/**
 * 压力遥测：纯函数，输入固定、输出固定，便于表格驱动单测。
 *
 * 口径：3 档＝当前窗口 × 35%／50%／65%，不扣预留输出、不设绝对预算。
 * 窗口读不到（非有效正数/为空）时不判定：bandsFor 返回 null，judgeLevel 返回 unknown，
 * 由上层显示「不判定」，不再退回 80K/120K/180K 兜底。
 * reservedOutput 只用于余量展示（headroom），不参与分档。结果单调不减；宿主线只读观测，不参与判定。
 */

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function pickNum(v, dflt) {
  const n = num(v);
  return n === null ? dflt : n;
}

/** 可用窗口：窗口减预留输出，只用于余量展示，不参与分档；窗口非法或非正时返回 0。 */
export function usableWindow(win, cfg) {
  const w = num(win);
  if (w === null || w <= 0) return 0;
  const reserved = pickNum(cfg && cfg.reservedOutput, 0);
  return Math.max(0, Math.round(w - reserved));
}

/** 分档线：返回 { usable, soft, advise, hard, host }，单位为 token；窗口读不到时返回 null。 */
export function bandsFor(cfg, win) {
  const c = cfg || {};
  const w = num(win);
  if (w === null || w <= 0) return null;
  // 3 档直接按当前窗口比例计算；预留输出只影响余量展示，不参与分档。
  const usable = Math.round(w);
  let soft = usable * pickNum(c.softRatio, 0.35);
  let advise = usable * pickNum(c.adviseRatio, 0.5);
  let hard = usable * pickNum(c.hardRatioCap, 0.65);
  // 取整后校正单调性：配置异常时也不得出现高档位低于低档位。
  soft = Math.max(0, Math.round(soft));
  advise = Math.max(soft, Math.round(advise));
  hard = Math.max(advise, Math.round(hard));
  const host = Math.max(0, Math.round(pickNum(c.hostSummaryRatio, 0.8) * usable));
  return { usable, soft, advise, hard, host };
}

/** 档位判定：返回 { level, ratio, headroom }；used 或窗口非法时 level 为 unknown。 */
export function judgeLevel(input) {
  const o = input || {};
  const used = num(o.used);
  const win = num(o.win);
  if (used === null || used < 0 || win === null || win <= 0) {
    return { level: 'unknown', ratio: null, headroom: null };
  }
  const c = o.cfg || {};
  const ratio = used / win;
  const headroom = Math.max(0, win - used - pickNum(c.reservedOutput, 0));
  const bands = bandsFor(c, win);
  if (!bands) return { level: 'unknown', ratio: null, headroom: null };
  const level = used >= bands.hard ? 'hard'
    : used >= bands.advise ? 'advise'
      : used >= bands.soft ? 'soft' : 'low';
  return { level, ratio, headroom };
}

/** 增速：取最近 4 个样本形成的 3 个增量，返回中位数；样本不足返回 null。 */
export function growthOf(history) {
  const rows = Array.isArray(history)
    ? history
      .filter((x) => x && num(x.at) !== null && num(x.used) !== null)
      .map((x) => ({ at: x.at, used: x.used }))
    : [];
  if (rows.length < 4) return null;
  rows.sort((a, b) => a.at - b.at);
  const deltas = [];
  for (let i = rows.length - 3; i < rows.length; i++) deltas.push(rows[i].used - rows[i - 1].used);
  deltas.sort((a, b) => a - b);
  return Math.round(deltas[1]);
}

/** 压缩收益：缩减比 (before−after)/before；输入非法或 before 不大于 0 时返回 null。 */
export function roiOf(before, after) {
  const b = num(before);
  const a = num(after);
  if (b === null || a === null || b <= 0) return null;
  return (b - a) / b;
}

/** 连续低收益次数：从最近一次往前数，收益低于 floor 的连续次数。 */
export function lowRoiStreakOf(history, floor) {
  const limit = num(floor);
  if (limit === null) return 0;
  const rows = Array.isArray(history) ? history.filter((x) => num(x) !== null) : [];
  let streak = 0;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i] < limit) streak += 1;
    else break;
  }
  return streak;
}

/**
 * 压缩后读数校准（D-171）：压缩返回瞬间的测量是中间态，改由下一个步骤边界用宿主投影水位补写。
 * 待校准记录只消费一次：无论本次读到的水位是否可用，调用后都删掉 pendingAfter；
 * 读不到可信值时只清空记录并留空，不填假数，也不追加 roiHistory。
 * @param {object} st 会话状态
 * @param {number|null} used 宿主投影水位
 * @param {number} floor 收益下限
 * @returns {{consumed:boolean, measured:boolean, roi:number|null, streak:number}}
 */
export function settlePendingAfter(st, used, floor) {
  const state = st && typeof st === 'object' ? st : {};
  const pending = state.pendingAfter && typeof state.pendingAfter === 'object' ? state.pendingAfter : null;
  const streak = Number(state.lowRoiStreak) || 0;
  if (!pending) return { consumed: false, measured: false, roi: null, streak };
  delete state.pendingAfter;
  const after = num(used);
  if (after === null || after <= 0) return { consumed: true, measured: false, roi: null, streak };
  const roi = roiOf(pending.before, after);
  state.tokensAfter = after;
  state.roi = roi;
  if (roi !== null) {
    state.roiHistory = (Array.isArray(state.roiHistory) ? state.roiHistory : []).concat([roi]).slice(-3);
  }
  state.lowRoiStreak = lowRoiStreakOf(state.roiHistory, floor);
  return { consumed: true, measured: true, roi, streak: state.lowRoiStreak };
}

/** 把投影缓存里的水位读法规整成 { used, win }：非法值一律 null，窗口不大于 0 视为读不到。 */
export function normWater(self) {
  const s = self || {};
  const used = typeof s.used === 'number' && Number.isFinite(s.used) ? s.used : null;
  const win = typeof s.win === 'number' && Number.isFinite(s.win) && s.win > 0 ? s.win : null;
  return { used, win };
}

/** 压力画像：汇总水位、分档、档位、增速与剩余轮数。 */
export function pressureOf(input) {
  const o = input || {};
  const c = o.cfg || {};
  const lv = judgeLevel({ used: o.used, win: o.win, cfg: c });
  const bands = bandsFor(c, o.win);
  const growth = growthOf(o.history);
  const used = num(o.used);
  const win = num(o.win);
  const remainingTurns = bands && growth !== null && growth > 0 && used !== null && lv.level !== 'unknown'
    ? Math.max(0, Math.floor((bands.hard - used) / growth))
    : null;
  return {
    used,
    win: win !== null && win > 0 ? win : null,
    ratio: lv.ratio,
    headroom: lv.headroom,
    bands,
    level: lv.level,
    growth,
    remainingTurns,
  };
}
