/**
 * 平级会话共享逻辑（原 peer-link 插件的本地只读部分，原样搬进来）。
 * 数据源与 peer-link 完全一致，不引入任何第三方依赖：
 *   ~/.dsh/storages/session_projcache/sessions/<session id>.json   水位 / 运行状态 / 项目名
 *   ~/.dsh/storages/workspace.json                                  工作区 id / 标题 / 路径
 *   ~/.dsh/sessions/<slug>/<session id>/session.v4.jsonl.zstd       会话日志（peer_peek 用）
 * 平级会话的判据：投影缓存里 **没有** record.rows.subagent.identity（子会话才有）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

/** 收到的消息必须能自报来源：宿主把投递消息记成 source.kind === "user"，不加标记就与用户消息无法区分。 */
const MARK_HEAD = '【peer-link ← ';

export function peerMarker(senderId) {
  return MARK_HEAD + (typeof senderId === 'string' && senderId !== '' ? senderId : 'unknown') + '】';
}

// ---------------------------------------------------------------- 本地只读状态

/** DSH 主目录候选（环境变量优先，回退 ~/.dsh）。 */
function dshRoots() {
  const roots = [];
  const env = process.env.DSH_HOME;
  if (typeof env === 'string' && env.trim() !== '') roots.push(env.trim());
  roots.push(path.join(os.homedir(), '.dsh'));
  return roots;
}

/** 在候选根下找第一个存在的目录；找不到返回 null（不抛）。 */
function findDir(relative) {
  for (const root of dshRoots()) {
    const p = path.join(root, relative);
    try {
      if (fs.statSync(p).isDirectory()) return p;
    } catch (error) {
      void error;
    }
  }
  return null;
}

/** 读 storages 下的一个文件；找不到返回 null（不抛）。 */
function findStateFile(relative) {
  for (const root of dshRoots()) {
    const p = path.join(root, relative);
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch (error) {
      void error;
    }
  }
  return null;
}

/** 安全地按路径取值；无法获取返回 undefined（与 peer-link 一致，区别于 lib/text.mjs 的 null）。 */
export function pick(node, ...rest) {
  let cur = node;
  for (const key of rest) {
    if (cur === null || typeof cur !== 'object' || !(key in cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

/**
 * 把「工作区 id / 标题 / 路径」解析成工作区 id。
 * 数据源：<DSH_HOME>/storages/workspace.json 的 tables.workspaces[<id>] = { path, title, sessionIds }。
 * 找不到返回 null（不抛）；读不到文件时原样返回入参，交给 session.create 去报 workspace/not-found。
 */
export function resolveWorkspaceId(key) {
  const raw = String(key).trim();
  if (raw === '') return null;
  const file = findStateFile(path.join('storages', 'workspace.json'));
  if (file === null) return raw;
  let table;
  try {
    table = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    void error;
    return raw;
  }
  const workspaces = pick(table, 'tables', 'workspaces');
  if (workspaces === undefined) return raw;
  if (workspaces[raw] !== undefined) return raw;
  const trimSlash = (v) => String(v).replace(/\/+$/, '');
  const want = trimSlash(raw);
  for (const id of Object.keys(workspaces)) {
    const ws = workspaces[id];
    if (ws === null || typeof ws !== 'object') continue;
    if (ws.title === raw) return id;
    if (ws.path !== undefined) {
      if (trimSlash(ws.path) === want) return id;
      // 注册表存的是真实路径，而入参可能是 /root/<项目名> 这类软链接 —— 两条都认
      try {
        if (trimSlash(fs.realpathSync(ws.path)) === trimSlash(fs.realpathSync(raw))) return id;
      } catch (error) {
        void error;
      }
    }
  }
  return null;
}

/** 读一个会话的投影缓存（水位 / 运行状态 / 项目名的来源）。读不到返回 null。 */
export function readProjCache(sessionId) {
  const dir = findDir('storages/session_projcache/sessions');
  if (dir === null) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, sessionId + '.json'), 'utf8'));
  } catch (error) {
    return null;
  }
}

/** 上下文水位（百分比）；读不到返回 null。 */
export function pressurePct(cache) {
  const used = pick(cache, 'record', 'rows', 'contextPressure', 'val', 'pressureTokens');
  const win = pick(cache, 'record', 'rows', 'contextPressure', 'val', 'contextWindow');
  if (!Number.isFinite(used) || !Number.isFinite(win) || win === 0) return null;
  return (used / win) * 100;
}

/** 子会话才有 record.rows.subagent.identity；没有就是平级会话。 */
export function isSubagent(cache) {
  return (
    pick(cache, 'record', 'rows', 'subagent', 'val', 'identity') !== undefined ||
    pick(cache, 'record', 'rows', 'subagent', 'identity') !== undefined
  );
}

/** 项目名：先看首条提示里的 Projects/<名>/ 或「<名>」项目，再退回标题。 */
export function projectName(cache) {
  const text = pick(cache, 'record', 'rows', 'titleInput', 'val', 'first', 'text');
  if (typeof text === 'string') {
    const a = text.match(/Projects\/([^\/\s]+)\//);
    if (a !== null) return a[1];
    const b = text.match(/「([^」]+)」项目/);
    if (b !== null) return b[1];
  }
  const title = pick(cache, 'record', 'rows', 'title', 'val');
  return typeof title === 'string' && title.trim() !== '' ? title.trim() : '-';
}

/** openStep 非空 = 正在跑一个步骤。 */
export function isBusy(cache) {
  if (cache === null) return null;
  const openStep = pick(cache, 'record', 'rows', 'sessionStats', 'val', 'openStep');
  return openStep !== null && openStep !== undefined;
}

/** 把时间戳格式化成 MM-DD HH:MM（本地时区）。 */
export function stamp(ms) {
  if (!Number.isFinite(ms)) return '--';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/** 一行式摘要（给 peer_list 用）。 */
export function rowLine(sessionId, cache, fallback) {
  const pct = cache === null ? null : pressurePct(cache);
  const state = isBusy(cache) === true ? 'running' : fallback === undefined ? 'idle' : fallback;
  const proj = cache === null ? '-' : projectName(cache);
  const kind = cache === null ? '' : isSubagent(cache) ? ' [子会话]' : ' [平级]';
  const water = pct === null ? '水位 ?' : '水位 ' + pct.toFixed(1) + '%';
  return sessionId + ' | ' + proj + ' | ' + water + ' | ' + state + kind;
}

/**
 * 会话清单：controller.list 的结果按 origin 过滤。
 * 冷会话在这一步就会被服务端从持久化里恢复成可寻址的行，所以 peer_list 本身不花 token。
 */
export async function sessionRows(controller, includeSubagents) {
  const value = await controller.list({}, new AbortController().signal);
  return value.items.filter((row) => includeSubagents === true || row.origin !== 'subagent');
}

// ---------------------------------------------------------------- 会话日志（peer_peek）

/** 解 zstd **多帧**日志并按行解析成事件数组；本 Node 构建没有 zstd 时返回 null。 */
export function decodeSessionLog(file) {
  if (typeof zlib.zstdDecompressSync !== 'function') return null;
  const buf = fs.readFileSync(file);
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const starts = [];
  let idx = 0;
  for (;;) {
    const at = buf.indexOf(magic, idx);
    if (at < 0) break;
    starts.push(at);
    idx = at + 4;
  }
  const parts = [];
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1] : buf.length;
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(starts[i], end)).toString('utf8'));
    } catch (error) {
      void error;
    }
  }
  return parts
    .join('')
    .split(String.fromCharCode(10))
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        return null;
      }
    })
    .filter((x) => x !== null);
}

/** 在 <DSH_HOME>/sessions/<任意 slug>/<session id>/ 下找日志文件（不猜 slug）。 */
export function findSessionLog(sessionId) {
  const root = findDir('sessions');
  if (root === null) return null;
  let buckets = [];
  try {
    buckets = fs.readdirSync(root);
  } catch (error) {
    return null;
  }
  for (const bucket of buckets) {
    const file = path.join(root, bucket, sessionId, 'session.v4.jsonl.zstd');
    try {
      if (fs.statSync(file).isFile()) return file;
    } catch (error) {
      void error;
    }
  }
  return null;
}

/** 从事件流里抽出「人/会话说得出口的话」，跳过运行时上下文与技能目录注入。 */
export function conversation(events, limit) {
  const skip = { 'runtime-context': true, 'skill-catalog': true };
  const items = [];
  for (const e of events) {
    if (e.type === 'user/message') {
      const kind = pick(e, 'data', 'source', 'kind');
      if (typeof kind === 'string' && skip[kind] === true) continue;
      const blocks = pick(e, 'data', 'content');
      const text = Array.isArray(blocks) ? blocks.map((c) => (c && c.text) || '').join(' ') : '';
      if (text.trim() !== '') items.push({ t: e.time, who: typeof kind === 'string' ? kind : 'user', text });
    } else if (e.type === 'assistant/message') {
      const blocks = pick(e, 'data', 'message', 'content');
      const text = Array.isArray(blocks)
        ? blocks.filter((b) => b && b.type === 'text').map((b) => b.text || '').join(' ')
        : '';
      if (text.trim() !== '') items.push({ t: e.time, who: 'assistant', text });
    }
  }
  return items.slice(-limit);
}
