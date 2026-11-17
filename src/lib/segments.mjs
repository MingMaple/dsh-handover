/** 段索引派生：从 compaction/summary 事件推导每段范围、token 与一行标签。不落盘，不做第二事实源。 */
import { estimateTokens } from './facts.mjs';
import { visibleTextOf } from './events.mjs';
import { stampTz } from './brief.mjs';

function seqOf(record, index) {
  return record && typeof record.seq === 'number' ? record.seq : index;
}

function cleanLine(text) {
  return String(text || '')
    .replace(/^#+\s*/, '')
    .replace(/^[-*+]\s*/, '')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 摘要首行常是小标题，取第一条有内容的正文行作标签。 */
function labelOf(summaryText, index) {
  const lines = String(summaryText || '').split(String.fromCharCode(10));
  for (const raw of lines) {
    const t = cleanLine(raw);
    if (!t) continue;
    if (/^(Primary Request|Key Technical|Files and Code|Errors and Fixes|Pending Jobs|Current Work|Next Step|Critical Context)/i.test(t)) continue;
    return t.length > 60 ? t.slice(0, 59) + '…' : t;
  }
  return '第 ' + (index + 1) + ' 段摘要';
}

/**
 * 推导段索引。
 * @param {Array<object>} records 会话日志事件
 * @returns {Array<{index:number, fromSeq:number, toSeq:number, shadowedEvents:number, tokens:number, label:string, at:string, atMs:number, summarySeq:number}>}
 */
export function deriveSegments(records) {
  const list = Array.isArray(records) ? records : [];
  const summaries = [];
  list.forEach((r, i) => {
    if (r && r.type === 'compaction/summary') summaries.push({ record: r, seq: seqOf(r, i), index: i });
  });
  const segments = [];
  let prev = -1;
  for (let k = 0; k < summaries.length; k++) {
    const s = summaries[k];
    const from = prev + 1;
    const to = s.seq - 1;
    let events = 0;
    let tokens = 0;
    if (to >= from) {
      for (const r of list) {
        const q = seqOf(r, -1);
        if (q < from || q > to) continue;
        if (r && (r.type === 'compaction/start' || r.type === 'compaction/summary' || r.type === 'compaction/end')) continue;
        events++;
        tokens += estimateTokens(visibleTextOf(r));
      }
    }
    const time = typeof s.record.time === 'number' ? s.record.time : null;
    segments.push({
      index: k + 1,
      fromSeq: from,
      toSeq: to,
      shadowedEvents: events,
      tokens,
      label: labelOf(visibleTextOf(s.record), k),
      at: time === null ? '未核' : stampTz(time),
      atMs: time,
      summarySeq: s.seq,
    });
    prev = s.seq;
  }
  return segments;
}

/** 某个事件序号落在哪一段；不在任何段内时返回 null。 */
export function segmentForSeq(segments, seq) {
  const q = Number(seq);
  if (!Number.isFinite(q)) return null;
  for (const s of (Array.isArray(segments) ? segments : [])) {
    if (q >= s.fromSeq && q <= s.toSeq) return s;
  }
  return null;
}

/**
 * 相邻 2 次压缩的增量比：本次遮蔽事件数 ÷ 上次遮蔽事件数。
 * 只在已有至少 3 次压缩时判定：第一次压缩的遮蔽量包含整段历史，拿它当分母会让
 * 刚做完第一次压缩的会话立刻被判「越压越快」。
 * 段数不足 3 段或上次遮蔽为零时返回 null（判据不成立，不误触发）。
 */
export function gainRatio(segments) {
  const list = Array.isArray(segments) ? segments : [];
  if (list.length < 3) return null;
  const last = list[list.length - 1];
  const prev = list[list.length - 2];
  if (!prev || !prev.shadowedEvents) return null;
  return (last.shadowedEvents || 0) / prev.shadowedEvents;
}

/** 段索引汇总：段数、累计遮蔽事件与 token、最近一段的时刻与标签，供回填消息与状态页共用。 */
export function segmentStats(segments) {
  const list = Array.isArray(segments) ? segments : [];
  const shadowed = list.reduce((a, s) => a + (s.shadowedEvents || 0), 0);
  const tokens = list.reduce((a, s) => a + (s.tokens || 0), 0);
  const last = list.length ? list[list.length - 1] : null;
  return {
    count: list.length,
    shadowedEvents: shadowed,
    tokens,
    lastAt: last ? last.at : '',
    lastLabel: last ? last.label : '',
  };
}
