/**
 * 一次性后台提醒（1.0）：35% 与 50% 各投一次。
 *
 * 投递方式（用户定）：尾注入（Tail-end Injection）。插件工具返回结果时，把提醒贴在结果的末尾，
 * 模型在下一步立刻读到；不改系统提示词（避免改写前缀缓存）、不拆回合、不另起消息、不打断工具。
 * 不往会话日志写任何事件：宿主对 developer/message 有「必须匹配已打开的轮与步」的强校验，
 * 写事件会把会话写成 SessionFormatError（已实测发生过）。
 *
 * 两处风险：
 *   1) 压缩刚完成时投影缓存还是压缩前的旧水位，跳过恢复后的第一次判定。
 *   2) 模型整轮不调用插件工具时没有注入点；此时它可自行用 ho_status 读水位。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSessionPressurePct } from './sessions.mjs';

export function remindersPath() {
  return path.join(os.homedir(), '.dsh', 'storages', 'dsh-handover.reminders.json');
}

export function readReminderState() {
  try {
    const v = JSON.parse(fs.readFileSync(remindersPath(), 'utf8').replace(/^\uFEFF/, ''));
    const sessions = v && typeof v.sessions === 'object' && v.sessions ? v.sessions : {};
    return { version: 1, sessions };
  } catch {
    return { version: 1, sessions: {} };
  }
}

function writeReminderState(state) {
  const file = remindersPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + String.fromCharCode(10), 'utf8');
  fs.renameSync(tmp, file);
}

/** 35% 提醒文本。 */
export function remindText35() {
  return '当前上下文约占窗口 35%。请把正在做的任务收束到适合暂停的位置；随后判断剩余总流程：'
    + '较少则继续完成；较多则做完当前小步骤后停下，向当前用户确认继续完成，'
    + '或写出剩余流程的行动计划、刷新交接后走压缩或换任。'
    + '判断标准：能十分保证完成全部剩余流程后，上下文占用不超过 45%。本条为一次性后台提醒。';
}

/** 50% 提醒文本。 */
export function remindText50() {
  return '当前上下文约占窗口 50%。请把正在做的任务收束到适合暂停的位置；随后判断剩余总流程：'
    + '较少则继续完成；较多则做完当前小步骤后停下，向当前用户确认继续完成，'
    + '或写出剩余流程的行动计划、刷新交接后走压缩或换任。'
    + '判断标准：能十分保证完成全部剩余流程后，上下文占用不超过 55%。本条为一次性后台提醒。';
}

/**
 * 判定一次：水位到线且该线未提醒过时写状态并返回提醒正文。
 * 只应由「工具返回结果」这条路径调用：那时模型正好在等下一次装配。
 * @param {{ remindRatio?: number, remind2Ratio?: number }} cfg
 * @param {string} sid 会话 id
 * @returns {string} 提醒正文；不需要投时为空串
 */
export function checkReminder(cfg, sid) {
  const id = String(sid || '');
  if (!id) return '';
  const state = readReminderState();
  const rec = state.sessions[id] || {};
  // 压缩刚完成后的那次判定：投影缓存可能还是压缩前的旧水位，跳过。
  if (rec.skipNext) {
    rec.skipNext = false;
    state.sessions[id] = rec;
    try { writeReminderState(state); } catch { /* 写盘失败不阻断工具 */ }
    return '';
  }
  const pct = readSessionPressurePct(id);
  if (pct === null || pct === undefined) return '';
  const r1 = (cfg && cfg.remindRatio !== undefined ? cfg.remindRatio : 0.35) * 100;
  const r2 = (cfg && cfg.remind2Ratio !== undefined ? cfg.remind2Ratio : 0.5) * 100;
  const parts = [];
  let changed = false;
  if (pct >= r1 && !rec.r35) { rec.r35 = true; changed = true; parts.push(remindText35()); }
  if (pct >= r2 && !rec.r50) { rec.r50 = true; changed = true; parts.push(remindText50()); }
  if (!changed) return '';
  state.sessions[id] = rec;
  try { writeReminderState(state); } catch { /* 写盘失败不阻断工具 */ }
  return parts.join(String.fromCharCode(10, 10));
}

/**
 * 工具结果末尾的提醒尾巴：命中阈值时返回要 append 的文本，否则空串。
 * 形如 `[System Note: …]`，紧贴工具结果，模型下一步立刻读到。
 * @param {{ remindRatio?: number, remind2Ratio?: number }} cfg
 * @param {string} sid 会话 id
 */
export function reminderTailNote(cfg, sid) {
  const text = checkReminder(cfg, sid);
  if (!text) return '';
  return '[System Note: ' + text + ']';
}

/** 记一次「压缩后跳过下一轮判定」；由 ho_checkpoint 在登记压缩时写入。 */
export function markSkipNext(sid) {
  const id = String(sid || '');
  if (!id) return;
  const state = readReminderState();
  const rec = state.sessions[id] || {};
  rec.skipNext = true;
  state.sessions[id] = rec;
  try { writeReminderState(state); } catch { /* 写盘失败只影响一次判定 */ }
}
