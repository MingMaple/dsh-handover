/** 文本与路径小工具：无第三方依赖，全部同步 IO，仅供工具调用内部使用。 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

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
 * 项目名与任务名要当目录名用，必须在 Windows、macOS、Linux 上都合法。
 * 规则：非空、不超过 24 字符、不含控制字符与 < > : " / \ | ? *、不以点或空格结尾、不是设备保留名。
 * 名字常来自首条提示等自由文本，须逐一校验。
 * Markdown 里的 `Projects/**` 这类通配写法曾被误当成名字，现已由下列规则拦下。
 */
const RESERVED_NAMES = ['con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9'];

export function isSafeName(name, maxLen) {
  const s = String(name === undefined || name === null ? '' : name);
  const limit = maxLen === undefined ? 24 : maxLen;
  if (s === '' || s.length > limit) return false;
  if (/[\u0000-\u001f\u007f<>:"/\\|?*]/.test(s)) return false;
  if (/[. ]$/.test(s)) return false;
  if (RESERVED_NAMES.indexOf(s.toLowerCase()) !== -1) return false;
  return true;
}

/** 名字不合法时抛出可直接展示的中文错误。 */
export function assertSafeName(name, label, maxLen) {
  if (isSafeName(name, maxLen)) return String(name);
  const shown = String(name === undefined || name === null ? '' : name);
  throw new Error((label || '名称') + '不合法：' + JSON.stringify(shown)
    + '（不得为空、不超过 ' + (maxLen === undefined ? 24 : maxLen) + ' 个字符、不含 < > : " / \\ | ? * 与控制字符、不以点或空格结尾、不是设备保留名）');
}

/**
 * 读目录下全部 *.json，返回 [{ name, path, data, mtimeMs }]；读不动的条目跳过。
 *
 * 投影缓存有几百个文件、几十 MB，单次全量解析约 130ms。按会话判定角色时会反复调用该函数。
 * 因此加进程内缓存：30 秒内直接复用解析结果。
 * 超过 30 秒先算目录签名（文件数、总字节、最新 mtime），签名未变则沿用结果。
 * DSH 会话日志每步追加，旧实现的 1.5 秒 TTL 短于追加间隔，等于每步都冷扫一遍。
 */
const JSON_DIR_TTL_MS = 30000;
const jsonDirCache = new Map();

/** 最新 mtime 文件的原文哈希：同长度、同 mtime 的就地改写靠它识别。 */
function digestOf(p) {
  try { return crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex'); } catch { return ''; }
}

/** 目录签名：名字数 + *.json 总字节 + 最新 mtimeMs + 最新文件的原文哈希。任一变化都说明需要重解析。 */
function dirSignature(dir, names) {
  let count = 0;
  let bytes = 0;
  let latest = 0;
  let latestName = '';
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const st = fs.statSync(path.join(dir, name));
      if (!st.isFile()) continue;
      count++;
      bytes += st.size;
      if (st.mtimeMs > latest) { latest = st.mtimeMs; latestName = name; }
    } catch { /* 跳过坏文件 */ }
  }
  return { count, bytes, latest, latestName, latestHash: latestName ? digestOf(path.join(dir, latestName)) : '' };
}

export function readJsonDir(dir) {
  const key = String(dir);
  const now = Date.now();
  const hit = jsonDirCache.get(key);
  if (hit && now - hit.at < JSON_DIR_TTL_MS) return hit.items;
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  if (hit) {
    const sig = dirSignature(dir, names);
    if (sig.count === hit.sig.count && sig.bytes === hit.sig.bytes && sig.latest === hit.sig.latest
      && sig.latestHash === hit.sig.latestHash) {
      hit.at = now;
      return hit.items;
    }
  }
  const out = [];
  const sig = { count: 0, bytes: 0, latest: 0, latestName: '', latestHash: '' };
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const p = path.join(dir, name);
    try {
      const st = fs.statSync(p);
      if (!st.isFile()) continue;
      sig.count++;
      sig.bytes += st.size;
      if (st.mtimeMs > sig.latest) { sig.latest = st.mtimeMs; sig.latestName = name; }
      out.push({ name, path: p, data: JSON.parse(fs.readFileSync(p, 'utf8')), mtimeMs: st.mtimeMs });
    } catch { /* 跳过坏文件 */ }
  }
  if (sig.latestName) sig.latestHash = digestOf(path.join(dir, sig.latestName));
  jsonDirCache.set(key, { at: Date.now(), sig, items: out });
  return out;
}

/**
 * 按候选文件名逐个直读 <dir>/<stem>.json，命中即返回 { name, data }，全部失败返回 null。
 * 只取单个会话的数据时不要调用 readJsonDir：该函数会全量解析 400 多个文件。
 */
/**
 * 单文件读取缓存：按路径存原文与解析结果，命中先比对原文。
 * 只用 mtime + size 判重会漏掉同长度改写。
 * 2 次写入可能落在同一时间戳刻度，size 又相同，缓存会返回旧值。
 * 原文比对多 1 次读盘，省下的是 JSON 解析，仍比每步重解析便宜。
 */
const lazyFileCache = new Map();
const LAZY_FILE_MAX = 128;

export function readJsonFileLazy(dir, stems) {
  const list = Array.isArray(stems) ? stems : [stems];
  for (const stem of list) {
    const s = String(stem === undefined || stem === null ? '' : stem);
    if (!s) continue;
    const p = path.join(String(dir), s + '.json');
    let st = null;
    try { st = fs.statSync(p); } catch { continue; }
    let buf = null;
    try { buf = fs.readFileSync(p); } catch { continue; }
    const hit = lazyFileCache.get(p);
    if (hit && hit.buf.equals(buf)) {
      hit.mtimeMs = st.mtimeMs;
      hit.size = st.size;
      lazyFileCache.delete(p);
      lazyFileCache.set(p, hit);
      return { name: s + '.json', data: hit.data, mtimeMs: st.mtimeMs, size: st.size };
    }
    try {
      const data = JSON.parse(buf.toString('utf8'));
      lazyFileCache.set(p, { buf, data, mtimeMs: st.mtimeMs, size: st.size });
      while (lazyFileCache.size > LAZY_FILE_MAX) lazyFileCache.delete(lazyFileCache.keys().next().value);
      return { name: s + '.json', data, mtimeMs: st.mtimeMs, size: st.size };
    } catch { /* 试下一个候选 */ }
  }
  return null;
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

/** 字节数转可读大小：GB 保留 2 位小数、MB/KB 保留 1 位，不足 1 KB 按字节。 */
export function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1024 * 1024 * 1024) return (v / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  if (v >= 1024 * 1024) return (v / (1024 * 1024)).toFixed(1) + ' MB';
  if (v >= 1024) return (v / 1024).toFixed(1) + ' KB';
  return v + ' B';
}

/** 固定按 MB 保留 2 位小数（打包与快照清单用，不随量级换算）。 */
export function fmtMB(n) {
  return ((Number(n) || 0) / 1048576).toFixed(2) + ' MB';
}

/** 缺目录时先创建；写入同目录临时文件后 rename，rename 失败则回退为复制。 */
/** 已确认存在的目录：原子写每个回合都会调用，重复 mkdir 是多余的系统调用。 */
const ensuredDirs = new Set();

function ensureDir(dir) {
  if (ensuredDirs.has(dir)) return;
  fs.mkdirSync(dir, { recursive: true });
  ensuredDirs.add(dir);
}

export function writeFileAtomic(file, text) {
  const dir = path.dirname(String(file));
  ensureDir(dir);
  const tmp = path.join(dir, '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 10));
  try {
    fs.writeFileSync(tmp, text, 'utf8');
  } catch {
    // 目录被外部清理时重建一次。
    ensuredDirs.delete(dir);
    ensureDir(dir);
    fs.writeFileSync(tmp, text, 'utf8');
  }
  try {
    fs.renameSync(tmp, file);
  } catch {
    try { fs.copyFileSync(tmp, file); } finally { try { fs.unlinkSync(tmp); } catch { /* ignore */ } }
  }
}