/**
 * 全局换任的读取入口：只回答「现在的全局是哪一个」。
 *
 * 数据来源是 <工作区根>/_Control_Center/records/Office.json 的「全局」世系；
 * 换任动作（succeed）在登记接任者时写入 current，因此本模块不需要另建通知文件。
 * 读盘按 mtime 缓存：未变化时不解析文件内容。
 */
import fs from 'node:fs';
import { loadOffice, officePath } from './office.mjs';

/** 每个登记文件的最近一次解析结果：file → { sig, holder }。 */
const cache = new Map();

/**
 * 读取全局现任。
 * @param {string} ws 工作区根
 * @returns {object|null} 现任；没有在任或读不到时为 null
 */
export function globalHolder(ws) {
  const root = String(ws || '');
  if (!root) return null;
  const file = officePath(root);
  let sig = '';
  try {
    const st = fs.statSync(file);
    sig = String(st.mtimeMs) + ':' + String(st.size);
  } catch {
    return null;
  }
  const hit = cache.get(file);
  if (hit && hit.sig === sig) return hit.holder;
  let holder = null;
  try {
    const store = loadOffice(root);
    const lin = store.lineages ? store.lineages['全局'] : null;
    const cur = lin && lin.current ? lin.current : null;
    if (cur && cur.sessionId) {
      holder = {
        name: String(cur.name || ''),
        sessionId: String(cur.sessionId),
        since: String(cur.since || ''),
      };
    }
  } catch {
    holder = null;
  }
  cache.set(file, { sig, holder });
  return holder;
}

/** 把「2026-11-21 02:57 +0800」解析为毫秒；解析不出返回 0。 */
function sinceMsOf(since) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/.exec(String(since || '').trim());
  if (!m) return 0;
  const iso = m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':00' + m[6] + m[7] + ':' + m[8];
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/**
 * 判定是否需要提示。
 * @param {object|null} seen 会话已见基线（{sessionId,name}）
 * @param {object|null} cur 全局现任
 * @param {number} sessionStartedAt 本会话首次落盘的时刻（state.createdAt）
 * @returns {{action:'none'|'baseline'|'notice', next:object|null}}
 *   baseline：会话出生于现任全局之后，只记基线不提示；
 *   notice：换代，或会话早于现任全局（休眠后唤醒），提示一次；
 *   none：无变化或无现任。
 */
export function judgeRotation(seen, cur, sessionStartedAt) {
  if (!cur || !cur.sessionId) return { action: 'none', next: seen || null };
  const next = { sessionId: String(cur.sessionId), name: String(cur.name || '') };
  const prev = seen && typeof seen === 'object' ? seen : null;
  if (prev && prev.sessionId) {
    if (String(prev.sessionId) === next.sessionId) return { action: 'none', next };
    return { action: 'notice', next };
  }
  // 没有基线：会话早于现任全局接任时刻时，说明它一直休眠，唤醒即提示；否则只记基线。
  const sinceMs = sinceMsOf(cur.since);
  const startedMs = Number(sessionStartedAt) || 0;
  if (sinceMs > 0 && startedMs > 0 && startedMs < sinceMs) return { action: 'notice', next };
  return { action: 'baseline', next };
}

/** 供自测使用：清空进程内缓存。 */
export function resetHolderCache() {
  cache.clear();
}
