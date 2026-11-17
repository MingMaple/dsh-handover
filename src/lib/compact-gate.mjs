/**
 * 助手执行入口的前置校验：全部条件满足才允许轮内压缩。
 * 纯函数，便于表格驱动单测。读文件、查锁等副作用由调用方完成。
 *
 * 判定顺序固定：角色 → 压缩计数 → 锚点可写 → 压缩锁 → 排队压缩 → 未闭合工具调用。
 * 顺序决定报错优先级，排在后面的条件被前面的拒绝掩盖，改序会改变提示口径。
 */

/**
 * 判定助手能否在本轮执行压缩。
 * @param {{
 *   sid?:string, role?:string,
 *   anchorPath?:string|null, anchorWritable?:boolean,
 *   lockState?:string, inflight?:boolean, schedulerPending?:boolean,
 *   pendingCompaction?:boolean, pendingToolCalls?:number,
 *   compactionCount?:number, maxCompactions?:number
 * }} input
 * @returns {{ok:boolean, reason:string, checks:Array<{name:string, ok:boolean, detail:string}>}}
 *   reason 依次写现象、原因、处置。checks 记录每项判定的原始取值，供设置页展示。
 */
export function judgeAssistantCompact(input) {
  const i = input || {};
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: ok === true, detail: String(detail || '') });
  const fail = (reason) => ({ ok: false, reason, checks });

  add('角色', i.role && i.role !== 'plain', i.role && i.role !== 'plain' ? '角色 ' + i.role : '普通会话不参与压缩');
  if (!i.role || i.role === 'plain') {
    return fail('现象：本会话为普通会话。原因：普通会话不参与交接与压缩。处置：先由全局会话为本会话指定角色，再压缩。');
  }

  const count = Number(i.compactionCount);
  const max = Number(i.maxCompactions);
  if (Number.isFinite(count) && Number.isFinite(max) && max > 0 && count >= max) {
    add('压缩计数', false, count + '/' + max);
    return fail('现象：压缩计数已达上限 ' + count + '/' + max + '，助手入口不再压缩。'
      + '原因：本会话允许的压缩次数已用尽。'
      + '处置：（1）调用 ho_handover(action="rotate", text=…) 归档旧交接并写入新正文；'
      + '（2）请用户授权：聊天框发送 /allow-reset，或在设置页点击「授权重置」；'
      + '（3）调用 ho_sessions(action="succeed") 完成换任。');
  }
  add('压缩计数', true, Number.isFinite(count) && Number.isFinite(max) && max > 0 ? count + '/' + max : '未核');

  const anchorPath = String(i.anchorPath || '');
  const anchorOk = !!anchorPath && i.anchorWritable !== false;
  add('锚点可写', anchorOk, anchorPath ? (i.anchorWritable === false ? anchorPath + '（目录不可写）' : anchorPath) : '本会话没有锚点路径');
  if (!anchorOk) {
    const why = anchorPath ? '目录无法创建（' + anchorPath + '）' : '本会话没有锚点路径';
    return fail('现象：锚点不可写。原因：' + why + '。处置：确认会话目录可写后重试。');
  }

  const lock = String(i.lockState || 'clean');
  add('压缩锁', lock === 'clean', lock);
  if (lock !== 'clean') {
    return fail('现象：存在未闭合的压缩锁（' + lock + '）。原因：上一次压缩开启后没有收尾。处置：先处理压缩锁，再压缩。');
  }

  const busy = i.inflight === true || i.schedulerPending === true || i.pendingCompaction === true;
  add('排队压缩', !busy, busy ? '已有进行中或排队的压缩' : '无');
  if (busy) {
    return fail('现象：已有进行中或排队的压缩。原因：同一会话不能并发压缩。处置：等本次压缩结束后重试。');
  }

  const calls = Number(i.pendingToolCalls);
  const balanced = !Number.isFinite(calls) || calls <= 1;
  add('未闭合工具调用', balanced, Number.isFinite(calls) ? String(calls) + ' 个' : '未核');
  if (!balanced) {
    return fail('现象：存在 ' + calls + ' 个未闭合的工具调用。原因：切点落在工具调用中间会丢掉配对的结果。处置：等工具结果闭合后再压缩。');
  }

  return { ok: true, reason: '前置校验通过', checks };
}
