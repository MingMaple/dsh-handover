/** ho_gate —— 通用约束条闸门 + 交接文档体检。 */
import path from 'node:path';
import { nameOf } from '../lib/names.mjs';
import fs from 'node:fs';
import { textOutput } from '../lib/output.mjs';
import { NL } from '../lib/text.mjs';
import { syncCheck, renderSyncCheck } from '../lib/gates.mjs';
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

export function pmGateTool(env) {
  return {
    name: nameOf('gate'),
    description:
      '通用约束条闸门（按库型判定）＋交接文档体检。只读。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        scope: { type: 'string', enum: ['all', 'global', 'project'], description: '默认 all' },
        project: { type: 'string', description: 'scope=project 时的项目名' },
      },
    },
    output: textOutput(),
    async execute(args, exec) {
      const ws = env.resolveWs(exec);
      const scope = args.scope || "all";
      if (scope !== "all" && scope !== "global" && scope !== "project") {
        throw new Error("scope 只能是 all | global | project（收到 " + String(scope) + "）");
      }
      const out = [];
      if (scope === "all") {
        const g = syncCheck(ws);
        if (g.noWorkspace) {
          out.push('通用约束条闸门：未接入工作区（' + g.path + '）');
          out.push('把工作区接入就好，一共四步：');
          SETUP_STEPS.forEach((s, i) => out.push('  ' + (i + 1) + '. ' + s));
          return { text: out.join(NL) };
        }
        out.push(renderSyncCheck(g).join(NL));
        out.push(renderLintProject(null, lintAllProjects(ws)).join(NL));
      } else if (scope === "project") {
        const name = args.project;
        if (!name) throw new Error("scope=project 时必须给 project 参数");
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