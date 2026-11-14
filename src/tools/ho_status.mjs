/**
 * ho_status —— 会话状态：一个入口，按 view 分流。
 *   phase（默认）：水位、压缩次数、锁、建议动作
 *   brief：水位、闸门、会话清点、交接漂移、阶段建议
 *   diag：服务可解析性、调度器、初始化错误、角色与工具集
 *   drift：交接漂移体检
 *   tokens：按会话 id 统计轮数、步数、每步 token
 * 全部只读；原 ho_phase、ho_brief、ho_diag、ho_drift、ho_tokens 合并于此。
 */
import fs from 'node:fs';
import path from 'node:path';
import { textOutput } from '../lib/output.mjs';
import { nameOf } from '../lib/names.mjs';
import { NL, pick } from '../lib/text.mjs';
import { syncCheck } from '../lib/gates.mjs';
import { scanSessions, readSelfPressure } from '../lib/sessions.mjs';
import { composeBrief } from '../lib/brief.mjs';
import { decide } from '../lib/phase.mjs';
import { computeDrift, driftVerdict } from '../lib/drift.mjs';
import { watermark } from '../lib/facts.mjs';
import { eventsOf, countCompactions } from '../lib/events.mjs';
import { findLog, decodeLog, turnStarts } from '../lib/zstd-log.mjs';
import { activeConsentsFor, formatConsentLine } from '../lib/consent.mjs';
import { readReminderState } from '../lib/reminder.mjs';

export const VIEWS = ['phase', 'brief', 'diag', 'drift', 'tokens'];

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

function phaseText(env, args, exec) {
  const meId = env.selfId(exec);
  const real = env.selfPct(meId);
  const ratio = typeof args.simulateRatio === 'number' ? args.simulateRatio : (real === null ? null : real / 100);
  const count = env.compactionCount(exec);
  const lock = env.lockState(exec);
  const adv = decide({ ratio, compactionsUsed: count.used, cfg: env.cfg, lockState: lock });
  const out = [];
  out.push('会话      ' + (meId || '未知'));
  out.push('水位      ' + (ratio === null ? '读不到' : (Math.round(ratio * 1000) / 10).toFixed(1) + '%')
    + (typeof args.simulateRatio === 'number' ? '  （演练模拟值）' : '')
    + (typeof env.staleNote === 'function' ? env.staleNote(exec) : ''));
  out.push('压缩      ' + count.used + '/' + env.cfg.maxCompactions + ' 次' + (count.note ? '  ' + count.note : ''));
  out.push('锁        ' + lock);
  out.push('建议      ' + adv.action + ' —— ' + adv.reason);
  const c = consentLine(meId);
  if (c) out.push('授权      ' + c);
  return out;
}

function briefText(env, args, exec) {
  const ws = env.resolveWs(exec);
  const w = watermark(env.cfg);
  const warn = typeof args.threshold === 'number' ? args.threshold : w.remindValue;
  const gate = syncCheck(ws);
  const meId = env.selfId(exec);
  const self = readSelfPressure(env.cacheDir(), meId);
  const scan = scanSessions({
    dir: env.cacheDir(),
    meId,
    meCwd: env.selfCwd(exec),
    warn,
    silentHours: env.cfg.sessionScanHours,
  });
  const drift = computeDrift({ ws, cacheDir: env.cacheDir(), slack: env.cfg.driftSlack, all: false });
  const ratio = self.used === null || self.win === null ? null : self.used / self.win;
  const adv = decide({ ratio, compactionsUsed: 0, cfg: env.cfg, lockState: 'unknown' });
  const selfPct = self.used === null || self.win === null ? null : (self.used / self.win) * 100;
  const ok = gate.ok && (selfPct === null || selfPct < warn);
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

function diagText(env, state, exec) {
  const out = [];
  const meId = env.selfId(exec);
  out.push('会话      ' + (meId || '?'));
  if (typeof env.version === 'function') out.push('版本      ' + env.version());
  out.push('调度器    ' + (state.schedulerReady() ? '就绪' : '未就绪' + (state.schedulerError() ? '：' + state.schedulerError() : '（稍后重试或重启）')));
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
  out.push('压缩      ' + st.used + '/' + env.cfg.maxCompactions + ' 次；锁 ' + st.lock + '；来源 ' + st.source);
  const pct = env.selfPct(meId);
  out.push('水位      ' + (pct === null ? '读不到' : pct.toFixed(1) + '%') + (typeof env.staleNote === 'function' ? env.staleNote(exec) : ''));
  try {
    const rec = readReminderState().sessions[String(meId || '')] || {};
    out.push('提醒      35%=' + (rec.r35 ? '已提醒' : '未提醒') + '  50%=' + (rec.r50 ? '已提醒' : '未提醒'));
  } catch { /* 提醒状态读不到不影响自检 */ }
  const ws = env.resolveWs(exec);
  let wsOk = false;
  try { wsOk = fs.existsSync(path.join(ws, '_Control_Center')); } catch { wsOk = false; }
  if (typeof env.roleOf === 'function') {
    try {
      const info = env.roleOf(exec);
      const ts = typeof env.toolsetOf === 'function' ? env.toolsetOf(info.role) : null;
      out.push('角色      ' + info.role + (info.project ? '（项目 ' + info.project + '）' : info.task ? '（任务 ' + info.task + '）' : '') + ' · 依据 ' + info.source + (ts ? ' · 可见工具 ' + ts.allow.length + '/' + (ts.allow.length + ts.deny.length) : ''));
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
    : '  未接入（未找到 _Control_Center）：请当前用户在设置页执行「首次安装」，或由本会话直接 ho_workspace(action="init", parent="<目录>", register=true)'));
  try {
    const mv = typeof env.moveInfo === 'function' ? env.moveInfo() : null;
    if (mv) out.push('迁移      ' + mv.phase + ' · ' + mv.src + (mv.dst ? '  →  ' + mv.dst : ''));
  } catch { /* ignore */ }
  out.push('配置      remind=' + env.cfg.remindRatio + '·' + env.cfg.remind2Ratio + ' handover=' + env.cfg.handoverRatio + ' pureWindow=' + env.cfg.pureWindowRatio + ' hard=' + env.cfg.hardRatio + ' max=' + env.cfg.maxCompactions);
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

function tokensText(args) {
  const out = [];
  const list = Array.isArray(args.sessions) ? args.sessions.filter((s) => typeof s === 'string' && s.trim() !== '') : [];
  if (!list.length) throw new Error('view=tokens 时 sessions 不能为空（给会话 id 数组）');
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

export function pmStatusTool(env, state) {
  const w = watermark(env.cfg);
  return {
    name: nameOf('status'),
    description:
      '会话状态（只读）：view=phase 水位与建议（缺省）、brief 起始简报、diag 插件自检、drift 交接漂移、tokens token 体检。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        view: { type: 'string', enum: VIEWS, description: '缺省 phase' },
        threshold: { type: 'number', description: 'view=brief：预警阈值百分比（默认 ' + w.remindValue + '）' },
        simulateRatio: { type: 'number', description: 'view=phase：演练用比例替代真实水位（0-1），不写任何状态' },
        sessions: { type: 'array', items: { type: 'string' }, description: 'view=tokens：会话 id 列表' },
        slack: { type: 'number', description: 'view=drift：容忍轮数（默认 3）' },
        all: { type: 'boolean', description: 'view=drift：列全部会话，而不只是每个项目的在任会话' },
      },
    },
    output: textOutput(),
    async execute(args, exec) {
      const view = typeof args.view === 'string' && args.view ? args.view : 'phase';
      if (VIEWS.indexOf(view) === -1) throw new Error('view 只能是 ' + VIEWS.join(' | ') + '（收到 ' + String(view) + '）');
      if (view === 'phase') return { text: phaseText(env, args, exec).join(NL) };
      if (view === 'brief') return { text: briefText(env, args, exec).join(NL) };
      if (view === 'diag') return { text: diagText(env, state, exec).join(NL) };
      if (view === 'drift') return { text: driftText(env, args, exec).join(NL) };
      return { text: tokensText(args).join(NL) };
    },
  };
}
