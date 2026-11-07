/** 阶段决策：纯函数，便于单测。 */

/**
 * @param {{ratio:number|null, compactionsUsed:number, cfg:object, lockState:string}} input
 * @returns {{action:string, reason:string}}
 *   action ∈ continue | pause | checkpoint | new_session | force_compact | blocked | unknown
 */
export function decide(input) {
  const cfg = input.cfg || {};
  const warn = cfg.warnRatio === undefined ? 0.32 : cfg.warnRatio;
  const handover = cfg.handoverRatio === undefined ? 0.35 : cfg.handoverRatio;
  const hard = cfg.hardRatio === undefined ? 0.85 : cfg.hardRatio;
  const maxComp = cfg.maxCompactions === undefined ? 3 : cfg.maxCompactions;
  const used = typeof input.compactionsUsed === 'number' ? input.compactionsUsed : 0;
  if (input.lockState === 'orphaned') {
    return { action: 'blocked', reason: '检测到未闭合的压缩锁（compaction/start 无配对 end）：先处理再排新压缩' };
  }
  if (input.ratio === null || input.ratio === undefined) {
    return { action: 'unknown', reason: '水位读不到：人工判断，不要盲目压缩' };
  }
  if (input.ratio >= hard) {
    if (used >= maxComp) return { action: 'new_session', reason: '已到硬顶且压缩额度用尽，应写交接并建新会话' };
    return { action: 'force_compact', reason: '已到硬顶（' + Math.round(hard * 100) + '%）：强制压缩兜底，哪怕任务中途' };
  }
  if (input.ratio >= handover) {
    if (used >= maxComp) return { action: 'new_session', reason: '已压缩 ' + used + '/' + maxComp + ' 次：写交接并建新会话（现行流程）' };
    return { action: 'checkpoint', reason: '过交接线（' + Math.round(handover * 100) + '%）：写交接，随后压缩，再读交接续跑' };
  }
  if (input.ratio >= warn) {
    if (used >= maxComp) return { action: 'new_session', reason: '已压缩 ' + used + '/' + maxComp + ' 次：到线即走换会话' };
    return { action: 'pause', reason: '过提醒线（' + Math.round(warn * 100) + '%）：建议在阶段完成处调 ho_checkpoint（关键步骤返回 pause）' };
  }
  return { action: 'continue', reason: '水位正常' };
}