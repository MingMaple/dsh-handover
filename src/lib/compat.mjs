/**
 * 兼容模块（可整删）：接入 1.0.0 至 1.1.x 的旧位置会话产物。
 *
 * 旧位置为 `~/.dsh/storages/dsh-handover.snapshots/<sid>/`。
 * 会话目录就绪时，把其中文件整份复制到 `storeLocation(sid).dir`。
 * 同名文件跳过，不删除旧文件；每会话每进程只处理一次。
 * 会话目录未就绪时暂缓接入，旧文件保持原位，就绪后再处理。
 * 1.0.0 之前的 docmap 数据不在支持范围。
 * 删除本文件时，同步删除 index.mjs 中 2 处 adoptLegacyStore 调用即可。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { storeLocation } from './store.mjs';

/** 旧位置相对用户主目录的路径。 */
const LEGACY_STORE_DIR = path.join('.dsh', 'storages', 'dsh-handover.snapshots');

/** 旧位置目录：`~/.dsh/storages/dsh-handover.snapshots/<sid>`。 */
function legacyStoreDir(sid) {
  return path.join(os.homedir(), LEGACY_STORE_DIR, String(sid || 'unknown'));
}

/** 已检查过的会话：每会话每进程只处理一次。 */
const checked = new Set();

/**
 * 把旧位置的文件复制进当前存储位置。
 * @param {string} sid
 * @returns {{adopted:string[], skipped:string[], from:string, to:string}}
 */
export function adoptLegacyStore(sid) {
  const id = String(sid || '');
  const from = legacyStoreDir(id);
  const result = { adopted: [], skipped: [], from, to: '' };
  if (!id || checked.has(id)) return result;
  const loc = storeLocation(id);
  if (loc.staged) return result;
  checked.add(id);
  result.to = loc.dir;
  let names = [];
  try { names = fs.readdirSync(from); } catch { return result; }
  for (const name of names) {
    const src = path.join(from, name);
    try { if (!fs.statSync(src).isFile()) continue; } catch { continue; }
    const dst = path.join(loc.dir, name);
    if (fs.existsSync(dst)) { result.skipped.push(name); continue; }
    try {
      fs.mkdirSync(loc.dir, { recursive: true });
      fs.copyFileSync(src, dst);
      result.adopted.push(name);
    } catch { result.skipped.push(name); }
  }
  return result;
}
