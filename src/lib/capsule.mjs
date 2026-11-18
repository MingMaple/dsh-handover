/**
 * 压缩后胶囊：一条纯文本，取代旧的交接起点。
 * 助手胶囊由助手自述正文；机制兜底只保留锚点（目标、约束、状态）
 * 与最近 6 轮会话记录里按关键词抽出的句子，抽不到写「（无）」。
 * 约束逐条保留原文，探针判为缺失的条目额外标注。
 * 不裁剪；超限由调用方报告。
 */
import { visibleTextOf } from './events.mjs';

const NL = String.fromCharCode(10);
const MISSING_MARK = '（以本行原文为准）';

/** 助手胶囊正文上限；超出由 compact 入口硬拒绝，不截断。 */
export const CAPSULE_MAX_CHARS = 4000;

/** 渲染后参考上限：只用于报告，不拒绝、不裁剪。 */
export const CAPSULE_RENDER_MAX_CHARS = 4600;

/** 机制兜底抽取关键词：命中任一即保留该句。 */
export const CAPSULE_KEYWORDS = ['下一步', '待办', '未完成', '待确认', '待修', '错误', '失败', '异常', '路径'];

/** 抽取窗口：最近 6 轮；句数与单句长度上限只防胶囊失控，不做截断回执。 */
const EXCERPT_TURNS = 6;
const EXCERPT_MAX = 10;
const EXCERPT_CLIP = 160;
const EXCERPT_TEXT_MAX = 20000;

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
  // 压缩后读数可能滞后一轮（D-171）：拿不到可信值就写「待下一轮校准」，不填数。
  const afterKnown = typeof input.after === 'number' && Number.isFinite(input.after);
  const arrow = '压缩前 ' + kText(input.before) + '，压缩后 ' + (afterKnown ? kText(input.after) : '待下一轮校准');
  const shadow = typeof input.shadow === 'number' && Number.isFinite(input.shadow)
    ? '本次遮蔽 ' + kText(input.shadow) : '本次遮蔽 未核';
  const ratio = afterKnown ? ratioOf(input.before, input.after) : null;
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

/** 按换行与句末标点切句；空白句丢弃。 */
function sentencesOf(text) {
  return String(text || '').split(/[\n。；;！!？?]+/).map((s) => s.trim()).filter(Boolean);
}

function hitKeyword(sentence) {
  for (const k of CAPSULE_KEYWORDS) if (sentence.indexOf(k) !== -1) return true;
  return false;
}

/**
 * 从会话记录抽关键词句：按 data.turn 分组，取最近 6 轮。
 * 无 data.turn 的记录沿用上一条已知轮号；整份记录都没有轮号时按一组处理。
 * 只读可见文本，跳过插件自身注入的消息。
 * 必须在压缩发生前读取会话日志，避免读到已被置换的正文。
 * @param {Array<object>} records 会话日志事件
 * @param {{turns?:number, max?:number}} [opts]
 * @returns {string[]} 去重后的句子，按时间顺序
 */
export function extractKeywordSentences(records, opts) {
  const o = opts || {};
  const turns = Number.isFinite(o.turns) && o.turns > 0 ? Math.floor(o.turns) : EXCERPT_TURNS;
  const max = Number.isFinite(o.max) && o.max > 0 ? Math.floor(o.max) : EXCERPT_MAX;
  const byTurn = new Map();
  let current = null;
  for (const r of Array.isArray(records) ? records : []) {
    if (!r || typeof r.type !== 'string') continue;
    const d = r.data && typeof r.data === 'object' ? r.data : {};
    if (typeof d.turn === 'number' && Number.isFinite(d.turn)) current = d.turn;
    if (r.type !== 'user/message' && r.type !== 'assistant/message' && r.type !== 'tool/result') continue;
    const src = d.source;
    if (src && src.kind === 'dsh-handover') continue;
    let text = '';
    try { text = visibleTextOf(r); } catch { text = ''; }
    if (!text) continue;
    if (text.length > EXCERPT_TEXT_MAX) text = text.slice(-EXCERPT_TEXT_MAX);
    const key = typeof d.turn === 'number' && Number.isFinite(d.turn)
      ? d.turn
      : (current === null ? 0 : current);
    if (!byTurn.has(key)) byTurn.set(key, []);
    byTurn.get(key).push(text);
  }
  const keys = Array.from(byTurn.keys()).sort((a, b) => a - b);
  const use = keys.length > turns ? keys.slice(-turns) : keys;
  const out = [];
  const seen = new Set();
  for (const key of use) {
    for (const text of byTurn.get(key)) {
      for (const s of sentencesOf(text)) {
        if (!hitKeyword(s)) continue;
        const t = s.length > EXCERPT_CLIP ? s.slice(0, EXCERPT_CLIP - 1) + '…' : s;
        if (seen.has(t)) continue;
        seen.add(t);
        out.push(t);
        if (out.length >= max) return out;
      }
    }
  }
  return out;
}

/**
 * 渲染胶囊。
 * 传入 source="assistant"（或 label）且 body 非空时，渲染助手自述胶囊：抬头、正文原样、召回提示。
 * 其余情况渲染机制兜底：只拼抬头、目标/状态、约束逐条原文与关键词摘录，
 * 摘录由调用方在压缩前从会话日志抽出；抽不到写「（无）」。
 * @param {{label?:string, source?:'assistant'|'mechanism', body?:string,
 *   anchor?:object, anchorPath?:string, excerpts?:string[], before?:number, after?:number, shadow?:number,
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
  const excerpts = listOf(i.excerpts);
  const goal = typeof anchor.goal === 'string' && anchor.goal.trim() ? anchor.goal.trim() : '未核';
  const status = typeof anchor.status === 'string' ? anchor.status.trim() : '';

  return [
    headLine(i),
    '目标：' + goal + (status ? '｜状态：' + status : ''),
    constraintsLine(constraints, i.missing),
    '近期关键字摘录：' + (excerpts.length ? excerpts.join('；') : '（无）'),
  ].join(NL);
}
