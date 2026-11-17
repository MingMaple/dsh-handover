/**
 * 轮内压缩：在 agent/pre-step 步骤边界同步调用宿主压缩引擎的 compactRegion。
 * compactNow 只在空闲时可用，不能用于轮内。
 * compactRegion 的 owner=current-turn，与宿主自身的步骤边界压缩走同一路径。
 * 因此压缩后本步骤继续，不新开轮次。
 */

export const INLINE_UNAVAILABLE = 'INLINE_UNAVAILABLE';
export const INLINE_NO_METER = 'INLINE_NO_METER';
const INLINE_TIMEOUT = 'INLINE_TIMEOUT';

class InlineCompactionError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'InlineCompactionError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

/**
 * 服务解析：优先 agent 作用域，其次 profile 作用域。
 * 作用域可能是属性直取，也可能是 get() 取，任一取法都可能抛错，因此逐个吞掉错误并按序降级。
 * 全部取不到时返回 null，由调用方决定该能力是否停用。
 */
export function serviceOf(ctx, agent, name) {
  try {
    const c = agent && agent.ctx;
    if (c) {
      let v = null;
      try { v = c[name]; } catch { /* ignore */ }
      if (!v) { try { v = typeof c.get === 'function' ? c.get(name) : null; } catch { /* ignore */ } }
      if (v) return v;
    }
  } catch { /* ignore */ }
  try {
    const v = ctx && ctx[name];
    if (v) return v;
  } catch { /* ignore */ }
  try { return ctx && typeof ctx.get === 'function' ? ctx.get(name) : null; } catch { return null; }
}

export function compactionOf(ctx, agent) {
  return serviceOf(ctx, agent, 'compaction');
}

function tokenMeterOf(ctx, agent) {
  return serviceOf(ctx, agent, 'tokenMeter');
}

/** 一条表面事件让未闭合的工具调用计数如何变化。 */
function eventDelta(event) {
  if (!event || typeof event.type !== 'string') return 0;
  if (event.type === 'assistant/message') {
    const content = event.data && event.data.message ? event.data.message.content : null;
    if (!Array.isArray(content)) return 0;
    let n = 0;
    for (const block of content) if (block && block.type === 'tool-call') n += 1;
    return n;
  }
  if (event.type === 'tool/result') return -1;
  return 0;
}

/** 表面序列 seq 之前的切点是否不跨未闭合的工具调用。 */
function balancedBefore(session, seq) {
  const nodes = session && session.surface ? session.surface.nodes || [] : [];
  const target = nodes.indexOf(seq);
  if (target === -1) return false;
  let pending = 0;
  for (let i = 0; i < target; i++) {
    let event = null;
    try { event = session.eventAt(nodes[i]); } catch { event = null; }
    if (!event || event.seq !== nodes[i]) return false;
    pending += eventDelta(event);
    if (pending < 0) return false;
  }
  return pending === 0;
}

/**
 * 选择压缩范围：跳过表面第一个系统消息，保留尾部，切点必须平衡。
 * 保留量的取值规则：在下列各项中取最大值。
 * 第一项为 used×(1−shadowTarget)。
 * 其余为最近 keepMinMessages 条消息的 token 和，以及 minKeepTokens。
 * 保留量不超过 used 的 60%，以免压缩后仍超出阈值。
 * 在理想切点 ±15% 内优先选用户消息起点，其次轮末，再次任意平衡位置。
 * 切点平衡指不跨未闭合的工具调用；跨过去会丢掉与调用配对的结果。
 * 返回 { start, end, keptTokens, shadowTokens }；选不出返回 null。
 */
export function selectCompactionRange(session, measurement, plan) {
  if (!session || !session.surface || !measurement || !Array.isArray(measurement.nodes)) return null;
  const priced = measurement.nodes;
  const surface = session.surface.nodes || [];
  if (priced.length === 0 || priced.length !== surface.length) return null;
  for (let i = 0; i < surface.length; i++) {
    if (!priced[i] || priced[i].seq !== surface[i]) return null;
  }
  const head = eventOf(session, surface[0]);
  const firstIdx = head && head.type === 'system/message' ? 1 : 0;
  if (firstIdx >= surface.length - 1) return null;

  const tokens = priced.map((node) => Number(node.tokens) || 0);
  const sum = tokens.reduce((a, b) => a + b, 0);
  const used = Number.isFinite(measurement.totalTokens) && measurement.totalTokens > 0
    ? measurement.totalTokens : sum;
  if (!(used > 0)) return null;

  const p = plan || {};
  const shadowTarget = Number.isFinite(p.shadowTarget) && p.shadowTarget >= 0 && p.shadowTarget < 1
    ? p.shadowTarget : 0.55;
  const keepMinMessages = Number.isFinite(p.keepMinMessages) && p.keepMinMessages > 0
    ? Math.floor(p.keepMinMessages) : 20;
  const minKeepTokens = Number.isFinite(p.minKeepTokens) && p.minKeepTokens > 0 ? p.minKeepTokens : 8000;

  let lastNTokens = 0;
  for (let i = surface.length - 1; i >= 0 && i >= surface.length - keepMinMessages; i -= 1) lastNTokens += tokens[i];
  const keep = Math.min(used * 0.6, Math.max(used * (1 - shadowTarget), lastNTokens, minKeepTokens));
  if (!(keep > 0)) return null;

  // 后缀和：suffix[i] 为第 i 条起到末尾的 token 合计。
  // 预先算好后，任一候选切点的保留量都能常数时间取得，不必逐个切点重新累加。
  const suffix = new Array(surface.length + 1);
  suffix[surface.length] = 0;
  for (let i = surface.length - 1; i >= 0; i -= 1) suffix[i] = suffix[i + 1] + tokens[i];

  let ideal = -1;
  for (let i = firstIdx + 1; i < surface.length; i += 1) {
    if (suffix[i] >= keep) { ideal = i; break; }
  }
  if (ideal === -1) return null;

  const tolerance = keep * 0.15;
  let low = ideal;
  while (low > firstIdx + 1 && suffix[low - 1] <= keep + tolerance) low -= 1;
  let high = ideal;
  while (high < surface.length - 1 && suffix[high + 1] >= keep - tolerance) high += 1;

  let best = null;
  for (let i = low; i <= high; i += 1) {
    if (Math.abs(suffix[i] - keep) > tolerance) continue;
    if (!balancedBefore(session, surface[i])) continue;
    const priority = cutPriority(eventOf(session, surface[i]));
    const distance = Math.abs(suffix[i] - keep);
    if (!best || priority < best.priority || (priority === best.priority && distance < best.distance)) {
      best = { index: i, priority, distance };
    }
  }
  if (!best) return null;

  const cut = best.index;
  return {
    start: surface[firstIdx],
    end: surface[cut - 1],
    keptTokens: suffix[cut],
    shadowTokens: suffix[firstIdx] - suffix[cut],
  };
}

/** 切点优先级：用户消息起点最优，轮末次之，其余第三。 */
function cutPriority(event) {
  if (event && event.type === 'user/message') return 0;
  if (event && event.type === 'turn/end') return 1;
  return 2;
}

function eventOf(session, seq) {
  try { return session.eventAt(seq); } catch { return null; }
}

function anySignal(signals) {
  const list = signals.filter(Boolean);
  if (list.length === 0) return undefined;
  if (list.length === 1) return list[0];
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(list);
  const ac = new AbortController();
  const stop = (event) => ac.abort(event && event.target ? event.target.reason : undefined);
  for (const s of list) {
    if (s.aborted) { ac.abort(s.reason); break; }
    s.addEventListener('abort', stop, { once: true });
  }
  return ac.signal;
}

/**
 * 轮内同步压缩：不投用户消息，不改变轮次。
 * @param {object} plan {shadowTarget, keepMinMessages, minKeepTokens, boundary, mode}
 * @returns {Promise<{status:'ok',range:object,result:object,tokensBefore:number|null,tokensAfter:number|null}|{status:'no-range'}>}
 */
export async function compactInTurn(ctx, agent, cfg, signal, plan) {
  const compaction = compactionOf(ctx, agent);
  if (!compaction || typeof compaction.compactRegion !== 'function') {
    throw new InlineCompactionError(
      INLINE_UNAVAILABLE,
      '现象：compaction.compactRegion 不可用。原因：agent 作用域与 profile 作用域均未取到该服务。处置：升级宿主，或改用轮间压缩。',
    );
  }
  const meter = tokenMeterOf(ctx, agent);
  if (!meter || typeof meter.measure !== 'function') {
    throw new InlineCompactionError(
      INLINE_NO_METER,
      '现象：tokenMeter.measure 不可用。原因：agent 作用域与 profile 作用域均未取到该服务。处置：升级宿主，或改用轮间压缩。',
    );
  }
  const session = agent && agent.session;
  if (!session) return { status: 'no-range', reason: 'no-session' };
  let header;
  try { header = typeof session.requestHeader === 'function' ? session.requestHeader() : undefined; } catch { header = undefined; }
  const measurement = header ? meter.measure(session, header) : meter.measure(session);
  if (!measurement || !Array.isArray(measurement.nodes) || measurement.nodes.length !== session.surface.nodes.length) {
    return { status: 'no-range', reason: 'surface-mismatch' };
  }
  const tokensBefore = typeof measurement.totalTokens === 'number' ? measurement.totalTokens : null;
  const options = plan || {};
  const range = selectCompactionRange(session, measurement, {
    shadowTarget: options.shadowTarget !== undefined ? options.shadowTarget : (cfg && cfg.shadowTarget),
    keepMinMessages: options.keepMinMessages !== undefined ? options.keepMinMessages : (cfg && cfg.keepMinMessages),
    minKeepTokens: options.minKeepTokens !== undefined ? options.minKeepTokens : (cfg && cfg.minKeepTokens),
    boundary: options.boundary,
  });
  if (!range) return { status: 'no-range', reason: 'retained-all' };

  const timeoutMs = cfg && cfg.compactTimeoutMs ? cfg.compactTimeoutMs : 120000;
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ac.abort(new Error('timeout')); }, timeoutMs);
  // 压缩是后台动作，定时器不应拖住进程退出，因此调用 unref；宿主不支持时忽略。
  if (timer && typeof timer.unref === 'function') timer.unref();
  try {
    const result = await compaction.compactRegion(range.start, range.end, agent, anySignal([signal, ac.signal]));
    let tokensAfter = null;
    try {
      let header2;
      try { header2 = typeof session.requestHeader === 'function' ? session.requestHeader() : undefined; } catch { header2 = undefined; }
      const after = header2 ? meter.measure(session, header2) : meter.measure(session);
      if (after && typeof after.totalTokens === 'number') tokensAfter = after.totalTokens;
    } catch { tokensAfter = null; }
    return { status: 'ok', range, result, tokensBefore, tokensAfter };
  } catch (e) {
    if (timedOut && !(signal && signal.aborted)) {
      throw new InlineCompactionError(INLINE_TIMEOUT, '现象：轮内压缩超时。原因：超过 ' + timeoutMs + ' ms 仍未返回。处置：缩短压缩范围后重试。', e);
    }
    throw e;
  } finally {
    try { clearTimeout(timer); } catch { /* ignore */ }
  }
}
