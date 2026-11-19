/**
 * 压缩主链：轮首注入压力行、到线注入提示、强制线强制压缩。
 * 整理线与建议线只注入提示，绝不调用压缩 API；只有强制线由插件兜底压缩。
 * 全部注入都在本会话的步骤边界生成，作为末尾消息追加；不改 system 头，不逐步注入。
 *
 * 依赖通过 runtime 注入，共享状态集中在 index.mjs 的 runtime 对象，
 * 含 inline、roleCache、cfg 等。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { projCacheDir, readSelfPressure } from './sessions.mjs';
import { appendRunLog } from './runlog.mjs';
import { createSkipLogger } from './skip-log.mjs';
import { compactInTurn, INLINE_UNAVAILABLE, INLINE_NO_METER } from './engine.mjs';
import { compactionStateOf, logRecordsOf } from './events.mjs';
import { judgeTrigger } from './triggers.mjs';
import { pressureLineText, tierPromptText, hardPromptText, successionPromptText, successionBlockText, successionCeilingText, roiAdviceText } from './inject.mjs';
import { pressureOf, roiOf, normWater, settlePendingAfter } from './pressure.mjs';
import { renderCapsule, extractKeywordSentences, CAPSULE_RENDER_MAX_CHARS } from './capsule.mjs';
import { probeConstraints } from './constraints.mjs';
import { writeSnapshot } from './checkpoint.mjs';
import { judgeAssistantCompact } from './compact-gate.mjs';
import { signalOf } from './abort.mjs';
import { readSessionState } from './store.mjs';
import { sendPrompt } from './prompt.mjs';

/** 创建压缩主链。runtime 注入共享状态与依赖。 */
export function createInlineEngine(runtime) {
  const {
    ctx, cfg, env, inline, roleCache,
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

  /** 表面未闭合工具调用数：工具调用块数减工具结果数；取不到即返回 NaN（未核），不得当成 0。 */
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
    } catch { return NaN; }
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

  /** 机制胶囊的关键词摘录：必须在压缩前读取会话日志，压缩后正文可能已被置换。 */
  function excerptSentencesFor(sid) {
    try { return extractKeywordSentences(logRecordsOf(sid) || [], { turns: 6 }); }
    catch { return []; }
  }

  /**
   * 压缩成功后的统一收尾：计数、日志、胶囊与换任提示。
   * 压缩返回瞬间的测量是中间态（被压区已从计量消失、宿主投影尚未结算），
   * 因此这里只记「待校准」，tokensAfter／roi／roiHistory／lowRoiStreak 交由下一个步骤边界补写。
   */
  function afterCompact(sid, by, r, extra) {
    const e = extra || {};
    const st = readState(sid) || readSessionState(sid);
    const logState = compactionStateOf(sid, null) || {};
    const beforeCount = Math.max(Number(logState.used) || 0, Number(st.compactions) || 0);
    st.compactions = beforeCount + 1;
    st.notified = {};
    st.lastCompactAt = Date.now();
    const tokensBefore = r && typeof r.tokensBefore === 'number' ? r.tokensBefore : null;
    const shadowed = r && r.result && r.result.shadowedTokenCount !== undefined
      ? r.result.shadowedTokenCount
      : (r && r.range && typeof r.range.shadowTokens === 'number' ? r.range.shadowTokens : null);
    st.tokensBefore = tokensBefore;
    st.tokensAfter = null;
    st.roi = null;
    st.pendingAfter = {
      before: tokensBefore,
      shadowed,
      at: Date.now(),
      range: r && r.range ? r.range.start + '-' + r.range.end : '',
      count: st.compactions,
    };
    noteInline('inline compacted ' + sid + ' by=' + by
      + ' seqs=' + (r && r.range ? r.range.start + '-' + r.range.end : '?')
      + ' shadowed=' + (shadowed === null ? '?' : shadowed)
      + ' tokensBefore=' + (tokensBefore === null ? '?' : tokensBefore)
      + ' tokensAfter=pending');
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
    const excerpts = Array.isArray(e.excerpts) ? e.excerpts : [];
    const capsuleText = renderCapsule({
      source: capsuleSource,
      body: capsuleSource === 'assistant' ? capsuleBody : '',
      anchor,
      anchorPath: e.anchorPath || '',
      excerpts,
      before: tokensBefore,
      after: null,
      shadow: shadowed,
      count: st.compactions,
      max,
      missing,
      cfg,
    });
    const capsuleChars = capsuleText.length;
    const capsuleLimit = CAPSULE_RENDER_MAX_CHARS;
    const capsuleOver = capsuleChars > capsuleLimit;
    if (capsuleOver) {
      noteInline('capsule over render budget ' + sid + ' chars=' + capsuleChars + ' limit=' + capsuleLimit);
    }
    st.pendingMessages.push({ kind: 'post-compact', text: capsuleText });
    const prompted = Number(st.succession && st.succession.promptedCount) || 0;
    if (st.compactions >= max && prompted < st.compactions) {
      st.succession = { promptedCount: st.compactions, promptedAt: Date.now() };
      st.pendingMessages.push({ kind: 'succession', text: successionPromptText(st.compactions, max, cfg) });
      noteInline('换任提示 ' + sid + ' 计数 ' + st.compactions + '/' + max);
    }
    saveState(sid, st);
    return { st, capsuleChars, capsuleOver, capsuleSource, capsuleBodyChars: capsuleBody.length };
  }

  /**
   * 待校准消费：用宿主投影水位补写一次压缩后读数，并据实判定低收益建议。
   * 记录由 settlePendingAfter 删除，重复调用不会再次累加。
   */
  function calibrateAfter(sid, st, used) {
    const floor = Number(cfg.roiFloor) || 0.30;
    const r = settlePendingAfter(st, used, floor);
    // 宿主投影尚未结算压缩结果：读数保留，下一处步骤边界重读。
    if (r.retained) {
      noteInline('inline compact after stale ' + sid
        + ' retries=' + (Number(st.pendingAfter && st.pendingAfter.retries) || 0));
      return r;
    }
    if (!r.consumed) return null;
    if (!r.measured) {
      noteInline('inline compact after unmeasured ' + sid);
      return r;
    }
    noteInline('inline compact calibrated ' + sid
      + ' tokensAfter=' + st.tokensAfter
      + ' roi=' + (r.roi === null ? '?' : r.roi.toFixed(3))
      + ' streak=' + r.streak);
    if (r.roi !== null && r.streak >= 2) {
      st.pendingMessages = Array.isArray(st.pendingMessages) ? st.pendingMessages : [];
      st.pendingMessages.push({ kind: 'succession-advice', text: roiAdviceText(r.roi, floor, r.streak) });
      noteInline('低收益换任建议 ' + sid + ' streak=' + r.streak);
    }
    return r;
  }

  /** 强制压缩：先写锚点与摘录，再压缩；锚点与快照失败都只留痕，不阻断压缩。 */
  async function forceCompact(agent, sid, signal) {
    const snap = autoSnapshotFor(sid);
    if (snap) {
      try { snap.snapshotPath = writeSnapshot(snap).path; }
      catch (e) { noteInline('compact snapshot failed ' + sid + ': ' + msgOf(e)); }
    }
    const excerpts = excerptSentencesFor(sid);
    const anchor = writeAnchorFor(sid, agent.session, '');
    inline.inflight.add(sid);
    const started = Date.now();
    try {
      const r = await compactInTurn(ctx, agent, cfg, signal, { shadowTarget: cfg.shadowTarget });
      if (r && r.status === 'ok') {
        afterCompact(sid, 'force', r, {
          session: agent.session,
          anchor: anchor.sections,
          anchorPath: anchor.path,
          excerpts,
          source: 'mechanism',
        });
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
    const stepNum = Number(payload && payload.step);
    const atTurnStart = !Number.isFinite(stepNum) || stepNum <= 1;
    const signal = payload ? payload.signal : undefined;
    const st = readState(sid);
    if (!st) return out;
    const self = readSelfPressure(projCacheDir(), sid);
    const { used, win } = normWater(self);
    // D-171：压缩后读数在压缩返回瞬间不可信，在此步骤边界用宿主投影水位补写一次。
    if (st.pendingAfter && calibrateAfter(sid, st, used)) saveState(sid, st);

    // 待注入消息：压缩后的胶囊、低收益建议与换任提示；由压缩入口写入，下一处步骤边界取走。
    if (Array.isArray(st.pendingMessages) && st.pendingMessages.length) {
      for (const m of st.pendingMessages) out.push(contextMessage(m.text, m.kind));
      st.pendingMessages = [];
      saveState(sid, st);
    }

    if (atTurnStart) {
      // 轮次起点：只注入水位行并记历史，不做到线判定、不压缩。
      if (used === null || win === null) {
        out.push(contextMessage(pressureLineText(pressureOf({ used: null, win: null, cfg })), 'water'));
        noteTriggerSkip(sid, 'no-pressure', null);
        return out;
      }
      st.usageHistory = (Array.isArray(st.usageHistory) ? st.usageHistory : [])
        .concat([{ at: Date.now(), used }])
        .slice(-6);
      const profile = pressureOf({ used, win, cfg, history: st.usageHistory });
      out.push(contextMessage(pressureLineText(profile), 'water'));
      st.lastWaterAt = Date.now();
      saveState(sid, st);
      return out;
    }

    // 轮内步骤分隔：到线判定与强制压缩只在此处发生。
    if (used === null || win === null) {
      noteTriggerSkip(sid, 'no-pressure', null);
      return out;
    }
    const profile = pressureOf({ used, win, cfg, history: st.usageHistory });
    // 水位低于整理线时，判据必为 idle，无需读压缩锁与计数；
    // 压缩状态要增量解码日志，每步约 0.2 ms，低水位步骤跳过。
    const cs = profile.level === 'low' ? { lock: 'clean' } : (compactionStateOf(sid, null) || {});
    // 两级计数：助手入口与提示在达到 maxCompactionsPerSession 后关闭；强制线兜底到 hardCap。
    const maxCompactions = Number(cfg.maxCompactionsPerSession) || 4;
    const hardCap = Number(cfg.maxCompactionsHardCap) || 6;
    const usedCompactions = Math.max(Number(cs.used) || 0, Number(st.compactions) || 0);
    const ratio = used / win;
    // 闸门取 3 项冷却的最大值：summary 静默期、落盘压缩时刻（state）、轮内压缩冷却。
    // 任一未结束即不判定，避免刚压缩完又在下一步重复压缩。
    const sinceSummary = cs.lastSummaryMs ? Date.now() - cs.lastSummaryMs : Infinity;
    const quietMs = Number(cfg.summaryQuietMs) > 0 ? Number(cfg.summaryQuietMs) : 120000;
    const quietLeft = sinceSummary < quietMs ? quietMs - sinceSummary : 0;
    const lastCompactAt = Number(st.lastCompactAt) || 0;
    const stateCool = lastCompactAt && cfg.triggerCooldownMs
      ? Math.max(0, Number(cfg.triggerCooldownMs) - (Date.now() - lastCompactAt))
      : 0;
    const action = judgeTrigger({
      used,
      win,
      bands: profile.bands,
      cfg,
      lockState: cs.lock,
      cooldownLeftMs: Math.max(quietLeft, stateCool, inlineCooldownLeft(sid, cfg.triggerCooldownMs)),
      inTurn: true,
      notifiedSoft: !!(st.notified && st.notified.soft),
      notifiedAdvise: !!(st.notified && st.notified.advise),
    });
    if (action.action === 'notifySoft' || action.action === 'notifyAdvise') {
      const level = action.action === 'notifySoft' ? 'soft' : 'advise';
      st.notified = st.notified && typeof st.notified === 'object' ? st.notified : {};
      st.notified[level] = Date.now();
      if (usedCompactions >= hardCap) {
        // 换任指令每会话只注入一条；压缩成功清空 notified 后才可能再提示。
        if (!st.notified.ceiling) {
          st.notified.ceiling = Date.now();
          out.push(contextMessage(successionCeilingText(usedCompactions, hardCap), 'succession'));
          noteInline('压缩硬上限 ' + sid + ' level=' + level + ' count=' + usedCompactions + '/' + hardCap);
        }
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
      return out;
    }
    if (usedCompactions >= hardCap) {
      // 硬上限：连强制线也不再压缩，只发换任指令。每会话一条，去重留痕。
      if (!(st.notified && st.notified.ceiling)) {
        st.notified = st.notified && typeof st.notified === 'object' ? st.notified : {};
        st.notified.ceiling = Date.now();
        out.push(contextMessage(successionCeilingText(usedCompactions, hardCap), 'succession'));
        noteInline('压缩硬上限 ' + sid + ' count=' + usedCompactions + '/' + hardCap);
      }
      noteTriggerSkip(sid, 'compaction-limit', ratio);
      saveState(sid, st);
      return out;
    }
    // 强制线唯一校验未闭合工具调用：>1 个（或取不到）说明切点落在工具调用中间，跳过并留痕。
    // 非强制线（助手入口）不再校验，避免把「表面未同步」误判成拒绝。
    const open = openToolCalls(agent.session);
    if (!Number.isFinite(open) || open > 1) {
      noteTriggerSkip(sid, 'open-tool-calls', ratio);
      noteInline('inline compact skipped ' + sid + ' reason=open-tool-calls count=' + (Number.isFinite(open) ? open : '未核'));
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
      pendingCompaction: false,
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
        full: cfg.fullCompact !== false,
        shadowTarget,
        keepMinMessages: cfg.keepMinMessages,
        minKeepTokens: cfg.minKeepTokens,
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
