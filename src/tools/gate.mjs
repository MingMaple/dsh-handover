/** 闸门实现 —— 通用约束条闸门 + 交接文档体检。经 ho_status 的 view="gate" 暴露。 */
import path from 'node:path';
import { nameOf } from '../lib/names.mjs';
import fs from 'node:fs';
import { textOutput } from '../lib/output.mjs';
import { NL } from '../lib/text.mjs';
import { syncCheck, renderSyncCheck, docmapReport, renderDocmapCheck } from '../lib/gates.mjs';
import { lintGlobal, lintProject, renderLintGlobal, renderLintProject } from '../lib/lint.mjs';
import { SETUP_STEPS } from '../lib/guide.mjs';

function lintAllProjects(ws) {
  const meta = path.join(ws, "_Project_Meta");
  const rows = [];
  let dirs = [];
  try { dirs = fs.readdirSync(meta).sort(); } catch { return rows; }
  for (const name of dirs) {
    const dir = path.join(meta, name);
    try { if (!fs.statSync(dir).isDirectory()) continue; } catch { continue; }
    const f = path.join(dir, "Handover.md");
    rows.push({ name, file: f, res: lintProject(f) });
  }
  return rows;
}

/**
 * 构造 `gate` 工具定义。
 *
 * 闸门、交接与体系注册共用一次扫描，避免分别读盘。
 *
 * @param {object} env 插件环境，提供 `resolveWs`。
 * @returns {object} 工具定义，供宿主注册。
 * 副作用：无；不修改任何文件。
 */
export function pmGateTool(env) {
  return {
    name: nameOf('gate'),
    description:
      '通用约束条闸门、交接体检与体系注册路径检查，按库型判定。只读，不修改任何文件。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        scope: { type: 'string', enum: ['all', 'global', 'project'], description: '检查范围。缺省 `all`。例：`project`。' },
        project: { type: 'string', description: '`scope=project` 时的项目名。例：`Demo`。' },
      },
    },
    output: textOutput(),
    async execute(args, exec) {
      const ws = env.resolveWs(exec);
      const scope = args.scope || "all";
      if (scope !== "all" && scope !== "global" && scope !== "project") {
        throw new Error("现象：`scope` 取值不在允许范围。原因：收到 `" + String(scope) + "`，只接受 all、global 与 project。处置：改用上述取值之一后重试。");
      }
      const out = [];
      if (scope === "all") {
        const g = syncCheck(ws);
        if (g.noWorkspace) {
          out.push('通用约束条闸门：未接入工作区（`' + g.path + '`）。');
          out.push('接入工作区共 4 步：');
          SETUP_STEPS.forEach((s, i) => out.push('  ' + (i + 1) + '. ' + s));
          return { text: out.join(NL) };
        }
        out.push(renderSyncCheck(g).join(NL));
        out.push(renderLintProject(null, lintAllProjects(ws)).join(NL));
        out.push(renderDocmapCheck(docmapReport(ws)).join(NL));
      } else if (scope === "project") {
        const name = args.project;
        if (!name) throw new Error("现象：`scope=project` 缺少 `project`。原因：项目体检须指定项目名。处置：补传 `project` 后重试。");
        const f = path.join(ws, "_Project_Meta", name, "Handover.md");
        out.push(renderLintProject(name, [{ name, file: f, res: lintProject(f) }]).join(NL));
      }
      if (scope === "all" || scope === "global") {
        const p = path.join(ws, "_Control_Center", "records", "Global_Handover.md");
        out.push(renderLintGlobal(p, lintGlobal(p)).join(NL));
      }
      return { text: out.join(NL + NL) };
    },
  };
}