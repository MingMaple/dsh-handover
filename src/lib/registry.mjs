/** 工作区与会话生命周期：只走 DSH 官方服务（workspaceRegistry），读不到就明确报错，不自己改注册表文件。 */
import os from 'node:os';
import path from 'node:path';
import { readUtf8 } from './text.mjs';

function workspaceJsonPath() {
  return path.join(os.homedir(), '.dsh', 'storages', 'workspace.json');
}

/** 读 workspace.json 的 workspaces 表（只读；读不到返回空表）。 */
function readWorkspaceTable() {
  try {
    const data = JSON.parse(readUtf8(workspaceJsonPath()));
    return (data && data.tables && data.tables.workspaces) || {};
  } catch { return {}; }
}

/** 官方服务：ctx.workspaceRegistry（session-controller 就是这么用的）；无法获取返回 null。 */
export function resolveRegistry(ctx) {
  let v = null;
  try { v = ctx.workspaceRegistry || null; } catch { /* ignore */ }
  if (!v) { try { v = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : null; } catch { /* ignore */ } }
  return v || null;
}

/** 「全局」工作区里的会话 id 集合（判定会话是否属于全局）。 */
export function globalWorkspaceSessionIds() {
  const out = [];
  const tables = readWorkspaceTable();
  for (const id of Object.keys(tables)) {
    const w = tables[id] || {};
    const title = typeof w.title === 'string' ? w.title : '';
    if (title.indexOf('全局') === -1) continue;
    for (const sid of (Array.isArray(w.sessionIds) ? w.sessionIds : [])) {
      if (out.indexOf(sid) === -1) out.push(sid);
    }
  }
  return out;
}

/** 工作区表投影：id / 标题 / 路径 / 会话数，供 ho_workspace list 用。 */
export function workspaceRows() {
  const tables = readWorkspaceTable();
  return Object.keys(tables).map((id) => {
    const w = tables[id] || {};
    return {
      id,
      title: typeof w.title === 'string' ? w.title : '-',
      path: typeof w.path === 'string' ? w.path : '-',
      sessions: Array.isArray(w.sessionIds) ? w.sessionIds.length : 0,
    };
  });
}
