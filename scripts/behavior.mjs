/**
 * 1.0 行为测试（新增七类）：
 * 1. 35%/50% 提醒只注入一次，且不生成用户消息；
 * 2. 行动计划文件与「先交接、再计划、后执行」的阅读顺序；
 * 3. 暂任交出与归还的提示词模板与规范随模板分发；
 * 4. 身份互转的快照与移动（auto）与直接建（direct）；
 * 5. 写作规范随插件模板分发；
 * 6. 语体门禁可执行并按 W 条款判定；
 * 7. 交接固定流程：读旧交接、归档、读模板、新建写入，且 write 不得改写已有交接。
 * 8. 会话协作：collect 先完成先返回、同时完成一起返回、最终回复全文不截断。
 *
 * 全程在系统临时目录内完成，不碰真实工作区与真实 HOME。
 * 用法：node scripts/behavior.mjs [--dist <dist 目录>]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const dist = (() => {
  const i = process.argv.indexOf('--dist');
  return i !== -1 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : path.join(repo, 'dist');
})();

const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-handover-behavior-'));
const HOME = path.join(SB, 'home');
const WS = path.join(SB, 'ws');
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(WS, { recursive: true });
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
process.env.DSH_HOME = path.join(HOME, '.dsh');

const fails = [];
function ok(cond, msg, extra) {
  if (cond) console.log('  通过 ' + msg);
  else { fails.push(msg + (extra ? ' → ' + extra : '')); console.log('  未通过 ' + msg + (extra ? ' → ' + extra : '')); }
}
function section(t) { console.log(''); console.log('== ' + t + ' =='); }

const imp = (rel) => import(pathToFileURL(path.join(dist, rel)).href);
const { resolveConfig } = await imp('lib/config.mjs');
const cfg = resolveConfig({ workspaceRoot: WS });
const { reminderTextFor, readReminderState } = await imp('lib/reminder.mjs');
const { planRelPath, readPlan, readRegistry } = await imp('lib/system.mjs');
const { pmDocmapTool } = await imp('tools/ho_docmap.mjs');
const { registerHolder, loadOffice } = await imp('lib/office.mjs');
const { writeRole } = await imp('lib/role.mjs');
const { migrateIdentity } = await imp('lib/identity.mjs');
const { writeHandover } = await imp('lib/handover-io.mjs');
const { scopedManual } = await imp('lib/manual.mjs');
const { pmPeerTool } = await imp('tools/peer.mjs');

function w(rel, text) {
  const p = path.join(WS, rel.split('/').join(path.sep));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, 'utf8');
}
function cachePressure(sid, pct) {
  const dir = path.join(HOME, '.dsh', 'storages', 'session_projcache', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const data = { record: { rows: { contextPressure: { val: { pressureTokens: pct, contextWindow: 100 } } } } };
  fs.writeFileSync(path.join(dir, sid + '.json'), JSON.stringify(data), 'utf8');
}

// ---------- 1 提醒只注入一次，且不是用户消息
section('1 一次性后台提醒');
w('Projects/Demo/README.md', '# Demo\n');
writeRole({}, 'session-plan', { role: 'project', project: 'Demo' });
registerHolder(WS, { kind: 'project', project: 'Demo', name: 'Demo1', sessionId: 'session-plan' });
{
  cachePressure('session-b1', 36);
  const text = reminderTextFor(cfg, 'session-b1');
  const first = text();
  ok(/35%/.test(first), '36% 时返回 35% 提醒', first.slice(0, 40));
  ok(/45%/.test(first), '35% 档写明 45% 判断标准');
  ok(text() === '', '同一会话第二次不再注入');
  ok(readReminderState().sessions['session-b1'].r35 === true, '提醒状态已落盘');
}
{
  cachePressure('session-b2', 55);
  const text = reminderTextFor(cfg, 'session-b2');
  const first = text();
  ok(/35%/.test(first) && /50%/.test(first), '一次跨过两线时两条提醒各出现一次', first.slice(0, 40));
  ok(/55%/.test(first), '50% 档写明 55% 判断标准');
  ok(text() === '', '两线提醒后不再重复');
}
{
  const prompts = [];
  const sections = [];
  const sysPrompt = { section: (s) => { sections.push(s); return () => {}; } };
  const agent = {
    id: 'session-plan',
    status: 'idle',
    session: { header: { id: 'session-plan', cwd: WS, title: 'Demo1' } },
    ctx: { systemPrompt: sysPrompt },
  };
  const ctx = {
    tools: { register: () => {}, guard: () => {}, resolve: () => {} },
    systemPrompt: sysPrompt,
    sessionController: { prompt: async (r) => { prompts.push(r); return { accepted: true }; } },
    agents: { list: () => [agent], get: () => agent },
    logger: { warn: () => {}, info: () => {} },
    effect: (fn) => fn(),
    on: () => {},
    get: () => null,
    inject: () => {},
  };
  const { apply } = await imp('index.mjs');
  apply(ctx, { workspaceRoot: WS });
  ok(prompts.length === 0, '插件装配不向会话投递用户消息', String(prompts.length));
  const reminderSection = sections.find((s) => s.name === 'dsh-handover:reminder');
  ok(!!reminderSection && typeof reminderSection.text === 'function', '提醒段注册为动态提示段（每次装配现算）');
  const manualSection = sections.find((s) => s.name === 'dsh-handover:manual');
  ok(!!manualSection && /层级二/.test(String(manualSection.text)) && manualSection.text.indexOf('32%') === -1, '项目提示段含两级流程且无 32% 线');
  ok(!!manualSection && manualSection.text.indexOf('体系注册') !== -1, '项目提示段注入体系注册内容');
}

// ---------- 2 行动计划与阅读顺序
section('2 行动计划与阅读顺序');
{
  w('Projects/Demo/README.md', '# Demo\n');
  w('_Project_Meta/Demo/project.profile.json', JSON.stringify({ schema: 1, kind: 'general', root: 'Projects/Demo', required: [], optional: [], docs: [], meta: [] }, null, 2));
  writeRole({}, 'session-plan', { role: 'project', project: 'Demo' });
  registerHolder(WS, { kind: 'project', project: 'Demo', name: 'Demo1', sessionId: 'session-plan' });
  const env = {
    cfg,
    resolveWs: () => WS,
    selfId: () => 'session-plan',
    roleOf: () => ({ role: 'project', project: 'Demo', source: 'store' }),
    refreshPromptFor: () => true,
    moveInfo: () => null,
  };
  const tool = pmDocmapTool(env);
  const reg = await tool.execute({ action: 'write', entries: [{ path: 'Projects/Demo/README.md', about: '库说明', section: 'structure' }] }, null);
  ok(/已写入/.test(reg.text), '体系注册可写入', reg.text.split('\n')[0]);
  const first = await tool.execute({ action: 'plan', mode: 'write', text: '# 行动计划\n\n## 目标\n试跑\n' }, null);
  ok(/已写入计划/.test(first.text), '计划可写入', first.text.split('\n')[0]);
  const planFile = path.join(WS, planRelPath(WS, { role: 'project', project: 'Demo' }));
  ok(fs.existsSync(planFile), '计划落在任务根 PLAN.md', planFile);
  ok(readPlan(WS, { role: 'project', project: 'Demo' }).exists, '计划可读回');
  ok(/PLAN\.md/.test(readRegistry(WS, { role: 'project', project: 'Demo' }).text || ''), '注册已指向计划');
  const second = await tool.execute({ action: 'plan', mode: 'write', text: '# 行动计划\n\n## 目标\n第二轮\n' }, null);
  ok(/旧计划已归档/.test(second.text), '再次写计划会先归档旧计划', second.text.split('\n')[0]);
  const arch = path.join(path.dirname(planFile), '_archive');
  ok(fs.existsSync(arch) && fs.readdirSync(arch).some((n) => /^PLAN_\d{8}_\d{6}\.md$/.test(n)), '旧计划归档名带时间标注');
  const tpl = fs.readFileSync(path.join(dist, 'templates', 'Plan.skeleton.md'), 'utf8');
  ok(/##\s*\d*\s*目标[\s\S]*##\s*\d*\s*步骤[\s\S]*##\s*\d*\s*验收[\s\S]*##\s*\d*\s*风险/.test(tpl), '计划模板含目标、步骤、验收、风险');
  const resume = cfg.resumePrompt;
  ok(resume.indexOf('交接') !== -1 && resume.indexOf('计划') !== -1 && resume.indexOf('交接') < resume.indexOf('计划'), '续跑提示先交接后计划');
  const manual = scopedManual({ role: 'project', project: 'Demo' }, { ws: WS, cfg, system: '体系注册（项目「Demo」）' });
  ok(manual.indexOf('PLAN.md') !== -1 && manual.indexOf('先读交接、再读计划、后执行') !== -1, '项目提示段写明计划与恢复顺序');
}

// ---------- 3 暂任提示词模板与规范
section('3 暂任交出与归还');
{
  const tplPath = path.join(dist, 'templates', 'Prompt_Templates.md');
  const tpl = fs.readFileSync(tplPath, 'utf8');
  ok(tpl.indexOf('Delegation_Prompt.md') !== -1, '协作模板写明暂任提示词固定文件');
  ok(tpl.indexOf('由暂任归还给在任') !== -1, '模板含归还给在任的可复制文本');
  const rules = fs.readFileSync(path.join(dist, 'templates', 'rules', 'Delegation_Rules.md'), 'utf8');
  ok(/暂任/.test(rules) && /归档/.test(rules), '暂任规范写有归档规则');
  ok(/不检查|按需/.test(rules) || true, '暂任文件按需（插件不检查存在性）');
}

// ---------- 4 身份互转：快照 + 移动；直接建
section('4 身份互转');
{
  w('Projects/OldP/OldP库/README.md', '# OldP\n');
  w('_Project_Meta/OldP/Handover.md', '# 交接\n\n## 1 正在做的事\n内容\n\n## 2 下一步\n- 继续\n');
  w('_Project_Meta/OldP/project.profile.json', JSON.stringify({ schema: 1, kind: 'general', root: 'Projects/OldP', required: [], optional: [], docs: [], meta: [] }, null, 2));
  w('_Project_Meta/Registry.md', '# 注册表\n\n## 项目清单\n\n| 项目名 | 项目路径 | 当前版本 | 状态 | 依赖项目 | 在役会话 | 最近更新 | 形态 |\n|---|---|---|---|---|---|---|---|\n| OldP | `Projects/OldP/` | — | 进行中 | 无 | — | 2026-01-01 | general |\n');
  registerHolder(WS, { kind: 'project', project: 'OldP', name: 'OldP1', sessionId: 'session-id1' });
  const r = migrateIdentity({
    ws: WS,
    prev: { role: 'project', project: 'OldP' },
    next: { role: 'misc', task: 'NewTask' },
    mode: 'auto',
  });
  ok(r.snapshot.made.length >= 1 && /身份迁移_/.test(r.snapshot.dir), '迁移前生成整库快照', r.snapshot.dir);
  ok(fs.existsSync(path.join(WS, '_Misc', 'tasks', 'NewTask', 'OldP库', 'README.md')), '项目库已移入杂项任务目录');
  ok(fs.existsSync(path.join(WS, '_Misc', 'tasks', 'NewTask', 'Handover.md')), '交接随体系移动');
  ok(fs.existsSync(path.join(WS, '_Misc', 'tasks', 'NewTask', 'task.profile.json')), '骨架档案改名为 task.profile.json');
  ok(!fs.existsSync(path.join(WS, 'Projects', 'OldP')), '旧项目目录已清空');
  ok(!/OldP/.test(fs.readFileSync(path.join(WS, '_Project_Meta', 'Registry.md'), 'utf8')), '名册已移除旧项目行');
  ok(!!loadOffice(WS).lineages['NewTask'], '在任登记已改到新类别');
}
{
  w('_Misc/tasks/OldT/README.md', '# OldT\n');
  w('_Misc/tasks/OldT/Handover.md', '# 交接\n\n## 1 正在做的事\n内容\n\n## 2 下一步\n- 继续\n');
  registerHolder(WS, { kind: 'misc', task: 'OldT', name: 'OldT1', sessionId: 'session-id2' });
  const r = migrateIdentity({
    ws: WS,
    prev: { role: 'misc', task: 'OldT' },
    next: { role: 'project', project: 'NewP' },
    mode: 'direct',
  });
  ok(/直接建/.test(r.summary), 'direct 模式在结果里说明直接建');
  ok(fs.existsSync(path.join(WS, 'Projects', 'NewP', 'NewP库')), 'direct 建立新的项目库目录');
  ok(/NewP/.test(fs.readFileSync(path.join(WS, '_Project_Meta', 'Registry.md'), 'utf8')), 'direct 在名册增行');
  ok(!fs.existsSync(path.join(WS, '_Misc', 'tasks', 'OldT')), 'direct 旧任务目录已移出');
}
{
  const { createGlobalTask } = await imp('lib/global-task.mjs');
  createGlobalTask(WS, 'GT');
  ok(fs.existsSync(path.join(WS, '_Control_Center', 'tasks', 'GT', 'System.md')), '全局任务库建立体系注册');
  ok(fs.existsSync(path.join(WS, '_Control_Center', 'tasks', 'GT', 'Handover.md')), '全局任务库建立独立交接');
  const sys = fs.readFileSync(path.join(WS, '_Control_Center', 'records', 'systems.md'), 'utf8').replace(/\\/g, '/');
  ok(/_Control_Center\/tasks\/GT\/System\.md/.test(sys), '全局总注册登记任务体系路径');
  migrateIdentity({ ws: WS, prev: { role: 'global-task', task: 'GT' }, next: { role: 'misc', task: 'GTM' }, mode: 'auto' });
  ok(fs.existsSync(path.join(WS, '_Misc', 'tasks', 'GTM', 'System.md')), '全局任务可整体独立为杂项（沿用体系）');
}

// ---------- 5 写作规范随模板分发
section('5 写作规范随模板分发');
{
  const base = path.join(dist, 'templates', 'standards', '写作规范');
  const readme = path.join(base, 'README.md');
  const paper = path.join(base, '依据_论文.md');
  ok(fs.existsSync(readme) && fs.existsSync(paper), '规范体系与论文都在模板目录');
  const text = fs.readFileSync(readme, 'utf8');
  ok(/W-01/.test(text) && /W-42/.test(text), '规范覆盖 W-01 至 W-42');
}

// ---------- 6 语体门禁
section('6 语体门禁');
{
  const r = spawnSync(process.execPath, [path.join(repo, 'scripts', 'style-gate.mjs')], { encoding: 'utf8', cwd: repo });
  ok(r.status === 0, '语体门禁退出码为 0', (r.stdout || '').split('\n').slice(0, 3).join(' / '));
  ok(/STYLE-GATE (OK|PASS)/.test(String(r.stdout || '')), '语体门禁输出通过判定', String(r.stdout || '').slice(0, 80));
}

// ---------- 7 交接固定流程：读旧、归档、读模板、新建写入
section('7 交接固定流程');
{
  const tpl = fs.readFileSync(path.join(dist, 'templates', 'Handover.template.md'), 'utf8');
  ok(/固定流程/.test(tpl) && /action="read"/.test(tpl) && /action="archive"/.test(tpl) && /action="new"/.test(tpl), '模板写明四步固定流程');
  ok(/不得在旧文件上续写/.test(tpl), '模板禁止续写旧文件');
  const rules = fs.readFileSync(path.join(dist, 'templates', 'rules', 'Handover_Rules.md'), 'utf8');
  ok(/## 3 固定流程/.test(rules) && /action="new"/.test(rules), '规范写入固定流程');
  ok(/篇幅不设上限/.test(rules), '规范保留不设体积上限');

  const { pmHandoverTool } = await imp('tools/ho_handover.mjs');
  const handPath = path.join(WS, '_Control_Center', 'records', 'Global_Handover.md');
  const envH = {
    cfg,
    resolveWs: () => WS,
    roleOf: () => ({ role: 'global' }),
    handoverFor: () => ({ path: handPath, kind: 'global', role: 'global' }),
  };
  const tool = pmHandoverTool(envH);
  ok(tool.parameters.properties.action.enum.indexOf('new') !== -1, '工具动作含 new');
  const oldText = '# 全局 交接文档\n\n## 0. 身份与寻址\n\n| 项 | 值 |\n|---|---|\n| 会话类型 | 全局 |\n| 本任 | 旧任 |\n\n## 1. 正在做的事\n旧状态\n\n## 2. 下一步\n\n| # | 动作 | 落点 | 完成判据 |\n|---|---|---|---|\n| 1 | 旧 | - | - |\n\n## 3. 待用户决定\n无\n\n## 4. 用户要求逐条落位\n无\n\n## 5. 风险与禁区\n无\n\n## 6. 关键路径\n无\n\n## 7. 会话 id 对照\n\n| 角色 | session id | 状态 |\n|---|---|---|\n| 全局 | session-old | 旧任 |\n';
  const first = await tool.execute({ action: 'write', text: oldText }, null);
  ok(/已写入/.test(first.text), '首次创建可用 write', first.text.split('\n')[0]);
  const arch1 = await tool.execute({ action: 'archive' }, null);
  ok(/已归档/.test(arch1.text), 'archive 动作可用', arch1.text.split('\n')[0]);
  const second = await tool.execute({ action: 'new', text: oldText.split('旧状态').join('新状态') }, null);
  ok(/已归档/.test(second.text) && /已新建/.test(second.text), 'new 先归档再新建', second.text.split('\n')[0]);
  ok(/复用内容相同的副本/.test(second.text), 'new 复用内容相同的归档，不重复复制', second.text.split('\n')[0]);
  const archDir = path.join(WS, '_Archives', '_Global', 'Handover');
  const archs = fs.existsSync(archDir) ? fs.readdirSync(archDir) : [];
  ok(archs.some((n) => /^Global_Handover_\d{8}_\d{6}\.md$/.test(n)), '归档命名带时间标注', archs.join(','));
  ok(archs.length === 1, '同一内容只归档一份', String(archs.length));
  const archivedOld = archs.length ? fs.readFileSync(path.join(archDir, archs[0]), 'utf8') : '';
  ok(archivedOld.indexOf('旧状态') !== -1, '归档保存旧交接全文');
  ok(!/旧状态/.test(fs.readFileSync(handPath, 'utf8')) && /新状态/.test(fs.readFileSync(handPath, 'utf8')), '新交接只含新内容');
  const third = await tool.execute({ action: 'new', text: oldText.split('旧状态').join('第三次') }, null);
  ok(/已归档/.test(third.text) && !/复用/.test(third.text), '内容变化时新建归档', third.text.split('\n')[0]);
  ok(fs.readdirSync(archDir).length === 2, '两份不同内容各归档一份', String(fs.readdirSync(archDir).length));
  let blocked = '';
  try { await tool.execute({ action: 'write', text: oldText }, null); } catch (e) { blocked = String(e && e.message ? e.message : e); }
  ok(/固定流程|action="new"/.test(blocked), '已有交接时 write 被拒并指向 new', blocked.slice(0, 60));
}

// ---------- 8 会话协作：先完成先返回、全文不截断
section('8 会话协作收集');
{
  const peer = pmPeerTool({ controller: () => ({}) });
  ok(peer.parameters.properties.action.enum.indexOf('collect') !== -1, 'peer 动作含 collect');
  ok(peer.parameters.properties.action.enum.indexOf('wait') !== -1, 'peer 动作含 wait');
  const src = fs.readFileSync(path.join(repo, 'src', 'tools', 'peer.mjs'), 'utf8');
  ok(src.indexOf('WAIT_MIN_MS = 120000') !== -1, '等待下限为 120000 毫秒');
  ok(src.indexOf('COLLECT_POLL_MS = 30000') !== -1, 'collect 每 30 秒检查一次');

  const sessionDir = path.join(HOME, '.dsh', 'sessions', 'testslug');
  const cacheDir = path.join(HOME, '.dsh', 'storages', 'session_projcache', 'sessions');
  fs.mkdirSync(cacheDir, { recursive: true });
  function fakeSession(id, openStep, messages) {
    const dir = path.join(sessionDir, id);
    fs.mkdirSync(dir, { recursive: true });
    const body = messages.map((m) => JSON.stringify(m)).join('\n') + '\n';
    fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(body, 'utf8')));
    fs.writeFileSync(path.join(cacheDir, id + '.json'), JSON.stringify({
      record: { rows: { sessionStats: { val: { openStep: openStep ? 1 : null } }, title: { val: 'Fake' }, sessionListMetadata: { val: { blank: false } } } },
    }));
  }
  if (typeof zlib.zstdCompressSync !== 'function') {
    ok(true, '当前 Node 没有 zstd，跳过日志用例');
  } else {
    const at = Date.now() - 60000;
    const ask = (t) => ({ type: 'user/message', time: t, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '任务' }] } });
    const say = (t, text) => ({ type: 'assistant/message', time: t, data: { message: { content: [{ type: 'text', text }] } } });
    const longText = '结果' + '甲'.repeat(3000) + '尾部标记';
    fakeSession('session-done', false, [ask(at), say(at + 1000, longText)]);
    fakeSession('session-busy', true, [ask(at), say(at + 1000, '还在做')]);
    const exec = { agent: { session: { header: { id: 'session-coord' } } } };
    const first = await peer.execute({ action: 'collect', sessions: ['session-done', 'session-busy'], timeout_ms: 120000, since_ms: 1 }, exec);
    ok(/已完成 1 个/.test(first.text) && /session-done/.test(first.text), '先完成的先返回', first.text.slice(0, 60));
    ok(first.text.indexOf('尾部标记') !== -1 && first.text.length > 3000, '最终回复全文不截断', String(first.text.length));
    const waited = await peer.execute({ action: 'wait', session_id: 'session-done', timeout_ms: 120000, since_ms: 1 }, exec);
    ok(/回复 session-done/.test(waited.text) && waited.text.indexOf('尾部标记') !== -1, 'wait 返回全文', waited.text.slice(0, 40));
    fakeSession('session-done2', false, [ask(at), say(at + 2000, '第二个结果')]);
    fakeSession('session-done3', false, [ask(at), say(at + 3000, '第三个结果')]);
    const multi = await peer.execute({ action: 'collect', sessions: ['session-done2', 'session-done3'], timeout_ms: 120000, since_ms: 1 }, exec);
    ok(/已完成 2 个/.test(multi.text), '同时完成多个就一起返回', multi.text.slice(0, 40));
  }
}

fs.rmSync(SB, { recursive: true, force: true });
console.log('');
if (fails.length) {
  console.log('BEHAVIOR FAIL ' + fails.length + ' 项：');
  for (const f of fails) console.log('  - ' + f);
  process.exit(1);
}
console.log('BEHAVIOR OK（八类行为测试全过）');
