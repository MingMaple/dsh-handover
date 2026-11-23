/**
 * 角色落位：角色生效后把会话放进对应工作区，缺工作区时按约定建目录并注册。
 *
 * 约定（与既有工作区一致）：
 *   global → 工作区根，标题「全局」
 *   misc   → <根>/_Misc，标题「_Misc」
 *   project→ <根>/Projects/<项目>/<项目>库，标题「<项目>库」
 *
 * 只在确实不存在时创建；已注册则直接复用。创建与挂载都走宿主 workspaceRegistry，
 * 不手写 workspace.json。注册表是可选能力：宿主版本不同，某些路径只提供 list 而没有
 * create；这时退回「不落位/保持原处」并如实回报，不中断换任与角色生效。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathKey } from './pathkey.mjs';

/** 由角色推出目标工作区路径与标题；普通角色返回 null。 */
export function workspaceTargetFor(wsRoot, info) {
  const root = String(wsRoot || '');
  if (!root) return null;
  const role = info && info.role;
  if (role === 'global') return { path: root, title: '全局' };
  if (role === 'misc') return { path: path.join(root, '_Misc'), title: '_Misc' };
  if (role === 'project') {
    const name = String((info && info.project) || '').trim();
    if (!name) return null;
    return { path: path.join(root, 'Projects', name, name + '库'), title: name + '库' };
  }
  return null;
}

/**
 * 路径比较键：统一斜杠、去掉末尾分隔符；大小写只在 win32/darwin 折叠。
 * 与 pathkey.mjs 的口径一致——Linux 区分大小写，不能无条件 toLowerCase。
 */
function normPath(p) {
  return pathKey(p);
}

/** 在工作区列表里按路径找已有条目。 */
export function findWorkspaceRow(rows, targetPath) {
  const want = normPath(targetPath);
  for (const r of Array.isArray(rows) ? rows : []) {
    if (normPath(r.path) === want) return r;
  }
  return null;
}

/** 已注册工作区清单（服务优先，读不到就当空表）。 */
export function workspaceRows(reg) {
  try {
    const list = reg && typeof reg.list === 'function' ? (reg.list() || []) : [];
    return list.map((w) => ({ id: String((w && w.id) || ''), title: String((w && w.title) || ''), path: String((w && w.path) || '') }));
  } catch { return []; }
}

/** 注册表是否具备新建工作区的能力：不同宿主版本的注册服务可能只提供 list。 */
function canCreateWorkspace(reg) {
  return !!reg && typeof reg.create === 'function';
}

/** 取宿主注册表；取不到或服务本身抛错时一律当「不可用」处理。 */
function registryOf(env) {
  try {
    return env && typeof env.registry === 'function' ? env.registry() : null;
  } catch {
    return null;
  }
}

function errText(e) {
  return String(e && e.message ? e.message : e);
}

/**
 * 取角色对应的工作区 id，缺工作区时按约定创建并注册。
 * 换任建会话前调用，保证接任者一开始就落在正确的工作区里。
 * 注册表缺 create 或新建失败时不抛错；返回 null 让调用方按已注册工作区兜底。
 * @returns {Promise<string|null>} 工作区 id；普通角色、取不到注册表或无法新建时返回 null
 */
export async function ensureWorkspaceId(env, info, wsRoot) {
  const target = workspaceTargetFor(wsRoot, info);
  if (!target) return null;
  const reg = registryOf(env);
  if (!reg) return null;
  const row = findWorkspaceRow(workspaceRows(reg), target.path);
  if (row) return String(row.id);
  // 可选能力缺失不算失败：没有 create 就不建目录，退回「不落位」。
  if (!canCreateWorkspace(reg)) return null;
  try {
    fs.mkdirSync(target.path, { recursive: true });
    const made = await reg.create(target.path, target.title);
    const id = String((made && (made.id || (made.header && made.header.id))) || '');
    return id || null;
  } catch {
    // 新建失败同样只按「不落位」处理，已写入的角色与换任流程不受影响。
    return null;
  }
}

/**
 * 落位结果拼成一句回报。
 * 成功说移进了哪个工作区；目录不符时说清「留在原处」，并点明换任时接任者会建在角色目录。
 * @param {object|null} target workspaceTargetFor 的结果（取标题用）
 * @param {object|null} placed placeSession 的结果
 * @param {string} placeError 失败原因
 * @returns {string} 空串表示既没成功也没有可报的失败
 */
export function placeNotice(target, placed, placeError) {
  const title = String((placed && placed.title) || (target && target.title) || '');
  if (placed) return '工作区：已移入「' + title + '」' + (placed.created ? '（本次新建）' : '') + '。';
  const err = String(placeError || '');
  if (!err) return '';
  if (err.indexOf('不允许改会话工作目录') !== -1) {
    return '工作区：本会话留在原目录（DSH 不允许改会话工作目录）；换任时接任者会直接建在「' + title + '」里。';
  }
  return '工作区：未能移入，原因：' + err;
}

/**
 * 把会话挂到角色对应的工作区。
 * 注册表是可选能力：缺 create 时不建工作区，抛「未落位」原因由调用方回报，
 * 不推翻已写入的角色；只有确实能 create 时才建目录并挂载。
 * @param {object} env 插件运行时（取 registry）
 * @param {string} sid 会话 id
 * @param {object} info 角色信息（role/project/task）
 * @param {string} wsRoot 工作区根
 * @returns {Promise<{attached:boolean, created:boolean, title:string, path:string, id:string}|null>} 普通角色返回 null
 * @throws {Error} 工作区建不出来或挂不上时抛出，由调用方决定是否阻断
 */
export async function placeSession(env, sid, info, wsRoot) {
  const target = workspaceTargetFor(wsRoot, info);
  if (!target) return null;
  const reg = registryOf(env);
  if (!reg) throw new Error('workspaceRegistry 不可用，无法把会话移入工作区');
  let row = findWorkspaceRow(workspaceRows(reg), target.path);
  let created = false;
  if (!row) {
    // 只有注册表确实能 create 时才建目录并注册；缺能力时如实回报「未落位」，不阻断主流程。
    if (!canCreateWorkspace(reg)) {
      throw new Error('工作区注册表不支持新建工作区（缺少 create），会话留在原处：' + target.path);
    }
    try {
      fs.mkdirSync(target.path, { recursive: true });
    } catch (e) {
      throw new Error('工作区目录建不出来，会话留在原处：' + target.path + '（' + errText(e) + '）');
    }
    let made = null;
    try {
      made = await reg.create(target.path, target.title);
    } catch (e) {
      throw new Error('新建工作区失败，会话留在原处：' + target.path + '（' + errText(e) + '）');
    }
    const id = String((made && (made.id || (made.header && made.header.id))) || '');
    if (!id) throw new Error('工作区已创建但未返回 id：' + target.path);
    row = { id, title: target.title, path: target.path };
    created = true;
  }
  const w = typeof reg.get === 'function' ? reg.get(String(row.id)) : null;
  if (!w || typeof w.attachSession !== 'function') throw new Error('工作区实体不可用：' + row.title);
  try {
    await w.attachSession(String(sid));
  } catch (e) {
    // 会话的 cwd 写死在 header 里，注册表按 canonical 路径比对后才收；对不上时宿主报英文原话。
    const msg = String((e && e.message) || e);
    const m = /its cwd resolves to '([^']+)'/.exec(msg);
    if (m) {
      throw new Error('会话工作目录是「' + m[1] + '」，不在「' + (row.title || target.title) + '」里；DSH 不允许改会话工作目录，所以移不进去。处置：在该工作区新建会话，或让本会话留在原位。');
    }
    throw e;
  }
  return { attached: true, created, title: String(row.title || target.title), path: String(row.path || target.path), id: String(row.id) };
}
