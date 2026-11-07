/** 文本/文件小工具：无第三方依赖，全部同步 IO（工具调用内使用）。 */
import fs from 'node:fs';
import path from 'node:path';

export const NL = String.fromCharCode(10);

export function readUtf8(p) {
  return fs.readFileSync(p, 'utf8');
}

export function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

export function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/**
 * 读目录下全部 *.json，返回 [{ name, path, data, mtimeMs }]，读不动的跳过。
 *
 * 投影缓存里有几百个文件、几十 MB，单次读取约 0.2 秒；按会话逐条判定角色时会反复调用。
 * 因此加一层 1.5 秒的进程内缓存：同一轮状态计算只解析一次，跨轮仍是新数据。
 */
const JSON_DIR_TTL_MS = 1500;
const jsonDirCache = new Map();

export function readJsonDir(dir) {
  const key = String(dir);
  const now = Date.now();
  const hit = jsonDirCache.get(key);
  if (hit && now - hit.at < JSON_DIR_TTL_MS) return hit.items;
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return out; }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const p = path.join(dir, name);
    try {
      const st = fs.statSync(p);
      if (!st.isFile()) continue;
      out.push({ name, path: p, data: JSON.parse(fs.readFileSync(p, 'utf8')), mtimeMs: st.mtimeMs });
    } catch { /* 跳过坏文件 */ }
  }
  jsonDirCache.set(key, { at: Date.now(), items: out });
  return out;
}

/** 安全按路径取值，无法获取返回 null。 */
export function pick(node) {
  let cur = node;
  for (let i = 1; i < arguments.length; i++) {
    const k = arguments[i];
    if (cur === null || typeof cur !== "object" || !(k in cur)) return null;
    cur = cur[k];
  }
  return cur === undefined ? null : cur;
}

/** 按标题行切节：返回标题匹配 name 的整段（到下一个 ## 为止）；找不到返回 null。 */
export function sectionLines(text, name) {
  const lines = text.split(NL);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('## ') && lines[i].indexOf(name) !== -1) {
      const out = [];
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].startsWith('## ')) break;
        out.push(lines[j]);
      }
      return out;
    }
  }
  return null;
}