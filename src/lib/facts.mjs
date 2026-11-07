/**
 * 口径单一来源：水位阈值、压缩次数与提示段 token 预算。
 * 运行期文本一律由本模块渲染；改数值只改 config.mjs 的默认值或本文件的预算表。
 * 文档与测试引用同一组常量，避免同一事实多处各写一遍。
 */
import { DEFAULTS } from './config.mjs';

/** 比例转百分比文本：0.32 → "32%"。 */
function pctOf(ratio) {
  const n = Math.round(Number(ratio) * 1000) / 10;
  return (Number.isInteger(n) ? String(n) : n.toFixed(1)) + '%';
}

/** 水位与压缩口径：全部由配置推导。 */
export function watermark(cfg) {
  const c = cfg || DEFAULTS;
  const warn = pctOf(c.warnRatio !== undefined ? c.warnRatio : DEFAULTS.warnRatio);
  const handover = pctOf(c.handoverRatio !== undefined ? c.handoverRatio : DEFAULTS.handoverRatio);
  const hard = pctOf(c.hardRatio !== undefined ? c.hardRatio : DEFAULTS.hardRatio);
  const max = c.maxCompactions !== undefined ? c.maxCompactions : DEFAULTS.maxCompactions;
  return { warn, handover, hard, max, warnValue: Math.round((c.warnRatio !== undefined ? c.warnRatio : DEFAULTS.warnRatio) * 100) };
}

/** 一句式交接规则（全局与项目提示段共用）。 */
export function handoverRuleText(cfg) {
  const w = watermark(cfg);
  return '水位 ' + w.warn + ' 提醒，' + w.handover + ' 交接线，' + w.hard + ' 硬上限；至多压缩 '
    + w.max + ' 次，第 ' + (w.max + 1) + ' 次换任。';
}

/** 设置页使用说明里的紧写形式。 */
export function compactSummaryText(cfg) {
  const w = watermark(cfg);
  return w.warn + ' 提醒、' + w.handover + ' 交接线、' + w.hard + ' 硬上限；同一会话最多压缩 ' + w.max + ' 次';
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
 * 上下文成本上限（加权 token）。
 * 全局段按短工作区路径计；worst 档按真实长路径加迁移提示行计。
 * 单条工具描述单独设限，避免每次请求的固定开销无界增长。
 */
export const TOKEN_BUDGET = {
  globalTokens: 320,
  globalWorstTokens: 360,
  projectTokens: 300,
  projectWorstTokens: 340,
  toolDescTokens: 70,
};
