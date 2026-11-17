import { checkConsent } from './consent.mjs';
import { sendPrompt } from './prompt.mjs';
import { logRecordsOf } from './events.mjs';
import { deriveSegments, segmentStats } from './segments.mjs';
import { extractSnapshot, writeSnapshot } from './checkpoint.mjs';
import { buildBackfillText, composeResumeMessage, shouldSendBackfill, markBackfill } from './resume.mjs';
import { appendRunLog } from './runlog.mjs';
import { serviceOf, compactionOf } from './engine.mjs';
import { abortableDelay, aborted } from './abort.mjs';

/**
 * 压缩调度：compactNow 只允许 idle 状态调用。
 * 例行自触发已改为在 agent/pre-step 内同步调用 compactRegion（见 lib/engine.mjs），不经过这里。
 * 本调度器只服务显式重置（checkpoint、设置页代排）：登记后等空闲再压缩，并投续跑回填。
 */

/** 填续跑模板：{n}/{handover}/{role}。没有交接路径时改用「未设置角色」模板，避免提示词指向空路径。 */
export function fillResumePrompt(cfg, input) {
  const i = input || {};
  const hasPath = !!i.handover;
  const tpl = hasPath ? String(cfg.resumePrompt || '') : String(cfg.resumePromptUnknown || cfg.resumePrompt || '');
  return tpl
    .split('{n}').join(String(i.n === undefined ? 0 : i.n))
    .split('{max}').join('—')
    .split('{handover}').join(hasPath ? i.handover : '（未解析）')
    .split('{role}').join(i.role || 'plain');
}

export function createScheduler(deps) {
  const { ctx, cfg } = deps;
  const logger = deps.logger || null;
  const pending = new Map();
  const timers = new Map();
  const lastDone = new Map();
  // 只留最近 64 个会话的落定记录：插件长驻时它只增不减，冷却判定并不需要更久的历史。
  const LAST_DONE_MAX = 64;
  let disposed = false;

  /** 记一次落定；同一会话刷新到队尾，超出上限淘汰最久未用。 */
  function rememberDone(sessionId, status) {
    lastDone.delete(sessionId);
    lastDone.set(sessionId, { at: Date.now(), status });
    while (lastDone.size > LAST_DONE_MAX) lastDone.delete(lastDone.keys().next().value);
  }

  // 用全局定时器：cordis 的 ctx.setTimeout 绑定调用方 fiber，工具调用返回后可能被一并释放。
  function later(fn, ms) {
    return setTimeout(fn, ms);
  }

  function note(msg) {
    try { if (logger && logger.info) logger.info("dsh-handover: " + msg); } catch { /* ignore */ }
    appendRunLog(msg);
  }

  function agentOf(sessionId) {
    const agents = serviceOf(ctx, null, 'agents');
    try { return agents && agents.get ? agents.get(sessionId) : null; } catch { return null; }
  }

  async function compactOnce(sessionId) {
    const agent = agentOf(sessionId);
    if (!agent) throw new Error("现象：会话不在内存中，可能已休眠。原因：宿主已卸载该会话的 agent。处置：唤醒该会话后重新登记压缩。");
    const compaction = compactionOf(ctx, agent);
    if (!compaction || typeof compaction.compactNow !== "function") throw new Error("现象：`compaction.compactNow` 不可用。原因：profile 级与会话作用域均未取到该服务。处置：确认宿主压缩服务可用后重启 DSH。");
    const ac = new AbortController();
    const timer = later(() => ac.abort(new Error("timeout")), cfg.compactTimeoutMs || 120000);
    try {
      return await compaction.compactNow(agent, ac.signal);
    } finally {
      if (timer) { try { clearTimeout(timer); } catch { /* ignore */ } }
    }
  }

  /** 续跑文案：按该会话的角色取模板，并把 {handover} 填成它自己的交接绝对路径。 */
  function resumeText(sessionId, n) {
    let info = null;
    let hp = null;
    try { info = typeof deps.roleOf === 'function' ? deps.roleOf(sessionId) : null; } catch { info = null; }
    try { hp = typeof deps.handoverFor === 'function' ? deps.handoverFor(sessionId) : null; } catch { hp = null; }
    return fillResumePrompt(cfg, { n, handover: hp && hp.path ? hp.path : '', role: info && info.role ? info.role : 'plain' });
  }

  function promptSelf(sessionId, text) {
    return sendPrompt(serviceOf(ctx, null, 'sessionController'), sessionId, text, 'queue');
  }

  /**
   * 等会话空闲。有 whenIdle 时优先用它；否则退回 1 秒一次的低频轮询（只在等待期生效）。
   * 等待拆成分段可中止：用户终止或插件卸载后立即返回 'aborted'，不必等满 180 秒。
   * @param {object} agent 会话实体
   * @param {number} ms 最长等待毫秒数
   * @param {AbortSignal} [signal] 本次工具调用的中止信号
   * @returns {Promise<'idle'|'timeout'|'aborted'>} 空闲、超时或被中止
   */
  async function waitIdle(agent, ms, signal) {
    if (disposed || aborted(signal)) return 'aborted';
    if (typeof agent.whenIdle === "function") {
      let timer = null;
      let tick = null;
      const clean = () => {
        if (timer) { try { clearTimeout(timer); } catch { /* ignore */ } }
        if (tick) { try { clearInterval(tick); } catch { /* ignore */ } }
      };
      const timeoutP = new Promise((resolve) => { timer = later(() => resolve('timeout'), ms); });
      const abortP = new Promise((resolve) => {
        if (!signal || typeof signal.addEventListener !== 'function') return;
        try { signal.addEventListener('abort', () => resolve('aborted'), { once: true }); } catch { /* ignore */ }
      });
      const disposedP = new Promise((resolve) => {
        tick = setInterval(() => { if (disposed) resolve('aborted'); }, 500);
      });
      try {
        const r = await Promise.race([
          Promise.resolve(agent.whenIdle()).then(() => (agent.status !== "running" ? "idle" : "busy"), () => "busy"),
          timeoutP,
          abortP,
          disposedP,
        ]);
        return r === 'idle' || r === 'timeout' || r === 'aborted' ? r : 'timeout';
      } finally {
        clean();
      }
    }
    const deadline = Date.now() + ms;
    for (;;) {
      if (agent.status !== "running") return 'idle';
      if (Date.now() >= deadline) return 'timeout';
      const why = await abortableDelay(Math.min(1000, deadline - Date.now()), signal);
      if (why === 'aborted' || disposed) return 'aborted';
    }
  }

  async function attempt(sessionId) {
    const job = pending.get(sessionId);
    if (!job || disposed) return;
    const agent = agentOf(sessionId);
    if (!agent) { fail(sessionId, "会话不在内存，可能已休眠"); return; }
    // 状态读取与空闲等待都可能抛错：不捕获的话 pending 会永久挂在表里，且没有下一次重试。
    if (agent.status === "running") {
      let idle = 'timeout';
      try {
        idle = await waitIdle(agent, cfg.waitIdleMs || 180000, job.signal);
      } catch (e) {
        fail(sessionId, "等待会话空闲时出错：" + (e && e.message ? e.message : e));
        return;
      }
      if (idle === 'aborted') { fail(sessionId, "已中止：等待会话空闲被终止，历史未压缩", true); return; }
      if (idle !== 'idle') { fail(sessionId, "等待 " + Math.round((cfg.waitIdleMs || 180000) / 1000) + " 秒后会话仍未空闲"); return; }
    }
    try {
      const result = await compactOnce(sessionId);
      if (!result) {
        job.done("no-span");
        pending.delete(sessionId);
        return;
      }
      note("compacted " + sessionId + " by=" + (job.triggeredBy || "manual") + " shadowed=" + (result.shadowedTokenCount || "?"));
      // resume=wait：任务已收尾，压缩后不唤醒，也不投回填消息。
      if (cfg.autoResume === false || job.resume === "wait") {
        if (job.resume === "wait") note("resume skipped (wait): " + sessionId);
        job.done(job.resume === "wait" ? "ok-wait" : "ok", result);
        pending.delete(sessionId);
        return;
      }
      // 5 分钟内连续压缩：回填不再重复，但续跑仍须投递，否则会话会停住。
      const gate = shouldSendBackfill(sessionId, Date.now(), cfg.backfillMergeMs);
      if (!gate.send) {
        note("backfill merged: " + sessionId + " since=" + Math.round((gate.sinceMs || 0) / 1000) + "s");
        try {
          await promptSelf(sessionId, resumeText(sessionId, job.n));
          job.done("ok-merged", result);
        } catch (e) {
          job.done("resume-failed", result);
          note("merged resume prompt failed: " + e.message);
        }
        pending.delete(sessionId);
        return;
      }
      let snapshotPath = job.snapshotPath || "";
      let segCount = 0;
      let lastLabel = "";
      try {
        const recs = logRecordsOf(sessionId) || [];
        const segs = deriveSegments(recs);
        const st2 = segmentStats(segs);
        segCount = st2.count;
        lastLabel = st2.lastLabel;
        if (!snapshotPath) {
          snapshotPath = writeSnapshot(extractSnapshot(recs, {
            sid: sessionId,
            ws: cfg.workspaceRoot || '',
            sinceSeq: segs.length ? segs[segs.length - 1].summarySeq : -1,
          })).path;
        }
      } catch (e) {
        note("snapshot failed: " + (e && e.message ? e.message : e));
      }
      let handover = "";
      try {
        const hp = typeof deps.handoverFor === 'function' ? deps.handoverFor(sessionId) : null;
        handover = hp && hp.path ? hp.path : "";
      } catch { handover = ""; }
      const bfText = buildBackfillText({
        n: job.n,
        snapshotPath,
        handoverPath: handover,
        segmentCount: segCount,
        lastLabel,
      });
      const text = composeResumeMessage(bfText, resumeText(sessionId, job.n));
      try {
        await promptSelf(sessionId, text);
        markBackfill(sessionId, Date.now(), snapshotPath);
        job.done("ok", result);
      } catch (e) {
        job.done("resume-failed", result);
        note("resume prompt failed: " + e.message);
      }
      pending.delete(sessionId);
    } catch (e) {
      const code = e && e.code;
      if (code === "busy") {
        if (Date.now() - job.startedAt > (cfg.waitIdleMs || 180000)) { fail(sessionId, "压缩持续处于 busy 状态，存在其他压缩或排队工作"); return; }
        retryLater(sessionId, 800);
        return;
      }
      job.attempts++;
      if (job.attempts >= (cfg.compactAttempts || 3)) { fail(sessionId, "压缩过程报错：" + (e.message || code)); return; }
      retryLater(sessionId, 800);
    }
  }

  function retryLater(sessionId, ms) {
    if (disposed) return;
    const old = timers.get(sessionId);
    if (old) { try { clearTimeout(old); } catch { /* ignore */ } }
    const t = later(() => { timers.delete(sessionId); attempt(sessionId); }, ms);
    timers.set(sessionId, t);
  }

  function fail(sessionId, msg, silent) {
    const job = pending.get(sessionId);
    if (job) job.done("failed", null, msg);
    pending.delete(sessionId);
    const t = timers.get(sessionId);
    if (t) { try { clearTimeout(t); } catch { /* ignore */ } timers.delete(sessionId); }
    note("checkpoint failed " + sessionId + ": " + msg);
    if (silent === true) return;
    try {
      promptSelf(sessionId, "【dsh-handover】现象：压缩未执行。原因：" + msg + "。历史未被压缩，交接已就绪。处置：将本条消息原样告知当前用户，不得自行重试压缩。").catch(() => {});
    } catch { /* ignore */ }
  }

  /** 登记一次压缩请求；返回 Promise，settle 时给出结果（供工具侧只做登记、不等待）。 */
  function request(sessionId, opts) {
    // 去重：同一会话已登记时不再叠加，避免自动触发与手动登记各排一次。
    if (pending.has(sessionId)) {
      return Promise.resolve({ status: 'duplicate', result: null, error: null, at: Date.now() });
    }
    return new Promise((resolve) => {
      let settled = false;
      const done = (status, result, error) => {
        if (settled) return;
        settled = true;
        rememberDone(sessionId, status);
        resolve({ status, result: result || null, error: error || null, at: Date.now() });
      };
      // 双保险只对「没验过授权」的调用方生效。入口工具（ho_handover 的 checkpoint 动作、全局代排）已校验并消费了授权，
  // 之后再查必然查不到，压缩会被这一步全部挡掉。
      if (opts.consent !== 'checked') {
        const cs = checkConsent(sessionId);
        if (!cs.ok) {
          note("拒绝压缩 " + sessionId + "：" + cs.reason);
          done("no-consent", null, cs.reason);
          return;
        }
      }
      pending.set(sessionId, {
        n: opts.n || 0,
        resume: opts.resume === "wait" ? "wait" : "continue",
        attempts: 0,
        done,
        startedAt: Date.now(),
        snapshotPath: opts.snapshotPath || "",
        triggeredBy: opts.triggeredBy || "manual",
        signal: opts.signal || null,
      });
      retryLater(sessionId, opts.delayMs === undefined ? 600 : opts.delayMs);
    });
  }

  /** 冷却剩余毫秒：本进程内该会话上一次压缩（含失败）落定后开始计时。 */
  function cooldownLeft(sessionId, ms) {
    const rec = lastDone.get(sessionId);
    if (!rec || !ms || ms <= 0) return 0;
    return Math.max(0, ms - (Date.now() - rec.at));
  }

  /** 最近一次压缩结果，供诊断读取。 */
  function lastOutcome(sessionId) {
    return lastDone.get(sessionId) || null;
  }

  function dispose() {
    disposed = true;
    for (const t of timers.values()) {
      try { clearTimeout(t); } catch { /* ignore */ }
    }
    timers.clear();
    pending.clear();
    lastDone.clear();
  }

  return { request, dispose, pending, cooldownLeft, lastOutcome };
}