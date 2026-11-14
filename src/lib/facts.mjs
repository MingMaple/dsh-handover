/**
 * 口径单一来源：水位阈值、压缩次数与提示段 token 参考值。
 * 运行期文本一律由本模块渲染；改数值只改 config.mjs 的默认值或本文件的参考表。
 * 文档与测试引用同一组常量，避免同一事实多处各写一遍。
 */
import { DEFAULTS } from './config.mjs';

/** 比例转百分比文本：0.35 → "35%"。 */
function pctOf(ratio) {
  const n = Math.round(Number(ratio) * 1000) / 10;
  return (Number.isInteger(n) ? String(n) : n.toFixed(1)) + '%';
}

/** 水位与压缩口径：全部由配置推导。 */
export function watermark(cfg) {
  const c = cfg || DEFAULTS;
  const pick = (k) => (c[k] !== undefined ? c[k] : DEFAULTS[k]);
  const remind = pctOf(pick('remindRatio'));
  const remind2 = pctOf(pick('remind2Ratio'));
  const handover = pctOf(pick('handoverRatio'));
  const hard = pctOf(pick('hardRatio'));
  const max = pick('maxCompactions');
  return {
    remind, remind2, handover, hard, max,
    remindValue: Math.round(pick('remindRatio') * 100),
    remind2Value: Math.round(pick('remind2Ratio') * 100),
    reuseValue: Math.round(pick('handoverRatio') * 100),
  };
}

/** 一句式交接规则（全局与项目提示段共用）。 */
export function handoverRuleText(cfg) {
  const w = watermark(cfg);
  return '水位 ' + w.remind + ' 与 ' + w.remind2 + ' 各提醒一次，' + w.handover + ' 后可压缩，' + w.hard + ' 硬上限；至多压缩 '
    + w.max + ' 次，第 ' + (w.max + 1) + ' 次换任。';
}

/** 设置页使用说明里的紧写形式。 */
export function compactSummaryText(cfg) {
  const w = watermark(cfg);
  return w.remind + ' 与 ' + w.remind2 + ' 各提醒一次，' + w.handover + ' 后可压缩，' + w.hard + ' 硬上限；同一会话最多压缩 ' + w.max + ' 次';
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
  globalTokens: 900,
  globalWorstTokens: 1000,
  projectTokens: 800,
  projectWorstTokens: 900,
  toolDescTokens: 70,
};
