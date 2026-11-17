/**
 * 新建会话的唯一落点：建会话、改名、登记角色、当场装配。
 * ho_sessions(new)、设置页一键部署与补建全局会话共用这一段，避免 3 处各写一遍。
 */
import { ABORTED_TEXT, aborted } from './abort.mjs';

/** 读角色表里的条目；读不到返回 null（用于建会话后的可核验核对）。 */
function roleEntryOf(env, sessionId) {
  try {
    return typeof env.roleEntryOf === 'function' ? env.roleEntryOf(sessionId) : null;
  } catch (error) {
    void error;
    return null;
  }
}

/**
 * 建一个会话并当场登记角色。
 * 失败时不回收已建会话，只把原因随结果返回，由调用方如实告知用户。
 * @param {object} env 插件环境（需要 controller、writeRole、roleEntryOf、applyScopedLive）
 * @param {object} opts { workspaceId?, cwd?, title?, role?, project?, task? }
 * @param {AbortSignal} [signal] 本次工具调用的中止信号
 * @returns {Promise<{sessionId?:string, workspaceId?:string, error?:string}>} 建成的会话与失败原因
 */
export async function newSessionIn(env, opts, signal) {
  const o = opts || {};
  const controller = typeof env.controller === 'function' ? env.controller() : null;
  if (!controller || typeof controller.create !== 'function') {
    return { error: 'sessionController.create 不可用' };
  }
  const workspaceId = String(o.workspaceId || '');
  const cwd = String(o.cwd || '');
  if (!workspaceId && !cwd) return { error: '建会话须给出 workspaceId 或 cwd：两者都为空时无法确定落点' };
  if (aborted(signal)) return { error: ABORTED_TEXT };
  let created = null;
  try {
    created = workspaceId ? await controller.create({ workspaceId }) : await controller.create({ cwd });
  } catch (e) {
    return { error: '建会话失败：' + String(e && e.message ? e.message : e) };
  }
  const sessionId = String((created && created.sessionId) || '');
  if (!sessionId) return { error: 'create 未返回 sessionId' };
  const title = String(o.title || '');
  if (title) {
    try { if (typeof controller.rename === 'function') await controller.rename({ sessionId, title }); } catch { /* 改名失败可事后用 peer（action="rename"） */ }
  }
  // 角色登记必须可核验：写一次、读回核对，读不到再补写一次；仍失败就显式报错，不得静默放过。
  const role = String(o.role || '') || 'plain';
  const project = String(o.project || '');
  const task = String(o.task || '');
  let roleError = '';
  if (typeof env.writeRole !== 'function') {
    roleError = 'writeRole 不可用';
  } else {
    const patch = { role, project, task, source: 'create' };
    let firstError = '';
    try {
      env.writeRole(sessionId, patch);
    } catch (e) {
      firstError = String(e && e.message ? e.message : e);
    }
    let entry = roleEntryOf(env, sessionId);
    if (!entry || String(entry.role || '') !== role) {
      try {
        env.writeRole(sessionId, patch);
      } catch (e) {
        roleError = String(e && e.message ? e.message : e);
      }
      entry = roleEntryOf(env, sessionId);
      if (!entry || String(entry.role || '') !== role) {
        roleError = roleError || firstError || '角色表里查不到该会话条目';
      }
    }
  }
  if (typeof env.applyScopedLive === 'function') {
    try { env.applyScopedLive(sessionId, { role, project, task }); } catch { /* 下一轮的开轮核对会补齐 */ }
  }
  if (roleError) {
    return { sessionId, workspaceId, error: '会话已建成，但角色登记失败：' + roleError + '。处置：用 ho_sessions(action="role") 补登角色，或归档该会话后重建' };
  }
  return { sessionId, workspaceId };
}
