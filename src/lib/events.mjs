/**
 * 会话事件派生：压缩计数、压缩锁、事件信号。
 * 主数据源为会话日志：本运行时的 eventsOf 常为空，内存事件数组只作兜底。
 * 日志只追加，因此压缩状态按「已解 offset」增量推进，每步只解新增的帧。
 */
import fs from 'node:fs';
import path from 'node:path';
import { findLog, decodeLog, readLogAppend, zstdAvailable, isZstdLog } from './zstd-log.mjs';
import { projCacheDir } from './sessions.mjs';
import { pathsInText } from './text.mjs';
import { pathKey } from './pathkey.mjs';

/** 取本会话事件数组；无法获取返回 []。宿主对象可能缺少 agent 或 session，取不到时按空事件处理。 */
export function eventsOf(exec) {
  try {
    const s = exec && exec.agent && exec.agent.session;
    if (s && Array.isArray(s.events)) return s.events;
  } catch { /* ignore */ }
  return [];
}

/**
 * 返回 { used, lock }：
 *   used = compaction/summary 次数（= 已压缩次数）
 *   lock = 'clean' | 'open'（有未闭合的 compaction/start，且晚于最近一次 session/end-seed）
 */
export function countCompactions(events) {
  let used = 0;
  let pendingStart = null;
  let lastEndSeed = -1;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const t = e && e.type;
    if (t === 'session/end-seed') lastEndSeed = i;
    else if (t === 'compaction/start') pendingStart = i;
    else if (t === 'compaction/summary') used++;
    else if (t === 'compaction/end') pendingStart = null;
  }
  const open = pendingStart !== null && pendingStart > lastEndSeed;
  return { used, lock: open ? 'open' : 'clean' };
}

// 全量事件缓存：只留最近使用的 2 个会话。
// 一份完整事件数组可达数十 MB，缓存若不设界会一直涨，所以用 LRU 上限压住。
const RECORDS_MAX = 2;
const recordsCache = new Map();

/** 从会话日志读全量事件；读不到返回 null。按 size 与 mtime 缓存（LRU，上限 2）。 */
export function logRecordsOf(sessionId) {
  const sid = sessionId ? String(sessionId) : '';
  if (!sid) return null;
  const file = findLog(sid);
  if (!file) return null;
  let st = null;
  try { st = fs.statSync(file); } catch { return null; }
  const hit = recordsCache.get(sid);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) {
    recordsCache.delete(sid);
    recordsCache.set(sid, hit);   // 刷新使用次序
    return hit.records;
  }
  let recs = null;
  try { recs = decodeLog(file); } catch { recs = null; }
  if (!recs) return null;
  recordsCache.delete(sid);
  recordsCache.set(sid, { size: st.size, mtimeMs: st.mtimeMs, records: recs });
  while (recordsCache.size > RECORDS_MAX) recordsCache.delete(recordsCache.keys().next().value);
  return recs;
}

/**
 * 事件源解析：优先会话日志，其次内存事件数组，均取不到时给出降级标记。
 * @returns {{records:Array<object>, source:'log'|'events'|'none', logPath:string}}
 */
export function eventSourceOf(sessionId, exec) {
  const recs = logRecordsOf(sessionId);
  if (recs && recs.length) return { records: recs, source: 'log', logPath: findLog(sessionId) || '' };
  const mem = eventsOf(exec);
  if (mem.length) return { records: mem, source: 'events', logPath: '' };
  return { records: [], source: 'none', logPath: '' };
}

/** 取一条事件里的可见文本（不含思维链）。 */
export function visibleTextOf(event) {
  const e = event || {};
  const parts = [];
  const push = (v) => { if (typeof v === 'string' && v) parts.push(v); };
  try {
    if (e.type === 'user/message' || e.type === 'system/message') {
      for (const c of (Array.isArray(e.data && e.data.content) ? e.data.content : [])) {
        if (c && c.type === 'text') push(c.text);
      }
    } else if (e.type === 'assistant/message') {
      const blocks = e.data && e.data.message && Array.isArray(e.data.message.content) ? e.data.message.content : [];
      for (const c of blocks) {
        if (c && c.type === 'text') push(c.text);
        else if (c && c.type === 'tool-call') push(c.name + ' ' + String(c.arguments || ''));
      }
    } else if (e.type === 'tool/result') {
      const msg = e.data && e.data.message ? e.data.message : null;
      const blocks = msg && Array.isArray(msg.content) ? msg.content : [];
      for (const c of blocks) if (c && c.type === 'text') push(c.text);
    } else if (e.type === 'compaction/summary') {
      const blocks = e.data && Array.isArray(e.data.summary) ? e.data.summary : [];
      for (const c of blocks) if (c && c.type === 'text') push(c.text);
    } else if (e.type === 'workspace/changes') {
      push(JSON.stringify(e.data || {}));
    }
  } catch { /* 结构异常时按空文本处理 */ }
  return parts.join(String.fromCharCode(10));
}

/** 把 tool-call 的 id 映射到工具名与参数（跨事件，需先扫一遍）。 */
export function toolCallMap(records) {
  const map = new Map();
  for (const e of Array.isArray(records) ? records : []) {
    if (!e || e.type !== 'assistant/message') continue;
    const blocks = e.data && e.data.message && Array.isArray(e.data.message.content) ? e.data.message.content : [];
    for (const c of blocks) {
      if (!c || c.type !== 'tool-call' || !c.id) continue;
      let args = {};
      try { args = typeof c.arguments === 'string' ? JSON.parse(c.arguments) : (c.arguments || {}); } catch { args = {}; }
      map.set(String(c.id), { name: String(c.name || ''), arguments: args, seq: e.seq });
    }
  }
  return map;
}

const FILE_WRITE_TOOL = /write|edit|apply|create|patch|rename|move|copy|mkdir|delete/i;
/** 读文件类工具：同一文件被反复读取才是「忘了做过」的信号；写同一文件是正常编辑。 */
const FILE_READ_TOOL = /^(read|read_file|fs_read|view_image|read_text)$/i;

function pathOfArgs(args) {
  const out = [];
  if (!args || typeof args !== 'object') return out;
  for (const k of ['file_path', 'path', 'target', 'notebook_path', 'source', 'destination']) {
    if (typeof args[k] === 'string' && args[k]) out.push(args[k]);
  }
  return out;
}

/**
 * 汇总事件信号：失败工具结果、文件写入、里程碑、用户消息。
 * @returns {{failures:Array, fileWrites:Array, milestones:Array, userMessages:Array, toolCalls:Map}}
 */
export function collectSignals(records, opts) {
  const o = opts || {};
  const since = typeof o.sinceSeq === 'number' ? o.sinceSeq : -1;
  const raw = Array.isArray(records) ? records : [];
  const list = since >= 0 ? raw.filter((e) => e && typeof e.seq === 'number' && e.seq > since) : raw;
  const calls = toolCallMap(list);
  const failures = [];
  const fileWrites = [];
  const fileReads = [];
  const milestones = [];
  const userMessages = [];
  for (const e of list) {
    if (!e || typeof e.type !== 'string') continue;
    if (e.type === 'user/message') {
      const text = visibleTextOf(e);
      if (text) userMessages.push({ seq: e.seq, time: e.time, text });
      if (/里程碑|阶段性完成|收尾|交付/.test(text)) milestones.push({ seq: e.seq, time: e.time, text: text.slice(0, 200) });
    } else if (e.type === 'tool/result') {
      const msg = e.data && e.data.message ? e.data.message : null;
      if (msg && msg.isError === true) {
        const callId = String(msg.toolCallId || '');
        const call = calls.get(callId);
        failures.push({
          seq: e.seq, time: e.time, tool: call ? call.name : '', callId,
          text: visibleTextOf(e).slice(0, 400),
        });
      }
    } else if (e.type === 'workspace/changes') {
      const text = visibleTextOf(e);
      for (const p of pathsInText(text)) fileWrites.push({ seq: e.seq, time: e.time, path: p, source: 'changes' });
    }
    if (e.type === 'assistant/message') {
      const blocks = e.data && e.data.message && Array.isArray(e.data.message.content) ? e.data.message.content : [];
      for (const c of blocks) {
        if (!c || c.type !== 'tool-call') continue;
        const name = String(c.name || '');
        const isWrite = FILE_WRITE_TOOL.test(name);
        const isRead = FILE_READ_TOOL.test(name);
        if (!isWrite && !isRead) continue;
        let args = {};
        try { args = typeof c.arguments === 'string' ? JSON.parse(c.arguments) : (c.arguments || {}); } catch { args = {}; }
        for (const p of pathOfArgs(args)) {
          if (isRead) fileReads.push({ seq: e.seq, time: e.time, path: p, source: name });
          else fileWrites.push({ seq: e.seq, time: e.time, path: p, source: name });
        }
      }
    }
  }
  return { failures, fileWrites, fileReads, milestones, userMessages, toolCalls: calls };
}

/** 同错与同文件重复次数（取出现最多的那一项的计数）。 */
export function repeatStats(signals) {
  const s = signals || {};
  const errCount = new Map();
  for (const f of (s.failures || [])) {
    const key = String(f.text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!key) continue;
    errCount.set(key, (errCount.get(key) || 0) + 1);
  }
  const fileCount = new Map();
  for (const f of (s.fileReads || [])) {
    // 同一文件的等价键按平台折算大小写：Windows/macOS 折叠，Linux 区分。
    const key = pathKey(f.path);
    if (!key) continue;
    fileCount.set(key, (fileCount.get(key) || 0) + 1);
  }
  const maxOf = (m) => (m.size ? Math.max.apply(null, Array.from(m.values())) : 0);
  return { repeatErrors: maxOf(errCount), repeatFiles: maxOf(fileCount) };
}

/**
 * 压缩状态的增量缓存：会话日志每步都在追加。
 * 按「整份 size+mtime」缓存会在每次追加后失效，代价是每步重解整份日志。
 * 因此缓存只保留解码进度，每步仅解 offset 之后的新帧。
 * 字段与 countCompactions 的扫描状态一一对应，used、pendingStart、lastEndSeed 均为累计值。
 */
const COMPACT_CACHE_MAX = 64;
/** 负缓存有效期 30 秒：坏帧重解一次要几百毫秒，短期内反复重试没有意义。 */
const COMPACT_FAIL_TTL_MS = 30000;
const compactCache = new Map();
const compactFail = new Map();
/** 首部指纹：文件被整体替换（截断后重写、轮转）时 size 可能不变，用首 32 字节兜底识别。 */
const HEAD_LEN = 32;

function evictOldest(map, max) {
  while (map.size > max) map.delete(map.keys().next().value);
}

function headOf(file, size) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const len = Math.min(HEAD_LEN, size);
      const buf = Buffer.allocUnsafe(len);
      const got = len ? fs.readSync(fd, buf, 0, len, 0) : 0;
      return buf.subarray(0, got).toString('hex');
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}

/**
 * 推进一条事件，更新压缩计数与锁状态。
 * 逐句对齐 countCompactions 的遍历逻辑。
 * 增量路径与全量路径必须同口径，否则同一份日志会得出不同计数。
 */
function applyCompactionEvent(st, e) {
  const t = e && e.type;
  if (t === 'session/end-seed') st.lastEndSeed = st.index;
  else if (t === 'compaction/start') st.pendingStart = st.index;
  else if (t === 'compaction/summary') {
    st.used++;
    if (typeof e.time === 'number') st.lastSummaryMs = st.lastSummaryMs === null ? e.time : Math.max(st.lastSummaryMs, e.time);
  } else if (t === 'compaction/end') st.pendingStart = null;
  st.index++;
}

function compactionValueOf(st) {
  const open = st.pendingStart !== null && st.pendingStart > st.lastEndSeed;
  return { used: st.used, lock: open ? 'open' : 'clean', lastSummaryMs: st.lastSummaryMs, source: 'log', logStatus: 'ok', note: '' };
}

/** 由全量事件记录派生压缩状态：与增量路径同口径，供「记录已在缓存」时省掉一次整份解码。 */
function compactionValueFromRecords(recs) {
  const c = countCompactions(recs);
  let last = null;
  for (const r of recs) {
    if (!r || r.type !== 'compaction/summary' || typeof r.time !== 'number') continue;
    last = last === null ? r.time : Math.max(last, r.time);
  }
  return { used: c.used, lock: c.lock, lastSummaryMs: last, source: 'log', logStatus: 'ok', note: '' };
}

/** 从会话日志读压缩状态：{ used, lock, lastSummaryMs, source, logStatus, note }。读不到日志时退回事件数组。 */
export function compactionStateOf(sessionId, exec) {
  const fromEvents = () => {
    const c = countCompactions(eventsOf(exec));
    return { used: c.used, lock: c.lock, lastSummaryMs: null, source: 'events', logStatus: 'events', note: '' };
  };
  const sid = sessionId ? String(sessionId) : '';
  if (!sid) return fromEvents();
  const file = findLog(sid);
  if (!file) return fromEvents();
  let st0 = null;
  try { st0 = fs.statSync(file); } catch { return fromEvents(); }

  // 日志是 zstd 帧但没有解压 API：不能当成「压缩 0 次·锁 clean」，明确标为不可用。
  if (isZstdLog(file) && !zstdAvailable()) {
    return Object.assign(fromEvents(), {
      lock: 'unknown', logStatus: 'no-zstd', note: '日志解压不可用（当前 Node 缺少 zstd 支持）',
    });
  }

  // 负缓存：日志损坏时每次重解都要几百毫秒且永远不会成功，30 秒内直接走兜底。
  const bad = compactFail.get(sid);
  if (bad && bad.size === st0.size && bad.mtimeMs === st0.mtimeMs && Date.now() - bad.at < COMPACT_FAIL_TTL_MS) {
    return Object.assign(fromEvents(), { lock: 'unknown', logStatus: 'bad', note: '日志解码失败（坏帧；30 秒内不重试）' });
  }

  // 全量事件若已在记录缓存里（同一 size+mtime），直接由记录派生，省掉一次整份解码。
  // 状态视图会先取记录再取压缩状态，这条捷径把同一份日志的解码次数从 2 次减到 1 次。
  const rc = recordsCache.get(sid);
  if (rc && rc.size === st0.size && rc.mtimeMs === st0.mtimeMs && Array.isArray(rc.records)) {
    return compactionValueFromRecords(rc.records);
  }

  const hit = compactCache.get(sid);
  if (hit && hit.size === st0.size && hit.mtimeMs === st0.mtimeMs) {
    compactCache.delete(sid);
    compactCache.set(sid, hit);   // 刷新使用次序
    return compactionValueOf(hit);
  }

  // 能增量就增量：offset 之前的字节不会再变（DSH 只追加），因此只需解 offset 之后。
  // 首部指纹用来识别「被整体替换」：size 不变而内容换了时，offset 之后没有增量可解。
  const head = headOf(file, st0.size);
  if (head === null) return fromEvents();
  const base = (hit && st0.size >= hit.offset && (hit.head === '' || head === hit.head)) ? hit : null;
  const state = base
    ? {
      offset: base.offset, index: base.index, used: base.used,
      pendingStart: base.pendingStart, lastEndSeed: base.lastEndSeed,
      lastSummaryMs: base.lastSummaryMs, carry: base.carry || '', head,
    }
    : { offset: 0, index: 0, used: 0, pendingStart: null, lastEndSeed: -1, lastSummaryMs: null, carry: '', head };

  const from = state.offset;
  const chunk = readLogAppend(file, from, state.carry);
  if (!chunk) {
    compactFail.set(sid, { failed: true, size: st0.size, mtimeMs: st0.mtimeMs, at: Date.now() });
    evictOldest(compactFail, COMPACT_CACHE_MAX);
    return Object.assign(fromEvents(), { lock: 'unknown', logStatus: 'unreadable', note: '日志读取失败，压缩状态未核' });
  }
  for (const e of chunk.records) applyCompactionEvent(state, e);
  state.offset = chunk.nextOffset;
  state.carry = chunk.carry;

  if (state.index === 0) {
    // 一条安全事件都没解出来：空日志（便宜，不必缓存）或全坏帧（写负缓存，避免每步重试几百毫秒）。
    if (chunk.size > 0 && !chunk.records.length && chunk.nextOffset === from) {
      compactFail.set(sid, { failed: true, size: st0.size, mtimeMs: st0.mtimeMs, at: Date.now() });
      evictOldest(compactFail, COMPACT_CACHE_MAX);
      return Object.assign(fromEvents(), { lock: 'unknown', logStatus: 'bad', note: '日志解码失败（坏帧），压缩状态未核' });
    }
    return Object.assign(fromEvents(), { logStatus: 'empty' });
  }
  compactFail.delete(sid);
  state.size = chunk.size;
  state.mtimeMs = chunk.mtimeMs;
  state.head = headOf(file, chunk.size) || '';
  compactCache.delete(sid);
  compactCache.set(sid, state);
  evictOldest(compactCache, COMPACT_CACHE_MAX);
  return compactionValueOf(state);
}

/** 投影缓存里该会话文件的 mtimeMs（判断「压缩刚完成、缓存未刷新」用）。 */
function projCacheMtimeOf(sessionId) {
  const sid = sessionId ? String(sessionId) : '';
  if (!sid) return null;
  const dir = projCacheDir();
  const bare = sid.indexOf('session-') === 0 ? sid.slice(8) : sid;
  const names = [];
  for (const n of [sid, 'session-' + bare]) {
    if (n && names.indexOf(n) === -1) names.push(n);
  }
  // 直接拼路径 stat：投影缓存有 400+ 个文件，readdirSync 只为匹配一个名字要 7ms 左右。
  for (const stem of names) {
    try { return fs.statSync(path.join(dir, stem + '.json')).mtimeMs; } catch { /* 试下一个命名 */ }
  }
  return null;
}

/** 压缩后读数滞后提示：日志里已有 summary，但投影缓存比它旧 ⇒ 返回一句中文提示，否则空串。 */
export function stalePressureNote(sessionId) {
  const st = compactionStateOf(sessionId, null);
  if (!st.lastSummaryMs) return '';
  const m = projCacheMtimeOf(sessionId);
  if (m === null || m >= st.lastSummaryMs) return '';
  return '（压缩刚完成，投影缓存尚未刷新，水位读数滞后一轮；下一次请求后恢复正常）';
}
