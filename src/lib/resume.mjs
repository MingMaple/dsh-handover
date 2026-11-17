/**
 * 显式重置回填：每次显式重置至多一条可见消息，5 分钟内连续重置合并为一条。
 * 只经 sendPrompt(..., 'queue') 投递；不写会话事件，不改系统提示结构。
 * 回填记录属会话级产物，随会话状态存放在会话目录内 `<sid>\dsh-handover\`。
 */
import { readSessionState, writeSessionState } from './store.mjs';

const NL = String.fromCharCode(10);
const DEFAULT_MERGE_MS = 5 * 60 * 1000;

/**
 * 是否投递回填消息。
 * 距上次投递不足合并窗口时只累加合并计数、不投递，避免连续重置产生多条消息。
 * @param {string} sid 会话 id
 * @param {number} nowMs 当前时刻
 * @param {number} mergeMs 合并窗口毫秒数
 * @returns {{send:boolean, sinceMs:number|null, merged:boolean}}
 */
export function shouldSendBackfill(sid, nowMs, mergeMs) {
  const id = String(sid || '');
  if (!id) return { send: false, sinceMs: null, merged: false };
  const state = readSessionState(id);
  const rec = state.backfill || {};
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  const win = typeof mergeMs === 'number' && mergeMs > 0 ? mergeMs : DEFAULT_MERGE_MS;
  const lastAt = typeof rec.lastAt === 'number' ? rec.lastAt : null;
  if (lastAt !== null && now - lastAt < win) {
    rec.merged = (rec.merged || 0) + 1;
    state.backfill = rec;
    try { writeSessionState(id, state); } catch { /* 合并计数失败不阻断 */ }
    return { send: false, sinceMs: now - lastAt, merged: true };
  }
  return { send: true, sinceMs: lastAt === null ? null : now - lastAt, merged: false };
}

/** 记录一次已投递；merged 清零，保留历史总数。 */
export function markBackfill(sid, nowMs, snapshotPath) {
  const id = String(sid || '');
  if (!id) return;
  const state = readSessionState(id);
  const rec = state.backfill || {};
  const total = (rec.total || 0) + 1;
  state.backfill = {
    lastAt: typeof nowMs === 'number' ? nowMs : Date.now(),
    total,
    merged: 0,
    lastSnapshot: String(snapshotPath || ''),
  };
  try { writeSessionState(id, state); } catch { /* 记录失败不阻断投递 */ }
}

/** 某会话的回填统计：最近投递时刻、总数、合并数。 */
export function backfillStats(sid) {
  const rec = readSessionState(String(sid || '')).backfill || {};
  return {
    lastAt: typeof rec.lastAt === 'number' ? rec.lastAt : null,
    total: rec.total || 0,
    merged: rec.merged || 0,
    lastSnapshot: String(rec.lastSnapshot || ''),
  };
}

/** 用户明确要求重置状态时使用（只清本会话）。 */
export function resetBackfill(sid) {
  const id = String(sid || '');
  if (!id) return;
  const state = readSessionState(id);
  state.backfill = {};
  try { writeSessionState(id, state); } catch { /* ignore */ }
}

/**
 * 回填正文：快照路径、交接路径、段索引与检索提示。
 * @param {{n?:number, snapshotPath?:string, handoverPath?:string, segmentCount?:number,
 *   lastLabel?:string, merged?:number, role?:string}} input
 */
export function buildBackfillText(input) {
  const i = input || {};
  const lines = [];
  lines.push('【dsh-handover 压缩后回填】第 ' + (i.n || 1) + ' 次压缩已完成。历史已由摘要替换，原文仍保留在会话日志中。');
  lines.push('快照：' + (i.snapshotPath || '（未生成）'));
  lines.push('交接：' + (i.handoverPath || '（未解析）'));
  if (typeof i.segmentCount === 'number') {
    lines.push('段索引：' + i.segmentCount + ' 段' + (i.lastLabel ? '，最近一段「' + i.lastLabel + '」' : '') + '。');
  }
  if (i.merged) lines.push('合并：5 分钟内的 ' + i.merged + ' 次压缩并入本条，不另行提醒。');
  lines.push('回读：`ho_status(view="recall", query="关键词")`。命中返回 `seq` 指针、前后 3 行与所属段。');
  lines.push('恢复顺序：先读交接，再读计划，后执行；不复述、不重做已完成事项。');
  if (!i.handoverPath) lines.push('本会话没有交接路径。处置：按快照与段索引继续；需要交接时先在设置页设定角色。');
  return lines.join(NL);
}

/** 回填与续跑合并成一条消息，避免连续 2 次压缩各投 1 条。 */
export function composeResumeMessage(backfillText, resumeText) {
  const a = String(backfillText || '').trim();
  const b = String(resumeText || '').trim();
  if (a && b) return a + NL + NL + b;
  return a || b;
}
