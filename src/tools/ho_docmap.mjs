/**
 * ho_docmap —— 本血脉的文档定位 map（只指路，不规定读多少）。
 *
 * 血脉由会话已登记的角色推导，不接受传入项目名或任务名：全局只写 global.md，
 * 项目只写 project-<本项目>.md，杂项只写 misc-<本任务>.md。
 * 写入者必须是该血脉在任者（以 Office.json 为准）；已交出的旧会话只读。
 * 不设字数上限；写盘前逐条校验路径存在，缺项整条拒绝并列出。
 */
import fs from 'node:fs';
import path from 'node:path';
import { textOutput } from '../lib/output.mjs';
import { nameOf } from '../lib/names.mjs';
import { NL } from '../lib/text.mjs';
import { loadOffice, lineageKeyOf } from '../lib/office.mjs';
import {
  lineageOf, lineageLabel, docmapRelPath, docmapAbsPath, readDocmap,
  renderDocmap, validateEntries,
} from '../lib/docmap.mjs';

export const ACTIONS = ['read', 'write', 'check'];

function ownLineage(env, exec) {
  let info = null;
  try { info = env.roleOf(exec); } catch { info = null; }
  const lin = lineageOf(info);
  return { info, lin };
}

function holderOf(ws, lin) {
  try {
    const store = loadOffice(ws);
    const key = lineageKeyOf(lin.kind, lin.project, lin.task);
    const row = store.lineages ? store.lineages[key] : null;
    return { key, current: row && row.current ? row.current : null };
  } catch {
    return { key: '', current: null };
  }
}

function entriesText(entries) {
  if (!entries.length) return '（空 map：不注入提示段）';
  return entries.map((e) => '- ' + e.path + (e.about ? ' —— ' + e.about : '') + (e.when ? '（' + e.when + '）' : '')).join(NL);
}

export function pmDocmapTool(env) {
  return {
    name: nameOf('docmap'),
    description:
      '本血脉的文档定位：action=read 读、write 写（逐条校验路径存在）、check 查自己的 map；只指路，不规定读多少。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ACTIONS, description: '缺省 read' },
        entries: {
          type: 'array',
          description: 'write：整份替换。每项 { path: 工作区相对路径, about: 一句话介绍, when: 何时读 }',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['path', 'about'],
            properties: {
              path: { type: 'string', description: '工作区相对路径，必须存在' },
              about: { type: 'string', description: '一句话介绍' },
              when: { type: 'string', description: '什么时候该读（可选，建议写）' },
            },
          },
        },
      },
    },
    output: textOutput(),
    async execute(args, exec) {
      const ws = env.resolveWs(exec);
      const { info, lin } = ownLineage(env, exec);
      if (!lin) throw new Error('本会话没有角色：文档定位只对全局、项目、杂项会话开放');
      const action = typeof args.action === 'string' && args.action ? args.action : 'read';
      if (ACTIONS.indexOf(action) === -1) throw new Error('action 只能是 ' + ACTIONS.join(' | ') + '（收到 ' + String(action) + '）');
      const rel = docmapRelPath(info);
      const abs = docmapAbsPath(ws, info);
      const label = lineageLabel(info);

      if (action === 'read') {
        const map = readDocmap(ws, info);
        const out = [];
        out.push('文档定位（' + label + '）  ' + rel);
        out.push(map.exists ? '状态  已设置，' + map.entries.length + ' 条' : '状态  未设置（空 map 不注入提示段）');
        if (map.entries.length) out.push('', entriesText(map.entries));
        return { text: out.join(NL) };
      }

      if (action === 'check') {
        const map = readDocmap(ws, info);
        const bad = validateEntries(ws, map.entries);
        const out = [];
        out.push('文档定位体检（' + label + '）  ' + rel);
        out.push(map.exists ? '条目 ' + map.entries.length + ' 条' : '未设置（空 map 不注入）');
        for (const b of bad) out.push('  失效：' + b.path + ' —— ' + b.problem);
        out.push(bad.length ? '判定：' + bad.length + ' 条失效，请更新 map。' : '判定：路径全部存在。');
        return { text: out.join(NL) };
      }

      // action=write
      const holder = holderOf(ws, lin);
      const meId = String(env.selfId(exec) || '');
      if (!holder.current) {
        throw new Error('登记表里没有「' + (holder.key || label) + '」的在任记录：换任登记表是写入依据，先由全局把本类别登记在任');
      }
      if (!meId || String(holder.current.sessionId || '') !== meId) {
        throw new Error('只有在任者可以写：本类别现任为 ' + (holder.current.name || '?') + '（' + holder.current.sessionId + '），本会话为只读');
      }
      const list = Array.isArray(args.entries) ? args.entries : null;
      if (!list) throw new Error('write 需要 entries 数组（每项 path、about、when）');
      const entries = [];
      for (const raw of list) {
        const e = raw || {};
        const p = String(e.path === undefined || e.path === null ? '' : e.path).trim();
        const about = String(e.about === undefined || e.about === null ? '' : e.about).trim();
        const when = String(e.when === undefined || e.when === null ? '' : e.when).trim();
        if (!p) throw new Error('entries 里有空路径');
        for (const [field, val] of [['path', p], ['about', about], ['when', when]]) {
          if (val.indexOf('|') !== -1) throw new Error(field + ' 里不能出现竖线「|」（表格分隔符）：' + val);
          if (val.indexOf(String.fromCharCode(10)) !== -1) throw new Error(field + ' 里不能换行');
        }
        entries.push({ path: p, about, when });
      }
      const bad = validateEntries(ws, entries);
      if (bad.length) {
        const lines = ['未写入：下列路径不存在或不合法，逐条修正后重试。'];
        for (const b of bad) lines.push('  - ' + b.path + '：' + b.problem);
        lines.push('路径一律写工作区相对路径（例：Projects/<项目>/SKILL.md）。');
        throw new Error(lines.join(NL));
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      let backup = '';
      if (fs.existsSync(abs)) {
        backup = abs + '.bak';
        try { fs.copyFileSync(abs, backup); } catch { backup = ''; }
      }
      const body = renderDocmap(info, entries);
      const tmp = abs + '.tmp-' + process.pid;
      fs.writeFileSync(tmp, body, 'utf8');
      fs.renameSync(tmp, abs);
      let refreshed = false;
      try { if (typeof env.refreshPromptFor === 'function') refreshed = env.refreshPromptFor(meId) === true; } catch { refreshed = false; }
      const out = [];
      out.push('已写入 ' + rel + '（' + entries.length + ' 条）' + (backup ? '；原文件备份为 ' + path.basename(backup) : ''));
      out.push(refreshed ? '提示段已重装：下一轮即按新 map 注入。' : '提示段未能在本进程重装：重启 DSH 或让会话重建后生效。');
      out.push('建议精炼：每条一句介绍、一句时机即可；不设字数上限，但太长的介绍会挤占提示段。');
      if (!entries.length) out.push('空 map：不注入提示段（相当于撤销）。');
      return { text: out.join(NL) };
    },
  };
}
