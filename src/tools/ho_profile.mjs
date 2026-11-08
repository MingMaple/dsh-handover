/** ho_profile —— 项目与杂项的骨架档案：读、注册、校验、取预设。 */
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
      throw new Error('本会话是' + (info.role === 'project' ? '项目「' + own + '」' : '杂项「' + own + '」')
        + '，只能读写自己的骨架；要看「' + given + '」请由全局会话执行 ho_profile。');
    }
    return { role: info.role, project: info.project || '', task: info.task || '', self: true };
  }
  if (info && info.role === 'global') {
    if (args.project) return { role: 'project', project: assertProjectName(String(args.project)), task: '', self: false };
    if (args.task) return { role: 'misc', project: '', task: assertTaskName(String(args.task)), self: false };
    throw new Error('全局会话使用 ho_profile 时须给 project 或 task');
  }
  throw new Error('普通会话不参与骨架注册');
}

function scopeOf(t) {
  return t.role === 'project' ? '项目「' + t.project + '」' : '杂项任务「' + t.task + '」';
}

export function pmProfileTool(env) {
  return {
    name: nameOf('profile'),
    description: '项目或杂项骨架：读取、注册、校验、取预设。只写本角色的 _Project_Meta 或 _Misc 目录。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['read', 'register', 'validate', 'presets'], description: '缺省 read' },
        project: { type: 'string', description: '全局会话读取或校验时的项目名' },
        task: { type: 'string', description: '全局会话读取或校验时的任务名' },
        kind: { type: 'string', enum: PROFILE_KINDS, description: 'presets 时取指定预设；缺省返回全部' },
      },
    },
    output: textOutput(),
    async execute(args, exec) {
      const action = typeof args.action === 'string' && args.action ? args.action : 'read';
      const ws = env.resolveWs(exec);
      if (!ws) throw new Error('没有工作区根');
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
        const v = validateProfile(ws, scope, r.profile);
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
        const v = validateProfile(ws, scope, r.profile);
        const out = [
          '骨架校验：' + scopeOf(t),
          '文件：' + (p || '（无）'),
          '结论：' + (v.ok ? '通过' : '未通过'),
        ];
        if (v.missing.length) out.push('缺：' + v.missing.join('、'));
        if (r.errors.length || v.errors.length) out.push('结构错误：' + r.errors.concat(v.errors).join('；'));
        return { text: out.join(NL) };
      }
      if (action === 'register') {
        if (!t.self) throw new Error('注册须由该项目或杂项会话本人执行');
        if (!r.exists) throw new Error('未找到骨架文件：' + p + '。先通读本库并写入该文件，再执行注册。');
        if (r.errors.length) throw new Error('骨架结构不合法：' + r.errors.join('；'));
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
        if (v.missing.length) out.push('尚缺：' + v.missing.join('、') + '（补齐后 ho_profile(action=validate) 复核）');
        else out.push('校验：通过');
        return { text: out.join(NL) };
      }
      throw new Error('未知 action：' + action);
    },
  };
}
