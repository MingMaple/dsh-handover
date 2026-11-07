/** Charter（规则正文）访问：只读，不改。 */
import path from 'node:path';
import { NL } from './text.mjs';

const FENCE = String.fromCharCode(96, 96, 96);
export const TITLE_KEY = "运行期省 token（通用约束";
export const WATER_KEY = "上下文水位自查";

export function charterPath(ws) {
  return path.join(ws, '_Control_Center', 'rules', 'Workspace_Charter.md');
}

/**
 * 从 §8.1.1.4 的 markdown 代码块现取「通用约束条」正文：
 * 返回 { title, body }，无法获取返回 null。改正文不用改代码。
 */
export function canonicalBlock(text) {
  const i = text.indexOf(FENCE + 'markdown');
  if (i === -1) return null;
  const rest = text.slice(i + FENCE.length + 8);
  const j = rest.indexOf(FENCE);
  if (j === -1) return null;
  const lines = rest.slice(0, j).split(NL).map((l) => l.trim()).filter((l) => l !== '');
  let idx = -1;
  for (let k = 0; k < lines.length; k++) if (lines[k].indexOf('运行期按') !== -1) { idx = k; break; }
  if (idx === -1) return null;
  return { title: lines[idx], body: lines.slice(idx) };
}
