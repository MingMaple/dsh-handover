/**
 * 口径单一来源：token 分档、宿主摘要阈值与提示段 token 参考值。
 * 运行期文本一律由本模块渲染；改数值只改 config.mjs 的默认值或本文件的参考表。
 * 文档与测试引用同一组常量，避免同一事实多处各写一遍。
 */

/** 分档口径共用文本（窗口纯比例、实得窗与退回预算）。 */
const BANDS_TEXT = '分档按窗口纯比例：整理线 35%、建议线 50%、强制线 65%。上述均为可用窗口比例，不设绝对上限。可用窗口 = 窗口 − 预留输出 13K。200K 窗实得 65K/94K/122K，1M 窗约 345K/494K/642K。窗口读不到时退回绝对预算 80K/120K/180K。前两档只提示，';

/** 设置页使用说明里的紧写形式。 */
export function compactSummaryText(cfg) {
  const c = cfg || {};
  const max = Number(c.maxCompactionsPerSession) || 4;
  return BANDS_TEXT + '强制线兜底；助手入口在 '
    + max + ' 次后关闭，强制线兜底至硬上限';
}

/** 提示段与工具描述的加权 token 估算：CJK 与全角标点每字符 1 token，其余每 4 字符 1 token。 */
export function estimateTokens(text) {
  const s = String(text === null || text === undefined ? '' : text);
  let wide = 0;
  let narrow = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (isWide(cp)) wide += 1;
    else narrow += 1;
  }
  return wide + Math.ceil(narrow / 4);
}

function isWide(cp) {
  return (cp >= 0x2000 && cp <= 0x206f)   // 通用标点（破折号、省略号、弯引号）
    || (cp >= 0x3000 && cp <= 0x303f)     // CJK 标点
    || (cp >= 0x2e80 && cp <= 0x9fff)     // CJK 部首至统一汉字
    || (cp >= 0xf900 && cp <= 0xfaff)     // 兼容汉字
    || (cp >= 0xfe30 && cp <= 0xfe4f)     // CJK 兼容形式
    || (cp >= 0xff00 && cp <= 0xffef);    // 全角字符
}

/**
 * 上下文成本参考值（加权 token）。
 * 全局段按短工作区路径计；worst 档按真实长路径加迁移提示行计。
 * 仅供参考：用于设置页展示与冒烟实测，不作为通过条件，也不参与任何拒绝或截断。
 * 提示词效果优先于字数，实测值超出参考值时如实展示即可。
 */
export const TOKEN_BUDGET = {
  globalTokens: 1000,
  globalWorstTokens: 1100,
  projectTokens: 900,
  projectWorstTokens: 1000,
  toolDescTokens: 70,
};
