/** 交接漂移（替代 handover_check.mjs）：Δ = 会话当前轮 − 交接写入轮；超过 slack 即需刷交接。 */
import fs from 'node:fs';
import path from 'node:path';
import { readJsonDir, pick } from './text.mjs';
import { projectOf, projCacheDir, isSubagent } from './sessions.mjs';
import { findLog, decodeLog, decodeLogTail, turnStarts, logsRoot, LOG_NAME_RE } from './zstd-log.mjs';

// brief 与 status 连续调用会重复计算同一份漂移，因此 10 秒内按输入签名复用结果。
const DRIFT_TTL_MS = 10000;
// 尾部解码起始帧数：一帧约含 1 至 2 条事件，32 帧足以覆盖最近一轮的尾部。
const TAIL_START_FRAMES = 32;

let driftCache = { key: '', at: 0, res: null };

function mtimeOf(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return null; }
}

// 全量扫描时需按几十个会话逐个定位日志。
// findLog 每条都要递归扫整棵 sessions 目录，76 个会话就是 76 次全树遍历。
// 因此 60 秒内复用一份「目录名到日志路径」的整树索引。
const LOG_INDEX_TTL_MS = 60000;

let logIndex = { key: null, at: 0, bySid: new Map() };

function indexLogs(base) {
  const map = new Map();
  const walk = (dir, depth) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      const p = path.join(dir, e.name);
      if (!map.has(e.name)) {
        let names = [];
        try { names = fs.readdirSync(p); } catch { names = []; }
        const hit = names.filter((n) => LOG_NAME_RE.test(n));
        const zstd = hit.find((n) => n.endsWith('.zstd'));
        if (zstd || hit.length) map.set(e.name, path.join(p, zstd || hit[0]));
      }
      if (depth < 3) walk(p, depth + 1);
    }
  };
  walk(base, 0);
  return map;
}

function logOf(sid, root) {
  const base = root || logsRoot();
  const now = Date.now();
  if (logIndex.key !== base || now - logIndex.at >= LOG_INDEX_TTL_MS) {
    logIndex = { key: base, at: now, bySid: indexLogs(base) };
  }
  const hit = logIndex.bySid.get(String(sid));
  if (hit && fs.existsSync(hit)) return hit;
  return findLog(sid, root);
}

/**
 * 取「交接时刻之前最后一轮」的轮号，不整份解码：从文件尾部按帧回溯，
 * 找到任一 time <= hm 的 turn/start 即可停（轮次按时间递增，尾部里最后一个满足条件的
 * 就是全局最后一个）。加到文件头仍没有，说明交接早于全部轮次，返回 found:false。
 * @returns {{found:boolean, turn:number}|null} null = 日志读不到
 */
function handoverTurnOf(file, hm) {
  let frames = TAIL_START_FRAMES;
  let prevLen = -1;
  for (;;) {
    const recs = decodeLogTail(file, frames);
    if (!recs) return null;
    let turn = null;
    for (const r of recs) {
      if (!r || r.type !== 'turn/start') continue;
      const t = r.data && typeof r.data.turn === 'number' ? r.data.turn : null;
      if (t === null || typeof r.time !== 'number') continue;
      if (r.time <= hm && (turn === null || t > turn)) turn = t;
    }
    if (turn !== null) return { found: true, turn };
    // 帧数加大后记录数不再变化，说明已回溯到文件头。
    if (recs.length === prevLen) return { found: false, turn: 0 };
    prevLen = recs.length;
    frames *= 4;
  }
}

function cacheKeyOf(all, slack, ws, picked) {
  const sig = picked.map((r) => r.sid + ':' + Math.round(r.mtime)).sort().join(',');
  return String(all) + '|' + String(slack) + '|' + String(ws) + '|' + sig;
}

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
  const cacheKey = cacheKeyOf(all, slack, ws, picked);
  const now = Date.now();
  if (driftCache.key === cacheKey && now - driftCache.at < DRIFT_TTL_MS) return driftCache.res;

  const out = [];
  let fresh = 0, need = 0, unknown = 0;
  for (const s of picked.slice().sort((a, b) => b.mtime - a.mtime)) {
    const hand = path.join(ws, '_Project_Meta', s.project, 'Handover.md');
    const hm = mtimeOf(hand) || 0;
    const log = logOf(s.sid, opts.logsRoot);
    let handoverTurn = null;
    let readable = false;
    if (log) {
      const lm = mtimeOf(log);
      if (hm <= 0) {
        // 没有交接文件：等价于交接轮为 0，不必解码日志。
        readable = true;
        handoverTurn = 0;
      } else if (lm !== null && lm <= hm && s.turns > 0) {
        // 日志比交接旧：之后没有新事件，当前轮就是交接轮，投影缓存里的计数可直接用。
        readable = true;
        handoverTurn = s.turns;
      } else {
        // 只看尾部：拿到「最后一条早于交接的轮首」即可，不整份解码。
        const t = handoverTurnOf(log, hm);
        if (t) {
          readable = true;
          handoverTurn = t.turn;
        } else {
          // 尾部解码失败时退回全量（罕见，保证口径与旧实现一致）。
          const recs = decodeLog(log);
          if (recs) {
            readable = true;
            handoverTurn = 0;
            for (const x of turnStarts(recs)) if (x.time <= hm) handoverTurn = x.turn;
          }
        }
      }
    }
    let verdict = '', delta = null;
    if (readable) {
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
  const res = { rows: out, fresh, need, unknown, slack };
  driftCache = { key: cacheKey, at: Date.now(), res };
  return res;
}

export function driftVerdict(res) {
  return '判定：' + res.fresh + ' 个已最新，' + res.need + ' 个需刷交接' +
    (res.unknown ? '，' + res.unknown + ' 个需人工确认' : '') +
    (res.need || res.unknown ? '。处置：先让需刷交接的会话写交接，再迁移。' : '。处置：可直接迁移。');
}
