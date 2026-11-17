/**
 * 会话级运行数据：统一落在会话目录内 `<会话目录>/dsh-handover/`。
 *
 * 放置理由：会话目录由宿主与用户整目录删除，产物随会话一起消失，且不依赖插件
 * 是否加载、是否运行。宿主只按 `session.vN.jsonl[.zstd]` 文件名识别会话，子目录
 * 不会被当作会话，也不参与损坏判定。
 *
 * 读不到会话目录时（会话尚未落盘或日志被移走），产物暂存插件自有目录
 * `~/.dsh/storages/dsh-handover.staging/<sid>/`；会话目录出现后整体迁入。
 * 绝不写宿主的会话日志文件。
 *
 * 读写都以进程内缓存为准：命中时只做一次 stat 校验，未变化不重复解析、不重复写盘。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findLog } from './zstd-log.mjs';
import { writeFileAtomic } from './text.mjs';

const STORE_DIR_NAME = 'dsh-handover';
const STATE_FILE_NAME = 'state.json';
const STAGING_DIR_NAME = 'dsh-handover.staging';

/** 暂存位置：会话目录未就绪时的临时落点；会话目录出现后迁入。 */
function stagingDirFor(sid) {
  return path.join(os.homedir(), '.dsh', 'storages', STAGING_DIR_NAME, String(sid || 'unknown'));
}

/** 会话目录：与宿主的会话日志同目录；找不到日志时返回空串。force 为 true 时跳过缓存重探。 */
const dirCache = new Map();   // sid → { dir, at }；命中即长期复用，未命中 5 秒后重试
function sessionDirFor(sid, force) {
  const id = String(sid || '');
  if (!id) return '';
  const hit = dirCache.get(id);
  if (force !== true && hit && (hit.dir || Date.now() - hit.at < 5000)) return hit.dir;
  const log = findLog(id);
  const dir = log ? path.dirname(log) : '';
  dirCache.set(id, { dir, at: Date.now() });
  return dir;
}

/**
 * 存储位置：优先会话目录内 `<会话目录>\dsh-handover\`，未就绪时用暂存目录。
 * @returns {{dir:string, staged:boolean, sessionDir:string}}
 */
export function storeLocation(sid, force) {
  const sessionDir = sessionDirFor(sid, force === true);
  if (sessionDir) {
    return { dir: path.join(sessionDir, STORE_DIR_NAME), staged: false, sessionDir };
  }
  return { dir: stagingDirFor(sid), staged: true, sessionDir: '' };
}

/** 兼容旧调用：直接取目录。 */
export function storeDirFor(sid) {
  return storeLocation(sid).dir;
}

/** 本进程内曾写过暂存目录的会话：用于判断是否需要尝试迁入。 */
const stagedSids = new Set();
/** 已确认过暂存目录是否存在的会话：每个会话每个进程只查一次。 */
const stagedChecked = new Set();

function moveFile(src, dst) {
  try { fs.renameSync(src, dst); return true; }
  catch {
    try { fs.copyFileSync(src, dst); fs.unlinkSync(src); return true; } catch { return false; }
  }
}

/**
 * 把暂存目录里的产物迁入会话目录；同名文件保留会话目录内的版本。
 * @returns {string[]} 已迁入的文件名
 */
function promoteStaged(sid, targetDir) {
  if (!stagedSids.has(sid)) {
    if (stagedChecked.has(sid)) return [];
    stagedChecked.add(sid);
    if (!fs.existsSync(stagingDirFor(sid))) return [];
  }
  const from = stagingDirFor(sid);
  let names = [];
  try { names = fs.readdirSync(from); } catch { return []; }
  const moved = [];
  for (const name of names) {
    const src = path.join(from, name);
    try { if (!fs.statSync(src).isFile()) continue; } catch { continue; }
    const dst = path.join(targetDir, name);
    if (fs.existsSync(dst)) continue;
    try { fs.mkdirSync(targetDir, { recursive: true }); } catch { continue; }
    if (moveFile(src, dst)) moved.push(name);
  }
  if (moved.length) {
    try { if (fs.readdirSync(from).length === 0) fs.rmdirSync(from); } catch { /* 目录非空或占用时保留 */ }
    stagedSids.delete(sid);
  }
  return moved;
}

function emptyState(sid) {
  return {
    version: 1,
    sid: String(sid || ''),
    createdAt: Date.now(),
    notified: {},
    lastTierPromptAt: 0,
    lastWaterAt: 0,
    compactions: 0,
    skipTierOnce: false,
    succession: { promptedCount: 0, promptedAt: 0 },
    handoverFlow: {},
    pendingMessages: [],
    backfill: {},
    usageHistory: [],
    updatedAt: Date.now(),
  };
}

function normalize(sid, raw, createdAtFallback) {
  const base = emptyState(sid);
  if (!raw || typeof raw !== 'object') return base;
  const out = Object.assign(base, raw);
  out.sid = String(sid || '');
  out.notified = raw.notified && typeof raw.notified === 'object' ? raw.notified : {};
  out.succession = raw.succession && typeof raw.succession === 'object'
    ? Object.assign({ promptedCount: 0, promptedAt: 0 }, raw.succession)
    : { promptedCount: 0, promptedAt: 0 };
  out.handoverFlow = raw.handoverFlow && typeof raw.handoverFlow === 'object' ? raw.handoverFlow : {};
  out.pendingMessages = Array.isArray(raw.pendingMessages) ? raw.pendingMessages : [];
  out.backfill = raw.backfill && typeof raw.backfill === 'object' ? raw.backfill : {};
  out.usageHistory = Array.isArray(raw.usageHistory)
    ? raw.usageHistory
      .filter((x) => x && typeof x === 'object' && Number.isFinite(x.at) && Number.isFinite(x.used))
      .slice(-6)
      .map((x) => ({ at: x.at, used: x.used }))
    : [];
  out.createdAt = typeof raw.createdAt === 'number'
    ? raw.createdAt
    : (Number.isFinite(createdAtFallback) && createdAtFallback ? createdAtFallback : Date.now());
  out.compactions = Number.isFinite(raw.compactions) ? raw.compactions : 0;
  out.lastTierPromptAt = Number.isFinite(raw.lastTierPromptAt) ? raw.lastTierPromptAt : 0;
  out.lastWaterAt = Number.isFinite(raw.lastWaterAt) ? raw.lastWaterAt : 0;
  out.skipTierOnce = raw.skipTierOnce === true;
  return out;
}

/** 进程内状态缓存：sid → { file, sig, text, state }。 */
const stateCache = new Map();

function fileSig(file) {
  try {
    const st = fs.statSync(file);
    return String(st.mtimeMs) + ':' + String(st.size);
  } catch { return ''; }
}

function cloneState(state) {
  try { return structuredClone(state); } catch { return JSON.parse(JSON.stringify(state)); }
}

/** 读状态：缓存命中且文件未变化时直接返回副本；都不存在时返回空状态。 */
export function readSessionState(sid) {
  const id = String(sid || '');
  if (!id) return emptyState('');
  const loc = storeLocation(id, stagedSids.has(id));
  if (!loc.staged) promoteStaged(id, loc.dir);
  const file = path.join(loc.dir, STATE_FILE_NAME);
  const sig = fileSig(file);
  if (!sig) {
    stateCache.delete(id);
    return emptyState(id);
  }
  const hit = stateCache.get(id);
  if (hit && hit.file === file && hit.sig === sig) return cloneState(hit.state);
  let text = '';
  try { text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''); } catch { return emptyState(id); }
  let state = null;
  try { state = normalize(id, JSON.parse(text)); } catch { state = null; }
  if (!state) return emptyState(id);
  const serialized = JSON.stringify(state);
  stateCache.set(id, { file, sig, text: serialized, state: cloneState(state) });
  return state;
}

/**
 * 写状态：落到会话目录内；内容未变化时不写盘。暂存数据在会话目录就绪后迁入。
 * @returns {{path:string, staged:boolean, written:boolean, promoted:string[]}}
 */
export function writeSessionState(sid, state, logger) {
  const id = String(sid || '');
  if (!id) throw new Error('状态缺少会话 id');
  const loc = storeLocation(id, stagedSids.has(id));
  let promoted = [];
  if (loc.staged) {
    stagedSids.add(id);
    if (typeof logger === 'function') logger('会话目录未找到，会话产物暂存：' + id);
  } else {
    promoted = promoteStaged(id, loc.dir);
    if (promoted.length && typeof logger === 'function') {
      logger('会话产物已迁入会话目录：' + id + '（' + promoted.join('、') + '）');
    }
  }
  const file = path.join(loc.dir, STATE_FILE_NAME);
  const hit = stateCache.get(id);
  const next = normalize(id, state, hit && hit.file === file ? hit.state.createdAt : 0);
  if (hit && hit.file === file && hit.sig === fileSig(file)) {
    const probe = Object.assign({}, next, { updatedAt: hit.state.updatedAt });
    if (JSON.stringify(probe) === hit.text) {
      return { path: file, staged: loc.staged, written: false, promoted };
    }
  }
  next.updatedAt = Date.now();
  const text = JSON.stringify(next);
  writeFileAtomic(file, text + String.fromCharCode(10));
  stateCache.set(id, { file, sig: fileSig(file), text, state: cloneState(next) });
  return { path: file, staged: loc.staged, written: true, promoted };
}

/** 供诊断与测试：位置、暂存目录是否存在、产物文件清单。 */
export function storeInfo(sid) {
  const loc = storeLocation(sid);
  let files = [];
  try { files = fs.readdirSync(loc.dir).filter((n) => fs.statSync(path.join(loc.dir, n)).isFile()).sort(); } catch { files = []; }
  return {
    dir: loc.dir,
    staged: loc.staged,
    sessionDir: loc.sessionDir,
    stagingDir: stagingDirFor(sid),
    stagingExists: fs.existsSync(stagingDirFor(sid)),
    files,
  };
}
