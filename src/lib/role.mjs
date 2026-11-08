/**
 * 会话角色：判定、逐角色交接路径、工具集与文案。角色表是本机状态（不进仓库、不进迁移包）。
 * 判定顺序：角色表 → 全局标题 → 全局工作区 → 子会话（默认普通）→ cwd（Projects/<名> 或 _Misc/tasks/<任务>）→ 首条提示 → 普通。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJsonDir, pick, isSafeName, assertSafeName } from './text.mjs';
import { projCacheDir, isSubagent } from './sessions.mjs';
import { globalWorkspaceSessionIds } from './registry.mjs';
import { TOOL_NAMES, PEER_NAMES, nameOf, peerNameOf } from './names.mjs';
import { stampTz } from './brief.mjs';

export const ROLES = ['global', 'project', 'misc', 'plain'];
export const ROLE_LABEL = { global: '全局', project: '项目', misc: '杂项', plain: '普通' };

export const ALL_TOOL_NAMES = TOOL_NAMES.concat(PEER_NAMES);

/** 角色 → 可见工具（其余一律 deny）。改这张表就是改成本结构。 */
const ROLE_TOOLS = {
  global: ALL_TOOL_NAMES.slice(),
  project: [nameOf('phase'), nameOf('handover'), nameOf('checkpoint'), nameOf('charter'), nameOf('gate'), nameOf('snapshot'), nameOf('profile'), peerNameOf('send'), peerNameOf('status')],
  misc: [nameOf('phase'), nameOf('handover'), nameOf('checkpoint'), nameOf('charter'), nameOf('snapshot'), nameOf('profile'), peerNameOf('send'), peerNameOf('status'), peerNameOf('new')],
  plain: [],
};

export function toolsetFor(role) {
  const allow = ROLE_TOOLS[role] || ROLE_TOOLS.plain;
  const deny = ALL_TOOL_NAMES.filter((n) => allow.indexOf(n) === -1);
  return { allow: allow.slice(), deny };
}

// ---------------------------------------------------------------- 角色表（本机状态）

export function rolesPath(cfg) {
  try {
    if (cfg && cfg.rolesPath) return String(cfg.rolesPath);
  } catch { /* ignore */ }
  return path.join(os.homedir(), '.dsh', 'storages', 'dsh-handover.roles.json');
}

export function readRoles(cfg) {
  try {
    const j = JSON.parse(fs.readFileSync(rolesPath(cfg), 'utf8'));
    const sessions = j && typeof j.sessions === 'object' && j.sessions ? j.sessions : {};
    return { version: 1, sessions };
  } catch {
    return { version: 1, sessions: {} };
  }
}

function writeRolesFile(cfg, data) {
  const file = rolesPath(cfg);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + String.fromCharCode(10), 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

/** 写入/更新一条角色；返回写入后的条目。 */
export function writeRole(cfg, sessionId, patch) {
  const sid = String(sessionId || '');
  if (!sid) throw new Error('缺会话 id');
  const data = readRoles(cfg);
  const prev = data.sessions[sid] || {};
  const next = Object.assign({}, prev, patch || {});
  // 名字要落成目录：不合法就当场拒绝，别等拼路径时才 ENOENT。
  if (next.role === 'project') assertProjectName(next.project);
  if (next.role === 'misc') assertTaskName(next.task);
  next.setAt = stampTz(Date.now());
  data.sessions[sid] = next;
  writeRolesFile(cfg, data);
  return next;
}


// ---------------------------------------------------------------- 判定

/** 从投影缓存读会话的 cwd 与首条提示（读不到返回空串）。 */
export function sessionMeta(sessionId) {
  const sid = String(sessionId || '');
  if (!sid) return { cwd: '', firstPrompt: '', subagent: false };
  for (const f of readJsonDir(projCacheDir())) {
    if (f.name.replace('.json', '') !== sid) continue;
    return {
      cwd: String(pick(f.data, 'record', 'identity', 'cwd') || ''),
      firstPrompt: String(pick(f.data, 'record', 'rows', 'titleInput', 'val', 'first', 'text') || ''),
      subagent: isSubagent(f.data),
    };
  }
  return { cwd: '', firstPrompt: '', subagent: false };
}

function parts(p) {
  return String(p || '').replace(/\\/g, '/').split('/').filter(Boolean);
}

/** 项目名当目录名用，长度与字符集都比任务名紧一些；任务名放宽到 40 字符。 */
export const PROJECT_NAME_MAX = 24;
export const TASK_NAME_MAX = 40;

export function projectNameOk(name) {
  return isSafeName(name, PROJECT_NAME_MAX);
}

export function taskNameOk(name) {
  return isSafeName(name, TASK_NAME_MAX);
}

export function assertProjectName(name) {
  return assertSafeName(name, '项目名', PROJECT_NAME_MAX);
}

export function assertTaskName(name) {
  return assertSafeName(name, '任务名', TASK_NAME_MAX);
}

/** cwd 落在 Projects/<名>/ 或 _Misc/tasks/<任务>/ 里就据此判定；名字不合法一律不认。 */
function roleFromPath(cwd) {
  const seg = parts(cwd);
  for (let i = 0; i < seg.length; i++) {
    if (seg[i] === 'Projects' && projectNameOk(seg[i + 1]) && seg[i + 1] !== '_Project_Meta') {
      return { role: 'project', project: seg[i + 1], task: '' };
    }
    if (seg[i] === '_Misc' && seg[i + 1] === 'tasks' && taskNameOk(seg[i + 2])) {
      return { role: 'misc', project: '', task: seg[i + 2] };
    }
    if (seg[i] === '_Project_Meta' && projectNameOk(seg[i + 1])) {
      return { role: 'project', project: seg[i + 1], task: '' };
    }
  }
  return null;
}

/** 首条提示里能解析出 Projects/<名>/ 或「<名>」项目 就算项目会话；名字不合法不认。 */
function roleFromPrompt(text) {
  const t = String(text || '').replace(/\\/g, '/');   // Windows 路径也能解析
  const i = t.indexOf('Projects/');
  if (i !== -1) {
    const rest = t.slice(i + 'Projects/'.length);
    let name = '';
    for (const ch of rest) {
      if (ch === '/' || ch === ' ' || ch === String.fromCharCode(9) || ch === String.fromCharCode(10) || ch === String.fromCharCode(13)) break;
      name += ch;
    }
    // 首条提示常把规则写成 `_Control_Center/**、Projects/**` 这样的通配，解析结果必须过名称校验。
    if (projectNameOk(name)) return { role: 'project', project: name, task: '' };
  }
  const q = t.indexOf(String.fromCharCode(12300));
  if (q !== -1) {
    const rest = t.slice(q + 1);
    const j = rest.indexOf(String.fromCharCode(12301) + '项目');
    if (j > 0) {
      const name = rest.slice(0, j);
      if (projectNameOk(name)) return { role: 'project', project: name, task: '' };
    }
  }
  return null;
}

/**
 * 判定一个会话的角色。
 * @param {{ cfg?: object, sessionId?: string, title?: string, cwd?: string, firstPrompt?: string, roles?: object }} opts
 */
export function resolveRole(opts) {
  const o = opts || {};
  const sid = String(o.sessionId || '');
  const store = o.roles || readRoles(o.cfg);
  const hit = sid ? store.sessions[sid] : null;
  if (hit) {
    const role = String(hit.role || '');
    if (ROLES.indexOf(role) !== -1) {
      // 角色表里的名字要当目录名用。历史写入或手工编辑留下的非法名字一律不认，继续往下推断，
      // 否则会把整条「写交接 → 备份 → 归档」链路卡在 Windows 的非法路径上。
      const named = role === 'project' ? projectNameOk(hit.project)
        : role === 'misc' ? taskNameOk(hit.task) : true;
      if (named) {
        return { role, project: String(hit.project || ''), task: String(hit.task || ''), source: 'store', sessionId: sid };
      }
    }
    // 旧角色表的 unknown 是兜底态，按新口径并入普通。
    if (role === 'unknown') {
      return { role: 'plain', project: String(hit.project || ''), task: String(hit.task || ''), source: 'store', sessionId: sid };
    }
  }
  const title = String(o.title || '');
  if (title.indexOf('全局') !== -1) return { role: 'global', project: '', task: '', source: 'title', sessionId: sid };
  try {
    if (sid && globalWorkspaceSessionIds().indexOf(sid) !== -1) {
      return { role: 'global', project: '', task: '', source: 'workspace', sessionId: sid };
    }
  } catch { /* 读不到工作区表就继续往下判 */ }
  // 子会话默认按普通处理，不再按 cwd 注入项目段；项目中显式指定角色的子会话仍以角色表为准。
  if (o.subagent === true) return { role: 'plain', project: '', task: '', source: 'subagent', sessionId: sid };
  const byPath = roleFromPath(o.cwd);
  if (byPath) return Object.assign(byPath, { source: 'cwd', sessionId: sid });
  const byPrompt = roleFromPrompt(o.firstPrompt);
  if (byPrompt) return Object.assign(byPrompt, { source: 'prompt', sessionId: sid });
  return { role: 'plain', project: '', task: '', source: 'none', sessionId: sid };
}

// ---------------------------------------------------------------- 路径

/**
 * 逐角色交接路径。
 * @returns {{ path: string|null, kind: string|null, scope: string, role: string, reason?: string }}
 */
export function handoverPathFor(ws, info) {
  const role = info && info.role ? info.role : 'plain';
  if (!ws) return { path: null, kind: null, scope: '', role, reason: '没有工作区根' };
  if (role === 'global') {
    return { path: path.join(ws, '_Control_Center', 'records', 'Global_Handover.md'), kind: 'global', scope: '_Global', role };
  }
  if (role === 'project') {
    const project = String(info.project || '');
    if (!project) return { path: null, kind: null, scope: '', role, reason: '项目名缺失' };
    if (!projectNameOk(project)) return { path: null, kind: null, scope: '', role, reason: '项目名不合法（当目录名用）：' + JSON.stringify(project) };
    return { path: path.join(ws, '_Project_Meta', project, 'Handover.md'), kind: 'project', scope: project, role, project };
  }
  if (role === 'misc') {
    const task = String(info.task || '');
    if (!task) return { path: null, kind: null, scope: '', role, reason: '任务名缺失' };
    if (!taskNameOk(task)) return { path: null, kind: null, scope: '', role, reason: '任务名不合法（当目录名用）：' + JSON.stringify(task) };
    return { path: path.join(ws, '_Misc', 'tasks', task, 'Handover.md'), kind: 'misc', scope: path.join('_Misc', task), role, task };
  }
  if (role === 'plain') return { path: null, kind: null, scope: '', role, reason: '普通会话不参与交接' };
  return { path: null, kind: null, scope: '', role, reason: '本会话未设定角色' };
}

export function snapshotDirFor(ws, info) {
  const t = handoverPathFor(ws, info);
  return path.join(ws, '_Temp', t.scope || '_Global', 'Snapshots');
}

export function archiveDirFor(ws, info) {
  // 规范 §4.1：杂项归档自包含在任务目录里（`_Misc/tasks/<任务>/_archive/`），不进全局归档；
  // 全局与项目归档在 `_Archives/<范围>/Handover/`。
  if (info && info.role === 'misc' && taskNameOk(info.task)) {
    return path.join(ws, '_Misc', 'tasks', String(info.task), '_archive');
  }
  const t = handoverPathFor(ws, info);
  return path.join(ws, '_Archives', t.scope || '_Global', 'Handover');
}

export function scopeLabel(info) {
  const role = info && info.role ? info.role : 'plain';
  if (role === 'project') return '项目「' + (info.project || '?') + '」';
  if (role === 'misc') return '杂项任务「' + (info.task || '?') + '」';
  return ROLE_LABEL[role] || role;
}