/**
 * peer —— 平级会话：一个入口，按 action 分流。
 *   list 会话一览（只读缓存，不激活任何会话）
 *   status 单会话详情
 *   send 投一条消息（唯一会消耗对方 token 的动作）
 *   peek 读取目标会话近期会话历史（内容进本会话上下文）
 *   rename 只改显示标题
 *   new 新建平级会话
 * 原 peer_list、peer_status、peer_send、peer_peek、peer_rename、peer_new 合并于此。
 * 动作级权限在这里再判一次：角色矩阵只决定「这个工具可不可见」，不细分动作。
 */
import { randomUUID } from 'node:crypto';
import { sendPrompt } from '../lib/prompt.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { textOutput } from '../lib/output.mjs';
import { PEER_NAME } from '../lib/names.mjs';
import { NL, writeFileAtomic } from '../lib/text.mjs';
import { bandsFor } from '../lib/pressure.mjs';
import { findLog, decodeLog } from '../lib/zstd-log.mjs';
import { readPressure } from '../lib/sessions.mjs';
import { ABORTED_TEXT, abortableDelay, aborted, signalOf } from '../lib/abort.mjs';
import {
  readProjCache, rowLine, sessionRows, stamp, isSubagent, isBusy,
  projectName, pick, peerMarker, resolveWorkspaceId, sessionsRoot, conversation,
} from '../lib/peer.mjs';

export const ACTIONS = ['list', 'status', 'send', 'wait', 'collect', 'collab', 'peek', 'rename', 'new'];
const GLOBAL_ONLY = ['list', 'peek', 'rename'];

const COLLECT_POLL_MS = 30000;
const WAIT_MIN_MS = 120000;
/** 协作注册的存活上限：协调者崩溃或忘记结束时，过期即自动解除明文限制。 */
const COLLAB_TTL_MS = 12 * 60 * 60 * 1000;

/** 协作游标：交办者 → 目标 → { since }。只存时间戳，不存消息正文。 */
function collectFile() {
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  return path.join(home, '.dsh', 'storages', 'dsh-handover.collect.json');
}
function loadCollect() {
  try {
    const data = JSON.parse(fs.readFileSync(collectFile(), 'utf8'));
    if (data && typeof data === 'object' && data.cursors) {
      if (!Array.isArray(data.groups)) data.groups = [];
      return data;
    }
  } catch (error) { void error; }
  return { version: 1, cursors: {}, groups: [] };
}
function saveCollect(data) {
  // 写盘前统一剔除过期组，异常路径（协调者崩溃/忘记结束）也能解除限制。
  refreshGroups(data);
  writeFileAtomic(collectFile(), JSON.stringify(data, null, 2));
}
function callerOf(exec) {
  return String(exec?.agent?.session?.header?.id ?? 'unknown');
}
function sinceOf(data, caller, target) {
  const row = data.cursors[caller] && data.cursors[caller][target];
  return row && Number.isFinite(row.since) ? row.since : null;
}
function setSince(data, caller, target, since) {
  if (!data.cursors[caller]) data.cursors[caller] = {};
  data.cursors[caller][target] = { since };
}

/** 协作注册：被交办方在协作期间不得向交办者或同组成员发明文消息；收集完或超时自动解除。 */
function groupsOf(state) {
  return Array.isArray(state.groups) ? state.groups : [];
}
/** 只留未过期的组：`at` 缺失或超龄都按解除处理，避免崩溃/重启后永久拦截。 */
function activeGroups(state) {
  const now = Date.now();
  return groupsOf(state).filter((g) => {
    const at = Number(g && g.at);
    return Number.isFinite(at) && at > 0 && now - at < COLLAB_TTL_MS;
  });
}
/** 原地剔除过期组，返回剔除数量。 */
function refreshGroups(state) {
  const before = groupsOf(state).length;
  state.groups = activeGroups(state);
  return before - state.groups.length;
}
function groupOf(state, sid) {
  return activeGroups(state).find((g) => String(sid) === String(g.coordinator) || (Array.isArray(g.members) && g.members.indexOf(String(sid)) !== -1)) || null;
}
function assertNotReplyingInCollab(state, sender, target) {
  const g = groupOf(state, sender);
  if (!g) return;
  if (String(sender) === String(g.coordinator)) return;
  const inGroup = String(target) === String(g.coordinator)
    || (Array.isArray(g.members) && g.members.indexOf(String(target)) !== -1);
  if (!inGroup) return;
  throw new Error(
    '现象：协作注册期间，被交办方尝试向交办者或同组成员发送明文消息（`target=' + target + '`）。'
    + '原因：成员的结果由协调者用 `peer(action="collect")` 取回，明文消息会打乱协作流程。'
    + '处置：完成即结束回合，最终回复即为结果；如需请示，将问题写入最终回复并结束回合。普通对话不受此限制。',
  );
}

/**
 * 供宿主工具守卫使用：某会话是协作成员（非协调者）时返回拒绝理由，否则空串。
 * 用于拦住 DSH 自带的 send_message 等明文投递通道。
 *
 * @param {string} sid 待判定的会话 id。
 * @param {string} [target] 目标会话 id；取不到时维持全禁。
 * @returns {string} 拒绝理由；不受限制时为空串。
 */
export function collabMemberReason(sid, target) {
  try {
    const state = loadCollect();
    const g = groupOf(state, sid);
    if (!g) return '';
    if (String(sid) === String(g.coordinator)) return '';
    // 解析到目标时按目标判定，与 assertNotReplyingInCollab 同一口径：向第三方求援/转交应放行。
    const t = String(target == null ? '' : target).trim();
    if (t) {
      const inGroup = String(t) === String(g.coordinator)
        || (Array.isArray(g.members) && g.members.indexOf(String(t)) !== -1);
      if (!inGroup) return '';
      return '协作注册期间，被交办方不得向交办者或同组成员（`target=' + t + '`）发送明文消息。处置：完成即结束回合，最终回复由协调者用 `peer(action="collect")` 取回。';
    }
    // 目标解析不到时维持全禁，避免守卫因入参差异被绕过。
    return '协作注册期间，被交办方不得发送明文消息。处置：完成即结束回合，最终回复由协调者用 `peer(action="collect")` 取回。';
  } catch (error) { void error; }
  return '';
}

/** 协作注册：开始或结束一组协作；结束即解除明文交流限制。 */
function collabText(args, exec) {
  const caller = callerOf(exec);
  const state = loadCollect();
  // 结束模式取 collabMode（schema 参数名）；兼容早期把 mode 当结束开关的调用。
  const ending = args.collabMode === 'end' || args.mode === 'end';
  if (ending) {
    const before = groupsOf(state).length;
    state.groups = groupsOf(state).filter((g) => String(g.coordinator) !== String(caller));
    saveCollect(state);
    return '已结束协作注册（' + String(before - state.groups.length) + ' 组），明文交流限制已解除。';
  }
  const members = (Array.isArray(args.sessions) ? args.sessions : [])
    .map((x) => String(x || '').trim()).filter(Boolean).filter((s) => s !== caller);
  if (!members.length) throw new Error('现象：`peer(action="collab")` 的 `sessions` 为空。原因：协作注册至少需要一个成员会话。处置：在 `sessions` 中列出至少一个协作会话。');
  state.groups = groupsOf(state).filter((g) => String(g.coordinator) !== String(caller));
  state.groups.push({ coordinator: caller, members, at: Date.now() });
  saveCollect(state);
  return '已注册协作：协调者 ' + caller + '，成员 ' + members.join('、')
    + '。协作期间成员不得向协调者或同组成员发送明文消息；`collect` 取回全部结果后自动解除。';
}

/** 助手文本：读目标日志里 since 之后的助手回复，不定长截断。 */
function assistantReplies(file, sinceMs) {
  const events = decodeLog(file);
  if (events === null) return null;
  const items = conversation(events, 500).filter((it) => it.who === 'assistant' && Number(it.t) > sinceMs);
  return items.map((it) => it.text);
}

function releaseMembers(state, caller, closed) {
  const groups = groupsOf(state);
  const g = groups.find((x) => String(x.coordinator) === caller);
  if (!g) return;
  g.members = (Array.isArray(g.members) ? g.members : []).filter((m) => closed.indexOf(String(m)) === -1);
  if (!g.members.length) state.groups = groups.filter((x) => x !== g);
}

/** 单个目标的完成判定：这一轮已结束，且 since 之后有助手文本。 */
function inspectTarget(sid, since) {
  const file = findLog(sid, sessionsRoot());
  if (file === null) return { sid, state: 'missing', text: '' };
  let replies = null;
  try { replies = assistantReplies(file, since); } catch (error) { void error; }
  if (replies === null) return { sid, state: 'nozstd', text: '' };
  const cache = readProjCache(sid);
  const busy = cache === null ? null : isBusy(cache);
  if (busy === false && replies.length) {
    return { sid, state: 'done', text: replies[replies.length - 1], at: Date.now() };
  }
  return { sid, state: busy === null ? 'unknown' : busy ? 'running' : 'ended-no-text', text: '' };
}

/** 一对一：等单个目标的回复。 */
async function waitText(args, signal) {
  const sid = String(args.session_id || '').trim();
  if (!sid) throw new Error('现象：`peer(action="wait")` 缺少 `session_id`。原因：等待回复须指定目标会话。处置：传入目标会话 id 后重试。');
  const timeout = Math.max(WAIT_MIN_MS, Math.min(3600000, Number(args.timeout_ms) || WAIT_MIN_MS));
  const since = Number(args.since_ms) || Date.now();
  const deadline = Date.now() + timeout;
  let lastError = '';
  for (;;) {
    if (aborted(signal)) return ABORTED_TEXT;
    const one = inspectTarget(sid, since);
    if (one.state === 'done') return '回复 ' + sid + '：' + NL + one.text;
    if (one.state === 'missing') throw new Error('现象：未找到目标会话日志：`' + sid + '`。原因：该会话没有可读取的日志文件。处置：先用 `peer(action="status")` 核对会话 id。');
    if (one.state === 'nozstd') throw new Error('现象：当前 Node 构建不支持 zstd，无法读取会话日志。原因：运行环境缺少 zstd 解压能力。处置：升级 Node 至支持的版本后重试。');
    lastError = one.state;
    if (Date.now() >= deadline) break;
    if (await abortableDelay(2000, signal) === 'aborted') return ABORTED_TEXT;
  }
  return '等待超时（' + String(Math.round(timeout / 1000)) + ' 秒）：`' + sid + '` 状态 ' + lastError
    + '。处置：先用 `peer(action="status")` 查看状态，稍后重试 `wait`。';
}

/**
 * 多会话收集：列出若干会话，谁先完成先返回；同时完成多个则一起返回。
 * 一次调用最多等 timeout_ms，最低 120 秒，由助手按任务预估设置。
 * 到点一个都没完成时，返回仍在运行的名单。
 */
async function collectText(args, exec, signal) {
  const caller = callerOf(exec);
  const state = loadCollect();
  const list = Array.isArray(args.sessions)
    ? args.sessions.map((x) => String(x || '').trim()).filter(Boolean)
    : [];
  const targets = list.length ? list : Object.keys(state.cursors[caller] || {});
  if (!targets.length) throw new Error('现象：`peer(action="collect")` 的 `sessions` 为空，且没有已交办的目标。原因：收集须给出会话 id，或先有交办记录。处置：在 `sessions` 中列出目标会话 id。');
  const timeout = Math.max(WAIT_MIN_MS, Math.min(3600000, Number(args.timeout_ms) || WAIT_MIN_MS));
  const deadline = Date.now() + timeout;
  const explicitSince = Number(args.since_ms) || null;
  const since = {};
  for (const sid of targets) since[sid] = sinceOf(state, caller, sid) ?? explicitSince ?? Date.now();
  const done = [];
  const unreachable = [];
  const running = new Map(targets.map((sid) => [sid, 'running']));
  for (;;) {
    if (aborted(signal)) return ABORTED_TEXT;
    let deadNow = false;
    for (const sid of targets) {
      if (done.some((d) => d.sid === sid) || unreachable.some((u) => u.sid === sid)) continue;
      const one = inspectTarget(sid, since[sid]);
      running.set(sid, one.state);
      if (one.state === 'done') done.push(one);
      // 日志不存在或解码不可用属于终结状态：本轮即解除该成员的协作限制，不再空等。
      else if (one.state === 'missing' || one.state === 'nozstd') {
        unreachable.push({ sid, state: one.state });
        deadNow = true;
      }
    }
    if (deadNow) {
      releaseMembers(state, caller, unreachable.map((u) => u.sid));
      saveCollect(state);
    }
    if (done.length) {
      for (const one of done) setSince(state, caller, one.sid, one.at);
      releaseMembers(state, caller, done.map((d) => d.sid));
      saveCollect(state);
      const out = ['已完成 ' + String(done.length) + ' 个：'];
      for (const one of done) out.push('[' + one.sid + ']' + NL + one.text);
      if (unreachable.length) {
        out.push('');
        out.push('另有 ' + String(unreachable.length) + ' 个不可达（已解除其协作限制）：');
        for (const one of unreachable) out.push('  ' + one.sid + '  ' + unreachableLabel(one.state));
      }
      return out.join(NL);
    }
    // 全部目标都已终结且没有完成项：立即返回不可达清单，不必等满 timeout。
    if (unreachable.length >= targets.length) {
      const out = ['本轮没有完成的会话；不可达 ' + String(unreachable.length) + ' 个（已解除其协作限制）：'];
      for (const one of unreachable) out.push('  ' + one.sid + '  ' + unreachableLabel(one.state));
      out.push('处置：先用 `peer(action="status")` 核对会话 id，再重试 `collect`。');
      return out.join(NL);
    }
    if (Date.now() >= deadline) break;
    if (await abortableDelay(COLLECT_POLL_MS, signal) === 'aborted') return ABORTED_TEXT;
  }
  const lines = ['本轮没有完成的会话（已等待 ' + String(Math.round(timeout / 1000)) + ' 秒）：'];
  for (const sid of targets) lines.push('  ' + sid + '  ' + (running.get(sid) || 'running'));
  if (unreachable.length) {
    lines.push('不可达（已解除其协作限制）：');
    for (const one of unreachable) lines.push('  ' + one.sid + '  ' + unreachableLabel(one.state));
  }
  lines.push('处置：稍后重试 `collect`；不可达的会话先用 `peer(action="status")` 核对 id。');
  return lines.join(NL);
}

function unreachableLabel(state) {
  return state === 'missing' ? '日志不存在' : '当前 Node 不支持 zstd，无法解码';
}

function roleOf(env, exec) {
  try { return env.roleOf(exec) || { role: 'plain' }; } catch { return { role: 'plain' }; }
}

function denyUnless(ok, action, why) {
  if (!ok) throw new Error('现象：`peer(action="' + action + '")` 被拒绝。原因：' + why + '。处置：改由具备该权限的会话执行。');
}

async function listText(env, args, signal) {
  const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(200, Math.trunc(args.limit))) : 40;
  const controller = env.controller();
  if (!controller || typeof controller.list !== 'function') {
    throw new Error('现象：`peer(action="list")` 失败。原因：`sessionController` 未注入，会话列表不可用。处置：确认 DSH 版本与插件装配后重启。');
  }
  const rows = await sessionRows(controller, args.include_subagents === true, signal);
  if (rows.length === 0) return '没有可列的会话。';
  return rows.slice(0, limit).map((row) => {
    const cache = readProjCache(row.sessionId);
    const state = row.running ? 'running' : row.agentAvailable ? 'idle' : 'cold';
    return rowLine(row.sessionId, cache, state) + ' | ' + stamp(row.updatedAt);
  }).join(NL);
}

async function statusText(env, args, signal) {
  const controller = env.controller();
  if (!controller || typeof controller.list !== 'function') {
    throw new Error('现象：`peer(action="status")` 失败。原因：`sessionController` 未注入，会话列表不可用。处置：确认 DSH 版本与插件装配后重启。');
  }
  const sid = String(args.session_id || '').trim();
  if (!sid) throw new Error('现象：`peer(action="status")` 缺少 `session_id`。原因：查询详情须指定目标会话。处置：传入目标会话 id 后重试。');
  const cache = readProjCache(sid);
  const rows = await sessionRows(controller, true, signal);
  const row = rows.find((r) => r.sessionId === sid) ?? null;
  if (cache === null && row === null) return '现象：未找到会话：`' + sid + '`。原因：该会话 id 不存在，或缓存与日志均不可读。处置：先用 `peer(action="list")` 核对会话 id。';
  const stats = pick(cache, 'record', 'rows', 'sessionStats', 'val') ?? {};
  const p = cache === null ? { used: null, win: null } : readPressure(cache);
  const pct = p.used === null || !p.win ? null : (p.used / p.win) * 100;
  const bands = p.win ? bandsFor(env.cfg, p.win) : null;
  const hot = bands !== null && p.used !== null && p.used >= bands.soft;
  return [
    '会话      ' + sid,
    '类型      ' + (cache === null ? '?' : isSubagent(cache) ? '子会话（subagent）' : '平级会话（peer）'),
    '项目      ' + (cache === null ? '-' : projectName(cache)),
    '水位      ' + (pct === null ? '?' : pct.toFixed(1) + '%') + (hot ? '  已进入预警区' : ''),
    '状态      ' + (isBusy(cache) === true ? 'running' : row === null ? 'cold' : row.agentAvailable ? 'idle' : 'cold'),
    '轮次与步数 ' + String(stats.turns ?? '?') + ' / ' + String(stats.steps ?? '?'),
    '工作目录  ' + String(row?.cwd ?? pick(cache, 'record', 'identity', 'cwd') ?? '-'),
    '预设      ' + String(pick(cache, 'record', 'rows', 'agentPreset', 'val') ?? '-'),
    '更新      ' + stamp(row?.updatedAt ?? pick(cache, 'record', 'identity', 'createdAt')),
  ].join(NL);
}

async function sendText(env, args, exec, info, signal) {
  const controller = env.controller();
  if (!controller || typeof controller.prompt !== 'function') {
    throw new Error('现象：`peer(action="send")` 失败。原因：`sessionController.prompt` 未注入，消息投递不可用。处置：确认 DSH 版本与插件装配后重启。');
  }
  const target = String(args.session_id || '').trim();
  if (!target) throw new Error('现象：`peer(action="send")` 缺少 `session_id`。原因：投递消息须指定目标会话。处置：传入目标会话 id 后重试。');
  // 归档会话被宿主的归档闸门拦住：投递会被接受，轮次却立即以 blocked 结束。
  // 现象上是「发出去了但没反应」，所以在这里先拦一次，并给出解除归档的处置。
  let archived = null;
  try {
    const reg = typeof env.registry === 'function' ? env.registry() : null;
    archived = reg && Array.isArray(reg.archivedSessionIds) ? reg.archivedSessionIds : null;
  } catch { archived = null; }
  if (archived && archived.indexOf(target) !== -1) {
    throw new Error('现象：目标会话已归档：`' + target + '`。原因：归档会话被宿主的 archived-session-gate 拦住。投递会被接受，轮次却立即以 blocked 结束，不会产生回复。处置：先解除归档 `ho_sessions(action="unarchive", session_id="' + target + '")`，再重新投递。');
  }
  const message = typeof args.message === 'string' ? args.message : '';
  if (message.trim() === '') throw new Error('现象：`peer(action="send")` 的 `message` 为空。原因：投递内容不得为空。处置：传入非空的 `message` 后重试。');
  const mode = args.mode === 'steer' ? 'steer' : 'queue';
  // 来源标记：dsh 把宿主投递的消息记成 source.kind === "user"，不加标记的话，
  // 平级会话的消息在日志和界面上与用户消息完全无法区分。
  const sender = exec?.agent?.session?.header?.id ?? 'unknown';
  const marker = peerMarker(sender);
  const body = message.startsWith(marker) ? message : marker + NL + message;
  const before = loadCollect();
  assertNotReplyingInCollab(before, sender, target);
  if (aborted(signal)) return ABORTED_TEXT;
  const since = Date.now();
  let receipt = null;
  try {
    // 走统一投递入口：冷会话先 resume 再 prompt，否则消息进队列但不会启动轮次。
    receipt = await sendPrompt(controller, target, body, mode, signal || new AbortController().signal);
  } catch (e) {
    // 投递已发出后被终止：消息不撤回，按中止返回，不当作投递失败。
    if (aborted(signal)) return ABORTED_TEXT;
    throw e;
  }
  try {
    const state = loadCollect();
    setSince(state, sender, target, since);
    saveCollect(state);
  } catch (error) { void error; }
  const head = 'accepted=' + String(receipt.accepted) + ' mode=' + mode + ' target=' + target + ' from=' + sender;
  if (args.wait === true) {
    return head + NL + await waitText({ session_id: target, since_ms: since, timeout_ms: args.timeout_ms }, signal);
  }
  return head;
}

async function peekText(args) {
  const sid = String(args.session_id || '').trim();
  if (!sid) throw new Error('现象：`peer(action="peek")` 缺少 `session_id`。原因：读取历史须指定目标会话。处置：传入目标会话 id 后重试。');
  const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(40, Math.trunc(args.limit))) : 8;
  const file = findLog(sid, sessionsRoot());
  if (file === null) return '现象：未找到会话日志：`' + sid + '`。原因：该会话没有可读取的日志文件。处置：先用 `peer(action="status")` 核对会话 id。';
  const events = decodeLog(file);
  if (events === null) return '现象：当前 Node 构建不支持 zstd，无法读取会话日志。原因：运行环境缺少 zstd 解压能力。处置：升级 Node 至支持的版本后重试。';
  const items = conversation(events, limit);
  const head = '会话 ' + sid + '  |  最近 ' + String(items.length) + ' 条  |  ' + file;
  if (items.length === 0) return head + NL + '（没有可读的会话历史）';
  const body = items.map((it) => {
    const one = it.text.replace(/\s+/g, ' ').trim();
    const cut = one.length > 400 ? one.slice(0, 400) + ' …' : one;
    return '[' + stamp(it.t) + ' ' + it.who + '] ' + cut;
  }).join(NL);
  return head + NL + body;
}

async function renameText(env, args) {
  const controller = env.controller();
  if (!controller || typeof controller.rename !== 'function') {
    throw new Error('现象：`peer(action="rename")` 失败。原因：`sessionController.rename` 未注入，改名不可用。处置：确认 DSH 版本与插件装配后重启。');
  }
  const sid = String(args.session_id || '').trim();
  if (!sid) throw new Error('现象：`peer(action="rename")` 缺少 `session_id`。原因：改名须指定目标会话。处置：传入目标会话 id 后重试。');
  const title = String(args.title ?? '').trim();
  if (title === '') throw new Error('现象：`peer(action="rename")` 的 `title` 为空。原因：标题不得为空。处置：传入非空的 `title` 后重试。');
  await controller.rename({ sessionId: sid, title });
  return '已改名：`' + sid + '` → ' + title + '。';
}

async function newText(env, args, info, signal) {
  const controller = env.controller();
  if (!controller || typeof controller.create !== 'function') {
    throw new Error('现象：`peer(action="new")` 失败。原因：`sessionController.create` 未注入，新建会话不可用。处置：确认 DSH 版本与插件装配后重启。');
  }
  // 会话创建仅属全局；杂项可以把会话建在 Misc 下（落到本任务体系内）。
  const wantsWorkspace = typeof args.workspace === 'string' && args.workspace.trim() !== '';
  if (wantsWorkspace && args.cwd !== undefined) {
    throw new Error('现象：同时传入了 `workspace` 与 `cwd`。原因：`session.create` 只接受其中之一，传 `workspace` 时 `cwd` 自动取该工作区路径。处置：删除 `cwd` 后重试。');
  }
  const targetText = String(args.workspace || args.cwd || '').toLowerCase();
  const allowed = info.role === 'global' || (info.role === 'misc' && targetText.indexOf('misc') !== -1);
  denyUnless(allowed, 'new', '会话创建仅属全局（杂项可建到 Misc 下）');
  let request = {};
  if (wantsWorkspace) {
    const workspaceId = resolveWorkspaceId(args.workspace);
    if (workspaceId === null || workspaceId === undefined) {
      throw new Error('现象：未找到工作区「' + args.workspace + '」。原因：该名称不在工作区登记表中，数据源为 `storages/workspace.json`。处置：改用工作区 id、标题或路径之一重试。');
    }
    request = { workspaceId };
  } else if (args.cwd !== undefined) {
    request = { cwd: args.cwd };
  }
  if (aborted(signal)) return ABORTED_TEXT;
  const created = await controller.create(request);
  const id = created.sessionId;
  if (typeof args.title === 'string' && args.title.trim() !== '') {
    try {
      await controller.rename({ sessionId: id, title: args.title.trim() });
    } catch (error) {
      if (typeof env.log === 'function') env.log('改标题失败：' + String(error));
    }
  }
  let tail = '';
  if (typeof args.message === 'string' && args.message.trim() !== '') {
    if (aborted(signal)) return '已创建会话 `' + id + '`（未投递启动消息）。' + NL + ABORTED_TEXT;
    try {
      await controller.prompt(
        { requestId: randomUUID(), sessionId: id, mode: 'queue', content: [{ type: 'text', text: args.message }] },
        signal || new AbortController().signal,
      );
    } catch (e) {
      if (aborted(signal)) return '已创建会话 `' + id + '`。' + NL + ABORTED_TEXT;
      throw e;
    }
    tail = '（启动消息已投递）';
  }
  return '已创建会话 `' + id + '`' + tail + '。';
}

/**
 * 构造 `peer` 工具定义。
 *
 * 动作级权限在此再判一次，因为角色矩阵只决定工具是否可见。
 *
 * @param {object} env 插件环境，提供 `controller`、`roleOf` 与 `cfg`。
 * @returns {object} 工具定义，供宿主注册。
 * 副作用：`send` 消耗目标会话 token；`new` 创建会话。
 */
export function pmPeerTool(env) {
  return {
    name: PEER_NAME,
    description: '平级会话通信；投递前先唤醒目标会话，已归档的会话会被拦下，须先解归档。列举、历史、改名与新建仅全局。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ACTIONS, description: '动作，必填。例：`send`。' },
        session_id: { type: 'string', description: '目标会话 id，取自 `list` 输出。例：`session-3f2a9c`。' },
        sessions: { type: 'array', items: { type: 'string' }, description: '`collect`、`collab` 的目标会话 id 清单。例：`["session-a1","session-b2"]`。' },
        message: { type: 'string', description: '`send` 的消息正文，不得为空。' },
        mode: { type: 'string', enum: ['queue', 'steer'], description: '`send` 的投递方式：`queue` 排队，`steer` 立即插入。缺省 `queue`。' },
        wait: { type: 'boolean', description: '`send` 为 `true` 时投递后等待回复。缺省 `false`。' },
        collabMode: { type: 'string', enum: ['start', 'end'], description: '`collab` 的开关：`start` 注册协作，`end` 解除限制。' },
        timeout_ms: { type: 'number', description: '`send`、`wait`、`collect` 的等待上限，单位毫秒，最低 120000。' },
        since_ms: { type: 'number', description: '只读取该毫秒时间戳之后的回复。缺省取当前时间。' },
        limit: { type: 'number', description: '`list`、`peek` 的返回条数上限。缺省分别为 40 与 8。' },
        include_subagents: { type: 'boolean', description: '`list` 是否连子会话一并列出。缺省 `false`。' },
        title: { type: 'string', description: '`rename`、`new` 的显示标题，不得为空。例：`Demo 2`。' },
        workspace: { type: 'string', description: '`new` 的目标工作区，可传 id、标题或路径；与 `cwd` 互斥。' },
        cwd: { type: 'string', description: '`new` 的工作目录绝对路径；与 `workspace` 互斥。' },
      },
    },
    output: textOutput(),
    async execute(args, exec) {
      const action = String(args.action || '');
      if (ACTIONS.indexOf(action) === -1) throw new Error('现象：`action` 取值不在允许范围。原因：收到 `' + JSON.stringify(action) + '`，只接受 ' + ACTIONS.join('、') + '。处置：改用上述取值之一后重试。');
      const signal = signalOf(exec);
      const info = roleOf(env, exec);
      if (GLOBAL_ONLY.indexOf(action) !== -1) denyUnless(info.role === 'global', action, '该动作仅全局会话可用');
      if (action === 'list') return { text: await listText(env, args, signal) };
      if (action === 'status') return { text: await statusText(env, args, signal) };
      if (action === 'send') return { text: await sendText(env, args, exec, info, signal) };
      if (action === 'wait') return { text: await waitText(args, signal) };
      if (action === 'collect') return { text: await collectText(args, exec, signal) };
      if (action === 'collab') return { text: collabText(args, exec) };
      if (action === 'peek') return { text: await peekText(args) };
      if (action === 'rename') return { text: await renameText(env, args) };
      return { text: await newText(env, args, info, signal) };
    },
  };
}
