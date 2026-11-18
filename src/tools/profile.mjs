/** 骨架档案实现 —— 项目与杂项的骨架：读、注册、校验、取预设。经 ho_docmap 的 profile-* 动作暴露。 */
import { textOutput } from '../lib/output.mjs';
import { nameOf } from '../lib/names.mjs';
import { NL } from '../lib/text.mjs';
import { presets, readProfile, writeProfile, validateProfile, profilePathFor, PROFILE_KINDS } from '../lib/profile.mjs';
import { assertProjectName, assertTaskName } from '../lib/role.mjs';
import { stampTz } from '../lib/brief.mjs';

function targetOf(env, info, args, exec) {
  if (info && (info.role === 'project' || info.role === 'misc')) {
    const own = info.role === 'project' ? String(info.project || '') : String(info.task || '');
    const given = String(args.project || args.task || '').trim();
    // 项目会话只处理自己的骨架；传了别的名字就明确报错，而不是静默忽略入参（实测踩过）。
    if (given && given !== own) {
      throw new Error('现象：本会话为' + (info.role === 'project' ? '项目「' + own + '」' : '杂项「' + own + '」')
        + '，无权读写「' + given + '」的骨架。原因：项目与杂项会话只能读写自身骨架。处置：改由全局会话执行 ho_docmap 的 profile-* 动作。');
    }
    return { role: info.role, project: info.project || '', task: info.task || '', self: true };
  }
  if (info && info.role === 'global') {
    if (args.project) return { role: 'project', project: assertProjectName(String(args.project)), task: '', self: false };
    if (args.task) return { role: 'misc', project: '', task: assertTaskName(String(args.task)), self: false };
    throw new Error('现象：全局会话未指定目标。原因：全局会话须指明项目或任务。处置：传入 `project` 或 `task` 后重试。');
  }
  throw new Error('现象：本会话为普通会话。原因：骨架注册只对全局、项目与杂项会话开放。处置：先在设置页设定角色，再调用。');
}

function scopeOf(t) {
  return t.role === 'project' ? '项目「' + t.project + '」' : '杂项任务「' + t.task + '」';
}

/**
 * 构造 `profile` 工具定义。
 *
 * 项目与杂项会话只能读写自身骨架，越界直接报错而不是静默忽略。
 *
 * @param {object} env 插件环境，提供 `resolveWs`、`roleOf` 与 `writeRole`。
 * @returns {object} 工具定义，供宿主注册。
 * 副作用：注册时写回骨架文件并更新角色表。
 */
export function pmProfileTool(env) {
  return {
    name: nameOf('profile'),
    description: '项目或杂项骨架：读取、注册、校验与取预设。只写本角色对应的 `_Project_Meta` 或 `_Misc` 目录。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['read', 'register', 'validate', 'presets'], description: '动作。缺省 `read`。例：`validate`。' },
        project: { type: 'string', description: '全局会话读取或校验时指定的项目名。例：`Demo`。' },
        task: { type: 'string', description: '全局会话读取或校验时指定的任务名。例：`巡检`。' },
        kind: { type: 'string', enum: PROFILE_KINDS, description: '`presets` 时取指定预设；缺省返回全部。例：`project`。' },
      },
    },
    output: textOutput(),
    async execute(args, exec) {
      const action = typeof args.action === 'string' && args.action ? args.action : 'read';
      const ws = env.resolveWs(exec);
      if (!ws) throw new Error('现象：未找到工作区根。原因：本实例尚未接入工作区。处置：先在设置页接入工作区，再重试。');
      if (action === 'presets') {
        const all = presets();
        const one = args.kind && all[args.kind] ? { [args.kind]: all[args.kind] } : all;
        return { text: JSON.stringify(one, null, 2) };
      }
      const info = env.roleOf(exec);
      const t = targetOf(env, info, args, exec);
      const scope = { role: t.role, project: t.project, task: t.task };
      const p = profilePathFor(ws, scope);
      const r = readProfile(ws, scope);
      if (action === 'read') {
        const v = validateProfile(ws, scope);
        const out = [
          '骨架：' + scopeOf(t) + '（' + (r.exists ? '已注册' : '未注册，按默认骨架运行') + '）',
          '文件：' + (p || '（无）'),
        ];
        out.push(JSON.stringify(r.profile, null, 2));
        out.push('校验：' + (v.ok ? '通过' : '未通过') + (v.missing.length ? '；缺 ' + v.missing.join('、') : ''));
        if (r.errors.length) out.push('结构错误：' + r.errors.join('；'));
        return { text: out.join(NL) };
      }
      if (action === 'validate') {
        const v = validateProfile(ws, scope);
        const out = [
          '骨架校验：' + scopeOf(t),
          '文件：' + (p || '（无）'),
          '结论：' + (v.ok ? '通过' : '未通过'),
        ];
        if (v.missing.length) out.push('缺：' + v.missing.join('、'));
        if (v.errors.length) out.push('结构错误：' + v.errors.join('；'));
        return { text: out.join(NL) };
      }
      if (action === 'register') {
        if (!t.self) throw new Error('现象：当前会话不能执行注册。原因：注册须由该项目或杂项会话自身执行。处置：改由对应会话执行 `ho_docmap(action="profile-register")`。');
        if (!r.exists) throw new Error('现象：未找到骨架文件 `' + p + '`。原因：该目录尚未写入骨架档案。处置：先通读本库并写入该文件，再执行注册。');
        if (r.errors.length) throw new Error('现象：骨架结构不合法。原因：' + r.errors.join('；') + '。处置：按上述结论修正后重试。');
        const saved = writeProfile(ws, scope, r.profile);
        const v = validateProfile(ws, scope, saved.profile);
        const sid = env.selfId(exec);
        if (sid && typeof env.writeRole === 'function') {
          try { env.writeRole(sid, { profileAt: stampTz(Date.now()), profileKind: saved.profile.kind }); } catch { /* 角色表写失败不影响注册 */ }
        }
        const out = [
          '已注册骨架：' + scopeOf(t),
          '文件：' + saved.path,
          '类别：' + saved.profile.kind + '；约束条校验：' + (saved.profile.gate.libraryBlock ? '启用' : '不启用'),
        ];
        if (v.missing.length) out.push('尚缺：' + v.missing.join('、') + '。处置：补齐后执行 `ho_docmap(action="profile-validate")` 复核。');
        else out.push('校验：通过');
        return { text: out.join(NL) };
      }
      throw new Error('现象：`action` 取值未知：`' + action + '`。原因：该取值不在允许清单内。处置：改用 read、register、validate 与 presets 之一。');
    },
  };
}
