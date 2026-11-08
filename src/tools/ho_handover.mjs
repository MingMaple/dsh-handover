/** ho_handover —— 读/写/追加/归档**本会话自己的**交接（路径按角色解析；写前备份、写后按角色体检）。 */
import { textOutput } from '../lib/output.mjs';
import { nameOf } from '../lib/names.mjs';
import { NL } from '../lib/text.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readHandover, writeHandover, archiveStamp, archiveFileName } from '../lib/handover-io.mjs';
import { archiveDirFor } from '../lib/role.mjs';

function noPath(input) {
  const reason = input && input.reason ? input.reason : '未知原因';
  return [
    '没有可用的交接路径：' + reason,
    '两条处置：',
    '  ① 在设置页的 dsh-handover 中「会话角色」给本会话指定角色（项目角色要填项目名）；',
    '  ② 临时显式传 path="<交接文件绝对路径>"。',
    '（插件不再默认读全局交接——那是以前会串角色的老行为。）',
  ].join(NL);
}

export function pmHandoverTool(env) {
  return {
    name: nameOf('handover'),
    description:
      '读写、追加、归档本会话自己的交接；写前备份、写后按角色体检。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['read', 'write', 'append', 'archive'], description: 'read | write | append | archive' },
        text: { type: 'string', description: 'write/append 时的正文（read/archive 忽略）' },
        path: { type: 'string', description: '覆盖默认路径（演练或强制指定时用）' },
      },
    },
    output: textOutput(),
    async execute(args, exec) {
      const ws = env.resolveWs(exec);
      const info = env.roleOf(exec);
      const target = args.path
        ? { path: args.path, kind: info.role === 'project' ? 'project' : info.role === 'misc' ? 'misc' : 'global', role: info.role, project: info.project, task: info.task }
        : env.handoverFor(exec);
      if (!target || !target.path) return { text: noPath(target) };

      if (args.action === "read") {
        const r = readHandover(target.path);
        if (r.text === null) return { text: "交接文档不存在：" + target.path + NL + "（第一次写用 action=write 或 action=append）" };
        return { text: r.text };
      }
      if (args.action === "archive") {
        const src = readHandover(target.path);
        if (src.text === null) throw new Error("要归档的交接不存在：" + target.path);
        const stampText = archiveStamp(new Date());
        const dir = archiveDirFor(ws, info);
        fs.mkdirSync(dir, { recursive: true });
        // 命名按 Handover_Rules §4.2：<原文件名>_<YYYYMMDD_HHMMSS>.md；同一秒重复归档加 -2、-3。
        let dest = path.join(dir, archiveFileName(target.path, stampText));
        for (let n = 2; fs.existsSync(dest) && n < 100; n++) {
          dest = path.join(dir, archiveFileName(target.path, stampText + "-" + n));
        }
        if (fs.existsSync(dest)) throw new Error("归档目标已存在，不覆盖：" + dest);
        fs.copyFileSync(target.path, dest);
        const a = crypto.createHash("sha256").update(fs.readFileSync(target.path)).digest("hex");
        const b = crypto.createHash("sha256").update(fs.readFileSync(dest)).digest("hex");
        const out = [];
        out.push("已归档 " + dest + "（" + fs.statSync(dest).size + " B）");
        out.push("sha256 " + (a === b ? "一致 " + a.slice(0, 16) + "…" : "**不一致，归档失败**"));
        return { text: out.join(NL) };
      }
      if (args.action !== "write" && args.action !== "append") {
        throw new Error("未知 action：" + String(args.action) + "（只能是 read | write | append | archive）");
      }
      if (typeof args.text !== "string" || args.text.trim() === "") throw new Error("write/append 需要 text");
      const res = writeHandover(ws, target.path, args.text, args.action === "append" ? "append" : "write", { kind: target.kind, info });
      const out = [];
      out.push("已写入 " + res.path + "（" + res.bytes + " B）· 角色 " + info.role + (target.kind !== 'global' ? "（" + (info.project || info.task) + "）" : ""));
      out.push("备份 " + (res.backup || "（原文件不存在，无需备份）"));
      out.push("体检 " + res.verdict + (res.reasons.length ? "" : " · 结构齐备"));
      for (const r of res.reasons) out.push("  - " + r);
      return { text: out.join(NL) };
    },
  };
}
