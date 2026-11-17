/**
 * 压缩主链：轮首注入压力行、到线注入提示、强制线强制压缩。
 * 整理线与建议线只注入提示，绝不调用压缩 API；只有强制线由插件兜底压缩。
 * 全部注入都在本会话的步骤边界生成，作为末尾消息追加；不改 system 头，不逐步注入。
 *
 * 依赖通过 runtime 注入，共享状态集中在 index.mjs 的 runtime 对象，
 * 含 inline、scheduler、roleCache、cfg 等。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { projCacheDir, readSelfPressure } from './sessions.mjs';
import { appendRunLog } from './runlog.mjs';
import { createSkipLogger } from './skip-log.mjs';
import { compactInTurn, INLINE_UNAVAILABLE, INLINE_NO_METER } from './engine.mjs';
import { compactionStateOf } from './events.mjs';
import { judgeTrigger } from './triggers.mjs';
import { pressureLineText, tierPromptText, hardPromptText, successionPromptText, successionBlockText, successionCeilingText, roiAdviceText } from './inject.mjs';
import { pressureOf, roiOf, lowRoiStreakOf, normWater } from './pressure.mjs';
import { renderCapsule } from './capsule.mjs';
import { probeConstraints } from './constraints.mjs';
import { writeSnapshot } from './checkpoint.mjs';
import { judgeAssistantCompact } from './compact-gate.mjs';
import { signalOf } from './abort.mjs';
import { readSessionState } from './store.mjs';
import { sendPrompt } from './prompt.mjs';

/** 创建压缩主链。runtime 注入共享状态与依赖。 */
export function createInlineEngine(runtime) {
  const {
    ctx, cfg, env, inline, scheduler, roleCache,
    readState, saveState, infoFor, scopedMetaOf, isChildSession,
    anchorOps,
  } = runtime;
  const { autoSnapshotFor, writeAnchorFor, surfaceTextsOf } = anchorOps;
  const msgOf = (e) => String(e && e.message ? e.message : e);

  function inlineCooldownLeft(sessionId, ms) {
    if (!ms || ms <= 0) return 0;
    const at = inline.lastAt.get(sessionId);
    return at ? Math.max(0, ms - (Date.now() - at)) : 0;
  }

  function noteInline(msg) {
    try { appendRunLog(msg); } catch { /* ignore */ }
    env.log('dsh-handover: ' + msg);
  }

  function pctText(ratio) {
    return ratio === null || ratio === undefined ? '?' : (Math.round(ratio * 1000) / 10) + '%';
  }

  /**
   * 末尾上下文消息：用户角色、自有 source.kind。
   * 宿主对 system/message 的校验要求 source.kind 为 system-prompt，且系统提示投影会把任何
   * 尾部 system 节点当作最新提示词重新渲染；因此按宿主自带的 runtime-context 同一路径注入，
   * 既不改 system 头，也不破坏前缀缓存。
   */
  function contextMessage(text, kind) {
    const body = String(text || '');
    return {
      id: typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random().toString(16).slice(2),
      role: 'user',
      content: [{ type: 'text', text: body }],
      source: { kind: 'dsh-handover', form: 'snapshot', sections: [{ name: 'dsh-handover:' + String(kind || 'note'), text: body }] },
    };
  }

  /** 表面未闭合工具调用数：工具调用块数减工具结果数。 */
  function openToolCalls(session) {
    try {
      const nodes = session && session.surface ? session.surface.nodes || [] : [];
      let pending = 0;
      for (const seq of nodes) {
        const event = session.eventAt(seq);
        if (!event) continue;
        if (event.type === 'assistant/message') {
          const content = event.data && event.data.message ? event.data.message.content : null;
          if (!Array.isArray(content)) continue;
          for (const block of content) if (block && block.type === 'tool-call') pending += 1;
        } else if (event.type === 'tool/result') {
          pending -= 1;
        }
      }
      return pending;
    } catch { return 0; }
  }

  /** 轮内压缩失败或引擎不可用时保留可见告知；例行成功不投任何消息。 */
  function notifyInlineStop(sessionId, err) {
    const text = [
      '【dsh-handover】现象：轮内压缩未执行。原因：' + msgOf(err) + '。',
      '交接与快照已落盘，历史未被压缩。处置：将本条消息原样告知当前用户；不要改用轮后压缩冒充完成。',
    ].join(String.fromCharCode(10));
    try { sendPrompt(env.controller(), sessionId, text, 'queue').catch(() => {}); } catch { /* ignore */ }
  }

  /**
   * 自触发早退留痕：同一会话同一原因 5 分钟内只写一条，避免每步刷屏。
   * 触发未介入时，日志必须能回答「为什么没介入」。
   */
  const noteTriggerSkip = createSkipLogger({ write: appendRunLog, pct: pctText });

  /** 压缩成功后的统一收尾：计数、收益、日志、胶囊与换任提示。 */
  function afterCompact(sid, by, r, extra) {
    const e = extra || {};
    const st = readState(sid) || readSessionState(sid);
    const logState = compactionStateOf(sid, null) || {};
    const beforeCount = Math.max(Number(logState.used) || 0, Number(st.compactions) || 0);
    st.compactions = beforeCount + 1;
    st.notified = {};
    st.skipTierOnce = true;
    st.lastCompactAt = Date.now();
    const tokensBefore = r && typeof r.tokensBefore === 'number' ? r.tokensBefore : null;
    const tokensAfter = r && typeof r.tokensAfter === 'number' ? r.tokensAfter : null;
    const roi = roiOf(tokensBefore, tokensAfter);
    st.tokensBefore = tokensBefore;
    st.tokensAfter = tokensAfter;
    st.roi = roi;
    if (roi !== null) {
      st.roiHistory = (Array.isArray(st.roiHistory) ? st.roiHistory : []).concat([roi]).slice(-3);
    }
    const floor = Number(cfg.roiFloor) || 0.30;
    st.lowRoiStreak = lowRoiStreakOf(st.roiHistory, floor);
    const shadowed = r && r.result && r.result.shadowedTokenCount !== undefined
      ? r.result.shadowedTokenCount
      : (r && r.range && typeof r.range.shadowTokens === 'number' ? r.range.shadowTokens : null);
    noteInline('inline compacted ' + sid + ' by=' + by
      + ' seqs=' + (r && r.range ? r.range.start + '-' + r.range.end : '?')
      + ' shadowed=' + (shadowed === null ? '?' : shadowed)
      + ' tokensBefore=' + (tokensBefore === null ? '?' : tokensBefore)
      + ' tokensAfter=' + (tokensAfter === null ? '?' : tokensAfter)
      + ' roi=' + (roi === null ? '?' : roi.toFixed(3)));
    const max = Number(cfg.maxCompactionsPerSession) || 4;
    noteInline('换任计数 ' + st.compactions + '/' + max);
    const anchor = e.anchor || null;
    const capsuleBody = typeof e.capsuleBody === 'string' ? e.capsuleBody.trim() : '';
    const capsuleSource = e.source === 'assistant' && capsuleBody ? 'assistant' : 'mechanism';
    let missing = [];
    if (capsuleSource === 'mechanism' && anchor && Array.isArray(anchor.constraints)
      && anchor.constraints.length && e.session) {
      const probe = probeConstraints(surfaceTextsOf(e.session), anchor.constraints.map((text) => ({ text })));
      missing = probe.missing;
    }
    st.pendingMessages = Array.isArray(st.pendingMessages) ? st.pendingMessages : [];
    const capsuleText = renderCapsule({
      source: capsuleSource,
      body: capsuleSource === 'assistant' ? capsuleBody : '',
      anchor,
      anchorPath: e.anchorPath || '',
      before: tokensBefore,
      after: tokensAfter,
      shadow: shadowed,
      count: st.compactions,
      max,
      missing,
      cfg,
    });
    const capsuleChars = capsuleText.length;
    const capsuleLimit = Number(cfg.capsuleMaxChars) || 1600;
    const capsuleOver = capsuleChars > capsuleLimit;
    if (capsuleOver) {
      noteInline('capsule over budget ' + sid + ' chars=' + capsuleChars + ' limit=' + capsuleLimit);
    }
    st.pendingMessages.push({ kind: 'post-compact', text: capsuleText });
    if (roi !== null && st.lowRoiStreak >= 2) {
      st.pendingMessages.push({ kind: 'succession-advice', text: roiAdviceText(roi, floor, st.lowRoiStreak) });
      noteInline('低收益换任建议 ' + sid + ' streak=' + st.lowRoiStreak);
    }
    const prompted = Number(st.succession && st.succession.promptedCount) || 0;
    if (st.compactions >= max && prompted < st.compactions) {
      st.succession = { promptedCount: st.compactions, promptedAt: Date.now() };
      st.pendingMessages.push({ kind: 'succession', text: successionPromptText(st.compactions, max, cfg) });
      noteInline('换任提示 ' + sid + ' 计数 ' + st.compactions + '/' + max);
    }
    saveState(sid, st);
    return { st, capsuleChars, capsuleOver, capsuleSource, capsuleBodyChars: capsuleBody.length };
  }

  /** 强制压缩：先写锚点，再压缩；锚点失败只留痕，不阻断压缩。 */
  async function forceCompact(agent, sid, signal) {
    const snap = autoSnapshotFor(sid);
    if (snap) snap.snapshotPath = writeSnapshot(snap).path;
    const anchor = writeAnchorFor(sid, agent.session, '');
    inline.inflight.add(sid);
    const started = Date.now();
    try {
      const r = await compactInTurn(ctx, agent, cfg, signal, { shadowTarget: cfg.shadowTarget });
      if (r && r.status === 'ok') {
        afterCompact(sid, 'force', r, { session: agent.session, anchor: anchor.sections, anchorPath: anchor.path, source: 'mechanism' });
        return r;
      }
      noteInline('inline compact skipped ' + sid + ' reason=' + (r && r.reason ? r.reason : (r && r.status ? r.status : 'unknown')));
      return null;
    } catch (e) {
      const code = e && e.code ? e.code : '';
      const detail = msgOf(e);
      if (code === INLINE_UNAVAILABLE || code === INLINE_NO_METER) {
        inline.disabled = true;
        inline.lastError = detail;
        noteInline('inline compact unavailable ' + sid + ': ' + detail);
        notifyInlineStop(sid, e);
      } else {
        noteInline('inline compact failed ' + sid + ' after ' + (Date.now() - started) + 'ms: ' + detail);
        const aborted = signal && signal.aborted;
        const transient = /busy|already in progress|surface changed|aborted|abort/i.test(detail);
        if (!aborted && !transient) notifyInlineStop(sid, e);
      }
      return null;
    } finally {
      inline.lastAt.set(sid, Date.now());
      inline.inflight.delete(sid);
    }
  }

  /**
   * 单个会话的步骤边界判定：轮次起点只注入水位行；到线判定与强制压缩只在轮内步骤分隔时做。
   * 待注入消息可在任意步骤取走。返回要追加到本步骤末尾的上下文消息。
   */
  async function autoTriggerFor(agent, payload) {
    const out = [];
    const h = agent && agent.session ? agent.session.header : null;
    const sid = String((h && h.id) || (agent && agent.id) || '');
    if (inline.disabled) {
      noteTriggerSkip(sid, 'inline-disabled', null);
      return out;
    }
    if (!sid) {
      noteTriggerSkip(sid, 'no-sid', null);
      return out;
    }
    if (isChildSession(agent)) {
      noteTriggerSkip(sid, 'subagent', null);
      return out;
    }
    let info = null;
    const hit = roleCache.get(sid);
    if (hit && Date.now() - hit.at < 2000) info = hit.info;
    else {
      try { info = infoFor(sid, scopedMetaOf(h, sid)); } catch { info = null; }
      if (info) roleCache.set(sid, { at: Date.now(), info });
    }
    if (!info || !info.role) {
      noteTriggerSkip(sid, 'no-role', null);
      return out;
    }
    if (info.role === 'plain') {
      noteTriggerSkip(sid, 'plain', null);
      return out;
    }
    if (inline.inflight.has(sid)) {
      noteTriggerSkip(sid, 'inline-inflight', null);
      return out;
    }
    if (scheduler && scheduler.pending && typeof scheduler.pending.has === 'function' && scheduler.pending.has(sid)) {
      noteTriggerSkip(sid, 'scheduler-pending', null);
      return out;
    }
    const stepNum = Number(payload && payload.step);
    const atTurnStart = !Number.isFinite(stepNum) || stepNum <= 1;
    const signal = payload ? payload.signal : undefined;
    const st = readState(sid);
    if (!st) return out;

    // 待注入消息：压缩后的胶囊、低收益建议与换任提示；由压缩入口写入，下一处步骤边界取走。
    if (Array.isArray(st.pendingMessages) && st.pendingMessages.length) {
      for (const m of st.pendingMessages) out.push(contextMessage(m.text, m.kind));
      st.pendingMessages = [];
      saveState(sid, st);
    }

    if (atTurnStart) {
      // 轮次起点：只注入水位行并记历史，不做到线判定、不压缩。
      const self = readSelfPressure(projCacheDir(), sid);
      const { used, win } = normWater(self);
      if (used === null || win === null) {
        out.push(contextMessage(pressureLineText(pressureOf({ used: null, win: null, cfg })), 'water'));
        noteTriggerSkip(sid, 'no-pressure', null);
        saveState(sid, st);
        return out;
      }
      st.usageHistory = (Array.isArray(st.usageHistory) ? st.usageHistory : [])
        .concat([{ at: Date.now(), used }])
        .slice(-6);
      const profile = pressureOf({ used, win, cfg, history: st.usageHistory });
      out.push(contextMessage(pressureLineText(profile), 'water'));
      st.lastWaterAt = Date.now();
      if (st.skipTierOnce) st.skipTierOnce = false;
      saveState(sid, st);
      return out;
    }

    // 轮内步骤分隔：到线判定与强制压缩只在此处发生。
    const self = readSelfPressure(projCacheDir(), sid);
    const { used, win } = normWater(self);
    if (used === null || win === null) {
      noteTriggerSkip(sid, 'no-pressure', null);
      return out;
    }
    const profile = pressureOf({ used, win, cfg, history: st.usageHistory });
    const cs = compactionStateOf(sid, null) || {};
    // 两级计数：助手入口与提示在达到 maxCompactionsPerSession 后关闭；强制线兜底到 hardCap。
    const maxCompactions = Number(cfg.maxCompactionsPerSession) || 4;
    const hardCap = Number(cfg.maxCompactionsHardCap) || 6;
    const usedCompactions = Math.max(Number(cs.used) || 0, Number(st.compactions) || 0);
    const ratio = used / win;
    // 闸门取 3 项冷却的最大值：summary 静默期、调度器冷却、轮内压缩冷却。
    // 任一未结束即不判定，避免刚压缩完又在下一步重复压缩。
    const sinceSummary = cs.lastSummaryMs ? Date.now() - cs.lastSummaryMs : Infinity;
    const quietLeft = sinceSummary < 120000 ? 120000 - sinceSummary : 0;
    const schedCool = scheduler && typeof scheduler.cooldownLeft === 'function'
      ? scheduler.cooldownLeft(sid, cfg.triggerCooldownMs)
      : 0;
    const action = judgeTrigger({
      used,
      win,
      bands: profile.bands,
      cfg,
      lockState: cs.lock,
      cooldownLeftMs: Math.max(quietLeft, schedCool, inlineCooldownLeft(sid, cfg.triggerCooldownMs)),
      inTurn: true,
      notifiedSoft: !!(st.notified && st.notified.soft),
      notifiedAdvise: !!(st.notified && st.notified.advise),
    });
    if (action.action === 'notifySoft' || action.action === 'notifyAdvise') {
      const level = action.action === 'notifySoft' ? 'soft' : 'advise';
      st.notified = st.notified && typeof st.notified === 'object' ? st.notified : {};
      st.notified[level] = Date.now();
      if (usedCompactions >= hardCap) {
        out.push(contextMessage(successionCeilingText(usedCompactions, hardCap), 'succession'));
        noteInline('压缩硬上限 ' + sid + ' level=' + level + ' count=' + usedCompactions + '/' + hardCap);
        saveState(sid, st);
        return out;
      }
      if (usedCompactions >= maxCompactions) {
        out.push(contextMessage(successionBlockText(usedCompactions, maxCompactions, cfg), 'succession'));
        noteInline('换任提示 ' + sid + ' level=' + level + ' count=' + usedCompactions + '/' + maxCompactions);
        saveState(sid, st);
        return out;
      }
      st.lastTierPromptAt = Date.now();
      out.push(contextMessage(tierPromptText(level, profile), 'tier-' + level));
      noteInline('提示压缩 ' + sid + ' level=' + level + ' ratio=' + pctText(ratio));
      saveState(sid, st);
      return out;
    }
    if (action.action !== 'force') {
      noteTriggerSkip(sid, 'not-triggered', ratio);
      saveState(sid, st);
      return out;
    }
    if (usedCompactions >= hardCap) {
      // 硬上限：连强制线也不再压缩，只发换任指令。每轮一条，去重留痕。
      out.push(contextMessage(successionCeilingText(usedCompactions, hardCap), 'succession'));
      noteTriggerSkip(sid, 'compaction-limit', ratio);
      saveState(sid, st);
      return out;
    }
    // 强制线：提示后立即强制压缩；助手计数达上限但未到硬上限时仍由插件兜底。
    out.push(contextMessage(hardPromptText(profile), 'hard'));
    st.lastTierPromptAt = Date.now();
    saveState(sid, st);
    const r = await forceCompact(agent, sid, signal);
    if (r) {
      const st2 = readState(sid);
      if (st2 && Array.isArray(st2.pendingMessages) && st2.pendingMessages.length) {
        for (const m of st2.pendingMessages) out.push(contextMessage(m.text, m.kind));
        st2.pendingMessages = [];
        saveState(sid, st2);
      }
    }
    return out;
  }

  /**
   * 步骤边界监听：只处理本次步骤所属的会话，不枚举其他会话；注入一律追加到末尾。
   * 先执行 next() 取得宿主决策，再把消息追加到该决策末尾。
   * 这样宿主拒绝或取消本步骤时原样返回决策，本钩子自身失败也不阻断步骤。
   */
  async function onPreStep(payload, next) {
    let decision;
    try {
      decision = typeof next === 'function' ? await next() : undefined;
    } catch (e) {
      env.log('步骤前置失败：' + msgOf(e));
      throw e;
    }
    try {
      const agent = payload && payload.agent ? payload.agent : null;
      if (!agent || !decision || decision.kind === 'reject') return decision;
      if (payload && payload.signal && payload.signal.aborted) return decision;
      const extra = await autoTriggerFor(agent, payload);
      if (!extra.length) return decision;
      const messages = Array.isArray(decision.messages) ? decision.messages : [];
      return Object.assign({}, decision, { messages: [...messages, ...extra] });
    } catch (e) {
      env.log('到线判定失败：' + msgOf(e));
      return decision;
    }
  }

  /** 助手执行入口：轮内压缩，零可见消息。先写锚点，再压缩。 */
  async function assistantCompact(exec, opts) {
    const a = opts || {};
    const agent = exec && exec.agent ? exec.agent : null;
    const sid = env.selfId(exec);
    if (!agent || !sid) return { ok: false, reason: '未取得本会话或会话不在内存中。' };
    const capsule = typeof a.capsule === 'string' ? a.capsule.trim() : '';
    if (!capsule) return { ok: false, reason: '缺少 `capsule` 或正文为空。' };
    const info = env.roleOf(exec) || {};
    const st = readState(sid) || {};
    const cs = compactionStateOf(sid, exec) || {};
    const anchorPath = anchorOps.anchorFileFor(sid);
    let anchorWritable = false;
    if (anchorPath) {
      try { fs.mkdirSync(path.dirname(anchorPath), { recursive: true }); anchorWritable = true; } catch { anchorWritable = false; }
    }
    const mode = a.mode === 'aggressive' || a.mode === 'minimal' ? a.mode : 'auto';
    const shadowTarget = mode === 'aggressive' ? 0.70 : mode === 'minimal' ? 0.40 : (Number(cfg.shadowTarget) || 0.55);
    const gate = judgeAssistantCompact({
      sid,
      role: info.role,
      anchorPath,
      anchorWritable,
      lockState: cs.lock || 'clean',
      inflight: inline.inflight.has(sid),
      schedulerPending: !!(scheduler && scheduler.pending && typeof scheduler.pending.has === 'function' && scheduler.pending.has(sid)),
      pendingCompaction: false,
      pendingToolCalls: openToolCalls(agent.session),
      compactionCount: Math.max(Number(cs.used) || 0, Number(st.compactions) || 0),
      maxCompactions: Number(cfg.maxCompactionsPerSession) || 4,
    });
    if (!gate.ok) return { ok: false, reason: gate.reason, checks: gate.checks };
    inline.inflight.add(sid);
    const started = Date.now();
    try {
      const snap = autoSnapshotFor(sid);
      if (snap) snap.snapshotPath = writeSnapshot(snap).path;
      const anchor = writeAnchorFor(sid, agent.session, a.status);
      const r = await compactInTurn(ctx, agent, cfg, signalOf(exec), {
        shadowTarget,
        keepMinMessages: cfg.keepMinMessages,
        minKeepTokens: cfg.minKeepTokens,
        boundary: a.boundary === true,
        mode,
      });
      if (r && r.status === 'ok') {
        const compacted = afterCompact(sid, 'assistant', r, {
          session: agent.session,
          anchor: anchor.sections,
          anchorPath: anchor.path,
          source: 'assistant',
          capsuleBody: capsule,
        });
        const after = readState(sid) || {};
        const max = Number(cfg.maxCompactionsPerSession) || 4;
        return {
          ok: true,
          status: 'ok',
          tokensBefore: r.tokensBefore,
          tokensAfter: r.tokensAfter,
          roi: roiOf(r.tokensBefore, r.tokensAfter),
          anchorPath: anchor.path || anchorPath,
          anchorTokens: anchor.tokens || 0,
          anchorOverBudget: anchor.overBudget === true,
          capsuleChars: compacted.capsuleChars,
          capsuleBodyChars: compacted.capsuleBodyChars,
          capsuleSource: compacted.capsuleSource,
          capsuleOverBudget: compacted.capsuleOver,
          remaining: Math.max(0, max - (Number(after.compactions) || 0)),
          mode,
          boundary: a.boundary === true,
        };
      }
      noteInline('inline compact skipped ' + sid + ' reason=' + (r && r.reason ? r.reason : (r && r.status ? r.status : 'unknown')));
      return { ok: false, status: r && r.status ? r.status : 'no-range', reason: '本轮没有可压缩范围或表面不一致：' + (r && r.reason ? r.reason : 'unknown') };
    } catch (e) {
      const detail = msgOf(e);
      noteInline('inline compact failed ' + sid + ' by=assistant after ' + (Date.now() - started) + 'ms: ' + detail);
      return { ok: false, status: 'failed', reason: detail };
    } finally {
      inline.lastAt.set(sid, Date.now());
      inline.inflight.delete(sid);
    }
  }

  return { onPreStep, autoTriggerFor, forceCompact, afterCompact, assistantCompact, noteInline, pctText, openToolCalls, contextMessage, inlineCooldownLeft, notifyInlineStop };
}
