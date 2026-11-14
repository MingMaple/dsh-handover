/**
 * 全局根目录迁移（跨平台）：探针 → 复制 → 全量校验 → 派后台助手在 DSH 退出后切换 → 状态 → 清旧备份。
 *
 * 平台无关的做法（Windows / Linux / macOS / 安卓 PRoot Ubuntu 同一套）：
 * - **链接**：Windows 用 junction，POSIX 用目录 symlink；都用 node:fs.symlinkSync，不需要管理员。
 * - **助手**：一个纯 Node 脚本，用 DSH 自带的运行时（process.execPath + ELECTRON_RUN_AS_NODE=1）启动，
 *   不依赖 PowerShell / bash。等待用「父进程 pid 还在不在」轮询（process.kill(pid,0)），不按进程名匹配。
 * - **为什么不就地做**：源目录在 DSH 运行时被占用，Windows 下改名会报占用，
 *   所以只能「先复制校验，等 DSH 退了再改名 + 建链接」。
 *
 * 本模块不持有进程状态，入参显式，便于空白环境单测。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathKey } from './pathkey.mjs';

const MARKER_NAME = 'dsh-handover.move.json';
const HELPER_NAME = 'dsh-handover.move.mjs';
const CMD_NAME = 'dsh-handover.move.cmd';
const SH_NAME = 'dsh-handover.move.sh';
const STAMP_REL = path.join('_Temp', '_Global', 'Scratch', '.dsh-handover-verified.json');

function msgOf(e) { return String(e && e.message ? e.message : e); }
function tail(p) { return String(p || '').replace(/[\\/]+$/, ''); }
function canon(p) {
  const t = tail(path.resolve(String(p || '')));
  return process.platform === 'win32' ? t.toLowerCase() : t;
}
function samePath(a, b) { return !!a && !!b && canon(a) === canon(b); }
function isInside(parent, child) {
  const p = canon(parent) + path.sep;
  const c = canon(child) + path.sep;
  return c.startsWith(p) && c !== p;
}
function linkKind() { return process.platform === 'win32' ? 'junction' : 'dir'; }

function stateDir() {
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  return path.join(home, '.dsh', 'storages');
}
function markerPath() { return path.join(stateDir(), MARKER_NAME); }
function switchLogPath() { return path.join(stateDir(), 'dsh-handover.move.log'); }
export function scriptPaths() {
  const d = stateDir();
  return {
    helper: path.join(d, HELPER_NAME),
    cmd: path.join(d, CMD_NAME),
    sh: path.join(d, SH_NAME),
    log: switchLogPath(),
  };
}

function readMarker() {
  try {
    const text = fs.readFileSync(markerPath(), 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(text);
  } catch { return null; }
}
function writeMarker(obj) {
  fs.mkdirSync(stateDir(), { recursive: true });
  const p = markerPath();
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, p);
  return p;
}
function stampNow() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ' +0800';
}

async function measure(dir) {
  let files = 0; let bytes = 0; let dirs = 0;
  const walk = async (d) => {
    for (const e of await fsp.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { dirs += 1; await walk(p); continue; }
      files += 1;
      try { bytes += (await fsp.stat(p)).size; } catch { /* 读取失败则跳过 */ }
    }
  };
  await walk(dir);
  return { files, bytes, dirs };
}

async function hashFile(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(p);
    s.on('error', reject);
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

export async function manifest(dir, onProgress) {
  const rows = [];
  const walk = async (d, rel) => {
    const ents = await fsp.readdir(d, { withFileTypes: true });
    ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of ents) {
      const p = path.join(d, e.name);
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { await walk(p, r); continue; }
      let size = 0; let sum = '-';
      try { size = (await fsp.stat(p)).size; sum = await hashFile(p); }
      catch (err) { sum = 'ERR:' + msgOf(err); }
      rows.push(r + '|' + size + '|' + sum);
      if (onProgress && rows.length % 500 === 0) onProgress(rows.length);
    }
  };
  await walk(dir, '');
  const digest = crypto.createHash('sha256').update(rows.join('\n')).digest('hex');
  return { rows, digest, files: rows.length };
}

function freeSpaceOf(p) {
  try { if (typeof fs.statfsSync !== 'function') return null; } catch { return null; }
  try { const st = fs.statfsSync(p); return Number(st.bavail) * Number(st.bsize); } catch { /* 目标可能还不存在 */ }
  try {
    const st2 = fs.statfsSync(path.parse(path.resolve(p)).root);
    return Number(st2.bavail) * Number(st2.bsize);
  } catch { return null; }
}

function linkTargetOf(p) {
  try {
    const st = fs.lstatSync(p);
    if (!st.isSymbolicLink()) return null;
    return fs.readlinkSync(p);
  } catch { return null; }
}

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1024 * 1024 * 1024) return (v / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  if (v >= 1024 * 1024) return (v / (1024 * 1024)).toFixed(1) + ' MB';
  if (v >= 1024) return (v / 1024).toFixed(1) + ' KB';
  return v + ' B';
}

function stampPathOf(dst) { return path.join(dst, STAMP_REL); }
function writeStamp(marker) {
  const p = stampPathOf(marker.dst);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({
    digest: marker.digest, files: marker.files, bytes: marker.bytes,
    from: marker.src, verifiedAt: marker.copiedAt, plugin: 'dsh-handover',
  }, null, 2), 'utf8');
  return p;
}

/** 探针：只读。 */
export async function probeMove({ src, to }) {
  const problems = [];
  const warnings = [];
  if (!src) throw new Error('缺少当前全局根路径');
  const s = tail(path.resolve(String(src)));
  let st = null;
  try { st = fs.lstatSync(s); } catch { st = null; }
  if (!st) throw new Error('当前全局根不存在：' + s);
  if (!st.isDirectory()) throw new Error('当前全局根不是目录：' + s);

  const asLink = linkTargetOf(s);
  if (asLink) warnings.push('当前根已经是链接（指向 ' + asLink + '），本次以它的真实位置为复制的源');
  let copyFrom = s;
  if (asLink) {
    try { copyFrom = tail(fs.realpathSync(s)); } catch { copyFrom = tail(asLink); }
  }
  if (!fs.existsSync(path.join(copyFrom, '_Control_Center'))) warnings.push('源目录里没有 _Control_Center：确认这是全局根吗？');

  const raw = String(to || '').trim();
  if (!raw) throw new Error('缺少目标路径（to）');
  if (!path.isAbsolute(raw)) problems.push('目标必须是绝对路径：' + raw);
  // 语义：to＝目标**父目录**（把整个根目录搬进去）；basename 与当前根同名则直接当新根。
  const toRaw = tail(path.resolve(raw));
  const rootName = path.basename(s);
  const t = pathKey(path.basename(toRaw)) === pathKey(rootName) ? toRaw : path.join(toRaw, rootName);
  if (samePath(t, s)) problems.push('目标与当前根相同');
  else if (isInside(s, t)) problems.push('目标在当前根内部：' + t);
  else if (isInside(t, s)) problems.push('目标是当前根的上级目录：' + t);

  if (fs.existsSync(t)) {
    let dstStat = null;
    try { dstStat = fs.lstatSync(t); } catch { dstStat = null; }
    if (!dstStat || !dstStat.isDirectory()) problems.push('目标已存在且不是目录：' + t);
    else {
      let kids = [];
      try { kids = fs.readdirSync(t); } catch { kids = []; }
      if (kids.length) problems.push('目标已存在且非空（' + kids.length + ' 项）：' + t);
    }
  }

  const srcSize = await measure(copyFrom);
  const freeBytes = freeSpaceOf(t);
  if (freeBytes !== null && freeBytes < srcSize.bytes * 1.15) {
    problems.push('目标盘空间不足：可用 ' + fmtBytes(freeBytes) + '，需要约 ' + fmtBytes(srcSize.bytes * 1.15));
  }
  if (!freeBytes && freeBytes !== 0) warnings.push('无法获取目标盘可用空间（继续前请自行确认）');

  return {
    ok: problems.length === 0,
    src: s, copyFrom, parent: toRaw, dst: t,
    srcIsLink: !!asLink, linkTarget: asLink || '',
    files: srcSize.files, bytes: srcSize.bytes, dirs: srcSize.dirs,
    freeBytes, problems, warnings,
  };
}

/** 复制 + 全量校验 + 落标记 + 写助手脚本。失败即抛，不留可被误用的标记。 */
export async function startMove({ src, to, onProgress }) {
  const p = await probeMove({ src, to });
  if (!p.ok) throw new Error('预检未通过：' + p.problems.join('；'));
  await fsp.mkdir(p.dst, { recursive: true });
  if (onProgress) onProgress({ stage: 'copy', done: 0, total: p.files });
  try {
    await fsp.cp(p.copyFrom, p.dst, { recursive: true, force: false, errorOnExist: false, dereference: false, preserveTimestamps: true });
  } catch (e) {
    throw new Error('复制失败：' + msgOf(e) + '（目标可能已有部分文件，可清空后重跑）');
  }
  if (onProgress) onProgress({ stage: 'verify', done: 0, total: p.files });
  const a = await manifest(p.copyFrom, (n) => { if (onProgress) onProgress({ stage: 'verify-src', done: n, total: p.files }); });
  const b = await manifest(p.dst, (n) => { if (onProgress) onProgress({ stage: 'verify-dst', done: n, total: p.files }); });
  const am = new Set(a.rows); const bm = new Set(b.rows);
  const missing = []; const extra = [];
  for (const r of a.rows) if (!bm.has(r)) missing.push(r.split('|')[0]);
  for (const r of b.rows) if (!am.has(r)) extra.push(r.split('|')[0]);
  const identical = a.digest === b.digest && a.files === b.files;
  const marker = {
    version: 2, src: p.src, copyFrom: p.copyFrom, dst: p.dst,
    phase: identical ? 'verified' : 'partial',
    files: a.files, bytes: p.bytes, digest: a.digest, copiedAt: stampNow(),
    verified: identical,
    missing: missing.slice(0, 20), extra: extra.slice(0, 20),
    missingCount: missing.length, extraCount: extra.length,
    script: scriptPaths(),
  };
  writeMarker(marker);
  if (!identical) {
    return { ok: false, marker, report: { files: a.files, bytes: p.bytes, digest: a.digest, copies: b.files, missing: missing.slice(0, 20), extra: extra.slice(0, 20), missingCount: missing.length, extraCount: extra.length } };
  }
  writeStamp(marker);
  marker.script = writeHelper(marker);
  writeMarker(marker);
  return { ok: true, marker, report: { files: a.files, bytes: p.bytes, digest: a.digest, copies: b.files } };
}

/** 生成跨平台助手脚本（纯 Node，不依赖 PowerShell、bash）+ 两个手工兜底启动器。 */
function writeHelper(marker) {
  fs.mkdirSync(stateDir(), { recursive: true });
  const sp = scriptPaths();
  const exe = (() => { try { return String(process.execPath || ''); } catch { return ''; } })();
  const helper = `// dsh-handover 切换助手（由插件生成，勿手改；跨平台，纯 Node）
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const MARKER = ${JSON.stringify(markerPath())};
const LOG = ${JSON.stringify(sp.log)};
const WAIT_PID = Number(process.argv[2] || 0) || 0;
const RELAUNCH = process.argv.indexOf('--relaunch') !== -1;
const EXE = ${JSON.stringify(exe)};
const ENV_SRC = ${JSON.stringify(marker.src)};
const ENV_DST = ${JSON.stringify(marker.dst)};
const RETARGET_HELPER = ${JSON.stringify((marker.retarget && marker.retarget.needed) ? marker.retarget.script : '')};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function log(m) {
  const line = new Date().toISOString() + '  ' + m;
  try { fs.appendFileSync(LOG, line + '\\n', 'utf8'); } catch { /* ignore */ }
  try { console.log(m); } catch { /* ignore */ }
}
function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
}
function stamp(text) { const t = String(text || '').replace(/[\\/]+$/, ''); return process.platform === 'win32' ? t.toLowerCase() : t; }
function stop(m) { log('[中止] ' + m); process.exit(1); }

(async () => {
  log('== dsh-handover 切换助手 ==  pid=' + process.pid + '  等待 pid=' + WAIT_PID);
  if (WAIT_PID) {
    log('等待 DSH 退出（最多 30 分钟）…');
    for (let i = 0; i < 900; i++) { if (!alive(WAIT_PID)) break; await sleep(2000); }
    if (alive(WAIT_PID)) stop('等待 DSH 退出超时，未做任何改动');
    await sleep(2000);
    log('DSH 已退出，开始切换');
  }
  let m = null;
  try { m = JSON.parse(fs.readFileSync(MARKER, 'utf8').replace(/^\\uFEFF/, '')); } catch { stop('读不到标记文件：' + MARKER); }
  const src = m.src; const dst = m.dst;
  log('源  ：' + src);
  log('目标：' + dst);
  if (!fs.existsSync(dst)) stop('目标不存在：' + dst);
  if (!fs.existsSync(src)) stop('源不存在：' + src);
  const stampFile = path.join(dst, '_Temp', '_Global', 'Scratch', '.dsh-handover-verified.json');
  if (!fs.existsSync(stampFile)) stop('目标里没有校验印章，它可能不是这次复制出来的');
  let sp2 = null;
  try { sp2 = JSON.parse(fs.readFileSync(stampFile, 'utf8')); } catch { stop('校验印章读不出来'); }
  if (String(sp2.digest) !== String(m.digest)) stop('校验印章与标记不一致，目标可能被改动过');
  log('校验印章匹配：' + sp2.files + ' 文件 · ' + String(m.digest).slice(0, 16) + '…');

  const stampName = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 13).replace(/^(\\d{8})(\\d{4})/, '$1-$2');
  const old = src + '.old-' + stampName;
  try { fs.renameSync(src, old); } catch (e) { stop('改名失败（多半还有进程占用）：' + e.message); }
  log('① 已改名：' + src + '  →  ' + old);
  const kind = process.platform === 'win32' ? 'junction' : 'dir';
  try { fs.symlinkSync(dst, src, kind); } catch (e) {
    try { fs.renameSync(old, src); } catch { /* ignore */ }
    stop('建链接失败，已把旧目录改回原名：' + e.message);
  }
  let target = '';
  try { target = fs.readlinkSync(src); } catch { target = ''; }
  if (!target || stamp(target) !== stamp(dst)) {
    log('链接指向不对：' + target + '（旧备份在 ' + old + '）');
    stop('切换校验失败');
  }
  m.phase = 'switched';
  m.switchedAt = new Date().toISOString();
  m.oldPath = old;
  m.linkKind = kind;
  try { fs.writeFileSync(MARKER, JSON.stringify(m, null, 2), 'utf8'); } catch { /* ignore */ }
  log('② 已建 ' + kind + '：' + src + '  →  ' + dst);
  if (RETARGET_HELPER) {
    try {
      spawn(process.execPath, [RETARGET_HELPER, '0'], { detached: true, stdio: 'ignore', windowsHide: true, env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }) }).unref();
      log('③ 已派登记修改登记助手（把 DSH 的登记改到新位置）');
    } catch (e) {
      log('修改登记助手未派成功：' + e.message + '（可在设置页点击「把登记迁到新位置」）');
    }
  }
  log('切换完成。旧备份：' + old);
  if (RELAUNCH && EXE) {
    try {
      spawn(EXE, [], { detached: true, stdio: 'ignore', env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: undefined }) }).unref();
      log('已重新启动：' + EXE);
    } catch (e) { log('重启失败：' + e.message); }
  }
})();
`;
  fs.writeFileSync(sp.helper, helper, 'utf8');
  // 手工兜底：Windows 与 POSIX 各一个启动器，都把 ELECTRON_RUN_AS_NODE 打开（Electron 运行时当 node 用）
  const cmd = ['@echo off', 'set ELECTRON_RUN_AS_NODE=1', '"' + exe + '" "' + sp.helper + '" %*', 'pause', ''].join('\r\n');
  fs.writeFileSync(sp.cmd, cmd, 'utf8');
  const sh = ['#!/bin/sh', 'export ELECTRON_RUN_AS_NODE=1', 'exec "' + exe + '" "' + sp.helper + '" "$@"', ''].join('\n');
  fs.writeFileSync(sp.sh, sh, 'utf8');
  try { fs.chmodSync(sp.sh, 0o755); } catch { /* Windows 上无意义 */ }
  return sp;
}

/** 派后台助手：等本进程（DSH）退出后自动切换。 */
export function stageSwitch({ relaunch, waitPid } = {}) {
  const m = readMarker();
  if (!m || !m.src || !m.dst) throw new Error('没有可用迁移标记，先跑一次 move');
  const st = moveStatus({ src: m.src });
  if (st.phase === 'switched' || st.phase === 'switched+cleaned') return { ok: true, already: true, phase: st.phase, log: switchLogPath() };
  if (st.phase !== 'verified') throw new Error('当前不是「已复制并校验通过」（phase=' + st.phase + '），不能切换');
  try { m.exe = process.execPath || ''; } catch { m.exe = ''; }
  // 先把「登记修改登记」算清楚：哪些文件里还写着旧路径。切换助手完成后会立刻派它执行。
  try {
    const plan = retargetPlan();
    if (plan.needed) {
      const rh = writeRetargetHelper(plan);
      m.retarget = { needed: true, script: rh.helper, log: rh.log, files: rh.files };
    } else {
      m.retarget = { needed: false, files: [] };
    }
  } catch { m.retarget = { needed: false, files: [] }; }
  m.relaunch = relaunch === true;
  m.stagedAt = stampNow();
  writeMarker(m);
  const sp = writeHelper(m);
  try { fs.writeFileSync(sp.log, '', 'utf8'); } catch { /* ignore */ }
  const pid = Number(waitPid || process.pid) || 0;
  const args = [sp.helper, String(pid)];
  if (relaunch === true) args.push('--relaunch');
  const env = Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' });
  let child = null;
  try {
    child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', windowsHide: true, env });
    child.unref();
  } catch (e) {
    return { ok: false, spawned: false, error: '派助手失败：' + msgOf(e), helper: sp.helper, cmd: sp.cmd, sh: sp.sh, log: sp.log };
  }
  return { ok: true, spawned: true, pid: child.pid, waitPid: pid, helper: sp.helper, cmd: sp.cmd, sh: sp.sh, log: sp.log, relaunch: relaunch === true };
}

/**
 * 重建链接：原路径被手工删除（或在资源管理器里误删）后，把链接按原样建回来。
 *
 * 只在「原路径确实不存在」或「原路径是指向别处的链接」时动手；
 * 遇到真实目录一律拒绝——那时候谁是真的数据已经说不清，必须人来判断。
 */
export function repairLink() {
  const m = readMarker();
  if (!m || !m.src || !m.dst) throw new Error('没有迁移记录，无法重建链接');
  if (!fs.existsSync(m.dst)) throw new Error('目标不存在（' + m.dst + '），先确认数据在哪里，本工具不动文件');
  const kind = linkKind();
  let st = null;
  try { st = fs.lstatSync(m.src); } catch { st = null; }
  if (st) {
    const t = linkTargetOf(m.src);
    if (t && samePath(t, m.dst)) return { ok: true, already: true, src: m.src, dst: m.dst, kind };
    if (!st.isSymbolicLink()) {
      throw new Error('原路径已存在且是真实目录（' + m.src + '），拒绝覆盖；请先确认哪一份才是真实数据');
    }
    try { fs.unlinkSync(m.src); } catch (e) { throw new Error('旧的链接删不掉：' + msgOf(e)); }
  }
  try { fs.mkdirSync(path.dirname(m.src), { recursive: true }); } catch { /* 父目录通常还在 */ }
  try { fs.symlinkSync(m.dst, m.src, kind); } catch (e) {
    throw new Error('建链接失败：' + msgOf(e) + '（若在安卓 /sdcard 这类不支持符号链接的挂载点上，请改用真实位置作为工作区根）');
  }
  const t2 = linkTargetOf(m.src);
  if (!t2 || !samePath(t2, m.dst)) {
    throw new Error('重建后校验失败：链接指向 ' + String(t2));
  }
  m.repairedAt = stampNow();
  if (m.phase !== 'switched+cleaned') m.phase = 'switched';
  try { writeMarker(m); } catch { /* ignore */ }
  return { ok: true, repaired: true, src: m.src, dst: m.dst, kind, link: t2 };
}

// ---------------------------------------------------------------- 登记修改登记（真正的「搬过去」）

/** 需要修改登记的 DSH 存储文件：工作区表、聊天集成的归属表。 */
function retargetTargets() {
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  const root = path.join(home, '.dsh');
  const out = [path.join(root, 'storages', 'workspace.json')];
  try {
    const integ = path.join(root, 'integrations');
    for (const name of fs.readdirSync(integ)) {
      const base = path.join(integ, name);
      const w = path.join(base, 'workspaces.json');
      try { if (fs.statSync(w).isFile()) out.push(w); } catch { /* 不存在则跳过 */ }
      const acc = path.join(base, 'accounts');
      let names = [];
      try { names = fs.readdirSync(acc); } catch { names = []; }
      for (const a of names) {
        const s = path.join(acc, a, 'state.json');
        try { if (fs.statSync(s).isFile()) out.push(s); } catch { /* 不存在则跳过 */ }
      }
    }
  } catch { /* 没装集成 */ }
  return out;
}

/** 路径在 JSON 文本里的转义形态（只替换字符串值，不碰结构）。 */
function escPath(p) {
  try { return JSON.stringify(String(p)).slice(1, -1); } catch { return String(p); }
}

function countOf(text, needle) {
  if (!needle) return 0;
  let n = 0;
  let i = -1;
  while ((i = text.indexOf(needle, i + 1)) !== -1) n += 1;
  return n;
}

/** 只算不改：哪些登记文件里还有旧路径、各多少处。 */
export function retargetPlan({ src, dst } = {}) {
  const m = readMarker();
  const S = tail(path.resolve(String(src || (m && m.src) || '')));
  const D = tail(path.resolve(String(dst || (m && m.dst) || '')));
  if (!S || S === '.' || !D) throw new Error('缺少源或目标路径');
  // 已经同一位置（修改登记完成后当前根就是新位置）→ 没有可改的，别误报。
  if (samePath(S, D)) return { src: S, dst: D, files: [], total: 0, needed: false };
  const needle = escPath(S);
  const files = [];
  for (const p of retargetTargets()) {
    let text = '';
    try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
    files.push({ path: p, count: countOf(text, needle) });
  }
  const total = files.reduce((a, b) => a + b.count, 0);
  return { src: S, dst: D, files, total, needed: total > 0 };
}

/** 真改：先备份再整篇替换；只替换字符串里的路径，结构不动。 */
export function applyRetarget(opts) {
  const plan = retargetPlan(opts);
  const from = escPath(plan.src);
  const to = escPath(plan.dst);
  const written = [];
  for (const f of plan.files) {
    if (!f.count) continue;
    let text = '';
    try { text = fs.readFileSync(f.path, 'utf8'); } catch { continue; }
    const bak = f.path + '.bak-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    try { fs.copyFileSync(f.path, bak); } catch { continue; }
    try { fs.writeFileSync(f.path, text.split(from).join(to), 'utf8'); } catch { continue; }
    written.push({ path: f.path, count: f.count, backup: bak });
  }
  const m = readMarker();
  if (m && written.length) {
    m.retargetedAt = stampNow();
    m.retargeted = written.map((w) => ({ path: w.path, count: w.count }));
    try { writeMarker(m); } catch { /* ignore */ }
  }
  return { ok: true, written, plan, note: written.length ? '登记已改到新位置' : '没有需要改的登记' };
}

/** 生成「只改登记」的助手（模板在同目录 retarget-helper.tmpl）。 */
function writeRetargetHelper(plan) {
  fs.mkdirSync(stateDir(), { recursive: true });
  const helper = path.join(stateDir(), 'dsh-handover.retarget.mjs');
  const log = path.join(stateDir(), 'dsh-handover.retarget.log');
  const tmplPath = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'retarget-helper.tmpl');
  let tmpl = '';
  try { tmpl = fs.readFileSync(tmplPath, 'utf8'); } catch (e) { throw new Error('读不到修改登记模板：' + msgOf(e)); }
  const files = plan.files.filter((x) => x.count > 0).map((x) => x.path);
  const text = tmpl.split('%%LOG%%').join(JSON.stringify(log))
    .split('%%FROM%%').join(JSON.stringify(plan.src))
    .split('%%TO%%').join(JSON.stringify(plan.dst))
    .split('%%FILES%%').join(JSON.stringify(files, null, 2));
  fs.writeFileSync(helper, text, 'utf8');
  return { helper, log, from: plan.src, to: plan.dst, files };
}

/** 派修改登记助手：等本进程退出后改写 DSH 登记。 */
export function stageRetarget() {
  const plan = retargetPlan();
  if (!plan.needed) return { ok: true, already: true, plan };
  const sp = writeRetargetHelper(plan);
  try { fs.writeFileSync(sp.log, '', 'utf8'); } catch { /* ignore */ }
  const env = Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' });
  let child = null;
  try {
    child = spawn(process.execPath, [sp.helper, String(process.pid)], { detached: true, stdio: 'ignore', windowsHide: true, env });
    child.unref();
  } catch (e) {
    return { ok: false, spawned: false, error: '派助手失败：' + msgOf(e), plan, script: sp };
  }
  return { ok: true, spawned: true, pid: child.pid, waitPid: process.pid, plan, script: sp };
}

/** 状态：verified、switched、partial、none。 */
export function moveStatus({ src } = {}) {
  const m = readMarker();
  const s = tail(path.resolve(String(src || (m && m.src) || '.')));
  const dst = (m && m.dst) || '';
  const link = linkTargetOf(s);
  let phase = 'none';
  if (m && m.phase === 'switched+cleaned' && link && dst && samePath(link, dst)) phase = 'switched+cleaned';
  else if (link && dst && samePath(link, dst)) phase = 'switched';
  else if (m && m.phase === 'partial') phase = 'partial';
  else if (m && m.phase === 'verified' && dst && fs.existsSync(dst)) phase = 'verified';
  else if (m && m.phase) phase = m.phase;

  const olds = [];
  try {
    const parent = path.dirname(s);
    const base = path.basename(s) + '.old-';
    for (const name of fs.readdirSync(parent)) {
      if (name.indexOf(base) !== 0) continue;
      const p = path.join(parent, name);
      let bytes = 0;
      try { bytes = measureSync(p); } catch { bytes = 0; }
      olds.push({ path: p, bytes });
    }
  } catch { /* 源目录读取失败则跳过 */ }

  // 这三种情形要让人一眼看见：原路径被手工删掉、目标不见了、链接悬空。
  let srcExists = false;
  try { fs.lstatSync(s); srcExists = true; } catch { srcExists = false; }
  const dstExists = !!dst && fs.existsSync(dst);
  const linkBroken = !!link && dst !== '' && !dstExists;

  // 登记是否还指着旧路径：这是「搬过去了」与「只是能在新位置读写」的分界线。
  let retarget = null;
  try {
    const p = retargetPlan({ src: s, dst });
    retarget = { needed: p.needed, total: p.total, files: p.files.filter((x) => x.count > 0) };
  } catch { retarget = null; }

  return {
    phase, marker: m, src: s, dst, linkTarget: link || '', olds, script: scriptPaths(),
    srcExists, dstExists, linkBroken, retarget,
    canCleanup: phase === 'switched' && olds.length > 0,
    canRepair: !srcExists && dstExists,
  };
}

function measureSync(dir) {
  let sum = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { try { sum += fs.statSync(p).size; } catch { /* ignore */ } }
    }
  };
  walk(dir);
  return sum;
}

/**
 * 删除一棵目录树：逐项删除，不用递归 rm。
 *
 * Windows 上 fs.rm(recursive) 遇到超长路径（本库 Gradle 中间产物最长 439 字符）会整体报 EPERM；
 * 逐项加 \\?\ 前缀再删则稳定成功。POSIX 上路径无需前缀，同一段代码可用。
 */
export async function rmTree(dir) {
  const target = path.resolve(String(dir || ''));
  const ns = (p) => (process.platform === 'win32' ? '\\\\?\\' + path.resolve(p) : path.resolve(p));
  const fails = [];
  const rmOne = (p, isDir) => {
    for (let i = 0; i < 3; i++) {
      try {
        if (isDir) fs.rmdirSync(ns(p)); else fs.unlinkSync(ns(p));
        return true;
      } catch (e) {
        if (e && e.code === 'ENOENT') return true;
        try { fs.chmodSync(ns(p), 0o666); } catch { /* 只读属性清不掉就再试 */ }
        try { fs.rmSync(ns(p), { force: true, maxRetries: 3, retryDelay: 100 }); return true; } catch { /* 下一轮再试 */ }
        if (i === 2) { fails.push(p + ' :: ' + msgOf(e)); return false; }
      }
    }
    return false;
  };
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(ns(d), { withFileTypes: true }); }
    catch (e) { if (!e || e.code !== 'ENOENT') fails.push(d + ' :: ' + msgOf(e)); return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && !e.isSymbolicLink()) { walk(p); rmOne(p, true); }
      else rmOne(p, false);
    }
  };
  walk(target);
  rmOne(target, true);
  return { ok: fails.length === 0 && !fs.existsSync(ns(target)), target, fails: fails.slice(0, 10) };
}

export async function cleanupOld({ src, confirm } = {}) {
  const st = moveStatus({ src });
  if (st.phase !== 'switched') throw new Error('当前不是已切换状态（phase=' + st.phase + '），拒绝删除任何目录');
  if (confirm !== true) throw new Error('删除旧备份需要明确确认（confirm=true）');
  if (!st.olds.length) return { ok: true, removed: [], bytes: 0, note: '没有找到旧备份目录' };
  const removed = []; const failed = []; let bytes = 0;
  const base = path.basename(st.src) + '.old-';
  for (const o of st.olds) {
    if (path.basename(o.path).indexOf(base) !== 0) continue;
    if (samePath(o.path, st.src) || (st.dst && samePath(o.path, st.dst))) continue;
    let lstat = null;
    try { lstat = fs.lstatSync(o.path); } catch { continue; }
    if (!lstat.isDirectory() || lstat.isSymbolicLink()) continue;
    const del = await rmTree(o.path);
    if (!del.ok) { failed.push({ path: o.path, fails: del.fails }); continue; }
    removed.push(o.path); bytes += o.bytes;
  }
  const m = readMarker();
  if (m && failed.length === 0) { m.phase = 'switched+cleaned'; m.cleanedAt = stampNow(); m.olds = []; writeMarker(m); }
  return {
    ok: failed.length === 0,
    removed, failed, bytes,
    note: failed.length ? ('有 ' + failed.length + ' 个旧备份未删净，可重试')
      : (removed.length ? '已删除旧备份' : '没有可删的旧备份'),
  };
}
