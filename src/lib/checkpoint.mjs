/**
 * 微快照：从会话事件抽取 6 项，依次为目标、已确认事实、未决、下一步、指针、时刻。
 * 条目标准：可核对；引路径不抄原文。缺项一律写「未核，待确认」。
 * 快照是派生结果，原文仍在会话日志；删除后可从日志重建。
 */
import fs from 'node:fs';
import path from 'node:path';
import { visibleTextOf, collectSignals } from './events.mjs';
import { stampTz } from './brief.mjs';
import { storeDirFor } from './store.mjs';
import { serviceOf } from './engine.mjs';
import { writeFileAtomic } from './text.mjs';

const UNVERIFIED = '未核，待确认';
/** 微快照保留上限：同目录只留最近 8 份。 */
const SNAPSHOT_KEEP = 8;

/** 包装消息与运行期噪声：不当用户目标，也不进事实与指针。 */
const ENVELOPE_RE = /^【(peer-link|dsh-handover|pm-)|^Time sampled|^Current runtime context|^Current working directory|^The working directory changed|^Elapsed since|^Browser time zone|Asia\/Shanghai/;

/**
 * 去掉消息里的信封与运行期行，保留真正的用户正文。
 * 协作消息形如「【peer-link ← 某会话】正文」，只丢信封行，不丢正文。
 */
function cleanUserText(text) {
  const raw = String(text || '');
  // 插件自己的角色与提示消息整条丢弃，只留第一行会被当成用户正文。
  if (/^【(dsh-handover|pm-)/.test(raw.trim())) return '';
  // 宿主压缩检查点不是用户发言，也不进快照。
  if (/This is an automatically generated checkpoint/.test(raw)) return '';
  const keep = [];
  for (const line of raw.split(String.fromCharCode(10))) {
    const t = line.trim();
    if (!t) continue;
    if (ENVELOPE_RE.test(t)) continue;
    keep.push(t);
  }
  return keep.join(' ');
}

function isEnvelope(text) {
  return !cleanUserText(text);
}

function clean(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function clip(text, n) {
  const t = clean(text);
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function pathsInText(text) {
  const out = [];
  const re = /[A-Za-z]:\\[^\s"',;）)]+|(?:\.{0,2}\/)?(?:[\w.\-\u4e00-\u9fa5]+[\/]){1,}[\w.\-\u4e00-\u9fa5]+/g;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    if (m[0].length >= 4 && m[0].length <= 260) out.push(m[0]);
    if (out.length >= 30) break;
  }
  return out;
}

function linesOf(text) {
  return String(text || '').split(String.fromCharCode(10)).map((s) => s.trim()).filter(Boolean);
}

/**
 * 抽取微快照。
 * @param {Array<object>} records 会话事件
 * @param {{sid?:string, ratio?:number|null}} opts
 * @returns {object} 6 项固定字段，缺项写占位句
 */
export function extractSnapshot(records, opts) {
  const o = opts || {};
  const list = Array.isArray(records) ? records : [];
  // 只看最近一轮压缩之后的事件；没有段信息时退化为最近 400 条，避免把陈旧历史当现状。
  const since = typeof o.sinceSeq === 'number' ? o.sinceSeq : -1;
  const scoped = since >= 0
    ? list.filter((r) => r && typeof r.seq === 'number' && r.seq > since)
    : list.slice(-400);
  const signals = collectSignals(scoped);
  const users = signals.userMessages
    .map((u) => ({ seq: u.seq, time: u.time, text: cleanUserText(u.text) }))
    .filter((u) => u.text && !isEnvelope(u.text));
  const assistants = scoped.filter((r) => r && r.type === 'assistant/message');

  let goal = UNVERIFIED;
  // 纯确认句不是目标；取最近一条非确认的用户发言。
  const goalUsers = users.filter((u) => !/^(已确认|确认[:：]|用户定[:：]|已定[:：]|定稿|已决定)/.test(u.text));
  const lastUser = goalUsers.length ? goalUsers[goalUsers.length - 1] : (users.length ? users[users.length - 1] : null);
  if (lastUser) {
    const line = linesOf(lastUser.text).find((l) => l && !isEnvelope(l));
    if (line) goal = clip(line, 200);
  }

  const facts = [];
  for (const u of users) {
    for (const line of linesOf(u.text)) {
      if (!/(已确认|确认[:：]|用户定[:：]|已定[:：]|定稿|已决定)/.test(line)) continue;
      const t = clip(line, 160);
      if (facts.indexOf(t) === -1) facts.push(t);
      if (facts.length >= 8) break;
    }
    if (facts.length >= 8) break;
  }

  const pending = [];
  for (const f of signals.failures.slice(-5)) {
    pending.push('工具 ' + (f.tool || '未知') + ' 失败：' + clip(f.text, 120) + '（seq ' + f.seq + '）');
  }
  for (const a of assistants.slice(-3)) {
    for (const line of linesOf(visibleTextOf(a))) {
      if (!/(待确认|未决|待定|待用户|需用户|悬而未决)/.test(line)) continue;
      const t = clip(line, 160);
      if (pending.indexOf(t) === -1) pending.push(t);
      if (pending.length >= 6) break;
    }
  }

  let next = UNVERIFIED;
  const tailUsers = users.slice(-3);
  for (let i = tailUsers.length - 1; i >= 0 && next === UNVERIFIED; i--) {
    const hit = linesOf(tailUsers[i].text).find((l) => /^(下一步|接下来|然后|接着)/.test(l));
    if (hit) next = clip(hit, 200);
  }
  if (next === UNVERIFIED) {
    for (const a of assistants.slice(-2)) {
      const t = visibleTextOf(a);
      const m = t.match(/Next Step[\s\S]{0,400}/i);
      if (m) {
        const line = linesOf(m[0]).find((l) => !/^Next Step/i.test(l));
        if (line) next = clip(line, 200);
      }
    }
  }

  const pointers = [];
  const ws = String(o.ws || '').replace(/\\/g, '/').toLowerCase();
  const add = (p) => {
    let t = String(p || '').trim().replace(/[；，。、）)]+.*$/, '').trim();
    if (!t || t.length < 4) return;
    const isAbs = /^[A-Za-z]:[\\/]/.test(t);
    if (!isAbs && ws && t.indexOf('/') !== -1) t = ws.replace(/\/$/, '') + '/' + t.replace(/^\.?\//, '');
    if (ws && !t.replace(/\\/g, '/').toLowerCase().startsWith(ws)) return;
    if (pointers.indexOf(t) !== -1) return;
    pointers.push(t);
  };
  for (const f of signals.fileWrites) add(f.path);
  for (const u of users.slice(-5)) for (const p of pathsInText(u.text)) add(p);
  if (pointers.length > 20) pointers.length = 20;

  const last = list.length ? list[list.length - 1] : null;
  const lastMs = last && typeof last.time === 'number' ? last.time : null;

  return {
    sid: String(o.sid || ''),
    at: lastMs === null ? UNVERIFIED : stampTz(lastMs),
    atMs: lastMs,
    ratio: typeof o.ratio === 'number' ? o.ratio : null,
    goal,
    facts: facts.length ? facts : [UNVERIFIED],
    pending: pending.length ? pending : [UNVERIFIED],
    next,
    pointers: pointers.length ? pointers : [UNVERIFIED],
    moment: lastMs === null ? UNVERIFIED : stampTz(lastMs),
  };
}

/** 渲染为 Markdown：6 节顺序固定，缺项保持占位句。 */
export function renderSnapshot(snap) {
  const s = snap || {};
  const out = [];
  out.push('# 微快照');
  out.push('');
  out.push('| 项 | 值 |');
  out.push('|---|---|');
  out.push('| 会话 | ' + (s.sid || '未核，待确认') + ' |');
  out.push('| 时刻 | ' + (s.moment || UNVERIFIED) + ' |');
  if (typeof s.ratio === 'number') out.push('| 水位 | ' + (Math.round(s.ratio * 1000) / 10).toFixed(1) + '% |');
  out.push('');
  const section = (title, body) => {
    out.push('## ' + title);
    if (Array.isArray(body)) {
      if (!body.length) out.push('- ' + UNVERIFIED);
      else for (const b of body) out.push('- ' + b);
    } else {
      out.push('- ' + (body || UNVERIFIED));
    }
    out.push('');
  };
  section('1 目标', s.goal);
  section('2 已确认事实', s.facts);
  section('3 未决', s.pending);
  section('4 下一步', s.next);
  section('5 指针', s.pointers);
  section('6 时刻', s.moment);
  return out.join(String.fromCharCode(10));
}

/** 快照文件名：秒级时刻 + 毫秒后缀，同一秒内多次写仍可区分（D-122）。 */
const SNAPSHOT_RE = /^micro_\d{8}_\d{6}(?:_\d{3})?(?:_\d+)?\.md$/;

function stampForFile(ms) {
  const d = new Date(ms);
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  const p3 = (n) => (n < 10 ? '00' + n : n < 100 ? '0' + n : '' + n);
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_'
    + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + '_'
    + p3(ms % 1000);
}

/** 写一份快照；返回路径与字节数。写完后只保留最近 SNAPSHOT_KEEP 份。 */
export function writeSnapshot(snap) {
  if (!snap || !snap.sid) throw new Error('快照缺少会话 id');
  const dir = storeDirFor(snap.sid);
  fs.mkdirSync(dir, { recursive: true });
  const ms = typeof snap.atMs === 'number' ? snap.atMs : Date.now();
  const base = 'micro_' + stampForFile(ms);
  // 同一 atMs 连续写 2 次时追加序号，避免后写覆盖前写（D-122）。
  let file = path.join(dir, base + '.md');
  for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, base + '_' + n + '.md');
  const text = renderSnapshot(snap);
  writeFileAtomic(file, text);
  try {
    const names = fs.readdirSync(dir).filter((n) => SNAPSHOT_RE.test(n)).sort();
    for (const name of names.slice(0, Math.max(0, names.length - SNAPSHOT_KEEP))) {
      try { fs.unlinkSync(path.join(dir, name)); } catch { /* 删除失败忽略 */ }
    }
  } catch { /* 清理失败不影响写入 */ }
  return { path: file, bytes: Buffer.byteLength(text, 'utf8') };
}

/** 列出某会话的快照：份数与最近一份。 */
export function listSnapshots(sid) {
  const dir = storeDirFor(sid);
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => SNAPSHOT_RE.test(n)).sort(); } catch { names = []; }
  const latest = names.length ? names[names.length - 1] : '';
  return {
    count: names.length,
    latest,
    latestPath: latest ? path.join(dir, latest) : '',
    dir,
  };
}

// 旁路语义摘要：默认关闭；仅记录调用次数，便于验收「默认配置零调用」。
let bypassCalls = 0;

export function bypassCount() { return bypassCalls; }
export function resetBypassCount() { bypassCalls = 0; }

/**
 * 可选的旁路语义摘要。仅在配置开启且触发类别属于里程碑、同错重复时调用一次，上限 200 字。
 * 任一环节失败都静默回退代码抽取，不阻断主流程。
 * @param {object} ctx 需提供 llm（可为 null）
 * @param {object} snap
 * @param {object} cfg
 * @param {string} trigger anomaly | milestone | repeat；其他值不调用
 * @returns {Promise<{used:boolean, text:string, error:string, skipped?:string}>}
 */
export async function maybeSemanticSnapshot(ctx, snap, cfg, trigger) {
  if (!cfg || cfg.bypassModel !== true) return { used: false, text: '', error: '' };
  if (['anomaly', 'milestone', 'repeat'].indexOf(String(trigger || '')) === -1) {
    return { used: false, text: '', error: '', skipped: '触发类别不在 anomaly、milestone、repeat 之内' };
  }
  const llm = serviceOf(ctx, null, 'llm');
  if (!llm) return { used: false, text: '', error: 'llm 服务不可用' };
  const call = llm.chat || llm.generate || llm.complete;
  if (typeof call !== 'function') return { used: false, text: '', error: 'llm 无可用调用方法' };
  const prompt = [
    '把下面 6 项压成不超过 200 字的中文摘要，只写可核对的事实与路径，不抄原文：',
    '目标：' + snap.goal,
    '已确认事实：' + (snap.facts || []).join('；'),
    '未决：' + (snap.pending || []).join('；'),
    '下一步：' + snap.next,
    '指针：' + (snap.pointers || []).join('；'),
  ].join(String.fromCharCode(10));
  bypassCalls++;
  try {
    const r = await call.call(llm, { prompt, maxTokens: 300 });
    const text = typeof r === 'string' ? r : String((r && (r.text || r.content)) || '');
    const max = cfg.bypassModelMaxChars || 200;
    return { used: true, text: text.slice(0, max), error: '' };
  } catch (e) {
    return { used: true, text: '', error: String(e && e.message ? e.message : e) };
  }
}
