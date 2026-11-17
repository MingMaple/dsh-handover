/**
 * 测试脚本共用的 reporter：ok / section 的输出格式与失败收集。
 * sink='array' 时只入内存（脚本末尾一次性打印）；sink='stdout' 时逐条打印。
 * style 决定用例前缀：blank（  ok / FAIL，:: 分隔）、plain（通过/未通过，→ 分隔）、silent（只记失败）。
 */
export function makeReporter(opts) {
  const o = opts || {};
  const buffered = o.sink === 'array';
  const style = o.style || (buffered ? 'blank' : 'plain');
  const sep = style === 'blank' ? ' :: ' : ' → ';
  const esc = String.fromCharCode(27);
  const green = esc + '[32m';
  const red = esc + '[31m';
  const reset = esc + '[0m';
  const lines = [];
  const fails = [];

  function emit(s) {
    if (buffered) lines.push(s);
    else console.log(s);
  }

  function ok(cond, label, extra) {
    if (cond) {
      if (style === 'blank') emit('  ' + green + 'ok' + reset + ' ' + label);
      else if (style === 'plain') emit('  通过 ' + label);
      return;
    }
    fails.push(label + (extra ? sep + extra : ''));
    if (style === 'blank') emit('  ' + red + 'FAIL' + reset + ' ' + label + (extra ? sep + extra : ''));
    else if (style === 'plain') emit('  未通过 ' + label + (extra ? sep + extra : ''));
  }

  function section(t) {
    emit('');
    emit('== ' + t + ' ==');
  }

  return { ok, section, fails, lines };
}
