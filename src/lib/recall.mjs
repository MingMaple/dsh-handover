/**
 * 检索：多路召回（字面、正则、分词、结构）加倒数排名融合，重复命中合并为组。
 * 索引只在内存中构建，不落盘；原文一律来自会话日志。
 */
import vm from 'node:vm';
import { visibleTextOf, toolCallMap } from './events.mjs';
import { deriveSegments, segmentForSeq } from './segments.mjs';
import { estimateTokens } from './facts.mjs';

const MAX_TEXT = 20000;
const RRF_K = 60;
const MERGE_SCAN = 300;
const MERGE_JACCARD = 0.85;
const MODES = ['auto', 'literal', 'regex', 'bm25', 'structural'];
/** 单次正则扫描的墙钟上限：超时即放弃本轮，避免灾难性回溯卡死插件线程。 */
const REGEX_TIMEOUT_MS = 500;

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const STOP = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'from', 'http', 'https', 'true', 'false']);

function clipText(text) {
  const s = String(text || '');
  return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) : s;
}

/** 把单条 assistant/message 里的 tool-call 记进映射（与 toolCallMap 同口径，供增量追加时逐条喂入）。 */
function absorbCalls(e, map) {
  const blocks = e && e.data && e.data.message && Array.isArray(e.data.message.content) ? e.data.message.content : [];
  for (const c of blocks) {
    if (!c || c.type !== 'tool-call' || !c.id) continue;
    let args = {};
    try { args = typeof c.arguments === 'string' ? JSON.parse(c.arguments) : (c.arguments || {}); } catch { args = {}; }
    map.set(String(c.id), { name: String(c.name || ''), arguments: args, seq: e.seq });
  }
}

/**
 * 把一段事件转成可检索条目。
 * base 是这段事件在整份日志里的起始下标，用于补齐缺失 seq 时的行号口径。
 * calls 由调用方持有：全量构建时传空 Map，增量追加时传索引里已有的 Map，
 * 这样新追加的 tool/result 仍能解析到此前事件的工具名。工具结果总在其 call 之后，逐条喂入与先扫全表等价。
 */
function docsFrom(list, calls, base) {
  const out = [];
  list.forEach((r, i) => {
    if (!r || typeof r.type !== 'string') return;
    const type = r.type;
    if (type === 'request/header' || type === 'request/context' || type === 'agent/inbox/spliced') return;
    if (type.indexOf('session-log-deepseek/') === 0 || type.indexOf('tool/ptc-dispatch') === 0) return;
    if (type === 'assistant/message') absorbCalls(r, calls);
    let text = clipText(visibleTextOf(r));
    if (!text) return;
    const seq = typeof r.seq === 'number' ? r.seq : base + i;
    let tool = '';
    let isError = false;
    let turn = null;
    if (type === 'tool/result') {
      const msg = r.data && r.data.message ? r.data.message : null;
      const call = msg ? calls.get(String(msg.toolCallId || '')) : null;
      tool = call ? call.name : '';
      isError = !!(msg && msg.isError === true);
      turn = r.data && typeof r.data.turn === 'number' ? r.data.turn : null;
    } else if (type === 'assistant/message') {
      turn = r.data && typeof r.data.turn === 'number' ? r.data.turn : null;
    } else if (type === 'step/start' || type === 'turn/start') {
      turn = r.data && typeof r.data.turn === 'number' ? r.data.turn : null;
    }
    out.push({ seq, type, tool, isError, turn, time: r.time, text });
  });
  return out;
}

/**
 * 取某条事件前后各 n 条：在给定事件数组上按 seq 定位，边界处自然截断。
 * @param {Array<object>} records 会话日志事件
 * @param {number} seq 中心事件序号
 * @param {number} [n] 前后条数，默认 3
 * @returns {{found:boolean, seq:number, events:Array<object>}}
 */
export function aroundEvents(records, seq, n) {
  const list = Array.isArray(records) ? records : [];
  const want = Number(seq);
  const k = Number.isFinite(n) && n > 0 ? Math.floor(n) : 3;
  const at = list.findIndex((r) => r && typeof r.seq === 'number' && r.seq === want);
  if (at === -1) return { found: false, seq: want, events: [] };
  const calls = toolCallMap(list);
  const events = [];
  const from = Math.max(0, at - k);
  const to = Math.min(list.length - 1, at + k);
  for (let i = from; i <= to; i++) {
    const r = list[i] || {};
    const type = typeof r.type === 'string' ? r.type : '';
    let tool = '';
    let isError = false;
    if (type === 'tool/result') {
      const msg = r.data && r.data.message ? r.data.message : null;
      const call = msg ? calls.get(String(msg.toolCallId || '')) : null;
      tool = call ? call.name : '';
      isError = !!(msg && msg.isError === true);
    }
    events.push({
      seq: typeof r.seq === 'number' ? r.seq : i,
      type,
      tool,
      isError,
      time: r.time,
      text: visibleTextOf(r),
      center: i === at,
    });
  }
  return { found: true, seq: want, events };
}

/** 分词：中文取单字与相邻 2 字，拉丁取长度不小于 2 的词。 */
function tokenize(text) {
  const s = String(text || '').toLowerCase();
  const out = [];
  const words = s.match(/[a-z0-9_]{2,}/g) || [];
  for (const w of words) if (!STOP.has(w)) out.push(w);
  const cjk = s.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g) || [];
  for (const run of cjk) {
    for (let i = 0; i < run.length; i++) {
      out.push(run[i]);
      if (i + 1 < run.length) out.push(run.slice(i, i + 2));
    }
  }
  return out;
}

// ---------------- 会话级内存索引（增量） ----------------
//
// 缓存键从「语料指纹」改为会话 id：日志只追加时不再重建整份语料。
// 追加只对新事件分词，并把词频合并进已有倒排：
//   · df（文档频次）按「新文档里出现的词各 +1」累加；
//   · lengths / avgdl 由累加的总词长除以文档数现算；
//   · postings 追加新的文档下标。
// 三者都是精确值，与全量重建逐项相同（不存在近似口径）。
// 只有检测到删除/截断/前缀被改写时才整份重建，追加场景一律走增量。
const INDEX_MAX = 2;   // 每份常驻数十 MB，只留最近 2 份会话
const indexCache = new Map();

/** 取日志首部的会话 id；内存事件没有会话头时返回空串。 */
function sidOfRecords(list) {
  const n = Math.min(list.length, 8);
  for (let i = 0; i < n; i++) {
    const r = list[i];
    if (r && r.type === 'session' && typeof r.id === 'string' && r.id) return r.id;
  }
  return '';
}

/** 一条事件的轻量签名：用于判断缓存前缀是否仍是同一份日志。 */
function signatureOf(r) {
  if (!r) return 'nil';
  return String(r.type || '') + '\u0000'
    + (typeof r.seq === 'number' ? r.seq : '') + '\u0000'
    + (typeof r.time === 'number' ? r.time : '');
}

/** 最后一条带数字 seq 的序号；没有则 -1。 */
function tailSeqOf(list) {
  for (let i = list.length - 1; i >= 0; i--) {
    const r = list[i];
    if (r && typeof r.seq === 'number') return r.seq;
  }
  return -1;
}

/** 无会话 id 的事件数组（自测、纯内存事件）：用长度 + 内容哈希做键，避免不同语料互相顶替。 */
function anonKeyOf(list) {
  let h = 2166136261;
  for (const r of list) {
    const s = signatureOf(r);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
  }
  return 'anon:' + list.length + ':' + (h >>> 0).toString(36);
}

function emptyIndex(key, sid) {
  return {
    key,
    sid,
    recordCount: 0,
    lastSeq: -1,
    lastSig: '',
    corpus: [],
    docs: [],
    lengths: [],
    postings: new Map(),
    df: new Map(),
    totalLen: 0,
    avgdl: 0,
    calls: new Map(),
    segments: [],
    at: Date.now(),
  };
}

/** 单文档入库：分词 → 词频 → 倒排与 df 增量累加。 */
function pushDoc(entry, doc) {
  const tf = new Map();
  const tokens = tokenize(doc.text);
  entry.lengths.push(tokens.length);
  entry.totalLen += tokens.length;
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
  const idx = entry.corpus.length;
  for (const t of tf.keys()) {
    entry.df.set(t, (entry.df.get(t) || 0) + 1);
    const listOfDoc = entry.postings.get(t);
    if (listOfDoc) listOfDoc.push(idx);
    else entry.postings.set(t, [idx]);
  }
  entry.docs.push(tf);
  entry.corpus.push(doc);
}

/** 从 from 起追加事件。段索引只在出现新 summary 时重算；段范围由 summary 的 seq 决定，追加尾部不影响旧段。 */
function appendRecords(entry, records, from) {
  if (from < records.length) {
    const fresh = records.slice(from);
    const docs = docsFrom(fresh, entry.calls, from);
    for (const d of docs) pushDoc(entry, d);
    let hasSummary = false;
    for (const r of fresh) {
      if (r && r.type === 'compaction/summary') { hasSummary = true; break; }
    }
    if (hasSummary) entry.segments = deriveSegments(records);
  }
  entry.recordCount = records.length;
  const tail = records.length ? records[records.length - 1] : null;
  entry.lastSeq = tailSeqOf(records);
  entry.lastSig = signatureOf(tail);
  entry.avgdl = entry.docs.length ? entry.totalLen / entry.docs.length : 0;
  entry.at = Date.now();
}

function touchIndex(key, entry) {
  indexCache.delete(key);
  indexCache.set(key, entry);
  while (indexCache.size > INDEX_MAX) indexCache.delete(indexCache.keys().next().value);
}

/**
 * 取会话索引。sid 可省略：优先从日志首部的 session 事件取 id。
 * @param {Array<object>} records
 * @param {string} [sid]
 */
export function indexOf(records, sid) {
  const list = Array.isArray(records) ? records : [];
  const id = String(sid || '') || sidOfRecords(list);
  const key = id ? 'sid:' + id : anonKeyOf(list);
  let entry = indexCache.get(key) || null;
  if (entry) {
    const boundaryOk = entry.recordCount <= list.length
      && (entry.recordCount === 0 || signatureOf(list[entry.recordCount - 1]) === entry.lastSig);
    const truncated = entry.recordCount > list.length || tailSeqOf(list) < entry.lastSeq;
    if (!boundaryOk || truncated) {
      // 删除、截断或前缀被改写：无法安全增量，整份重建。
      indexCache.delete(key);
      entry = null;
    }
  }
  if (!entry) {
    entry = emptyIndex(key, id);
    appendRecords(entry, list, 0);
    touchIndex(key, entry);
    return entry;
  }
  if (list.length > entry.recordCount) appendRecords(entry, list, entry.recordCount);
  else entry.at = Date.now();
  touchIndex(key, entry);
  return entry;
}

/* ---------------- 查询语法 ---------------- */

const OPEN_QUOTES = { '"': '"', "'": "'", '\u201c': '\u201d', '\u2018': '\u2019' };
const OP_BOUNDARY = /[\s|]/;

function lowerText(text) {
  return String(text || '').toLowerCase();
}

function plainSpec(raw) {
  const terms = String(raw || '').split(/\s+/).filter(Boolean);
  return {
    raw,
    ok: false,
    syntax: false,
    groups: terms.length
      ? [{ fragments: terms.map((text) => ({ text, required: false, negated: false, phrase: false })), whole: terms.join(' ') }]
      : [],
    exclusions: [],
  };
}

/**
 * 解析查询语法：竖线为或，减号为排除，加号为必含，引号内为短语。
 * 解析失败时退回普通关键词，不抛异常。
 */
function parseQuery(query) {
  const raw = String(query || '').trim();
  if (!raw) return { raw: '', ok: true, syntax: false, groups: [], exclusions: [] };
  try {
    const groups = [];
    let cur = [];
    let prefix = '';
    let syntax = false;
    let i = 0;
    while (i < raw.length) {
      const ch = raw[i];
      if (/\s/.test(ch)) { i++; continue; }
      if (ch === '|') {
        syntax = true;
        if (!cur.length) return plainSpec(raw);
        groups.push(cur);
        cur = [];
        i++;
        continue;
      }
      if ((ch === '+' || ch === '-') && (i === 0 || OP_BOUNDARY.test(raw[i - 1]))) {
        syntax = true;
        prefix = ch === '+' ? 'req' : 'neg';
        i++;
        const next = raw[i];
        if (next === undefined || /[\s|]/.test(next) || next === '+' || next === '-') return plainSpec(raw);
        continue;
      }
      let text = '';
      let phrase = false;
      if (OPEN_QUOTES[ch]) {
        syntax = true;
        const close = OPEN_QUOTES[ch];
        let j = i + 1;
        while (j < raw.length && raw[j] !== close) { text += raw[j]; j++; }
        if (j >= raw.length) return plainSpec(raw);
        phrase = true;
        i = j + 1;
      } else {
        while (i < raw.length && !/\s/.test(raw[i]) && raw[i] !== '|') { text += raw[i]; i++; }
      }
      text = text.trim();
      if (!text) return plainSpec(raw);
      cur.push({ text, required: prefix === 'req', negated: prefix === 'neg', phrase });
      prefix = '';
    }
    if (cur.length) groups.push(cur);
    else if (groups.length) return plainSpec(raw);
    if (!groups.length) return plainSpec(raw);
    const built = groups.map((fragments) => ({
      fragments,
      whole: fragments.filter((f) => !f.negated).map((f) => f.text).join(' '),
    }));
    const exclusions = [];
    for (const g of built) {
      for (const f of g.fragments) if (f.negated) exclusions.push(lowerText(f.text));
    }
    return { raw, ok: true, syntax, groups: built, exclusions };
  } catch {
    return plainSpec(raw);
  }
}

function positivesOf(group) {
  return group.fragments.filter((f) => !f.negated);
}

function excludedBySpec(spec, low) {
  for (const t of spec.exclusions) if (low.indexOf(t) !== -1) return true;
  return false;
}

/** 字面组匹配：组内正向词须全部出现，整组原文出现得高分。 */
function literalGroupScore(group, low) {
  const positives = positivesOf(group);
  if (!positives.length) return { score: 1, pos: 0 };
  let pos = -1;
  for (const f of positives) {
    const at = low.indexOf(lowerText(f.text));
    if (at === -1) return null;
    if (pos === -1 || at < pos) pos = at;
  }
  const whole = lowerText(group.whole);
  const exact = whole ? low.indexOf(whole) : -1;
  return { score: exact >= 0 ? 3 : 1, pos: exact >= 0 ? exact : Math.max(0, pos) };
}

/** 分词组匹配：必含与短语须出现，普通词至少出现一个。 */
function bm25GroupMatch(group, low) {
  const positives = positivesOf(group);
  if (!positives.length) return true;
  for (const f of positives) {
    if ((f.required || f.phrase) && low.indexOf(lowerText(f.text)) === -1) return false;
  }
  return positives.some((f) => low.indexOf(lowerText(f.text)) !== -1);
}

/* ---------------- 各路召回 ---------------- */

/** 字面召回：整句匹配；多词查询按全部词命中降级。 */
function literalHits(corpus, query, limit, spec) {
  const s = spec || parseQuery(query);
  if (!s.groups.length) return { hits: [], total: 0, all: [] };
  const out = [];
  for (const doc of corpus) {
    const low = lowerText(doc.text);
    if (excludedBySpec(s, low)) continue;
    let best = null;
    for (const g of s.groups) {
      const r = literalGroupScore(g, low);
      if (!r) continue;
      if (!best || r.score > best.score || (r.score === best.score && r.pos < best.pos)) best = r;
    }
    if (!best) continue;
    out.push({ seq: doc.seq, pos: best.pos, score: best.score });
  }
  out.sort((a, b) => b.score - a.score || a.seq - b.seq);
  return { hits: out.slice(0, limit || 30), total: out.length, all: out };
}

/**
 * 正则模式校验：返回拒绝原因，可用时返回空串。
 * 拒绝超长模式、嵌套量词与「交替分组 + 量词」，这些是回溯复杂度的主要来源。
 */
export function regexIssue(pattern) {
  const p = String(pattern || '');
  if (!p) return '模式为空';
  if (p.length > 200) return '模式长度 ' + p.length + ' 超过 200 个字符，请缩短或改用 mode=literal';
  if (/\([^)]*[+*]\)\s*[+*]/.test(p)) return '模式含嵌套量词，可能回溯爆炸，请改写';
  // (a|aa)+、(a|b)*、(?:x|yy){2,} 这类交替分组后接量词会指数级回溯，直接拒绝。
  if (/\([^)]*\|[^)]*\)\s*(?:[+*]|\{\d*,?\d*\})/.test(p)) {
    return '模式含「交替分组 + 量词」，可能灾难性回溯，请改写或改用 mode=literal';
  }
  try { new RegExp(p, 'i'); } catch (e) { return '模式无法编译：' + (e && e.message ? e.message : e); }
  return '';
}

/**
 * 在独立 VM 上下文里执行正则扫描，超时即中断。
 * 返回 { hits:[{k,pos}], timedOut }；超时前已得到的命中保留。
 */
function regexScan(texts, pattern) {
  const hits = [];
  if (!texts.length) return { hits, timedOut: false };
  try {
    vm.runInNewContext(
      'for (let k = 0; k < texts.length; k++) { const m = re.exec(texts[k]); if (m) hits.push({ k: k, pos: m.index }); }',
      { texts, hits, re: new RegExp(String(pattern), 'i') },
      { timeout: REGEX_TIMEOUT_MS, displayErrors: false },
    );
    return { hits, timedOut: false };
  } catch (e) {
    const timedOut = !!(e && (e.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' || /timed out|timeout/i.test(String(e.message || e))));
    return { hits, timedOut };
  }
}

/** 正则召回：模式不合格时返回空列表；原因由调用方通过 regexIssue 取。 */
function regexHits(corpus, pattern, limit) {
  if (regexIssue(pattern)) return { hits: [], total: 0, all: [], timedOut: false };
  const scan = regexScan(corpus.map((doc) => doc.text), pattern);
  const out = scan.hits.map((one) => ({ seq: corpus[one.k].seq, pos: one.pos, score: 2 }));
  out.sort((a, b) => b.score - a.score || a.seq - b.seq);
  return { hits: out.slice(0, limit || 30), total: out.length, all: out, timedOut: scan.timedOut };
}

/** 分词召回：只对查询词倒排并集里的文档打分，整句命中另给固定加权。 */
function bm25Hits(index, query, limit, spec) {
  const s = spec || parseQuery(query);
  const tokens = [];
  const seen = new Set();
  for (const g of s.groups) {
    for (const f of positivesOf(g)) {
      for (const t of tokenize(f.text)) {
        if (!seen.has(t)) { seen.add(t); tokens.push(t); }
      }
    }
  }
  if (!tokens.length) return { hits: [], total: 0, all: [] };
  const candidates = new Set();
  for (const t of tokens) {
    const list = index.postings.get(t);
    if (list) for (const i of list) candidates.add(i);
  }
  const N = index.corpus.length;
  const avg = index.avgdl || 1;
  const scored = [];
  for (const i of candidates) {
    const doc = index.corpus[i];
    const low = lowerText(doc.text);
    if (excludedBySpec(s, low)) continue;
    const groupTokens = new Set();
    let bonus = 0;
    let pass = false;
    for (const g of s.groups) {
      if (!bm25GroupMatch(g, low)) continue;
      pass = true;
      if (g.whole && low.indexOf(lowerText(g.whole)) !== -1) bonus += 10;
      for (const f of positivesOf(g)) {
        for (const t of tokenize(f.text)) groupTokens.add(t);
      }
    }
    if (!pass || !groupTokens.size) continue;
    const tf = index.docs[i];
    let sc = 0;
    for (const t of groupTokens) {
      const f = tf.get(t) || 0;
      if (!f) continue;
      const df = index.df.get(t) || 0;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      const dl = index.lengths[i] || 0;
      sc += idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * dl / avg));
    }
    sc += bonus;
    if (sc > 0) scored.push({ seq: doc.seq, score: sc, pos: 0 });
  }
  scored.sort((a, b) => b.score - a.score || a.seq - b.seq);
  return { hits: scored.slice(0, limit || 30), total: scored.length, all: scored };
}

/** 结构过滤：逗号分隔的 key:value，支持 type、tool、error、file、turn、seq。 */
function parseFilter(filter) {
  const out = {};
  for (const part of String(filter || '').split(',')) {
    const t = part.trim();
    if (!t) continue;
    const i = t.indexOf(':');
    if (i <= 0) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

function structuralHits(corpus, filter, limit) {
  const f = parseFilter(filter);
  if (!Object.keys(f).length) return { hits: [], total: 0, all: [] };
  const out = [];
  for (const doc of corpus) {
    if (f.type && doc.type !== f.type) continue;
    if (f.tool && doc.tool.toLowerCase() !== f.tool.toLowerCase()) continue;
    if (f.error !== undefined && String(doc.isError) !== f.error) continue;
    if (f.turn !== undefined && String(doc.turn) !== f.turn) continue;
    if (f.seq !== undefined && String(doc.seq) !== f.seq) continue;
    if (f.file && doc.text.toLowerCase().indexOf(f.file.toLowerCase()) === -1) continue;
    out.push({ seq: doc.seq, pos: 0, score: 1 });
  }
  out.sort((a, b) => a.seq - b.seq);
  return { hits: out.slice(0, limit || 30), total: out.length, all: out };
}

/** 倒数排名融合：名次越靠前权重越高。 */
function fuseRRF(lists, limit) {
  const score = new Map();
  const hit = new Map();
  for (const list of lists) {
    (list || []).forEach((item, i) => {
      const s = 1 / (RRF_K + i + 1);
      score.set(item.seq, (score.get(item.seq) || 0) + s);
      const prev = hit.get(item.seq);
      if (!prev) hit.set(item.seq, item);
      else if (!prev.pos && item.pos) prev.pos = item.pos;
    });
  }
  return Array.from(score.entries())
    .map(([seq, s]) => ({ seq, score: s, pos: (hit.get(seq) || {}).pos || 0 }))
    .sort((a, b) => b.score - a.score || a.seq - b.seq)
    .slice(0, limit || 12);
}

function matchPos(text, query) {
  const low = String(text || '').toLowerCase();
  const q = String(query || '').trim().toLowerCase();
  if (q) {
    const at = low.indexOf(q);
    if (at >= 0) return at;
  }
  for (const t of tokenize(query)) {
    if (t.length < 2) continue;
    const i = low.indexOf(t);
    if (i >= 0) return i;
  }
  return 0;
}

function matchPosWithSpec(text, spec, query) {
  const low = lowerText(text);
  let best = -1;
  if (spec) {
    for (const g of spec.groups) {
      for (const f of positivesOf(g)) {
        const at = low.indexOf(lowerText(f.text));
        if (at >= 0 && (best === -1 || at < best)) best = at;
      }
    }
  }
  if (best >= 0) return best;
  return matchPos(text, query);
}

function excerptOf(text, pos) {
  const s = String(text || '');
  let line = 1;
  for (let i = 0; i < pos && i < s.length; i++) if (s[i] === String.fromCharCode(10)) line++;
  const lines = s.split(String.fromCharCode(10));
  const from = Math.max(1, line - 3);
  const to = Math.min(lines.length, line + 3);
  const out = [];
  for (let n = from; n <= to; n++) out.push({ no: n, text: lines[n - 1] });
  return { line, lines: out };
}

/* ---------------- 命中合并 ---------------- */

function normalizeText(text) {
  return lowerText(text).replace(/[\s\p{P}\p{Z}]/gu, '');
}

function bigramSet(text) {
  const set = new Set();
  if (!text) return set;
  if (text.length < 2) { set.add(text); return set; }
  for (let i = 0; i + 1 < text.length; i++) set.add(text.slice(i, i + 2));
  return set;
}

function jaccardOf(a, b) {
  if (!a.size || !b.size) return 0;
  const small = a.size <= b.size ? a : b;
  const large = a.size <= b.size ? b : a;
  let inter = 0;
  for (const item of small) if (large.has(item)) inter++;
  return inter / (a.size + b.size - inter);
}

function finalizeGroup(group, bySeq, index, spec, query) {
  const members = group.members.slice().sort((a, b) => b.score - a.score || a.seq - b.seq);
  const rep = members[0];
  const seqs = group.members.map((m) => m.seq).sort((a, b) => a - b);
  const doc = rep.doc || {};
  const firstDoc = bySeq.get(seqs[0]) || doc;
  const lastDoc = bySeq.get(seqs[seqs.length - 1]) || doc;
  const pos = rep.pos > 0 ? rep.pos : matchPosWithSpec(doc.text, spec, query);
  return {
    seq: rep.seq,
    type: doc.type || '',
    tool: doc.tool || '',
    isError: !!doc.isError,
    score: Math.round(rep.score * 10000) / 10000,
    segment: segmentForSeq(index.segments, rep.seq),
    excerpt: excerptOf(doc.text, pos),
    tokens: estimateTokens(doc.text),
    at: doc.time,
    seqs,
    count: seqs.length,
    firstSeq: seqs[0],
    lastSeq: seqs[seqs.length - 1],
    firstAt: firstDoc.time === undefined ? null : firstDoc.time,
    lastAt: lastDoc.time === undefined ? null : lastDoc.time,
  };
}

/** 同一类型与工具下，按正文相同或二元组相似度合并；只比较前 300 条。 */
function groupHits(fused, index, spec, query) {
  const bySeq = new Map(index.corpus.map((d) => [d.seq, d]));
  const groups = [];
  const exact = new Map();
  const items = fused.map((h) => ({
    seq: h.seq,
    score: h.score,
    pos: h.pos || 0,
    doc: bySeq.get(h.seq) || { seq: h.seq, type: '', tool: '', text: '', time: null },
  }));
  const scan = items.slice(0, MERGE_SCAN);
  const rest = items.slice(MERGE_SCAN);
  for (const it of scan) {
    it.norm = normalizeText(it.doc.text);
    const key = String(it.doc.type || '') + '\u0000' + String(it.doc.tool || '') + '\u0000' + it.norm;
    let target = exact.get(key) || null;
    if (!target) {
      it.grams = bigramSet(it.norm);
      for (const g of groups) {
        if (g.type !== (it.doc.type || '') || g.tool !== (it.doc.tool || '')) continue;
        if (!it.norm || !g.norm) continue;
        const min = Math.min(it.norm.length, g.norm.length);
        const max = Math.max(it.norm.length, g.norm.length);
        if (!max || min / max < MERGE_JACCARD) continue;
        if (jaccardOf(it.grams, g.grams) >= MERGE_JACCARD) { target = g; break; }
      }
    }
    if (target) target.members.push(it);
    else {
      const g = {
        type: it.doc.type || '',
        tool: it.doc.tool || '',
        norm: it.norm,
        grams: it.grams || bigramSet(it.norm),
        members: [it],
      };
      groups.push(g);
      exact.set(key, g);
    }
  }
  for (const it of rest) {
    groups.push({ type: it.doc.type || '', tool: it.doc.tool || '', norm: '', grams: null, members: [it] });
  }
  return groups.map((g) => finalizeGroup(g, bySeq, index, spec, query));
}

function orderGroups(groups, order) {
  const list = groups.slice();
  if (order === 'relevance') list.sort((a, b) => b.score - a.score || a.firstSeq - b.firstSeq);
  else list.sort((a, b) => a.firstSeq - b.firstSeq || a.seq - b.seq);
  return list;
}

/** 关键词建议：取最近用户消息里的高频词。 */
function suggestKeywords(index) {
  const freq = new Map();
  const docs = index.corpus.filter((d) => d.type === 'user/message' || d.type === 'assistant/message').slice(-40);
  for (const d of docs) {
    for (const t of tokenize(d.text)) {
      if (t.length < 2) continue;
      freq.set(t, (freq.get(t) || 0) + 1);
    }
  }
  return Array.from(freq.entries())
    .filter(([t]) => !/^\d+$/.test(t))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([t]) => t);
}

/**
 * 检索入口。
 * @param {Array<object>} records
 * @param {{query?:string, mode?:string, filter?:string, limit?:number, order?:string}} opts
 */
export function search(records, opts) {
  const o = opts || {};
  const index = indexOf(records, o.session_id);
  const mode = MODES.indexOf(o.mode) !== -1 ? o.mode : 'auto';
  const order = o.order === 'relevance' ? 'relevance' : 'time';
  const limit = typeof o.limit === 'number' && o.limit > 0 ? Math.min(o.limit, 50) : 8;
  const query = String(o.query || '').trim();
  const spec = mode === 'regex' ? null : parseQuery(query);
  const perRoute = { literal: 0, regex: 0, bm25: 0, structural: 0 };
  let lists = [];
  let route = mode;
  let regexTimedOut = false;
  if (mode === 'regex') {
    const r = regexHits(index.corpus, query, 40);
    perRoute.regex = r.total;
    regexTimedOut = r.timedOut === true;
    lists = [r.all];
  } else if (mode === 'literal') {
    const r = literalHits(index.corpus, query, 40, spec);
    perRoute.literal = r.total;
    lists = [r.all];
  } else if (mode === 'bm25') {
    const r = bm25Hits(index, query, 40, spec);
    perRoute.bm25 = r.total;
    lists = [r.all];
  } else if (mode === 'structural') {
    const r = structuralHits(index.corpus, o.filter, 40);
    perRoute.structural = r.total;
    lists = [r.all];
  } else {
    const lit = literalHits(index.corpus, query, 40, spec);
    const bm = bm25Hits(index, query, 40, spec);
    const st = structuralHits(index.corpus, o.filter, 40);
    perRoute.literal = lit.total;
    perRoute.bm25 = bm.total;
    perRoute.structural = st.total;
    lists = lit.total ? [lit.all, bm.all, st.all] : [bm.all, st.all];
    route = lit.total ? 'auto+literal' : 'auto+bm25';
  }
  const fused = fuseRRF(lists, Infinity);
  const groups = orderGroups(groupHits(fused, index, spec, query), order);
  const hits = groups.slice(0, limit);
  const matched = fused.length;
  const empty = matched === 0;
  return {
    route,
    mode,
    order,
    total: matched,
    matched,
    returned: hits.length,
    perRoute,
    hits,
    groups,
    index: index.key,
    segments: index.segments,
    rejected: mode === 'regex' ? (regexIssue(query) || (regexTimedOut
      ? '正则扫描超过 ' + REGEX_TIMEOUT_MS + ' 毫秒已中止，请缩小范围或改用 mode=literal'
      : '')) : '',
    suggestion: empty ? {
      segments: index.segments.slice(-5).map((s) => ({ index: s.index, label: s.label, range: s.fromSeq + '-' + s.toSeq })),
      keywords: suggestKeywords(index),
      hint: '可改用 mode="structural" 或去掉排除词后重试。',
    } : null,
  };
}

export { MODES };
