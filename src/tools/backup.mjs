/**
 * 备份与迁移实现：按动作分流，经 ho_workspace 的 backup-* 动作暴露。
 *   snapshot（默认）：库快照，逐字节复制 + sha256 清单 + PROVENANCE
 *   check：迁移包前置闸门
 *   pack：打包
 *   verify：校包
 *   restore：恢复（默认仅预演）
 * 原 ho_snapshot、ho_pack 合并于此。
 */
import fs from 'node:fs';
import path from 'node:path';
import { textOutput } from '../lib/output.mjs';
import { nameOf } from '../lib/names.mjs';
import { NL, isDir, fmtMB } from '../lib/text.mjs';
import { sha256 } from '../lib/handover-io.mjs';
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
  if (!project) throw new Error('现象：`action="snapshot"` 缺少 `project`。原因：库快照须指定项目名。处置：传入 `project`，例如 `Demo`。');
  const projDir = path.join(ws, 'Projects', project);
  if (!isDir(projDir)) throw new Error('现象：未找到项目目录 `' + projDir + '`。原因：`project` 与工作区内 `Projects` 下的目录不一致。处置：核对项目名后重试。');
  let lib = null;
  for (const name of fs.readdirSync(projDir)) {
    const p = path.join(projDir, name);
    if (isDir(p) && fs.existsSync(path.join(p, 'RULES.md'))) { lib = p; break; }
  }
  if (!lib) throw new Error('现象：项目目录下没有含 `RULES.md` 的库根：`' + projDir + '`。原因：该项目尚未建立库结构。处置：先建立含 `RULES.md` 的库根，再执行快照。');
  const rows = walk(lib, '', []);
  const total = rows.reduce((a, b) => a + b.size, 0);
  const out = [];
  out.push('源库 `' + lib + '`');
  out.push('文件 ' + rows.length + ' 个，共 ' + fmtMB(total));
  if (args.dry_run) { out.push('`dry_run`：只统计，不写入磁盘。'); return out.join(NL); }
  const tag = args.tag || '行为检查';
  const dest = path.join(ws, '_Temp', 'Checks', project + '_' + tag + '_' + stamp());
  if (fs.existsSync(dest)) throw new Error('现象：目标快照目录已存在：`' + dest + '`。原因：插件不覆盖已有快照。处置：更换 `tag`，或删除该目录后重试。');
  const libDest = path.join(dest, 'lib');
  fs.mkdirSync(libDest, { recursive: true });
  const manifest = ['# 源库: ' + lib, '# 文件: ' + rows.length + '  字节: ' + total];
  let drift = 0;
  for (const r of rows) {
    const src = path.join(lib, r.rel);
    const dst = path.join(libDest, r.rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    const h1 = sha256(src);
    const h2 = sha256(dst);
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
  out.push('已写入 `' + dest + '`');
  out.push('校验 drift=' + drift + (drift === 0 ? '，逐文件一致' : '，不一致，判定失败'));
  return out.join(NL);
}

/**
 * 构造 `backup` 工具定义。
 *
 * 工具层只分派动作，打包与恢复逻辑留在 `lib/pack-ops.mjs`，避免实现分叉。
 *
 * @param {object} env 插件环境，提供 `resolveWs` 与 `selfId`。
 * @returns {object} 工具定义，供宿主注册。
 * 副作用：`snapshot` 向 `_Temp/Checks` 写入快照、清单与来源记录。
 */
export function pmBackupTool(env) {
  return {
    name: nameOf('backup'),
    description:
      '备份与迁移：按 `action` 执行库快照、迁移包前置检查、打包、校验包与恢复。所有动作只读写工作区内的文件。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ACTIONS, description: '动作。缺省 `snapshot`：库快照；`check`：迁移包前置检查；`pack`：打包；`verify`：校验包；`restore`：恢复（缺省预演）。' },
        project: { type: 'string', description: '`snapshot` 的项目名，位于 `Projects/<项目>/` 下。例：`Demo`。' },
        tag: { type: 'string', description: '`snapshot` 的快照标签，写进目录名。缺省「行为检查」。例：`发布前`。' },
        kind: { type: 'string', enum: ['project', 'task', 'global'], description: '`pack` 的目标类型：`project`、`task` 或 `global`。' },
        name: { type: 'string', description: '`pack` 的项目名或任务名。例：`Demo`。' },
        out: { type: 'string', description: '`pack` 的输出目录。例：`_Temp/Packs`。' },
        note: { type: 'string', description: '`pack` 写入 `MIGRATION.md` 的说明。例：`迁移到新机`。' },
        items: { type: 'array', items: { type: 'string' }, description: '`check` 检查的项目名，`global` 表示全局。例：`["Demo","global"]`。' },
        min_age_min: { type: 'number', description: '`check` 要求的静止分钟数。默认 90。' },
        pack: { type: 'string', description: '`verify`、`restore` 的包路径。例：`_Temp/Packs/Demo.tar.gz`。' },
        target: { type: 'string', description: '`restore` 的目标根。缺省为当前根。' },
        apply: { type: 'boolean', description: '`restore` 为 `true` 时才写入。缺省 `false`，只预演。' },
        dry_run: { type: 'boolean', description: '`snapshot`：只统计，不写入磁盘；`pack`、`restore`：只列清单。' },
        format: { type: 'string', enum: ['auto', '7z', 'tar'], description: '`pack`：`auto` 表示有 7-Zip 时用 7z，否则用内置 tar.gz。此值缺省。' },
      },
    },
    output: textOutput(),
    async execute(args, exec) {
      const action = typeof args.action === 'string' && args.action ? args.action : 'snapshot';
      if (ACTIONS.indexOf(action) === -1) throw new Error('现象：`action` 取值不在允许范围。原因：收到 `' + String(action) + '`，只接受 ' + ACTIONS.join('、') + '。处置：改用上述取值之一后重试。');
      if (action === 'snapshot') return { text: snapshotText(env, args, exec) };
      if (action === 'check') return { text: packCheck(env, args, exec) };
      if (action === 'verify') return { text: packVerify(env, args, exec) };
      if (action === 'restore') return { text: packRestore(env, args, exec) };
      return { text: packNow(env, args, exec) };
    },
  };
}
