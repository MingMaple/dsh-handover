/**
 * 脱离 DSH 的自测台：用假 env 直接跑工具 execute，打印只读结果，供人工比对；不参与发布门禁。
 * 用法：node selftest.mjs [--ws <工作区根>] [--session <session id>] [--tool status|gate|sessions|charter|office|succeed|all]
 */
import { resolveConfig } from './lib/config.mjs';
import { projCacheDir, pressurePct } from './lib/sessions.mjs';
import { readJsonDir, isDir } from './lib/text.mjs';
import { pmStatusTool } from './tools/ho_status.mjs';
import { pmGateTool } from './tools/ho_gate.mjs';
import { pmSessionsTool } from './tools/ho_sessions.mjs';
import { pmCharterTool } from './tools/ho_charter.mjs';
import { pmOfficeTool } from './tools/ho_office.mjs';
import { pmSucceedTool } from './tools/ho_succeed.mjs';
import path from 'node:path';

const argv = process.argv.slice(2);
function argOf(flag, dflt) {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : dflt;
}

/** 从 cwd 向上找带 _Control_Center 的目录；找不到就用 cwd（公开仓库里不写死任何本机路径）。 */
function autoWs() {
  let cur = process.cwd();
  for (let i = 0; i < 8 && cur; i++) {
    if (isDir(path.join(cur, "_Control_Center"))) return cur;
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return process.cwd();
}

const ws = argOf("--ws", autoWs());
const selfId = argOf("--session", "");
const only = argOf("--tool", "all");

const cfg = resolveConfig({ workspaceRoot: ws });
const env = {
  cfg,
  cacheDir: () => projCacheDir(),
  resolveWs: () => cfg.workspaceRoot,
  selfId: () => (selfId || null),
  selfCwd: () => null,
  selfPct(id) {
    if (!id) return null;
    const target = id.indexOf('session-') === 0 ? id : 'session-' + id;
    for (const f of readJsonDir(projCacheDir())) {
      const stem = f.name.replace('.json', '');
      if (stem === target || stem === id) return pressurePct(f.data);
    }
    return null;
  },
  compactionCount: () => ({ used: null, note: '（批 B 接入事件计数）' }),
  lockState: () => 'unknown',
};

/** 换任只读用例：只验授权判据，不带用户授权时应当返回「没有授权」，而不是抛异常。 */
const envSucceed = Object.assign({}, env, {
  selfId: () => 'session-selftest-succeed',
  roleOf: () => ({ role: 'project', project: 'Demo', task: '', source: 'selftest' }),
  handoverFor: () => ({ path: path.join(ws, '_Project_Meta', 'Demo', 'Handover.md'), reason: '' }),
});

const exec = null;
const cases = [
  { t: pmStatusTool(env, { schedulerReady: () => false, schedulerError: () => 'selftest' }), a: { view: "brief" }, flag: "status" },
  { t: pmStatusTool(env, { schedulerReady: () => false, schedulerError: () => 'selftest' }), a: { view: "phase" }, flag: "status" },
  { t: pmStatusTool(env, { schedulerReady: () => false, schedulerError: () => 'selftest' }), a: { view: "diag" }, flag: "status" },
  { t: pmGateTool(env), a: { scope: "all" }, flag: "gate" },
  { t: pmSessionsTool(env), a: {}, flag: "sessions" },
  { t: pmCharterTool(env), a: { doc: "charter", section: "8.1.1.4", maxLines: 30 }, flag: "charter" },
  { t: pmOfficeTool(env), a: { query: "全局" }, flag: "office" },
  { t: pmSucceedTool(envSucceed), a: {}, flag: "succeed", want: /没有授权/ },
];

let failed = 0;
for (const c of cases) {
  if (only !== "all" && only !== c.flag) continue;
  const bar = "==== " + c.t.name + " " + JSON.stringify(c.a) + " ====";
  console.log(bar);
  try {
    const out = await c.t.execute(c.a, exec);
    console.log(out.text);
    if (c.want && !c.want.test(String(out && out.text))) {
      failed++;
      console.log("FAILED: 输出不符合预期 " + c.want);
    }
  } catch (e) {
    failed++;
    console.log("FAILED: " + (e && e.message ? e.message : String(e)));
    if (e && e.stack) console.log(e.stack.split(String.fromCharCode(10)).slice(0, 4).join(String.fromCharCode(10)));
  }
  console.log("");
}
if (failed) {
  console.log("自测失败 " + failed + " 项");
  process.exitCode = 1;
}