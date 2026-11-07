/** 交接文档体检：项目交接与全局交接。 */
import { readUtf8, sectionLines, isFile } from './text.mjs';
import { statSync } from 'node:fs';

const TICK = String.fromCharCode(96);
const ACCEPTABLE = [
  '<工作区根>', '<项目名>', '<YYYY-MM-DD>', '<绝对路径>', '<版本号>',
  '<YYYYMMDD_HHMMSS>', '<日期>', '<过去日期>', '<任务短名>', '<N>', '<M>', '<id>', '<新 id>',
];

/** 去掉行内代码段，避免把示例里的占位符当残留。 */
function stripCodeSpans(text) {
  let out = "";
  let inCode = false;
  for (const ch of text) {
    if (ch === TICK) { inCode = !inCode; continue; }
    if (!inCode) out += ch;
  }
  return out;
}

function firstPlaceholder(text) {
  const src = stripCodeSpans(text);
  for (let i = 0; i < src.length; i++) {
    if (src[i] !== '<') continue;
    const j = src.indexOf('>', i + 1);
    if (j === -1) break;
    if (j - i > 41) continue;
    const token = src.slice(i, j + 1);
    if (token.indexOf(String.fromCharCode(10)) !== -1) continue;
    if (ACCEPTABLE.indexOf(token) !== -1) continue;
    return token;
  }
  return null;
}

const GLOBAL_SECTIONS = [
  '0. 身份与寻址',
  '1. 正在做的事',
  '2. 下一步',
  '3. 待用户决定',
  '4. 用户要求逐条落位',
  '5. 坑点与禁区',
  '6. 关键路径',
  '7. 会话 id 对照',
];

const GLOBAL_FIELDS = [
  '会话类型', '本任', '链内代数', '接任', '本文件', '冲突以谁为准', '修订',
];

function hasHeading(lines, sec) {
  return lines.some((l) => l.startsWith('## ') && l.indexOf(sec) !== -1);
}

function tableRows(lines) {
  return lines.filter((l) => l.trim().startsWith('|') && l.indexOf('---') === -1);
}

function bulletRows(lines) {
  return lines.filter((l) => l.trim().startsWith('-') || l.trim().startsWith('*'));
}

/** 全局交接体检：{ verdict, reasons }。 */
export function lintGlobal(file) {
  if (!isFile(file)) return { verdict: "读不到", reasons: ["文件不存在：" + file] };
  let text = "";
  try { text = readUtf8(file); } catch (e) { return { verdict: "读不到", reasons: ["读取失败：" + e.message] }; }
  const lines = text.split(String.fromCharCode(10));
  const bad = [];
  // §3 标题有新旧两种写法，旧的「等用户拍板」也按通过处理。
  const SEC_ALIAS = { '3. 待用户决定': ['3. 等用户拍板'] }; // 语体豁免：旧文档标题原文，只作兼容匹配
  for (const sec of GLOBAL_SECTIONS) {
    const alt = SEC_ALIAS[sec] || [];
    if (!hasHeading(lines, sec) && !alt.some((a) => hasHeading(lines, a))) bad.push("缺一节：## " + sec);
  }
  const zero = sectionLines(text, '身份与寻址');
  if (!zero) bad.push('缺 ## 0. 身份与寻址');
  else {
    const zt = zero.join(String.fromCharCode(10));
    for (const f of GLOBAL_FIELDS) if (zt.indexOf("| " + f + " |") === -1 && zt.indexOf("|" + f + "|") === -1) bad.push("§0 缺字段：" + f);
  }
  const chainLine = lines.find((l) => l.indexOf('链内代数') !== -1);
  if (!chainLine) bad.push('§0 缺「链内代数」行');
  else {
    const hasDi = chainLine.indexOf('第') !== -1 && chainLine.indexOf('代') !== -1;
    if (!hasDi) bad.push('链内代数不是「第 N 代」格式：' + chainLine.slice(0, 60));
  }
  const s2 = sectionLines(text, '下一步');
  if (!s2) bad.push('缺 ## 2. 下一步');
  else if (tableRows(s2).length <= 1 && bulletRows(s2).length === 0) bad.push('§2 没列出任何条目');
  const s7 = sectionLines(text, '会话 id 对照');
  if (!s7) bad.push('缺 ## 7. 会话 id 对照');
  else {
    if (!s7.some((l) => l.trim().startsWith('|') && l.indexOf('session-') !== -1)) bad.push('§7 没有一行带 session id');
    if (s7.some((l) => l.indexOf('待回填') !== -1)) bad.push('§7 还有「待回填」');
  }
  const ph = firstPlaceholder(text);
  if (ph) bad.push("残留模板占位符：" + ph);
  return { verdict: bad.length === 0 ? "通过" : "不合格", reasons: bad };
}

/** 项目交接体检：{ verdict, reasons }，verdict ∈ 通过/不合格/缺节/读不到。 */
export function lintProject(file) {
  if (!isFile(file)) return { verdict: "不合格", reasons: ["缺 Handover.md：" + file] };
  let text = "";
  try { text = readUtf8(file); } catch (e) { return { verdict: "读不到", reasons: ["读取失败：" + e.message] }; }
  const bad = [];
  const gap = [];
  const body = sectionLines(text, '正在做的事');
  if (!body) gap.push("缺 ## 1. 正在做的事 一节（2026-10-12 起的强制项，本项目还没补）");
  else {
    const core = body.filter((l) => l.trim() !== '' && !l.trim().startsWith('>'));
    if (core.length === 0) bad.push("正在做的事 是空节（或只有引用块说明），没写实质内容");
    else if (core.join('').trim().length < 30) bad.push('正在做的事 内容过短，像是应付');
  }
  const nxt = sectionLines(text, '下一步') || sectionLines(text, '待办');
  if (!nxt) bad.push("缺「下一步待办」一节");
  else if (tableRows(nxt).length <= 1 && bulletRows(nxt).length === 0) bad.push("「下一步待办」没列出任何条目");
  const ph = firstPlaceholder(text);
  if (ph) bad.push("残留模板占位符：" + ph);
  if (bad.length) return { verdict: "不合格", reasons: bad };
  if (gap.length) return { verdict: "缺节", reasons: gap };
  return { verdict: "通过", reasons: [] };
}

export function renderLintGlobal(file, res) {
  const out = [];
  out.push("交接文档体检（全局）  " + file);
  let size = "?";
  try { size = String(statSync(file).size); } catch { /* ignore */ }
  out.push("  Global_Handover.md  " + res.verdict + "  " + size + " B");
  for (const r of res.reasons) out.push("             - " + r);
  out.push("判定：" + (res.verdict === "通过" ? "结构齐备" : "不合格（" + res.reasons.length + " 项）"));
  return out;
}

export function renderLintProject(name, rows) {
  const list = Array.isArray(rows) ? rows : [{ name, file: "", res: rows }];
  const out = [];
  out.push("交接文档体检  项目 " + (name || "全部"));
  let fails = 0;
  let gaps = 0;
  for (const it of list) {
    out.push("  " + it.name + "  " + it.res.verdict);
    for (const r of it.res.reasons) out.push("             - " + r);
    if (it.res.verdict === "不合格") fails++;
    else if (it.res.verdict === "缺节") gaps++;
  }
  out.push("判定：" + list.length + " 个项目 —— 不合格 " + fails + " 个（要改）、缺节 " + gaps + " 个（新规范未铺开，属正常）");
  return out;
}