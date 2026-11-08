import fsx from "node:fs";
import osx from "node:os";
import pathx from "node:path";
import { checkConsent } from './consent.mjs';

/**
 * 压缩调度：compactNow 只允许 idle，所以 ho_checkpoint 只登记，轮次结束后由这里排程。
 * 做法：短间隔轮询 ctx.agents.get(sessionId).status，直到非 running 再压缩；成功后投续跑消息。
 */

/** 填续跑模板：{n}/{max}/{handover}/{role}。没有交接路径时用「未设置角色」模板。 */
export function fillResumePrompt(cfg, input) {
  const i = input || {};
  const hasPath = !!i.handover;
  const tpl = hasPath ? String(cfg.resumePrompt || '') : String(cfg.resumePromptUnknown || cfg.resumePrompt || '');
  return tpl
    .split('{n}').join(String(i.n === undefined ? 0 : i.n))
    .split('{max}').join(String(cfg.maxCompactions))
    .split('{handover}').join(hasPath ? i.handover : '（未解析）')
    .split('{role}').join(i.role || 'plain');
}

export function createScheduler(deps) {
  const { ctx, cfg } = deps;
  const logger = deps.logger || null;
  const pending = new Map();
  const timers = new Map();
  let disposed = false;

  // 用全局定时器：cordis 的 ctx.setTimeout 绑定调用方 fiber，工具调用返回后可能被一并释放
  // 用全局定时器：cordis 的 ctx.setTimeout 绑定调用方 fiber，工具调用返回后可能被一并释放。
  function later(fn, ms) {
    return setTimeout(fn, ms);
  }

  function note(msg) {
    try { if (logger && logger.info) logger.info("dsh-handover: " + msg); } catch { /* ignore */ }
    try {
      const f = pathx.join(osx.homedir(), ".dsh", "storages", "dsh-handover", "logs", "schedule.log");
      fsx.mkdirSync(pathx.dirname(f), { recursive: true });
      const line = new Date().toISOString() + " " + msg + String.fromCharCode(10);
      const bom = fsx.existsSync(f) ? "" : String.fromCharCode(0xfeff);
      fsx.appendFileSync(f, bom + line);
    } catch { /* ignore */ }
  }

  /** 服务解析：优先 ctx 直取，其次 ctx.get（inject 未声明的服务只能用后者）。 */
  function service(name) {
    try { const v = ctx[name]; if (v) return v; } catch { /* ignore */ }
    try { return typeof ctx.get === 'function' ? ctx.get(name) : null; } catch { return null; }
  }

  function agentOf(sessionId) {
    const agents = service('agents');
    try { return agents && agents.get ? agents.get(sessionId) : null; } catch { return null; }
  }

  /** compaction 可能是「每个 agent 提供」的会话作用域服务：先 agent.ctx，再退回 profile 级 ctx。 */
  function compactionOf(agent) {
    try {
      const c = agent && agent.ctx;
      if (c) {
        let v = null;
        try { v = c.compaction; } catch { /* ignore */ }
        if (!v) { try { v = typeof c.get === 'function' ? c.get('compaction') : null; } catch { /* ignore */ } }
        if (v) return v;
      }
    } catch { /* ignore */ }
    return service('compaction');
  }

  async function compactOnce(sessionId) {
    const agent = agentOf(sessionId);
    if (!agent) throw new Error("agent 不在内存中（会话可能已休眠）");
    const compaction = compactionOf(agent);
    if (!compaction || typeof compaction.compactNow !== "function") throw new Error("compaction.compactNow 不可用（profile 级与会话作用域都没取到）");
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

  async function promptSelf(sessionId, text) {
    const controller = service('sessionController');
    if (!controller || typeof controller.prompt !== "function") throw new Error("sessionController.prompt 不可用");
    const req = {
      requestId: (globalThis.crypto && globalThis.crypto.randomUUID) ? globalThis.crypto.randomUUID() : String(Date.now()),
      sessionId,
      mode: "queue",
      content: [{ type: "text", text }],
    };
    return controller.prompt(req, new AbortController().signal);
  }

  /**
   * 等会话空闲。官方插件规范明确「不要轮询 agent.status」，所以优先用 agent.whenIdle()；
   * 老宿主没有这个方法时，退回 1 秒一次的低频轮询（只在等待期生效，不是常驻轮询）。
   */
  async function waitIdle(agent, ms) {
    if (typeof agent.whenIdle === "function") {
      let timer = null;
      const timedOut = new Promise((resolve) => { timer = later(() => resolve("timeout"), ms); });
      try {
        const r = await Promise.race([Promise.resolve(agent.whenIdle()).then(() => "idle"), timedOut]);
        return r === "idle" && agent.status !== "running";
      } catch {
        return false;
      } finally {
        if (timer) { try { clearTimeout(timer); } catch { /* ignore */ } }
      }
    }
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (agent.status !== "running") return true;
      await new Promise((resolve) => later(resolve, 1000));
    }
    return agent.status !== "running";
  }

  async function attempt(sessionId) {
    const job = pending.get(sessionId);
    if (!job || disposed) return;
    const agent = agentOf(sessionId);
    if (!agent) { fail(sessionId, "会话不在内存，无法压缩"); return; }
    if (agent.status === "running") {
      const idle = await waitIdle(agent, cfg.waitIdleMs || 180000);
      if (!idle) { fail(sessionId, "等了 " + Math.round((cfg.waitIdleMs || 180000) / 1000) + " 秒会话仍未空闲"); return; }
    }
    try {
      const result = await compactOnce(sessionId);
      if (!result) {
        job.done("no-span");
        pending.delete(sessionId);
        return;
      }
      note("compacted " + sessionId + " shadowed=" + (result.shadowedTokenCount || "?"));
      // resume=wait：任务已收尾，压缩后不唤醒，等用户派新任务。
      // resume=continue（默认）：照旧投续跑消息，按交接 §2 继续。
      if (cfg.autoResume !== false && job.resume !== "wait") {
        const text = resumeText(sessionId, job.n);
        try {
          await promptSelf(sessionId, text);
          job.done("ok", result);
        } catch (e) {
          job.done("resume-failed", result);
          note("resume prompt failed: " + e.message);
        }
      } else {
        if (job.resume === "wait") note("resume skipped (wait): " + sessionId);
        job.done(job.resume === "wait" ? "ok-wait" : "ok", result);
      }
      pending.delete(sessionId);
    } catch (e) {
      const code = e && e.code;
      if (code === "busy") {
        if (Date.now() - job.startedAt > (cfg.waitIdleMs || 180000)) { fail(sessionId, "压缩一直 busy（有别的压缩或排队工作）"); return; }
        retryLater(sessionId, 800);
        return;
      }
      job.attempts++;
      if (job.attempts >= (cfg.compactAttempts || 3)) { fail(sessionId, "压缩失败：" + (e.message || code)); return; }
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

  function fail(sessionId, msg) {
    const job = pending.get(sessionId);
    if (job) job.done("failed", null, msg);
    pending.delete(sessionId);
    note("checkpoint failed " + sessionId + ": " + msg);
    try {
      promptSelf(sessionId, "【dsh-handover】压缩未执行：" + msg + "。历史没有被压缩，交接已就绪；请把这条消息原样告诉用户，不要自行重试压缩。").catch(() => {});
    } catch { /* ignore */ }
  }

  /** 登记一次压缩请求；返回 Promise，settle 时给出结果（供工具侧只做登记、不等待）。 */
  function request(sessionId, opts) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (status, result, error) => {
        if (settled) return;
        settled = true;
        resolve({ status, result: result || null, error: error || null, at: Date.now() });
      };
      // 双保险只对「没验过授权」的调用方生效。入口工具（ho_checkpoint、全局代排）已校验并消费了授权，
  // 之后再查必然查不到，压缩会被这一步全部挡掉。
      if (opts.consent !== 'checked') {
        const cs = checkConsent(sessionId);
        if (!cs.ok) {
          note("拒绝压缩 " + sessionId + "：" + cs.reason);
          done("no-consent", null, cs.reason);
          return;
        }
      }
      pending.set(sessionId, { n: opts.n || 0, resume: opts.resume === "wait" ? "wait" : "continue", attempts: 0, done, startedAt: Date.now() });
      retryLater(sessionId, opts.delayMs === undefined ? 600 : opts.delayMs);
    });
  }

  function dispose() {
    disposed = true;
    for (const t of timers.values()) {
      try { clearTimeout(t); } catch { /* ignore */ }
    }
    timers.clear();
    pending.clear();
  }

  return { request, dispose, pending };
}