/**
 * 压缩判据：全部为纯函数，输入固定、输出固定，便于表格驱动单测。
 *
 * 分档以 token 计量：soft（整理线）只提示、advise（建议线）再次提示、hard（强制线）由插件兜底压缩。
 * 判定压缩的权力归助手。插件不代替助手判断何时压缩，只在到线时提示。
 * 宏观重置的 4 条条件保留为追加提示理由，不替代压缩计数。
 */
import { bandsFor } from './pressure.mjs';

/** 宏观重置默认门槛。 */
const MACRO_WINDOW_FACTOR = 2;
const MACRO_GAIN_RATIO = 0.5;
const MACRO_REPEAT = 2;

function num(value, dflt) {
  return typeof value === 'number' && Number.isFinite(value) ? value : dflt;
}

function kText(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '未核';
  return Math.round(value / 1000) + 'K';
}

/**
 * 宏观重置判定：4 条条件任一命中即成立。判定结果只作追加提示理由，不替代计数。
 * @param {{cumulativeShadowedTokens?:number, windowTokens?:number, compactionGainRatio?:number,
 *   repeatErrors?:number, repeatFiles?:number, milestone?:boolean, userRequest?:boolean,
 *   used?:number, bands?:object}} input
 */
export function judgeMacroReset(input) {
  const i = input || {};
  const window = num(i.windowTokens, 0);
  const shadow = num(i.cumulativeShadowedTokens, 0);
  const gain = typeof i.compactionGainRatio === 'number' ? i.compactionGainRatio : null;
  const errors = num(i.repeatErrors, 0);
  const files = num(i.repeatFiles, 0);
  const conditions = {
    shadowed: window > 0 && shadow >= window * MACRO_WINDOW_FACTOR,
    gain: gain !== null && gain < MACRO_GAIN_RATIO,
    repeat: errors >= MACRO_REPEAT || files >= MACRO_REPEAT,
    milestone: i.milestone === true || i.userRequest === true,
  };
  const reasons = [];
  if (conditions.shadowed) reasons.push('累计遮蔽 ' + shadow + ' token，达到窗口的 ' + MACRO_WINDOW_FACTOR + ' 倍');
  if (conditions.gain) reasons.push('压缩增量比 ' + gain.toFixed(2) + ' 低于 ' + MACRO_GAIN_RATIO);
  if (conditions.repeat) reasons.push('同错或同文件重复：错误 ' + errors + ' 次，文件 ' + files + ' 次');
  if (conditions.milestone) reasons.push(i.userRequest === true ? '用户要求重置' : '到达里程碑');
  // 水位低于整理线时，条件只记录不提示；否则低水位会话会反复向用户索要授权。
  const used = num(i.used, null);
  const bands = i.bands || null;
  const low = used !== null && bands && used < bands.soft;
  if (reasons.length && low && i.userRequest !== true && i.milestone !== true) {
    return { hit: false, reasons: ['水位 ' + kText(used) + ' 低于整理线 ' + kText(bands.soft) + '：条件只记录，不提示'], conditions, muted: true };
  }
  return { hit: reasons.length > 0, reasons, conditions };
}

/**
 * 强制线判定：按分档的 hard 值比较。
 * @param {{used:number|null, bands?:object}} input
 */
export function judgeHardCap(input) {
  const i = input || {};
  const bands = i.bands || null;
  const hard = bands ? bands.hard : 0;
  const used = num(i.used, null);
  if (used === null || !bands) return { hit: false, hard };
  return { hit: used >= hard, hard };
}

/**
 * 档位判定：只看水位落在哪一分档，不处理闸门与去重。
 * @param {{used:number|null, win?:number, bands?:object, cfg?:object}} input
 * @returns {{action:'idle'|'notifySoft'|'notifyAdvise'|'force', line:number, reason:string}}
 */
export function judgeTier(input) {
  const i = input || {};
  const win = num(i.win, null);
  const bands = i.bands || (win !== null ? bandsFor(i.cfg || {}, win) : null);
  const used = num(i.used, null);
  if (!bands || used === null) {
    return { action: 'idle', line: bands ? bands.soft : 0, reason: '水位或窗口读不到：不判定' };
  }
  if (used >= bands.hard) return { action: 'force', line: bands.hard, reason: '水位 ' + kText(used) + ' 已到强制线 ' + kText(bands.hard) };
  if (used >= bands.advise) return { action: 'notifyAdvise', line: bands.advise, reason: '水位 ' + kText(used) + ' 已到建议线 ' + kText(bands.advise) };
  if (used >= bands.soft) return { action: 'notifySoft', line: bands.soft, reason: '水位 ' + kText(used) + ' 已到整理线 ' + kText(bands.soft) };
  return { action: 'idle', line: bands.soft, reason: '水位 ' + kText(used) + ' 未到整理线 ' + kText(bands.soft) };
}

/**
 * 步骤边界判定：闸门顺序为不在轮次内、压缩锁未闭合、冷却中、水位未知；再过档位与去重。
 * inTurn 必须为 true：空闲会话没有步骤边界，不参与判定。
 * @param {{used:number|null, win?:number, bands?:object, cfg?:object, lockState?:string,
 *   cooldownLeftMs?:number, inTurn?:boolean, notifiedSoft?:boolean, notifiedAdvise?:boolean}} input
 */
export function judgeTrigger(input) {
  const i = input || {};
  const tier = judgeTier(i);
  if (i.inTurn !== true) return { action: 'idle', line: tier.line, reason: '会话不在轮次内：空闲会话不判定' };
  if (i.lockState === 'open') {
    return { action: 'idle', line: tier.line, reason: '压缩锁未闭合：先处理压缩锁' };
  }
  if (num(i.cooldownLeftMs, 0) > 0) {
    return { action: 'idle', line: tier.line, reason: '冷却中，剩余 ' + Math.ceil(num(i.cooldownLeftMs, 0) / 1000) + ' 秒' };
  }
  if (tier.action === 'idle' && tier.reason.indexOf('读不到') !== -1) {
    return { action: 'idle', line: tier.line, reason: '水位读不到：不判定，等下一个步骤边界' };
  }
  if (tier.action === 'notifySoft' && i.notifiedSoft === true) {
    return { action: 'idle', line: tier.line, reason: '整理线已提示过，压缩成功后重置' };
  }
  if (tier.action === 'notifyAdvise' && i.notifiedAdvise === true) {
    return { action: 'idle', line: tier.line, reason: '建议线已提示过，压缩成功后重置' };
  }
  return tier;
}

/**
 * 阶段决策：纯函数，供 ho_status 与单测共用。
 * @param {{used:number|null, win?:number, bands?:object, cfg?:object, lockState?:string,
 *   macro?:{hit:boolean,reasons:string[]}, snapshot?:{needed:boolean,reasons:string[]}}} input
 * @returns {{action:string, reason:string}}
 *   action 属于 continue | snapshot | notify | force | blocked | unknown
 */
export function decidePhase(input) {
  const i = input || {};
  const cfg = i.cfg || {};
  if (i.lockState === 'open') {
    return { action: 'blocked', reason: '检测到未闭合的压缩锁（compaction/start 无配对 end）：先处理压缩锁，再判压缩' };
  }
  const used = num(i.used, null);
  if (used === null) return { action: 'unknown', reason: '水位读不到：需人工判断，不得盲目压缩' };
  const bands = i.bands || (num(i.win, null) !== null ? bandsFor(cfg, i.win) : null);
  if (!bands) return { action: 'unknown', reason: '窗口读不到：无法换算分档线，需人工判断' };
  const hard = judgeHardCap({ used, bands });
  if (hard.hit) {
    return { action: 'force', reason: '已到强制线 ' + kText(hard.hard) + '：插件立即强制压缩，任务中途亦同' };
  }
  const tier = judgeTier({ used, win: i.win, bands, cfg });
  if (tier.action === 'notifyAdvise' || tier.action === 'notifySoft') {
    return { action: 'notify', reason: tier.reason + '：提示助手先停在安全断点、按标准写胶囊，再调用压缩，插件不压缩' };
  }
  // 当前无调用方传入 snapshot，保留为扩展点：将来若增加事件级快照，在此接入。
  if (i.snapshot && i.snapshot.needed === true) {
    return { action: 'snapshot', reason: '微快照事件命中：' + (i.snapshot.reasons || []).join('；') };
  }
  const extra = i.macro && i.macro.hit === true ? '；追加提示理由：' + (i.macro.reasons || []).join('；') : '';
  return { action: 'continue', reason: '未到整理线 ' + kText(tier.line) + '；提前压缩仅在助手判断为安全断点、写完胶囊后调用 ho_handover(action="compact", capsule=…)' + extra };
}
