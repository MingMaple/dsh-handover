/**
 * ho_init —— 首次安装：在用户给的目录里建「全局文件体系」，可选顺带注册为工作区。
 * 与设置页的「首次安装向导」同一套实现（lib/scaffold.mjs），因此两条路径行为一致。
 */
import fs from 'node:fs';
import { nameOf } from '../lib/names.mjs';
import path from 'node:path';
import { textOutput } from '../lib/output.mjs';
import { NL } from '../lib/text.mjs';
import { createGlobalWorkspace } from '../lib/scaffold.mjs';

export function pmInitTool(env) {
  return {
    name: nameOf('init'),
    description:
      '首次安装：在指定目录（不存在会创建）下建全局文件体系（根为 <目录>/_Workspace），可顺带注册工作区。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['parent'],
      properties: {
        parent: { type: 'string', description: '目标父目录绝对路径（不存在会创建）；全局根建在它里面' },
        name: { type: 'string', description: '全局根目录名，默认 _Workspace' },
        register: { type: 'boolean', description: '建好后顺带注册为工作区（默认 false）' },
        title: { type: 'string', description: 'register 时的工作区标题，默认「全局」' },
      },
    },
    output: textOutput(),
    async execute(args) {
      const r = createGlobalWorkspace(args.parent, { name: args.name });
      const out = [];
      if (!r.ok) {
        out.push('未建立：' + r.error);
        if (r.root) out.push('目标：' + r.root);
        out.push('');
        out.push('用法：ho_init(parent="<已存在的目录绝对路径>")。插件只新建、不覆盖。');
        return { text: out.join(NL) };
      }
      out.push('已建立全局文件体系：' + r.root);
      out.push('  目录 ' + r.created.length + ' 个：' + r.created.slice(0, 5).join('、') + (r.created.length > 5 ? ' 等' : ''));
      out.push('  文件 ' + r.written.length + ' 个：' + (r.written.length ? r.written.join('、') : '（都已存在，未覆盖）'));
      if (r.existed) out.push('  目标目录原为空目录，直接使用。');
      if (r.createdParent) out.push('  父目录原本不存在，已创建。');
      if (r.skipped.length) out.push('  跳过（已存在、未覆盖）：' + r.skipped.join('、'));

      let registered = null;
      if (args.register === true) {
        const reg = env.registry();
        if (!reg || typeof reg.create !== 'function') {
          out.push('');
          out.push('注册未完成：workspaceRegistry 不可用。请把下面这个路径粘进 DSH 的新建工作区窗口：');
          out.push('  ' + r.root);
          return { text: out.join(NL) };
        }
        const title = String(args.title || '').trim() || '全局';
        try {
          const w = await reg.create(r.root, title);
          registered = w;
          out.push('');
          out.push('已注册工作区：' + title + '（' + String(w && w.id ? w.id : '?') + '）');
        } catch (e) {
          out.push('');
          out.push('注册失败：' + String(e && e.message ? e.message : e));
          out.push('可把下面这个路径粘进 DSH 的新建工作区窗口：');
          out.push('  ' + r.root);
          return { text: out.join(NL) };
        }
      }

      out.push('');
      out.push('下一步：');
      if (!registered) {
        out.push('  1. 注册为工作区：ho_workspace(action="create", path="' + r.root + '", title="全局")，或把该路径粘进 DSH 的新建工作区窗口；');
        out.push('  2. 新建一个标题含「全局」的会话，闸门、交接体检、会话水位即接入。');
      } else {
        out.push('  新建一个标题含「全局」的会话，闸门、交接体检、会话水位即接入。');
      }
      out.push('（也可以在设置页的 dsh-handover 中完成「首次安装」，效果相同。）');
      return { text: out.join(NL) };
    },
  };
}
