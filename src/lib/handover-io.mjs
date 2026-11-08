/** 交接文档读写：原子写 + 写前备份 + 写后体检（判据复用 lib/lint.mjs）。路径按会话角色解析。 */
import fs from 'node:fs';
import path from 'node:path';
import { readUtf8 } from './text.mjs';
import { lintGlobal, lintProject } from './lint.mjs';
import { snapshotDirFor } from './role.mjs';

function stamp() {
  const d = new Date();
  const p = (n) => (n < 10 ? "0" + n : "" + n);
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

/** 读交接：{ path, text }；文件不存在返回 text: null。 */
export function readHandover(file) {
  try { return { path: file, text: readUtf8(file) }; }
  catch { return { path: file, text: null }; }
}

/**
 * 归档时间戳：`YYYYMMDD_HHMMSS`（到秒）。
 * 规范要求时间戳取归档那一刻；只到分钟会在同一分钟内归档两份时撞名，故到秒。
 */
export function archiveStamp(d) {
  const x = d || new Date();
  const p = (n) => (n < 10 ? "0" + n : "" + n);
  return x.getFullYear() + p(x.getMonth() + 1) + p(x.getDate()) + "_" + p(x.getHours()) + p(x.getMinutes()) + p(x.getSeconds());
}

/**
 * 归档文件名：`<原文件名>_<YYYYMMDD_HHMMSS>.md`。
 * 「原文件名」取源文件主名（不含扩展名）：全局 `Global_Handover_…`、项目与杂项 `Handover_…`；
 * 不加链标识——归档目录本身已按链隔离（规范 §4.1）。
 */
export function archiveFileName(file, stampText) {
  const base = String(file || "").split(/[\\/]/).pop().replace(/\.md$/i, "");
  return base + "_" + String(stampText) + ".md";
}

/**
 * 写交接：先把旧文件复制到 <作用域>/Snapshots/pm-handover-<stamp>/，再原子替换，最后按角色体检。
 * @param {object} [opts] { info?: 角色信息（决定体检判据与备份目录）, kind?: 'global'|'project'|'misc' }
 * @returns {{ path, backup, verdict, reasons, bytes }}
 */
export function writeHandover(ws, file, text, mode, opts) {
  const o = opts || {};
  const info = o.info || { role: o.kind === 'project' ? 'project' : o.kind === 'misc' ? 'misc' : 'global' };
  let dir = null;
  try { dir = snapshotDirFor(ws, info); } catch { dir = path.join(ws, '_Temp', '_Global', 'Snapshots'); }
  let backup = null;
  try {
    if (fs.existsSync(file)) {
      const bdir = path.join(dir, "pm-handover-" + stamp());
      fs.mkdirSync(bdir, { recursive: true });
      backup = path.join(bdir, path.basename(file));
      fs.copyFileSync(file, backup);
    }
  } catch (e) { throw new Error("备份失败，已中止写入：" + e.message); }
  const body = mode === "append" && fs.existsSync(file) ? readUtf8(file) + String.fromCharCode(10) + text : text;
  const parent = path.dirname(file);
  fs.mkdirSync(parent, { recursive: true });
  const tmp = file + ".tmp-" + stamp();
  fs.writeFileSync(tmp, body, "utf8");
  fs.renameSync(tmp, file);
  const res = (o.kind === 'project' || o.kind === 'misc' || info.role === 'project' || info.role === 'misc')
    ? lintProject(file)
    : lintGlobal(file);
  return { path: file, backup, verdict: res.verdict, reasons: res.reasons, bytes: Buffer.byteLength(body, "utf8") };
}
