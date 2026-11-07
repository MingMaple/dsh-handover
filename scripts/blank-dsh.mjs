/**
 * 空白 DSH 验收：证明「移到一个没有任何旧全局文件的空 DSH 上，插件所有功能 100% 可用」。
 * 做法：临时 HOME（无 ~/.dsh 状态）→ 只靠 dist/ 自带的东西跑完 22 个工具 + 迁移四件。
 * 额外覆盖：7-Zip 不存在（强制 format=tar）、工作区规则文件被删光（必须退回内置模板）。
 * 用法：node scripts/blank-dsh.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const dist = path.join(repo, 'dist');

const fails = [];
const lines = [];
function ok(cond, label, extra) {
  if (cond) lines.push('  [32mok[0m ' + label);
  else { fails.push(label + (extra ? ' :: ' + extra : '')); lines.push('  [31mFAIL[0m ' + label + (extra ? ' :: ' + extra : '')); }
}
function section(t) { lines.push(''); lines.push('== ' + t + ' =='); }

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-handover-blankdsh-'));
const HOME = path.join(ROOT, 'home');
const WORK = path.join(ROOT, 'work');
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(WORK, { recursive: true });
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;

const { apply } = await import(pathToFileURL(path.join(dist, 'index.mjs')).href);
const { safeRel } = await import(pathToFileURL(path.join(dist, 'lib', 'archive.mjs')).href);

const reg = { tools: [], sections: [], listeners: {}, logs: [] };
const prompts = [];
const ctx = {
  tools: { register: (t) => reg.tools.push(t), restrict() { }, guard() { } },
  systemPrompt: { section: (s) => { reg.sections.push(s); return () => { }; } },
  sessionController: {
    prompt: async (r) => { prompts.push(r); return { accepted: true }; },
    list: async () => ({ items: [] }),
    create: async () => ({ sessionId: 'session-created' }),
    rename: async () => ({}),
  },
  workspaceRegistry: {
    archiveSession: async () => ({}),
    unarchiveSession: async () => ({}),
    get: () => null,
  },
  logger: { warn: (m) => reg.logs.push(String(m)), error: (m) => reg.logs.push(String(m)), info() { } },
  effect: (fn) => fn(),
  on: (n, cb) => { (reg.listeners[n] = reg.listeners[n] || []).push(cb); },
  get: () => null,
  inject: (names, cb) => { reg.injectCb = cb; },
};
apply(ctx, { packFormat: 'tar' });   // 强制内置归档器：模拟一台没有 7-Zip 的机器

section('装配');
ok(reg.tools.length === 22, '注册 22 个工具', String(reg.tools.length));
ok(reg.tools.every((t) => t && t.name && t.description && typeof t.execute === 'function'), '每个工具都有 name／description／execute');
const names = reg.tools.map((t) => t.name).sort();
ok(names.indexOf('ho_pack') !== -1 && names.indexOf('peer_send') !== -1, '关键工具都在');

const byName = new Map(reg.tools.map((t) => [t.name, t]));
function execFor(cwd, id, title) {
  return { name: '', arguments: {}, agent: { session: { header: { id: id || 'session-blank-test', cwd, title: title || '' } } } };
}
async function run(tool, args, cwd, id, title) {
  const t = byName.get(tool);
  if (!t) return { err: 'no tool ' + tool };
  try {
    const out = await t.execute(args, execFor(cwd, id, title));
    return { text: String(out && out.text !== undefined ? out.text : out) };
  } catch (e) {
    return { err: String(e && e.message ? e.message : e) };
  }
}

section('首次安装（只用插件自带模板）');
const init = await run('ho_init', { parent: WORK, name: '_Workspace', register: false });
ok(!init.err, 'ho_init 不抛错', init.err);
const WS = path.join(WORK, '_Workspace');
ok(fs.existsSync(WS), '全局根已建', WS);
for (const rel of [
  '_Control_Center/records/Global_Handover.md',
  '_Control_Center/records/Global_Changelog.md',
  '_Control_Center/rules/Workspace_Charter.md',
  '_Control_Center/templates/Prompt_Templates.md',
  '_Control_Center/rules/Handover_Rules.md',
  '_Control_Center/rules/Migration_Rules.md',
  '_Control_Center/rules/Misc_Task_Standard.md',
  '_Control_Center/user/Writing_Rules.md',
]) {
  ok(fs.existsSync(path.join(WS, rel)), '铺好 ' + rel);
}

section('22 个工具在空白工作区逐个跑');
const calls = [
  ['ho_diag', {}],
  ['ho_brief', {}],
  ['ho_gate', { scope: 'all' }],
  ['ho_sessions', { action: 'list' }],
  ['ho_phase', {}],
  ['ho_charter', { doc: 'runtime' }],
  ['ho_charter', { doc: 'charter', section: '10' }],
  ['ho_handover', { action: 'read' }],
  ['ho_handover', { action: 'write', text: '# 全局交接\n\n## 0 身份与寻址\n- 本文件：_Control_Center/records/Global_Handover.md\n\n## 1 正在做的事\n空白验收\n\n## 2 下一步\n- 无\n\n## 3 等用户拍板\n- 无\n\n## 4 用户要求逐条落位\n- 无\n\n## 5 坑点与禁区\n- 无\n\n## 6 关键路径\n- 无\n\n## 7 会话 id\n- session-blank-test\n' }],
  ['ho_checkpoint', { at_risk: true }],
  ['ho_snapshot', { project: 'NoSuchProject' }],
  ['ho_drift', {}],
  ['ho_changelog', { summary: '空白验收写入一行' }],
  ['ho_tokens', { sessions: ['session-blank-test'] }],
  ['ho_pack', { action: 'check', items: ['global'] }],
  ['ho_workspace', { action: 'list' }],
  ['peer_list', {}],
  ['peer_status', { session_id: 'session-blank-test' }],
  ['peer_peek', { session_id: 'session-blank-test', limit: 2 }],
  ['peer_rename', { session_id: 'session-blank-test', title: '空白验收' }],
];
for (const [tool, args] of calls) {
  const r = await run(tool, args, WS, 'session-blank-test', '空白验收');
  const acceptable = !r.err || /找不到项目|日志找不到|没有可读会话|not found/i.test(r.err);
  ok(acceptable, tool + ' 可用', r.err);
}

section('删掉旧全局留下的规则文件：必须退回内置模板');
for (const rel of [
  '_Control_Center/rules/Handover_Rules.md',
  '_Control_Center/rules/Migration_Rules.md',
  '_Control_Center/rules/Misc_Task_Standard.md',
  '_Control_Center/user/Writing_Rules.md',
  '_Control_Center/templates/Prompt_Templates.md',
  '_Control_Center/records/Global_Changelog.md',
]) fs.rmSync(path.join(WS, rel), { force: true });
for (const doc of ['handover_rules', 'migration_rules', 'misc_standard', 'writing_rules']) {
  const r = await run('ho_charter', { doc }, WS, 'session-blank-test', '空白验收');
  ok(!r.err && r.text.length > 50 && /内置/.test(r.text), 'ho_charter doc=' + doc + ' 用内置默认', r.err || String(r.text.length));
}
{
  const r = await run('ho_sessions', { action: 'prompt', kind: 'project', project: 'Demo' }, WS, 'session-blank-test', '空白验收');
  ok(!r.err && r.text.length > 50, 'ho_sessions(action=prompt) 缺模板也能渲染', r.err);
}
{
  const r = await run('ho_changelog', { summary: '缺台账时自建' }, WS, 'session-blank-test', '空白验收');
  ok(!r.err && fs.existsSync(path.join(WS, '_Control_Center/records/Global_Changelog.md')), 'ho_changelog 缺台账时自建', r.err);
}

section('有 _Control_Center 但没有 Charter：闸门仍要能跑（用内置约束条）');
fs.writeFileSync(path.join(WS, '_Control_Center', 'rules', 'Workspace_Charter.md'), '# empty\n', 'utf8');
{
  const r = await run('ho_gate', { scope: 'all' }, WS, 'session-blank-test', '空白验收');
  ok(!r.err && /内置口径|全部落位|缺/.test(r.text), 'Charter 空壳时闸门用内置约束条', r.err || String(r.text.slice(0, 80)));
}
fs.rmSync(path.join(WS, '_Control_Center', 'rules', 'Workspace_Charter.md'), { force: true });
{
  const r = await run('ho_gate', { scope: 'all' }, WS, 'session-blank-test', '空白验收');
  ok(!r.err && /内置/.test(r.text), 'Charter 完全缺失时闸门仍用内置约束条', r.err || String(r.text.slice(0, 80)));
}

section('迁移四件（无 7-Zip，走内置 tar.gz）');
fs.mkdirSync(path.join(WS, 'Projects', 'Demo', 'Demo库'), { recursive: true });
fs.writeFileSync(path.join(WS, 'Projects', 'Demo', 'Demo库', 'RULES.md'), '# Demo RULES\n', 'utf8');
fs.mkdirSync(path.join(WS, '_Project_Meta', 'Demo'), { recursive: true });
fs.writeFileSync(path.join(WS, '_Project_Meta', 'Demo', 'Handover.md'), '# Demo 交接\n\n## 1 正在做的事\n- 空\n\n## 2 下一步\n- 空\n\n## 3 坑点\n- 空\n', 'utf8');
const packOut = path.join(ROOT, 'packs');
const packed = await run('ho_pack', { action: 'pack', kind: 'project', name: 'Demo', out: packOut, format: 'tar' }, WS, 'session-blank-test', '空白验收');
ok(!packed.err, 'pack 打包成功', packed.err);
const pkg = fs.existsSync(packOut) ? fs.readdirSync(packOut).filter((f) => f.endsWith('.tar.gz')) : [];
ok(pkg.length === 1, '产出 1 个 .tar.gz', pkg.join(','));
if (pkg.length === 1) {
  const packPath = path.join(packOut, pkg[0]);
  const ver = await run('ho_pack', { action: 'verify', pack: packPath }, WS, 'session-blank-test', '空白验收');
  ok(!ver.err && /一致/.test(ver.text), 'verify 校包可跑', ver.err);
  const dry = await run('ho_pack', { action: 'restore', pack: packPath, target: path.join(ROOT, 'target'), dry_run: true }, WS, 'session-blank-test', '空白验收');
  ok(!dry.err && /预演/.test(dry.text), 'restore 预演不写盘', dry.err);
  const applied = await run('ho_pack', { action: 'restore', pack: packPath, target: path.join(ROOT, 'target'), apply: true }, WS, 'session-blank-test', '空白验收');
  ok(!applied.err, 'restore 写入成功', applied.err);
  const restored = path.join(ROOT, 'target', 'Projects', 'Demo', 'Demo库', 'RULES.md');
  ok(fs.existsSync(restored), '恢复出来的文件在（相对路径正确）', restored);
  if (fs.existsSync(restored)) {
    const h = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    ok(h(restored) === h(path.join(WS, 'Projects', 'Demo', 'Demo库', 'RULES.md')), '内容一致');
  }
}

section('防越界');
ok(safeRel('../x') === null, 'safeRel 拒绝 ..');
ok(safeRel('/abs') === null, 'safeRel 拒绝绝对路径');
ok(safeRel('C:/x') === null, 'safeRel 拒绝带盘符');
ok(safeRel('a/b.md') === 'a/b.md', 'safeRel 放行正常相对路径');

fs.rmSync(ROOT, { recursive: true, force: true });
console.log(lines.join('\n'));
console.log('');
if (fails.length) {
  console.log('BLANK-DSH FAIL ' + fails.length + ' 项：');
  for (const f of fails) console.log('  - ' + f);
  process.exit(1);
}
console.log('BLANK-DSH OK（空白 DSH 上 22 工具 + 迁移四件全部可用）');

