/** 工作区解析：路由侧（设置页，没有 exec）与工具侧共用一套判定。 */
import path from 'node:path';
import { isDir } from './text.mjs';
import { workspaceRows } from './registry.mjs';

export function hasCenter(p) {
  if (!p || p === '-') return false;
  try { return isDir(path.join(p, '_Control_Center')); } catch { return false; }
}

/**
 * 没有 exec 时的兜底：配置 workspaceRoot → 标题含「全局」且带 _Control_Center 的工作区
 * → 任一带 _Control_Center 的工作区 → 进程 cwd。
 */
export function routeWorkspace(env) {
  try { if (env && env.cfg && env.cfg.workspaceRoot) return env.cfg.workspaceRoot; } catch { /* ignore */ }
  let rows = [];
  try { rows = workspaceRows(); } catch { rows = []; }
  const list = Array.isArray(rows) ? rows : [];
  for (const r of list) if (String(r.title).indexOf('全局') !== -1 && hasCenter(r.path)) return r.path;
  for (const r of list) if (hasCenter(r.path)) return r.path;
  try { return process.cwd(); } catch { return ''; }
}
