/**
 * 在任登记表（office）：回答「这条类别现在谁在任」。
 *
 * 记录保存在 <工作区根>/_Control_Center/records/Office.json：每一类会话（全局／项目名／杂项任务名）
 * 记一个在任会话与历史编号。Registry.md 的「在役会话」列由本文件定点改写——只换那一格，
 * 不动人写的状态文字与整表结构。编号由这里分配（历史最大号 + 1），不采信会话自述。
 */
import fs from 'node:fs';
import path from 'node:path';
import { NL, readUtf8 } from './text.mjs';

export const OFFICE_VERSION = 1;

/** 带时区偏移的时刻文本（与交接、登记表同一写法）。 */
export function stampNow() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate())
    + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ' +0800';
}

export const KIND_LABEL = { global: '全局', project: '项目', misc: '杂项' };

export function officePath(ws) {
  return path.join(String(ws || ''), '_Control_Center', 'records', 'Office.json');
}

export function loadOffice(ws) {
  let v = null;
  try { v = JSON.parse(readUtf8(officePath(ws)).replace(/^\uFEFF/, '')); } catch { v = null; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) v = {};
  if (!v.lineages || typeof v.lineages !== 'object' || Array.isArray(v.lineages)) v.lineages = {};
  v.version = OFFICE_VERSION;
  return v;
}

/** 原子写：临时文件 + rename，半截文件不会被下一次读当成事实。 */
export function saveOffice(ws, store) {
  const p = officePath(ws);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  store.version = OFFICE_VERSION;
  store.updatedAt = stampNow();
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + NL, 'utf8');
  fs.renameSync(tmp, p);
  return p;
}

/** 类别名：全局固定「全局」，项目用项目名，杂项用任务名。 */
export function lineageKeyOf(kind, project, task) {
  if (kind === 'global') return '全局';
  if (kind === 'project') return String(project || '').trim();
  if (kind === 'misc') return String(task || '').trim();
  return '';
}

const GEN_RE = /^(.*\D)(\d+)$/;

/** 名字去掉尾部代际：全局11 → 全局；没有数字返回空串。 */
export function baseOf(name) {
  const m = GEN_RE.exec(String(name || '').trim());
  return m ? m[1] : '';
}

/** 名字里的代际号：全局11 → 11；没有数字返回 null。 */
export function generationOf(name) {
  const m = GEN_RE.exec(String(name || '').trim());
  return m ? Number(m[2]) : null;
}

/** 下一编号：该类别历史上出现过的最大号 + 1；没有历史就从 1 起算。 */
export function nextName(store, key) {
  const lin = store && store.lineages ? store.lineages[key] : null;
  const names = [];
  if (lin && lin.current && lin.current.name) names.push(lin.current.name);
  for (const h of (lin && Array.isArray(lin.history) ? lin.history : [])) {
    if (h && h.name) names.push(h.name);
  }
  let max = 0;
  for (const n of names) {
    const g = generationOf(n);
    if (g !== null && g > max) max = g;
  }
  return String(key) + String(max + 1);
}

/**
 * 名字 → 类别。用户给的多半是不确定的名字（全局3、全局、Mingent、赢了两次的旧叫法），
 * 按「类别名精确 → 去尾部编号 → 现任名 → 唯一子串」四步收敛；收敛不了就报候选，不瞎猜。
 */
export function resolveOffice(store, query) {
  const q = String(query || '').trim();
  if (!q) return { ok: false, reason: '空查询' };
  const keys = Object.keys((store && store.lineages) || {});
  const lower = q.toLowerCase();
  let key = '';
  let via = '';
  const exact = keys.filter((k) => k.toLowerCase() === lower);
  if (exact.length === 1) { key = exact[0]; via = 'exact'; }
  if (!key) {
    const base = baseOf(q);
    if (base) {
      const hit = keys.filter((k) => k.toLowerCase() === base.toLowerCase());
      if (hit.length === 1) { key = hit[0]; via = 'generation'; }
    }
  }
  if (!key) {
    const hit = keys.filter((k) => {
      const cur = store.lineages[k] && store.lineages[k].current;
      return cur && cur.name && String(cur.name).toLowerCase() === lower;
    });
    if (hit.length === 1) { key = hit[0]; via = 'current'; }
  }
  if (!key) {
    const hit = keys.filter((k) => {
      const a = k.toLowerCase();
      return a.indexOf(lower) !== -1 || lower.indexOf(a) !== -1;
    });
    if (hit.length === 1) { key = hit[0]; via = 'fuzzy'; }
    else if (hit.length > 1) return { ok: false, reason: '与多个类别相近：' + hit.join('、') + '（请写全名）', candidates: hit };
  }
  if (!key) return { ok: false, reason: '没有名为「' + q + '」的全局、项目或杂项任务' };
  const lin = store.lineages[key];
  const cur = lin && lin.current;
  if (!cur || !cur.name) return { ok: true, key, lineage: lin, via, vacant: true };
  return { ok: true, key, lineage: lin, via, vacant: false };
}

export function rowsOf(store) {
  const lines = (store && store.lineages) || {};
  return Object.keys(lines).map((key) => {
    const lin = lines[key] || {};
    return {
      key,
      kind: String(lin.kind || ''),
      project: String(lin.project || ''),
      task: String(lin.task || ''),
      workspace: String(lin.workspace || ''),
      current: lin.current || null,
    };
  }).sort((a, b) => {
    const order = { global: 0, project: 1, misc: 2 };
    const d = (order[a.kind] === undefined ? 9 : order[a.kind]) - (order[b.kind] === undefined ? 9 : order[b.kind]);
    return d !== 0 ? d : a.key.localeCompare(b.key, 'zh');
  });
}

/** 一行人类可读：名字、会话 id、类别、（提到旧编号时的来处）。 */
export function formatRow(row, askedAs) {
  const cur = row && row.current;
  if (!cur || !cur.name) return (row && row.key ? row.key : '?') + '  — 当前空缺';
  const label = KIND_LABEL[row.kind] || row.kind || '-';
  // 只有「拿旧编号问现任」时才加来处标注；直接问类别名或现任名就不必重复。
  const tail = askedAs && askedAs !== cur.name && askedAs !== row.key ? '（' + askedAs + ' → ' + row.key + '）' : '';
  return cur.name + '  ' + cur.sessionId + '  ' + label + (cur.since ? '  自 ' + cur.since : '') + tail;
}

/** 登记一位在任者：原在任者进历史，写盘后同步 Registry.md。 */
export function registerHolder(ws, opts) {
  const o = opts || {};
  const key = lineageKeyOf(o.kind, o.project, o.task);
  if (!key) throw new Error('类别名缺失：全局用 kind=global，项目给 project，杂项给 task');
  const store = loadOffice(ws);
  const lin = store.lineages[key] || (store.lineages[key] = {
    kind: o.kind, project: String(o.project || ''), task: String(o.task || ''),
    workspace: String(o.workspace || ''), current: null, history: [],
  });
  if (!Array.isArray(lin.history)) lin.history = [];
  const previous = lin.current && lin.current.name ? { ...lin.current } : null;
  if (previous) {
    lin.history.push({
      name: previous.name, sessionId: previous.sessionId,
      from: previous.since || '', to: stampNow(), note: previous.note || '',
    });
  }
  lin.kind = o.kind;
  if (o.project) lin.project = String(o.project);
  if (o.task) lin.task = String(o.task);
  if (o.workspace) lin.workspace = String(o.workspace);
  lin.current = { name: String(o.name || ''), sessionId: String(o.sessionId || ''), since: stampNow(), note: String(o.note || '') };
  if (!lin.current.name || !lin.current.sessionId) throw new Error('在任登记需要 name 与 sessionId');
  saveOffice(ws, store);
  let registry = { changed: [], error: '' };
  try { registry = syncRegistry(ws, store); } catch (e) { registry = { changed: [], error: String(e && e.message ? e.message : e) }; }
  return { key, previous, current: lin.current, registry };
}

/** 类别当前空缺（会话退役、项目暂停）。 */
export function retireHolder(ws, key, note) {
  const store = loadOffice(ws);
  const lin = store.lineages[String(key || '')];
  if (!lin) throw new Error('没有这条类别：' + key);
  const previous = lin.current && lin.current.name ? { ...lin.current } : null;
  if (previous) {
    lin.history.push({ name: previous.name, sessionId: previous.sessionId, from: previous.since || '', to: stampNow(), note: note || previous.note || '' });
  }
  lin.current = null;
  saveOffice(ws, store);
  let registry = { changed: [], error: '' };
  try { registry = syncRegistry(ws, store); } catch (e) { registry = { changed: [], error: String(e && e.message ? e.message : e) }; }
  return { key, previous, registry };
}

// ---------------------------------------------------------------- Registry.md 定点同步

function splitCells(line) {
  // "| a | b |" → ['', ' a ', ' b ', '']；保持两端空格原样，便于回写。
  return line.split('|');
}

function tailOf(cell) {
  const m = /（[^（）]*）\s*$/.exec(cell) || /\([^()]*\)\s*$/.exec(cell);
  return m ? ' ' + m[0].trim() : '';
}

function currentCellFor(row, withName) {
  const cur = row.current;
  if (!cur || !cur.name) return null;
  return withName ? cur.name + ' `' + cur.sessionId + '`' : '`' + cur.sessionId + '`';
}

/**
 * 把 Registry.md 里的「在役会话」格改成登记表里的现任。
 * 只认两张表（项目清单、未登记但存在的任务），只换那一格；其它文字一律不动。
 */
export function syncRegistry(ws, store) {
  const file = path.join(String(ws || ''), '_Project_Meta', 'Registry.md');
  let text = '';
  try { text = readUtf8(file); } catch { return { changed: [], error: '读不到 Registry.md' }; }
  const bom = text.charCodeAt(0) === 0xFEFF ? '\uFEFF' : '';
  if (bom) text = text.slice(1);
  const lines = text.split(NL);
  const changed = [];
  let mode = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('## ')) {
      if (line.indexOf('项目清单') !== -1) mode = 'project';
      else if (line.indexOf('未登记但存在的任务') !== -1) mode = 'misc';
      else mode = '';
      continue;
    }
    if (!mode || !line.startsWith('|')) continue;
    const cells = splitCells(line);
    // 表头与分隔行跳过
    if (cells.length < 4) continue;
    const name = String(cells[1] || '').trim();
    if (!name || name === '项目名' || name === '任务短名' || /^-+$/.test(name)) continue;
    const row = rowsOf(store).find((r) => r.key === name);
    if (!row) continue;
    if (mode === 'project') {
      if (cells.length < 9) continue; // 8 列 + 首尾空
      const old = String(cells[6] || '');
      const next = currentCellFor(row, true);
      if (!next) continue;
      const want = ' ' + next + tailOf(old) + ' ';
      if (old === want) continue;
      cells[6] = want;
    } else {
      if (cells.length < 5) continue; // 4 列 + 首尾空
      const next = currentCellFor(row, false);
      if (!next) continue;
      const want = ' ' + next + tailOf(String(cells[3] || '')) + ' ';
      if (String(cells[3] || '') === want) continue;
      cells[3] = want;
    }
    lines[i] = cells.join('|');
    changed.push(name);
  }
  if (changed.length) fs.writeFileSync(file, bom + lines.join(NL), 'utf8');
  return { changed, error: '' };
}
