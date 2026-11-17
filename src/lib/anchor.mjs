/**
 * 会话锚点：压缩前写入的增量材料，落在会话目录内的 dsh-handover/anchor.md。
 * 这是会话侧车：随会话删除而消失，插件卸载不影响其可读性。
 * 只做字段合并与节渲染，不裁剪任何段；超出上限只报告。
 * 写盘用临时文件加改名，旧文件保留一份 .bak。
 */
import fs from 'node:fs';
import path from 'node:path';
import { storeLocation } from './store.mjs';
import { estimateTokens } from './facts.mjs';
import { DEFAULTS } from './config.mjs';
import { writeFileAtomic } from './text.mjs';

const ANCHOR_FILE_NAME = 'anchor.md';

/** 固定节顺序：标题与合并语义一一对应。 */
const SECTIONS = [
  { key: 'goal', title: '目标', list: false },
  { key: 'status', title: '状态', list: false },
  { key: 'constraints', title: '约束', list: true },
  { key: 'facts', title: '已确认事实', list: true },
  { key: 'decisions', title: '决策', list: true },
  { key: 'pending', title: '未完成', list: true },
  { key: 'files', title: '文件', list: true },
  { key: 'pointers', title: '指针', list: true },
];

const LIST_CAP = 12;
const EMPTY = '（无）';

/** 锚点绝对路径。 */
export function anchorPathFor(sid) {
  return path.join(storeLocation(sid).dir, ANCHOR_FILE_NAME);
}

/**
 * 读锚点：读不到不抛错。
 * @returns {{path:string, text:string|null, exists:boolean, mtimeMs:number|null}}
 */
export function readAnchor(sid) {
  const file = anchorPathFor(sid);
  let text = null;
  let mtimeMs = null;
  try {
    text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch { /* 文件不存在或不可读时按空处理 */ }
  return { path: file, text, exists: text !== null, mtimeMs };
}

function emptySections() {
  return {
    goal: '', status: '', constraints: [], facts: [], decisions: [], pending: [], files: [], pointers: [],
  };
}

function parseAnchor(text) {
  const out = emptySections();
  if (!text) return out;
  let key = null;
  for (const raw of String(text).split(String.fromCharCode(10))) {
    const line = raw.trim();
    if (line.startsWith('## ')) {
      const title = line.slice(3).trim();
      const def = SECTIONS.find((s) => s.title === title);
      key = def ? def.key : null;
      continue;
    }
    if (!key || !line || line === EMPTY) continue;
    if (!SECTIONS.find((s) => s.key === key).list) {
      out[key] = out[key] ? out[key] + String.fromCharCode(10) + line : line;
      continue;
    }
    out[key].push(line.startsWith('- ') ? line.slice(2).trim() : line);
  }
  return out;
}

function renderAnchor(sections) {
  const lines = [];
  for (const def of SECTIONS) {
    lines.push('## ' + def.title);
    if (def.list) {
      const rows = Array.isArray(sections[def.key]) ? sections[def.key] : [];
      if (rows.length === 0) lines.push(EMPTY);
      else for (const row of rows) lines.push('- ' + row);
    } else {
      lines.push(String(sections[def.key] || '').trim() || EMPTY);
    }
    if (def !== SECTIONS[SECTIONS.length - 1]) lines.push('');
  }
  return lines.join(String.fromCharCode(10));
}

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function cleanList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((x) => cleanText(x)).filter(Boolean);
}

function dedupeKey(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

/** 并集：旧在前、新在后，去重，上限内超出的新项丢弃。 */
function unionList(oldList, newList, cap) {
  const out = [];
  const seen = new Set();
  for (const item of oldList.concat(newList)) {
    const key = dedupeKey(item);
    if (!key || seen.has(key)) continue;
    if (out.length >= cap) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/** 追加去重，上限内超出的新项丢弃。 */
function appendList(oldList, newList, cap) {
  return unionList(oldList, newList, cap);
}

function budgetOf(cfg) {
  const c = cfg || DEFAULTS;
  const max = Number(c.anchorMaxTokens);
  return Number.isFinite(max) && max > 0 ? max : DEFAULTS.anchorMaxTokens;
}

/**
 * 合并并写锚点。
 * @param {string} sid 会话 id
 * @param {object} patch 字段 goal/status 为字符串；其余为字符串数组
 * @param {object} [cfg] 配置覆盖，默认取 DEFAULTS
 * @returns {{path:string, bytes:number, tokens:number, overBudget:boolean, sections:object}}
 */
export function mergeAnchor(sid, patch, cfg) {
  const p = patch || {};
  const c = cfg || DEFAULTS;
  const file = anchorPathFor(sid);
  const old = parseAnchor(readAnchor(sid).text);
  const next = emptySections();

  const goal = cleanText(p.goal);
  const status = cleanText(p.status);
  next.goal = goal || old.goal;
  next.status = status || old.status;

  const constraintMax = Number.isFinite(c.constraintMax) && c.constraintMax > 0
    ? Math.floor(c.constraintMax) : DEFAULTS.constraintMax;
  next.constraints = unionList(old.constraints, cleanList(p.constraints), constraintMax);
  next.facts = appendList(old.facts, cleanList(p.facts), LIST_CAP);
  next.decisions = appendList(old.decisions, cleanList(p.decisions), LIST_CAP);

  for (const key of ['pending', 'files', 'pointers']) {
    const incoming = cleanList(p[key]);
    next[key] = incoming.length ? incoming : old[key];
  }

  const text = renderAnchor(next);
  const tokens = estimateTokens(text);
  if (fs.existsSync(file)) {
    try { fs.copyFileSync(file, file + '.bak'); } catch { /* 备份失败不阻断写入 */ }
  }
  writeFileAtomic(file, text);
  return {
    path: file,
    bytes: Buffer.byteLength(text, 'utf8'),
    tokens,
    overBudget: tokens > budgetOf(c),
    sections: next,
  };
}
