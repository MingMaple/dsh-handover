/** 工作区解析：设置页路由（没有 exec）与工具侧共用同一套判定。 */
import path from 'node:path';
import { isDir } from './text.mjs';
import { workspaceRows } from './registry.mjs';

export function hasCenter(p) {
  if (!p || p === '-') return false;
  try { return isDir(path.join(p, '_Control_Center')); } catch { return false; }
}

/**
 * 没有 exec 时的回退顺序：先取配置 workspaceRoot。
 * 其次取标题含「全局」且带 _Control_Center 的工作区，再次取任一带 _Control_Center 的工作区。
 * 都取不到时返回空串（视为没有工作区根），由调用方拒绝写入；不把进程 cwd 当作工作区根（D-112）。
 */
export function routeWorkspace(env) {
  try { if (env && env.cfg && env.cfg.workspaceRoot) return env.cfg.workspaceRoot; } catch { /* ignore */ }
  let rows = [];
  try { rows = workspaceRows(); } catch { rows = []; }
  const list = Array.isArray(rows) ? rows : [];
  for (const r of list) if (String(r.title).indexOf('全局') !== -1 && hasCenter(r.path)) return r.path;
  for (const r of list) if (hasCenter(r.path)) return r.path;
  return '';
}
