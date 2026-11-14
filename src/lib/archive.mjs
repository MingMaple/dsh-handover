/**
 * 自带归档器：不依赖 7-Zip 的 tar(.gz) 读写（纯 Node，node:zlib 压缩）。
 * 目的：插件所有功能都必须能用「构建产物 + DSH 自带环境」跑起来；7-Zip 只是可选加速器，不是前提。
 * 格式口径：ustar + GNU 长名（typeflag L）；只存普通文件与目录；符号链接、硬链接一律不读不写。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const BLOCK = 512;
const MAX_TOTAL = 512 * 1024 * 1024;

function octal(value, len) {
  const s = Math.max(0, Math.floor(value)).toString(8);
  if (s.length > len - 1) throw new Error('归档字段溢出：' + s);
  return s.padStart(len - 1, '0') + String.fromCharCode(0);
}

function tarHeader(nameBytes, opts) {
  const o = opts || {};
  const h = Buffer.alloc(BLOCK, 0);
  nameBytes.copy(h, 0, 0, Math.min(nameBytes.length, 100));
  h.write(octal(o.mode === undefined ? 420 : o.mode, 8), 100, 'ascii');
  h.write(octal(0, 8), 108, 'ascii');
  h.write(octal(0, 8), 116, 'ascii');
  h.write(octal(o.size || 0, 12), 124, 'ascii');
  h.write(octal(o.mtime || 0, 12), 136, 'ascii');
  h.write('        ', 148, 'ascii');
  h.write(o.type || '0', 156, 'ascii');
  h.write('ustar' + String.fromCharCode(0), 257, 'ascii');
  h.write('00', 263, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  const cs = sum.toString(8).padStart(6, '0');
  h.write(cs + String.fromCharCode(0) + ' ', 148, 'ascii');
  return h;
}

function padToBlock(buf) {
  const rem = buf.length % BLOCK;
  return rem === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - rem, 0);
}

function walkEntries(root) {
  const out = [];
  const visit = (rel) => {
    const abs = rel ? path.join(root, rel.split('/').join(path.sep)) : root;
    let ents = [];
    try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const r = rel ? rel + '/' + e.name : e.name;
      const a = path.join(root, r.split('/').join(path.sep));
      if (e.isDirectory()) {
        out.push({ rel: r + '/', abs: a, dir: true, mtime: 0 });
        visit(r);
      } else if (e.isFile()) {
        let st = null;
        try { st = fs.statSync(a); } catch { continue; }
        out.push({ rel: r, abs: a, dir: false, size: st.size, mtime: st.mtimeMs });
      }
    }
  };
  visit('');
  return out;
}

/** 把目录打成 tar.gz。返回 { files, entries, bytes, archive }。 */
export function packDirTarGz(srcDir, outFile) {
  const entries = walkEntries(srcDir);
  const total = entries.reduce((s, e) => s + (e.size || 0), 0);
  if (total > MAX_TOTAL) throw new Error('待归档总量 ' + total + ' B 超过上限 ' + MAX_TOTAL + ' B，拒绝打包');
  const chunks = [];
  let files = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.rel, 'utf8');
    const mtime = Math.floor((e.mtime || Date.now()) / 1000);
    if (e.rel.length > 100) {
      const payloadName = Buffer.concat([Buffer.from(e.rel, 'utf8'), Buffer.alloc(1, 0)]);
      chunks.push(
        tarHeader(Buffer.from('././@LongLink', 'utf8'), { size: payloadName.length, mtime, type: 'L' }),
        payloadName,
        padToBlock(payloadName),
      );
    }
    if (e.dir) {
      chunks.push(tarHeader(nameBuf, { type: '5', mode: 493, mtime }));
      continue;
    }
    const body = fs.readFileSync(e.abs);
    chunks.push(tarHeader(nameBuf, { size: body.length, mtime }), body, padToBlock(body));
    files++;
  }
  chunks.push(Buffer.alloc(BLOCK * 2, 0));
  const tar = Buffer.concat(chunks);
  fs.writeFileSync(outFile, zlib.gzipSync(tar, { level: 6 }));
  return { files, entries: entries.length, bytes: tar.length, archive: outFile };
}

/** 归档格式：'7z' | 'targz' | 'unknown'（按魔数判断，不看扩展名）。 */
export function detectFormat(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(8, 0);
    fs.readSync(fd, head, 0, 8, 0);
    if (head[0] === 0x37 && head[1] === 0x7a && head[2] === 0xbc && head[3] === 0xaf) return '7z';
    if (head[0] === 0x1f && head[1] === 0x8b) return 'targz';
    return 'unknown';
  } catch {
    return 'unknown';
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

/** 把归档里的相对路径规范化；不安全（绝对路径、盘符、..）返回 null。 */
export function safeRel(name) {
  const raw = String(name || '').replace(/\\/g, '/');
  if (raw === '') return null;
  if (raw.charAt(0) === '/') return null;
  if (/^[a-zA-Z]:/.test(raw)) return null;
  const segs = raw.split('/').filter((s) => s !== '' && s !== '.');
  if (!segs.length) return null;
  for (const s of segs) if (s === '..') return null;
  return segs.join('/');
}

function readOctal(buf, off, len) {
  let s = '';
  for (let i = off; i < off + len; i++) {
    const c = buf[i];
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  s = s.trim();
  return s === '' ? 0 : parseInt(s, 8) || 0;
}

function parseTar(buf, onEntry) {
  let off = 0;
  let longName = null;
  while (off + BLOCK <= buf.length) {
    const header = buf.subarray(off, off + BLOCK);
    let allZero = true;
    for (const b of header) if (b !== 0) { allZero = false; break; }
    if (allZero) break;
    const size = readOctal(header, 124, 12);
    const typeByte = header[156] === 0 ? 48 : header[156];
    const type = String.fromCharCode(typeByte);
    let nameEnd = header.indexOf(0, 0);
    if (nameEnd === -1 || nameEnd > 100) nameEnd = 100;
    let name = header.toString('utf8', 0, nameEnd);
    const bodyStart = off + BLOCK;
    const body = buf.subarray(bodyStart, Math.min(bodyStart + size, buf.length));
    const pad = (BLOCK - (size % BLOCK)) % BLOCK;
    off = bodyStart + size + pad;
    if (type === 'L') { longName = body.toString('utf8').replace(/\u0000+$/, ''); continue; }
    if (longName) { name = longName; longName = null; }
    onEntry({ name, type, size, body });
  }
}

/** 列出 tar.gz 内的条目：[{ rel, size, type }]（rel 不安全的条目也照实列出，标 safe:false）。 */
export function listTarGz(file) {
  const buf = zlib.gunzipSync(fs.readFileSync(file));
  const out = [];
  parseTar(buf, (e) => {
    const rel = safeRel(e.name);
    out.push({ rel: rel === null ? e.name : rel, size: e.size, type: e.type, safe: rel !== null });
  });
  return out;
}

/** 解 tar.gz 到 destDir；跳过不安全路径与链接类条目。返回 { written, dirs, skipped }。 */
export function extractTarGz(file, destDir) {
  const buf = zlib.gunzipSync(fs.readFileSync(file));
  const root = path.resolve(destDir);
  let written = 0;
  let dirs = 0;
  const skipped = [];
  parseTar(buf, (e) => {
    const rel = safeRel(e.name);
    if (rel === null) { skipped.push('不安全路径：' + e.name); return; }
    const dest = path.resolve(root, rel.split('/').join(path.sep));
    if (dest !== root && !dest.startsWith(root + path.sep)) { skipped.push('越界：' + rel); return; }
    if (e.type === '5') {
      fs.mkdirSync(dest, { recursive: true });
      dirs++;
      return;
    }
    if (e.type === '1' || e.type === '2') { skipped.push('链接条目不处理：' + rel); return; }
    if (e.type !== '0' && e.type !== '') { skipped.push('未知条目类型 ' + e.type + '：' + rel); return; }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, e.body);
    written++;
  });
  return { written, dirs, skipped };
}
