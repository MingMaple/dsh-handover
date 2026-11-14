/** 阶段决策：纯函数，便于单测。 */

/**
 * @param {{ratio:number|null, compactionsUsed:number, cfg:object, lockState:string}} input
 * @returns {{action:string, reason:string}}
 *   action ∈ continue | checkpoint | force_compact | new_session | blocked | unknown
 */
export function decide(input) {
  const cfg = input.cfg || {};
  const handover = cfg.handoverRatio === undefined ? 0.35 : cfg.handoverRatio;
  const hard = cfg.hardRatio === undefined ? 0.85 : cfg.hardRatio;
  const maxComp = cfg.maxCompactions === undefined ? 3 : cfg.maxCompactions;
  const used = typeof input.compactionsUsed === 'number' ? input.compactionsUsed : 0;
  if (input.lockState === 'orphaned') {
    return { action: 'blocked', reason: '检测到未闭合的压缩锁（compaction/start 无配对 end）：先处理压缩锁，再排新压缩' };
  }
  // 额度用尽优先于水位判定：3 次压满后再压不是「水位没到」，而是该换任了。
  if (used >= maxComp) {
    return { action: 'new_session', reason: '已压缩 ' + used + '/' + maxComp + ' 次：压缩额度用尽，应写交接并新建会话' };
  }
  if (input.ratio === null || input.ratio === undefined) {
    return { action: 'unknown', reason: '水位读不到：需人工判断，不得盲目压缩' };
  }
  if (input.ratio >= hard) {
    return { action: 'force_compact', reason: '已到硬顶（' + Math.round(hard * 100) + '%）：应强制压缩，任务中途亦同' };
  }
  if (input.ratio >= handover) {
    return { action: 'checkpoint', reason: '已过可压缩线（' + Math.round(handover * 100) + '%）：先刷新交接，再登记压缩' };
  }
  return { action: 'continue', reason: '水位可继续；提前压缩仅在助手建议，或当前用户主动要求并授权时进行' };
}
