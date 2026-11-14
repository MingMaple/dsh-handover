/**
 * 全局任务库：`_Control_Center/tasks/<任务>/`。
 * 全局可同时承担多个任务，每个任务有独立交接、体系注册与计划；任务可整体独立为项目或杂项会话。
 */
import fs from 'node:fs';
import path from 'node:path';
import { NL, readUtf8, isFile, isDir } from './text.mjs';
import { assertTaskName } from './role.mjs';
import { renderRegistry, syncGlobalRefs } from './system.mjs';

const HANDOVER = [
  '# 交接（全局任务）',
  '',
  '## 1. 正在做的事',
  '',
  '未开始；由全局会话在任务启动时补写。',
  '',
  '## 2. 下一步',
  '',
  '- 待定。',
  '',
].join(NL);

function copyIf(src, dst) {
  if (!isFile(src) || fs.existsSync(dst)) return false;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  return true;
}

/**
 * 建立全局任务库：目录、交接、体系注册、规则与模板副本；随后重建全局总注册。
 * @returns {{ dir: string, created: string[] }}
 */
export function createGlobalTask(ws, task) {
  const name = String(task || '').trim();
  assertTaskName(name);
  const dir = path.join(String(ws || ''), '_Control_Center', 'tasks', name);
  if (isDir(dir) && fs.readdirSync(dir).length) throw new Error('全局任务已存在且非空：' + dir);
  fs.mkdirSync(path.join(dir, '_archive'), { recursive: true });
  const created = [];
  const files = [
    ['Handover.md', HANDOVER],
    ['System.md', renderRegistry({ role: 'global-task', task: name }, { structure: [], files: [], plan: '' })],
  ];
  for (const [rel, body] of files) {
    const dst = path.join(dir, rel);
    if (fs.existsSync(dst)) continue;
    fs.writeFileSync(dst, body, 'utf8');
    created.push(rel);
  }
  // 暂任规范与交接规范随任务库独立，避免暂任方跨库读取全局规则。
  const rules = path.join(String(ws || ''), '_Control_Center', 'rules');
  for (const rel of ['Delegation_Rules.md', 'Handover_Rules.md']) {
    if (copyIf(path.join(rules, rel), path.join(dir, rel))) created.push(rel);
  }
  const tpl = path.join(String(ws || ''), '_Control_Center', 'templates');
  for (const rel of ['Plan.skeleton.md', 'System.skeleton.md']) {
    if (copyIf(path.join(tpl, rel), path.join(dir, rel))) created.push(rel);
  }
  syncGlobalRefs(ws);
  return { dir, created };
}

/** 读全局任务交接正文（不存在返回空串）。 */
export function readTaskHandover(ws, task) {
  const file = path.join(String(ws || ''), '_Control_Center', 'tasks', String(task || ''), 'Handover.md');
  try { return readUtf8(file); } catch { return ''; }
}
