/**
 * 工作区与会话生命周期只走 DSH 官方服务（workspaceRegistry）。
 * 读不到服务时明确报错，不直接改注册表文件。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readUtf8 } from './text.mjs';
import { serviceOf } from './engine.mjs';

function workspaceJsonPath() {
  return path.join(os.homedir(), '.dsh', 'storages', 'workspace.json');
}

// workspace.json 约 13KB，设置页每行列角色都会问一次「哪些会话属于全局」。
// 按 mtime + size 缓存解析结果：内容没变就不重复 JSON.parse，也不重复拼全局会话集合。
// 缓存键失效时回落到空表，调用方按「未接入」处理，不阻断设置页。
let tableCache = { stamp: '', tables: {} };
let globalCache = { stamp: '', ids: [] };

function workspaceTableCached() {
  try {
    const file = workspaceJsonPath();
    const st = fs.statSync(file);
    const stamp = st.mtimeMs + ':' + st.size;
    if (tableCache.stamp === stamp) return tableCache;
    const data = JSON.parse(readUtf8(file));
    const tables = (data && data.tables && data.tables.workspaces) || {};
    tableCache = { stamp, tables };
    return tableCache;
  } catch {
    tableCache = { stamp: '', tables: {} };
    return tableCache;
  }
}

/** 读 workspace.json 的 workspaces 表（只读；读不到返回空表）。 */
function readWorkspaceTable() {
  return workspaceTableCached().tables;
}

/** 官方服务：ctx.workspaceRegistry（session-controller 就是这么用的）；无法获取返回 null。 */
export function resolveRegistry(ctx) {
  return serviceOf(ctx, null, 'workspaceRegistry');
}

/** 「全局」工作区里的会话 id 集合（判定会话是否属于全局）。 */
export function globalWorkspaceSessionIds() {
  const { stamp, tables } = workspaceTableCached();
  if (stamp && globalCache.stamp === stamp) return globalCache.ids;
  const out = [];
  const seen = new Set();
  for (const id of Object.keys(tables)) {
    const w = tables[id] || {};
    const title = typeof w.title === 'string' ? w.title : '';
    if (title.indexOf('全局') === -1) continue;
    for (const sid of (Array.isArray(w.sessionIds) ? w.sessionIds : [])) {
      if (seen.has(sid)) continue;
      seen.add(sid);
      out.push(sid);
    }
  }
  if (stamp) globalCache = { stamp, ids: out };
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
