/** ho_handover —— 读/新建/追加/归档**本会话自己的**交接（路径按角色解析；整篇重写先归档旧交接，写后按角色体检）。 */
import { textOutput } from '../lib/output.mjs';
import { nameOf } from '../lib/names.mjs';
import { NL } from '../lib/text.mjs';
import path from 'node:path';
import { readHandover, writeHandover, rewriteHandover, archiveHandover } from '../lib/handover-io.mjs';
import { assertTaskName } from '../lib/role.mjs';

function noPath(input) {
  const reason = input && input.reason ? input.reason : '未知原因';
  return [
    '没有可用的交接路径：' + reason,
    '处置：',
    '  ① 在设置页的 dsh-handover 中「会话角色」给本会话指定角色（项目角色须填项目名）；',
    '  ② 临时显式传 path="<交接文件绝对路径>"。',
    '（插件不再默认读全局交接：旧版行为会导致角色串用。）',
  ].join(NL);
}

export function pmHandoverTool(env) {
  return {
    name: nameOf('handover'),
    description:
      '读写、新建、追加、归档交接；整篇重写用 new（先归档旧交接，再新建空白文件写入）；项目与杂项会话读写自己的交接，全局会话可用 task 指向某个全局任务。写后按角色体检。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['read', 'new', 'write', 'append', 'archive'], description: 'read | new（整篇重写：归档旧交接后新建空白写入）| write（仅首次创建）| append | archive' },
        text: { type: 'string', description: 'new/write/append 时的正文（read/archive 忽略）' },
        path: { type: 'string', description: '覆盖默认路径（演练或强制指定时用）' },
        task: { type: 'string', description: '全局会话读写某个全局任务的交接：_Control_Center/tasks/<任务>/Handover.md' },
      },
    },
    output: textOutput(),
    async execute(args, exec) {
      const ws = env.resolveWs(exec);
      const info = env.roleOf(exec);
      const taskName = String(args.task || '').trim();
      let target = null;
      if (taskName) {
        if (info.role !== 'global') throw new Error('task 参数只对全局会话开放');
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

      if (args.action === "read") {
        const r = readHandover(target.path);
        if (r.text === null) return { text: "交接文档不存在：" + target.path + NL + "（首次创建用 action=write；整篇重写用 action=new）" };
        return { text: r.text };
      }
      if (args.action === "archive") {
        if (!readHandover(target.path).text) throw new Error("要归档的交接不存在：" + target.path);
        const a = archiveHandover(ws, target.path, archiveOpts);
        return { text: "已归档 " + a.dest + "（" + a.bytes + " B）" + NL + "sha256 一致 " + a.sha256.slice(0, 16) + "…" };
      }
      if (args.action === "new") {
        if (typeof args.text !== "string" || args.text.trim() === "") throw new Error("new 需要 text");
        const res = rewriteHandover(ws, target.path, args.text, Object.assign({}, snapOpts, archiveOpts));
        const out = [];
        out.push(res.archived
          ? (res.archived.reused
            ? "已归档（复用内容相同的副本）" + res.archived.dest + "（" + res.archived.bytes + " B）"
            : "已归档 " + res.archived.dest + "（" + res.archived.bytes + " B，sha256 一致）")
          : "原交接不存在，直接新建（无需归档）");
        out.push("已新建 " + res.path + "（" + res.bytes + " B）· 角色 " + (taskName ? 'global-task' : info.role) + (taskName ? " · 任务「" + taskName + "」" : ""));
        out.push("体检 " + res.verdict + (res.reasons.length ? "" : " · 结构齐备"));
        for (const r of res.reasons) out.push("  - " + r);
        if (res.verdict !== "通过") out.push("提示：修正后重跑 action=new（将再次归档当前文件）。");
        return { text: out.join(NL) };
      }
      if (args.action !== "write" && args.action !== "append") {
        throw new Error("未知 action：" + String(args.action) + "（只能是 read | new | write | append | archive）");
      }
      if (typeof args.text !== "string" || args.text.trim() === "") throw new Error(args.action + " 需要 text");
      if (args.action === "write" && readHandover(target.path).text) {
        throw new Error(
          "交接已存在，不能用 write 改写：" + target.path + NL
          + "整篇重写按固定流程：① ho_handover(action=\"read\") 读旧交接；② ho_handover(action=\"archive\") 归档；③ 读模板 _Control_Center/templates/Handover.md；④ ho_handover(action=\"new\", text=…) 新建空白写入。",
        );
      }
      const res = writeHandover(ws, target.path, args.text, args.action, snapOpts);
      const out = [];
      const scope = taskName ? '全局任务「' + taskName + '」' : (target.kind !== 'global' ? '（' + (info.project || info.task) + '）' : '');
      out.push("已写入 " + res.path + "（" + res.bytes + " B）· 角色 " + (taskName ? 'global-task' : info.role) + scope);
      out.push("备份 " + (res.backup || "（原文件不存在，无需备份）"));
      out.push("体检 " + res.verdict + (res.reasons.length ? "" : " · 结构齐备"));
      for (const r of res.reasons) out.push("  - " + r);
      return { text: out.join(NL) };
    },
  };
}
