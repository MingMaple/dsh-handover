/** 会话事件派生：已压缩次数与压缩锁状态。主数据源＝会话日志（eventsOf 在本运行时常常为空），事件数组只作兜底。 */
import fs from 'node:fs';
import path from 'node:path';
import { findLog, decodeLog } from './zstd-log.mjs';
import { projCacheDir } from './sessions.mjs';

/** 取本会话事件数组；无法获取返回 []。 */
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

// 按 (sid, 日志 size+mtime) 缓存，避免每轮解几 MB 日志。
const cache = new Map();

/** 从会话日志读压缩状态：{ used, lock, lastSummaryMs, source }。读不到日志时退回事件数组。 */
export function compactionStateOf(sessionId, exec) {
  const fromEvents = () => {
    const c = countCompactions(eventsOf(exec));
    return { used: c.used, lock: c.lock, lastSummaryMs: null, source: 'events' };
  };
  const sid = sessionId ? String(sessionId) : '';
  if (!sid) return fromEvents();
  const file = findLog(sid);
  if (!file) return fromEvents();
  let st = null;
  try { st = fs.statSync(file); } catch { return fromEvents(); }
  const hit = cache.get(sid);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.value;
  let recs = null;
  try { recs = decodeLog(file); } catch { recs = null; }
  if (!recs || !recs.length) return fromEvents();
  const c = countCompactions(recs);
  let last = null;
  for (const r of recs) {
    if (r && r.type === 'compaction/summary' && typeof r.time === 'number') last = last === null ? r.time : Math.max(last, r.time);
  }
  const value = { used: c.used, lock: c.lock, lastSummaryMs: last, source: 'log' };
  cache.set(sid, { size: st.size, mtimeMs: st.mtimeMs, value });
  return value;
}

/** 投影缓存里该会话文件的 mtimeMs（判断「压缩刚完成、缓存未刷新」用）。 */
function projCacheMtimeOf(sessionId) {
  const sid = sessionId ? String(sessionId) : '';
  if (!sid) return null;
  try {
    const dir = projCacheDir();
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      if (name.replace('.json', '') !== sid) continue;
      return fs.statSync(path.join(dir, name)).mtimeMs;
    }
  } catch { /* ignore */ }
  return null;
}

/** 压缩后读数滞后提示：日志里已有 summary，但投影缓存比它旧 ⇒ 返回一句中文提示，否则空串。 */
export function stalePressureNote(sessionId) {
  const st = compactionStateOf(sessionId, null);
  if (!st.lastSummaryMs) return '';
  const m = projCacheMtimeOf(sessionId);
  if (m === null || m >= st.lastSummaryMs) return '';
  return '（压缩刚完成，投影缓存尚未刷新，水位读数滞后一轮；下一次请求后自动正常）';
}
