/**
 * ho_docmap —— 体系注册与文档定位（1.0）。
 *
 * 动作：read 读、write 写、check 校验路径、plan 读写与归档行动计划。
 * 写入范围由会话已登记的角色决定：全局只写总注册，项目只写本项目注册，杂项只写本任务注册。
 * 写入者必须是在任会话（以 Office.json 为准）；已交出的旧会话只读。
 * 写入后重装本会话提示段，实现热更新。
 */
import fs from 'node:fs';
import path from 'node:path';
import { textOutput } from '../lib/output.mjs';
import { nameOf } from '../lib/names.mjs';
import { NL } from '../lib/text.mjs';
import { loadOffice, lineageKeyOf } from '../lib/office.mjs';
import {
  lineageOf, lineageLabel, registryRelPath, registryAbsPath, readRegistry, readGlobalRegistry,
  validateEntries, checkRegistries, writeRegistry, syncGlobalRefs,
  planRelPath, readPlan, writePlan, archivePlan, pointRegistryToPlan,
  GLOBAL_REGISTRY_REL, REGISTRY_NAME,
} from '../lib/system.mjs';
import { taskNameOk } from '../lib/role.mjs';

export const ACTIONS = ['read', 'write', 'check', 'plan'];

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
  if (!entries.length) return '（空：不注入正文）';
  return entries.map((e) => '- ' + e.path + (e.about ? ' —— ' + e.about : '') + (e.when ? '（' + e.when + '）' : '')).join(NL);
}

function targetInfoFor(info, task) {
  if (info && info.role === 'global') {
    const t = String(task || '').trim();
    if (!t) return null;
    if (!taskNameOk(t)) throw new Error('任务名不合法（当目录名用）：' + t);
    return { role: 'global-task', task: t };
  }
  return info;
}

function nodePath(ws, ...parts) {
  return path.join(String(ws || ''), ...parts);
}

export function pmDocmapTool(env) {
  return {
    name: nameOf('docmap'),
    description:
      '体系注册与文档定位：read 读、write 写（逐条校验路径存在）、check 校验、plan 读写并归档行动计划；全局总注册只列路径，全局任务用 task 读写自身注册与计划。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ACTIONS, description: '缺省 read' },
        entries: {
          type: 'array',
          description: 'write：整份替换。每项 { path: 工作区相对路径, about: 用途, when: 读取时机, section: structure|files }；section 缺省 files',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['path', 'about'],
            properties: {
              path: { type: 'string', description: '工作区相对路径，必须存在' },
              about: { type: 'string', description: '用途，一句话' },
              when: { type: 'string', description: '读取时机（可选）' },
              section: { type: 'string', enum: ['structure', 'files'], description: '目录结构或规范文件（缺省 files）' },
            },
          },
        },
        mode: { type: 'string', enum: ['read', 'write', 'archive'], description: 'action=plan 时的动作，缺省 read' },
        text: { type: 'string', description: 'action=plan、mode=write 时的行动计划正文' },
        task: { type: 'string', description: '全局会话操作某个任务时给任务名（项目与杂项会话省略）' },
      },
    },
    output: textOutput(),
    async execute(args, exec) {
      const ws = env.resolveWs(exec);
      const { info, lin } = ownLineage(env, exec);
      if (!lin) throw new Error('本会话没有角色：体系注册只对全局、项目、杂项会话开放');
      const action = typeof args.action === 'string' && args.action ? args.action : 'read';
      if (ACTIONS.indexOf(action) === -1) throw new Error('action 只能是 ' + ACTIONS.join(' | ') + '（收到 ' + String(action) + '）');
      const label = lineageLabel(info);
      const meId = String(env.selfId(exec) || '');

      if (action === 'read') {
        const taskName = String(args.task || '').trim();
        if (lin.kind === 'global' && taskName) {
          const target = targetInfoFor(info, taskName);
          const reg = readRegistry(ws, target);
          const rel = registryRelPath(target);
          const out = ['体系注册（' + lineageLabel(target) + '）  ' + rel];
          out.push(reg.exists ? '状态  已设置，目录 ' + reg.data.structure.length + ' 条、规范 ' + reg.data.files.length + ' 条' : '状态  未设置');
          if (reg.data.plan) out.push('计划  ' + reg.data.plan);
          if (reg.data.structure.length) out.push('', '目录结构：', entriesText(reg.data.structure));
          if (reg.data.files.length) out.push('', '规范文件：', entriesText(reg.data.files));
          return { text: out.join(NL) };
        }
        if (lin.kind === 'global') {
          const g = readGlobalRegistry(ws);
          const out = ['体系注册（全局）  ' + GLOBAL_REGISTRY_REL, g.rows.length ? '任务 ' + g.rows.length + ' 个' : '暂无任务注册'];
          for (const r of g.rows) out.push('  ' + r.kind + '「' + r.task + '」  ' + r.path);
          return { text: out.join(NL) };
        }
        const reg = readRegistry(ws, info);
        const rel = registryRelPath(info);
        const out = ['体系注册（' + label + '）  ' + rel];
        out.push(reg.exists ? '状态  已设置，目录 ' + reg.data.structure.length + ' 条、规范 ' + reg.data.files.length + ' 条' : '状态  未设置（空注册只注入一句提示）');
        if (reg.data.plan) out.push('计划  ' + reg.data.plan);
        if (reg.data.structure.length) out.push('', '目录结构：', entriesText(reg.data.structure));
        if (reg.data.files.length) out.push('', '规范文件：', entriesText(reg.data.files));
        return { text: out.join(NL) };
      }

      if (action === 'check') {
        const res = lin.kind === 'global' ? checkRegistries(ws) : checkRegistries(ws, info);
        const out = ['体系注册体检  ' + (lin.kind === 'global' ? '全部任务' : label)];
        if (!res.rows.length) out.push('  尚无任何任务注册（空注册不注入正文，属正常）');
        for (const r of res.rows) {
          out.push('  ' + r.label + '  ' + r.rel + '  ' + (r.exists ? r.entries + ' 条' : '未设置') + '  ' + (r.bad.length ? '失效 ' + r.bad.length + ' 条' : '路径全部存在'));
          for (const b of r.bad.slice(0, 5)) out.push('        失效：' + b.path + ' —— ' + b.problem);
        }
        out.push(res.missing ? '判定：' + res.missing + ' 条路径失效，由该类别在任会话用 ho_docmap(action="write") 更新。' : '判定：路径全部存在。');
        return { text: out.join(NL) };
      }

      if (action === 'plan') {
        const mode = typeof args.mode === 'string' && args.mode ? args.mode : 'read';
        let target = null;
        try { target = targetInfoFor(info, args.task); } catch (e) { throw e; }
        if (!target) throw new Error('全局会话读写计划时须给 task（任务名）');
        const rel = planRelPath(ws, target);
        if (!rel) throw new Error('没有可用的计划路径：角色未定');
        if (mode === 'read') {
          const p = readPlan(ws, target);
          if (!p.exists) return { text: '计划未建立：' + rel + NL + '层二任务应先写行动计划，模板见 _Control_Center/templates/Plan.skeleton.md。' };
          if (p.error) throw new Error(p.error);
          return { text: p.text };
        }
        if (mode === 'archive') {
          const archived = archivePlan(ws, target);
          return { text: archived ? '旧计划已归档：' + archived : '没有可归档的旧计划：' + rel };
        }
        const text = String(args.text || '');
        if (!text.trim()) throw new Error('mode=write 需要 text（行动计划正文）');
        const r = writePlan(ws, target, text);
        let pointed = false;
        try { pointed = pointRegistryToPlan(ws, target); } catch { pointed = false; }
        let refreshed = false;
        try { refreshed = env.refreshPromptFor(meId) === true; } catch { refreshed = false; }
        const out = ['已写入计划 ' + r.rel + '（' + r.bytes + ' B）' + (r.archived ? '；旧计划已归档 ' + r.archived : '；无旧计划')];
        out.push(pointed ? '注册已指向该计划。' : '本任务尚无体系注册，写入注册后再指向计划。');
        out.push(refreshed ? '提示段已重装。' : '提示段未能当场重装：下一轮或重启后生效。');
        return { text: out.join(NL) };
      }

      // action=write
      const holder = holderOf(ws, lin);
      if (!holder.current) {
        throw new Error('名册里没有「' + (holder.key || label) + '」的在任记录：以在任记录为写入依据，先完成名称注册（ho_office action="register"）');
      }
      if (!meId || String(holder.current.sessionId || '') !== meId) {
        throw new Error('只有在任会话可以写：本条登记的在任会话为 ' + (holder.current.name || '?') + '（' + holder.current.sessionId + '），本会话为只读');
      }

      if (lin.kind === 'global' && !String(args.task || '').trim()) {
        const g = syncGlobalRefs(ws);
        let refreshed = false;
        try { refreshed = env.refreshPromptFor(meId) === true; } catch { refreshed = false; }
        const out = ['已按磁盘任务重建全局总注册 ' + GLOBAL_REGISTRY_REL + '（' + g.rows.length + ' 个任务）'];
        for (const r of g.rows) out.push('  ' + r.kind + '「' + r.task + '」  ' + r.path);
        out.push(refreshed ? '提示段已重装：下一轮即注入引用清单。' : '提示段未能当场重装：重启 DSH 或让会话重建后生效。');
        return { text: out.join(NL) };
      }

      // 全局任务：由全局会话直接维护该任务的体系注册。
      const writeInfo = lin.kind === 'global'
        ? targetInfoFor(info, String(args.task || '').trim())
        : info;
      if (!writeInfo) throw new Error('全局会话写任务注册时需要 task（任务名）');
      const list = Array.isArray(args.entries) ? args.entries : null;
      if (!list) throw new Error('write 需要 entries 数组（每项 path、about、when、section）');
      const structure = [];
      const files = [];
      for (const raw of list) {
        const e = raw || {};
        const p = String(e.path === undefined || e.path === null ? '' : e.path).trim();
        const about = String(e.about === undefined || e.about === null ? '' : e.about).trim();
        const when = String(e.when === undefined || e.when === null ? '' : e.when).trim();
        const section = e.section === 'structure' ? 'structure' : 'files';
        if (!p) throw new Error('entries 里有空路径');
        for (const [field, val] of [['path', p], ['about', about], ['when', when]]) {
          if (val.indexOf('|') !== -1) throw new Error(field + ' 里不能出现竖线「|」（表格分隔符）：' + val);
          if (val.indexOf(String.fromCharCode(10)) !== -1) throw new Error(field + ' 里不能换行');
        }
        (section === 'structure' ? structure : files).push({ path: p, about, when });
      }
      const bad = validateEntries(ws, structure.concat(files));
      if (bad.length) {
        const lines = ['未写入：下列路径不存在或不合法，逐条修正后重试。'];
        for (const b of bad) lines.push('  - ' + b.path + '：' + b.problem);
        lines.push('路径一律写工作区相对路径（例：Projects/<项目>/README.md）。');
        throw new Error(lines.join(NL));
      }
      const cur = readRegistry(ws, writeInfo);
      const plan = cur.data.plan || '';
      if (plan) {
        const problem = validateEntries(ws, [{ path: plan }]);
        if (problem.length) throw new Error('注册里的计划路径已失效：' + plan + NL + '先修正计划（ho_docmap action="plan"）或删除该行。');
      }
      const r = writeRegistry(ws, writeInfo, { structure, files, plan });
      if (lin.kind === 'global') syncGlobalRefs(ws);
      let refreshed = false;
      try { refreshed = env.refreshPromptFor(meId) === true; } catch { refreshed = false; }
      const out = [];
      out.push('已写入 ' + registryRelPath(writeInfo) + '（目录 ' + structure.length + ' 条、规范 ' + files.length + ' 条）'
        + (r.backup ? '；原文件备份为 ' + path.basename(r.backup) : ''));
      out.push(refreshed ? '提示段已重装：下一轮即按新注册注入。' : '提示段未能当场重装：重启 DSH 或让会话重建后生效。');
      out.push('只给路径与用途；不设字数上限，但过长的用途会挤占提示段。');
      return { text: out.join(NL) };
    },
  };
}
