/**
 * ho_status —— 会话状态：一个入口，按 view 分流。
 *   phase（默认）：水位、压缩、段索引、快照、判据与建议动作
 *   pressure：压力遥测（水位、余量、增速、剩余轮数、分档线与档位）
 *   brief：水位、闸门、会话清点、交接漂移、阶段建议
 *   diag：服务可解析性、初始化错误、角色与工具集
 *   drift：交接漂移体检
 *   tokens：按会话 id 统计轮数、步数、每步 token
 *   gate：通用约束条闸门、交接体检与体系注册路径检查
 *   recall：按关键词或 seq 回读压缩前原文
 * 全部只读；早期各视图与闸门入口已按 1.0.2 归并到此。
 */
import fs from 'node:fs';
import path from 'node:path';
import { textOutput } from '../lib/output.mjs';
import { nameOf } from '../lib/names.mjs';
import { NL, pick } from '../lib/text.mjs';
import { syncCheck } from '../lib/gates.mjs';
import { scanSessions, readSelfPressure, projCacheDir } from '../lib/sessions.mjs';
import { composeBrief, stampTz } from '../lib/brief.mjs';

import { pressureOf, bandsFor, normWater } from '../lib/pressure.mjs';
import { judgeMacroReset, decidePhase as decide } from '../lib/triggers.mjs';
import { computeDrift, driftVerdict } from '../lib/drift.mjs';
import { eventsOf, countCompactions, collectSignals, repeatStats, eventSourceOf } from '../lib/events.mjs';
import { deriveSegments, segmentStats, gainRatio } from '../lib/segments.mjs';
import { listSnapshots } from '../lib/checkpoint.mjs';
import { anchorPathFor, readAnchor } from '../lib/anchor.mjs';
import { estimateTokens } from '../lib/facts.mjs';
import { findLog, decodeLog, turnStarts } from '../lib/zstd-log.mjs';
import { activeConsentsFor, formatConsentLine } from '../lib/consent.mjs';
import { capText, STATUS_MAX_LINES } from '../lib/limit.mjs';
import { search, MODES, aroundEvents } from '../lib/recall.mjs';
import { pmGateTool } from './gate.mjs';

const VIEWS = ['phase', 'pressure', 'brief', 'diag', 'drift', 'tokens', 'gate', 'recall'];

function analyzeLog(records) {
  const turns = turnStarts(records).length;
  let steps = 0, outTok = 0, maxResult = 0, toolResults = 0;
  const perTurn = new Map();
  for (const r of records) {
    if (!r || !r.type) continue;
    if (r.type === 'step/start') {
      steps++;
      const t = pick(r, 'data', 'turn');
      if (typeof t === 'number') perTurn.set(t, (perTurn.get(t) || 0) + 1);
    } else if (r.type === 'assistant/message') {
      const u = pick(r, 'data', 'usage');
      if (u && typeof u.outputTokens === 'number') outTok += u.outputTokens;
    } else if (r.type === 'tool/result') {
      toolResults++;
      try { const len = JSON.stringify(pick(r, 'data') || '').length; if (len > maxResult) maxResult = len; } catch { /* ignore */ }
    }
  }
  const heavyTurns = Array.from(perTurn.values()).filter((n) => n > 20).length;
  return { turns, steps, outTok, maxResult, toolResults, heavyTurns, perStep: steps ? Math.round(outTok / steps) : 0 };
}

/** 授权状态行：压缩与换任各一句，未授权写「无授权」。 */
function consentLine(meId) {
  try { return formatConsentLine(activeConsentsFor(meId)); } catch { return ''; }
}

function pctText(ratio) {
  return ratio === null ? '读不到' : (Math.round(ratio * 1000) / 10).toFixed(1) + '%';
}

function kText(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '未核';
  return Math.round(value / 1000) + 'K';
}

/** 取最近一份快照里的水位记录；读不到返回 null。 */
function snapshotRatioOf(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const m = text.match(/\|\s*水位\s*\|\s*([\d.]+)%\s*\|/);
    return m ? Number(m[1]) / 100 : null;
  } catch { return null; }
}

// 同一会话连续多次看状态（phase → diag、或设置页刷新）不必重算段索引。
// 键含事件数与末条 seq：日志只追加时事件数变化即失效；单条目即可，避免多会话常驻。
let segCache = { key: '', value: null };

function segmentsOf(sid, records) {
  const list = Array.isArray(records) ? records : [];
  const tail = list.length ? list[list.length - 1] : null;
  const key = String(sid || '') + '|' + list.length + '|'
    + (tail && typeof tail.seq === 'number' ? tail.seq : '-') + '|' + (tail && tail.type ? tail.type : '-');
  if (segCache.key === key && segCache.value) return segCache.value;
  const value = deriveSegments(list);
  segCache = { key, value };
  return value;
}

/** 投影缓存文件 mtime：按候选名直接拼出路径，命中即返回。 */
function projCacheMtimeOf(sid) {
  const id = String(sid || '');
  if (!id) return null;
  const bare = id.indexOf('session-') === 0 ? id.slice(8) : id;
  const stems = id.indexOf('session-') === 0 ? [bare, id] : [id, 'session-' + bare];
  const dir = projCacheDir();
  for (const stem of stems) {
    try { return fs.statSync(path.join(dir, stem + '.json')).mtimeMs; } catch { /* 试下一个候选 */ }
  }
  return null;
}

/**
 * 压缩后读数滞后提示：与 events.stalePressureNote 同一判据，
 * 但复用 phaseText 已取到的 lastSummaryMs，不再为这一行重新读一遍压缩状态。
 */
function staleNoteFrom(sid, lastSummaryMs) {
  if (!lastSummaryMs) return '';
  const m = projCacheMtimeOf(sid);
  if (m === null || m >= lastSummaryMs) return '';
  return '（压缩刚完成，投影缓存尚未刷新，水位读数滞后一轮；下一次请求后恢复正常）';
}

function phaseText(env, args, exec) {
  const meId = env.selfId(exec);
  const self = readSelfPressure(env.cacheDir(), meId || '');
  const { used: realUsed, win } = normWater(self);
  const real = realUsed === null || win === null ? null : (realUsed / win) * 100;
  const ratio = typeof args.simulateRatio === 'number' ? args.simulateRatio : (real === null ? null : real / 100);
  const used = typeof args.simulateRatio === 'number' && win
    ? Math.round(args.simulateRatio * win)
    : (typeof self.used === 'number' && Number.isFinite(self.used) ? self.used : null);
  const bands = bandsFor(env.cfg, win);
  // 先取事件记录，再取压缩状态：压缩状态会复用记录缓存的派生结果，同一份日志只解一遍。
  const src = eventSourceOf(meId, exec);
  // 压缩状态只取一次：后面 count / lock / staleNote 全部复用它，不再各解一遍日志。
  const st = typeof env.compactionState === 'function' ? env.compactionState(exec) : null;
  const count = st
    ? { used: st.used, lock: st.lock, lastSummaryMs: st.lastSummaryMs, note: st.note || '' }
    : env.compactionCount(exec);
  const lock = st ? st.lock : env.lockState(exec);
  const segments = segmentsOf(meId, src.records);
  const stats = segmentStats(segments);
  const sinceSeq = segments.length
    ? segments[segments.length - 1].summarySeq
    : (src.records.length > 150 ? src.records[src.records.length - 150].seq : -1);
  const signals = collectSignals(src.records, { sinceSeq });
  const repeat = repeatStats(signals);
  const macro = judgeMacroReset({
    cumulativeShadowedTokens: stats.tokens,
    windowTokens: typeof win === 'number' ? win : 0,
    compactionGainRatio: gainRatio(segments),
    repeatErrors: repeat.repeatErrors,
    repeatFiles: repeat.repeatFiles,
    used,
    bands,
    milestone: false,
    userRequest: false,
  });
  const adv = decide({ used, win, bands, cfg: env.cfg, lockState: lock, macro });
  const snaps = listSnapshots(meId);
  const lastSnapRatio = snaps.latestPath ? snapshotRatioOf(snaps.latestPath) : null;
  const drop = lastSnapRatio !== null && ratio !== null ? lastSnapRatio - ratio : null;
  const state = typeof env.sessionState === 'function' ? env.sessionState(exec) : null;
  const limit = typeof env.compactionLimit === 'function' ? env.compactionLimit() : (env.cfg.maxCompactionsPerSession || 4);
  const out = [];
  out.push('会话      ' + (meId || '未知'));
  out.push('水位      ' + pctText(ratio)
    + (typeof args.simulateRatio === 'number' ? '  （演练模拟值）' : '')
    + staleNoteFrom(meId, count.lastSummaryMs));
  out.push('压缩      ' + count.used + ' 次 · 换任计数 ' + Math.max(count.used, (state && state.compactions) || 0) + '/' + limit + (count.note ? '  ' + count.note : ''));
  out.push('锁        ' + lock);
  out.push('段索引    ' + (src.source === 'none' ? '未核' : stats.count + ' 段 · 累计遮蔽 ' + stats.tokens + ' token · 最近 ' + (stats.lastAt || '未核')));
  out.push('快照      ' + (snaps.count ? snaps.count + ' 份 · 最近 ' + snaps.latest : '未核'));
  out.push('最近压缩  ' + (count.lastSummaryMs ? stampTz(count.lastSummaryMs) : '未核'));
  out.push('压缩回落  ' + (drop === null ? '未核' : (drop >= 0 ? '回落 ' + (Math.round(drop * 1000) / 10) + ' 点' : '回升 ' + (Math.round(-drop * 1000) / 10) + ' 点')));
  out.push('分档      ' + (bands
    ? 'soft ' + kText(bands.soft) + ' · advise ' + kText(bands.advise) + ' · hard ' + kText(bands.hard) + ' · 宿主 ' + kText(bands.host)
    : '不判定（窗口读不到）'));
  if (state) {
    const soft = state.notified && state.notified.soft;
    const advise = state.notified && state.notified.advise;
    out.push('提示状态  soft=' + (soft ? '已提示' : '未提示') + ' · advise=' + (advise ? '已提示' : '未提示'));
    if (state.succession && state.succession.promptedAt) {
      out.push('换任提示  ' + stampTz(state.succession.promptedAt) + ' · 计数 ' + state.succession.promptedCount + '/' + limit);
    }
  }
  if (typeof env.storeInfo === 'function') {
    const si = env.storeInfo(exec);
    if (si) out.push('存储      ' + si.dir + (si.staged ? '（暂存目录）' : '（会话目录内）') + ' · 文件 ' + (si.files.length ? si.files.join('、') : '无'));
  }
  out.push('判据      强制线 ' + (bands ? kText(bands.hard) : '不判定') + (adv.action === 'force' ? '（命中）' : '（未命中）')
    + ' · 宏观重置 ' + (macro.hit ? '命中' : '0/4'));
  if (macro.hit) out.push('追加理由  ' + macro.reasons.join('；'));
  out.push('建议      ' + adv.action + ' —— ' + adv.reason);
  const c = consentLine(meId);
  if (c) out.push('授权      ' + c);
  return out;
}

const LEVEL_GLOSS = { low: '低于整理线', soft: '已过整理线', advise: '已过建议线', hard: '已过强制线' };
const LEVEL_ADVICE = {
  low: '低于整理线，暂不需要压缩。',
  soft: '已过整理线，可在阶段边界压缩。',
  advise: '已过建议线，建议尽快压缩。',
  hard: '已过强制线，插件将强制压缩。',
};

/** 压力遥测：水位、余量、增速、剩余轮数、分档线与档位；simulateRatio 只对 phase 生效。 */
function pressureText(env, args, exec) {
  const meId = env.selfId(exec);
  const self = readSelfPressure(env.cacheDir(), meId || '');
  const { used, win } = normWater(self);
  const state = typeof env.sessionState === 'function' ? env.sessionState(exec) : null;
  const history = state && Array.isArray(state.usageHistory) ? state.usageHistory : [];
  const p = pressureOf({ used, win, cfg: env.cfg, history });
  const out = [];
  out.push('会话      ' + (meId || '未知'));
  if (p.level === 'unknown') {
    out.push('水位      水位读不到');
    out.push('建议      先在该会话完成一轮对话后重试本视图。');
    return out;
  }
  out.push('水位      ' + p.used + '/' + p.win + '（' + pctText(p.ratio) + '）');
  out.push('余量      ' + p.headroom + ' token');
  out.push('增速      ' + (p.growth === null ? '未核（样本不足）' : (p.growth > 0 ? '+' : '') + p.growth + ' token/轮'));
  out.push('剩余轮数  ' + (p.remainingTurns === null ? '未核' : p.remainingTurns + ' 轮'));
  out.push('分档线    ' + (p.bands
    ? 'soft ' + p.bands.soft + ' · advise ' + p.bands.advise + ' · hard ' + p.bands.hard + ' · 宿主 ' + p.bands.host
    : '不判定（窗口读不到）'));
  out.push('当前档位  ' + p.level + '（' + LEVEL_GLOSS[p.level] + '）');
  out.push('建议      ' + LEVEL_ADVICE[p.level]);
  return out;
}

function briefText(env, args, exec) {
  const ws = env.resolveWs(exec);
  const gate = syncCheck(ws);
  const meId = env.selfId(exec);
  const self = readSelfPressure(env.cacheDir(), meId);
  const scan = scanSessions({
    dir: env.cacheDir(),
    meId,
    meCwd: env.selfCwd(exec),
    cfg: env.cfg,
    silentHours: env.cfg.sessionScanHours,
  });
  const drift = computeDrift({ ws, cacheDir: env.cacheDir(), slack: env.cfg.driftSlack, all: false });
  const bands = bandsFor(env.cfg, self.win);
  const adv = decide({ used: self.used, win: self.win, bands, cfg: env.cfg, lockState: 'unknown' });
  const selfPercent = self.used === null || self.win === null ? null : (self.used / self.win) * 100;
  const ok = gate.ok && (selfPercent === null || !bands || self.used < bands.advise);
  const lines = composeBrief({
    cfg: env.cfg,
    selfUsed: self.used,
    selfWin: self.win,
    gate,
    scan,
    drift,
    advice: { text: adv.action + ' —— ' + adv.reason },
    ok,
  });
  const c = consentLine(meId);
  if (c) lines.push('授权   ' + c);
  return lines;
}

function diagText(env, exec) {
  const out = [];
  const meId = env.selfId(exec);
  out.push('会话      ' + (meId || '?'));
  if (typeof env.version === 'function') out.push('版本      ' + env.version());
  if (typeof env.injectList === 'function') out.push('inject    ' + env.injectList().join(' / '));
  if (typeof env.initErrors === 'function') {
    const errs = env.initErrors();
    out.push('初始化    ' + (errs.length ? '有 ' + errs.length + ' 处失败：' + errs.join('；') : '无错误'));
  }
  if (typeof env.probeServices === 'function') {
    const svc = env.probeServices();
    out.push('服务      ' + Object.keys(svc).map((k) => k + '=' + (svc[k] ? '可用' : '—')).join('  '));
  }
  if (typeof env.guardLast === 'function') {
    const g = env.guardLast();
    out.push('通信判定  ' + (g
      ? (g.allow ? '放行' : '拦截') + ' · 依据 ' + g.source + (g.title ? ' · 标题 ' + g.title : '') + ' · 会话 ' + g.sid
      : '本进程还没有 peer（action="send"、"new"）调用'));
  }
  if (typeof env.probeAgentScope === 'function') {
    const a = env.probeAgentScope(exec);
    const show = ['compaction', 'compactNow', 'tokenMeter', 'sessions', 'llm', 'agents']
      .map((k) => k + '=' + (a[k] ? '可用' : '—')).join('  ');
    out.push('会话作用域 ' + (a.ctx ? show : '无法获取 exec.agent.ctx'));
  }
  const st = typeof env.compactionState === 'function'
    ? env.compactionState(exec)
    : (() => { const c = countCompactions(eventsOf(exec)); return { used: c.used, lock: c.lock, source: 'events' }; })();
  const src = eventSourceOf(meId, exec);
  out.push('压缩      ' + st.used + ' 次；锁 ' + st.lock + '；来源 ' + st.source + '；事件源 ' + src.source + '（' + src.records.length + ' 条）' + (st.note ? '  ' + st.note : ''));
  out.push('段索引    ' + (src.records.length ? segmentsOf(meId, src.records).length + ' 段' : '未核'));
  out.push('快照      ' + (listSnapshots(meId).count || '未核'));
  const anchorFile = meId ? anchorPathFor(meId) : '';
  const anchor = anchorFile ? readAnchor(meId) : { exists: false, text: null };
  const anchorTokens = anchor.exists ? estimateTokens(anchor.text) : 0;
  const anchorLimit = Number(env.cfg.anchorMaxTokens) || 1500;
  out.push('锚点      ' + (anchor.exists
    ? anchorTokens + ' token / 上限 ' + anchorLimit + (anchorTokens > anchorLimit ? '（超预算，内容未裁）' : '')
    : '未写'));
  const selfP = typeof env.selfPressure === 'function' ? env.selfPressure(meId) : null;
  const pct = selfP && selfP.used !== null && selfP.win ? (selfP.used / selfP.win) * 100 : null;
  out.push('水位      ' + (pct === null ? '读不到' : pct.toFixed(1) + '%') + staleNoteFrom(meId, st.lastSummaryMs));
  try {
    const state = typeof env.sessionState === 'function' ? env.sessionState(exec) : null;
    const limit = typeof env.compactionLimit === 'function' ? env.compactionLimit() : (env.cfg.maxCompactionsPerSession || 4);
    if (state) {
      out.push('提示      soft=' + (state.notified && state.notified.soft ? '已提示' : '未提示')
        + ' advise=' + (state.notified && state.notified.advise ? '已提示' : '未提示')
        + ' · 计数 ' + Math.max(st.used, state.compactions || 0) + '/' + limit
        + ' · 存储 ' + (typeof env.storeInfo === 'function' ? (env.storeInfo(exec) || {}).dir : '未核'));
    }
  } catch { /* 会话状态读不到不影响自检 */ }
  const ws = env.resolveWs(exec);
  let wsOk = false;
  try { wsOk = fs.existsSync(path.join(ws, '_Control_Center')); } catch { wsOk = false; }
  if (typeof env.roleOf === 'function') {
    try {
      const info = env.roleOf(exec);
      const ts = typeof env.toolsetOf === 'function' ? env.toolsetOf(info.role) : null;
      out.push('角色      ' + info.role + (info.project ? '（项目 ' + info.project + '）' : info.task ? '（任务 ' + info.task + '）' : '') + ' · 依据 ' + info.source + (ts ? ' · 可见工具 ' + ts.allow.length + '/' + (ts.allow.length + ts.deny.length) : ''));
      // 两轴不同时单独报一行：类别换了而布局未迁，文件仍在旧布局。
      if (info.layout && info.layout !== info.role) {
        out.push('布局      ' + info.layout + (info.layoutName ? '「' + info.layoutName + '」' : '') + '（与类别不同）'
          + (info.pending ? ' · 待确认迁移' : ''));
      } else if (info.pending) {
        out.push('布局      待确认迁移');
      }
      if (typeof env.roleState === 'function') {
        const rs = env.roleState();
        const cnt = typeof rs.count === 'number' ? ' · 已装配 ' + rs.count + ' 个会话' : '';
        out.push('角色装配  ' + (rs.mode || '未知') + cnt + (rs.last ? ' · 最近：' + rs.last.sid + ' → ' + rs.last.role + '（' + rs.last.at + '）' : ''));
      }
    } catch (e) {
      out.push('角色      判定失败：' + (e && e.message ? e.message : e));
    }
  }
  out.push('工作区    ' + ws + (wsOk
    ? '  已接入'
    : '  未接入：未找到 `_Control_Center`。处置：在设置页执行「首次安装」；或执行 `ho_workspace(action="init", parent="<目录>", register=true)`。'));
  try {
    const mv = typeof env.moveInfo === 'function' ? env.moveInfo() : null;
    if (mv) out.push('迁移      ' + mv.phase + ' · ' + mv.src + (mv.dst ? (mv.sameTarget ? '（目标与源一致）' : '  →  ' + mv.dst) : ''));
  } catch { /* ignore */ }
  const ratioPct = (v, dflt) => Math.round((Number(v) || dflt) * 100) + '%';
  out.push('配置      分档 ' + ratioPct(env.cfg.softRatio, 0.35) + '/' + ratioPct(env.cfg.adviseRatio, 0.50) + '/'
    + ratioPct(env.cfg.hardRatioCap, 0.65) + ' reserved=' + env.cfg.reservedOutput
    + ' maxCompactions=' + env.cfg.maxCompactionsPerSession + '/' + env.cfg.maxCompactionsHardCap
    + ' shadow=' + env.cfg.shadowTarget + ' roiFloor=' + env.cfg.roiFloor);
  if (typeof env.handoverFor === 'function') {
    try {
      const hp = env.handoverFor(exec);
      out.push('交接路径  ' + (hp && hp.path ? hp.path + '（' + hp.kind + '）' : '无，' + ((hp && hp.reason) || '角色未定')));
    } catch (e) {
      out.push('交接路径  解析失败：' + (e && e.message ? e.message : e));
    }
  } else {
    out.push('交接路径  ' + (env.cfg.handoverPath || '（按角色解析）'));
  }
  return out;
}

function driftText(env, args, exec) {
  const ws = env.resolveWs(exec);
  const res = computeDrift({
    ws,
    cacheDir: env.cacheDir(),
    slack: typeof args.slack === 'number' ? args.slack : env.cfg.driftSlack,
    all: args.all === true,
  });
  const out = [];
  out.push('交接匹配检查（以交接为准；容忍 ' + res.slack + ' 轮）  工作区根 ' + ws);
  out.push('  项目  会话类型 会话  当前轮  交接轮  Δ  判定');
  for (const r of res.rows) {
    const cells = [r.project, r.kind, r.sid.slice(-8), String(r.turns), r.handoverTurn === null ? '?' : String(r.handoverTurn), r.delta === null ? '?' : String(r.delta), r.verdict];
    out.push('  ' + cells.join('  '));
  }
  if (!res.rows.length) out.push('  读不到任何项目会话（Projects/ 下对应库不存在时属正常）');
  out.push(driftVerdict(res));
  return out;
}

function tokensText(env, args, exec) {
  const out = [];
  const list = Array.isArray(args.sessions) ? args.sessions.filter((s) => typeof s === 'string' && s.trim() !== '') : [];
  if (!list.length) throw new Error('现象：`view=tokens` 的 `sessions` 为空。原因：token 体检须给出会话 id。处置：传入会话 id 数组后重试。');
  // 跨会话体检与 recall 同一权限口径：只有全局会话能看别人的活动元数据。
  const normSid = (s) => (String(s || '').indexOf('session-') === 0 ? String(s) : 'session-' + String(s || '').trim());
  const meId = env.selfId(exec) || '';
  const foreign = list.filter((s) => normSid(s) !== normSid(meId));
  if (foreign.length) {
    let info = null;
    try { info = env.roleOf(exec); } catch { info = null; }
    if (!info || info.role !== 'global') {
      throw new Error('现象：`view=tokens` 的会话不在本会话范围。原因：跨会话体检仅对全局会话开放。处置：只传本会话 id，或改由全局会话执行。');
    }
  }
  out.push('会话 轮 步 输出tok 每步tok 最贵返回 超20步轮 判定');
  for (const sid of list) {
    const full = sid.indexOf('session-') === 0 ? sid : 'session-' + sid;
    const log = findLog(full);
    if (!log) { out.push(sid + '  ERR 日志不存在'); continue; }
    const recs = decodeLog(log);
    if (!recs) { out.push(sid + '  ERR 日志无法解码'); continue; }
    const m = analyzeLog(recs);
    const verdict = m.perStep > 2000 ? '偏贵（每步 >2k）' : m.heavyTurns > 0 ? '有超 20 步的轮' : '正常';
    out.push([sid.slice(-8), m.turns, m.steps, m.outTok, m.perStep, Math.round(m.maxResult / 1024) + 'KB', m.heavyTurns, verdict].join('  '));
  }
  return out;
}

const AROUND_CLIP = 1200;
const EXCERPT_CLIP = 2000;

function clipOne(text) {
  const s = String(text === null || text === undefined ? '' : text);
  return s.length > 220 ? s.slice(0, 219) + '…' : s;
}

function clipBody(text, limit) {
  const s = String(text === null || text === undefined ? '' : text);
  if (!s) return '';
  return s.length <= limit ? s : s.slice(0, limit) + NL + '（已截断，可用 around 展开）';
}

function excerptBlock(excerpt) {
  const lines = excerpt && Array.isArray(excerpt.lines) ? excerpt.lines : [];
  const body = lines.map((l) => '  ' + String(l.no).padStart(5) + ' | ' + clipOne(l.text)).join(NL);
  if (body.length <= EXCERPT_CLIP) return body;
  return body.slice(0, EXCERPT_CLIP) + NL + '（摘录已截断，可用 around 展开）';
}

/** 召回视图：按关键词检索，或按 seq 展开前后各 3 条。 */
function recallText(env, args, exec) {
  const a = args || {};
  const meId = env.selfId(exec);
  if (!meId) return { text: '现象：未取得本会话 id。原因：宿主未提供会话标识。处置：重启 DSH 后重试。' };
  const want = String(a.session_id || '').trim();
  const sid = want || meId;
  const normSid = (s) => (String(s || '').indexOf('session-') === 0 ? String(s) : 'session-' + String(s || '').trim());
  if (want && normSid(want) !== normSid(meId)) {
    let info = null;
    try { info = env.roleOf(exec); } catch { info = null; }
    if (!info || info.role !== 'global') {
      return { text: '现象：当前会话无权检索其他会话。原因：跨会话检索仅对全局会话开放。处置：本次只查本会话 ' + meId + '；如需跨会话检索，由全局会话执行。' };
    }
  }
  const src = eventSourceOf(sid, want ? null : exec);
  if (!src.records.length) {
    return { text: ['现象：读不到会话日志：`' + sid + '`。原因：该会话没有可读取的日志文件。', '处置：只用当前内存事件，或改查本会话；事件来源见 `ho_status(view="diag")` 的「压缩」一行。'].join(NL) };
  }
  const aroundRaw = a.around;
  const hasAround = aroundRaw !== undefined && aroundRaw !== null && aroundRaw !== '';
  const query = String(a.query || '').trim();
  if (hasAround) {
    if (query) throw new Error('现象：`query` 与 `around` 同时给出。原因：二者互斥，`around` 只按事件序号展开。处置：二选一后重试。');
    const seq = Number(aroundRaw);
    if (!Number.isInteger(seq)) throw new Error('现象：`around` 不是整数事件序号。原因：收到 `' + String(aroundRaw) + '`。处置：传入命中条目给出的 `seq` 后重试。');
    const r = aroundEvents(src.records, seq, 3);
    if (!r.found) {
      return { text: '现象：会话日志中没有 seq=' + seq + ' 的事件。原因：序号来自其他会话或已超出日志范围。处置：先用 `query` 检索取得有效 `seq`，再用 `around` 展开。' };
    }
    const out = [];
    out.push('邻近事件  ' + sid + ' · 中心 seq ' + seq + ' · ' + r.events.length + ' 条 · 来源 ' + src.source);
    for (const e of r.events) {
      const at = typeof e.time === 'number' ? ' · ' + stampTz(e.time) : '';
      out.push('');
      out.push((e.center ? '▶ ' : '  ') + 'seq ' + e.seq + ' · ' + (e.type || '未知')
        + (e.tool ? ' · ' + e.tool : '') + (e.isError ? ' · 失败' : '') + at);
      const body = clipBody(e.text, AROUND_CLIP);
      if (body) out.push('  ' + body.split(NL).join(NL + '  '));
    }
    return { text: out.join(NL) };
  }
  const mode = a.mode || 'auto';
  const order = a.order === 'relevance' ? 'relevance' : 'time';
  const limit = typeof a.limit === 'number' && a.limit > 0 ? Math.min(a.limit, 50) : env.cfg.recallLimit;
  if (!query && mode !== 'structural') {
    return { text: '现象：`query` 为空。原因：字面与分词检索须有关键词。处置：传入 `query`；`mode=structural` 时可用 `filter` 代替。' };
  }
  let res = null;
  try {
    res = search(src.records, { query, mode, filter: a.filter, limit, order, session_id: sid });
  } catch (e) {
    return { text: '现象：检索失败。原因：' + (e && e.message ? e.message : e) + '。处置：改用 `mode=literal`，或缩短关键词后重试。' };
  }
  const offsetRaw = a.offset;
  const offset = offsetRaw === undefined || offsetRaw === null || offsetRaw === '' || !Number.isInteger(Number(offsetRaw))
    ? null : Number(offsetRaw);
  const allGroups = Array.isArray(res.groups) ? res.groups : res.hits;
  const filtered = offset === null ? allGroups : allGroups.filter((h) => h.firstSeq >= offset);
  const hits = filtered.slice(0, limit);
  const out = [];
  out.push('检索  ' + sid + ' · 全量命中 ' + res.matched + ' 条 · 合并 ' + res.groups.length + ' 组 · 返回 ' + hits.length + ' 组'
    + ' · 模式 ' + res.route + ' · 顺序 ' + res.order
    + (offset === null ? '' : '（起始 seq ' + offset + '）')
    + ' · 事件 ' + src.records.length + ' · 段 ' + res.segments.length + ' · 来源 ' + src.source);
  if (!hits.length) {
    out.push('');
    if (res.matched > 0 && offset !== null) {
      out.push('没有命中。起始 seq ' + offset + ' 之后没有可返回的组。处置：减小 `offset` 后重试。');
      return { text: out.join(NL) };
    }
    out.push('没有命中。');
    if (res.rejected) out.push('模式被拒。原因：' + res.rejected + '。');
    if (res.suggestion) {
      out.push('候选段：');
      if (!res.suggestion.segments.length) out.push('  - 日志里还没有压缩段，可按类型过滤，例如 `type:tool/result, error:true`。');
      for (const s of res.suggestion.segments) out.push('  - 第 ' + s.index + ' 段「' + s.label + '」· seq ' + s.range);
      out.push('建议关键词：' + (res.suggestion.keywords.length ? res.suggestion.keywords.join('、') : '（数量不足，改用 `mode=structural`）'));
      if (res.suggestion.hint) out.push('提示：' + res.suggestion.hint);
    }
    out.push('用法：`ho_status(view="recall", query="关键词", mode="bm25")`；结构过滤示例 `type:tool/result, error:true`。');
    return { text: out.join(NL) };
  }
  hits.forEach((h, i) => {
    const seg = h.segment ? ' · 段' + h.segment.index + '「' + h.segment.label + '」' : ' · 段外';
    const at = typeof h.at === 'number' ? ' · ' + stampTz(h.at) : '';
    const range = h.firstSeq === h.lastSeq ? String(h.seq) : h.firstSeq + '–' + h.lastSeq;
    out.push('');
    out.push((i + 1) + '. seq ' + h.seq + ' · seq 范围 ' + range + ' · 出现 ' + h.count + ' 次'
      + ' · ' + h.type + (h.tool ? ' · ' + h.tool : '')
      + (h.isError ? ' · 失败' : '') + ' · 分数 ' + h.score + seg + at);
    if (h.count > 1) {
      const shown = h.seqs.slice(0, 20).join('、');
      const more = h.seqs.length > 20 ? ' 等 ' + h.seqs.length + ' 个' : '';
      out.push('   同组 seq：' + shown + more + ' · around=<seq> 可展开');
    }
    const block = excerptBlock(h.excerpt);
    if (block) out.push(block);
  });
  if (filtered.length > hits.length) {
    out.push('');
    out.push('合并组已截断：共 ' + filtered.length + ' 组，本次返回 ' + hits.length + ' 组。处置：改窄查询、加 `filter`，或提高 `limit`（上限 50）。');
    const last = hits[hits.length - 1];
    if (order === 'time' && last) out.push('分页：offset=' + (last.lastSeq + 1) + ' 可继续按时间顺序读取。');
  }
  out.push('');
  out.push('指针：命中条目的 seq 可用 `ho_status(view="recall", around=<seq>)` 展开前后各 3 条。');
  return { text: out.join(NL) };
}

/**
 * 构造 `status` 工具定义。
 *
 * 8 个视图共用一个只读入口，避免工具数量随诊断项增长。
 *
 * @param {object} env 插件环境，提供水位、压缩状态与角色解析。
 * @returns {object} 工具定义，供宿主注册。
 * 副作用：无；只读缓存与日志。
 */
export function pmStatusTool(env) {
  const gate = pmGateTool(env);
  return {
    name: nameOf('status'),
    description: '会话状态与原文召回，只读。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        view: { type: 'string', enum: VIEWS, description: '视图，缺省 phase。' },
        simulateRatio: { type: 'number', description: '`phase` 演练用的水位比例，取 0 至 1。例：`0.82`。' },
        sessions: { type: 'array', items: { type: 'string' }, description: '`tokens` 要体检的会话 id 数组。例：`["session-3f2a"]`。' },
        slack: { type: 'number', description: '`drift` 容许的轮数差，缺省取配置值。例：`3`。' },
        all: { type: 'boolean', description: '`drift` 为 `true` 时连沉默会话一并比对。' },
        scope: { type: 'string', enum: ['all', 'global', 'project'], description: '`gate` 视图的检查范围，缺省 `all`。例：`project`。' },
        project: { type: 'string', description: '`gate` 在 `scope=project` 时的项目名。例：`Demo`。' },
        query: { type: 'string', description: 'recall 的关键词或正则。语法：竖线表示或，-词 排除，+词 必含，引号内为短语；解析失败按普通关键词处理。' },
        mode: { type: 'string', enum: MODES, description: 'recall 的检索模式，缺省 auto。' },
        filter: { type: 'string', description: 'recall 的结构过滤，例 type:tool/result, error:true。' },
        limit: { type: 'number', description: 'recall 返回的合并组数，默认 8，上限 50。' },
        order: { type: 'string', enum: ['time', 'relevance'], description: 'recall 的组排序，缺省 time；relevance 按组内最高分降序。' },
        session_id: { type: 'string', description: 'recall 的目标会话，缺省本会话；跨会话仅全局可用。' },
        around: { type: 'integer', description: 'recall 时按 seq 展开前后各 3 条；与 query 互斥。' },
        offset: { type: 'integer', description: 'recall 的起始事件序号，可选。' },
      },
    },
    output: textOutput(),
    async execute(args, exec) {
      const view = typeof args.view === 'string' && args.view ? args.view : 'phase';
      if (VIEWS.indexOf(view) === -1) throw new Error('现象：`view` 取值不在允许范围。原因：收到 `' + String(view) + '`，只接受 ' + VIEWS.join('、') + '。处置：改用上述取值之一后重试。');
      if (view === 'gate') {
        const g = await gate.execute(args, exec);
        return { text: capText(g && g.text !== undefined ? g.text : String(g || ''), { maxLines: STATUS_MAX_LINES, hint: '闸门输出过长：先用 `scope=project` 查单个项目，或按库逐个复核。' }) };
      }
      if (view === 'recall') {
        const r = recallText(env, args, exec);
        return { text: capText(r && r.text !== undefined ? r.text : String(r || ''), { maxLines: STATUS_MAX_LINES, hint: '召回输出过长：用 `offset=<seq>` 或 `around=<seq>` 继续读取，或缩小 `limit`。' }) };
      }
      const out = view === 'phase' ? phaseText(env, args, exec)
        : view === 'pressure' ? pressureText(env, args, exec)
          : view === 'brief' ? briefText(env, args, exec)
            : view === 'diag' ? diagText(env, exec)
              : view === 'drift' ? driftText(env, args, exec)
                : tokensText(env, args, exec);
      return { text: capText(out.join(NL), { maxLines: STATUS_MAX_LINES, hint: '状态过长：先用 `view=phase` 查看摘要，需要细节再按 `view` 取值。' }) };
    },
  };
}
