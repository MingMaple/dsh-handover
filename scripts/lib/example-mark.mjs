/**
 * [@example] 窄豁免：设置页话术示例保留口语，语气词按行放行。
 *
 * 口径：
 *   1. 只豁免标记所在的物理行，不整文件、不整目录；
 *   2. 标记只加在示例字符串所在行，作为行尾注释；
 *   3. 每次运行把被豁免的行逐条打印，供发版核对，不静默放行。
 *
 * 只读，只依赖 node:fs。
 */
import fs from 'node:fs';

/** 行级豁免标记。 */
export const EXAMPLE_MARK = '[@example]';

/** 读源文件，返回「行号 → 原文」的标记行表；行号从 1 起。 */
export function readMarkedLines(abs) {
  const map = new Map();
  const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
  lines.forEach((text, i) => {
    if (text.indexOf(EXAMPLE_MARK) !== -1) map.set(i + 1, text.trim());
  });
  return map;
}
