/**
 * 自触发早退留痕：同一会话、同一原因 5 分钟内只写一条，避免每步重复写日志。
 * 触发未介入时，日志必须能回答「为什么没介入」。
 *
 * 单独成模块是为了可核验：selftest 用假时钟直接跑去重规则，不必启动插件。
 */

/**
 * 建一个带去重的留痕函数。
 * @param {object} opts 可选项
 * @param {number} [opts.ttlMs] 去重窗口，缺省 5 分钟
 * @param {number} [opts.maxKeys] 键上限，超出时先清理过期键，缺省 200
 * @param {Function} [opts.now] 取当前时刻，便于测试注入假时钟
 * @param {Function} [opts.write] 落日志的函数，收到一行文本；抛错被视为留痕失败，不影响主流程
 * @param {Function} [opts.pct] 把比例（0–1）转成百分比文本，缺省按整数百分比
 * @returns {Function} note(sid, reason, ratio)：真的写了一条返回 true，被去重挡下返回 false
 */
export function createSkipLogger(opts) {
  const o = opts || {};
  const ttlMs = Number(o.ttlMs) > 0 ? Number(o.ttlMs) : 300000;
  const maxKeys = Number(o.maxKeys) > 0 ? Number(o.maxKeys) : 200;
  const now = typeof o.now === 'function' ? o.now : Date.now;
  const write = typeof o.write === 'function' ? o.write : function noop() {};
  const pct = typeof o.pct === 'function' ? o.pct
    : (v) => (v === null || v === undefined ? '?' : String(Math.round(v * 100)));
  const seen = new Map();

  return function noteTriggerSkip(sid, reason, ratio) {
    const key = String(sid || '-') + '|' + reason;
    const at = seen.get(key);
    const t = now();
    if (at !== undefined && t - at < ttlMs) return false;
    if (at === undefined && seen.size >= maxKeys) {
      for (const [k, v] of seen) {
        if (t - v >= ttlMs) seen.delete(k);
      }
      // 全未过期时按插入顺序淘汰最旧键：Map 必须有界（D-126）。
      while (seen.size >= maxKeys) {
        const oldest = seen.keys().next();
        if (oldest.done) break;
        seen.delete(oldest.value);
      }
    }
    seen.set(key, t);
    try {
      write('自触发跳过 sid=' + (sid || '-') + ' reason=' + reason + ' ratio=' + pct(ratio));
    } catch (error) {
      void error;   // 留痕失败只丢一行日志，去重状态已写入，主流程继续
    }
    return true;
  };
}
