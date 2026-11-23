/** 会话清点：只读投影缓存，不激活任何会话、不消耗 token。 */
import os from 'node:os';
import path from 'node:path';
import { readJsonDir, readJsonFileLazy, pick, isSafeName } from './text.mjs';
import { bandsFor } from './pressure.mjs';

export function projCacheDir() {
  return path.join(os.homedir(), '.dsh', 'storages', 'session_projcache', 'sessions');
}

/** 从投影缓存数据取水位：返回 { used, win }，读不到为 null。 */
export function readPressure(data) {
  const used = pick(data, 'record', 'rows', 'contextPressure', 'val', 'pressureTokens');
  const win = pick(data, 'record', 'rows', 'contextPressure', 'val', 'contextWindow');
  return {
    used: typeof used === 'number' && Number.isFinite(used) ? used : null,
    win: typeof win === 'number' && Number.isFinite(win) ? win : null,
  };
}

export function pressurePct(data) {
  const p = readPressure(data);
  if (!p.used || !p.win) return null;
  return (p.used / p.win) * 100;
}

export function isSubagent(data) {
  return pick(data, 'record', 'rows', 'subagent', 'val', 'identity') !== null;
}

function isBlank(data) {
  return pick(data, 'record', 'rows', 'sessionListMetadata', 'val', 'blank') === true;
}

export function isBusy(data) {
  return pick(data, 'record', 'rows', 'sessionStats', 'val', 'openStep') !== null;
}

/**
 * 会话最近活动时刻（epoch 毫秒）：与 DSH 侧栏口径一致，取会话摘要里的最后提示时刻。
 * 投影缓存文件的 mtime 会在批量迁移或重建缓存时被统一改写，不能当作活动时间。
 * 读不到时退回文件 mtime。
 */
function activityMsOf(data, fallback) {
  const lastPrompt = pick(data, 'record', 'rows', 'sessionListMetadata', 'val', 'lastPromptAt');
  const lastMessage = pick(data, 'record', 'rows', 'timeContext', 'val', 'lastMessageTime');
  let max = Number(fallback) || 0;
  for (const v of [lastPrompt, lastMessage]) {
    if (typeof v === 'number' && v > max) max = v;
  }
  return max;
}

function cwdOf(data) {
  return pick(data, 'record', 'identity', 'cwd');
}

/**
 * 名字要当目录名用：统一走 text.mjs 的跨平台校验。
 * 返回 { project, real }：优先看 cwd 里的 Projects/<名>/，退回首条提示里的 Projects/<名>/ 或「<名>」项目。
 */
export function projectOf(data) {
  // 先认路径：首条提示是自然语言时解析不出项目名，会被整行过滤。
  // 不先认路径，在任判定就可能落到已交出的旧会话上。
  // cwd 由宿主写入，最可靠。
  const raw = String(cwdOf(data) || '').replace(/\\/g, '/');
  // 插件约定的项目目录固定叫 `Projects`。Windows/macOS 文件系统默认不区分大小写，按折叠匹配；
  // Linux 区分大小写，只认 `Projects`，否则用户自建的 `/home/x/projects/...` 会被误判成项目库。
  const folded = process.platform === 'win32' || process.platform === 'darwin';
  const ci = folded ? raw.toLowerCase().indexOf('/projects/') : raw.indexOf('/Projects/');
  if (ci !== -1) {
    const name = raw.slice(ci + '/Projects/'.length).split('/')[0];
    if (isSafeName(name)) return { project: name, real: true };
  }
  const text = pick(data, 'record', 'rows', 'titleInput', 'val', 'first', 'text') || '';
  const i = text.indexOf('Projects/');
  if (i !== -1) {
    const rest = text.slice(i + 'Projects/'.length);
    let name = "";
    let bad = false;
    for (const ch of rest) {
      if (ch === '/') break;
      if (ch === " " || ch === String.fromCharCode(9) || ch === String.fromCharCode(10) || ch === String.fromCharCode(13)) { bad = true; break; }
      name += ch;
    }
    // 首条提示常带 Markdown 通配写法（`Projects/**`），解析出的名字必须过名称校验才算项目。
    if (!bad && isSafeName(name)) return { project: name, real: true };
  }
  const q = text.indexOf(String.fromCharCode(12300));
  if (q !== -1) {
    const rest = text.slice(q + 1);
    const j = rest.indexOf(String.fromCharCode(12301) + '项目');
    if (j > 0) {
      const name = rest.slice(0, j);
      if (isSafeName(name)) return { project: name, real: true };
    }
  }
  const title = pick(data, 'record', 'rows', 'title', 'val');
  return { project: (typeof title === 'string' && title.trim() !== '') ? title : '-', real: false };
}

/** 该会话的投影缓存候选名：带前缀与不带前缀的 2 种写法都认。 */
function stemsOf(sid) {
  const id = String(sid || '');
  if (!id) return [];
  const bare = id.indexOf('session-') === 0 ? id.slice(8) : id;
  const out = [];
  for (const n of [id, 'session-' + bare]) {
    if (n && out.indexOf(n) === -1) out.push(n);
  }
  return out;
}

/** 单文件直读该会话的投影缓存；读不到返回 null（不遍历目录）。 */
export function projCacheFileOf(sid, dir) {
  const stems = stemsOf(sid);
  if (!stems.length) return null;
  return readJsonFileLazy(dir || projCacheDir(), stems);
}

// 同一 step 内会被读多次（状态计算、逐回合提醒、诊断），500ms 内复用同一个结果。
const SELF_TTL_MS = 500;
const SELF_MAX = 64;
const selfCache = new Map();

/** 读本会话的 pressureTokens / contextWindow：返回 { used, win }（读不到为 null）。 */
export function readSelfPressure(dir, meId) {
  if (!meId) return { used: null, win: null };
  const base = String(dir || projCacheDir());
  const key = base + String.fromCharCode(0) + String(meId);
  const now = Date.now();
  const hit = selfCache.get(key);
  if (hit && now - hit.at < SELF_TTL_MS) return { used: hit.used, win: hit.win };

  const one = projCacheFileOf(meId, base);
  let p = { used: null, win: null };
  if (one) {
    p = readPressure(one.data);
  } else {
    // 回退：文件名可能与会话 id 不是一一对应（旧缓存），按原口径全目录扫一次。
    const target = meId.indexOf('session-') === 0 ? meId : 'session-' + meId;
    for (const f of readJsonDir(base)) {
      const stem = f.name.replace('.json', '');
      if (stem !== target && stem !== meId) continue;
      p = readPressure(f.data);
      break;
    }
  }
  selfCache.delete(key);
  selfCache.set(key, { at: Date.now(), used: p.used, win: p.win });
  while (selfCache.size > SELF_MAX) selfCache.delete(selfCache.keys().next().value);
  return p;
}

/**
 * 扫描投影缓存，得到会话清点结果。
 * 每个项目只把最近活跃的 1 行放进 notify，其余放进 skip。同一项目只提醒一次，避免逐会话重复提醒。
 * @param {object} opts dir、silentHours、meId、meCwd、cfg、projectsOnly
 * @returns {{rows:object[], cutoffMs:number, hot:string[], unknown:string[], notify:object[], skip:object[]}}
 */
export function scanSessions(opts) {
  const dir = opts.dir || projCacheDir();
  const cfg = opts.cfg || {};
  const silentHours = opts.silentHours === undefined ? 12 : opts.silentHours;
  const nowMs = opts.nowMs || Date.now();
  const meId = opts.meId || null;
  const meCwd = opts.meCwd || null;
  const projectsOnly = opts.projectsOnly !== false;
  const cutoffMs = nowMs - silentHours * 3600 * 1000;
  const rows = [];
  for (const f of readJsonDir(dir)) {
    const sid = f.name.replace('.json', '');
    if (meId && (sid === meId || (sid.indexOf("session-") === 0 && sid.slice(8) === meId))) continue;
    if (!f.data || isBlank(f.data)) continue;
    const cwd = cwdOf(f.data);
    const pj = projectOf(f.data);
    const isProject = pj.real && isSafeName(pj.project);
    if (projectsOnly && !isProject) continue;
    if (meCwd && cwd && cwd !== meCwd && !isProject) continue;
    const p = readPressure(f.data);
    rows.push({
      sid,
      kind: isSubagent(f.data) ? '子会话' : '平级',
      project: pj.project,
      pct: p.used && p.win ? (p.used / p.win) * 100 : null,
      used: p.used,
      win: p.win,
      state: isBusy(f.data) ? 'running' : 'idle',
      mtime: activityMsOf(f.data, f.mtimeMs),
    });
  }
  rows.sort((a, b) => {
    if ((a.pct === null) !== (b.pct === null)) return a.pct === null ? 1 : -1;
    if ((b.pct || 0) !== (a.pct || 0)) return (b.pct || 0) - (a.pct || 0);
    return b.mtime - a.mtime;
  });
  const hot = [];
  const unknown = [];
  for (const r of rows) {
    if (r.used === null) unknown.push(r.sid);
    else if (r.win) {
      const bands = bandsFor(cfg, r.win);
      if (bands !== null && r.used >= bands.soft) hot.push(r.sid);
    }
  }
  const pool = rows.filter((r) => r.kind === "平级" && r.project !== null && r.project !== "-");
  const byProject = new Map();
  for (const r of pool) {
    if (!byProject.has(r.project)) byProject.set(r.project, []);
    byProject.get(r.project).push(r);
  }
  const notify = [];
  const skip = [];
  for (const name of Array.from(byProject.keys()).sort()) {
    const rs = byProject.get(name).slice().sort((a, b) => b.mtime - a.mtime);
    if (rs[0].mtime >= cutoffMs) { notify.push(rs[0]); skip.push(...rs.slice(1)); }
    else skip.push(...rs);
  }
  return { rows, cutoffMs, hot, unknown, notify, skip, silentHours, nowMs, dir };
}