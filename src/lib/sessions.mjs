/** 会话清点：只读投影缓存，不激活任何会话、不消耗 token。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJsonDir, pick, isSafeName } from './text.mjs';

export function projCacheDir() {
  return path.join(os.homedir(), '.dsh', 'storages', 'session_projcache', 'sessions');
}

export function pressurePct(data) {
  const used = pick(data, 'record', 'rows', 'contextPressure', 'val', 'pressureTokens');
  const win = pick(data, 'record', 'rows', 'contextPressure', 'val', 'contextWindow');
  if (!used || !win) return null;
  return (used / win) * 100;
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

/** 名字要当目录名用：统一走 text.mjs 的跨平台校验。 */
function isPlausible(name) {
  return isSafeName(name);
}

/** 返回 { project, real }：优先看 cwd 里的 Projects/<名>/，退回首条提示里的 Projects/<名>/ 或 「<名>」项目。 */
export function projectOf(data) {
  // 先认路径：首条提示是自然语言的会话解析不出项目名，会被整行过滤，在任判定就可能落到已交出的旧会话身上。
  // cwd 由宿主写入，最可靠。
  const raw = String(cwdOf(data) || '').replace(/\\/g, '/');
  const ci = raw.toLowerCase().indexOf('/projects/');
  if (ci !== -1) {
    const name = raw.slice(ci + '/projects/'.length).split('/')[0];
    if (isPlausible(name)) return { project: name, real: true };
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
    if (!bad && isPlausible(name)) return { project: name, real: true };
  }
  const q = text.indexOf(String.fromCharCode(12300));
  if (q !== -1) {
    const rest = text.slice(q + 1);
    const j = rest.indexOf(String.fromCharCode(12301) + '项目');
    if (j > 0) {
      const name = rest.slice(0, j);
      if (isPlausible(name)) return { project: name, real: true };
    }
  }
  const title = pick(data, 'record', 'rows', 'title', 'val');
  return { project: (typeof title === 'string' && title.trim() !== '') ? title : '-', real: false };
}

/** 读本会话的 pressureTokens / contextWindow：返回 { used, win }（读不到为 null）。 */
export function readSelfPressure(dir, meId) {
  if (!meId) return { used: null, win: null };
  const target = meId.indexOf('session-') === 0 ? meId : 'session-' + meId;
  for (const f of readJsonDir(dir || projCacheDir())) {
    const stem = f.name.replace('.json', '');
    if (stem !== target && stem !== meId) continue;
    const used = pick(f.data, 'record', 'rows', 'contextPressure', 'val', 'pressureTokens');
    const win = pick(f.data, 'record', 'rows', 'contextPressure', 'val', 'contextWindow');
    return { used: used === null ? null : used, win: win === null ? null : win };
  }
  return { used: null, win: null };
}

/** 只读一个会话的投影缓存文件，返回水位百分比；读不到返回 null。供逐回合提醒使用。 */
export function readSessionPressurePct(sessionId) {
  const sid = String(sessionId || '');
  if (!sid) return null;
  const dir = projCacheDir();
  const bare = sid.indexOf('session-') === 0 ? sid.slice(8) : sid;
  const names = [];
  for (const n of [sid, bare]) {
    if (n && names.indexOf(n) === -1) names.push(n);
  }
  for (const stem of names) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, stem + '.json'), 'utf8'));
      const used = pick(data, 'record', 'rows', 'contextPressure', 'val', 'pressureTokens');
      const win = pick(data, 'record', 'rows', 'contextPressure', 'val', 'contextWindow');
      if (!used || !win) return null;
      return (used / win) * 100;
    } catch { /* 试下一个文件名 */ }
  }
  return null;
}

/** 扫描：返回 { rows, cutoff, hot, unknown, notify, skip }。 */
export function scanSessions(opts) {
  const dir = opts.dir || projCacheDir();
  const warn = opts.warn === undefined ? 35 : opts.warn;
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
    const isProject = pj.real && isPlausible(pj.project);
    if (projectsOnly && !isProject) continue;
    if (meCwd && cwd && cwd !== meCwd && !isProject) continue;
    rows.push({
      sid,
      kind: isSubagent(f.data) ? '子会话' : '平级',
      project: pj.project,
      pct: pressurePct(f.data),
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
    if (r.pct === null) unknown.push(r.sid);
    else if (r.pct >= warn) hot.push(r.sid);
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
  return { rows, cutoffMs, hot, unknown, notify, skip, warn, silentHours, nowMs, dir };
}