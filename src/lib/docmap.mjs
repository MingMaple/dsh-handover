/**
 * 旧版文档定位（docmap）解析：1.0 起只由迁移兼容模块 `legacy.mjs` 使用，用于把旧表并入体系注册。
 * 新写入一律走 `system.mjs`；本模块不再参与提示段注入。
 */
import fs from 'node:fs';
import path from 'node:path';
import { NL, readUtf8, isFile, isDir } from './text.mjs';

export const DOCMAP_DIR = path.join('_Control_Center', 'records', 'docmap');
export const COLUMNS = ['路径', '一句话介绍', '何时读'];

/** 由会话角色推导所属的登记（全局／项目／杂项）；普通会话没有 map。 */
export function lineageOf(info) {
  const role = info && info.role ? info.role : '';
  if (role === 'global') return { kind: 'global', project: '', task: '', key: '全局' };
  if (role === 'project' && info.project) return { kind: 'project', project: String(info.project), task: '', key: String(info.project) };
  if (role === 'misc' && info.task) return { kind: 'misc', project: '', task: String(info.task), key: String(info.task) };
  return null;
}

export function lineageLabel(info) {
  const lin = lineageOf(info);
  if (!lin) return '';
  if (lin.kind === 'project') return '项目「' + lin.project + '」';
  if (lin.kind === 'misc') return '杂项任务「' + lin.task + '」';
  return '全局';
}

/** 文件名：global.md / project-<项目名>.md / misc-<任务名>.md（相对工作区根）。 */
export function docmapRelPath(info) {
  const lin = lineageOf(info);
  if (!lin) return null;
  const stem = lin.kind === 'global' ? 'global' : lin.kind === 'project' ? 'project-' + lin.project : 'misc-' + lin.task;
  return path.join(DOCMAP_DIR, stem + '.md');
}

export function docmapAbsPath(ws, info) {
  const rel = docmapRelPath(info);
  return rel ? path.join(String(ws || ''), rel) : null;
}

function stripTicks(s) {
  return String(s || '').replace(/`/g, '').trim();
}

/** 解析表格行：跳过表头与分隔行；三列之外的多余列合并进第三列。 */
export function parseDocmap(text) {
  const entries = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('|')) continue;
    const cells = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => stripTicks(c));
    if (!cells.length) continue;
    if (cells.length < 2) continue;
    if (cells[0] === COLUMNS[0]) continue;                 // 表头
    if (cells.every((c) => /^[-:\s]*$/.test(c))) continue;  // 分隔行
    const p = cells[0];
    if (!p) continue;
    const about = cells[1] || '';
    const when = cells.length > 3 ? cells.slice(2).join('，') : (cells[2] || '');
    entries.push({ path: p, about, when });
  }
  return entries;
}

export function readDocmap(ws, info) {
  const file = docmapAbsPath(ws, info);
  if (!file) return { file: null, exists: false, entries: [] };
  if (!isFile(file)) return { file, exists: false, entries: [] };
  let text = '';
  try { text = readUtf8(file); } catch { return { file, exists: true, entries: [], error: '读取失败' }; }
  return { file, exists: true, entries: parseDocmap(text) };
}

/** 渲染文件正文（写盘用）：标题一行、表格、一句判定。 */
export function renderDocmap(info, entries) {
  const label = lineageLabel(info);
  const lines = ['# 文档定位（' + label + '）', '', '| ' + COLUMNS.join(' | ') + ' |', '|' + COLUMNS.map(() => '---').join('|') + '|'];
  for (const e of entries) lines.push('| `' + e.path + '` | ' + e.about + ' | ' + (e.when || '') + ' |');
  lines.push('');
  lines.push('只指路：是否读正文由会话判断，不得无目的通读。');
  return lines.join(NL) + NL;
}

/**
 * 注入提示段的文本：空 map 返回空串（不占位）。
 * 形如「文档定位（项目「X」；只指路…）」＋ 每条一行，路径加反引号。
 */
export function docmapBlock(ws, info) {
  const map = readDocmap(ws, info);
  if (!map.entries.length) return '';
  const lines = ['文档定位（' + lineageLabel(info) + '；只指路，是否读正文由会话判断，不得无目的通读）'];
  for (const e of map.entries) {
    lines.push('- ' + e.path + (e.about ? ' —— ' + e.about : '') + (e.when ? '（' + e.when + '）' : ''));
  }
  return lines.join(NL);
}

/** 路径是否合法且存在：只收工作区相对路径，不得越出工作区。 */
export function pathProblem(ws, p) {
  const raw = String(p || '').trim();
  if (!raw) return '路径为空';
  if (/^[a-zA-Z]:/.test(raw) || raw.startsWith('/') || raw.startsWith('\\')) return '须写工作区相对路径，不得写绝对路径';
  const norm = path.normalize(raw).replace(/\\/g, '/');
  if (norm === '..' || norm.startsWith('../')) return '不得指向工作区之外';
  const abs = path.join(String(ws || ''), norm);
  if (!isFile(abs) && !isDir(abs)) return '不存在：' + norm;
  return '';
}

/** 逐条校验：返回 [{ path, problem }]。 */
export function validateEntries(ws, entries) {
  const bad = [];
  for (const e of entries) {
    const problem = pathProblem(ws, e.path);
    if (problem) bad.push({ path: e.path, problem });
  }
  return bad;
}

/** 闸门用：检查所有 map 的路径存在性（只判存在，不判字数）。 */
export function checkDocmaps(ws) {
  const dir = path.join(String(ws || ''), DOCMAP_DIR);
  const rows = [];
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort(); } catch { return { dir, rows, missing: 0 }; }
  for (const name of files) {
    const file = path.join(dir, name);
    const stem = name.slice(0, -3);
    let info = null;
    if (stem === 'global') info = { role: 'global' };
    else if (stem.startsWith('project-')) info = { role: 'project', project: stem.slice(8) };
    else if (stem.startsWith('misc-')) info = { role: 'misc', task: stem.slice(5) };
    let entries = [];
    try { entries = parseDocmap(readUtf8(file)); } catch { entries = []; }
    const bad = validateEntries(ws, entries);
    rows.push({ name, label: info ? lineageLabel(info) : '（文件名不符合规范）', entries: entries.length, bad });
  }
  return { dir, rows, missing: rows.reduce((a, r) => a + r.bad.length, 0) };
}
