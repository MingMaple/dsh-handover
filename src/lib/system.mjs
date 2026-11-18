/**
 * 体系注册与文档定位（1.0）：每个任务一份注册文件，写目录结构、规范文件与计划；
 * 全局总注册只列各任务体系文件的路径，不承载正文。
 *
 * 路径约定：
 * - 全局总注册：_Control_Center/records/systems.md
 * - 项目：_Project_Meta/<项目>/System.md
 * - 杂项：_Misc/tasks/<任务>/System.md
 * - 全局任务：_Control_Center/tasks/<任务>/System.md
 *
 * 定位：注册只给路径与用途，是否读正文由会话判断；空注册不注入正文，只注入一句提示。
 */
import fs from 'node:fs';
import path from 'node:path';
import { NL, readUtf8, isFile, isDir, writeFileAtomic } from './text.mjs';
import { readProfile } from './profile.mjs';

export const GLOBAL_REGISTRY_REL = path.join('_Control_Center', 'records', 'systems.md');
export const REGISTRY_NAME = 'System.md';

const TICK = String.fromCharCode(96);

export function lineageOf(info) {
  const role = info && info.role ? info.role : '';
  if (role === 'global') return { kind: 'global', project: '', task: '', key: '全局' };
  if (role === 'project' && info.project) return { kind: 'project', project: String(info.project), task: '', key: String(info.project) };
  if (role === 'misc' && info.task) return { kind: 'misc', project: '', task: String(info.task), key: String(info.task) };
  if (role === 'global-task' && info.task) return { kind: 'global-task', project: '', task: String(info.task), key: String(info.task) };
  return null;
}

export function lineageLabel(info) {
  const lin = lineageOf(info);
  if (!lin) return '';
  if (lin.kind === 'project') return '项目「' + lin.project + '」';
  if (lin.kind === 'misc') return '杂项任务「' + lin.task + '」';
  if (lin.kind === 'global-task') return '全局任务「' + lin.task + '」';
  return '全局';
}

/** 任务库根（相对工作区）。项目优先取骨架档案登记的根，其次 `<项目>库`，最后项目目录。 */
function taskRoot(ws, info) {
  const lin = lineageOf(info);
  if (!lin) return '';
  if (lin.kind === 'project') {
    const p = lin.project;
    try {
      const pf = readProfile(ws, { role: 'project', project: p });
      if (pf && pf.exists && pf.profile && pf.profile.root) return String(pf.profile.root);
    } catch { /* 骨架读不到时按目录规则推断 */ }
    const lib = path.join('Projects', p, p + '库');
    return isDir(path.join(String(ws || ''), lib)) ? lib : path.join('Projects', p);
  }
  if (lin.kind === 'misc') return path.join('_Misc', 'tasks', lin.task);
  if (lin.kind === 'global-task') return path.join('_Control_Center', 'tasks', lin.task);
  return '_Control_Center';
}

/** 注册文件相对路径。 */
export function registryRelPath(info) {
  const lin = lineageOf(info);
  if (!lin) return null;
  if (lin.kind === 'global') return GLOBAL_REGISTRY_REL;
  if (lin.kind === 'project') return path.join('_Project_Meta', lin.project, REGISTRY_NAME);
  if (lin.kind === 'misc') return path.join('_Misc', 'tasks', lin.task, REGISTRY_NAME);
  if (lin.kind === 'global-task') return path.join('_Control_Center', 'tasks', lin.task, REGISTRY_NAME);
  return null;
}

export function registryAbsPath(ws, info) {
  const rel = registryRelPath(info);
  return rel ? path.join(String(ws || ''), rel) : null;
}

export function planRelPath(ws, info) {
  const root = taskRoot(ws, info);
  return root ? path.join(root, 'PLAN.md') : '';
}

function normRel(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function cellsOf(line) {
  return line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.replace(new RegExp(TICK, 'g'), '').trim());
}

/** 解析任务级注册：返回 { title, structure: [{path, about}], files: [{path, about, when}], plan }。 */
function parseRegistry(text) {
  const out = { title: '', structure: [], files: [], plan: '' };
  let section = '';
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('# ')) { out.title = line.slice(2).trim(); continue; }
    if (line.startsWith('## ')) { section = line.slice(3).trim(); continue; }
    if (section.indexOf('计划') !== -1) {
      const m = /^[-*]\s*`?([^`：:]+\.md)`?/.exec(line);
      if (m) out.plan = m[1].trim();
      continue;
    }
    if (!line.startsWith('|')) continue;
    const cells = cellsOf(line);
    if (cells.length < 2) continue;
    if (cells[0] === '路径') continue;
    if (cells.every((c) => /^[-:\s]*$/.test(c))) continue;
    if (section.indexOf('目录') !== -1) out.structure.push({ path: cells[0], about: cells[1] || '' });
    else if (section.indexOf('规范') !== -1 || section.indexOf('文件') !== -1) {
      out.files.push({ path: cells[0], about: cells[1] || '', when: cells[2] || '' });
    }
  }
  return out;
}

/** 渲染任务级注册文件。 */
export function renderRegistry(info, data) {
  const label = lineageLabel(info);
  const lines = ['# 体系注册（' + label + '）', '', '## 目录结构', '', '| 路径 | 用途 |', '|---|---|'];
  for (const e of data.structure || []) lines.push('| ' + wrap(e.path) + ' | ' + e.about + ' |');
  lines.push('', '## 规范文件', '', '| 路径 | 用途 | 何时读 |', '|---|---|---|');
  for (const e of data.files || []) lines.push('| ' + wrap(e.path) + ' | ' + e.about + ' | ' + (e.when || '') + ' |');
  lines.push('', '## 计划', '');
  if (data.plan) lines.push('- ' + wrap(data.plan) + '：当前行动计划');
  lines.push('');
  lines.push('只给路径与用途：是否读正文由会话判断，不得无目的通读。');
  return lines.join(NL) + NL;
}

function wrap(p) {
  return TICK + normRel(p) + TICK;
}

/** 读取任务级注册；不存在返回 exists=false。 */
export function readRegistry(ws, info) {
  const file = registryAbsPath(ws, info);
  if (!file) return { file: null, exists: false, data: { structure: [], files: [], plan: '' } };
  if (!isFile(file)) return { file, exists: false, data: { structure: [], files: [], plan: '' } };
  let text = '';
  try { text = readUtf8(file); } catch { return { file, exists: true, error: '读取失败', data: { structure: [], files: [], plan: '' } }; }
  return { file, exists: true, data: parseRegistry(text), text };
}

/** 路径合法且存在：只收工作区相对路径。 */
function pathProblem(ws, p) {
  const raw = normRel(p);
  if (!raw) return '路径为空';
  if (/^[a-zA-Z]:/.test(raw) || raw.startsWith('/') || raw.startsWith('\\')) return '须写工作区相对路径，不得写绝对路径';
  const norm = path.normalize(raw).replace(/\\/g, '/');
  if (norm === '..' || norm.startsWith('../')) return '不得指向工作区之外';
  const abs = path.join(String(ws || ''), norm);
  if (!isFile(abs) && !isDir(abs)) return '不存在：' + norm;
  return '';
}

export function validateEntries(ws, entries) {
  const bad = [];
  for (const e of entries) {
    const problem = pathProblem(ws, e.path);
    if (problem) bad.push({ path: e.path, problem });
  }
  return bad;
}

const KIND_LABEL = { project: '项目', misc: '杂项', 'global-task': '全局任务' };

/** 扫描磁盘上的任务注册，返回行；只读，不落盘。 */
function scanGlobalRows(ws) {
  const root = String(ws || '');
  const rows = [];
  const pushFrom = (base, kind, nameOf) => {
    let names = [];
    try { names = fs.readdirSync(base); } catch { return; }
    for (const name of names) {
      const dir = path.join(base, name);
      if (fs.existsSync(path.join(dir, '.deregistered.json'))) continue;
      const file = path.join(dir, REGISTRY_NAME);
      if (!isFile(file)) continue;
      rows.push({ task: nameOf(name), kind: KIND_LABEL[kind] || kind, path: path.join(base, name, REGISTRY_NAME), mtime: 0 });
    }
  };
  pushFrom(path.join(root, '_Project_Meta'), 'project', (n) => n);
  pushFrom(path.join(root, '_Misc', 'tasks'), 'misc', (n) => n);
  pushFrom(path.join(root, '_Control_Center', 'tasks'), 'global-task', (n) => n);
  rows.sort((a, b) => (a.kind === b.kind ? a.task.localeCompare(b.task, 'zh') : a.kind.localeCompare(b.kind)));
  return rows;
}

/** 解析全局总注册表格，返回任务行；说明文字与人工非表格行不计入。 */
function parseGlobalRows(text) {
  const rows = [];
  let inTable = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('|')) { inTable = false; continue; }
    const cells = cellsOf(line);
    if (cells[0] === '任务') { inTable = true; continue; }
    if (!inTable) continue;
    if (cells.every((c) => /^[-:\s]*$/.test(c))) continue;
    if (cells.length < 3 || !cells[0]) continue;
    rows.push({ task: cells[0], kind: cells[1], path: cells[2], mtime: 0 });
  }
  return rows;
}

/** 全新生成全局总注册正文。 */
function buildGlobalBody(rows) {
  const lines = ['# 体系注册（全局）', '', '| 任务 | 类别 | 体系文件 |', '|---|---|---|'];
  for (const r of rows) lines.push('| ' + r.task + ' | ' + r.kind + ' | ' + wrap(r.path) + ' |');
  lines.push('');
  lines.push('本文件只列各任务体系文件的路径；各任务体系正文不注入全局提示段。');
  return lines.join(NL) + NL;
}

/**
 * 合并全局总注册：只更新任务行的类别与路径 2 列。
 * 文件头说明与人工补写的行原样保留。
 * 已不存在的任务行（路径形如各任务体系的 System.md）会被移除，避免迁移后残留旧行。
 * 表格不存在时返回空串，由调用方回退为全新生成。
 */
function mergeGlobalBody(existing, rows) {
  const lines = String(existing || '').split(/\r?\n/);
  if (!existing) return '';
  const head = lines.findIndex((l) => /^\|\s*任务\s*\|/.test(l));
  if (head < 0) return '';
  const isRegistryPath = (p) => /(^|[\\/])System\.md$/.test(p)
    && /(_Project_Meta[\\/]|_Misc[\\/]tasks[\\/]|_Control_Center[\\/]tasks[\\/])/.test(p);
  let end = head;
  while (end + 1 < lines.length && lines[end + 1].trim().startsWith('|')) end++;
  const dataStart = head + 2;                       // 表头 + 分隔行之后
  const out = lines.slice(0, dataStart);
  const seen = new Set();
  for (let i = dataStart; i <= end; i++) {
    const line = lines[i];
    if (!line.trim().startsWith('|')) { out.push(line); continue; }
    const cells = cellsOf(line);
    const task = cells[0] || '';
    const r = rows.find((x) => x.task === task);
    if (!r) {
      if (!isRegistryPath(cells[2] || '')) out.push(line);   // 人工补写的非任务行：保留
      continue;                                              // 已不存在的任务行：移除
    }
    seen.add(task);
    const parts = line.split('|');                   // 0 空、1 任务、2 类别、3 体系文件
    if (parts.length >= 5) {
      parts[2] = ' ' + r.kind + ' ';
      parts[3] = ' ' + wrap(r.path) + ' ';
      out.push(parts.join('|'));
    } else {
      out.push('| ' + r.task + ' | ' + r.kind + ' | ' + wrap(r.path) + ' |');
    }
  }
  for (const r of rows) {
    if (seen.has(r.task)) continue;
    out.push('| ' + r.task + ' | ' + r.kind + ' | ' + wrap(r.path) + ' |');
  }
  return out.concat(lines.slice(end + 1)).join(NL);
}

/** 显式写路径：按磁盘任务同步全局总注册；只更新路径行，保留人工备注。返回 { rows, file, changed }。 */
export function syncGlobalRefs(ws) {
  const rows = scanGlobalRows(ws);
  const file = path.join(String(ws || ''), GLOBAL_REGISTRY_REL);
  let prev = '';
  try { prev = readUtf8(file); } catch { prev = ''; }
  const body = mergeGlobalBody(prev, rows) || buildGlobalBody(rows);
  const changed = prev !== body;
  if (changed) writeFileAtomic(file, body);
  return { rows, file, changed, body };
}

/**
 * 全局总注册正文：只读文件，不触发任何写入。
 * 文件缺失或没有表格时按磁盘扫描给出数据（同样不落盘）；差异只在显式写路径同步。
 */
export function readGlobalRegistry(ws) {
  const file = path.join(String(ws || ''), GLOBAL_REGISTRY_REL);
  let text = '';
  let exists = false;
  try {
    if (isFile(file)) { text = readUtf8(file); exists = true; }
  } catch { exists = true; }
  const parsed = text
    ? parseGlobalRows(text).filter((r) => {
      const abs = path.isAbsolute(r.path) ? r.path : path.join(String(ws || ''), normRel(r.path));
      return isFile(abs);
    })
    : [];
  const rows = parsed.length ? parsed : scanGlobalRows(ws);
  return { file, exists, text, rows };
}

/** 注册内容注入块：全局只注入引用清单；项目与杂项注入本任务注册全文（压缩为一行一条）。 */
export function systemBlock(ws, info) {
  const lin = lineageOf(info);
  if (!lin) return '';
  if (lin.kind === 'global') {
    const g = readGlobalRegistry(ws);
    if (!g.rows.length) return '体系注册（全局）：暂无任务体系；新建任务后由插件登记路径。';
    const lines = ['体系注册（全局；只列路径，不注入各任务正文）'];
    for (const r of g.rows) lines.push('- ' + normRel(r.path) + ' —— ' + r.kind + '「' + r.task + '」');
    return lines.join(NL);
  }
  const reg = readRegistry(ws, info);
  if (!reg.exists) return '体系注册：未设置（首轮讨论体系后用 ho_docmap(action="registry-write") 注册）';
  const d = reg.data;
  const lines = ['体系注册（' + lineageLabel(info) + '）'];
  for (const e of d.structure) lines.push('- 目录 ' + normRel(e.path) + '：' + (e.about || ''));
  for (const e of d.files) lines.push('- 规范 ' + normRel(e.path) + '：' + (e.about || '') + (e.when ? '（' + e.when + '）' : ''));
  if (d.plan) lines.push('- 计划 ' + normRel(d.plan));
  return lines.join(NL);
}

/** 注册文件签名：文件不存在为 'none'；用于热更新判断。 */
export function registrySignature(ws, info) {
  const lin = lineageOf(info);
  if (!lin) return '';
  if (lin.kind === 'global') {
    try {
      const st = fs.statSync(path.join(String(ws || ''), GLOBAL_REGISTRY_REL));
      return 'g:' + st.size + ':' + Math.round(st.mtimeMs);
    } catch { return 'g:none'; }
  }
  const file = registryAbsPath(ws, info);
  if (!file) return '';
  try {
    const st = fs.statSync(file);
    return 'r:' + st.size + ':' + Math.round(st.mtimeMs);
  } catch { return 'r:none'; }
}

/**
 * 体检：校验某类别的注册路径；不传 info 时检查全部任务目录。
 * 全部任务按磁盘目录枚举，缺 System.md 的也计入（exists=false），
 * 避免「未注册任务完全不可见」时仍判「路径全部存在」（D-143）。
 * @returns {{ rows:object[], missing:number, unset:number }}
 */
export function checkRegistries(ws, info) {
  const targets = [];
  if (info) targets.push(info);
  else {
    const root = String(ws || '');
    const pushFrom = (base, make) => {
      let names = [];
      try { names = fs.readdirSync(base); } catch { return; }
      for (const name of names) {
        const dir = path.join(base, name);
        if (!isDir(dir)) continue;
        if (fs.existsSync(path.join(dir, '.deregistered.json'))) continue;
        targets.push(make(name));
      }
    };
    pushFrom(path.join(root, '_Project_Meta'), (name) => ({ role: 'project', project: name }));
    pushFrom(path.join(root, '_Misc', 'tasks'), (name) => ({ role: 'misc', task: name }));
    pushFrom(path.join(root, '_Control_Center', 'tasks'), (name) => ({ role: 'global-task', task: name }));
  }
  const rows = [];
  let missing = 0;
  let unset = 0;
  for (const t of targets) {
    const reg = readRegistry(ws, t);
    const entries = reg.data.structure.concat(reg.data.files);
    const bad = validateEntries(ws, entries);
    const planBad = reg.data.plan && pathProblem(ws, reg.data.plan) ? [{ path: reg.data.plan, problem: pathProblem(ws, reg.data.plan) }] : [];
    if (!reg.exists) unset++;
    missing += bad.length + planBad.length;
    rows.push({ label: lineageLabel(t), rel: normRel(registryRelPath(t) || ''), exists: reg.exists, entries: entries.length, bad: bad.concat(planBad) });
  }
  return { rows, missing, unset };
}

/** 写任务级注册：原子写，写前备份。 */
export function writeRegistry(ws, info, data) {
  const file = registryAbsPath(ws, info);
  if (!file) throw new Error('没有可写的注册路径：角色未定');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let backup = '';
  if (isFile(file)) {
    backup = file + '.bak';
    try { fs.copyFileSync(file, backup); } catch { backup = ''; }
  }
  const body = renderRegistry(info, data);
  writeFileAtomic(file, body);
  return { file, backup, bytes: Buffer.byteLength(body, 'utf8') };
}

// ---------------------------------------------------------------- 计划

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

/** 归档旧计划到任务根 _archive/，返回归档路径；没有旧计划返回空串。 */
export function archivePlan(ws, info) {
  const rel = planRelPath(ws, info);
  if (!rel) return '';
  const abs = path.join(String(ws || ''), rel);
  if (!isFile(abs)) return '';
  const dir = path.join(path.dirname(abs), '_archive');
  fs.mkdirSync(dir, { recursive: true });
  const dst = path.join(dir, 'PLAN_' + stamp() + '.md');
  fs.renameSync(abs, dst);
  return dst;
}

/** 计划模板要求的节次；写入时逐节校验，缺节即拒收。 */
const PLAN_SECTIONS = ['目标', '步骤', '验收', '风险', '状态'];

/** 返回计划正文缺少的模板节次（空数组表示齐全）。 */
export function planSectionProblems(text) {
  const t = String(text || '');
  return PLAN_SECTIONS.filter((s) => !(new RegExp('^##\\s*\\d*\\s*' + s, 'm')).test(t));
}

export function readPlan(ws, info) {
  const rel = planRelPath(ws, info);
  const abs = rel ? path.join(String(ws || ''), rel) : '';
  if (!abs || !isFile(abs)) return { rel, exists: false, text: '' };
  try { return { rel, exists: true, text: readUtf8(abs) }; }
  catch { return { rel, exists: true, text: '', error: '读取失败' }; }
}

/** 写计划：先归档旧计划，再原子写入。返回 { rel, archived, bytes }。 */
export function writePlan(ws, info, text) {
  const rel = planRelPath(ws, info);
  if (!rel) throw new Error('没有可写的计划路径：角色未定');
  const archived = archivePlan(ws, info);
  const abs = path.join(String(ws || ''), rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const body = String(text || '');
  writeFileAtomic(abs, body);
  return { rel, archived, bytes: Buffer.byteLength(body, 'utf8') };
}

/** 把计划写入本任务注册的「计划」一节；注册不存在时返回 false。 */
export function pointRegistryToPlan(ws, info) {
  const reg = readRegistry(ws, info);
  if (!reg.exists) return false;
  const rel = planRelPath(ws, info);
  const data = { structure: reg.data.structure, files: reg.data.files, plan: rel };
  writeRegistry(ws, info, data);
  return true;
}
