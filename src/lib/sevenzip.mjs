/** 7-Zip 封装：路径探测 + a/t/x 三个动作（参数用数组，不拼命令行字符串）。 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const CANDIDATES = [
  'C:\\Program Files\\7-Zip\\7z.exe',
  'C:\\Program Files (x86)\\7-Zip\\7z.exe',
  '/usr/bin/7z',
  '/usr/local/bin/7z',
  '/opt/homebrew/bin/7z',
  '/usr/bin/7za',
  '/usr/local/bin/7za',
  '/opt/homebrew/bin/7zz',
];
const BARE = new Set(['7z', '7zz', '7za']);

function run7z(bin, args, opts) {
  const res = spawnSync(bin, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, ...(opts || {}) });
  const out = (res.stdout || '') + (res.stderr || '');
  return { code: res.status === null ? -1 : res.status, out: out, error: res.error ? String(res.error.message) : null };
}

export function pack(bin, archive, sourceDir) {
  return run7z(bin, ['a', '-t7z', '-mx=5', '-y', archive, sourceDir + path.sep + '*']);
}

export function test(bin, archive) {
  return run7z(bin, ['t', archive]);
}

export function extract(bin, archive, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  return run7z(bin, ['x', '-y', '-o' + destDir, archive]);
}
let probed = null;

/**
 * 探测可用的 7-Zip：配置路径 → 常见安装位置 → PATH 里的 7z。
 * 返回空串表示本机没有；调用方要能退回内置归档器（lib/archive.mjs），不能因此罢工。
 */
export function sevenZipBin(configured) {
  if (probed !== null) return probed;
  const cands = [];
  if (configured) cands.push(configured);
  for (const c of CANDIDATES) cands.push(c);
  cands.push('7z');
  cands.push('7zz');
  cands.push('7za');
  for (const c of cands) {
    if (!BARE.has(c) && !fs.existsSync(c)) continue;
    const r = run7z(c, ['i']);
    if (r.code === 0) { probed = c; return c; }
  }
  probed = '';
  return '';
}
