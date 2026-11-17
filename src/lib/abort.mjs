/**
 * 工具调用级中止：宿主在 exec.signal 上给出本次调用的中止信号。
 * 用户点击「终止」时触发，中止只让本次调用提前返回。
 * 已发出的消息不撤回，已建成的会话不回滚，已写入的交接与快照保留。
 */

/** 中止后的统一返回文案。 */
export const ABORTED_TEXT =
  '已中止：本次工具调用被用户终止，等待环节已提前返回。已发出的消息不撤回；已建成的会话不回滚；已写入的交接与快照保留。';

/** 从工具 exec 取中止信号。老宿主或命令行路径没有该信号时返回 null。 */
export function signalOf(exec) {
  const sig = exec === null || exec === undefined ? null : exec.signal;
  return sig !== null && sig !== undefined && typeof sig.aborted === 'boolean' ? sig : null;
}

/** 是否已经中止。 */
export function aborted(signal) {
  return signal !== null && signal !== undefined && signal.aborted === true;
}

/**
 * 可中止的等待：到时返回 'timeout'，被中止返回 'aborted'。
 * 没有信号时退化为普通定时器，行为与原先一致。
 */
export function abortableDelay(ms, signal) {
  if (aborted(signal)) return Promise.resolve('aborted');
  if (signal === null || signal === undefined || typeof signal.addEventListener !== 'function') {
    return new Promise((resolve) => {
      setTimeout(() => resolve('timeout'), ms);
    });
  }
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (why) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      try {
        signal.removeEventListener('abort', onAbort);
      } catch (error) {
        void error;
      }
      resolve(why);
    };
    const onAbort = () => finish('aborted');
    signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => finish('timeout'), ms);
  });
}
