/**
 * 自测台：判据、快照、段索引、检索、回填的表格驱动单测，外加工具只读冒烟。
 * 用法：node src/selftest.mjs [--ws <工作区根>] [--session <session id>] [--tool status|gate|docmap|office|succeed|action|all]
 * 退出码 0 表示全部通过。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveConfig } from './lib/config.mjs';
import { projCacheDir, readPressure } from './lib/sessions.mjs';
import { readJsonDir, readJsonFileLazy, isDir, isFile } from './lib/text.mjs';
import { migrateIdentity } from './lib/identity.mjs';
import { capText, HANDOVER_MAX_LINES, STATUS_MAX_LINES } from './lib/limit.mjs';
import { judgeMacroReset, judgeHardCap, decidePhase, judgeTrigger, judgeTier } from './lib/triggers.mjs';
import { usableWindow, bandsFor, judgeLevel, growthOf, pressureOf, roiOf, lowRoiStreakOf, settlePendingAfter } from './lib/pressure.mjs';
import { selectCompactionRange, selectFullRange, compactInTurn, INLINE_UNAVAILABLE } from './lib/engine.mjs';
import { createInlineEngine } from './lib/inline-engine.mjs';
import { compactionStateOf } from './lib/events.mjs';
import { deriveSegments, segmentStats, segmentForSeq, gainRatio } from './lib/segments.mjs';
import { extractSnapshot, renderSnapshot, maybeSemanticSnapshot, bypassCount, resetBypassCount, writeSnapshot, listSnapshots } from './lib/checkpoint.mjs';
import { pressureLineText, tierPromptText, hardPromptText, successionPromptText, successionCeilingText, rubricText } from './lib/inject.mjs';
import { judgeAssistantCompact } from './lib/compact-gate.mjs';
import { extractConstraints, probeConstraints } from './lib/constraints.mjs';
import { mergeAnchor, readAnchor } from './lib/anchor.mjs';
import { renderCapsule, extractKeywordSentences, CAPSULE_MAX_CHARS, CAPSULE_RENDER_MAX_CHARS } from './lib/capsule.mjs';
import { storeDirFor, writeSessionState, readSessionState, storeInfo } from './lib/store.mjs';
import { adoptLegacyStore } from './lib/compat.mjs';
import { search, regexIssue, aroundEvents } from './lib/recall.mjs';
import { carryItemsOf, fileSha256 } from './lib/handover-io.mjs';
import { judgeRotateGate } from './lib/succession.mjs';
import { toolsetFor } from './lib/role.mjs';
import { ALL_TOOL_NAMES } from './lib/names.mjs';
import { pmStatusTool } from './tools/ho_status.mjs';
import { pmHandoverTool } from './tools/ho_handover.mjs';
import { pmDocmapTool } from './tools/ho_docmap.mjs';
import { pmSessionsTool } from './tools/ho_sessions.mjs';
import { pmWorkspaceTool } from './tools/ho_workspace.mjs';
import { pmPeerTool } from './tools/peer.mjs';
import { newSessionIn } from './lib/session-create.mjs';
import { abortableDelay, ABORTED_TEXT } from './lib/abort.mjs';
import { createSkipLogger } from './lib/skip-log.mjs';
import { nextName, registerHolder } from './lib/office.mjs';
import { resolveShortSid } from './lib/api.mjs';
import { decodeLogResult } from './lib/zstd-log.mjs';
import { syncCheck } from './lib/gates.mjs';
import { checkRegistries, syncGlobalRefs } from './lib/system.mjs';
import { validateProfile } from './lib/profile.mjs';
import { createInitErrors } from './index.mjs';

const argv = process.argv.slice(2);
function argOf(flag, dflt) {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : dflt;
}

const fails = [];
let total = 0;
function check(name, cond, extra) {
  total++;
  if (!cond) fails.push(name + (extra ? ' → ' + extra : ''));
}
function eq(name, got, want) {
  check(name, JSON.stringify(got) === JSON.stringify(want), '实得 ' + JSON.stringify(got));
}

/* ---------------- 判据表 ---------------- */

/* ---------------- 分档（token）：整理线、建议线、强制线 ---------------- */

const PB = { soft: 65450, advise: 93500, hard: 121550, host: 160000 };
const Q = (used, extra) => judgeTier(Object.assign({ used, win: 200000, bands: PB }, extra || {}));
eq('soft-1 不判定', Q(65449).action, 'idle');
eq('soft 提示整理线', Q(65450).action, 'notifySoft');
eq('advise-1 仍在整理线', Q(93499).action, 'notifySoft');
eq('advise 提示建议线', Q(93500).action, 'notifyAdvise');
eq('hard-1 仍在建议线', Q(121549).action, 'notifyAdvise');
eq('hard 强制', Q(121550).action, 'force');
eq('hard 强制取强制线', Q(121550).line, 121550);
eq('水位读不到不判定', Q(null).action, 'idle');

const M = (o) => judgeMacroReset(o);
eq('累计遮蔽两倍窗口命中', M({ cumulativeShadowedTokens: 200, windowTokens: 100 }).hit, true);
eq('累计遮蔽不足不命中', M({ cumulativeShadowedTokens: 199, windowTokens: 100 }).hit, false);
eq('窗口未知不判遮蔽', M({ cumulativeShadowedTokens: 999, windowTokens: 0 }).hit, false);
eq('增量比 0.49 命中', M({ compactionGainRatio: 0.49 }).hit, true);
eq('增量比 0.5 不命中', M({ compactionGainRatio: 0.5 }).hit, false);
eq('增量比未知不命中', M({ compactionGainRatio: null }).hit, false);
eq('同错两次命中', M({ repeatErrors: 2 }).hit, true);
eq('同文件两次命中', M({ repeatFiles: 2 }).hit, true);
eq('各一次不命中', M({ repeatErrors: 1, repeatFiles: 1 }).hit, false);
eq('里程碑命中', M({ milestone: true }).hit, true);
eq('用户要求命中', M({ userRequest: true }).hit, true);
eq('四项皆无', M({}).hit, false);
eq('整理线以上不静默', M({ repeatErrors: 2, used: 90000, bands: PB }).hit, true);
eq('整理线以下只记录', M({ repeatErrors: 2, used: 1000, bands: PB }).hit, false);
eq('低水位用户要求仍提示', M({ userRequest: true, used: 1000, bands: PB }).hit, true);

eq('硬顶 hard-1 未命中', judgeHardCap({ used: 121549, bands: PB }).hit, false);
eq('硬顶 hard 命中', judgeHardCap({ used: 121550, bands: PB }).hit, true);
eq('硬顶读不到不误报', judgeHardCap({ used: null, bands: PB }).hit, false);

/* ---------------- 步骤边界判定（分档 + 闸门 + 去重） ---------------- */

const T = (o) => judgeTrigger(Object.assign({ inTurn: true, win: 200000, bands: PB }, o));
eq('soft-1 不判定', T({ used: 65449 }).action, 'idle');
eq('soft 只提示', T({ used: 65450 }).action, 'notifySoft');
eq('advise-1 只提示', T({ used: 93499 }).action, 'notifySoft');
eq('advise 只提示', T({ used: 93500 }).action, 'notifyAdvise');
eq('hard-1 只提示', T({ used: 121549 }).action, 'notifyAdvise');
eq('hard 强制', T({ used: 121550 }).action, 'force');
eq('空闲会话不判定', T({ used: 190000, inTurn: false }).action, 'idle');
eq('空闲会话强制线亦不判定', T({ used: 190000, inTurn: false }).action, 'idle');
eq('锁未闭合不判定', T({ used: 121550, lockState: 'open' }).action, 'idle');
eq('锁未闭合时低水位也不判定', T({ used: 70000, lockState: 'open' }).action, 'idle');
eq('冷却中不判定', T({ used: 70000, cooldownLeftMs: 1000 }).action, 'idle');
eq('冷却结束可判定', T({ used: 70000, cooldownLeftMs: 0 }).action, 'notifySoft');
eq('水位未知不判定', T({ used: null }).action, 'idle');
eq('整理线已提示过不重复', T({ used: 70000, notifiedSoft: true }).action, 'idle');
eq('建议线已提示过不重复', T({ used: 100000, notifiedSoft: true, notifiedAdvise: true }).action, 'idle');
eq('建议线未提示过仍提示', T({ used: 100000, notifiedSoft: true }).action, 'notifyAdvise');
eq('强制不受去重影响', T({ used: 130000, notifiedSoft: true, notifiedAdvise: true }).action, 'force');
eq('分档 × 闸门：soft 冷却', T({ used: 65450, cooldownLeftMs: 5000 }).action, 'idle');
eq('分档 × 闸门：advise 锁', T({ used: 93500, lockState: 'open' }).action, 'idle');
eq('分档 × 闸门：hard 冷却', T({ used: 121550, cooldownLeftMs: 5000 }).action, 'idle');

/* ---------------- 压力遥测：分档、档位、增速、注入行 ---------------- */

const pCfg = {
  reservedOutput: 13000,
  softRatio: 0.35,
  adviseRatio: 0.50,
  hardRatioCap: 0.65,
};

eq('200K 窗可用窗口', usableWindow(200000, pCfg), 187000);
eq('可用窗口不为负', usableWindow(10000, pCfg), 0);
const b200 = bandsFor(pCfg, 200000);
eq('200K 窗三档按窗口 35/50/65%', [b200.soft, b200.advise, b200.hard], [70000, 100000, 130000]);
eq('200K 窗宿主线', b200.host, 160000);
check('预留输出不参与分档', bandsFor(Object.assign({}, pCfg, { reservedOutput: 50000 }), 200000).hard === 130000);
const b1m = bandsFor(pCfg, 1000000);
eq('1M 窗三档按窗口 35/50/65%', [b1m.soft, b1m.advise, b1m.hard], [350000, 500000, 650000]);
const b1m2 = bandsFor(pCfg, 1048576);
eq('1048576 窗三档按窗口 35/50/65%', [b1m2.soft, b1m2.advise, b1m2.hard], [367002, 524288, 681574]);
const b128 = bandsFor(pCfg, 131072);
eq('131072 窗三档按窗口 35/50/65%', [b128.soft, b128.advise, b128.hard], [45875, 65536, 85197]);
eq('窗口读不到不判定', bandsFor(pCfg, null), null);
eq('窗口非正不判定', bandsFor(pCfg, 0), null);
const bMono = bandsFor(Object.assign({}, pCfg, { softRatio: 0.8, adviseRatio: 0.1, hardRatioCap: 0.5 }), 200000);
check('分档单调不减', bMono.soft <= bMono.advise && bMono.advise <= bMono.hard, JSON.stringify(bMono));

const L = (used) => judgeLevel({ used, win: 200000, cfg: pCfg });
eq('soft-1 为 low', L(69999).level, 'low');
eq('soft 为 soft', L(70000).level, 'soft');
eq('advise-1 为 soft', L(99999).level, 'soft');
eq('advise 为 advise', L(100000).level, 'advise');
eq('hard-1 为 advise', L(129999).level, 'advise');
eq('hard 为 hard', L(130000).level, 'hard');
const badLv = judgeLevel({ used: Number.NaN, win: 200000, cfg: pCfg });
eq('水位非法返回 unknown', [badLv.level, badLv.ratio, badLv.headroom], ['unknown', null, null]);
eq('窗口非法返回 unknown', judgeLevel({ used: 100, win: 0, cfg: pCfg }).level, 'unknown');

eq('3 个增量取中位数', growthOf([{ at: 1, used: 100 }, { at: 2, used: 200 }, { at: 3, used: 280 }, { at: 4, used: 400 }]), 100);
eq('样本不足返回 null', growthOf([{ at: 1, used: 100 }, { at: 2, used: 200 }, { at: 3, used: 300 }]), null);
eq('空历史返回 null', growthOf([]), null);

const prof = pressureOf({
  used: 92000,
  win: 200000,
  cfg: pCfg,
  history: [{ at: 1, used: 70000 }, { at: 2, used: 81000 }, { at: 3, used: 92000 }, { at: 4, used: 103000 }],
});
eq('画像档位', prof.level, 'soft');
eq('画像剩余轮数', prof.remainingTurns, Math.floor((130000 - 92000) / 11000));
const pLine = pressureLineText(prof);
check('注入行含 used/win', pLine.indexOf('92K/200K') !== -1, pLine);
check('注入行含三档线', pLine.indexOf('70K') !== -1 && pLine.indexOf('130K') !== -1, pLine);
check('注入行不超过 80 字', pLine.length <= 80, String(pLine.length));
const pUnknown = pressureLineText(pressureOf({ used: null, win: null, cfg: pCfg }));
check('未知水位数写未核', pUnknown.indexOf('未核') !== -1 && pUnknown.indexOf('NaN') === -1 && pUnknown.indexOf('0K') === -1, pUnknown);

eq('收益 100K 降到 45K 为 0.55', roiOf(100000, 45000), 0.55);
eq('收益输入非法返回 null', roiOf(null, 0), null);
eq('连续两次低收益计为 2', lowRoiStreakOf([0.20, 0.25], 0.30), 2);
eq('中间一次达标后只计最近一次', lowRoiStreakOf([0.20, 0.40, 0.20], 0.30), 1);
eq('最近一次达标归零', lowRoiStreakOf([0.20, 0.25, 0.40], 0.30), 0);

// D-171：压缩后读数校准。待校准只消费一次，真实水位来自宿主投影，读不到就不填数。
{
  const st = {
    tokensBefore: 318789,
    tokensAfter: null,
    roi: null,
    pendingAfter: { before: 318789, shadowed: 208891, at: 1, range: '1990-2311' },
  };
  const first = settlePendingAfter(st, 36428, 0.30);
  eq('校准写入宿主投影水位', st.tokensAfter, 36428);
  eq('校准按真实水位重算收益', Math.round(st.roi * 1000) / 1000, 0.886);
  eq('校准只追加一条收益记录', st.roiHistory.length, 1);
  eq('校准消费掉待校准记录', st.pendingAfter, undefined);
  eq('首次校准标记已测量', first.measured, true);
  const again = settlePendingAfter(st, 1000, 0.30);
  eq('重复校准直接忽略', again.consumed, false);
  eq('重复校准不改写读数', st.tokensAfter, 36428);
  eq('重复校准不追加收益记录', st.roiHistory.length, 1);
}
{
  const st = { tokensAfter: null, pendingAfter: { before: 100000 } };
  const r = settlePendingAfter(st, null, 0.30);
  eq('读不到水位时标记未测量', r.measured, false);
  eq('读不到水位时不填读数', st.tokensAfter, null);
  eq('读不到水位时不累计收益', st.roiHistory, undefined);
  eq('读不到水位也消费记录', st.pendingAfter, undefined);
}
{
  const st = { roiHistory: [0.5], lowRoiStreak: 0, pendingAfter: { before: 100000 } };
  const r = settlePendingAfter(st, 96000, 0.30);
  eq('低收益时累计连续次数', r.streak, 1);
  eq('低收益记录进入收益历史', st.roiHistory.length, 2);
}

const indexSrc = fs.readFileSync(new URL('./index.mjs', import.meta.url), 'utf8');
// 压缩主链的实现已抽到 lib/inline-engine.mjs：断言核对实现文件本身。
// 同时拼接 index.mjs 的装配段（引擎创建、步骤边界监听、助手入口赋值），接线同样在锁定范围内。
const inlineSrc = fs.readFileSync(new URL('./lib/inline-engine.mjs', import.meta.url), 'utf8');
// 压缩后读数校准的实现落在 lib/pressure.mjs：低收益连击的判据也随之搬到该文件。
const pressureSrc = fs.readFileSync(new URL('./lib/pressure.mjs', import.meta.url), 'utf8');
const wiringAt = indexSrc.indexOf('压缩主链：轮首注入压力行');
const wiringEnd = indexSrc.indexOf('用户全局前置提示词');
const autoBlock = inlineSrc + (wiringAt >= 0 && wiringEnd > wiringAt ? indexSrc.slice(wiringAt, wiringEnd) : '');
check('判定段已移除全局巡检', autoBlock.length > 0 && autoBlock.indexOf('agents.list()') === -1);
check('判定段已移除定时扫描', autoBlock.indexOf('setInterval') === -1 && autoBlock.indexOf('triggerScanMs') === -1);
check('判定绑定本会话步骤边界', autoBlock.indexOf("'agent/pre-step'") !== -1);
check('别的会话到线不影响本会话', autoBlock.indexOf('payload.agent') !== -1 && autoBlock.indexOf('scanAutoTrigger') === -1);
check('压缩调用只出现在 force 与助手入口', (autoBlock.match(/compactInTurn\(/g) || []).length === 2
  && autoBlock.indexOf("action.action !== 'force'") !== -1
  && autoBlock.indexOf('forceCompact(agent, sid, signal)') !== -1
  && autoBlock.indexOf('env.assistantCompact') !== -1);
check('提示分支先返回不压缩', autoBlock.indexOf("action.action === 'notifySoft' || action.action === 'notifyAdvise'") !== -1
  && autoBlock.indexOf('return out;') !== -1);
check('例行压缩不排轮后队列', autoBlock.indexOf('env.schedule(') === -1 && autoBlock.indexOf('triggeredBy') === -1);
check('计数两级：助手上限与硬上限', autoBlock.indexOf('maxCompactionsHardCap') !== -1
  && autoBlock.indexOf('successionBlockText(') !== -1
  && autoBlock.indexOf('successionCeilingText(') !== -1
  && autoBlock.indexOf("noteTriggerSkip(sid, 'compaction-limit'") !== -1);
check('硬线在两级之间仍强制压缩', autoBlock.indexOf('usedCompactions >= maxCompactions') !== -1
  && autoBlock.indexOf('forceCompact(agent, sid, signal)') !== -1);
check('助手入口传入换任计数', autoBlock.indexOf('compactionCount: Math.max(') !== -1
  && autoBlock.indexOf('maxCompactions: Number(cfg.maxCompactionsPerSession)') !== -1);
check('助手入口要求锚点可写', autoBlock.indexOf('anchorPath,') !== -1 && autoBlock.indexOf('anchorWritable,') !== -1);
check('例行压缩不生成回填文本', autoBlock.indexOf('buildBackfillText') === -1 && autoBlock.indexOf('composeResumeMessage') === -1);
check('轮首压力行每轮注入', autoBlock.indexOf('pressureLineText(profile)') !== -1 && autoBlock.indexOf('atTurnStart') !== -1);
const turnStartBlock = inlineSrc.slice(inlineSrc.indexOf('if (atTurnStart) {'), inlineSrc.indexOf('// 轮内步骤分隔'));
check('轮次起点只注水位不判定', turnStartBlock.length > 0
  && turnStartBlock.indexOf('judgeTrigger') === -1
  && turnStartBlock.indexOf('forceCompact') === -1);
const stepJudgeBlock = inlineSrc.slice(inlineSrc.indexOf('// 轮内步骤分隔'), inlineSrc.indexOf('async function onPreStep'));
check('轮内步骤才判定与强制压缩', stepJudgeBlock.indexOf('judgeTrigger(') !== -1
  && stepJudgeBlock.indexOf('forceCompact(agent, sid, signal)') !== -1);
check('注入不改 system 头', autoBlock.indexOf('systemPrompt.section') === -1 && autoBlock.indexOf("append('system/message'") === -1);
check('压缩前先写锚点', autoBlock.indexOf('writeAnchorFor(sid, agent.session') !== -1
  && autoBlock.indexOf('writeAnchorFor(sid, agent.session') < autoBlock.indexOf('compactInTurn('));
check('连续低收益追加换任建议', (autoBlock + pressureSrc).indexOf('lowRoiStreakOf') !== -1
  && autoBlock.indexOf("kind: 'succession-advice'") !== -1);
check('换任留痕记录 rotate', indexSrc.indexOf("kind === 'rotate'") !== -1 && indexSrc.indexOf('flow.rotatedAt') !== -1);
check('换任硬闸改用 rotate 判据', indexSrc.indexOf('judgeRotateGate(') !== -1 && indexSrc.indexOf('四步顺序') === -1);

/* ---------------- 轮内压缩：范围选择与引擎调用 ---------------- */

function fakeSession(types) {
  const nodes = types.map((_, i) => i + 1);
  const events = new Map();
  nodes.forEach((seq, i) => {
    const type = types[i];
    const content = type === 'assistant/message' ? [{ type: 'tool-call' }] : [];
    events.set(seq, { seq, type, data: { message: { content } } });
  });
  return { surface: { nodes }, eventAt: (seq) => events.get(seq) };
}
function priced(session, tokens) {
  return { totalTokens: tokens.reduce((a, b) => a + b, 0), nodes: session.surface.nodes.map((seq, i) => ({ seq, tokens: tokens[i] })) };
}

const S1 = fakeSession(['system/message', 'user/message', 'assistant/message', 'tool/result', 'user/message', 'assistant/message']);
const M1 = priced(S1, [1000, 100, 100, 100, 100, 100]);
const PLAN = { shadowTarget: 0.55, keepMinMessages: 5, minKeepTokens: 1000 };
eq('保留区覆盖全表面时不压缩', selectCompactionRange(S1, M1, PLAN), null);

function bigSession(count, tokensEach, isUser) {
  const types = [];
  for (let i = 0; i < count; i += 1) types.push(i === 0 ? 'system/message' : (isUser(i) ? 'user/message' : 'turn/end'));
  const session = fakeSession(types);
  return { session, measurement: priced(session, types.map(() => tokensEach)) };
}

const bigRange = bigSession(100, 1000, (i) => i % 5 === 0);
const rBig = selectCompactionRange(bigRange.session, bigRange.measurement, PLAN);
eq('200K 窗 used 100K 保留约 45K', rBig.keptTokens, 45000);
eq('切点落在用户消息边界', bigRange.session.eventAt(rBig.end + 1).type, 'user/message');
eq('压缩范围跳过系统头', rBig.start, 2);
// 54000 为节点遮蔽量；胶囊展示的 55000 是压缩前减压缩后（含系统头 1000），两者不冲突。
eq('遮蔽量按实际节点计', rBig.shadowTokens, 54000);

// 全量压缩：1 个系统头 + 99 个节点，末节点为当前步的助手消息。
const fullTypes = ['system/message'];
for (let i = 1; i < 99; i += 1) fullTypes.push(i % 5 === 0 ? 'user/message' : 'turn/end');
fullTypes.push('assistant/message');
const fullSession = fakeSession(fullTypes);
const fullM = priced(fullSession, fullTypes.map(() => 1000));
const rFull = selectFullRange(fullSession, fullM);
eq('全量范围起点为系统头之后第一个节点', rFull.start, 2);
eq('全量范围终点为当前步之前一个节点', rFull.end, 99);
eq('全量范围保留当前步', rFull.keptTokens, 1000);
eq('全量范围遮蔽除系统头与当前步外全部', rFull.shadowTokens, 98000);

const tinyFull = fakeSession(['system/message', 'user/message', 'assistant/message']);
eq('表面过短时全量范围返回 null', selectFullRange(tinyFull, priced(tinyFull, [1000, 1000, 1000])), null);

const tailNotAssistant = fakeSession(['system/message', 'user/message', 'tool/result']);
eq('末节点不是助手消息时全量范围返回 null', selectFullRange(tailNotAssistant, priced(tailNotAssistant, [1000, 1000, 1000])), null);

const noToolCall = {
  surface: { nodes: [1, 2, 3] },
  eventAt: (seq) => (seq === 1 ? { seq, type: 'system/message' }
    : seq === 2 ? { seq, type: 'user/message' }
      : { seq, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '回复' }] } } }),
};
eq('末节点无 tool-call 时全量范围返回 null',
  selectFullRange(noToolCall, { totalTokens: 3000, nodes: [1, 2, 3].map((seq) => ({ seq, tokens: 1000 })) }), null);

const rFallback = selectCompactionRange(bigRange.session, bigRange.measurement, Object.assign({}, PLAN, { full: true }));
eq('全量不成立时回退尾部策略', rFallback && rFallback.start + '-' + rFallback.end, '2-55');

const fullCalls = [];
const fullAgent = {
  session: fullSession,
  ctx: {
    tokenMeter: { measure: () => fullM },
    compaction: { compactRegion: async (start, end) => { fullCalls.push({ start, end }); return { shadowedTokenCount: 98000 }; } },
  },
};
const fullOut = await compactInTurn({}, fullAgent, {}, undefined, { full: true, shadowTarget: 0.55, keepMinMessages: 20, minKeepTokens: 8000 });
eq('轮内全量压缩区间', fullCalls[0].start + '-' + fullCalls[0].end, '2-99');
eq('轮内全量压缩返回成功', fullOut.status, 'ok');

const pairTypes = ['system/message', 'turn/end', 'turn/end', 'turn/end', 'turn/end', 'turn/end', 'turn/end', 'turn/end', 'turn/end', 'assistant/message', 'tool/result', 'user/message', 'turn/end', 'turn/end', 'turn/end', 'turn/end', 'turn/end', 'turn/end', 'turn/end', 'turn/end'];
const S3 = fakeSession(pairTypes);
const M3 = priced(S3, pairTypes.map(() => 1000));
const r3 = selectCompactionRange(S3, M3, { shadowTarget: 0.525, keepMinMessages: 1, minKeepTokens: 1 });
eq('工具对不切断：切到用户消息起点', S3.eventAt(r3.end + 1).type, 'user/message');
eq('工具对整体落在压缩区内', S3.eventAt(r3.end).type, 'tool/result');

let compactNowCalls = 0;
const calls = [];
const agent = {
  session: bigRange.session,
  ctx: {
    tokenMeter: { measure: () => bigRange.measurement },
    compaction: {
      compactRegion: async (start, end) => { calls.push({ start, end }); return { shadowedTokenCount: 7 }; },
      compactNow: async () => { compactNowCalls += 1; },
    },
  },
};
const out = await compactInTurn({}, agent, { compactTimeoutMs: 1000 }, undefined, PLAN);
eq('轮内压缩走 compactRegion', calls.length, 1);
eq('轮内压缩范围正确', calls[0].start + '-' + calls[0].end, '2-55');
eq('轮内压缩不调用 compactNow', compactNowCalls, 0);
eq('轮内压缩返回成功', out.status, 'ok');
eq('压缩前 token 取测量总量', out.tokensBefore, 100000);
// D-171：压缩返回瞬间不测量，压缩后读数恒为空，由主链在下一个步骤边界校准。
eq('压缩后读数不在引擎内测量', out.tokensAfter, null);
const smallAgent = { session: S1, ctx: { tokenMeter: { measure: () => M1 }, compaction: agent.ctx.compaction } };
eq('无可压缩范围时跳过', (await compactInTurn({}, smallAgent, {}, undefined, PLAN)).status, 'no-range');

let missingCode = '';
try {
  await compactInTurn({}, {
    session: S1,
    ctx: { tokenMeter: { measure: () => M1 }, compaction: { compactNow: async () => {} } },
  }, {}, undefined, PLAN);
} catch (e) { missingCode = e.code; }
eq('缺 compactRegion 时带证据停止', missingCode, INLINE_UNAVAILABLE);

/* ---------------- 压缩主链：快照失败不阻断压缩 ---------------- */

{
  // 快照缺少会话 id 时 writeSnapshot 必抛；强制压缩仍须照常执行并返回结果。
  let snapFailCompacts = 0;
  const snapFailAgent = {
    session: bigRange.session,
    ctx: {
      tokenMeter: { measure: () => bigRange.measurement },
      compaction: { compactRegion: async () => { snapFailCompacts += 1; return { shadowedTokenCount: 100 }; } },
    },
  };
  const snapFailEngine = createInlineEngine({
    ctx: {},
    cfg: resolveConfig({ workspaceRoot: os.tmpdir() }),
    env: { log: () => {}, controller: () => null },
    inline: { inflight: new Set(), lastAt: new Map(), disabled: false },
    scheduler: null,
    roleCache: new Map(),
    readState: () => ({ compactions: 0 }),
    saveState: () => {},
    infoFor: () => ({ role: 'project', project: 'Demo' }),
    scopedMetaOf: () => ({}),
    isChildSession: () => false,
    anchorOps: {
      autoSnapshotFor: () => ({ sid: '' }),
      writeAnchorFor: () => ({ sections: [], path: '' }),
      surfaceTextsOf: () => [],
    },
  });
  const snapFailResult = await snapFailEngine.forceCompact(snapFailAgent, 'session-snapfail', undefined);
  eq('快照写失败仍执行强制压缩', snapFailCompacts, 1);
  eq('快照写失败仍按成功回告', snapFailResult && snapFailResult.status, 'ok');
}

/* ---------------- 压缩后读数：记账只写待校准 ---------------- */

{
  // 压缩返回时读数不可信：不得写入压缩后读数、不得累计收益；胶囊与回执写「待下一轮校准」。
  let store = { compactions: 0, pendingMessages: [], roiHistory: [] };
  const pendingEngine = createInlineEngine({
    ctx: {},
    cfg: resolveConfig({ workspaceRoot: os.tmpdir() }),
    env: { log: () => {}, controller: () => null },
    inline: { inflight: new Set(), lastAt: new Map(), disabled: false },
    scheduler: null,
    roleCache: new Map(),
    readState: () => store,
    saveState: (sid, next) => { store = next; },
    infoFor: () => ({ role: 'project', project: 'Demo' }),
    scopedMetaOf: () => ({}),
    isChildSession: () => false,
    anchorOps: {
      autoSnapshotFor: () => null,
      writeAnchorFor: () => ({ sections: [], path: '' }),
      surfaceTextsOf: () => [],
    },
  });
  const pendingResult = pendingEngine.afterCompact('session-d171', 'assistant', {
    status: 'ok',
    tokensBefore: 318789,
    tokensAfter: null,
    result: { shadowedTokenCount: 208891 },
    range: { start: 1990, end: 2311 },
  }, { source: 'assistant', capsuleBody: '目标：补齐部署脚本' });
  check('压缩返回不写失真读数', store.tokensAfter === null && store.roi === null, JSON.stringify(store));
  check('压缩返回不累计收益历史', store.roiHistory.length === 0, JSON.stringify(store.roiHistory));
  check('压缩返回记录待校准', store.pendingAfter && store.pendingAfter.before === 318789
    && store.pendingAfter.shadowed === 208891 && store.pendingAfter.range === '1990-2311', JSON.stringify(store.pendingAfter));
  const capsuleNow = pendingResult.st.pendingMessages[0].text;
  check('胶囊回执写待下一轮校准', capsuleNow.indexOf('压缩后 待下一轮校准') !== -1, capsuleNow);
  check('胶囊回执不填缩减比例', capsuleNow.indexOf('缩减 未核') !== -1, capsuleNow);
}

const engineSrc = fs.readFileSync(new URL('./lib/engine.mjs', import.meta.url), 'utf8');
check('轮内实现调用 compactRegion', engineSrc.indexOf('compactRegion(') !== -1);
check('轮内实现不调用 compactNow', engineSrc.indexOf('compactNow(') === -1);

/* ---------------- 配置与口径 ---------------- */

const dflt = resolveConfig({});
eq('旧配置项 triggerRatio 已移除', dflt.triggerRatio, undefined);
eq('旧配置项 bufferRatio 已移除', dflt.bufferRatio, undefined);
eq('旧配置项 hardRatio 已移除', dflt.hardRatio, undefined);
eq('旧配置项 reuseRatio 已移除', dflt.reuseRatio, undefined);
eq('默认助手压缩上限 4 次', dflt.maxCompactionsPerSession, 4);
eq('默认压缩硬上限 6 次', dflt.maxCompactionsHardCap, 6);
eq('默认遮蔽比 0.55', dflt.shadowTarget, 0.55);
eq('默认保留消息数 20', dflt.keepMinMessages, 20);
eq('默认保留 token 下限 8000', dflt.minKeepTokens, 8000);
eq('默认收益下限 0.30', dflt.roiFloor, 0.30);
eq('默认锚点上限 1500', dflt.anchorMaxTokens, 1500);
eq('默认胶囊上限 4600', dflt.capsuleMaxChars, 4600);
eq('默认助手线全量压缩', dflt.fullCompact, true);
eq('默认约束上限 8', dflt.constraintMax, 8);
eq('边界压缩配置已移除', dflt.boundaryCompact, undefined);
eq('宿主兜底线保持 0.8', dflt.hostSummaryRatio, 0.8);
eq('宿主线随窗口配置', bandsFor({ hostSummaryRatio: 0.7 }, 100000).host, 70000);

const D = (o) => decidePhase(Object.assign({ win: 200000, bands: PB, lockState: 'clean' }, o));
eq('未闭合锁优先', D({ used: 190000, lockState: 'open' }).action, 'blocked');
eq('强制线强制', D({ used: 121550 }).action, 'force');
eq('建议线只提示', D({ used: 93500 }).action, 'notify');
eq('整理线只提示', D({ used: 65450 }).action, 'notify');
eq('微快照事件给快照建议', D({ used: 1000, snapshot: { needed: true, reasons: ['x'] } }).action, 'snapshot');
eq('平静时继续', D({ used: 1000 }).action, 'continue');
eq('水位未知', D({ used: null }).action, 'unknown');

/* ---------------- 注入文本 ---------------- */

eq('整理线提示文案', tierPromptText('soft', prof), '上下文 92K/200K（46%）。3 档 70K/100K/130K。已过整理线，可择机压缩。先把任务收到安全断点。按胶囊标准写：目标、已定方案、下一步、易错点、必须遵守的约束原文、需要保留的原文位置。再调用 ho_handover(action="compact", capsule=…)。可压：边界已到；缓压：推导未落盘或有错在追。');
check('建议线提示写尽快', /尽快/.test(tierPromptText('advise', prof)), tierPromptText('advise', prof));
eq('强制线文案含实际用量', hardPromptText(prof), '上下文 92K/200K（46%），已到强制线 130K。插件立即执行压缩。');
check('rubric 不超过 220 字', rubricText().length <= 220, String(rubricText().length));
check('rubric 含 fire 四条', /子任务闭环/.test(rubricText()) && /即将切换阶段/.test(rubricText())
  && /噪声不少于 30%/.test(rubricText()) && /余量低于预计下一阶段增量/.test(rubricText()));
check('rubric 含 suppress 四条', /多步推导未落盘/.test(rubricText()) && /未解决的错误/.test(rubricText())
  && /上一条工具结果尚未消费/.test(rubricText()) && /距上次压缩不足 3 轮/.test(rubricText()));
check('换任提示给 rotate 与授权入口', /action="rotate"/.test(successionPromptText(4, 4, dflt))
  && /allow-reset/.test(successionPromptText(4, 4, dflt)) && /succeed/.test(successionPromptText(4, 4, dflt)));
check('换任提示说明硬线兜底至 6 次', /6 次/.test(successionPromptText(4, 4, dflt)), successionPromptText(4, 4, dflt));
check('硬上限文案不再压缩', /不再压缩/.test(successionCeilingText(6, 6)) && /6\/6/.test(successionCeilingText(6, 6)), successionCeilingText(6, 6));

/* ---------------- 助手压缩前置校验（含换任计数） ---------------- */

const G = (o) => judgeAssistantCompact(Object.assign({
  sid: 'session-g', role: 'project', anchorPath: 'E:/x/anchor.md', anchorWritable: true,
  lockState: 'clean', inflight: false,
  pendingCompaction: false, pendingToolCalls: 1, compactionCount: 0, maxCompactions: 4,
}, o || {}));
eq('全部条件齐备可压缩', G().ok, true);
eq('计数未达上限可压缩', G({ compactionCount: 3 }).ok, true);
eq('计数达上限拒绝压缩', G({ compactionCount: 4 }).ok, false);
eq('计数超上限拒绝压缩', G({ compactionCount: 6 }).ok, false);
check('计数达上限给换任处置', /不再压缩/.test(G({ compactionCount: 4 }).reason)
  && /action="rotate"/.test(G({ compactionCount: 4 }).reason) && /allow-reset/.test(G({ compactionCount: 4 }).reason),
G({ compactionCount: 4 }).reason);
eq('计数未知不拦', G({ compactionCount: undefined }).ok, true);
eq('未注入提示不再是条件', G({ lastTierPromptAt: 0 }).ok, true);
eq('交接更新时间不再是条件', G({ handoverMtimeMs: 0, handoverPath: '' }).ok, true);
eq('无锚点路径拒绝', G({ anchorPath: '' }).ok, false);
eq('锚点不可写拒绝', G({ anchorWritable: false }).ok, false);
check('锚点不可写给处置', /锚点不可写/.test(G({ anchorWritable: false }).reason)
  && /重试/.test(G({ anchorWritable: false }).reason), G({ anchorWritable: false }).reason);
eq('锁未闭合拒绝', G({ lockState: 'open' }).ok, false);
eq('进行中压缩拒绝', G({ inflight: true }).ok, false);
eq('助手闸门不校验未闭合工具调用', G({ pendingToolCalls: 2 }).ok, true);
eq('普通会话拒绝', G({ role: 'plain' }).ok, false);
check('闸门不再含旧两项', G().checks.every((c) => c.name !== '提示注入' && c.name !== '交接更新时间'), JSON.stringify(G().checks));
check('闸门含锚点与计数', G().checks.some((c) => c.name === '锚点可写') && G().checks.some((c) => c.name === '压缩计数'));

/* ---------------- 约束抽取与探针 ---------------- */

const extracted = extractConstraints([
  { text: '不要修改配置文件。必须跑完自测；别删日志', seq: 3 },
  { text: '用户说「不要动 A 文件」后继续', seq: 5 },
  { text: '不要修改配置文件', seq: 7 },
  { text: '略', seq: 8 },
], { max: 8 });
eq('约束抽取保留最早顺序与去重', extracted.map((c) => c.text), ['不要修改配置文件', '必须跑完自测', '别删日志', '用户说「不要动 A 文件」后继续']);
eq('约束带来源序号', extracted[0].seq, 3);
const manyConstraints = Array.from({ length: 10 }, (_, i) => '必须完成第' + (i + 1) + '项验收').join('。');
eq('约束上限 8 条', extractConstraints([{ text: manyConstraints, seq: 1 }], { max: 8 }).length, 8);
eq('4 字约束保留', extractConstraints([{ text: '必须先做', seq: 1 }]).length, 1);
eq('3 字约束丢弃', extractConstraints([{ text: '必须做', seq: 1 }]).length, 0);
eq('120 字约束保留', extractConstraints([{ text: '不要' + '好'.repeat(118), seq: 1 }]).length, 1);
eq('121 字约束丢弃', extractConstraints([{ text: '不要' + '好'.repeat(119), seq: 1 }]).length, 0);

const cons = [{ text: '不要修改配置文件' }, { text: '必须跑完自测' }];
const probe = probeConstraints(['这里提到 不要修改配置文件，但没有提自测'], cons);
eq('探针命中 1 条', probe.kept, 1);
eq('探针缺失项按原文返回', probe.missing, ['必须跑完自测']);
const probeEmpty = probeConstraints([], cons);
eq('空文本时命中为 0', probeEmpty.kept, 0);
eq('空文本时全部缺失', probeEmpty.missing.length, 2);

/* ---------------- 压缩后胶囊 ---------------- */

const capsuleAnchor = {
  goal: '补齐部署脚本',
  status: '进行中',
  constraints: ['不要修改配置文件', '必须跑完自测'],
  facts: ['部署目录为 D:/ws/deploy'],
  decisions: ['采用 A 方案'],
  pending: ['补回滚分支', '同步文档'],
  files: ['D:/ws/deploy/run.ps1'],
  pointers: ['E:/x/PLAN.md'],
};
const capsule = renderCapsule({
  anchor: capsuleAnchor,
  anchorPath: 'E:/sessions/s1/dsh-handover/anchor.md',
  before: 100000,
  after: 45000,
  shadow: 55000,
  count: 2,
  max: 4,
  missing: ['必须跑完自测'],
});
check('胶囊不超过 4600 字', capsule.length <= 4600, String(capsule.length));
for (const head of ['[压缩完成·机制兜底]', '目标：', '约束（逐条原文）：', '近期关键字摘录：']) {
  check('机制胶囊含段 ' + head, capsule.indexOf(head) !== -1);
}
check('胶囊含前后 token 与次序', /压缩前 100K，压缩后 45K/.test(capsule) && /第 2\/4 次/.test(capsule), capsule);
// D-171：压缩后读数未知时不填数，写明待下一轮校准。
const pendingCapsule = renderCapsule({
  anchor: capsuleAnchor,
  anchorPath: 'E:/a.md',
  before: 318789,
  after: null,
  shadow: 208891,
  count: 1,
  max: 4,
});
check('压缩后未知写待下一轮校准', pendingCapsule.indexOf('压缩后 待下一轮校准') !== -1, pendingCapsule);
check('压缩后未知不填缩减比例', pendingCapsule.indexOf('缩减 未核') !== -1, pendingCapsule);
check('机制胶囊不含锚点路径', capsule.indexOf('E:/sessions/s1/dsh-handover/anchor.md') === -1);
check('无摘录写（无）', capsule.indexOf('近期关键字摘录：（无）') !== -1, capsule);
check('缺失约束加原文标注', /必须跑完自测（以本行原文为准）/.test(capsule), capsule);
check('未缺失约束不加标注', !/不要修改配置文件（以本行原文为准）/.test(capsule));
check('默认渲染机制兜底', renderCapsule({ anchor: capsuleAnchor, anchorPath: 'E:/a.md' }).indexOf('[压缩完成·机制兜底]') === 0);

const assistantBody = '目标：补齐部署脚本\n已定方案：沿用 A 方案\n下一步：补回滚分支\n易错点：不得改动配置\n约束：不要修改配置文件\n原文位置：E:/x/PLAN.md';
const assistantCapsule = renderCapsule({
  source: 'assistant',
  body: assistantBody,
  anchorPath: 'E:/sessions/s1/dsh-handover/anchor.md',
  before: 100000,
  after: 45000,
  shadow: 55000,
  count: 2,
  max: 4,
});
check('助手胶囊抬头', assistantCapsule.indexOf('[压缩完成·助手胶囊]') === 0, assistantCapsule);
check('助手胶囊保留正文原样', assistantCapsule.indexOf(assistantBody) !== -1, assistantCapsule);
check('助手胶囊含压缩信息', /压缩前 100K，压缩后 45K/.test(assistantCapsule) && /第 2\/4 次/.test(assistantCapsule));
check('助手胶囊含召回提示', assistantCapsule.indexOf('ho_status(view="recall", query="…")') !== -1, assistantCapsule);
check('助手胶囊不含机制约束段', assistantCapsule.indexOf('约束（逐条原文）：') === -1, assistantCapsule);
check('助手胶囊不做探针标记', assistantCapsule.indexOf('（以本行原文为准）') === -1);
check('标签可覆盖来源', renderCapsule({ label: '[压缩完成·助手胶囊]', body: '目标：测试' }).indexOf('[压缩完成·助手胶囊]') === 0);
const longExcerpt = '错误'.repeat(1200);
const longCapsule = renderCapsule({
  anchor: { goal: '目标', constraints: ['不要修改配置文件'] },
  excerpts: [longExcerpt, longExcerpt],
  anchorPath: 'E:/sessions/s1/dsh-handover/anchor.md',
  before: 100000,
  after: 45000,
  count: 1,
  max: 4,
});
check('超长胶囊不裁剪', longCapsule.split(longExcerpt).length - 1 === 2 && longCapsule.length > CAPSULE_RENDER_MAX_CHARS, String(longCapsule.length));
check('胶囊保留约束', longCapsule.indexOf('不要修改配置文件') !== -1);

const kwEvents = [];
function kw(seq, turn, text, source) {
  kwEvents.push({ seq, type: 'user/message', data: { turn, content: [{ type: 'text', text }], source: source || { kind: 'user' } } });
}
kw(1, 1, '第一轮：普通叙述');
kw(2, 2, '待办：补回滚分支');
kw(3, 3, '普通叙述第二轮');
kw(4, 4, '路径 D:/ws/deploy/run.ps1');
kw(5, 5, '未完成：同步文档');
kw(6, 6, '错误：权限不足');
kw(7, 7, '异常：解压失败');
kw(8, 8, '下一步：复跑自检');
eq('关键词句按最近 6 轮抽取', extractKeywordSentences(kwEvents, { turns: 6 }),
  ['路径 D:/ws/deploy/run.ps1', '未完成：同步文档', '错误：权限不足', '异常：解压失败', '下一步：复跑自检']);
eq('抽不到关键词返回空', extractKeywordSentences([{ type: 'user/message', data: { turn: 1, content: [{ type: 'text', text: '普通叙述' }] } }]), []);
eq('插件注入消息跳过', extractKeywordSentences([{ type: 'user/message', data: { turn: 1, content: [{ type: 'text', text: '下一步：注入' }], source: { kind: 'dsh-handover' } } }]), []);

/* ---------------- 合成事件 ---------------- */

function ev(seq, type, data, time) {
  return { seq, type, time: time || 1794700000000 + seq * 1000, data };
}
function user(seq, text, time) {
  return ev(seq, 'user/message', { content: [{ type: 'text', text }], source: { kind: 'user' } }, time);
}
function say(seq, text, time) {
  return ev(seq, 'assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } }, time);
}
function toolCall(seq, id, name, args) {
  return ev(seq, 'assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'tool-call', id, name, arguments: JSON.stringify(args || {}) }] } });
}
function toolResult(seq, callId, text, isError) {
  return ev(seq, 'tool/result', { turn: 1, step: 1, message: { role: 'tool', toolCallId: callId, content: [{ type: 'text', text }], isError: isError === true } });
}
function summary(seq, text, id) {
  return ev(seq, 'compaction/summary', { compactionId: id || ('c' + seq), summary: [{ type: 'text', text }] });
}

const RECORDS = [
  user(1, '目标：把部署脚本补齐。'),
  user(2, '已确认：部署目录为 D:/ws/deploy。'),
  say(3, '先读脚本。'),
  toolCall(4, 'call-1', 'read', { file_path: 'D:/ws/deploy/run.ps1' }),
  toolResult(5, 'call-1', '脚本内容', false),
  user(6, '下一步：补充回滚分支。'),
  toolCall(7, 'call-2', 'write', { file_path: 'D:/ws/deploy/run.ps1' }),
  toolResult(8, 'call-2', '写入失败：权限不足', true),
  toolResult(9, 'call-2', '写入失败：权限不足', true),
  summary(10, '## Primary Request and Intent\n- 补齐部署脚本与回滚分支。', 'c10'),
  user(20, '继续补回滚。'),
  summary(30, '## Current Work\n- 回滚分支已完成。', 'c30'),
];

/* ---------------- 段索引 ---------------- */

const segs = deriveSegments(RECORDS);
eq('段数为 2', segs.length, 2);
eq('第一段遮蔽事件数大于 0', segs[0].shadowedEvents > 0, true);
eq('第二段 token 大于 0', segs[1].tokens > 0, true);
eq('段标签非空', !!(segs[0].label && segs[1].label), true);
eq('段查询命中第一段', segmentForSeq(segs, 5).index, 1);
eq('段查询命中第二段', segmentForSeq(segs, 25).index, 2);
eq('段外返回 null', segmentForSeq(segs, 99), null);
eq('重复推导一致', JSON.stringify(deriveSegments(RECORDS)), JSON.stringify(segs));
eq('段汇总计数', segmentStats(segs).count, 2);
eq('两段不判增量比', gainRatio([{ shadowedEvents: 100 }, { shadowedEvents: 50 }]), null);
eq('三段增量比为本次除上次', Math.round(gainRatio([{ shadowedEvents: 100 }, { shadowedEvents: 200 }, { shadowedEvents: 50 }]) * 1000) / 1000, 0.25);
eq('上次遮蔽为零不判增量比', gainRatio([{ shadowedEvents: 100 }, { shadowedEvents: 0 }, { shadowedEvents: 5 }]), null);

/* ---------------- 正则防护 ---------------- */

eq('超长模式被拒', regexIssue('a'.repeat(201)).indexOf('超过 200') !== -1, true);
eq('嵌套量词被拒', regexIssue('(a+)+b').length > 0, true);
eq('合法模式可用', regexIssue('Handover'), '');

/* ---------------- 微快照 ---------------- */

const snap = extractSnapshot(RECORDS, { sid: 'session-selftest', ratio: 0.42 });
check('快照目标取最近一条用户消息', /部署脚本|回滚/.test(snap.goal), snap.goal);
check('快照已确认事实含确认行', snap.facts.some((f) => /已确认/.test(f)), JSON.stringify(snap.facts));
check('快照未决含失败工具', snap.pending.some((p) => /权限不足/.test(p)), JSON.stringify(snap.pending));
check('快照下一步取用户指令', /回滚分支/.test(snap.next), snap.next);
check('快照指针含文件路径', snap.pointers.some((p) => /run\.ps1/.test(p)), JSON.stringify(snap.pointers));
check('快照时刻带时区', /[+-]\d{4}$/.test(snap.moment), snap.moment);
const rendered = renderSnapshot(snap);
for (const h of ['## 1 目标', '## 2 已确认事实', '## 3 未决', '## 4 下一步', '## 5 指针', '## 6 时刻']) {
  check('快照渲染含 ' + h, rendered.indexOf(h) !== -1);
}
eq('快照可重复', JSON.stringify(extractSnapshot(RECORDS, { sid: 'session-selftest', ratio: 0.42 })), JSON.stringify(snap));
const blank = extractSnapshot([], { sid: 'session-empty' });
eq('空日志目标占位', blank.goal, '未核，待确认');
const withEnvelope = RECORDS.concat([{
  type: 'user/message', seq: 900, time: Date.now(),
  data: { content: [{ type: 'text', text: '【peer-link session-x】回一个字：在。' }] },
}]);
const snapEnv = extractSnapshot(withEnvelope, { sid: 'session-env' });
check('快照跳过包装消息', snapEnv.goal.indexOf('peer-link') === -1, snapEnv.goal);
const scoped = extractSnapshot(RECORDS, { sid: 'session-scope', sinceSeq: 999 });
eq('段后无事件时目标占位', scoped.goal, '未核，待确认');
eq('空日志下一步占位', blank.next, '未核，待确认');
eq('空日志指针占位', blank.pointers, ['未核，待确认']);
eq('空日志时刻占位', blank.moment, '未核，待确认');

const sem = await maybeSemanticSnapshot(null, snap, { bypassModel: false });
eq('默认配置旁路零调用', sem.used, false);
eq('默认配置调用计数为零', bypassCount(), 0);
{
  const fakeLlm = { chat: async () => ({ text: '旁路摘要' }) };
  resetBypassCount();
  const on = await maybeSemanticSnapshot({ llm: fakeLlm }, snap, { bypassModel: true, bypassModelMaxChars: 200 }, 'milestone');
  eq('开启后里程碑触发一次', on.used, true);
  eq('旁路摘要限 200 字', on.text, '旁路摘要');
  eq('旁路调用计数为一', bypassCount(), 1);
  const skip = await maybeSemanticSnapshot({ llm: fakeLlm }, snap, { bypassModel: true }, '');
  eq('触发类别不在三类内则跳过', skip.used, false);
  eq('跳过不增加调用计数', bypassCount(), 1);
  const fail = await maybeSemanticSnapshot({ llm: { chat: async () => { throw new Error('boom'); } } }, snap, { bypassModel: true }, 'repeat');
  eq('旁路失败已调用但回退', fail.used, true);
  eq('旁路失败文本为空', fail.text, '');
  const noLlm = await maybeSemanticSnapshot(null, snap, { bypassModel: true }, 'milestone');
  eq('llm 不可用不调用', noLlm.used, false);
  resetBypassCount();
}

/* ---------------- 检索 ---------------- */

const lit = search(RECORDS, { query: '权限不足', mode: 'literal' });
check('字面召回命中失败结果', lit.hits.some((h) => h.seq === 8 && h.isError), JSON.stringify(lit.hits.map((h) => h.seq)));
eq('字面召回带段归属', lit.hits[0].segment.index, 1);
check('命中带前后三行', lit.hits[0].excerpt.lines.length >= 1, String(lit.hits[0].excerpt.lines.length));
const bm = search(RECORDS, { query: '回滚分支', mode: 'bm25' });
check('分词召回命中摘要', bm.hits.length > 0, String(bm.hits.length));
const st = search(RECORDS, { query: '', mode: 'structural', filter: 'type:tool/result, error:true' });
eq('结构过滤只留失败结果', st.hits.length === 1 && st.hits[0].seqs.sort((a, b) => a - b), [8, 9]);
const empty = search(RECORDS, { query: '完全不存在的词组xyz', mode: 'literal' });
eq('空结果没有命中', empty.total, 0);
check('空结果给候选段', !empty.suggestion || empty.suggestion.segments.length >= 0);
check('空结果给建议关键词', empty.suggestion && Array.isArray(empty.suggestion.keywords), JSON.stringify(empty.suggestion));
const bad = search(RECORDS, { query: '(a+)+$', mode: 'regex' });
eq('回溯模式被拒后空结果', bad.total, 0);
const aroundMid = aroundEvents(RECORDS, 5, 3);
eq('around 命中中心事件', aroundMid.found, true);
eq('around 中部前后各三条', aroundMid.events.length, 7);
eq('around 中心标记唯一', aroundMid.events.filter((e) => e.center).length, 1);
const aroundHead = aroundEvents(RECORDS, 1, 3);
eq('around 头部按边界截断', aroundHead.events.length, 4);
eq('around 头部中心为首条', aroundHead.events[0].center, true);
const aroundMissing = aroundEvents(RECORDS, 999, 3);
eq('around 序号不存在不返回事件', [aroundMissing.found, aroundMissing.events.length], [false, 0]);

/* ---------------- 检索：全量计数、合并、顺序与查询语法 ---------------- */

const mergedLit = search(RECORDS, { query: '权限不足', mode: 'literal' });
eq('重复命中合并为一组', mergedLit.groups.length, 1);
eq('合并组出现次数', mergedLit.groups[0].count, 2);
eq('合并组序号升序', mergedLit.groups[0].seqs, [8, 9]);
eq('合并组代表取最早', mergedLit.groups[0].seq, 8);
eq('全量命中数为唯一事件数', mergedLit.matched, 2);
eq('返回组数小于命中数', mergedLit.returned, 1);
eq('total 与 matched 同值', mergedLit.total, mergedLit.matched);
eq('分路全量计数', mergedLit.perRoute.literal, 2);

const timeOrder = search(RECORDS, { query: '回滚', mode: 'literal' });
const timeSeqs = timeOrder.hits.map((h) => h.firstSeq);
eq('默认按时间顺序', timeSeqs, timeSeqs.slice().sort((a, b) => a - b));
eq('默认顺序字段', timeOrder.order, 'time');

const ORDER_RECORDS = [
  user(1, '回滚分支 补丁'),
  user(2, '回滚分支与补丁'),
  user(3, '回滚分支 补丁 追加'),
];
const relOrder = search(ORDER_RECORDS, { query: '回滚分支 补丁', mode: 'literal', order: 'relevance' });
eq('相关度顺序按分数降序', relOrder.hits.map((h) => h.seq), [1, 3, 2]);
eq('相关度顺序字段', relOrder.order, 'relevance');
const timeOrder2 = search(ORDER_RECORDS, { query: '回滚分支 补丁', mode: 'literal' });
eq('时间顺序按首次出现', timeOrder2.hits.map((h) => h.seq), [1, 2, 3]);

const cutRes = search(RECORDS, { query: '回滚', mode: 'literal', limit: 1 });
check('截断时全量命中大于返回组数', cutRes.matched > cutRes.returned && cutRes.returned === 1, JSON.stringify([cutRes.matched, cutRes.returned]));

const orHits = search(RECORDS, { query: '权限不足|回滚分支', mode: 'literal' });
const orSeqs = orHits.groups.reduce((a, g) => a.concat(g.seqs), []);
check('竖线表示或', orSeqs.indexOf(8) !== -1 && orSeqs.indexOf(6) !== -1, JSON.stringify(orSeqs));

const negHits = search(RECORDS, { query: '回滚 -部署', mode: 'literal' });
const negSeqs = negHits.groups.reduce((a, g) => a.concat(g.seqs), []);
check('减号排除含排除词的命中', negSeqs.length > 0 && negSeqs.indexOf(10) === -1, JSON.stringify(negSeqs));

const reqHits = search(RECORDS, { query: '回滚 +分支', mode: 'bm25' });
const reqSeqs = reqHits.groups.reduce((a, g) => a.concat(g.seqs), []);
check('加号必含', reqSeqs.length > 0 && reqSeqs.indexOf(20) === -1, JSON.stringify(reqSeqs));

const PHRASE_RECORDS = [
  user(1, '目标：回滚 分支完成'),
  user(2, '目标：回滚分支完成'),
];
const phraseHits = search(PHRASE_RECORDS, { query: '"回滚 分支"', mode: 'literal' });
eq('引号内按短语匹配', phraseHits.groups.map((g) => g.seq), [1]);
const brokenQuery = search(RECORDS, { query: '"未闭合', mode: 'literal' });
eq('语法解析失败不抛异常', brokenQuery.matched, 0);

check('空结果提示结构模式或去排除词', !!(empty.suggestion && /structural/.test(empty.suggestion.hint || '') && /排除词/.test(empty.suggestion.hint || '')), JSON.stringify(empty.suggestion));

/* ---------------- 回填合并 ---------------- */

const homeBak = { u: process.env.USERPROFILE, h: process.env.HOME };
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-handover-selftest-'));
process.env.USERPROFILE = tmpHome;
process.env.HOME = tmpHome;

/* ---------------- 单文件缓存：同长度同刻度改写 ---------------- */

const lazyDir = path.join(tmpHome, 'lazy');
fs.mkdirSync(lazyDir, { recursive: true });
const lazyFile = path.join(lazyDir, 's.json');
const lazyTick = new Date(1794700000000);
fs.writeFileSync(lazyFile, '{"v":"aa"}', 'utf8');
fs.utimesSync(lazyFile, lazyTick, lazyTick);
eq('单文件缓存首次读取', readJsonFileLazy(lazyDir, ['s']).data.v, 'aa');
fs.writeFileSync(lazyFile, '{"v":"bb"}', 'utf8');
fs.utimesSync(lazyFile, lazyTick, lazyTick);
eq('同长度同 mtime 改写读到新值', readJsonFileLazy(lazyDir, ['s']).data.v, 'bb');

/* ---------------- 会话内存储：位置、暂存、兼容与保留上限 ---------------- */

const sidStore = 'session-store-selftest';
const sessDir = path.join(tmpHome, '.dsh', 'sessions', 'slug', sidStore);
fs.mkdirSync(sessDir, { recursive: true });
fs.writeFileSync(path.join(sessDir, 'session.v4.jsonl.zstd'), '');
const sweep = writeSessionState(sidStore, { compactions: 2, notified: { 25: 1 } });
check('状态写入会话目录', sweep.path.indexOf(path.join(sidStore, 'dsh-handover', 'state.json')) !== -1, sweep.path);
eq('状态读回计数', readSessionState(sidStore).compactions, 2);
const sweepAgain = writeSessionState(sidStore, { compactions: 2, notified: { 25: 1 } });
eq('状态未变化不重复写盘', sweepAgain.written, false);
const snapPath = writeSnapshot({
  sid: sidStore, goal: '目标', facts: ['事实'], pending: ['未决'], next: '下一步',
  pointers: ['E:/x'], moment: '2026-11-17 10:00 +0800', atMs: 1794700000000,
}).path;
check('快照写入会话目录', snapPath.indexOf(path.join(sidStore, 'dsh-handover')) !== -1, snapPath);
check('旧位置不再写入', !fs.existsSync(path.join(tmpHome, '.dsh', 'storages', 'dsh-handover.snapshots', sidStore)));
check('存储清单落在会话目录', storeInfo(sidStore).dir === storeDirFor(sidStore) && storeInfo(sidStore).staged === false);
fs.rmSync(sessDir, { recursive: true, force: true });
check('删除会话目录后产物无残留', !fs.existsSync(path.join(sessDir, 'dsh-handover')));
check('删除后读回空状态', readSessionState(sidStore).compactions === 0);

// 暂存：会话目录未就绪时写入插件自有目录，就绪后迁入。
const sidStaged = 'session-staged-selftest';
const stagedDir = path.join(tmpHome, '.dsh', 'storages', 'dsh-handover.staging', sidStaged);
const stagedWrite = writeSessionState(sidStaged, { compactions: 1 });
eq('会话目录未就绪时标记暂存', stagedWrite.staged, true);
check('暂存目录内已有状态文件', fs.existsSync(path.join(stagedDir, 'state.json')), stagedWrite.path);
eq('存储清单标记暂存', storeInfo(sidStaged).staged, true);
const stagedSess = path.join(tmpHome, '.dsh', 'sessions', 'slug', sidStaged);
fs.mkdirSync(stagedSess, { recursive: true });
fs.writeFileSync(path.join(stagedSess, 'session.v4.jsonl.zstd'), '');
const promotedWrite = writeSessionState(sidStaged, { compactions: 2 });
eq('会话目录就绪后写入会话目录', promotedWrite.staged, false);
check('暂存状态已迁入会话目录', fs.existsSync(path.join(stagedSess, 'dsh-handover', 'state.json')));
check('暂存目录不再保留状态文件', !fs.existsSync(path.join(stagedDir, 'state.json')));
fs.rmSync(stagedDir, { recursive: true, force: true });
fs.rmSync(stagedSess, { recursive: true, force: true });

// 兼容：旧位置文件复制进会话目录，旧文件保留，每会话只处理一次。
const sidCompat = 'session-compat-selftest';
const compatLegacy = path.join(tmpHome, '.dsh', 'storages', 'dsh-handover.snapshots', sidCompat);
const compatSess = path.join(tmpHome, '.dsh', 'sessions', 'slug', sidCompat);
fs.mkdirSync(compatLegacy, { recursive: true });
fs.writeFileSync(path.join(compatLegacy, 'micro_x.md'), '旧快照');
fs.mkdirSync(compatSess, { recursive: true });
fs.writeFileSync(path.join(compatSess, 'session.v4.jsonl.zstd'), '');
const adopted = adoptLegacyStore(sidCompat);
eq('旧位置产物复制成功', adopted.adopted, ['micro_x.md']);
check('旧位置产物已在会话目录', fs.existsSync(path.join(compatSess, 'dsh-handover', 'micro_x.md')));
check('旧位置文件仍保留', fs.existsSync(path.join(compatLegacy, 'micro_x.md')));
eq('同会话不重复处理', adoptLegacyStore(sidCompat).adopted, []);
fs.rmSync(compatLegacy, { recursive: true, force: true });
fs.rmSync(compatSess, { recursive: true, force: true });

// 微快照保留上限：连续写 10 份只留最近 8 份。
const sidKeep = 'session-snap-keep-selftest';
const keepSess = path.join(tmpHome, '.dsh', 'sessions', 'slug', sidKeep);
fs.mkdirSync(keepSess, { recursive: true });
fs.writeFileSync(path.join(keepSess, 'session.v4.jsonl.zstd'), '');
for (let i = 0; i < 10; i++) {
  writeSnapshot({
    sid: sidKeep, goal: '目标', facts: ['事实'], pending: ['未决'], next: '下一步',
    pointers: ['E:/x'], moment: '2026-11-17 10:00 +0800', atMs: 1794700000000 + i * 1000,
  });
}
eq('微快照只保留最近 8 份', listSnapshots(sidKeep).count, 8);
fs.rmSync(keepSess, { recursive: true, force: true });

/* ---------------- 锚点合并 ---------------- */

const anchorSid = 'session-anchor-selftest';
const anchorSessDir = path.join(tmpHome, '.dsh', 'sessions', 'slug', anchorSid);
fs.mkdirSync(anchorSessDir, { recursive: true });
fs.writeFileSync(path.join(anchorSessDir, 'session.v4.jsonl.zstd'), '');
const a1 = mergeAnchor(anchorSid, { goal: '做 X', status: '进行中', constraints: ['不要改 A', '必须跑测试'], pending: ['P1'] });
check('锚点首次创建于会话目录', a1.path.indexOf(path.join(anchorSid, 'dsh-handover', 'anchor.md')) !== -1, a1.path);
check('锚点文件存在', readAnchor(anchorSid).exists);
const anchorHeads = ['## 目标', '## 状态', '## 约束', '## 已确认事实', '## 决策', '## 未完成', '## 文件', '## 指针'];
check('锚点固定节齐全', anchorHeads.every((h) => readAnchor(anchorSid).text.indexOf(h) !== -1), readAnchor(anchorSid).text.slice(0, 80));
check('锚点返回 token 数', Number.isFinite(a1.tokens) && a1.tokens > 0, String(a1.tokens));
eq('锚点首次约束', a1.sections.constraints, ['不要改 A', '必须跑测试']);
const a2 = mergeAnchor(anchorSid, { constraints: ['不要改 A', '只能改 B'] });
eq('锚点约束追加去重', a2.sections.constraints, ['不要改 A', '必须跑测试', '只能改 B']);
check('.bak 已生成', fs.existsSync(a1.path + '.bak'));
const a3 = mergeAnchor(anchorSid, { pending: ['P2'] });
eq('pending 有值则替换', a3.sections.pending, ['P2']);
eq('未传 goal 时沿用旧值', a3.sections.goal, '做 X');

const trimSid = 'session-anchor-trim-selftest';
const trimDir = path.join(tmpHome, '.dsh', 'sessions', 'slug', trimSid);
fs.mkdirSync(trimDir, { recursive: true });
fs.writeFileSync(path.join(trimDir, 'session.v4.jsonl.zstd'), '');
const trimConstraints = Array.from({ length: 8 }, (_, i) => '必须保留约束第' + i + '条');
const a4 = mergeAnchor(trimSid, {
  constraints: trimConstraints,
  facts: ['很长的已确认事实'.repeat(40)],
  decisions: ['很长的决策理由'.repeat(40)],
  pending: ['很长的未完成事项'.repeat(40)],
}, { anchorMaxTokens: 60, constraintMax: 8 });
eq('约束不被裁剪', a4.sections.constraints.length, 8);
check('约束仍可在正文找到', readAnchor(trimSid).text.indexOf(trimConstraints[7]) !== -1);
check('事实全部保留', a4.sections.facts.length === 1, JSON.stringify(a4.sections.facts.map((x) => x.length)));
check('未完成全部保留', a4.sections.pending.length === 1);
check('锚点超预算已标记', a4.overBudget === true);

process.env.USERPROFILE = homeBak.u || '';
process.env.HOME = homeBak.h || '';
fs.rmSync(tmpHome, { recursive: true, force: true });

/* ---------------- 工具输出上限 ---------------- */

const NL2 = String.fromCharCode(10);
const small = ['a', 'b', 'c'].join(NL2);
eq('上限内原样返回', capText(small, { maxLines: 10 }), small);
const big = Array.from({ length: 700 }, (_, i) => 'line-' + (i + 1)).join(NL2);
const cut = capText(big, { maxLines: 600, hint: '续读：给 offset=601。' });
check('超限截断报总行数', cut.indexOf('全文 700 行') !== -1, cut.slice(-60));
check('超限只返回前 600 行', /line-600/.test(cut) && !/line-601/.test(cut));
check('截断提示含续读引导', cut.indexOf('续读') !== -1);
const ranged = capText(big, { maxLines: 600, offset: 601, limit: 50 });
check('定向放行不截断', ranged.indexOf('line-601') !== -1 && ranged.indexOf('line-650') !== -1 && ranged.indexOf('line-651') === -1);
check('范围返回带总行数', ranged.indexOf('共 700 行') !== -1, ranged.slice(-40));
check('交接读取上限 600 行', HANDOVER_MAX_LINES === 600);
const beyond = capText(big, { offset: 900 });
check('起点超出全文给提示', beyond.indexOf('超出全文') !== -1, beyond);

/* ---------------- 身份互转布局 ---------------- */

const idWs = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-handover-id-'));
const idMeta = path.join(idWs, '_Project_Meta');
fs.mkdirSync(path.join(idWs, '_Control_Center', 'records'), { recursive: true });
fs.mkdirSync(idMeta, { recursive: true });
fs.writeFileSync(path.join(idMeta, 'Registry.md'),
  '# 项目清单' + '\n\n## 项目清单\n\n| 项目 | 库根 | 元数据 | 状态 | 交接 | 备注 | 更新 | 类型 |\n|---|---|---|---|---|---|---|---|\n', 'utf8');
const miscDir = path.join(idWs, '_Misc', 'tasks', 'T');
fs.mkdirSync(path.join(miscDir, 'Docs'), { recursive: true });
fs.writeFileSync(path.join(miscDir, 'task.profile.json'), JSON.stringify({ schema: 1, kind: 'general', root: '_Misc/tasks/T' }), 'utf8');
fs.writeFileSync(path.join(miscDir, 'Handover.md'), '# 交接\n', 'utf8');
fs.writeFileSync(path.join(miscDir, 'System.md'), '- 库根：_Misc/tasks/T\n', 'utf8');
fs.writeFileSync(path.join(miscDir, 'Project_Overview.md'), '# 总览\n', 'utf8');
fs.writeFileSync(path.join(miscDir, 'RULES.md'), '# 规则\n', 'utf8');
migrateIdentity({ ws: idWs, prev: { role: 'misc', task: 'T' }, next: { role: 'project', project: 'P' }, mode: 'auto' });
const pMeta = path.join(idMeta, 'P');
const pLib = path.join(idWs, 'Projects', 'P', 'P库');
check('杂项转项目：交接进元数据目录', isFile(path.join(pMeta, 'Handover.md')));
check('杂项转项目：体系进元数据目录', isFile(path.join(pMeta, 'System.md')));
check('杂项转项目：总览进元数据目录', isFile(path.join(pMeta, 'Project_Overview.md')));
check('杂项转项目：库内容进库目录', isFile(path.join(pLib, 'RULES.md')));
check('杂项转项目：库根不留交接', !isFile(path.join(pLib, 'Handover.md')));
check('杂项转项目：库根不留档案', !isFile(path.join(pLib, 'task.profile.json')));
const pProf = JSON.parse(fs.readFileSync(path.join(pMeta, 'project.profile.json'), 'utf8'));
check('杂项转项目：档案根改为项目根', pProf.root === 'Projects/P', JSON.stringify(pProf));
const pSys = fs.readFileSync(path.join(pMeta, 'System.md'), 'utf8');
check('杂项转项目：体系旧根已改写', pSys.indexOf('Projects/P') !== -1 && pSys.indexOf('_Misc/tasks/T') === -1, pSys);
migrateIdentity({ ws: idWs, prev: { role: 'project', project: 'P' }, next: { role: 'misc', task: 'T2' }, mode: 'auto' });
const t2 = path.join(idWs, '_Misc', 'tasks', 'T2');
check('项目转杂项：交接进任务目录', isFile(path.join(t2, 'Handover.md')));
check('项目转杂项：库内容随迁', isFile(path.join(t2, 'RULES.md')));
check('项目转杂项：拆掉库包装层', !isDir(path.join(t2, 'P库')));
check('项目转杂项：体系进任务目录', isFile(path.join(t2, 'System.md')));
const t2Prof = JSON.parse(fs.readFileSync(path.join(t2, 'task.profile.json'), 'utf8'));
check('项目转杂项：档案根改为任务根', t2Prof.root === '_Misc/tasks/T2', JSON.stringify(t2Prof));
migrateIdentity({ ws: idWs, prev: { role: 'misc', task: 'T2' }, next: { role: 'project', project: 'P2' }, mode: 'auto' });
const p2Lib = path.join(idWs, 'Projects', 'P2', 'P2库');
check('来回转换：库内容只套一层', isFile(path.join(p2Lib, 'RULES.md')) && !isDir(path.join(p2Lib, 'P2库')));
check('来回转换：档案回元数据目录', isFile(path.join(idMeta, 'P2', 'Handover.md')));
fs.rmSync(idWs, { recursive: true, force: true });

/* ---------------- 身份互转：前置检查失败不动文件 ---------------- */

{
  // 名册里已有目标类别键时，互转必须在移动前失败：源目录、目标目录、登记表与快照都不动。
  const cfWs = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-handover-id-conflict-'));
  const cfSrc = path.join(cfWs, '_Misc', 'tasks', 'TC');
  fs.mkdirSync(path.join(cfWs, '_Control_Center', 'records'), { recursive: true });
  fs.mkdirSync(cfSrc, { recursive: true });
  fs.writeFileSync(path.join(cfSrc, 'Handover.md'), '# 交接\n', 'utf8');
  const cfOffice = path.join(cfWs, '_Control_Center', 'records', 'Office.json');
  const cfOfficeText = JSON.stringify({
    version: 1,
    lineages: {
      TC: { kind: 'misc', task: 'TC', current: null, history: [] },
      P9: { kind: 'project', project: 'P9', current: null, history: [] },
    },
  }, null, 2);
  fs.writeFileSync(cfOffice, cfOfficeText, 'utf8');
  let cfMsg = '';
  try {
    migrateIdentity({ ws: cfWs, prev: { role: 'misc', task: 'TC' }, next: { role: 'project', project: 'P9' }, mode: 'auto' });
  } catch (e) { cfMsg = String(e && e.message ? e.message : e); }
  check('目标名册键已存在时互转报错', /名册里已有/.test(cfMsg), cfMsg);
  check('互转失败源目录仍在', isDir(cfSrc) && isFile(path.join(cfSrc, 'Handover.md')));
  check('互转失败不建目标目录', !isDir(path.join(cfWs, 'Projects', 'P9')));
  check('互转失败不改登记表', fs.readFileSync(cfOffice, 'utf8') === cfOfficeText);
  check('互转失败不留快照', !isDir(path.join(cfWs, '_Archives')));
  fs.rmSync(cfWs, { recursive: true, force: true });
}

/* ---------------- 工具只读冒烟 ---------------- */

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
  selfPressure(id) {
    if (!id) return { used: null, win: null };
    const target = id.indexOf('session-') === 0 ? id : 'session-' + id;
    for (const f of readJsonDir(projCacheDir())) {
      const stem = f.name.replace('.json', '');
      if (stem === target || stem === id) return readPressure(f.data);
    }
    return { used: null, win: null };
  },
  compactionCount() {
    const st = compactionStateOf(selfId || null, null);
    return { used: st.used, note: '' };
  },
  lockState() { return compactionStateOf(selfId || null, null).lock; },
  compactionState() { return compactionStateOf(selfId || null, null); },
};

const envSucceed = Object.assign({}, env, {
  selfId: () => 'session-selftest-succeed',
  roleOf: () => ({ role: 'project', project: 'Demo', task: '', source: 'selftest' }),
  handoverFor: () => ({ path: path.join(ws, '_Project_Meta', 'Demo', 'Handover.md'), reason: '' }),
});

const exec = null;

/* ---------------- 1.1.1 动作级用例 ---------------- */

const envGlobal = Object.assign({}, env, {
  roleOf: () => ({ role: 'global', project: '', task: '', source: 'selftest' }),
});
const envProject = Object.assign({}, env, {
  selfId: () => 'session-selftest-project',
  roleOf: () => ({ role: 'project', project: 'Demo', task: '', source: 'selftest' }),
});

async function throwsWith(name, fn, re) {
  try {
    await fn();
    check(name, false, '未抛错');
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    check(name, !re || re.test(msg), msg);
  }
}

const stateStub = () => ({ schedulerReady: () => false, schedulerError: () => 'selftest' });

eq('入口总数为 6', ALL_TOOL_NAMES.length, 6);
check('工具面不含 ho_recall', ALL_TOOL_NAMES.indexOf('ho_recall') === -1, JSON.stringify(ALL_TOOL_NAMES));
eq('全局可见全部入口', toolsetFor('global').allow.slice().sort(), ALL_TOOL_NAMES.slice().sort());
eq('全局无被拒入口', toolsetFor('global').deny.length, 0);
const OLD_NAMES = ['ho_gate', 'ho_checkpoint', 'ho_charter', 'ho_changelog', 'ho_backup', 'ho_profile', 'ho_office', 'ho_succeed'];
for (const role of ['global', 'project', 'misc']) {
  check(role + ' 不可见旧入口', OLD_NAMES.every((n) => toolsetFor(role).allow.indexOf(n) === -1));
}
check('项目不可见 ho_workspace', toolsetFor('project').allow.indexOf('ho_workspace') === -1);
check('杂项不可见 ho_workspace', toolsetFor('misc').allow.indexOf('ho_workspace') === -1);
check('项目可见 ho_sessions', toolsetFor('project').allow.indexOf('ho_sessions') !== -1);

await throwsWith('status 拒绝未知 view', () => pmStatusTool(envGlobal, stateStub()).execute({ view: 'nope' }, exec), /view/);
await throwsWith('handover 拒绝未知 action', () => pmHandoverTool(envGlobal).execute({ action: 'nope' }, exec), /不在允许范围/);
await throwsWith('handover rotate 缺 text', () => pmHandoverTool(envGlobal).execute({ action: 'rotate' }, exec), /缺少 `text`/);
await throwsWith('docmap 拒绝未知 action', () => pmDocmapTool(envGlobal).execute({ action: 'nope' }, exec), /不在允许范围/);
await throwsWith('docmap plan-write 缺 text', () => pmDocmapTool(envGlobal).execute({ action: 'plan-write' }, exec), /缺少 `text`/);
await throwsWith('docmap changelog-append 缺 summary', () => pmDocmapTool(envGlobal).execute({ action: 'changelog-append' }, exec), /缺少 `summary`/);
await throwsWith('docmap registry-write 项目缺 entries', () => pmDocmapTool(envProject).execute({ action: 'registry-write' }, exec), /缺少 `entries`/);
await throwsWith('workspace 拒绝未知 action', () => pmWorkspaceTool(envGlobal).execute({ action: 'nope' }, exec), /不在允许范围/);
await throwsWith('workspace create 缺 path', () => pmWorkspaceTool(envGlobal).execute({ action: 'create' }, exec), /缺少 `path`/);
await throwsWith('workspace backup-restore 缺 pack', () => pmWorkspaceTool(envGlobal).execute({ action: 'backup-restore' }, exec), /缺少 `pack`/);
await throwsWith('项目会话越权 list', () => pmSessionsTool(envProject).execute({ action: 'list' }, exec), /只对全局会话开放/);
await throwsWith('项目会话越权 role', () => pmSessionsTool(envProject).execute({ action: 'role', session_id: 'x', role: 'project' }, exec), /只对全局会话开放/);
await throwsWith('项目会话越权 office-register', () => pmSessionsTool(envProject).execute({ action: 'office-register', name: 'Demo' }, exec), /只对全局会话开放/);
await throwsWith('office-register 缺 name', () => pmSessionsTool(envGlobal).execute({ action: 'office-register' }, exec), /缺少 `name`/);
await throwsWith('task-init 缺 task', () => pmSessionsTool(envGlobal).execute({ action: 'task-init' }, exec), /缺少 `task`/);

/* ---------------- compact 胶囊必填与来源 ---------------- */

eq('胶囊正文上限 4000', CAPSULE_MAX_CHARS, 4000);
eq('胶囊渲染参考上限 4600', CAPSULE_RENDER_MAX_CHARS, 4600);
{
  const calls = { n: 0, last: null, source: 'assistant' };
  const compactEnv = {
    cfg: { capsuleMaxChars: 4600, anchorMaxTokens: 1500 },
    assistantCompact: async (execArg, opts) => {
      calls.n += 1;
      calls.last = opts;
      const body = opts.capsule;
      return {
        ok: true,
        status: 'ok',
        tokensBefore: 100000,
        tokensAfter: 45000,
        roi: 0.55,
        anchorPath: 'E:/a.md',
        anchorTokens: 10,
        anchorOverBudget: false,
        capsuleChars: body.length + 80,
        capsuleBodyChars: body.length,
        capsuleSource: calls.source,
        remaining: 3,
        mode: opts.mode,
      };
    },
  };
  const compactTool = pmHandoverTool(compactEnv);
  const missing = await compactTool.execute({ action: 'compact' }, exec);
  check('compact 缺 capsule 拒绝且未压缩', calls.n === 0 && /安全断点/.test(missing.text)
    && /capsule/.test(missing.text), missing.text);
  const blank = await compactTool.execute({ action: 'compact', capsule: '   ' }, exec);
  check('compact 空 capsule 拒绝且未压缩', calls.n === 0 && /安全断点/.test(blank.text), blank.text);
  const over = await compactTool.execute({ action: 'compact', capsule: '字'.repeat(CAPSULE_MAX_CHARS + 1) }, exec);
  check('compact 超 4000 字拒绝且未压缩', calls.n === 0
    && over.text.indexOf('胶囊正文 ' + (CAPSULE_MAX_CHARS + 1) + ' 字') !== -1
    && over.text.indexOf('超过正文上限 4000 字（硬拒绝，不截断）') !== -1 && /精简/.test(over.text), over.text);
  const edge = await compactTool.execute({ action: 'compact', capsule: '字'.repeat(CAPSULE_MAX_CHARS) }, exec);
  check('compact 正文 4000 字放行', calls.n === 1 && calls.last && calls.last.capsule.length === CAPSULE_MAX_CHARS, String(calls.n));
  const okResult = await compactTool.execute({ action: 'compact', capsule: '目标：补齐部署脚本' }, exec);
  check('compact 透传 capsule', calls.n === 2 && calls.last && calls.last.capsule === '目标：补齐部署脚本',
    JSON.stringify(calls.last));
  check('compact 回告助手自述来源', /胶囊来源：助手自述（9 字）/.test(okResult.text), okResult.text);
  calls.source = 'mechanism';
  const mechResult = await compactTool.execute({ action: 'compact', capsule: '目标：机制' }, exec);
  check('compact 回告机制兜底来源', /胶囊来源：机制兜底/.test(mechResult.text), mechResult.text);
}
{
  // 压缩后读数未知：回执写「待下一轮校准」，不填数字，并提示不要拿回执当水位。
  const compactEnv = {
    cfg: { capsuleMaxChars: 4600, anchorMaxTokens: 1500 },
    assistantCompact: async (execArg, opts) => ({
      ok: true,
      status: 'ok',
      tokensBefore: 318789,
      tokensAfter: null,
      roi: null,
      anchorPath: 'E:/a.md',
      anchorTokens: 10,
      anchorOverBudget: false,
      capsuleChars: 80,
      capsuleBodyChars: opts.capsule.length,
      capsuleSource: 'assistant',
      remaining: 3,
      mode: opts.mode,
    }),
  };
  const r = await pmHandoverTool(compactEnv).execute({ action: 'compact', capsule: '目标：待校准' }, exec);
  check('回执压缩后未知写待下一轮校准', /压缩前 318789 token，压缩后 待下一轮校准/.test(r.text)
    && r.text.indexOf('缩减 未核') !== -1, r.text);
  check('回执提示不要拿回执当水位', r.text.indexOf('不要拿本次回执当水位') !== -1, r.text);
}
{
  // 渲染后 4601 字只报告：正文未超正文上限，渲染长度超参考线时不拒绝、不裁剪。
  const compactEnv = {
    cfg: { capsuleMaxChars: 4600, anchorMaxTokens: 1500 },
    assistantCompact: async (execArg, opts) => ({
      ok: true,
      status: 'ok',
      tokensBefore: 100000,
      tokensAfter: 45000,
      roi: 0.55,
      anchorPath: 'E:/a.md',
      anchorTokens: 10,
      anchorOverBudget: false,
      capsuleChars: CAPSULE_RENDER_MAX_CHARS + 1,
      capsuleBodyChars: opts.capsule.length,
      capsuleSource: 'assistant',
      capsuleOverBudget: true,
      remaining: 3,
      mode: opts.mode,
    }),
  };
  const r = await pmHandoverTool(compactEnv).execute({ action: 'compact', capsule: '目标：边界' }, exec);
  check('compact 渲染超 4600 字只报告',
    r.text.indexOf('4601 字') !== -1 && r.text.indexOf('超过渲染后参考上限 4600') !== -1
    && /仅报告，正文未裁/.test(r.text), r.text);
}

/* ---------------- 换任 rotate：留痕、归档与承接项 ---------------- */

const rotWs = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-handover-rotate-'));
const rotPath = path.join(rotWs, '_Project_Meta', 'Demo', 'Handover.md');
fs.mkdirSync(path.dirname(rotPath), { recursive: true });
const rotSteps = [];
const rotEnv = {
  cfg,
  resolveWs: () => rotWs,
  roleOf: () => ({ role: 'project', project: 'Demo', task: '' }),
  handoverFor: () => ({ path: rotPath, kind: 'project', role: 'project', project: 'Demo' }),
  noteHandoverStep: (e, kind, data) => rotSteps.push({ kind, data }),
};
const rotTool = pmHandoverTool(rotEnv);
const rotOld = [
  '# 交接文档', '',
  '## 1 正在做的事', '推进中', '',
  '## 2 下一步', '- 补齐回滚分支', '- 复跑自测', '',
  '## 3 待用户决定', '- 是否保留旧接口', '',
  '## 5 风险与禁区', '- 不得改动配置', '',
  '## 6 关键路径', '- D:/ws/deploy', '',
].join(NL2);
const rotFirst = await rotTool.execute({ action: 'rotate', text: rotOld.replace('推进中', '首次') }, null);
check('rotate 原交接不存在时直接新建', /原交接不存在，直接新建/.test(rotFirst.text), rotFirst.text);
check('rotate 返回新交接路径与字节', rotFirst.text.indexOf(rotPath) !== -1 && /（\d+ B）/.test(rotFirst.text), rotFirst.text);
check('rotate 首次无承接项', /承接项：无/.test(rotFirst.text), rotFirst.text);
check('rotate 首次不记归档', rotSteps.every((s) => s.kind !== 'archive'), JSON.stringify(rotSteps.map((s) => s.kind)));
eq('rotate 首次仍记 rotate 留痕', rotSteps.filter((s) => s.kind === 'rotate').length, 1);

rotSteps.length = 0;
const rotSecond = await rotTool.execute({ action: 'rotate', text: rotOld.replace('推进中', '第二次') }, null);
eq('rotate 留痕顺序', rotSteps.map((s) => s.kind), ['read', 'archive', 'new', 'rotate']);
const rotArchive = rotSteps.find((s) => s.kind === 'archive');
check('rotate 归档 sha256 与副本一致', !!rotArchive && fileSha256(rotArchive.data.dest) === rotArchive.data.sha256, rotArchive && rotArchive.data.dest);
check('rotate 返回归档路径与字节', /归档 `/.test(rotSecond.text) && rotSecond.text.indexOf(rotArchive.data.dest) !== -1, rotSecond.text);
check('rotate 体检通过', /体检 通过/.test(rotSecond.text), rotSecond.text);
check('rotate 返回承接项', /承接项 1：补齐回滚分支/.test(rotSecond.text) && /承接项需自行并入新正文/.test(rotSecond.text), rotSecond.text);

const rotMany = ['## 2 下一步'].concat(Array.from({ length: 10 }, (_, i) => '- 事项' + (i + 1))).join(NL2);
eq('承接项提取上限为 8', carryItemsOf(rotMany, 8).length, 8);
await rotTool.execute({ action: 'rotate', text: rotMany }, null);
const rotCapped = await rotTool.execute({ action: 'rotate', text: rotMany }, null);
eq('rotate 返回承接项最多 6 条', rotCapped.text.split(NL2).filter((l) => /^承接项 \d+：/.test(l)).length, 6);

/* ---------------- 换任硬闸：rotate 留痕判据 ---------------- */

const gateBase = {
  flow: { rotatedAt: 3000, newAt: 4000, archivePath: 'E:/arch/a.md', archiveSha256: 'abc' },
  archiveSha256: 'abc',
  archiveMtimeMs: 3500,
  handoverMtimeMs: 4000,
  lint: { verdict: '通过', reasons: [] },
  lock: 'clean',
  compactionPending: false,
  openToolCalls: 0,
};
const gateWith = (patch) => judgeRotateGate(Object.assign({}, gateBase, patch, {
  flow: Object.assign({}, gateBase.flow, patch.flow || {}),
}));
check('硬闸：留痕齐全通过', gateWith({}).ok === true, JSON.stringify(gateWith({}).lines));
check('硬闸：缺 rotate 拒绝', gateWith({ flow: { rotatedAt: 0 } }).ok === false);
check('硬闸：归档 sha256 不一致拒绝', gateWith({ archiveSha256: 'def' }).ok === false);
check('硬闸：newAt 早于归档拒绝', gateWith({ flow: { newAt: 3000 }, handoverMtimeMs: 3000, archiveMtimeMs: 3500 }).ok === false);
check('硬闸：结构不合格拒绝', gateWith({ lint: { verdict: '不合格', reasons: ['缺一节'] } }).ok === false);
check('硬闸：压缩锁未闭合拒绝', gateWith({ lock: 'open' }).ok === false);
check('硬闸：未闭合工具调用超限拒绝', gateWith({ openToolCalls: 2 }).ok === false);

/* ---------------- 召回视图：关键词、结构过滤、around 与空结果 ---------------- */

const recallExec = { agent: { session: { header: { id: 'session-recall-selftest' }, events: RECORDS } } };
const recallStatus = pmStatusTool(Object.assign({}, env, {
  selfId: () => 'session-recall-selftest',
  roleOf: () => ({ role: 'project', project: 'Demo', task: '' }),
}), stateStub());
const litView = await recallStatus.execute({ view: 'recall', query: '权限不足', mode: 'literal' }, recallExec);
check('召回视图：字面命中失败结果', /seq 8/.test(litView.text) && /失败/.test(litView.text), litView.text.slice(0, 160));
const mergedView = await recallStatus.execute({ view: 'recall', query: '权限不足', mode: 'literal' }, recallExec);
check('召回视图：全量命中与合并组', /全量命中 2 条/.test(mergedView.text) && /合并 1 组/.test(mergedView.text) && /出现 2 次/.test(mergedView.text), mergedView.text.slice(0, 200));
check('召回视图：组内序号与指针', /同组 seq：8、9/.test(mergedView.text) && /around=<seq>/.test(mergedView.text), mergedView.text.slice(0, 240));
const relView = await recallStatus.execute({ view: 'recall', query: '回滚', mode: 'literal', order: 'relevance' }, recallExec);
check('召回视图：顺序字段', /顺序 time/.test(litView.text) && /顺序 relevance/.test(relView.text), relView.text.slice(0, 200));
const structView = await recallStatus.execute({ view: 'recall', mode: 'structural', filter: 'type:tool/result, error:true' }, recallExec);
check('召回视图：结构过滤', /seq 8/.test(structView.text) && /8、9/.test(structView.text) && /出现 2 次/.test(structView.text), structView.text.slice(0, 200));
const emptyView = await recallStatus.execute({ view: 'recall', query: '完全不存在的词组xyz', mode: 'literal' }, recallExec);
check('召回视图：空结果引导', /没有命中/.test(emptyView.text) && /ho_status\(view="recall"/.test(emptyView.text), emptyView.text.slice(0, 200));
await throwsWith('召回视图：query 与 around 冲突', () => recallStatus.execute({ view: 'recall', query: '权限', around: 8 }, recallExec), /互斥/);
const aroundView = await recallStatus.execute({ view: 'recall', around: 8 }, recallExec);
check('召回视图：around 展开前后事件', /邻近事件/.test(aroundView.text) && /seq 5/.test(aroundView.text) && /seq 10/.test(aroundView.text), aroundView.text.slice(0, 200));

/* ---------------- 建会话：角色可核验 + 中止 ---------------- */

const roleStore = new Map();
let roleWrites = 0;
let roleSeq = 0;
function createEnv(opts) {
  const o = opts || {};
  return {
    controller: () => ({
      create: async () => ({ sessionId: 'sid-role-' + (++roleSeq) }),
      rename: async () => {},
    }),
    writeRole: (sid, patch) => {
      roleWrites += 1;
      if (o.throwOnWrite === true) throw new Error('磁盘只读');
      if (o.dropWrite !== true) roleStore.set(sid, Object.assign({}, patch));
    },
    roleEntryOf: (sid) => roleStore.get(sid) || null,
    applyScopedLive: () => {},
  };
}

roleWrites = 0;
const madeOk = await newSessionIn(createEnv(), { cwd: 'C:/x', role: 'global' });
check('建会话后角色可核验', madeOk.sessionId !== '' && !madeOk.error, madeOk.error || '无 sessionId');
check('角色表立即有条目', (roleStore.get(madeOk.sessionId) || {}).role === 'global');

roleWrites = 0;
const madeDrop = await newSessionIn(createEnv({ dropWrite: true }), { cwd: 'C:/x', role: 'project', project: 'Demo' });
check('角色写不进时补写一次并显式报错', roleWrites === 2 && /角色登记失败/.test(madeDrop.error || ''), '写次 ' + roleWrites + ' / ' + (madeDrop.error || '无错误'));
check('角色登记失败仍保留已建会话', String(madeDrop.sessionId).indexOf('sid-role-') === 0);

const madeThrow = await newSessionIn(createEnv({ throwOnWrite: true }), { cwd: 'C:/x', role: 'misc', task: 't' });
check('角色写入抛错时带原因', /角色登记失败：磁盘只读/.test(madeThrow.error || ''), madeThrow.error || '无错误');

check('中止文案统一', /^已中止：/.test(ABORTED_TEXT));
const t0 = Date.now();
const whyAbort = await abortableDelay(5000, AbortSignal.abort());
check('中止等待立即返回', whyAbort === 'aborted' && Date.now() - t0 < 2000, whyAbort + ' / ' + (Date.now() - t0) + 'ms');
const peerAbort = await pmPeerTool(envGlobal).execute({ action: 'wait', session_id: 'sid-x', timeout_ms: 120000 }, { signal: AbortSignal.abort() });
check('peer wait 中止即返回', /已中止/.test(peerAbort.text), peerAbort.text);

/* ---------------- 中止必须发生在等待途中也生效 ---------------- */

const midCtl = new AbortController();
const midT0 = Date.now();
const midTimer = setTimeout(() => midCtl.abort(), 120);
const whyMid = await abortableDelay(5000, midCtl.signal);
clearTimeout(midTimer);
const midElapsed = Date.now() - midT0;
check('等待中途中止 2 秒内返回', whyMid === 'aborted' && midElapsed < 2000, whyMid + ' / ' + midElapsed + 'ms');

/* ---------------- 中止不导致重复投递 ---------------- */

let prompts = 0;
const sendExec = { agent: { session: { header: { id: 'session-send-probe' } } } };
const sendEnv = (onPrompt) => Object.assign({}, env, {
  controller: () => ({ prompt: onPrompt }),
});

const sendPre = new AbortController();
sendPre.abort();
const preSend = await pmPeerTool(sendEnv(async () => { prompts += 1; return { accepted: true }; }))
  .execute({ action: 'send', session_id: 'sid-target', message: 'hi' }, Object.assign({}, sendExec, { signal: sendPre.signal }));
check('投递前中止不发送', /已中止/.test(preSend.text) && prompts === 0, 'prompts=' + prompts);

prompts = 0;
const sendMid = new AbortController();
const midSend = await pmPeerTool(sendEnv(async () => {
  prompts += 1;
  sendMid.abort();
  throw new Error('transport closed');
})).execute({ action: 'send', session_id: 'sid-target', message: 'hi' }, Object.assign({}, sendExec, { signal: sendMid.signal }));
check('投递途中中止只投一次且不重试', /已中止/.test(midSend.text) && prompts === 1, prompts + ' 次 / ' + midSend.text);

/* ---------------- 早退留痕：每原因一条、去重生效 ---------------- */

const skipLines = [];
let skipNow = 1000;
const noteSkip = createSkipLogger({
  now: () => skipNow,
  write: (line) => skipLines.push(line),
  pct: (v) => String(Math.round(v * 100)),
});
check('留痕首条写入', noteSkip('sid-a', 'no-role', 0.13) === true && skipLines.length === 1);
check('留痕同 sid+reason 去重', noteSkip('sid-a', 'no-role', 0.5) === false && skipLines.length === 1);
check('留痕换原因另写一条', noteSkip('sid-a', 'plain', 0.13) === true && skipLines.length === 2);
check('留痕带 sid 与比例', skipLines[0] === '自触发跳过 sid=sid-a reason=no-role ratio=13', skipLines[0]);
skipNow += 300001;
check('留痕 5 分钟后重新写', noteSkip('sid-a', 'no-role', 0.2) === true && skipLines.length === 3);

/* ---------------- 留痕与可中止等待：静态核对 ---------------- */

for (const reason of ['no-sid', 'subagent', 'no-role', 'plain', 'inline-inflight', 'no-pressure', 'not-triggered', 'open-tool-calls']) {
  check('自触发留痕 reason=' + reason, autoBlock.indexOf("noteTriggerSkip(sid, '" + reason + "'") !== -1);
}
check('硬上限留痕一次', autoBlock.indexOf("noteTriggerSkip(sid, 'compaction-limit'") !== -1);
const skipSrc = fs.readFileSync(new URL('./lib/skip-log.mjs', import.meta.url), 'utf8');
check('自触发留痕带 sid/ratio', skipSrc.indexOf("'自触发跳过 sid='") !== -1 && skipSrc.indexOf("' ratio='") !== -1);
check('自触发留痕按 sid+reason 去重', skipSrc.indexOf('ttlMs') !== -1 && skipSrc.indexOf('300000') !== -1);
check('插件入口接统一留痕器', autoBlock.indexOf('createSkipLogger') !== -1);

const peerSrc = fs.readFileSync(new URL('./tools/peer.mjs', import.meta.url), 'utf8');
check('peer 阻塞等待可中止', peerSrc.indexOf('abortableDelay') !== -1 && peerSrc.indexOf('signalOf(exec)') !== -1 && peerSrc.indexOf('ABORTED_TEXT') !== -1);
const compactToolSrc = fs.readFileSync(new URL('./tools/compact.mjs', import.meta.url), 'utf8');
check('助手压缩入口走统一闸门', compactToolSrc.indexOf('env.assistantCompact') !== -1);
const gateSrc = fs.readFileSync(new URL('./lib/compact-gate.mjs', import.meta.url), 'utf8');
check('助手压缩闸门已删旧两项', gateSrc.indexOf('提示注入') === -1 && gateSrc.indexOf('交接更新时间') === -1);
check('助手压缩闸门含锚点、计数与工具闭合', gateSrc.indexOf('锚点可写') !== -1 && gateSrc.indexOf('压缩计数') !== -1
  && gateSrc.indexOf('未闭合工具调用') !== -1);
const moverSrc = fs.readFileSync(new URL('./lib/mover.mjs', import.meta.url), 'utf8');
check('批处理启动器先切 UTF-8 代码页', moverSrc.indexOf("'chcp 65001 >nul'") !== -1);

/* ---------------- 修复覆盖：结构断言与最小行为断言 ---------------- */

const statusSrc = fs.readFileSync(new URL('./tools/ho_status.mjs', import.meta.url), 'utf8');
const roleSrc = fs.readFileSync(new URL('./lib/role-assembly.mjs', import.meta.url), 'utf8');
const checkpointSrc = fs.readFileSync(new URL('./lib/checkpoint.mjs', import.meta.url), 'utf8');
const successionSrc = fs.readFileSync(new URL('./lib/succession.mjs', import.meta.url), 'utf8');

// D-115 / D-116 / D-125：已删除的配置、参数与状态。
eq('D-115 快照最小间隔配置已移除', dflt.snapshotMinGapMs, undefined);
check('D-116 boundary 参数已移除', pmHandoverTool(envGlobal).parameters.properties.boundary === undefined);
check('D-125 skipTierOnce 已移除', statusSrc.indexOf('skipTierOnce') === -1);

// D-104 / D-133：在任命名按历史最大号 +1，类别尾号不计入代数。
eq('D-104 无在任时全局命名为 全局1', nextName({ lineages: {} }, '全局'), '全局1');
eq('D-104 已有全局时最大号 +1',
  nextName({ lineages: { 全局: { current: { name: '全局3' }, history: [{ name: '全局2' }] } } }, '全局'), '全局4');
eq('D-133 类别尾号不计入代数',
  nextName({ lineages: { Demo2: { current: { name: 'Demo2' }, history: [] } } }, 'Demo2'), 'Demo3');

// D-109：初始化错误去重且有上限。
const ie = createInitErrors(50);
ie.push('同一条');
ie.push('同一条');
eq('D-109 初始化错误去重', ie.length, 1);
for (let i = 0; i < 60; i += 1) ie.push('错误 ' + i);
eq('D-109 初始化错误上限 50', ie.length, 50);

// D-126：跳过日志触顶后按插入序淘汰未过期键。
{
  const note = createSkipLogger({ ttlMs: 1000, maxKeys: 2, now: () => 0, write: () => {} });
  note('a', 'x', 0.1);
  note('b', 'x', 0.1);
  note('c', 'x', 0.1);
  eq('D-126 仍在窗口内的键仍被去重', note('c', 'x', 0.1), false);
  eq('D-126 未过期键按插入序淘汰', note('a', 'x', 0.1), true);
}

// D-111：严格模式下短号解析不到返回空串。
eq('D-111 严格短号解析不到返回空串', resolveShortSid({ cacheDir: () => '' }, 'abc123', { strict: true }), '');
eq('D-111 非严格模式保留原样', resolveShortSid({ cacheDir: () => '' }, 'abc123'), 'abc123');

// D-124：摘要静默期可配置。
eq('D-124 摘要静默期默认 2 分钟', dflt.summaryQuietMs, 120000);
eq('D-124 摘要静默期可覆盖', resolveConfig({ summaryQuietMs: 1000 }).summaryQuietMs, 1000);

// D-162：日志解码返回带状态结果。
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-handover-decode-'));
  const plain = path.join(dir, 'log.txt');
  fs.writeFileSync(plain, '{"type":"user/message","seq":1}' + String.fromCharCode(10), 'utf8');
  eq('D-162 明文日志解码状态为 ok', decodeLogResult(plain).status, 'ok');
  eq('D-162 读不到时状态为 unreadable', decodeLogResult(path.join(dir, 'nope.txt')).status, 'unreadable');
}

// D-165：规则文件读不到时同步检查不抛错。
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-handover-sync-'));
  fs.mkdirSync(path.join(dir, '_Control_Center'), { recursive: true });
  let okSync = true;
  try { syncCheck(dir); } catch { okSync = false; }
  check('D-165 规则缺失时同步检查不抛错', okSync);
}

// D-154：全局总注册只更新任务行，人工备注原样保留。
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-handover-refs-'));
  const file = path.join(dir, '_Control_Center', 'records', 'systems.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = ['# 体系注册（全局）', '', '人工备注：保留本行', '', '| 任务 | 类别 | 体系文件 |', '|---|---|---|', '| 手工 | 说明 | 备注保留 |', ''].join(String.fromCharCode(10));
  fs.writeFileSync(file, text, 'utf8');
  const r = syncGlobalRefs(dir);
  check('D-154 注册同步保留人工备注', r.body.indexOf('人工备注') !== -1 && r.body.indexOf('备注保留') !== -1, r.body);
}

// D-143：体检枚举全部任务目录，缺 System.md 也计入。
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-handover-regcheck-'));
  fs.mkdirSync(path.join(dir, '_Control_Center', 'tasks', 'NoReg'), { recursive: true });
  const r = checkRegistries(dir);
  check('D-143 未创建 System.md 的任务也计入',
    r.rows.some((row) => row.exists === false) && r.unset === 1, JSON.stringify(r));
}

// D-153：校验错误真正写入 errors。
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-handover-prof-'));
  const file = path.join(dir, '_Project_Meta', 'Demo', 'project.profile.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ 坏 JSON', 'utf8');
  const v = validateProfile(dir, { role: 'project', project: 'Demo' });
  check('D-153 解析失败写入 errors', v.errors.length === 1 && /解析失败/.test(v.errors[0]), JSON.stringify(v.errors));
}

// D-160 / D-161 / D-168：状态输出上限与类型化会话 id 校验。
eq('D-160 状态输出上限 300 行', STATUS_MAX_LINES, 300);
check('D-160 gate 与 recall 共用上限', /STATUS_MAX_LINES/.test(statusSrc));
check('D-161 tokens 视图校验跨会话', /跨会话体检仅对全局会话开放/.test(statusSrc));
check('D-168 会话 id 比较前补前缀', /normSid/.test(statusSrc) && /indexOf\('session-'\) === 0/.test(statusSrc));

// D-166 / D-148 / D-107 / D-149：短号口径、客户端 note、授权回退与字节双判。
check('D-166 短号取末 8 位',
  /slice\(-8\)/.test(fs.readFileSync(new URL('./lib/brief.mjs', import.meta.url), 'utf8')));
check('D-148 客户端读 r.note',
  /r\.note/.test(fs.readFileSync(new URL('./client.js', import.meta.url), 'utf8')));
check('D-107 HTTP 回退含 consent 动作',
  /consent\.grant/.test(fs.readFileSync(new URL('./lib/webroute.mjs', import.meta.url), 'utf8')));
{
  const src = fs.readFileSync(new URL('./lib/extra-prompt.mjs', import.meta.url), 'utf8');
  check('D-149 字符与字节双判', /Buffer\.byteLength/.test(src) && /56 \* 1024/.test(src));
}

// D-103 / D-108 / D-110 / D-129：装配的结构不变式。
check('D-103 角色写入与提示段共用工作区解析',
  /唯一的工作区解析入口/.test(roleSrc) && /workspaceForSid/.test(roleSrc));
check('D-108 roleGating=off 文案写「除子会话外」', /除子会话外/.test(roleSrc));
check('D-129 全局名不采信标题', /全局名不采信会话标题/.test(roleSrc));
check('D-110 无 tools.guard 时留痕并降级',
  /无 tools\.guard/.test(fs.readFileSync(new URL('./lib/tool-registry.mjs', import.meta.url), 'utf8')));
check('D-105 装配只认角色注册文件', /registeredOnly: true/.test(roleSrc));
{
  let wsRejected = false;
  try { registerHolder('', { kind: 'project', project: 'X', name: 'a', sessionId: 's' }); } catch { wsRejected = true; }
  check('D-112 无工作区根拒绝登记', wsRejected);
}

// D-122 / D-136 / D-137 / D-138 / D-140 / D-146：文件名、硬闸与写盘口径。
check('D-122 微快照文件名带毫秒',
  /micro_\\d\{8\}_\\d\{6\}/.test(checkpointSrc) && /_\\d\{3\}/.test(checkpointSrc));
check('D-136 硬闸注释按 9 项', /共 9 项/.test(successionSrc));
check('D-137 换任登记原子写', /writeFileAtomic/.test(successionSrc));
{
  const src = fs.readFileSync(new URL('./tools/ho_workspace.mjs', import.meta.url), 'utf8');
  check('D-132 派发失败不再报成功',
    src.indexOf('if (!r.ok)') !== -1 && src.indexOf('已派出后台切换助手') > src.indexOf('if (!r.ok)'));
}
{
  const src = fs.readFileSync(new URL('./lib/compact-gate.mjs', import.meta.url), 'utf8');
  check('D-138 失败文案指向换任入口',
    src.indexOf('授权压缩') === -1 && /ho_handover\(action="rotate"/.test(src));
}
check('D-140 写前快照分支已删',
  /不再另做写前快照/.test(fs.readFileSync(new URL('./lib/handover-io.mjs', import.meta.url), 'utf8')));
{
  const src = fs.readFileSync(new URL('./lib/sevenzip.mjs', import.meta.url), 'utf8');
  check('D-146 探测使用配置路径', /if \(configured\) cands\.push\(configured\)/.test(src) && /probed\.has\(key\)/.test(src));
}

// D-141 / D-155 / D-156 / D-157：动作名、统一解码、协作 TTL 与不可达终结。
check('D-141 docmap 动作名为 registry-* 与 plan-*',
  /registry-write/.test(fs.readFileSync(new URL('./tools/ho_docmap.mjs', import.meta.url), 'utf8')));
check('D-155 协作不自带解码器', /decodeLog/.test(peerSrc) && peerSrc.indexOf('inflateRawSync') === -1);
check('D-156 协作注册 12 小时 TTL', /COLLAB_TTL_MS = 12 \* 60 \* 60 \* 1000/.test(peerSrc));
check('D-157 不可达成员立即终结', /不可达（已解除其协作限制）/.test(peerSrc));

const cases = [
  { t: pmStatusTool(env, { schedulerReady: () => false, schedulerError: () => 'selftest' }), a: { view: "brief" }, flag: "status" },
  { t: pmStatusTool(env, { schedulerReady: () => false, schedulerError: () => 'selftest' }), a: { view: "phase" }, flag: "status" },
  { t: pmStatusTool(env, { schedulerReady: () => false, schedulerError: () => 'selftest' }), a: { view: "pressure", simulateRatio: 0.9 }, flag: "status" },
  { t: pmStatusTool(env, { schedulerReady: () => false, schedulerError: () => 'selftest' }), a: { view: "diag" }, flag: "status" },
  { t: pmStatusTool(envGlobal, stateStub()), a: { view: "gate", scope: "all" }, flag: "gate" },
  { t: pmSessionsTool(envGlobal), a: { action: "list" }, flag: "sessions" },
  { t: pmDocmapTool(envGlobal), a: { action: "rules-read", doc: "charter", section: "8.1.1.4", maxLines: 30 }, flag: "docmap" },
  { t: pmSessionsTool(envGlobal), a: { action: "office-read", query: "全局" }, flag: "office" },
  { t: pmSessionsTool(envSucceed), a: { action: "succeed" }, flag: "succeed", want: /未授权|没有授权/ },
];

for (const c of cases) {
  if (only !== "all" && only !== c.flag) continue;
  const bar = "==== " + c.t.name + " " + JSON.stringify(c.a) + " ====";
  console.log(bar);
  try {
    const out = await c.t.execute(c.a, exec);
    console.log(out.text);
    if (c.want) check(c.t.name + ' 输出符合预期', c.want.test(String(out && out.text)), c.want);
  } catch (e) {
    check(c.t.name + ' 不抛错', false, e && e.message ? e.message : String(e));
    console.log("FAILED: " + (e && e.message ? e.message : String(e)));
  }
  console.log("");
}

console.log('');
if (fails.length) {
  console.log('SELFTEST FAIL ' + fails.length + '/' + total + ' 项：');
  for (const f of fails) console.log('  - ' + f);
  process.exitCode = 1;
} else {
  console.log('SELFTEST OK（' + total + ' 项用例全过）');
}
