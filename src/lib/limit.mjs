/**
 * 工具输出上限（1.1.0 第二批）：只在「一次全量返回会把上下文撑开」时截断。
 *
 * 定向放行：模型自己给了 offset/limit 时按范围返回，不受上限约束——它已经知道自己要读什么，
 * 为省行数逼它多跑一轮，省下的 token 还不够补那次往返。全量读才设限，并在尾部给出总行数与续读方式。
 */
import { NL } from './text.mjs';

export const HANDOVER_MAX_LINES = 600;
export const STATUS_MAX_LINES = 300;

function rawNum(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? n : null;
}

export function capText(text, opts) {
  const o = opts || {};
  const s = text === undefined || text === null ? '' : String(text);
  if (!s) return s;
  const lines = s.split(NL);
  const total = lines.length;
  const off = rawNum(o.offset);
  const lim = rawNum(o.limit);
  const max = rawNum(o.maxLines);
  const maxLines = max && max > 0 ? max : STATUS_MAX_LINES;
  const tail = o.hint ? NL + String(o.hint) : '';

  // 定向放行：给了范围就按范围返回，不套上限。
  if (off !== null || lim !== null) {
    const start = off && off > 0 ? off : 1;
    const end = lim && lim > 0 ? Math.min(total, start + lim - 1) : total;
    if (start > total) return '（请求的起点超出全文：共 ' + total + ' 行）' + tail;
    return lines.slice(start - 1, end).join(NL)
      + NL + NL + '（第 ' + start + '–' + end + ' 行，共 ' + total + ' 行）' + tail;
  }

  if (total <= maxLines) return s;
  return lines.slice(0, maxLines).join(NL)
    + NL + NL + '…（已截断：全文 ' + total + ' 行，本次返回第 1–' + maxLines + ' 行）' + tail;
}
