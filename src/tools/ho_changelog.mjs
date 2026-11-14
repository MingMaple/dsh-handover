/** ho_changelog —— 按表格格式追加一行到 Global_Changelog.md。 */
import fs from 'node:fs';
import { nameOf } from '../lib/names.mjs';
import path from 'node:path';
import { textOutput } from '../lib/output.mjs';
import { NL, readUtf8, isFile } from '../lib/text.mjs';

function stamp() {
  const d = new Date();
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

export function pmChangelogTool(env) {
  return {
    name: nameOf('changelog'),
    description:
      '按固定表格追加一行台账。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['summary'],
      properties: {
        summary: { type: 'string', description: '本行内容（中文）' },
        executor: { type: 'string', description: '执行者（缺省为本会话 id）' },
        date: { type: 'string', description: '日期 YYYY-MM-DD（缺省为当天）' },
      },
    },
    output: textOutput(),
    async execute(args, exec) {
      const ws = env.resolveWs(exec);
      const file = path.join(ws, '_Control_Center', 'records', 'Global_Changelog.md');
      // 台账不存在就从插件自带的骨架建一份（不依赖旧全局留下的文件）。
      if (!isFile(file)) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, readUtf8(new URL('../templates/Changelog.skeleton.md', import.meta.url)), 'utf8');
      }
      let text = readUtf8(file);
      let lines = text.split(NL);
      let sepIdx = lines.findIndex((l) => l.trim() === '|---|---|---|');
      if (sepIdx === -1) {
        // 骨架被改坏（没有表）：补一张新表再写，绝不因此拒绝记账。
        const extra = ['', '| 日期 | 变更 | 执行者 |', '|---|---|---|'];
        lines = lines.concat(extra);
        sepIdx = lines.length - 1;
        text = lines.join(NL);
      }
      const date = args.date || stamp();
      const who = args.executor || env.selfId(exec) || '?';
      const summary = typeof args.summary === 'string' ? args.summary.trim() : '';
      if (!summary) throw new Error('summary 不能为空（写明变更内容与原因）');
      const safe = summary.split('|').join(String.fromCharCode(92) + '|');
      const row = '| ' + date + ' | ' + safe + ' | ' + who + ' |';
      lines.splice(sepIdx + 1, 0, row);
      fs.writeFileSync(file, lines.join(NL), 'utf8');
      return { text: '已追加到 ' + file + NL + row.slice(0, 240) };
    },
  };
}