/**
 * 新建会话的唯一落点：建会话、改名、登记角色、当场装配。
 * ho_sessions(new)、设置页一键部署与补建全局会话共用这一段，避免三处各写一遍。
 */

/**
 * @param env 插件环境（需要 controller、writeRole、applyScopedLive）
 * @param opts { workspaceId?, cwd?, title?, role?, project?, task? }
 * @returns { sessionId, workspaceId, error }
 */
export async function newSessionIn(env, opts) {
  const o = opts || {};
  const controller = typeof env.controller === 'function' ? env.controller() : null;
  if (!controller || typeof controller.create !== 'function') {
    return { error: 'sessionController.create 不可用' };
  }
  const workspaceId = String(o.workspaceId || '');
  const cwd = String(o.cwd || '');
  if (!workspaceId && !cwd) return { error: '建会话要么给 workspaceId，要么给 cwd' };
  let created = null;
  try {
    created = workspaceId ? await controller.create({ workspaceId }) : await controller.create({ cwd });
  } catch (e) {
    return { error: '建会话失败：' + String(e && e.message ? e.message : e) };
  }
  const sessionId = String((created && created.sessionId) || '');
  if (!sessionId) return { error: 'create 没有返回 sessionId' };
  const title = String(o.title || '');
  if (title) {
    try { if (typeof controller.rename === 'function') await controller.rename({ sessionId, title }); } catch { /* 改名失败可事后 peer_rename */ }
  }
  const role = String(o.role || '');
  if (role && role !== 'plain' && typeof env.writeRole === 'function') {
    try {
      env.writeRole(sessionId, { role, project: String(o.project || ''), task: String(o.task || ''), source: 'create' });
    } catch { /* 角色登记失败不影响建会话 */ }
  }
  if (typeof env.applyScopedLive === 'function') {
    try { env.applyScopedLive(sessionId, { role: role || 'plain', project: String(o.project || ''), task: String(o.task || '') }); } catch { /* 下一轮的开轮核对会补齐 */ }
  }
  return { sessionId, workspaceId };
}
