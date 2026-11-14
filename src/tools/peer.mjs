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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { textOutput } from '../lib/output.mjs';
import { PEER_NAME } from '../lib/names.mjs';
import { NL } from '../lib/text.mjs';
import {
  readProjCache, rowLine, sessionRows, stamp, pressurePct, isSubagent, isBusy,
  projectName, pick, peerMarker, resolveWorkspaceId, findSessionLog, decodeSessionLog, conversation,
} from '../lib/peer.mjs';

export const ACTIONS = ['list', 'status', 'send', 'wait', 'collect', 'peek', 'rename', 'new'];
const GLOBAL_ONLY = ['list', 'peek', 'rename'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const COLLECT_POLL_MS = 30000;
const WAIT_MIN_MS = 120000;

/** 协作游标：交办者 → 目标 → { since }。只存时间戳，不存消息正文。 */
function collectFile() {
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  return path.join(home, '.dsh', 'storages', 'dsh-handover.collect.json');
}
function loadCollect() {
  try {
    const data = JSON.parse(fs.readFileSync(collectFile(), 'utf8'));
    if (data && typeof data === 'object' && data.cursors) return data;
  } catch (error) { void error; }
  return { version: 1, cursors: {} };
}
function saveCollect(data) {
  const file = collectFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
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

/** 助手文本：读目标日志里 since 之后的助手回复，不定长截断。 */
function assistantReplies(file, sinceMs) {
  const events = decodeSessionLog(file);
  if (events === null) return null;
  const items = conversation(events, 500).filter((it) => it.who === 'assistant' && Number(it.t) > sinceMs);
  return items.map((it) => it.text);
}

/** 单个目标的完成判定：这一轮已结束，且 since 之后有助手文本。 */
function inspectTarget(sid, since) {
  const file = findSessionLog(sid);
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
async function waitText(args) {
  const sid = String(args.session_id || '').trim();
  if (!sid) throw new Error('peer(action="wait")：session_id 不能为空');
  const timeout = Math.max(WAIT_MIN_MS, Math.min(3600000, Number(args.timeout_ms) || WAIT_MIN_MS));
  const since = Number(args.since_ms) || Date.now();
  const deadline = Date.now() + timeout;
  let lastError = '';
  for (;;) {
    const one = inspectTarget(sid, since);
    if (one.state === 'done') return '回复 ' + sid + '：' + NL + one.text;
    if (one.state === 'missing') throw new Error('peer(action="wait")：找不到目标会话日志：' + sid);
    if (one.state === 'nozstd') throw new Error('peer(action="wait")：本 Node 构建没有 zstd 支持，读不了会话日志');
    lastError = one.state;
    if (Date.now() >= deadline) break;
    await sleep(2000);
  }
  return '等待超时（' + String(Math.round(timeout / 1000)) + ' 秒）：' + sid + ' 状态 ' + lastError
    + '。可再用 peer(action="status") 看状态，稍后重试 wait。';
}

/**
 * 多会话收集：列一串会话，谁先完成先返回；同时完成多个就一起返回。
 * 一次调用最多等 timeout_ms（最低 120 秒，由助手按任务预估设置）；到点一个都没完成则返回仍在运行的名单。
 */
async function collectText(args, exec) {
  const caller = callerOf(exec);
  const state = loadCollect();
  const list = Array.isArray(args.sessions)
    ? args.sessions.map((x) => String(x || '').trim()).filter(Boolean)
    : [];
  const targets = list.length ? list : Object.keys(state.cursors[caller] || {});
  if (!targets.length) throw new Error('peer(action="collect")：sessions 为空，且没有已交办的目标');
  const timeout = Math.max(WAIT_MIN_MS, Math.min(3600000, Number(args.timeout_ms) || WAIT_MIN_MS));
  const deadline = Date.now() + timeout;
  const explicitSince = Number(args.since_ms) || null;
  const since = {};
  for (const sid of targets) since[sid] = sinceOf(state, caller, sid) ?? explicitSince ?? Date.now();
  const done = [];
  const running = new Map(targets.map((sid) => [sid, 'running']));
  for (;;) {
    for (const sid of targets) {
      if (done.some((d) => d.sid === sid)) continue;
      const one = inspectTarget(sid, since[sid]);
      running.set(sid, one.state);
      if (one.state === 'done') done.push(one);
    }
    if (done.length) {
      for (const one of done) setSince(state, caller, one.sid, one.at);
      saveCollect(state);
      const out = ['已完成 ' + String(done.length) + ' 个：'];
      for (const one of done) out.push('[' + one.sid + ']' + NL + one.text);
      return out.join(NL);
    }
    if (Date.now() >= deadline) break;
    await sleep(COLLECT_POLL_MS);
  }
  const lines = ['本轮没有完成的会话（等待 ' + String(Math.round(timeout / 1000)) + ' 秒）：'];
  for (const sid of targets) lines.push('  ' + sid + '  ' + (running.get(sid) || 'running'));
  lines.push('稍后重试 collect 即可；已完成的会立即返回。');
  return lines.join(NL);
}

function roleOf(env, exec) {
  try { return env.roleOf(exec) || { role: 'plain' }; } catch { return { role: 'plain' }; }
}

function denyUnless(ok, action, why) {
  if (!ok) throw new Error('peer(action="' + action + '")：' + why);
}

async function listText(env, args) {
  const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(200, Math.trunc(args.limit))) : 40;
  const controller = env.controller();
  if (!controller || typeof controller.list !== 'function') {
    throw new Error('peer(action="list")：sessionController 不可用（插件未注入该服务）');
  }
  const rows = await sessionRows(controller, args.include_subagents === true);
  if (rows.length === 0) return 'no sessions';
  return rows.slice(0, limit).map((row) => {
    const cache = readProjCache(row.sessionId);
    const state = row.running ? 'running' : row.agentAvailable ? 'idle' : 'cold';
    return rowLine(row.sessionId, cache, state) + ' | ' + stamp(row.updatedAt);
  }).join(NL);
}

async function statusText(env, args) {
  const controller = env.controller();
  if (!controller || typeof controller.list !== 'function') {
    throw new Error('peer(action="status")：sessionController 不可用（插件未注入该服务）');
  }
  const sid = String(args.session_id || '').trim();
  if (!sid) throw new Error('peer(action="status")：session_id 不能为空');
  const cache = readProjCache(sid);
  const rows = await sessionRows(controller, true);
  const row = rows.find((r) => r.sessionId === sid) ?? null;
  if (cache === null && row === null) return 'unknown session: ' + sid;
  const stats = pick(cache, 'record', 'rows', 'sessionStats', 'val') ?? {};
  const pct = cache === null ? null : pressurePct(cache);
  return [
    'session  ' + sid,
    'kind     ' + (cache === null ? '?' : isSubagent(cache) ? '子会话（subagent）' : '平级会话（peer）'),
    'project  ' + (cache === null ? '-' : projectName(cache)),
    'pressure ' + (pct === null ? '?' : pct.toFixed(1) + '%') + (pct !== null && pct >= 32 ? '  已进入预警区' : ''),
    'state    ' + (isBusy(cache) === true ? 'running' : row === null ? 'cold' : row.agentAvailable ? 'idle' : 'cold'),
    'turns    ' + String(stats.turns ?? '?') + '   steps ' + String(stats.steps ?? '?'),
    'cwd      ' + String(row?.cwd ?? pick(cache, 'record', 'identity', 'cwd') ?? '-'),
    'preset   ' + String(pick(cache, 'record', 'rows', 'agentPreset', 'val') ?? '-'),
    'updated  ' + stamp(row?.updatedAt ?? pick(cache, 'record', 'identity', 'createdAt')),
  ].join(NL);
}

async function sendText(env, args, exec, info) {
  const controller = env.controller();
  if (!controller || typeof controller.prompt !== 'function') {
    throw new Error('peer(action="send")：sessionController.prompt 不可用（插件未注入该服务）');
  }
  const target = String(args.session_id || '').trim();
  if (!target) throw new Error('peer(action="send")：session_id 不能为空');
  const message = typeof args.message === 'string' ? args.message : '';
  if (message.trim() === '') throw new Error('peer(action="send")：message 不能为空');
  const mode = args.mode === 'steer' ? 'steer' : 'queue';
  // 来源标记：dsh 把宿主投递的消息记成 source.kind === "user"，不加标记的话，
  // 平级会话的消息在日志和界面上与用户消息完全无法区分。
  const sender = exec?.agent?.session?.header?.id ?? 'unknown';
  const marker = peerMarker(sender);
  const body = message.startsWith(marker) ? message : marker + NL + message;
  const since = Date.now();
  const receipt = await controller.prompt(
    { requestId: randomUUID(), sessionId: target, mode, content: [{ type: 'text', text: body }] },
    new AbortController().signal,
  );
  try {
    const state = loadCollect();
    setSince(state, sender, target, since);
    saveCollect(state);
  } catch (error) { void error; }
  const head = 'accepted=' + String(receipt.accepted) + ' mode=' + mode + ' target=' + target + ' from=' + sender;
  if (args.wait === true) {
    return head + NL + await waitText({ session_id: target, since_ms: since, timeout_ms: args.timeout_ms });
  }
  return head;
}

async function peekText(args) {
  const sid = String(args.session_id || '').trim();
  if (!sid) throw new Error('peer(action="peek")：session_id 不能为空');
  const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(40, Math.trunc(args.limit))) : 8;
  const file = findSessionLog(sid);
  if (file === null) return 'no session log found for ' + sid;
  const events = decodeSessionLog(file);
  if (events === null) return 'this Node build has no zstd support; cannot read the session log';
  const items = conversation(events, limit);
  const head = 'session ' + sid + '  |  最近 ' + String(items.length) + ' 条  |  ' + file;
  if (items.length === 0) return head + NL + '(没有可读的会话历史)';
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
    throw new Error('peer(action="rename")：sessionController.rename 不可用（插件未注入该服务）');
  }
  const sid = String(args.session_id || '').trim();
  if (!sid) throw new Error('peer(action="rename")：session_id 不能为空');
  const title = String(args.title ?? '').trim();
  if (title === '') throw new Error('peer(action="rename")：title 不能为空');
  await controller.rename({ sessionId: sid, title });
  return 'renamed ' + sid + ' -> ' + title;
}

async function newText(env, args, info) {
  const controller = env.controller();
  if (!controller || typeof controller.create !== 'function') {
    throw new Error('peer(action="new")：sessionController.create 不可用（插件未注入该服务）');
  }
  // 会话创建仅属全局；杂项可以把会话建在 Misc 下（落到本任务体系内）。
  const wantsWorkspace = typeof args.workspace === 'string' && args.workspace.trim() !== '';
  if (wantsWorkspace && args.cwd !== undefined) {
    throw new Error('peer(action="new")：传 workspace 时不要再传 cwd —— session.create 只接受其中之一（cwd 会自动取该工作区的 path）');
  }
  const targetText = String(args.workspace || args.cwd || '').toLowerCase();
  const allowed = info.role === 'global' || (info.role === 'misc' && targetText.indexOf('misc') !== -1);
  denyUnless(allowed, 'new', '会话创建仅属全局（杂项可建到 Misc 下）');
  let request = {};
  if (wantsWorkspace) {
    const workspaceId = resolveWorkspaceId(args.workspace);
    if (workspaceId === null || workspaceId === undefined) {
      throw new Error('peer(action="new")：找不到工作区「' + args.workspace + '」（可用 id / 标题 / 路径；数据源 storages/workspace.json）');
    }
    request = { workspaceId };
  } else if (args.cwd !== undefined) {
    request = { cwd: args.cwd };
  }
  const created = await controller.create(request);
  const id = created.sessionId;
  if (typeof args.title === 'string' && args.title.trim() !== '') {
    try {
      await controller.rename({ sessionId: id, title: args.title.trim() });
    } catch (error) {
      if (typeof env.log === 'function') env.log('peer(action="new")：改标题失败：' + String(error));
    }
  }
  let tail = '';
  if (typeof args.message === 'string' && args.message.trim() !== '') {
    await controller.prompt(
      { requestId: randomUUID(), sessionId: id, mode: 'queue', content: [{ type: 'text', text: args.message }] },
      new AbortController().signal,
    );
    tail = ' (opening message delivered)';
  }
  return 'created ' + id + tail;
}

export function pmPeerTool(env) {
  return {
    name: PEER_NAME,
    description:
      '平级会话：action=list 一览、status 详情、send 投消息（wait=true 时同一轮等回复）、wait 等单个回复、collect 收集多个会话中先完成的最终回复、peek 读历史、rename 改标题、new 新建。list、peek、rename 与 new 仅全局会话可用。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ACTIONS, description: '要做的动作' },
        session_id: { type: 'string', description: 'status、send、wait、peek、rename：目标会话 id' },
        sessions: { type: 'array', items: { type: 'string' }, description: 'collect：要等的会话 id 列表；留空则取已交办的目标' },
        message: { type: 'string', description: 'send：要投递的正文' },
        mode: { type: 'string', enum: ['queue', 'steer'], description: 'send：queue（默认）或 steer' },
        wait: { type: 'boolean', description: 'send：发完在同一轮等回复（一对一对话用）' },
        timeout_ms: { type: 'number', description: 'wait、collect：一次等待上限（毫秒，最低 120000，按任务预估设置）' },
        since_ms: { type: 'number', description: 'wait、collect：从哪个时刻之后找回复（默认取交办时刻）' },
        limit: { type: 'number', description: 'list：最多多少行（默认 40）；peek：最近多少条（默认 8，上限 40）' },
        include_subagents: { type: 'boolean', description: 'list：同时列出子会话' },
        title: { type: 'string', description: 'new、rename：显示标题' },
        workspace: { type: 'string', description: 'new：工作区 id、标题或路径（与 cwd 互斥）' },
        cwd: { type: 'string', description: 'new：新会话的工作目录' },
      },
    },
    output: textOutput(),
    async execute(args, exec) {
      const action = String(args.action || '');
      if (ACTIONS.indexOf(action) === -1) throw new Error('peer：action 只能是 ' + ACTIONS.join(' | ') + '（收到 ' + JSON.stringify(action) + '）');
      const info = roleOf(env, exec);
      if (GLOBAL_ONLY.indexOf(action) !== -1) denyUnless(info.role === 'global', action, '该动作仅全局会话可用');
      if (action === 'list') return { text: await listText(env, args) };
      if (action === 'status') return { text: await statusText(env, args) };
      if (action === 'send') return { text: await sendText(env, args, exec, info) };
      if (action === 'wait') return { text: await waitText(args) };
      if (action === 'collect') return { text: await collectText(args, exec) };
      if (action === 'peek') return { text: await peekText(args) };
      if (action === 'rename') return { text: await renameText(env, args) };
      return { text: await newText(env, args, info) };
    },
  };
}
