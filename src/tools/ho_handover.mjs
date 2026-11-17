/** ho_handover —— 读/写/换任重写/归档本会话交接，并登记压缩。（路径按角色解析；rotate 先归档旧交接，写后按角色体检。） */
import { textOutput } from '../lib/output.mjs';
import { nameOf } from '../lib/names.mjs';
import { NL } from '../lib/text.mjs';
import { capText, HANDOVER_MAX_LINES } from '../lib/limit.mjs';
import path from 'node:path';
import {
  readHandover, writeHandover, rewriteHandover, archiveHandover, handoverMtimeMs, fileSha256, carryItemsOf,
} from '../lib/handover-io.mjs';
import { assertTaskName } from '../lib/role.mjs';
import { assistantCompact } from './compact.mjs';

export const ACTIONS = ['read', 'write', 'rotate', 'archive', 'compact'];

function noPath(input) {
  const reason = input && input.reason ? input.reason : '未知原因';
  return [
    '现象：没有可用的交接路径。原因：' + reason + '。',
    '处置：',
    '  （1）在设置页打开 dsh-handover 的「会话角色」，为会话指定角色。项目角色须填项目名。',
    '  （2）临时显式传 `path="<交接文件绝对路径>"`。',
    '（插件不再默认读全局交接；旧版行为会导致角色串用。）',
  ].join(NL);
}

/**
 * 构造 `handover` 工具定义。
 *
 * `write` 只用于首次创建，改写一律走 `rotate`，避免覆盖未归档的旧交接。
 *
 * @param {object} env 插件环境，提供 `resolveWs`、`roleOf`、`handoverFor` 与 `noteHandoverStep`。
 * @returns {object} 工具定义，供宿主注册。
 * 副作用：写交接、归档旧交接、登记压缩结果。
 */
export function pmHandoverTool(env) {
  return {
    name: nameOf('handover'),
    description: '本会话交接读写、换任重写与轮内压缩。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ACTIONS, description: '动作。rotate 归档旧交接并写入新正文；compact 轮内压缩。' },
        text: { type: 'string', description: '`write`、`rotate` 的交接正文，不得为空。' },
        path: { type: 'string', description: '交接文件绝对路径；省略时按本会话角色解析。' },
        task: { type: 'string', description: '全局会话读写某任务交接时给的任务名。例：`巡检`。' },
        offset: { type: 'integer', description: 'read 起始行，从 1 计。例：`80`。' },
        limit: { type: 'integer', description: 'read 最多返回的行数。例：`40`。' },
        reason: { type: 'string', description: 'compact 的原因，可选。' },
        capsule: { type: 'string', description: 'compact 必填。助手自述胶囊正文，trim 后 1–1400 字。标准：目标、已定方案、下一步、易错点、必须遵守的约束原文、需要保留的原文位置。' },
        mode: { type: 'string', enum: ['auto', 'aggressive', 'minimal'], description: 'compact 的遮蔽比：auto 0.55、aggressive 0.70、minimal 0.40。' },
        boundary: { type: 'boolean', description: 'compact 时声明当前处于阶段边界。' },
        status: { type: 'string', description: 'compact 时给锚点补的现状，可选。' },
      },
    },
    output: textOutput(),
    async execute(args, exec) {
      const action = String(args.action || '');
      if (ACTIONS.indexOf(action) === -1) throw new Error('现象：`action` 取值不在允许范围。原因：收到 `' + action + '`。处置：改用 ' + ACTIONS.join('、') + ' 之一后重试。');
      if (action === 'compact') return { text: await assistantCompact(env, exec, args) };
      if (['write', 'rotate'].indexOf(action) !== -1 && (typeof args.text !== 'string' || args.text.trim() === '')) {
        throw new Error('现象：`action=' + action + '` 缺少 `text`。原因：写入交接须提供正文。处置：传入非空的 `text` 后重试。');
      }
      const ws = env.resolveWs(exec);
      const info = env.roleOf(exec);
      const taskName = String(args.task || '').trim();
      let target = null;
      if (taskName) {
        if (info.role !== 'global') throw new Error('现象：当前会话不能使用 `task` 参数。原因：`task` 只对全局会话开放。处置：改由全局会话执行，或省略 `task` 读写本会话的交接。');
        assertTaskName(taskName);
        target = {
          path: path.join(ws, '_Control_Center', 'tasks', taskName, 'Handover.md'),
          kind: 'project', role: 'global-task', task: taskName,
        };
      } else {
        target = args.path
          ? { path: args.path, kind: info.role === 'project' ? 'project' : info.role === 'misc' ? 'misc' : 'global', role: info.role, project: info.project, task: info.task }
          : env.handoverFor(exec);
      }
      if (!target || !target.path) return { text: noPath(target) };
      const archiveOpts = taskName
        ? {
            info: { role: 'misc', task: taskName },
            archiveDir: path.join(ws, '_Archives', '_Global', 'tasks', taskName, 'Handover'),
          }
        : { kind: target.kind, info };
      const snapOpts = taskName
        ? { kind: target.kind, info: { role: 'misc', task: taskName }, snapshotDir: path.join(ws, '_Temp', '_Global', 'tasks', taskName, 'Snapshots') }
        : { kind: target.kind, info };
      const noteStep = (kind, data) => {
        try { if (typeof env.noteHandoverStep === 'function') env.noteHandoverStep(exec, kind, data); } catch { /* 留痕失败不阻断写入 */ }
      };

      if (action === 'read') {
        const r = readHandover(target.path);
        if (r.text === null) return { text: '现象：交接不存在：`' + target.path + '`。原因：该路径尚未写入交接。处置：首次创建用 `action=write`；整篇重写用 `action="rotate"`。' };
        noteStep('read', { path: target.path });
        return {
          text: capText(r.text, {
            maxLines: HANDOVER_MAX_LINES,
            offset: args.offset,
            limit: args.limit,
            hint: '续读：`action="read"` 并给 `offset=' + (HANDOVER_MAX_LINES + 1) + '`，可加 `limit`；给了范围就不再截断。',
          }),
        };
      }
      if (action === 'archive') {
        if (!readHandover(target.path).text) throw new Error('现象：要归档的交接不存在：`' + target.path + '`。原因：该路径没有可归档的交接文件。处置：先确认路径，再执行归档。');
        const a = archiveHandover(ws, target.path, archiveOpts);
        noteStep('archive', a);
        return { text: '已归档 `' + a.dest + '`（' + a.bytes + ' B）' + NL + 'sha256 一致 ' + a.sha256.slice(0, 16) + '…' };
      }
      if (action === 'rotate') {
        const old = readHandover(target.path);
        const carry = old.text ? carryItemsOf(old.text, 8).slice(0, 6) : [];
        if (old.text) noteStep('read', { path: target.path });
        const res = rewriteHandover(ws, target.path, args.text, Object.assign({}, snapOpts, archiveOpts));
        if (res.archived) noteStep('archive', res.archived);
        noteStep('new', { path: res.path, mtime: handoverMtimeMs(res.path) });
        noteStep('rotate', { path: res.path, sha256: fileSha256(res.path), at: Date.now(), archived: !!res.archived });
        const out = [];
        out.push('新交接 `' + res.path + '`（' + res.bytes + ' B）');
        out.push(res.archived
          ? '归档 `' + res.archived.dest + '`（' + res.archived.bytes + ' B，sha256 一致）'
          : '原交接不存在，直接新建');
        out.push('体检 ' + res.verdict + (res.reasons.length ? '' : ' · 结构齐备'));
        for (const r of res.reasons) out.push('  - ' + r);
        if (carry.length) {
          for (let i = 0; i < carry.length; i++) out.push('承接项 ' + (i + 1) + '：' + carry[i]);
          out.push('承接项需自行并入新正文。');
        } else {
          out.push('承接项：无');
        }
        return { text: out.join(NL) };
      }
      // 余下只有 write：只用于首次创建，已有交接一律拒绝。
      if (readHandover(target.path).text) {
        throw new Error(
          '现象：交接已存在，不能用 `write` 改写：`' + target.path + '`。原因：`write` 只用于首次创建。'
          + '处置：（1）调用 ho_handover(action="rotate", text=…) 一步完成归档与写入；'
          + '（2）请用户授权后调用 ho_sessions(action="succeed")。'
          + '授权方式：聊天框发送 /allow-reset，或在设置页点击「授权重置」。',
        );
      }
      const res = writeHandover(ws, target.path, args.text, snapOpts);
      const out = [];
      const scope = taskName ? '全局任务「' + taskName + '」' : (target.kind !== 'global' ? '（' + (info.project || info.task) + '）' : '');
      out.push('已写入 `' + res.path + '`（' + res.bytes + ' B）· 角色 ' + (taskName ? 'global-task' : info.role) + scope);
      out.push('备份 ' + (res.backup || '（原文件不存在，无需备份）'));
      out.push('体检 ' + res.verdict + (res.reasons.length ? '' : ' · 结构齐备'));
      for (const r of res.reasons) out.push('  - ' + r);
      return { text: out.join(NL) };
    },
  };
}
