/**
 * 压缩后胶囊：一条纯文本，取代旧的交接起点。
 * 助手胶囊由助手自述正文；机制兜底按 6 段固定顺序拼装。
 * 约束逐条保留原文，探针判为缺失的条目额外标注。
 * 不裁剪；超限由调用方报告。
 */
const NL = String.fromCharCode(10);
const MISSING_MARK = '（以本行原文为准）';

/** 助手胶囊正文上限；超出由 compact 入口拒绝，不截断。 */
export const CAPSULE_MAX_CHARS = 1400;

/** 助手自述与机制兜底各配一个抬头标签。 */
const CAPSULE_LABELS = {
  assistant: '[压缩完成·助手胶囊]',
  mechanism: '[压缩完成·机制兜底]',
};

function kText(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '未核';
  return Math.round(value / 1000) + 'K';
}

function pct(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '未核';
  const n = Math.round(value * 1000) / 10;
  return (Number.isInteger(n) ? String(n) : n.toFixed(1)) + '%';
}

function listOf(value) {
  return Array.isArray(value) ? value.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : [];
}

function ratioOf(before, after) {
  if (typeof before !== 'number' || typeof after !== 'number' || before <= 0) return null;
  return (before - after) / before;
}

function labelOf(input) {
  if (typeof input.label === 'string' && input.label.trim()) return input.label.trim();
  return input.source === 'assistant' ? CAPSULE_LABELS.assistant : CAPSULE_LABELS.mechanism;
}

function headLine(input) {
  const arrow = '压缩前 ' + kText(input.before) + '，压缩后 ' + kText(input.after);
  const shadow = typeof input.shadow === 'number' && Number.isFinite(input.shadow)
    ? '本次遮蔽 ' + kText(input.shadow) : '本次遮蔽 未核';
  const ratio = ratioOf(input.before, input.after);
  const seq = '第 ' + (Number.isFinite(input.count) ? input.count : '?') + '/'
    + (Number.isFinite(input.max) ? input.max : '?') + ' 次';
  return labelOf(input) + ' ' + [arrow, shadow, '缩减 ' + pct(ratio), seq].join('｜');
}

function constraintsLine(constraints, missing) {
  if (!constraints.length) return '约束（逐条原文）：（无）';
  const miss = new Set(Array.isArray(missing) ? missing : []);
  const rows = constraints.map((text, i) => (i + 1) + ') ' + text + (miss.has(text) ? MISSING_MARK : ''));
  return '约束（逐条原文）：' + rows.join('；');
}

function recallLine(path) {
  return '锚点 ' + path + '｜需要历史原文时用 ho_status(view="recall", query="…")';
}

/**
 * 渲染胶囊。
 * 传入 source="assistant"（或 label）且 body 非空时，渲染助手自述胶囊：抬头、正文原样、召回提示。
 * 其余情况渲染机制兜底：按 6 段固定顺序拼装，并标注约束探针未命中的条目。
 * @param {{label?:string, source?:'assistant'|'mechanism', body?:string,
 *   anchor?:object, anchorPath?:string, before?:number, after?:number, shadow?:number,
 *   count?:number, max?:number, missing?:string[], cfg?:object}} input
 * @returns {string}
 */
export function renderCapsule(input) {
  const i = input || {};
  const path = i.anchorPath || '（未解析）';
  const body = typeof i.body === 'string' ? i.body.trim() : '';
  const assistant = !!body && (i.source === 'assistant' || /助手胶囊/.test(labelOf(i)));
  if (assistant) {
    return [headLine(i), body, recallLine(path)].join(NL);
  }

  const anchor = i.anchor || {};
  const constraints = listOf(anchor.constraints);
  const facts = listOf(anchor.facts);
  const pointers = listOf(anchor.pointers);
  const pending = listOf(anchor.pending);
  const goal = typeof anchor.goal === 'string' && anchor.goal.trim() ? anchor.goal.trim() : '未核';
  const status = typeof anchor.status === 'string' ? anchor.status.trim() : '';

  return [
    headLine(i),
    '目标：' + goal + (status ? '｜状态：' + status : ''),
    constraintsLine(constraints, i.missing),
    '已确认事实与指针：' + (facts.concat(pointers).length ? facts.concat(pointers).join('；') : '（无）'),
    '未完成：' + (pending.length ? pending.join('；') : '（无）'),
    '下一步：' + (pending.length ? pending[0] : '（无）'),
    '锚点 ' + path + '｜需要历史原文时按需召回，不读旧交接全文',
  ].join(NL);
}
