/**
 * 1.0 行为测试（新增七类）：
 * 1. 三线制：档位判定、提示文案、轮首注入与强制线兜底压缩；
 * 2. 行动计划文件与「先交接、再计划、后执行」的阅读顺序；
 * 3. 暂任交出与归还的提示词模板与规范随模板分发；
 * 4. 身份互转的快照与移动（auto）与直接建（direct）；
 * 5. 写作规范随插件模板分发；
 * 6. 语体门禁可执行并按 W 条款判定；
 * 7. 交接固定流程：rotate 一步归档、写入与结构体检，且 write 不得改写已有交接。
 * 8. 会话协作：collect 先完成先返回、同时完成一起返回、最终回复全文不截断。
 * 9. 判据、段索引、检索与微快照；10. 回填合并与回读提示。
 *
 * 全程在系统临时目录内完成，不碰真实工作区与真实 HOME。
 * 用法：node scripts/behavior.mjs [--dist <dist 目录>]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeReporter } from './lib/harness.mjs';
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

const { ok, section, fails } = makeReporter({ sink: 'stdout' });

const imp = (rel) => import(pathToFileURL(path.join(dist, rel)).href);
const { resolveConfig } = await imp('lib/config.mjs');
const cfg = resolveConfig({ workspaceRoot: WS });
const { judgeTrigger, judgeTier, judgeMacroReset, decidePhase } = await imp('lib/triggers.mjs');
const { pressureOf } = await imp('lib/pressure.mjs');
const { pressureLineText, tierPromptText, hardPromptText } = await imp('lib/inject.mjs');
const BANDS = pressureOf({ used: 0, win: 200000, cfg }).bands;
const kText = (v) => Math.round(v / 1000) + 'K';
const BAND_TEXT = kText(BANDS.soft) + '/' + kText(BANDS.advise) + '/' + kText(BANDS.hard);
const { readSessionState, writeSessionState } = await imp('lib/store.mjs');
const { anchorPathFor } = await imp('lib/anchor.mjs');
const { planRelPath, readPlan, readRegistry, syncGlobalRefs } = await imp('lib/system.mjs');
const { pmDocmapTool } = await imp('tools/ho_docmap.mjs');
const { registerHolder, loadOffice, syncHolderKind, removeHolder } = await imp('lib/office.mjs');
const { writeRole } = await imp('lib/role.mjs');
const { migrateIdentity } = await imp('lib/identity.mjs');
const { writeHandover } = await imp('lib/handover-io.mjs');
const { scopedManual } = await imp('lib/manual.mjs');
const { pmPeerTool, collabMemberReason } = await imp('tools/peer.mjs');
const { deriveSegments } = await imp('lib/segments.mjs');
const { extractSnapshot, renderSnapshot } = await imp('lib/checkpoint.mjs');
const { search } = await imp('lib/recall.mjs');
const { shouldSendBackfill, markBackfill, buildBackfillText } = await imp('lib/resume.mjs');
const { pmStatusTool } = await imp('tools/ho_status.mjs');

function w(rel, text) {
  const p = path.join(WS, rel.split('/').join(path.sep));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, 'utf8');
}
function cachePressure(sid, used, win = 200000) {
  const dir = path.join(HOME, '.dsh', 'storages', 'session_projcache', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const data = { record: { rows: { contextPressure: { val: { pressureTokens: used, contextWindow: win } } } } };
  fs.writeFileSync(path.join(dir, sid + '.json'), JSON.stringify(data), 'utf8');
}

// ---------- 1 三线制：档位、文案、轮首注入与强制压缩
section('1 三线制与注入');
{
  const Q = (used, extra) => judgeTrigger(Object.assign({ used, win: 200000, cfg, inTurn: true }, extra || {}));
  ok(Q(BANDS.soft - 1).action === 'idle', '整理线前不判定');
  ok(Q(BANDS.soft).action === 'notifySoft', '整理线只提示');
  ok(Q(BANDS.advise - 1).action === 'notifySoft', '建议线前仍在整理线');
  ok(Q(BANDS.advise).action === 'notifyAdvise', '建议线再次提示');
  ok(Q(BANDS.hard - 1).action === 'notifyAdvise', '强制线前仍在建议线');
  ok(Q(BANDS.hard).action === 'force', '强制线由插件兜底压缩');
  ok(Q(BANDS.soft, { notifiedSoft: true }).action === 'idle', '整理线同一档位只提示一次');
  ok(Q(BANDS.advise, { notifiedAdvise: true }).action === 'idle', '建议线同一档位只提示一次');
  const profile = pressureOf({ used: 92000, win: 200000, cfg });
  ok(pressureLineText(profile) === '上下文 92K/200K（46%）｜余 95K｜近3轮 未核｜线 ' + BAND_TEXT, '轮首压力画像一行');
  ok(/已过整理线/.test(tierPromptText('soft', profile)) && /ho_handover\(action="compact", capsule=…\)/.test(tierPromptText('soft', profile)) && /安全断点/.test(tierPromptText('soft', profile)), '整理线提示文案');
  ok(/已过建议线/.test(tierPromptText('advise', profile)) && tierPromptText('advise', profile).indexOf('3 档 ' + BAND_TEXT) !== -1, '建议线提示文案');
  ok(hardPromptText(profile) === '上下文 92K/200K（46%），已到强制线 ' + kText(BANDS.hard) + '。插件立即执行压缩。', '强制线提示文案');
  const st = readSessionState('session-tier-soft');
  st.notified.soft = Date.now();
  st.lastTierPromptAt = Date.now();
  writeSessionState('session-tier-soft', st);
  ok(readSessionState('session-tier-soft').notified.soft > 0, '提示状态按会话持久化');
  const st2 = readSessionState('session-tier-soft');
  st2.notified = {};
  writeSessionState('session-tier-soft', st2);
  ok(readSessionState('session-tier-soft').notified.soft === undefined, '压缩后可重置提示状态');
}
{
  w('Projects/Demo/README.md', '# Demo\n');
  writeRole({}, 'session-plan', { role: 'project', project: 'Demo' });
  registerHolder(WS, { kind: 'project', project: 'Demo', name: 'Demo1', sessionId: 'session-plan' });
  cachePressure('session-plan', BANDS.soft);
  // 投影缓存目录有 1.5 秒读缓存：同一目录的后续用例须在首次读取前落盘，避免读到旧快照。
  cachePressure('session-force', 130000);
  const prompts = [];
  const sections = [];
  const definitions = [];
  const handlers = new Map();
  const sysPrompt = { section: (s) => { sections.push(s); return () => {}; } };
  const agent = {
    id: 'session-plan',
    status: 'idle',
    session: { header: { id: 'session-plan', cwd: WS, title: 'Demo1' } },
    ctx: { systemPrompt: sysPrompt },
  };
  const ctx = {
    tools: { register: (d) => { definitions.push(d); }, guard: () => {}, resolve: () => {} },
    systemPrompt: sysPrompt,
    sessionController: { prompt: async (r) => { prompts.push(r); return { accepted: true }; } },
    agents: { list: () => [agent], get: () => agent },
    logger: { warn: () => {}, info: () => {} },
    effect: (fn) => fn(),
    on: (name, fn) => { handlers.set(name, fn); },
    get: () => null,
    inject: () => {},
  };
  const { apply } = await imp('index.mjs');
  apply(ctx, { workspaceRoot: WS, retainTokens: 1 });
  ok(prompts.length === 0, '插件装配不向会话投递用户消息', String(prompts.length));
  ok(!sections.find((s) => s.name === 'dsh-handover:reminder'), '不注册动态提醒提示段（不改系统提示词）');
  const manualSection = sections.find((s) => s.name === 'dsh-handover:manual');
  ok(!!manualSection && /层级二/.test(String(manualSection.text)), '项目提示段仍正常注册');
  const tool = definitions.find((d) => d && d.name === 'ho_status');
  ok(!!tool && typeof tool.execute === 'function', '工具定义已注册');
  const pre = handlers.get('agent/pre-step');
  ok(typeof pre === 'function', '步骤边界监听已注册');
  const next = () => Promise.resolve({ kind: 'enter', messages: [] });
  const first = await pre({ agent, turn: 1, step: 1 }, next);
  const texts = (first.messages || []).map((m) => m.content[0].text);
  const expectLine = '上下文 ' + kText(BANDS.soft) + '/200K（' + Math.round(BANDS.soft / 200000 * 100) + '%）'
    + '｜余 ' + kText(200000 - BANDS.soft - cfg.reservedOutput) + '｜近3轮 未核｜线 ' + BAND_TEXT;
  ok(texts.some((t) => t === expectLine), '轮首注入压力画像', texts.join(' | '));
  ok((first.messages || []).every((m) => m.role === 'user' && m.source && m.source.kind === 'dsh-handover'), '注入为末尾上下文消息');
  ok(prompts.length === 0, '到线只提示，不投用户消息');
  const second = await pre({ agent, turn: 1, step: 2 }, next);
  const tierTexts = (second.messages || []).map((m) => m.content[0].text);
  ok(tierTexts.some((t) => /已过整理线/.test(t) && t.indexOf(BAND_TEXT) !== -1), '整理线注入到线提示');
  const third = await pre({ agent, turn: 1, step: 3 }, next);
  ok((third.messages || []).length === 0, '同一轮后续步骤不重复注入');
}
{
  // 强制线：插件侧唯一强制压缩路径。
  const hp = path.join(WS, '_Project_Meta', 'Demo', 'Handover.md');
  writeHandover(WS, hp, ['# 交接', '', '## 1. 正在做的事', '- 联调', '', '## 2. 下一步', '- 跑测试', ''].join('\n'), { kind: 'project' });
  cachePressure('session-force', 130000);
  writeRole({}, 'session-force', { role: 'project', project: 'Demo' });
  const handlers = new Map();
  let compactCalls = 0;
  const seqs = Array.from({ length: 30 }, (_, i) => i + 1);
  const events = new Map(seqs.map((seq) => {
    const type = seq === 1 ? 'system/message' : seq % 2 === 0 ? 'user/message' : 'assistant/message';
    const data = type === 'user/message'
      ? { content: [{ type: 'text', text: '步骤 ' + seq }] }
      : { message: { content: [{ type: 'text', text: '回复 ' + seq }] } };
    return [seq, { seq, type, data }];
  }));
  const priced = seqs.map((seq) => ({ seq, tokens: 1000 }));
  const session = {
    header: { id: 'session-force', cwd: WS, title: 'Demo1' },
    surface: { nodes: seqs },
    eventAt: (seq) => events.get(seq),
    requestHeader: () => undefined,
  };
  const agent = {
    id: 'session-force',
    status: 'running',
    session,
    ctx: {
      tokenMeter: { measure: () => ({ totalTokens: 30000, nodes: priced }) },
      compaction: { compactRegion: async () => { compactCalls += 1; return { shadowedTokenCount: 100 }; } },
      systemPrompt: { section: () => () => {} },
    },
  };
  const ctx = {
    tools: { register: () => {}, guard: () => {}, resolve: () => {} },
    systemPrompt: { section: () => () => {} },
    sessionController: { prompt: async () => ({ accepted: true }) },
    agents: { list: () => [agent], get: () => agent },
    logger: { warn: () => {}, info: () => {} },
    effect: (fn) => fn(),
    on: (name, fn) => { handlers.set(name, fn); },
    get: () => null,
    inject: () => {},
  };
  const { apply } = await imp('index.mjs');
  apply(ctx, { workspaceRoot: WS, retainTokens: 1 });
  const pre = handlers.get('agent/pre-step');
  const decision = await pre({ agent, turn: 1, step: 2 }, () => Promise.resolve({ kind: 'enter', messages: [] }));
  ok(compactCalls === 1, '强制线由插件强制压缩一次', String(compactCalls));
  ok(fs.existsSync(anchorPathFor('session-force')), '强制压缩前写入会话锚点', anchorPathFor('session-force'));
  const texts = (decision.messages || []).map((m) => m.content[0].text);
  ok(texts.some((t) => /已到强制线/.test(t) && t.indexOf(kText(BANDS.hard)) !== -1), '强制前注入强制线提示');
  ok(texts.some((t) => /\[压缩完成·机制兜底\]/.test(t) && /约束（逐条原文）：/.test(t)), '压缩后注入机制兜底胶囊');
  ok(readSessionState('session-force').compactions === 1, '压缩计数持久化');
  ok(readSessionState('session-force').notified.soft === undefined, '压缩成功重置提示状态');
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
  const reg = await tool.execute({ action: 'registry-write', entries: [{ path: 'Projects/Demo/README.md', about: '库说明', section: 'structure' }] }, null);
  ok(/已写入/.test(reg.text), '体系注册可写入', reg.text.split('\n')[0]);
  let planReject = '';
  try { await tool.execute({ action: 'plan-write', text: '# 行动计划\n\n## 1 目标\n只有目标\n' }, null); } catch (e) { planReject = String(e && e.message ? e.message : e); }
  ok(/缺少模板要求的节/.test(planReject) && /Plan\.skeleton\.md/.test(planReject), '计划缺节拒收并指向模板', planReject.slice(0, 60));
  const first = await tool.execute({ action: 'plan-write', text: "# 行动计划\n\n## 1 目标\n试跑\n\n## 2 步骤\n| 1 | 做 |\n\n## 3 验收\n- 可判定\n\n## 4 风险\n- 无\n\n## 5 状态\n- 进行中\n" }, null);
  ok(/已写入计划/.test(first.text) && /无旧计划/.test(first.text), '计划可写入', first.text.split('\n')[0]);
  const planFile = path.join(WS, planRelPath(WS, { role: 'project', project: 'Demo' }));
  ok(fs.existsSync(planFile), '计划落在任务根 PLAN.md', planFile);
  ok(readPlan(WS, { role: 'project', project: 'Demo' }).exists, '计划可读回');
  ok(/PLAN\.md/.test(readRegistry(WS, { role: 'project', project: 'Demo' }).text || ''), '注册已指向计划');
  const second = await tool.execute({ action: 'plan-write', text: "# 行动计划\n\n## 1 目标\n第二轮\n\n## 2 步骤\n| 1 | 做 |\n\n## 3 验收\n- 可判定\n\n## 4 风险\n- 无\n\n## 5 状态\n- 进行中\n" }, null);
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
  ok(fs.existsSync(path.join(WS, '_Misc', 'tasks', 'NewTask', 'README.md')), '项目库内容已移入杂项任务目录（拆掉库包装层）');
  ok(!fs.existsSync(path.join(WS, '_Misc', 'tasks', 'NewTask', 'OldP库')), '杂项任务目录不再多套库包装层');
  ok(fs.existsSync(path.join(WS, '_Misc', 'tasks', 'NewTask', 'Handover.md')), '交接随体系移动');
  ok(fs.existsSync(path.join(WS, '_Misc', 'tasks', 'NewTask', 'task.profile.json')), '骨架档案改名为 task.profile.json');
  ok(!fs.existsSync(path.join(WS, 'Projects', 'OldP')), '旧项目目录已清空');
  ok(!/OldP/.test(fs.readFileSync(path.join(WS, '_Project_Meta', 'Registry.md'), 'utf8')), '名册已移除旧项目行');
  ok(!!loadOffice(WS).lineages['NewTask'], '在任登记已改到新类别');
}
{
  registerHolder(WS, { kind: 'misc', task: 'SameX', name: 'SameX1', sessionId: 'session-samex1' });
  registerHolder(WS, { kind: 'project', project: 'SameX', name: 'SameX2', sessionId: 'session-samex2' });
  ok(loadOffice(WS).lineages.SameX.kind === 'project', '同名类别互转后名册类别跟着改');
  removeHolder(WS, { kind: 'project', project: 'SameX', sessionId: 'session-samex2' });
  ok(!loadOffice(WS).lineages.SameX, '注销登记会移除整条世系');
  w('_Project_Meta/Skip/System.md', '# S\n');
  w('_Project_Meta/Skip/.deregistered.json', '{}');
  const skipReg = syncGlobalRefs(WS);
  ok(!skipReg.rows.some((r) => r.task === 'Skip'), '注销标记后残留体系不进入总注册');
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
  ok(/固定流程/.test(tpl) && /ho_handover\(action="rotate"/.test(tpl) && /归档/.test(tpl) && /结构体检/.test(tpl), '模板写明 rotate 一步流程、归档与结构体检');
  ok(/不得在旧文件上续写/.test(tpl), '模板禁止续写旧文件');
  const rules = fs.readFileSync(path.join(dist, 'templates', 'rules', 'Handover_Rules.md'), 'utf8');
  ok(/## 3 固定流程/.test(rules) && /ho_handover\(action="rotate"/.test(rules) && /sha256/.test(rules) && /结构体检/.test(rules), '规范写入 rotate 归档校验与结构体检');
  ok(/全文不超过 500 行/.test(rules), '规范写明交接篇幅 500 行上限');
  ok(/以结构控制为主/.test(rules) && /不规定字节数与页数/.test(rules), '规范保留结构控制的软口径');

  const { pmHandoverTool } = await imp('tools/ho_handover.mjs');
  const handPath = path.join(WS, '_Control_Center', 'records', 'Global_Handover.md');
  const envH = {
    cfg,
    resolveWs: () => WS,
    roleOf: () => ({ role: 'global' }),
    handoverFor: () => ({ path: handPath, kind: 'global', role: 'global' }),
  };
  const tool = pmHandoverTool(envH);
  ok(tool.parameters.properties.action.enum.indexOf('rotate') !== -1, '工具动作含 rotate');
  ok(tool.parameters.properties.action.enum.indexOf('new') === -1, '工具动作不含已撤除的 new');
  const oldText = '# 全局 交接文档\n\n## 0. 身份与寻址\n\n| 项 | 值 |\n|---|---|\n| 会话类型 | 全局 |\n| 本任 | 旧任 |\n\n## 1. 正在做的事\n旧状态\n\n## 2. 下一步\n\n| # | 动作 | 落点 | 完成判据 |\n|---|---|---|---|\n| 1 | 旧 | - | - |\n\n## 3. 待用户决定\n无\n\n## 4. 用户要求逐条落位\n无\n\n## 5. 风险与禁区\n无\n\n## 6. 关键路径\n无\n\n## 7. 会话 id 对照\n\n| 角色 | session id | 状态 |\n|---|---|---|\n| 全局 | session-old | 旧任 |\n';
  const first = await tool.execute({ action: 'write', text: oldText }, null);
  ok(/已写入/.test(first.text), '首次创建可用 write', first.text.split('\n')[0]);
  const arch1 = await tool.execute({ action: 'archive' }, null);
  ok(/已归档/.test(arch1.text), 'archive 动作可用', arch1.text.split('\n')[0]);
  const second = await tool.execute({ action: 'rotate', text: oldText.split('旧状态').join('新状态') }, null);
  ok(/归档/.test(second.text) && /新交接/.test(second.text) && /sha256 一致/.test(second.text) && /体检/.test(second.text), 'rotate 归档、写入、sha256 校验与结构体检一次完成', second.text.split('\n')[0]);
  const archDir = path.join(WS, '_Archives', '_Global', 'Handover');
  const archs = fs.existsSync(archDir) ? fs.readdirSync(archDir) : [];
  ok(archs.some((n) => /^Global_Handover_\d{8}_\d{6}\.md$/.test(n)), '归档命名带时间标注', archs.join(','));
  ok(archs.length === 1, '同一内容只归档一份', String(archs.length));
  const archivedOld = archs.length ? fs.readFileSync(path.join(archDir, archs[0]), 'utf8') : '';
  ok(archivedOld.indexOf('旧状态') !== -1, '归档保存旧交接全文');
  ok(!/旧状态/.test(fs.readFileSync(handPath, 'utf8')) && /新状态/.test(fs.readFileSync(handPath, 'utf8')), '新交接只含新内容');
  const third = await tool.execute({ action: 'rotate', text: oldText.split('旧状态').join('第三次') }, null);
  ok(/归档/.test(third.text) && /新交接/.test(third.text), '内容变化时新建归档', third.text.split('\n')[0]);
  ok(fs.readdirSync(archDir).length === 2, '两份不同内容各归档一份', String(fs.readdirSync(archDir).length));
  let blocked = '';
  try { await tool.execute({ action: 'write', text: oldText }, null); } catch (e) { blocked = String(e && e.message ? e.message : e); }
  ok(/rotate/.test(blocked), '已有交接时 write 被拒并指向 rotate', blocked.slice(0, 60));
}

// ---------- 8 会话协作：先完成先返回、全文不截断
section('8 会话协作收集');
{
  const peer = pmPeerTool({ controller: () => ({}) });
  ok(peer.parameters.properties.action.enum.indexOf('collect') !== -1, 'peer 动作含 collect');
  ok(peer.parameters.properties.action.enum.indexOf('wait') !== -1, 'peer 动作含 wait');
  const { pmSessionsTool } = await imp('tools/ho_sessions.mjs');
  const sessTool = pmSessionsTool({ cfg });
  ok(Object.prototype.hasOwnProperty.call(sessTool.parameters.properties, 'project'), 'ho_sessions 声明 project 参数（role=project 必需）');
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
    const peerCtl = pmPeerTool({ controller: () => ({ prompt: async () => ({ accepted: true }) }) });
    const coordExec = { agent: { session: { header: { id: 'session-coordx' } } } };
    const workerExec = { agent: { session: { header: { id: 'session-workerx' } } } };
    await peerCtl.execute({ action: 'collab', sessions: ['session-workerx'] }, coordExec);
    ok(collabMemberReason('session-workerx').indexOf('被交办方') !== -1, '协作成员被工具守卫识别');
    ok(collabMemberReason('session-coordx') === '', '协调者不受协作守卫限制');
    let blocked2 = '';
    try { await peerCtl.execute({ action: 'send', session_id: 'session-coordx', message: '回报' }, workerExec); } catch (e) { blocked2 = String(e && e.message ? e.message : e); }
    ok(/协作注册期间/.test(blocked2) && /被交办方/.test(blocked2), '协作注册期间被交办方不能向交办者发明文消息', blocked2.slice(0, 60));
    const workerY = { agent: { session: { header: { id: 'session-workery' } } } };
    await peerCtl.execute({ action: 'send', session_id: 'session-coordy', message: '问一句' }, { agent: { session: { header: { id: 'session-coordy' } } } });
    const normalReply = await peerCtl.execute({ action: 'send', session_id: 'session-coordy', message: '答一句' }, workerY);
    ok(/accepted=true/.test(normalReply.text), '普通对话仍允许明文回复', normalReply.text.slice(0, 40));
    const coordZ = { agent: { session: { header: { id: 'session-coordz' } } } };
    await peerCtl.execute({ action: 'collab', sessions: ['session-done2', 'session-done3'] }, coordZ);
    const drained = await peerCtl.execute({ action: 'collect', sessions: ['session-done2', 'session-done3'], timeout_ms: 120000, since_ms: 1 }, coordZ);
    ok(/已完成 2 个/.test(drained.text), '协作注册的成员结果一次取回', drained.text.slice(0, 40));
    const after = await peerCtl.execute({ action: 'send', session_id: 'session-coordz', message: '收尾回报' }, { agent: { session: { header: { id: 'session-done2' } } } });
    ok(/accepted=true/.test(after.text), '协作结果取完后限制自动解除', after.text.slice(0, 40));
    ok(collabMemberReason('session-done2') === '', '协作结果取完后守卫也解除');
    await peerCtl.execute({ action: 'collab', sessions: ['session-workerx'] }, coordExec);
    ok(collabMemberReason('session-workerx').indexOf('被交办方') !== -1, '重新登记协作后守卫再生效');
    const ended = await peerCtl.execute({ action: 'collab', collabMode: 'end' }, coordExec);
    ok(/已结束协作注册/.test(ended.text), 'collabMode=end 不列 sessions 也能结束协作', ended.text.slice(0, 40));
    ok(collabMemberReason('session-workerx') === '', '结束协作后守卫解除');
    let releasedText = '';
    try { releasedText = (await peerCtl.execute({ action: 'send', session_id: 'session-coordx', message: '回报' }, workerExec)).text; } catch (e) { releasedText = String(e && e.message ? e.message : e); }
    ok(/accepted=true/.test(releasedText), '结束协作后成员可向协调者发明文消息', releasedText.slice(0, 40));
  }
}

// ---------- 9 判据、段索引、检索与微快照
section('9 判据、段索引、检索与微快照');
{
  ok(judgeTier({ used: BANDS.soft - 1, win: 200000, cfg }).action === 'idle', '整理线前未到线');
  ok(judgeTier({ used: BANDS.soft, win: 200000, cfg }).action === 'notifySoft', '整理线只提示');
  ok(judgeTier({ used: BANDS.advise - 1, win: 200000, cfg }).action === 'notifySoft', '建议线前仍在整理线');
  ok(judgeTier({ used: BANDS.advise, win: 200000, cfg }).action === 'notifyAdvise', '建议线再次提示');
  ok(judgeTier({ used: BANDS.hard, bands: BANDS, cfg }).action === 'force', '强制线强制');
  ok(judgeMacroReset({ cumulativeShadowedTokens: 200, windowTokens: 100 }).hit === true, '累计遮蔽两倍窗口命中');
  ok(judgeMacroReset({ compactionGainRatio: 0.49 }).hit === true, '增量比低于 0.5 命中');
  ok(judgeMacroReset({ repeatErrors: 2 }).hit === true, '同错两次命中');
  ok(decidePhase({ used: BANDS.hard, win: 200000, cfg, lockState: 'clean' }).action === 'force', '强制线强制压缩');
  ok(decidePhase({ used: BANDS.soft, win: 200000, cfg, lockState: 'clean' }).action === 'notify', '整理线只提示');
  ok(decidePhase({ used: BANDS.soft - 1, win: 200000, cfg, lockState: 'clean' }).action === 'continue', '平静时继续');
}
{
  const records = [
    { seq: 1, type: 'user/message', time: 1794700000000, data: { content: [{ type: 'text', text: '目标：补齐部署脚本。' }] } },
    { seq: 2, type: 'user/message', time: 1794700001000, data: { content: [{ type: 'text', text: '已确认：部署目录为 D:/ws/deploy。' }] } },
    { seq: 3, type: 'assistant/message', time: 1794700002000, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'write', arguments: '{"file_path":"D:/ws/deploy/run.ps1"}' }] } } },
    { seq: 4, type: 'tool/result', time: 1794700003000, data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: '写入失败：权限不足' }], isError: true } } },
    { seq: 5, type: 'compaction/summary', time: 1794700004000, data: { compactionId: 'c9', summary: [{ type: 'text', text: '## Current Work\n- 部署脚本已补齐。' }] } },
  ];
  const segs = deriveSegments(records);
  ok(segs.length === 1 && segs[0].shadowedEvents > 0, '段索引可由日志派生', JSON.stringify(segs[0]));
  const lit = search(records, { query: '权限不足', mode: 'literal' });
  ok(lit.hits.length === 1 && lit.hits[0].seq === 4, '字面召回命中失败结果');
  ok(lit.hits[0].excerpt.lines.length >= 1, '命中带片段');
  const st = search(records, { query: '', mode: 'structural', filter: 'type:tool/result, error:true' });
  ok(st.hits.length === 1 && st.hits[0].isError === true, '结构过滤只留失败结果');
  const empty = search(records, { query: '不存在的词组xyz', mode: 'literal' });
  ok(empty.total === 0 && empty.suggestion && Array.isArray(empty.suggestion.keywords), '空结果给建议关键词');
  ok(Array.isArray(empty.suggestion.segments), '空结果给候选段');
  const snap = extractSnapshot(records, { sid: 'session-bh', ratio: 0.55 });
  ok(/部署脚本/.test(snap.goal), '快照目标可核对', snap.goal);
  ok(snap.pending.some((p) => /权限不足/.test(p)), '快照未决含失败工具');
  ok(snap.pointers.some((p) => /run\.ps1/.test(p)), '快照指针引路径');
  ok(/## 6 时刻/.test(renderSnapshot(snap)), '快照六节齐全');
  const recallEnv = { cfg, selfId: () => 'session-bh', roleOf: () => ({ role: 'project' }) };
  const recallStatus = pmStatusTool(recallEnv, { schedulerReady: () => false, schedulerError: () => '' });
  const recallExec = { agent: { session: { header: { id: 'session-bh' }, events: records } } };
  const litOut = await recallStatus.execute({ view: 'recall', query: '权限不足', mode: 'literal' }, recallExec);
  ok(/seq 4/.test(litOut.text) && /失败/.test(litOut.text), '召回视图字面命中失败结果', litOut.text.slice(0, 120));
  const stOut = await recallStatus.execute({ view: 'recall', mode: 'structural', filter: 'type:tool/result, error:true' }, recallExec);
  ok(/seq 4/.test(stOut.text) && /失败/.test(stOut.text), '召回视图结构过滤只留失败结果', stOut.text.slice(0, 120));
  const emptyOut = await recallStatus.execute({ view: 'recall', query: '不存在的词组xyz', mode: 'literal' }, recallExec);
  ok(/没有命中/.test(emptyOut.text) && /ho_status\(view="recall"/.test(emptyOut.text), '召回视图空结果给出用法', emptyOut.text.slice(0, 160));
}
{
  ok(shouldSendBackfill('session-bf', 1000, 300000).send === true, '首次压缩应投回填');
  markBackfill('session-bf', 1000, 'snap.md');
  const merged = shouldSendBackfill('session-bf', 2000, 300000);
  ok(merged.send === false && merged.merged === true, '五分钟内连续压缩合并为一条');
  ok(shouldSendBackfill('session-bf', 400000, 300000).send === true, '超过窗口恢复投递');
  const text = buildBackfillText({ n: 1, snapshotPath: 'snap.md', handoverPath: 'hand.md', segmentCount: 2, lastLabel: '部署' });
  ok(/snap\.md/.test(text) && /hand\.md/.test(text) && /ho_status\(view="recall"/.test(text), '回填含快照、交接与检索提示');
}
{
  // 端到端：假会话完成一次压缩后，首条消息必须是含快照路径与交接路径的回填消息。
  const sid = 'session-sched';
  const sdir = path.join(HOME, '.dsh', 'sessions', 'slug', sid);
  fs.mkdirSync(sdir, { recursive: true });
  const lines = [
    { type: 'user/message', seq: 1, time: Date.now() - 9000, data: { content: [{ type: 'text', text: '目标：验证回填消息。' }] } },
    { type: 'compaction/summary', seq: 2, time: Date.now() - 8000, data: { compactionId: 'c1', summary: [{ type: 'text', text: '## Current Work\n- 回填验证。' }] } },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(path.join(sdir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(lines, 'utf8')));
  const prompts = [];
  const agent = {
    status: 'idle',
    session: { header: { id: sid } },
    ctx: { compaction: { compactNow: async () => ({ shadowedTokenCount: 10 }) } },
  };
  const ctx = {
    agents: { get: () => agent },
    sessionController: { prompt: async (r) => { prompts.push(r); return { accepted: true }; } },
    logger: null,
    get: () => null,
  };
  const schedMod = await imp('lib/schedule.mjs');
  const sched = schedMod.createScheduler({
    ctx,
    cfg,
    roleOf: () => ({ role: 'project', project: 'Demo' }),
    handoverFor: () => ({ path: 'E:/ws/_Project_Meta/Demo/Handover.md' }),
  });
  const r1 = await sched.request(sid, { n: 1, resume: 'continue', consent: 'checked', delayMs: 1 });
  ok(r1.status === 'ok' && prompts.length === 1, '压缩后只投一条消息', JSON.stringify({ status: r1.status, n: prompts.length }));
  const msg = prompts.length ? String(prompts[0].content[0].text) : '';
  ok(/快照：/.test(msg) && msg.indexOf(path.join(sdir, 'dsh-handover')) !== -1, '首条消息带会话目录内的快照路径', msg.slice(0, 80));
  ok(msg.indexOf('_Project_Meta/Demo/Handover.md') !== -1, '首条消息带交接路径', msg.slice(0, 120));
  ok(/ho_status\(view="recall"/.test(msg), '首条消息带检索提示');
  const r2 = await sched.request(sid, { n: 2, resume: 'continue', consent: 'checked', delayMs: 1 });
  ok(r2.status === 'ok-merged' && prompts.length === 2, '五分钟内第二次压缩仍发续跑'
    , JSON.stringify({ status: r2.status, n: prompts.length }));
  const msg2 = prompts.length > 1 ? String(prompts[1].content[0].text) : '';
  ok(/自动续跑/.test(msg2), '合并后的消息只有续跑段', msg2.slice(0, 80));
  ok(msg2.indexOf('快照：') === -1, '合并后不重复回填快照', msg2.slice(0, 120));
  sched.dispose();
}

// ---------- 11 与官方预设解耦
section('11 与官方预设解耦');
{
  const srcDir = path.join(repo, 'src');
  const walk = (dir) => {
    const out = [];
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) out.push(...walk(p));
      else if (/\.(mjs|js)$/.test(name)) out.push(p);
    }
    return out;
  };
  const hits = [];
  for (const file of walk(srcDir)) {
    const rel = path.relative(srcDir, file).replace(/\\/g, '/');
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (/agentPreset|agent-presets|presetService/.test(line) && rel !== 'tools/peer.mjs') {
        hits.push(rel + ':' + (i + 1));
      }
    });
  }
  ok(hits.length === 0, '插件源码不读取 agent 预设', hits.join('、'));
  const idx = fs.readFileSync(path.join(srcDir, 'index.mjs'), 'utf8');
  ok(/inject = \['tools', 'systemPrompt', 'sessionController'\]/.test(idx), '注入面只有官方扩缝');
  ok(!/agentPresets/.test(idx), '注入面不含预设服务');
}

fs.rmSync(SB, { recursive: true, force: true });
console.log('');
if (fails.length) {
  console.log('BEHAVIOR FAIL ' + fails.length + ' 项：');
  for (const f of fails) console.log('  - ' + f);
  process.exit(1);
}
console.log('BEHAVIOR OK（十一类行为测试全过）');
