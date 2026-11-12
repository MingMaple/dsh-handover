/**
 * peer —— 平级会话：一个入口，按 action 分流。
 *   list 会话一览（只读缓存，不激活任何会话）
 *   status 单会话详情
 *   send 投一条消息（唯一会消耗对方 token 的动作）
 *   peek 读取目标会话近期对话（内容进本会话上下文）
 *   rename 只改显示标题
 *   new 新建平级会话
 * 原 peer_list、peer_status、peer_send、peer_peek、peer_rename、peer_new 合并于此。
 * 动作级权限在这里再判一次：角色矩阵只决定「这个工具可不可见」，不细分动作。
 */
import { randomUUID } from 'node:crypto';
import { textOutput } from '../lib/output.mjs';
import { PEER_NAME } from '../lib/names.mjs';
import { NL } from '../lib/text.mjs';
import {
  readProjCache, rowLine, sessionRows, stamp, pressurePct, isSubagent, isBusy,
  projectName, pick, peerMarker, resolveWorkspaceId, findSessionLog, decodeSessionLog, conversation,
} from '../lib/peer.mjs';

export const ACTIONS = ['list', 'status', 'send', 'peek', 'rename', 'new'];
const GLOBAL_ONLY = ['list', 'peek', 'rename'];

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
  const receipt = await controller.prompt(
    { requestId: randomUUID(), sessionId: target, mode, content: [{ type: 'text', text: body }] },
    new AbortController().signal,
  );
  return 'accepted=' + String(receipt.accepted) + ' mode=' + mode + ' target=' + target + ' from=' + sender;
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
  if (items.length === 0) return head + NL + '(没有可读的对话内容)';
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
      '平级会话：action=list 一览、status 详情、send 投消息（耗对方 token）、peek 读近期对话（耗本会话 token）、rename 改标题、new 新建。list、peek、rename 与 new 仅全局会话可用。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ACTIONS, description: '要做的动作' },
        session_id: { type: 'string', description: 'status、send、peek、rename：目标会话 id' },
        message: { type: 'string', description: 'send：要投递的正文' },
        mode: { type: 'string', enum: ['queue', 'steer'], description: 'send：queue（默认）或 steer' },
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
      if (action === 'peek') return { text: await peekText(args) };
      if (action === 'rename') return { text: await renameText(env, args) };
      return { text: await newText(env, args, info) };
    },
  };
}
