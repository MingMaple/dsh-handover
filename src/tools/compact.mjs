/**
 * 助手执行入口 ho_handover(action="compact")：轮内压缩，零可见消息，不需要授权。
 * 胶囊正文为必填；前置校验由 lib/compact-gate.mjs 完成；本文件只负责校验胶囊与组织中文回告。
 */
import { NL } from '../lib/text.mjs';
import { CAPSULE_MAX_CHARS } from '../lib/capsule.mjs';

function pctOf(roi) {
  if (typeof roi !== 'number' || !Number.isFinite(roi)) return '未核';
  const n = Math.round(roi * 1000) / 10;
  return (Number.isInteger(n) ? String(n) : n.toFixed(1)) + '%';
}

function numText(value) {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '未核';
}

/** 缺失或为空时的处置：先停在安全断点、按标准写胶囊，再调用压缩。 */
function capsuleMissingText() {
  return [
    '现象：压缩未执行。原因：缺少 `capsule` 或正文为空。',
    '处置：先将任务停在安全断点，再按胶囊标准写正文。',
    '必写 6 项：目标、已定方案、下一步、易错点、必须遵守的约束原文、需要保留的原文位置。',
    '写毕调用 compact(capsule=…) 后重试。',
  ].join(NL);
}

/** 超过上限时的回告：不压缩、不截断。 */
function capsuleOverText(chars) {
  return [
    '现象：压缩未执行。原因：胶囊正文 ' + chars + ' 字，超过上限 ' + CAPSULE_MAX_CHARS + '。',
    '处置：精简胶囊正文后再次调用 compact(capsule=…)。',
  ].join(NL);
}

/**
 * @param {object} env 插件环境（提供 assistantCompact）
 * @param {object} exec 工具执行上下文
 * @param {{reason?:string, mode?:string, boundary?:boolean, status?:string, capsule?:string}} args
 * @returns {Promise<string>} 中文结果
 */
export async function assistantCompact(env, exec, args) {
  const a = args || {};
  const reason = typeof a.reason === 'string' ? a.reason.trim() : '';
  const capsule = typeof a.capsule === 'string' ? a.capsule.trim() : '';
  if (!capsule) return capsuleMissingText();
  if (capsule.length > CAPSULE_MAX_CHARS) return capsuleOverText(capsule.length);
  const mode = a.mode === 'aggressive' || a.mode === 'minimal' ? a.mode : 'auto';
  if (typeof env.assistantCompact !== 'function') {
    return ['现象：轮内压缩入口不可用。原因：插件未装配 assistantCompact。', '处置：重启 DSH 后重试。'].join(NL);
  }
  const r = await env.assistantCompact(exec, {
    reason,
    mode,
    boundary: a.boundary === true,
    status: typeof a.status === 'string' ? a.status : '',
    capsule,
  });
  const out = [];
  if (r && r.ok === true) {
    out.push('压缩完成（by=assistant，mode=' + (r.mode || mode) + '）。');
    out.push('压缩前 ' + numText(r.tokensBefore) + ' token，压缩后 ' + numText(r.tokensAfter)
      + ' token，缩减 ' + pctOf(r.roi) + '。');
    out.push('锚点：' + (r.anchorPath || '（未解析）'));
    if (r.anchorOverBudget === true) {
      out.push('锚点 ' + numText(r.anchorTokens) + ' token，超过上限 '
        + numText(Number(env.cfg && env.cfg.anchorMaxTokens) || 1500) + '；内容未裁。');
    }
    if (r.capsuleOverBudget === true) {
      out.push('胶囊 ' + numText(r.capsuleChars) + ' 字，超过上限 '
        + numText(Number(env.cfg && env.cfg.capsuleMaxChars) || 1600) + '；内容未裁。');
    }
    const source = r.capsuleSource === 'mechanism' ? 'mechanism' : 'assistant';
    out.push('胶囊来源：' + (source === 'assistant'
      ? '助手自述（' + numText(r.capsuleBodyChars !== undefined ? r.capsuleBodyChars : capsule.length) + ' 字）'
      : '机制兜底') + '。');
    out.push('剩余次数：' + numText(r.remaining) + ' 次。');
    if (r.boundary === true) out.push('已按阶段边界声明处理本次压缩。');
    if (reason) out.push('原因：' + reason + '。');
    out.push('按胶囊继续当前任务；需要历史原文时按需召回，不读旧交接全文。');
    return out.join(NL);
  }
  out.push('现象：压缩未执行。原因：' + ((r && r.reason) || '未知').replace(/[。；]+$/, '') + '。');
  const checks = r && Array.isArray(r.checks) ? r.checks : [];
  for (const check of checks) out.push('  ' + (check.ok ? '通过' : '未过') + ' ' + check.name + (check.detail ? '：' + check.detail : ''));
  out.push('处置：按未过项补齐后重试；本次未产生压缩记录。');
  return out.join(NL);
}
