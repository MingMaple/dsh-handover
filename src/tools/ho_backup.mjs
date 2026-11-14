/**
 * ho_backup —— 备份与迁移：一个入口，按 action 分流。
 *   snapshot（默认）：库快照，逐字节复制 + sha256 清单 + PROVENANCE
 *   check：迁移包前置闸门
 *   pack：打包
 *   verify：校包
 *   restore：恢复（默认仅预演）
 * 原 ho_snapshot、ho_pack 合并于此。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { textOutput } from '../lib/output.mjs';
import { nameOf } from '../lib/names.mjs';
import { NL, isDir } from '../lib/text.mjs';
import { assertProjectName } from '../lib/role.mjs';
import { packCheck, packNow, packVerify, packRestore } from '../lib/pack-ops.mjs';

export const ACTIONS = ['snapshot', 'check', 'pack', 'verify', 'restore'];

const SKIP_DIRS = ['__pycache__', '.git', 'node_modules', '.obsidian'];
const SKIP_FILES = ['.DS_Store', 'Thumbs.db'];

function stamp() {
  const d = new Date();
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
}

function walk(root, rel, rows) {
  for (const name of fs.readdirSync(path.join(root, rel))) {
    const full = path.join(root, rel, name);
    const st = fs.statSync(full);
    const r = rel ? rel + '/' + name : name;
    if (st.isDirectory()) {
      if (SKIP_DIRS.indexOf(name) !== -1) continue;
      walk(root, r, rows);
    } else if (st.isFile()) {
      if (SKIP_FILES.indexOf(name) !== -1) continue;
      if (name.endsWith('.pyc')) continue;
      rows.push({ rel: r, size: st.size });
    }
  }
  return rows;
}

function snapshotText(env, args, exec) {
  const ws = env.resolveWs(exec);
  const project = assertProjectName(typeof args.project === 'string' ? args.project.trim() : '');
  if (!project) throw new Error('action="snapshot" 需要 project（写项目名，如 Demo）');
  const projDir = path.join(ws, 'Projects', project);
  if (!isDir(projDir)) throw new Error('找不到项目：' + projDir);
  let lib = null;
  for (const name of fs.readdirSync(projDir)) {
    const p = path.join(projDir, name);
    if (isDir(p) && fs.existsSync(path.join(p, 'RULES.md'))) { lib = p; break; }
  }
  if (!lib) throw new Error('该项目下没有带 RULES.md 的库根：' + projDir);
  const rows = walk(lib, '', []);
  const total = rows.reduce((a, b) => a + b.size, 0);
  const out = [];
  out.push('源库 ' + lib);
  out.push('文件 ' + rows.length + ' 个，共 ' + (total / 1048576).toFixed(2) + ' MB');
  if (args.dry_run) { out.push('dry_run：不落盘。'); return out.join(NL); }
  const tag = args.tag || '行为检查';
  const dest = path.join(ws, '_Temp', 'Checks', project + '_' + tag + '_' + stamp());
  if (fs.existsSync(dest)) throw new Error('目标已存在，不覆盖：' + dest);
  const libDest = path.join(dest, 'lib');
  fs.mkdirSync(libDest, { recursive: true });
  const manifest = ['# 源库: ' + lib, '# 文件: ' + rows.length + '  字节: ' + total];
  let drift = 0;
  for (const r of rows) {
    const src = path.join(lib, r.rel);
    const dst = path.join(libDest, r.rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    const h1 = crypto.createHash('sha256').update(fs.readFileSync(src)).digest('hex');
    const h2 = crypto.createHash('sha256').update(fs.readFileSync(dst)).digest('hex');
    if (h1 !== h2) drift++;
    manifest.push(r.rel + String.fromCharCode(9) + r.size + String.fromCharCode(9) + h1);
  }
  fs.writeFileSync(path.join(dest, 'MANIFEST.tsv'), manifest.join(NL), 'utf8');
  const prov = [
    '# PROVENANCE',
    '- 源库: ' + lib,
    '- 生成时间: ' + new Date().toISOString(),
    '- 发起会话: ' + (env.selfId(exec) || '?'),
    '- 文件数/字节: ' + rows.length + ' / ' + total,
    '- 排除: __pycache__ .git node_modules .obsidian *.pyc .DS_Store Thumbs.db',
    '- 校验: 逐文件 sha256 比对，drift=' + drift,
    '- 含个人数据，不得外发、不得进 _Archives',
  ].join(NL);
  fs.writeFileSync(path.join(dest, 'PROVENANCE.md'), prov, 'utf8');
  out.push('已落盘 ' + dest);
  out.push('校验 drift=' + drift + (drift === 0 ? '（逐文件一致）' : '（不一致，判定失败）'));
  return out.join(NL);
}

export function pmBackupTool(env) {
  return {
    name: nameOf('backup'),
    description:
      '备份与迁移：action=snapshot 库快照（缺省）、check 前置闸门、pack 打包、verify 校验包、restore 恢复（缺省预演）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ACTIONS, description: '缺省 snapshot' },
        project: { type: 'string', description: 'snapshot：项目名（Projects/<项目>/ 下）' },
        tag: { type: 'string', description: 'snapshot：标签，缺省 行为检查' },
        kind: { type: 'string', enum: ['project', 'task', 'global'], description: 'pack：目标类型' },
        name: { type: 'string', description: 'pack：项目名或任务名' },
        out: { type: 'string', description: 'pack：输出目录' },
        note: { type: 'string', description: 'pack：写入 MIGRATION.md 的说明' },
        items: { type: 'array', items: { type: 'string' }, description: 'check：检查的项目名（global 表示全局）' },
        min_age_min: { type: 'number', description: 'check：要求静止分钟数（默认 90）' },
        pack: { type: 'string', description: 'verify、restore：包路径' },
        target: { type: 'string', description: 'restore：目标根（缺省当前）' },
        apply: { type: 'boolean', description: 'restore：为 true 才写入' },
        dry_run: { type: 'boolean', description: 'snapshot：只统计不落盘；pack、restore：只列清单' },
        format: { type: 'string', enum: ['auto', '7z', 'tar'], description: 'pack：auto＝有 7-Zip 用 7z，否则内置 tar.gz（缺省）' },
      },
    },
    output: textOutput(),
    async execute(args, exec) {
      const action = typeof args.action === 'string' && args.action ? args.action : 'snapshot';
      if (ACTIONS.indexOf(action) === -1) throw new Error('action 只能是 ' + ACTIONS.join(' | ') + '（收到 ' + String(action) + '）');
      if (action === 'snapshot') return { text: snapshotText(env, args, exec) };
      if (action === 'check') return { text: packCheck(env, args, exec) };
      if (action === 'verify') return { text: packVerify(env, args, exec) };
      if (action === 'restore') return { text: packRestore(env, args, exec) };
      return { text: packNow(env, args, exec) };
    },
  };
}
