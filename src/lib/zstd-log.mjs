/** DSH 会话日志：定位路径、多帧 zstd 解码、增量读取；坏帧跳过。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const NL = String.fromCharCode(10);

export function logsRoot() {
  return path.join(os.homedir(), '.dsh', 'sessions');
}

export const LOG_NAME_RE = /^session\.v\d+\.jsonl(?:\.zstd)?$/;

/** 在会话目录内取会话日志：优先 zstd，其次明文；兼容 v4 之后的版本号。 */
function logInDir(dir) {
  const names = fs.readdirSync(dir).filter((n) => LOG_NAME_RE.test(n));
  const zstd = names.find((n) => n.endsWith('.zstd'));
  return zstd ? path.join(dir, zstd) : (names.length ? path.join(dir, names[0]) : '');
}

/**
 * 路径缓存：会话日志路径在会话生命周期内不变，而递归遍历 ~/.dsh/sessions（上百个目录）
 * 单次约 15ms，每步会被调用 2 至 3 次。命中后先做一次 existsSync，目录被清理时重新查找。
 */
const FIND_TTL_MS = 60000;
const FIND_MAX = 64;
const findCache = new Map();

function rememberFind(key, p) {
  findCache.delete(key);
  findCache.set(key, { path: p, at: Date.now() });
  while (findCache.size > FIND_MAX) findCache.delete(findCache.keys().next().value);
}

/** 在 ~/.dsh/sessions 下找 <sid>/session.vN.jsonl[.zstd]（深度 ≤3）。 */
export function findLog(sid, root) {
  const base = root || logsRoot();
  const key = base + String.fromCharCode(0) + String(sid);
  const now = Date.now();
  const hit = findCache.get(key);
  if (hit && now - hit.at < FIND_TTL_MS) {
    // 日志被清理/归档后路径会失效，一次 existsSync 比整棵目录重扫便宜得多。
    if (fs.existsSync(hit.path)) return hit.path;
    findCache.delete(key);
  }
  // 会话目录名带 session- 前缀，调用方有时只拿到裸 id；2 种写法都要认。
  // 只认一种会静默找不到日志，退回事件数组后压缩状态读成 0 / clean，判定随之失真。
  const want = String(sid || '');
  const names = want.indexOf('session-') === 0 ? [want] : [want, 'session-' + want];
  let found = '';
  const walk = (dir, depth) => {
    if (found || depth > 3) return;
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      const p = path.join(dir, e.name);
      if (names.indexOf(e.name) !== -1) {
        try { found = logInDir(p); } catch { found = ''; }
        if (found) return;
      }
      walk(p, depth + 1);
    }
  };
  walk(base, 0);
  if (!found) return null;
  rememberFind(key, found);
  return found;
}

/** 逐行解析并追加到 out；返回末尾未闭合的行（跨帧续接，语义等同整份字符串 split）。 */
function pushLines(out, text, carry) {
  const s = carry ? carry + text : text;
  if (!s) return '';
  const lines = s.split(NL);
  const tail = lines.pop();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* 非 JSON 行 */ }
  }
  return tail;
}

/** 按 MAGIC 切帧，返回各帧起始偏移（绝对或相对，由 base 决定）。 */
function magicOffsets(buf, base) {
  const out = [];
  let i = 0;
  while (true) {
    const j = buf.indexOf(MAGIC, i);
    if (j < 0) break;
    out.push(base + j);
    i = j + 4;
  }
  return out;
}

/** 从已打开的 fd 精确读取 [pos, pos+len)。 */
function readRange(fd, pos, len) {
  const buf = Buffer.allocUnsafe(len);
  let got = 0;
  while (got < len) {
    const r = fs.readSync(fd, buf, got, len - got, pos + got);
    if (r <= 0) break;
    got += r;
  }
  return got === len ? buf : buf.subarray(0, got);
}

const FRAME_MAGIC_LE = 0xfd2fb528;

function atMagic(buf, off) {
  return off + 4 <= buf.length && buf.readUInt32LE(off) === FRAME_MAGIC_LE;
}

/** 按 block 头计算帧的压缩长度：>=0 完整帧；-1 尾部不完整；-2 结构非法。 */
function blockEnd(buf, pos) {
  while (pos + 3 <= buf.length) {
    const h = buf[pos] | (buf[pos + 1] << 8) | (buf[pos + 2] << 16);
    const type = (h >> 1) & 3;
    const size = h >>> 3;
    if (type === 3) return -2;
    const need = 3 + (type === 1 ? 1 : size);   // RLE 块内容固定 1 字节
    if (pos + need > buf.length) return -1;
    pos += need;
    if (h & 1) return pos;
  }
  return -1;
}

/**
 * 一帧 zstd 的压缩长度（字节）。截断的帧解压不会报错而是返回前半截内容，
 * 只看能否解压无法判断「写了一半」，所以按帧头与 block 头精确算长度。
 */
function frameLength(buf, off) {
  if (buf.length - off < 5) return -1;
  if (!atMagic(buf, off)) return -2;
  const fhd = buf[off + 4];
  const fcsFlag = fhd >> 6;
  const single = (fhd >> 5) & 1;
  const check = (fhd >> 2) & 1;
  const dictFlag = fhd & 3;
  let pos = off + 5;
  if (!single) pos += 1;                        // Window_Descriptor
  pos += [0, 1, 2, 4][dictFlag];                // Dictionary_ID
  pos += [single ? 1 : 0, 2, 4, 8][fcsFlag];    // Frame_Content_Size
  if (pos > buf.length) return -1;
  const end = blockEnd(buf, pos);
  if (end < 0) return end;
  const total = end + (check ? 4 : 0) - off;    // Content_Checksum
  return off + total > buf.length ? -1 : total;
}

/** 当前运行时是否提供 zstd 解压 API（Node 22.15 之前不存在）。 */
export function zstdAvailable() {
  return typeof zlib.zstdDecompressSync === 'function';
}

/** 文件是否以 zstd 帧魔数开头（明文 JSONL 不需要 zstd 支持）。 */
export function isZstdLog(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const b = Buffer.allocUnsafe(4);
      const got = fs.readSync(fd, b, 0, 4, 0);
      return got === 4 && b.readUInt32LE(0) === FRAME_MAGIC_LE;
    } finally { fs.closeSync(fd); }
  } catch { return false; }
}

/** 解压一段帧内容并按行解析；返回 'ok' | 'bad'（坏帧）| 'no-zstd'（缺 API，未尝试）。 */
function decodeFrameInto(out, buf, off, len, carryRef) {
  if (!zstdAvailable()) return 'no-zstd';
  let text = '';
  try { text = zlib.zstdDecompressSync(buf.subarray(off, off + len)).toString('utf8'); } catch { return 'bad'; }
  carryRef.value = pushLines(out, text, carryRef.value);
  return 'ok';
}

/**
 * 解码多帧 zstd 日志，返回带状态的结果：{ records, status, badFrames }。
 * status：ok（全部帧成功）｜partial（部分坏帧，records 为已解出的行）｜bad（有帧但一条都没解出）
 *         ｜empty（可解码但没有事件）｜no-zstd（缺 zstd API，未尝试）｜unreadable（文件读不到）。
 * 调用方据此区分「无事件」与「解压不可用/坏帧」，不要把失败当成空日志。
 * 逐帧解压、逐行解析，不把全部帧拼成一个巨型字符串（10MB 日志的拼接峰值约 150MB）。
 * 帧边界按 block 头计算，遇到结构非法就退回魔数扫描继续，因此仍能跨过坏帧。
 */
export function decodeLogResult(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch { return { records: [], status: 'unreadable', badFrames: 0 }; }
  const first = buf.indexOf(MAGIC);
  if (first < 0) {
    let text = '';
    try { text = buf.toString('utf8'); } catch { return { records: [], status: 'unreadable', badFrames: 0 }; }
    const rows = [];
    pushLines(rows, text, '');
    return rows.length ? { records: rows, status: 'ok', badFrames: 0 } : { records: [], status: 'empty', badFrames: 0 };
  }
  if (!zstdAvailable()) return { records: [], status: 'no-zstd', badFrames: 0 };
  const out = [];
  const carryRef = { value: '' };
  let badFrames = 0;
  let pos = first;
  while (pos < buf.length) {
    const len = frameLength(buf, pos);
    if (len < 0) {
      // 尾部写了一半且后面没有魔数时到此为止；结构非法时跳到下一个魔数继续。
      if (len === -2) badFrames++;
      const j = buf.indexOf(MAGIC, pos + 4);
      if (j < 0) break;
      pos = j;
      continue;
    }
    if (decodeFrameInto(out, buf, pos, len, carryRef) === 'bad') badFrames++;
    pos += len;
  }
  const status = out.length ? (badFrames ? 'partial' : 'ok') : (badFrames ? 'bad' : 'empty');
  return { records: out, status, badFrames };
}

/** 兼容入口：解得出事件即返回数组；空日志返回 []；解压不可用/坏帧/读不到返回 null。 */
export function decodeLog(file) {
  const r = decodeLogResult(file);
  if (r.status === 'no-zstd' || r.status === 'unreadable' || r.status === 'bad') return null;
  return r.records;
}

/**
 * 只解最后 maxFrames 帧（默认 4），用于只看尾部状态的场景。
 * 典型场景为最后一次 summary 与压缩计数增量。
 * 从文件尾部按块回溯找帧起点，无需把整份日志读进内存。
 * 明文日志按最后 maxFrames 行解析；读不到返回 null。
 */
export function decodeLogTail(file, maxFrames) {
  const n = typeof maxFrames === 'number' && maxFrames > 0 ? Math.floor(maxFrames) : 4;
  let fd = null;
  try { fd = fs.openSync(file, 'r'); } catch { return null; }
  try {
    const size = fs.fstatSync(fd).size;
    if (!size) return [];
    let chunk = Math.min(size, 256 * 1024);
    let buf = null;
    let starts = [];
    while (true) {
      buf = readRange(fd, size - chunk, chunk);
      starts = magicOffsets(buf, size - chunk);
      if (starts.length >= n + 1 || chunk >= size) break;
      chunk = Math.min(size, chunk * 4);
    }
    const out = [];
    if (!starts.length) {
      pushLines(out, buf.toString('utf8'), '');
      return out.length > n ? out.slice(-n) : out;
    }
    const base = size - chunk;
    // 只认「帧长能算出来」的起点：压后数据里偶现的魔术字节不算帧。
    const frames = [];
    for (const s of starts) {
      const rel = s - base;
      const len = frameLength(buf, rel);
      if (len > 0) frames.push({ s: rel, len });
    }
    const use = frames.slice(-n);
    const carryRef = { value: '' };
    for (const f of use) decodeFrameInto(out, buf, f.s, f.len, carryRef);
    return out;
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/**
 * 增量读取：只解 [offset, size) 区间内的追加帧（zstd 帧彼此独立，可分段解码）。
 * 返回 { records, nextOffset, carry, size, mtimeMs }。
 * nextOffset 不越过未写完的帧；结构非法帧跳过后仍会推进。
 * 尾部写了一半的帧留在原处，留到下次读取时处理。调用方不要因此重解整份文件；读不到返回 null。
 * carry 是上一步末尾未闭合的半行文本，调用方原样带回即可跨调用续接。
 */
export function readLogAppend(file, offset, carry) {
  let fd = null;
  try { fd = fs.openSync(file, 'r'); } catch { return null; }
  try {
    const fst = fs.fstatSync(fd);
    const size = fst.size;
    let nextOffset = offset;
    const carryRef = { value: carry || '' };
    const records = [];
    if (size > offset) {
      // 用文件首 4 字节判定是 zstd 帧日志还是明文 JSONL；只看追加段会把「写了一半的帧头」当明文。
      const isZstd = size >= 4 && readRange(fd, 0, 4).readUInt32LE(0) === FRAME_MAGIC_LE;
      const buf = readRange(fd, offset, size - offset);
      if (!isZstd) {
        carryRef.value = pushLines(records, buf.toString('utf8'), carryRef.value);
        nextOffset = size;
      } else if (atMagic(buf, 0)) {
        let pos = 0;
        while (pos < buf.length) {
          const len = frameLength(buf, pos);
          if (len < 0) {
            // 后面还有帧起点时，这一帧是坏的，跳过。后面没有帧起点时，说明尾部写了一半，等下次。
            const j = buf.indexOf(MAGIC, pos + 4);
            if (j < 0) break;
            pos = j;
            nextOffset = offset + pos;
            continue;
          }
          decodeFrameInto(records, buf, pos, len, carryRef);
          pos += len;
          nextOffset = offset + pos;
        }
      }
    }
    return { records, nextOffset, carry: carryRef.value, size, mtimeMs: fst.mtimeMs };
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/** 取 turn/start 事件的时间戳序列（按时间排序）。 */
export function turnStarts(records) {
  const starts = [];
  for (const r of records) {
    if (!r || r.type !== "turn/start") continue;
    const turn = r.data && typeof r.data.turn === "number" ? r.data.turn : null;
    if (turn !== null && typeof r.time === "number") starts.push({ turn, time: r.time });
  }
  return starts.sort((a, b) => a.time - b.time);
}
