/** 交接漂移（替代 handover_check.mjs）：Δ = 会话当前轮 − 交接写入轮；> slack 即需刷交接。 */
import fs from 'node:fs';
import path from 'node:path';
import { readJsonDir, pick } from './text.mjs';
import { projectOf, projCacheDir, isSubagent } from './sessions.mjs';
import { findLog, decodeLog, turnStarts } from './zstd-log.mjs';

export function computeDrift(opts) {
  const ws = opts.ws;
  const slack = opts.slack === undefined ? 3 : opts.slack;
  const all = opts.all === true;
  const cacheDir = opts.cacheDir || projCacheDir();
  const rows = [];
  const seen = new Map();
  for (const f of readJsonDir(cacheDir)) {
    const proj = projectOf(f.data).project;
    if (!proj || proj === '-' || proj.indexOf('<') !== -1 || proj.indexOf('>') !== -1) continue;
    if (!fs.existsSync(path.join(ws, 'Projects', proj))) continue;
    const sid = f.name.replace('.json', '');
    const turns = Number(pick(f.data, 'record', 'rows', 'sessionStats', 'val', 'turns') || 0);
    rows.push({ sid, project: proj, turns, mtime: f.mtimeMs, kind: isSubagent(f.data) ? '子会话' : '平级' });
  }
  let picked;
  if (all) picked = rows;
  else {
    for (const r of rows) {
      const cur = seen.get(r.project);
      if (!cur || r.mtime > cur.mtime) seen.set(r.project, r);
    }
    picked = Array.from(seen.values());
  }
  const out = [];
  let fresh = 0, need = 0, unknown = 0;
  for (const s of picked.slice().sort((a, b) => b.mtime - a.mtime)) {
    const hand = path.join(ws, '_Project_Meta', s.project, 'Handover.md');
    let hm = 0;
    try { hm = fs.statSync(hand).mtimeMs; } catch { /* 没有交接 */ }
    const log = findLog(s.sid, opts.logsRoot);
    const recs = log ? decodeLog(log) : null;
    let handoverTurn = null;
    if (recs) {
      for (const t of turnStarts(recs)) if (t.time <= hm) handoverTurn = t.turn;
      if (handoverTurn === null) handoverTurn = 0;
    }
    let verdict = '', delta = null;
    if (recs) {
      delta = s.turns - (handoverTurn || 0);
      verdict = delta <= slack ? '已最新' : '需刷交接';
    } else {
      delta = null;
      verdict = hm && s.mtime <= hm ? '已最新（仅时间戳）' : '需人工确认';
    }
    if (verdict === '已最新' || verdict === '已最新（仅时间戳）') fresh++;
    else if (verdict === '需刷交接') need++;
    else unknown++;
    out.push({ project: s.project, kind: s.kind, sid: s.sid, turns: s.turns, handoverTurn, delta, verdict });
  }
  return { rows: out, fresh, need, unknown, slack };
}

export function driftVerdict(res) {
  return '判定：' + res.fresh + ' 个已最新、' + res.need + ' 个需刷交接' +
    (res.unknown ? '、' + res.unknown + ' 个需人工确认' : '') +
    (res.need || res.unknown ? '；先令需刷交接的会话写交接，再迁移' : '；可直接迁移');
}