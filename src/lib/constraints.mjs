/**
 * 会话约束抽取：只做规则匹配，不调用模型。
 * 输入为用户消息表面文本，输出逐条原文与来源序号，供锚点合并与压缩后探针校验共用。
 */

/** 约束句式关键词。 */
const HIT_RE = /不要|别|不得|不能|禁止|严禁|必须|务必|只能|只允许|一律|不允许|仅可|切勿|勿/;

/** 按句末标点与换行切句。 */
const SENTENCE_RE = /[。！？；\n]/;

/** 约束长度下限与上限（字符）。 */
const MIN_LEN = 4;
const MAX_LEN = 120;

const DEFAULT_MAX = 8;
const PROBE_CHARS = 12;

/** 去空白与标点后的比较键：只用于去重，不改变保留原文。 */
function keyOf(text) {
  return String(text || '').replace(/[\s\p{P}\p{S}]/gu, '');
}

function charLength(text) {
  return Array.from(String(text || '')).length;
}

/**
 * 抽取约束：保留最早出现顺序，按去空白与标点后的文本去重。
 * @param {Array<{text:string, seq:number}>} messages 用户消息
 * @param {{max?:number}} [opts] max 默认 8
 * @returns {Array<{text:string, seq:number}>}
 */
export function extractConstraints(messages, opts) {
  const list = Array.isArray(messages) ? messages : [];
  const max = Number.isFinite(opts && opts.max) && opts.max > 0 ? Math.floor(opts.max) : DEFAULT_MAX;
  const out = [];
  const seen = new Set();
  for (const message of list) {
    const text = message && typeof message.text === 'string' ? message.text : '';
    if (!text) continue;
    for (const raw of text.split(SENTENCE_RE)) {
      const line = raw.trim();
      if (!line) continue;
      const len = charLength(line);
      if (len < MIN_LEN || len > MAX_LEN) continue;
      if (!HIT_RE.test(line)) continue;
      const key = keyOf(line);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({ text: line, seq: message.seq });
      if (out.length >= max) return out;
    }
  }
  return out;
}

/** 探针：前 12 个非空白字符。 */
function probeOf(text) {
  return Array.from(String(text || '').replace(/\s+/g, '')).slice(0, PROBE_CHARS).join('');
}

/**
 * 约束探针：压缩后表面文本中还能否找到每条约束的关键短语。
 * @param {string[]} texts 压缩后表面可见文本
 * @param {Array<{text:string}>} constraints 约束
 * @returns {{kept:number, missing:string[]}} missing 为未命中的约束原文
 */
export function probeConstraints(texts, constraints) {
  const body = Array.isArray(texts) ? texts.join(String.fromCharCode(10)) : '';
  const list = Array.isArray(constraints) ? constraints : [];
  if (!body) return { kept: 0, missing: list.map((c) => String((c && c.text) || '')) };
  let kept = 0;
  const missing = [];
  for (const c of list) {
    const text = String((c && c.text) || '');
    const probe = probeOf(text);
    if (probe && body.indexOf(probe) !== -1) kept += 1;
    else missing.push(text);
  }
  return { kept, missing };
}
