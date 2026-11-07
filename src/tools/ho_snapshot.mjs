/** ho_snapshot —— 库快照：逐字节复制 + sha256 清单 + PROVENANCE（Charter §4.4）。 */
import fs from 'node:fs';
import { nameOf } from '../lib/names.mjs';
import path from 'node:path';
import crypto from 'node:crypto';
import { textOutput } from '../lib/output.mjs';
import { NL, isDir } from '../lib/text.mjs';

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

export function pmSnapshotTool(env) {
  return {
    name: nameOf('snapshot'),
    description:
      '库快照：逐字节复制、sha256 清单、来源说明。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['project'],
      properties: {
        project: { type: 'string', description: '项目名（Projects/<项目>/ 下）' },
        tag: { type: 'string', description: '标签，默认 行为检查' },
        dry_run: { type: 'boolean', description: '只统计不落盘' },
      },
    },
    output: textOutput(),
    async execute(args, exec) {
      const ws = env.resolveWs(exec);
      const project = typeof args.project === 'string' ? args.project.trim() : '';
      if (!project) throw new Error('project 不能为空（写项目名，如 Demo）');
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
      if (args.dry_run) { out.push('dry_run：不落盘。'); return { text: out.join(NL) }; }
      const tag = args.tag || '行为检查';
      const dest = path.join(ws, '_Temp', 'Checks', args.project + '_' + tag + '_' + stamp());
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
      out.push('校验 drift=' + drift + (drift === 0 ? '（逐文件一致）' : '（**不一致，判失败**）'));
      return { text: out.join(NL) };
    },
  };
}