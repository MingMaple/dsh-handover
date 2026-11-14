/**
 * 绝对路径体检：扫「文件内容里写死的本机绝对路径」，只报告、不改写。
 * 跨机器/跨平台迁移时，这些位置必须由人或项目会话自己处理——插件改不了用户文件里的路径语义。
 */
import fs from 'node:fs';
import path from 'node:path';

const SKIP_EXT = new Set([
  '.7z', '.zip', '.gz', '.zst', '.tar', '.rar',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svg',
  '.pdf', '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt',
  '.mp3', '.mp4', '.mov', '.wav', '.flac', '.m4a',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.exe', '.dll', '.so', '.dylib', '.node', '.pyc', '.class', '.jar',
  '.db', '.sqlite', '.bin', '.dat',
]);
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_PER_FILE = 3;

/**
 * 识别模式：本机路径的典型写法。
 * 盘符前必须是词边界、冒号后不能再跟斜杠——否则 https:// 、file:/// 的尾字母会被误判成盘符。
 */
const PATTERNS = [
  ['盘符路径', /(?<![A-Za-z0-9_])[A-Za-z]:[\\/](?![\\/])[^\s'"`<>|]*/g],
  ['UNC 网络路径', /(?<![A-Za-z0-9_\\])\\\\[A-Za-z0-9_.-]+\\[^\s'"`<>|]*/g],
  ['POSIX 家目录', /(?<![A-Za-z0-9_.-])\/(?:Users|home)\/[A-Za-z0-9_.-]+\/[^\s'"`<>|]*/g],
  ['file URL', /file:\/\/\/[^\s'"`<>|]*/g],
];

function walk(root, rel, out) {
  let names = [];
  try { names = fs.readdirSync(path.join(root, rel)); } catch { return out; }
  for (const name of names) {
    const r = rel ? rel + '/' + name : name;
    const abs = path.join(root, rel, name);
    let st;
    try { st = fs.statSync(abs); } catch { continue; }
    if (st.isDirectory()) walk(root, r, out);
    else if (st.isFile()) out.push({ rel: r, abs, bytes: st.size });
  }
  return out;
}

/**
 * 扫一个目录（或给定相对清单）里的绝对路径引用。
 * @returns {{files:number, scanned:number, skipped:number, hits:Array, totalHits:number, crlf:number, lf:number, nonUtf8:Array, mixed:Array}}
 */
export function scanAbsoluteRefs(root, relPaths) {
  const list = Array.isArray(relPaths) && relPaths.length
    ? relPaths.map((rel) => ({ rel, abs: path.join(root, rel.split('/').join(path.sep)) }))
    : walk(root, '', []);
  const res = { files: list.length, scanned: 0, skipped: 0, hits: [], totalHits: 0, crlf: 0, lf: 0, nonUtf8: [], mixed: [] };
  for (const it of list) {
    const ext = path.extname(it.rel).toLowerCase();
    if (SKIP_EXT.has(ext)) { res.skipped++; continue; }
    let buf;
    try {
      const st = fs.statSync(it.abs);
      if (!st.isFile() || st.size > MAX_BYTES) { res.skipped++; continue; }
      buf = fs.readFileSync(it.abs);
    } catch { res.skipped++; continue; }
    const text = buf.toString('utf8');
    res.scanned++;
    if (text.indexOf(String.fromCharCode(0xFFFD)) !== -1) res.nonUtf8.push(it.rel);
    const hasCrlf = text.indexOf(String.fromCharCode(13, 10)) !== -1;
    const hasLfOnly = /\n/.test(text) && !hasCrlf;
    if (hasCrlf) res.crlf++;
    if (hasLfOnly) res.lf++;
    const lines = text.split(String.fromCharCode(10));
    const items = [];
    for (let i = 0; i < lines.length && items.length < MAX_PER_FILE; i++) {
      const line = lines[i];
      for (const [kind, re] of PATTERNS) {
        re.lastIndex = 0;
        const m = re.exec(line);
        if (!m) continue;
        const sample = String(m[0]).trim().slice(0, 90);
        if (!sample) continue;
        if (items.some((x) => x.kind === kind && x.sample === sample)) continue;
        items.push({ kind, sample, line: i + 1 });
        if (items.length >= MAX_PER_FILE) break;
      }
    }
    if (items.length) {
      res.hits.push({ path: it.rel, items });
      res.totalHits += items.length;
    }
  }
  return res;
}

/** 渲染成给人看的中文结论。 */
export function renderAbsoluteRefs(res, opts) {
  const o = opts || {};
  const out = [];
  const title = o.title || '绝对路径体检';
  out.push(title + '：扫描 ' + res.scanned + ' 个文本文件（跳过二进制/超大 ' + res.skipped + ' 个）');
  if (!res.totalHits) {
    out.push('  未发现写死的本机绝对路径');
  } else {
    out.push('  发现 ' + res.hits.length + ' 个文件中有 ' + res.totalHits + ' 处绝对路径（插件不改写这些内容）：');
    for (const h of res.hits.slice(0, o.max || 10)) {
      out.push('  ' + h.path);
      for (const it of h.items) out.push('      L' + it.line + ' [' + it.kind + '] ' + it.sample);
    }
    if (res.hits.length > (o.max || 10)) out.push('  …还有 ' + (res.hits.length - (o.max || 10)) + ' 个文件（见 manifest）');
  }
  if (res.nonUtf8.length) out.push('  非 UTF-8（疑似 GBK/其他编码）' + res.nonUtf8.length + ' 个：' + res.nonUtf8.slice(0, 5).join('、'));
  if (res.crlf && res.lf) out.push('  换行混用：CRLF ' + res.crlf + ' 个 / LF ' + res.lf + ' 个（跨系统请项目会话自行统一）');
  return out;
}
