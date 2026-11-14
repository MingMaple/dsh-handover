/**
 * 一次性后台提醒（1.0）：35% 与 50% 各注入一次。
 *
 * 实现方式：提示段的 text 为函数，宿主每次装配系统提示时调用。
 * 函数读取本会话水位，命中阈值且未提醒过时写入状态并返回提醒文本；
 * 因此提醒只出现在系统提示中，不生成用户消息、不独立成轮、不分割回合。
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
  return '【dsh-handover 上下文提醒】当前上下文约占窗口 35%。'
    + '请把正在做的任务收束到适合暂停的位置；随后判断剩余总流程：较少则继续完成；较多则做完当前小步骤后停下，'
    + '向当前用户确认继续完成，或写出剩余流程的行动计划、刷新交接后走压缩或换任。'
    + '判断标准：能十分保证完成全部剩余流程后，上下文占用不超过 45%。本条为一次性后台提醒。';
}

/** 50% 提醒文本。 */
export function remindText50() {
  return '【dsh-handover 上下文提醒】当前上下文约占窗口 50%。'
    + '请把正在做的任务收束到适合暂停的位置；随后判断剩余总流程：较少则继续完成；较多则做完当前小步骤后停下，'
    + '向当前用户确认继续完成，或写出剩余流程的行动计划、刷新交接后走压缩或换任。'
    + '判断标准：能十分保证完成全部剩余流程后，上下文占用不超过 55%。本条为一次性后台提醒。';
}

/**
 * 生成提醒段的 text 函数：命中一次即记录，返回空串时该段不进入提示。
 * @param {{ remindRatio?: number, remind2Ratio?: number }} cfg
 * @param {string} sid 会话 id
 */
export function reminderTextFor(cfg, sid) {
  const r1 = (cfg && cfg.remindRatio !== undefined ? cfg.remindRatio : 0.35) * 100;
  const r2 = (cfg && cfg.remind2Ratio !== undefined ? cfg.remind2Ratio : 0.5) * 100;
  return function text() {
    const id = String(sid || '');
    if (!id) return '';
    const pct = readSessionPressurePct(id);
    if (pct === null || pct === undefined) return '';
    const state = readReminderState();
    const rec = state.sessions[id] || {};
    const parts = [];
    let changed = false;
    if (pct >= r1 && !rec.r35) { rec.r35 = true; changed = true; parts.push(remindText35()); }
    if (pct >= r2 && !rec.r50) { rec.r50 = true; changed = true; parts.push(remindText50()); }
    if (changed) {
      state.sessions[id] = rec;
      try { writeReminderState(state); } catch { /* 写盘失败不阻断提示装配 */ }
    }
    return parts.join(String.fromCharCode(10, 10));
  };
}
