/**
 * 迁移兼容模块（1.0）：把旧版文档定位（docmap）并入体系注册。
 *
 * 本模块可整体删除：删除后不影响 1.0 的主实现；用户应先升级到 1.0.0 完成迁移，再升级后续版本。
 * 迁移不删除旧文件：旧目录整体移入 _Archives/_Global/Backups/ 下并带时间标注。
 */
import fs from 'node:fs';
import path from 'node:path';
import { NL, readUtf8, isFile, isDir } from './text.mjs';
import { planRelPath } from './system.mjs';
import { parseDocmap } from './docmap.mjs';

export const LEGACY_DIR = path.join('_Control_Center', 'records', 'docmap');

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

/** 旧目录是否存在且含 .md 文件。 */
export function legacyInfo(ws) {
  const dir = path.join(String(ws || ''), LEGACY_DIR);
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')); } catch { return { dir, exists: false, files: [] }; }
  return { dir, exists: files.length > 0, files };
}

function taskInfoFromStem(stem) {
  if (stem.indexOf('project-') === 0) return { role: 'project', project: stem.slice(8) };
  if (stem.indexOf('misc-') === 0) return { role: 'misc', task: stem.slice(5) };
  return null;
}

function renderSystem(info, rows, plan) {
  const label = info.role === 'project' ? '项目「' + info.project + '」' : '杂项任务「' + info.task + '」';
  const lines = ['# 体系注册（' + label + '）', '', '## 目录结构', '', '| 路径 | 用途 |', '|---|---|', '', '## 规范文件', '', '| 路径 | 用途 | 何时读 |', '|---|---|---|'];
  for (const r of rows) lines.push('| `' + r.path + '` | ' + r.about + ' | ' + (r.when || '') + ' |');
  lines.push('', '## 计划', '');
  if (plan) lines.push('- `' + plan + '`：当前行动计划');
  lines.push('', '本文件由 1.0 迁移从旧文档定位转换而来；后续由本任务在任会话用 ho_docmap 维护。');
  return lines.join(NL) + NL;
}

function writeIfAbsent(file, body) {
  if (isFile(file)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, 'utf8');
  return true;
}

/**
 * 执行迁移。返回 { ok, dir, converted, kept, archived, problems }。
 * @param {string} ws 工作区根
 */
export function migrateLegacyDocmaps(ws) {
  const root = String(ws || '');
  const info = legacyInfo(root);
  if (!info.exists) return { ok: true, dir: info.dir, converted: [], kept: [], archived: '', problems: [] };
  const archiveRoot = path.join(root, '_Archives', '_Global', 'Backups', '1.0-docmap_' + stamp());
  const problems = [];
  const converted = [];
  const kept = [];
  for (const name of info.files) {
    const file = path.join(info.dir, name);
    let text = '';
    try { text = readUtf8(file); } catch { problems.push('读取失败：' + name); continue; }
    const stem = name.replace(/\.md$/, '');
    const rows = parseDocmap(text);
    if (stem === 'global') {
      // 全局旧内容不是任务体系引用，保留为工作区文档清单，不注入提示段。
      const dst = path.join(root, '_Control_Center', 'records', 'global-docs.md');
      if (writeIfAbsent(dst, text)) kept.push('_Control_Center/records/global-docs.md');
      continue;
    }
    const t = taskInfoFromStem(stem);
    if (!t) { problems.push('文件名不符合旧规范，未转换：' + name); continue; }
    const dst = t.role === 'project'
      ? path.join(root, '_Project_Meta', t.project, 'System.md')
      : path.join(root, '_Misc', 'tasks', t.task, 'System.md');
    const plan = planRelPath(root, t);
    if (writeIfAbsent(dst, renderSystem(t, rows, plan))) converted.push(path.relative(root, dst));
  }
  // 归档旧目录：整体移入备份位，不删除。
  fs.mkdirSync(archiveRoot, { recursive: true });
  const archived = path.join(archiveRoot, 'docmap');
  fs.renameSync(info.dir, archived);
  return { ok: problems.length === 0, dir: info.dir, converted, kept, archived, problems };
}
