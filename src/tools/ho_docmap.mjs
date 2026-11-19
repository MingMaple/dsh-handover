/**
 * ho_docmap —— 体系注册、计划、骨架、台账与规则正文（1.2 合并入口）。
 *
 * 动作：registry-read / registry-write / registry-check / plan-read / plan-write / plan-archive /
 *       profile-read / profile-register / profile-validate / profile-presets / changelog-append / rules-read。
 * 写入范围由会话已登记的角色决定：全局只写总注册，项目只写本项目注册，杂项只写本任务注册。
 * 写入者必须是在任会话（以 Office.json 为准）；已交出的旧会话只读。
 * 写入后重装本会话提示段，实现热更新。
 */
import path from 'node:path';
import { textOutput } from '../lib/output.mjs';
import { nameOf } from '../lib/names.mjs';
import { NL, isSafeName } from '../lib/text.mjs';
import { capText, STATUS_MAX_LINES } from '../lib/limit.mjs';
import { loadOffice, lineageKeyOf } from '../lib/office.mjs';
import {
  lineageOf, lineageLabel, registryRelPath, readRegistry, readGlobalRegistry,
  validateEntries, checkRegistries, writeRegistry, syncGlobalRefs,
  planRelPath, readPlan, writePlan, archivePlan, pointRegistryToPlan, planSectionProblems,
  GLOBAL_REGISTRY_REL,
} from '../lib/system.mjs';
import { TASK_NAME_MAX } from '../lib/role.mjs';
import { pmProfileTool } from './profile.mjs';
import { pmChangelogTool } from './changelog.mjs';
import { pmCharterTool } from './charter.mjs';

export const ACTIONS = ['read', 'write', 'check', 'plan'];
export const ENTRY_ACTIONS = [
  'registry-read', 'registry-write', 'registry-check',
  'plan-read', 'plan-write', 'plan-archive',
  'profile-read', 'profile-register', 'profile-validate', 'profile-presets',
  'changelog-append', 'rules-read',
];

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
    if (!isSafeName(t, TASK_NAME_MAX)) throw new Error('任务名不合法（当目录名用）：' + t);
    return { role: 'global-task', task: t };
  }
  return info;
}

function baseDocmapTool(env) {
  return {
    name: nameOf('docmap'),
    description:
      '体系注册与文档定位：读写与校验体系注册，读写并归档计划。全局总注册只列路径；全局任务用 `task` 读写自身注册与计划。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ACTIONS, description: '动作。缺省 `read`。' },
        entries: {
          type: 'array',
          description: '`write`：整份替换。每项含 `path`（工作区相对路径）、`about`（用途）、`when`（读取时机）与 `section`（`structure` 或 `files`，缺省 `files`）。',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['path', 'about'],
            properties: {
              path: { type: 'string', description: '工作区相对路径，必须存在。' },
              about: { type: 'string', description: '该文件的用途，一句话。例：`项目总览与索引`。' },
              when: { type: 'string', description: '读取该文件的时机，可选。例：`作业前`。' },
              section: { type: 'string', enum: ['structure', 'files'], description: '目录结构或规范文件。缺省 `files`。' },
            },
          },
        },
        mode: { type: 'string', enum: ['read', 'write', 'archive'], description: '`action=plan` 时的动作。缺省 `read`。' },
        text: { type: 'string', description: '`action=plan`、`mode=write` 时的计划正文。' },
        task: { type: 'string', description: '全局会话操作某个任务时给出的任务名。项目与杂项会话省略。' },
      },
    },
    output: textOutput(),
    async execute(args, exec) {
      const ws = env.resolveWs(exec);
      const { info, lin } = ownLineage(env, exec);
      if (!lin) throw new Error('现象：本会话没有角色。原因：体系注册只对全局、项目与杂项会话开放。处置：先在设置页设定角色，再调用。');
      const action = typeof args.action === 'string' && args.action ? args.action : 'read';
      if (ACTIONS.indexOf(action) === -1) throw new Error('现象：`action` 取值不在允许范围。原因：收到 `' + String(action) + '`，只接受 ' + ACTIONS.join('、') + '。处置：改用上述取值之一后重试。');
      const label = lineageLabel(info);
      const meId = String(env.selfId(exec) || '');
      const capped = (text, hint) => capText(text, { maxLines: STATUS_MAX_LINES, hint });

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
          return { text: capped(out.join(NL), '条目较多：先读某一类，全局任务用 `task` 指定；或在文件里按节定位。') };
        }
        if (lin.kind === 'global') {
          const g = readGlobalRegistry(ws);
          const out = ['体系注册（全局）  ' + GLOBAL_REGISTRY_REL, g.rows.length ? '任务 ' + g.rows.length + ' 个' : '暂无任务注册'];
          for (const r of g.rows) out.push('  ' + r.kind + '「' + r.task + '」  ' + r.path);
          return { text: capped(out.join(NL), '任务较多：按任务名用 `ho_docmap(action="registry-read", task="…")` 读取单个任务。') };
        }
        const reg = readRegistry(ws, info);
        const rel = registryRelPath(info);
        const out = ['体系注册（' + label + '）  ' + rel];
        out.push(reg.exists ? '状态  已设置，目录 ' + reg.data.structure.length + ' 条、规范 ' + reg.data.files.length + ' 条' : '状态  未设置（空注册只注入一句提示）');
        if (reg.data.plan) out.push('计划  ' + reg.data.plan);
        if (reg.data.structure.length) out.push('', '目录结构：', entriesText(reg.data.structure));
        if (reg.data.files.length) out.push('', '规范文件：', entriesText(reg.data.files));
        return { text: capped(out.join(NL), '条目较多：按名称在文件里定位。') };
      }

      if (action === 'check') {
        const res = lin.kind === 'global' ? checkRegistries(ws) : checkRegistries(ws, info);
        const out = ['体系注册体检  ' + (lin.kind === 'global' ? '全部任务' : label)];
        if (!res.rows.length) out.push('  尚无任何任务目录（空注册不注入正文，属正常）');
        for (const r of res.rows) {
          out.push('  ' + r.label + '  ' + r.rel + '  ' + (r.exists
            ? r.entries + ' 条  ' + (r.bad.length ? '失效 ' + r.bad.length + ' 条' : '路径全部存在')
            : '未设置（缺 System.md）'));
          for (const b of r.bad.slice(0, 5)) out.push('        失效：' + b.path + ' —— ' + b.problem);
        }
        out.push(res.missing
          ? '判定：' + res.missing + ' 条路径失效。处置：由该类别在任会话用 `ho_docmap(action="registry-write")` 更新。'
          : res.unset
            ? '判定：' + res.unset + ' 个任务未设置体系注册。处置：由该类别在任会话用 `ho_docmap(action="registry-write")` 建立。'
            : '判定：路径全部存在。');
        return { text: out.join(NL) };
      }

      if (action === 'plan') {
        const mode = typeof args.mode === 'string' && args.mode ? args.mode : 'read';
        let target = null;
        try { target = targetInfoFor(info, args.task); } catch (e) { throw e; }
        if (!target) throw new Error('现象：全局会话未指定任务。原因：全局会话读写计划须给出任务名。处置：传入 `task` 后重试。');
        const rel = planRelPath(ws, target);
        if (!rel) throw new Error('现象：没有可用的计划路径。原因：角色未定，无法解析计划位置。处置：先为会话设定角色，再重试。');
        if (mode === 'read') {
          const p = readPlan(ws, target);
          if (!p.exists) return { text: '计划未建立：`' + rel + '`。处置：层二任务应先写计划，模板见 `_Control_Center/templates/Plan.skeleton.md`。' };
          if (p.error) throw new Error(p.error);
          return { text: capped(p.text, '计划较长：用 read 工具带 offset 与 limit 直接读文件，或按节读。') };
        }
        if (mode === 'archive') {
          const archived = archivePlan(ws, target);
          return { text: archived ? '旧计划已归档：`' + archived + '`。' : '没有可归档的旧计划：`' + rel + '`。' };
        }
        const text = String(args.text || '');
        if (!text.trim()) throw new Error('现象：`mode=write` 缺少 `text`。原因：写入计划须提供正文。处置：传入非空的 `text` 后重试。');
        const missing = planSectionProblems(text);
        if (missing.length) {
          throw new Error('现象：计划缺少模板要求的节：' + missing.join('、') + '。原因：计划须按模板的 5 节结构写入。'
            + '处置：（1）先读模板 `_Control_Center/templates/Plan.skeleton.md`，按 5 节写入；'
            + '（2）写新计划前先把上一份计划归档到任务根的 `_archive/`。'
            + '归档后不再读取旧计划，也不得在旧计划上改写。');
        }
        const r = writePlan(ws, target, text);
        let pointed = false;
        try { pointed = pointRegistryToPlan(ws, target); } catch { pointed = false; }
        let refreshed = false;
        try { refreshed = env.refreshPromptFor(meId) === true; } catch { refreshed = false; }
        const out = ['已写入计划 `' + r.rel + '`（' + r.bytes + ' B）' + (r.archived ? '；旧计划已归档 `' + r.archived + '`' : '；无旧计划')];
        out.push(pointed ? '注册已指向该计划。' : '本任务尚无体系注册，写入注册后再指向计划。');
        out.push(refreshed ? '提示段已重装。' : '现象：提示段未能当场重装。处置：下一轮或重启后生效。');
        return { text: out.join(NL) };
      }

      // action=write
      const holder = holderOf(ws, lin);
      if (!holder.current) {
        throw new Error('现象：在任登记表中没有「' + (holder.key || label) + '」的在任记录。原因：写入以在任登记为据。处置：先完成名称注册，即 `ho_sessions(action="office-register")`。');
      }
      if (!meId || String(holder.current.sessionId || '') !== meId) {
        throw new Error('现象：当前会话为只读。原因：该登记的在任会话为 ' + (holder.current.name || '?') + '（' + holder.current.sessionId + '）。处置：由该在任会话执行写入。');
      }

      if (lin.kind === 'global' && !String(args.task || '').trim()) {
        const g = syncGlobalRefs(ws);
        let refreshed = false;
        try { refreshed = env.refreshPromptFor(meId) === true; } catch { refreshed = false; }
        const out = ['已按磁盘任务重建全局总注册 ' + GLOBAL_REGISTRY_REL + '（' + g.rows.length + ' 个任务）'];
        for (const r of g.rows) out.push('  ' + r.kind + '「' + r.task + '」  ' + r.path);
        out.push(refreshed ? '提示段已重装：下一轮即注入引用清单。' : '现象：提示段未能当场重装。处置：重启 DSH 或让会话重建后生效。');
        return { text: out.join(NL) };
      }

      // 全局任务：由全局会话直接维护该任务的体系注册。
      const writeInfo = lin.kind === 'global'
        ? targetInfoFor(info, String(args.task || '').trim())
        : info;
      if (!writeInfo) throw new Error('现象：全局会话写任务注册时未指定任务。原因：任务注册须绑定任务名。处置：传入 `task` 后重试。');
      const list = Array.isArray(args.entries) ? args.entries : null;
      if (!list) throw new Error('现象：`write` 缺少 `entries` 数组。原因：整份替换须提供条目清单。处置：按 `path`、`about`、`when` 与 `section` 4 项组装后再调用。');
      const structure = [];
      const files = [];
      for (const raw of list) {
        const e = raw || {};
        const p = String(e.path === undefined || e.path === null ? '' : e.path).trim();
        const about = String(e.about === undefined || e.about === null ? '' : e.about).trim();
        const when = String(e.when === undefined || e.when === null ? '' : e.when).trim();
        const section = e.section === 'structure' ? 'structure' : 'files';
        if (!p) throw new Error('现象：`entries` 中有条目的 `path` 为空。原因：注册条目必须给出工作区相对路径。处置：补齐 `path` 后重试。');
        for (const [field, val] of [['path', p], ['about', about], ['when', when]]) {
          if (val.indexOf('|') !== -1) throw new Error('现象：`' + field + '` 含竖线「|」，该字符是表格分隔符：' + val + '。原因：注册写入 Markdown 表格，竖线会破坏列结构。处置：删除竖线后重试。');
          if (val.indexOf(String.fromCharCode(10)) !== -1) throw new Error('现象：`' + field + '` 含换行符。原因：注册每个条目占一行。处置：删除换行符后重试。');
        }
        (section === 'structure' ? structure : files).push({ path: p, about, when });
      }
      const bad = validateEntries(ws, structure.concat(files));
      if (bad.length) {
        const lines = ['现象：未写入，下列路径不存在或不合法。原因：注册只接受已存在的工作区相对路径。'];
        for (const b of bad) lines.push('  - ' + b.path + '：' + b.problem);
        lines.push('处置：逐条修正后重试。路径例 `Projects/<项目>/README.md`。');
        throw new Error(lines.join(NL));
      }
      const cur = readRegistry(ws, writeInfo);
      const plan = cur.data.plan || '';
      if (plan) {
        const problem = validateEntries(ws, [{ path: plan }]);
        if (problem.length) throw new Error('现象：注册中的计划路径已失效：`' + plan + '`。原因：该计划文件已被移动或删除。处置：先修正计划，即 `ho_docmap(action="plan-write")`，或删除该行。');
      }
      const r = writeRegistry(ws, writeInfo, { structure, files, plan });
      if (lin.kind === 'global') syncGlobalRefs(ws);
      let refreshed = false;
      try { refreshed = env.refreshPromptFor(meId) === true; } catch { refreshed = false; }
      const out = [];
      out.push('已写入 `' + registryRelPath(writeInfo) + '`（目录 ' + structure.length + ' 条、规范 ' + files.length + ' 条）'
        + (r.backup ? '；原文件备份为 `' + path.basename(r.backup) + '`' : ''));
      out.push(refreshed ? '提示段已重装：下一轮即按新注册注入。' : '现象：提示段未能当场重装。处置：重启 DSH 或让会话重建后生效。');
      out.push('只给路径与用途。不设字数上限，但过长的用途会挤占提示段。');
      return { text: out.join(NL) };
    },
  };
}

/**
 * 构造 `docmap` 合并入口。
 *
 * 12 个动作合用一个工具以减少工具数，实现分派到注册、骨架、台账与规则各子工具。
 *
 * @param {object} env 插件环境，提供 `resolveWs`、`roleOf`、`selfId` 与 `refreshPromptFor`。
 * @returns {object} 工具定义，供宿主注册。
 * 副作用：写注册、计划与台账；写后重装本会话提示段。
 */
export function pmDocmapTool(env) {
  const base = baseDocmapTool(env);
  const profile = pmProfileTool(env);
  const changelog = pmChangelogTool(env);
  const charter = pmCharterTool(env);
  return {
    name: nameOf('docmap'),
    description: '体系注册、计划、骨架、台账与规则正文。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ENTRY_ACTIONS,
          description: '动作，必填。例：`registry-read`；各动作所需参数见下。',
        },
        entries: {
          type: 'array',
          description: '`registry-write` 的条目清单，整份替换。例：`[{"path":"…","about":"…"}]`。',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['path', 'about'],
            properties: {
              path: { type: 'string', description: '工作区相对路径，必须已存在。例：`Projects/Demo/README.md`。' },
              about: { type: 'string', description: '该文件的用途，一句话。例：`项目总览与索引`。' },
              when: { type: 'string', description: '读取该文件的时机，可省略。例：`作业前`。' },
              section: { type: 'string', enum: ['structure', 'files'], description: '归入「目录结构」或「规范文件」。缺省 `files`。' },
            },
          },
        },
        text: { type: 'string', description: '`plan-write` 的计划正文，须含模板 5 节。例：见 `Plan.skeleton.md`。' },
        task: { type: 'string', description: '全局会话读写某个任务时给出的任务名。例：`巡检`。' },
        project: { type: 'string', description: '`profile-*` 动作的项目名，全局会话必填。例：`Demo`。' },
        kind: { type: 'string', description: '`profile-presets` 取的预设类型。缺省返回全部预设。例：`project`。' },
        summary: { type: 'string', description: '`changelog-append` 的台账内容，写明变更与原因。例：`新增合并入口`。' },
        executor: { type: 'string', description: '`changelog-append` 的执行者，缺省为本会话 id。例：`全局1`。' },
        date: { type: 'string', description: '`changelog-append` 的日期，格式 `YYYY-MM-DD`。缺省当天。' },
        doc: { type: 'string', description: '`rules-read` 的文档名，`runtime` 为完整流程手册。例：`charter`。' },
        section: { type: 'string', description: '`rules-read` 的节标题片段；省略时只返回目录。例：`8.1.1.4`。' },
        maxLines: { type: 'number', description: '`rules-read` 最多返回的行数，缺省 120。例：`60`。' },
      },
    },
    output: textOutput(),
    async execute(args, exec) {
      const action = String(args.action || '');
      if (ENTRY_ACTIONS.indexOf(action) === -1) {
        throw new Error('现象：`action` 取值不在允许范围。原因：收到 `' + action + '`。处置：改用 ' + ENTRY_ACTIONS.join('、') + ' 之一后重试。');
      }
      if (action === 'plan-write' && (typeof args.text !== 'string' || args.text.trim() === '')) {
        throw new Error('现象：`plan-write` 缺少 `text`。原因：写入计划须提供正文。处置：传入非空的 `text` 后重试。');
      }
      if (action === 'changelog-append' && (typeof args.summary !== 'string' || args.summary.trim() === '')) {
        throw new Error('现象：`changelog-append` 缺少 `summary`。原因：台账须记录变更内容与原因。处置：传入非空的 `summary` 后重试。');
      }
      if (action === 'registry-write') {
        let info = null;
        try { info = env.roleOf(exec); } catch { info = null; }
        const rebuildAll = info && info.role === 'global' && !String(args.task || '').trim();
        if (!rebuildAll && !Array.isArray(args.entries)) {
          throw new Error('现象：`registry-write` 缺少 `entries` 数组。原因：整份替换须提供条目清单。处置：按 `path`、`about`、`when` 与 `section` 组装后再调用。');
        }
      }
      if (action === 'registry-read') return base.execute({ action: 'read', task: args.task }, exec);
      if (action === 'registry-write') return base.execute({ action: 'write', task: args.task, entries: args.entries }, exec);
      if (action === 'registry-check') return base.execute({ action: 'check' }, exec);
      if (action === 'plan-read') return base.execute({ action: 'plan', mode: 'read', task: args.task }, exec);
      if (action === 'plan-write') return base.execute({ action: 'plan', mode: 'write', task: args.task, text: args.text }, exec);
      if (action === 'plan-archive') return base.execute({ action: 'plan', mode: 'archive', task: args.task }, exec);
      if (action === 'profile-read') return profile.execute({ action: 'read', project: args.project, task: args.task }, exec);
      if (action === 'profile-register') return profile.execute({ action: 'register', project: args.project, task: args.task }, exec);
      if (action === 'profile-validate') return profile.execute({ action: 'validate', project: args.project, task: args.task }, exec);
      if (action === 'profile-presets') return profile.execute({ action: 'presets', kind: args.kind }, exec);
      if (action === 'changelog-append') return changelog.execute({ summary: args.summary, executor: args.executor, date: args.date }, exec);
      return charter.execute({ doc: args.doc, section: args.section, maxLines: args.maxLines }, exec);
    },
  };
}
