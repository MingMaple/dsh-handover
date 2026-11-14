/**
 * 语体门禁（style-gate）：按写作规范中标注「自动」的条款检查中文串。
 *
 * 规范正文：_Control_Center/standards/写作规范/README.md（W-01 至 W-42）。
 * 本脚本只实现本次分配的十个条款：
 *   阻断级（命中即退出码 1）：W-01、W-02、W-04、W-05、W-07、W-08；
 *   警告级（只命中警告时退出码 0）：W-09、W-19（仅判文档）、W-26、W-38。
 *
 * 扫描范围：README.md、docs/**\/*.md、src/templates/**（不含 src/templates/standards/）、
 * src/**\/*.mjs、src/client.js。代码文件只看注释与字符串字面量；文档只看正文，
 * 不扫描 fenced code block 与行内代码段。
 *
 * 唯一例外 E-01：对外仓库 README.md「为什么需要」一节的指定正文豁免 W-01；按节绑定，由 check-docs 逐字比对；不得扩充。
 *
 * 用法：node scripts/style-gate.mjs
 * 只读，不写任何文件；只用 node:fs 与 node:path，无第三方依赖。
 *
 * 输出：全部通过时一行 OK；否则逐条列出「文件:行 条款 命中内容」。
 */
import fs from 'node:fs';
import path from 'node:path';

/* ============================== 常量表 ============================== */

/** 唯一例外 E-01：对外 README「为什么需要」一节的指定句（用户指定保留；整句不计 W-01）；不得扩充。 */
const E01_TEXT = '本插件一定能很好地帮助你。来试试吧；不满意，随时关闭插件并删除即可。';

/** 规范正文与论文属规范性文本，条款本身会引用被禁词，整目录排除。 */
const SKIP_DIRS = ['src/templates/standards'];

/** W-01 语气词与口语词（规范正文原表）。 */
const W01_WORDS = ['吧', '呢', '啦', '嘛', '呀', '哈', '哦', '其实', '反正'];

/**
 * W-01 的单字词只在作语气词时判违规：「哈希」（hash）是技术专名，不是语气词。
 * 这只处理词形边界，不构成条款例外；其余单字仍按原表逐字判定。
 */
function isW01Word(text, at, word) {
  return !(word === '哈' && text[at + 1] === '希');
}

/** W-02 情绪化、评价性表达（规范正文原表）。 */
const W02_WORDS = ['完美', '惊艳', '糟糕', '坑', '丝滑', '离谱'];

/** W-04 填充语（规范正文原表）。 */
const W04_WORDS = ['值得注意的是', '众所周知', '简单来说'];

/**
 * W-05 界面动作「点」未写「点击」。
 * 只判动词用法：后面紧跟界面对象（引号、按钮类名词、「一下」等）；
 * 节点、重点、落点、定点、清点等名词不受影响；点击、双击、单击本已合规。
 */
const W05_RE = /(?<![双单轻])点(?=一下|下(?:按钮|卡片|链接|图标|选项|菜单|标签|开关)|开|选|按|右|按钮|卡片|链接|图标|选项|菜单|标签|开关|确定|取消|刷新|「|『|“|"|'|`)/;

/**
 * W-07 表情符号（含 ✅❌⚠✗ 一类图形结论符号）与网络缩略语。
 * 箭头、圈号等结构符号在代码注释与流程文案中作分隔标记，不在本次分配范围，
 * 不据此判违规，以免把注释与流程标记误判为装饰。
 */
const W07_EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F1E6}-\u{1F1FF}]/u;
const W07_NET_ABBR = ['yyds', 'xswl', 'awsl', 'srds', 'u1s1', 'zqsg', 'dddd', 'nsdd', 'gkd', 'yygq', 'xdm'];

/** W-09 单句上限（字）。 */
const W09_LIMIT = 40;

/**
 * W-19 常见缩写表：缩写与其全称。只收本仓库常出现、且补全称有信息量的几个；
 * JSON、HTTP、URL 等通用术语不在此列，避免把技术名词当违规。
 * 缩写首次出现全称的要求只判文档（README、docs、模板），代码注释不成文，不作提示。
 */
const W19_ABBR = [
  { abbr: 'DSH', forms: ['DeepSeek Harness'] },
  { abbr: 'API', forms: ['应用程序接口', 'Application Programming Interface'] },
  { abbr: 'CLI', forms: ['命令行界面', 'Command Line Interface'] },
  { abbr: 'GUI', forms: ['图形用户界面', 'Graphical User Interface'] },
];

/** W-26 汉字数字的计量、统计语境：数字 + 量词。单用「一」多属惯用语，不提示。 */
const W26_RE = /([二三四五六七八九十百千万亿两]+)(个|条|次|份|项|行|节|章|种|类|组|张|位|名|天|秒|分钟|小时|月|年|周|页|字符|步|层|处|款|列|人|件|套|遍|轮|档|期|段|句|字|倍|成|回|篇)/g;
/** 这些字在前表示序数、每一、约数或指代，不按计量数字提示。 */
const W26_SKIP_PREV = /[第每这那同约数几上下唯任某另前后首初末本该此其]/;

/** W-38 版本说明的标准分组，以及混用的近义写法。 */
const W38_GROUPS = ['新增', '变更', '修复', '移除', '安全'];
const W38_CHANGE_LIKE = /新增|变更|改动|修正|修复|移除|删除|安全|优化|调整|增强|特性/;

/** 条款清单：编号、级别与顺序。 */
const RULES = [
  { id: 'W-01', level: 'block' },
  { id: 'W-02', level: 'block' },
  { id: 'W-04', level: 'block' },
  { id: 'W-05', level: 'block' },
  { id: 'W-07', level: 'block' },
  { id: 'W-08', level: 'block' },
  { id: 'W-09', level: 'warn' },
  { id: 'W-19', level: 'warn' },
  { id: 'W-26', level: 'warn' },
  { id: 'W-38', level: 'warn' },
];
const RULE_INDEX = new Map(RULES.map((r, i) => [r.id, i]));

/* ============================== 工具函数 ============================== */

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/** 取脚本所在仓库根：脚本位于 <root>/scripts/style-gate.mjs。 */
function repoRoot() {
  const p = process.argv[1] ? path.resolve(process.argv[1]) : path.join(process.cwd(), 'scripts', 'style-gate.mjs');
  return path.resolve(path.dirname(p), '..');
}

/** 递归列出目录下文件；先排序，保证输出稳定。 */
function walk(dir, accept, out) {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir).sort()) {
    const abs = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(abs, accept, out);
    else if (accept(abs)) out.push(abs);
  }
  return out;
}

/** 是否属于排除的规范性文本目录。 */
function isSkipped(rel) {
  return SKIP_DIRS.some((d) => rel === d || rel.startsWith(d + '/'));
}

/** 收集本次扫描的文件清单。 */
function collectFiles(root) {
  const files = [];
  const readme = path.join(root, 'README.md');
  if (fs.existsSync(readme)) files.push(readme);
  const docsDir = path.join(root, 'docs');
  walk(docsDir, (abs) => abs.toLowerCase().endsWith('.md'), files);
  const templatesDir = path.join(root, 'src', 'templates');
  walk(templatesDir, (abs) => !isSkipped(path.relative(root, abs).split(path.sep).join('/')), files);
  const srcDir = path.join(root, 'src');
  walk(srcDir, (abs) => {
    const rel = path.relative(root, abs).split(path.sep).join('/');
    return rel === 'src/client.js' || abs.toLowerCase().endsWith('.mjs');
  }, files);
  const seen = new Set();
  const out = [];
  for (const f of files) {
    const rel = path.relative(root, f).split(path.sep).join('/');
    if (isSkipped(rel) || seen.has(rel)) continue;
    seen.add(rel);
    out.push({ abs: f, rel });
  }
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/** 长度上限内截断，便于单行输出。 */
function clip(s, n) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

/** 去掉 markdown 行内代码、图片、链接目标与 HTML 标签；只留文字。 */
function stripMarkdown(text) {
  let s = text;
  s = s.replace(/`+[^`]*`+/g, ' '); // 行内代码段不参与判定
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/https?:\/\/\S+/g, ' ');
  return s;
}

/** 句长口径：汉字每字 1，英文字母与数字每 2 字符约合 1 字；标点不计。 */
function sentenceLength(s) {
  let cjk = 0;
  let ascii = 0;
  for (const ch of s) {
    if (CJK_RE.test(ch)) cjk++;
    else if (/[A-Za-z0-9]/.test(ch)) ascii++;
  }
  return cjk + Math.ceil(ascii / 2);
}

/** 切句：按中文句末标点。返回句子数组。 */
function splitSentences(text) {
  return text
    .split(/[。！？!?]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 计算单句长度用的清洗：去掉 URL、长路径类词与 markdown 标记。 */
function cleanForLength(text) {
  return text
    .replace(/https?:\/\/\S+/g, ' ')
    .split(/\s+/)
    .map((tok) => (tok.length >= 12 && /[\/\\]/.test(tok) ? '' : tok)) // 长路径整词跳过
    .join(' ')
    .replace(/^\s*[#>*+-]+\s*/g, ' ')
    .replace(/[*_~|]/g, ' ');
}

/* ============================== 抽取器 ============================== */

/** 抽取 markdown / 模板正文：跳过 fenced code block 与表格行（表格行只跳过 W-09）。 */
function extractMarkdown(abs) {
  const src = fs.readFileSync(abs, 'utf8');
  const lines = src.split(/\r?\n/);
  const segs = [];
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();
    const fenceMatch = t.match(/^(```+|~~~+)/);
    if (fenceMatch) {
      const mark = fenceMatch[1][0];
      if (!fence) fence = mark;
      else if (fence === mark) fence = null;
      continue;
    }
    if (fence) continue;
    const text = stripMarkdown(raw);
    if (!CJK_RE.test(text) && !W07_EMOJI_RE.test(text)) continue;
    segs.push({ line: i + 1, text, raw, table: /^\s*\|/.test(raw) });
  }
  return segs;
}

/** 抽取 JS 源码：只取注释与字符串字面量里的中文（以及表情符号）。 */
function extractJs(abs) {
  const src = fs.readFileSync(abs, 'utf8');
  const segs = [];
  const n = src.length;
  let i = 0;
  let line = 1;
  let mode = 'code';
  let buf = '';
  let bufLine = 1;
  let lastSig = '';

  const push = (text, startLine, isComment) => {
    if (!text) return;
    const parts = text.split('\n');
    for (let k = 0; k < parts.length; k++) {
      let t = parts[k].replace(/\r$/, '');
      if (isComment) t = t.replace(/^\s*\*+\s?/, '');
      t = stripMarkdown(t);
      if (!CJK_RE.test(t) && !W07_EMOJI_RE.test(t)) continue;
      segs.push({ line: startLine + k, text: t, raw: t, table: false });
    }
  };

  // 跳过正则字面量：只在明显是正则的位置启用，避免把注释起点误判。
  const skipRegex = (from) => {
    let j = from + 1;
    let inClass = false;
    while (j < n) {
      const c = src[j];
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (c === '\n') return -1;
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) {
        j++;
        while (j < n && /[a-z]/i.test(src[j])) j++;
        return j;
      }
      j++;
    }
    return -1;
  };

  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];
    if (mode === 'code') {
      if (ch === '/' && next === '/') {
        mode = 'line';
        buf = '';
        bufLine = line;
        i += 2;
        continue;
      }
      if (ch === '/' && next === '*') {
        mode = 'block';
        buf = '';
        bufLine = line;
        i += 2;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        mode = ch === "'" ? 'sq' : ch === '"' ? 'dq' : 'tpl';
        buf = '';
        bufLine = line;
        i++;
        continue;
      }
      if (ch === '/' && /[=(:,!&|?{};[+\-*%<>~^]/.test(lastSig)) {
        const j = skipRegex(i);
        if (j > 0) {
          lastSig = '/';
          i = j;
          continue;
        }
      }
      if (ch === '\n') line++;
      if (!/\s/.test(ch)) lastSig = ch;
      i++;
      continue;
    }
    // 注释与字符串内部
    if ((mode === 'sq' || mode === 'dq' || mode === 'tpl') && ch === '\\') {
      const nxt = src[i + 1];
      if (nxt !== undefined) {
        if (nxt === '\n') line++;
        else buf += nxt === 'n' || nxt === 't' ? ' ' : nxt;
      }
      i += 2;
      continue;
    }
    if (mode === 'line' && ch === '\n') {
      push(buf, bufLine, true);
      mode = 'code';
      buf = '';
      line++;
      lastSig = '';
      i++;
      continue;
    }
    if (mode === 'block' && ch === '*' && next === '/') {
      push(buf, bufLine, true);
      mode = 'code';
      buf = '';
      i += 2;
      lastSig = '/';
      continue;
    }
    if (mode === 'sq' && ch === "'") {
      push(buf, bufLine, false);
      mode = 'code';
      buf = '';
      i++;
      lastSig = "'";
      continue;
    }
    if (mode === 'dq' && ch === '"') {
      push(buf, bufLine, false);
      mode = 'code';
      buf = '';
      i++;
      lastSig = '"';
      continue;
    }
    if (mode === 'tpl' && ch === '`') {
      push(buf, bufLine, false);
      mode = 'code';
      buf = '';
      i++;
      lastSig = '`';
      continue;
    }
    if (ch === '\n') {
      buf += ch;
      line++;
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  if (mode !== 'code') push(buf, bufLine, mode === 'line' || mode === 'block');
  return segs;
}

/* ============================== 判定 ============================== */

/** 在一段文字里找词表命中，返回 [{ word, at }]。 */
function wordHits(text, words) {
  const out = [];
  for (const w of words) {
    let from = 0;
    for (;;) {
      const at = text.indexOf(w, from);
      if (at === -1) break;
      out.push({ word: w, at });
      from = at + w.length;
    }
  }
  return out;
}

/** 逐段判定阻断级条款（W-01、W-02、W-04、W-05、W-07、W-08）。 */
function scanBlockRules(rel, seg, add) {
  // E-01：README.md「为什么需要」一节的指定句豁免 W-01（按节绑定，不按行号；该节正文由 check-docs 逐字比对）。
  const e01 = rel === 'README.md' && String(seg.raw || '').indexOf(E01_TEXT) !== -1;
  if (!e01) {
    for (const h of wordHits(seg.text, W01_WORDS)) {
      if (!isW01Word(seg.text, h.at, h.word)) continue;
      add('W-01', '「' + h.word + '」');
    }
  }
  for (const h of wordHits(seg.text, W02_WORDS)) add('W-02', '「' + h.word + '」');
  for (const h of wordHits(seg.text, W04_WORDS)) add('W-04', '「' + h.word + '」');

  const m5 = W05_RE.exec(seg.text);
  if (m5) add('W-05', '「点」应写作「点击」');

  const emoji = seg.text.match(W07_EMOJI_RE);
  if (emoji) add('W-07', '表情符号「' + emoji[0] + '」');
  for (const w of W07_NET_ABBR) {
    if (new RegExp('\\b' + w + '\\b', 'i').test(seg.text)) add('W-07', '网络缩略语「' + w + '」');
  }

  // W-08：全角感叹号一律算；半角仅在中文语境中算，且排除 != 与 !==。
  for (let i = 0; i < seg.text.length; i++) {
    const ch = seg.text[i];
    if (ch === '！') {
      add('W-08', '感叹号「！」');
      break;
    }
    if (ch === '!') {
      if (seg.text[i + 1] === '=') continue;
      const prev = i > 0 ? seg.text[i - 1] : '';
      const nxt = seg.text[i + 1] || '';
      if (CJK_RE.test(prev) || CJK_RE.test(nxt)) {
        add('W-08', '感叹号「!」');
        break;
      }
    }
  }
}

/** W-09：单句超过上限。表格、代码块、长路径均不参与统计。 */
function scanW09(seg, add) {
  if (seg.table) return;
  for (const sentence of splitSentences(cleanForLength(seg.text))) {
    const len = sentenceLength(sentence);
    if (len > W09_LIMIT) {
      add('W-09', len + ' 字（上限 ' + W09_LIMIT + ' 字）：「' + clip(sentence, 24) + '」');
      return; // 一行只报一次，避免同一行多句重复刷屏
    }
  }
}

/** W-26：汉字数字用于计量、统计、编号时提示。 */
function scanW26(seg, add) {
  W26_RE.lastIndex = 0;
  let m;
  while ((m = W26_RE.exec(seg.text)) !== null) {
    const at = m.index;
    const prev = at > 0 ? seg.text[at - 1] : '';
    // 万、千、百、亿作量级单位（如「1.1 万字符」）时不按汉字数字计数。
    if (/^[万千百亿]$/.test(m[1])) continue;
    // 紧跟数字或字母的是数值的一部分（如「3 万」「第2 条」），不判。
    if (prev && /[0-9A-Za-z]/.test(prev)) continue;
    if (prev && W26_SKIP_PREV.test(prev)) continue;
    add('W-26', '「' + m[0] + '」（计量、统计、编号宜用阿拉伯数字）');
  }
}

/** W-19：同一文件内缩写首次出现未先写全称。只看首次出现，后文补写全称也不免除。 */
function scanW19(segs, add) {
  for (const item of W19_ABBR) {
    const re = new RegExp('\\b' + item.abbr + '\\b');
    let prior = '';
    for (const seg of segs) {
      const m = re.exec(seg.text);
      if (m) {
        const before = prior + '\n' + seg.text.slice(0, m.index);
        if (!item.forms.some((f) => before.indexOf(f) !== -1)) {
          add('W-19', item.abbr + ' 首次出现未写全称（先写「' + item.forms[0] + '（' + item.abbr + '）」）', seg.line);
        }
        break; // 只看首次出现
      }
      prior += '\n' + seg.text;
    }
  }
}

/** W-38：版本说明按新增、变更、修复、移除、安全分组。 */
function scanW38(abs, add) {
  const text = fs.readFileSync(abs, 'utf8');
  const headings = [];
  text.split(/\r?\n/).forEach((lineText, i) => {
    const m = lineText.match(/^##\s+(.+?)\s*$/);
    if (m) headings.push({ line: i + 1, title: m[1].trim() });
  });
  const exact = headings.filter((h) => W38_GROUPS.indexOf(h.title) !== -1);
  if (exact.length === 0) {
    const line = headings.length ? headings[0].line : 1;
    add('W-38', '未按 新增、变更、修复、移除、安全 分组', line);
    return;
  }
  for (const h of headings) {
    if (W38_GROUPS.indexOf(h.title) !== -1) continue;
    if (!W38_CHANGE_LIKE.test(h.title)) continue;
    add('W-38', '分组「' + h.title + '」应改用 新增、变更、修复、移除、安全', h.line);
  }
}

/* ============================== 主流程 ============================== */

function main() {
  const root = repoRoot();
  const files = collectFiles(root);
  const findings = [];
  const order = new Map(files.map((f, i) => [f.rel, i]));

  for (const { abs, rel } of files) {
    const isDoc = rel.startsWith('src/templates/') || rel.toLowerCase().endsWith('.md');
    const segs = isDoc ? extractMarkdown(abs) : extractJs(abs);
    const add = (rule, content, lineOverride) => {
      findings.push({ rel, line: lineOverride || segLine, rule, content });
    };
    let segLine = 1;

    for (const seg of segs) {
      segLine = seg.line;
      scanBlockRules(rel, seg, add);
      scanW09(seg, add);
      scanW26(seg, add);
    }

    // 文件级条款
    const fileAdd = (rule, content, line) => findings.push({ rel, line: line || 1, rule, content });
    if (/^docs\/releases\/[^/]+\.md$/.test(rel)) scanW38(abs, fileAdd);
    // W-19 只判文档；代码注释不成文，逐文件要求缩写全称会大面积误报。
    if (rel === 'README.md' || rel.startsWith('docs/') || rel.startsWith('src/templates/')) {
      scanW19(segs, fileAdd);
    }
  }

  // 去重并按「文件、行、条款」排序
  const seen = new Set();
  const list = [];
  for (const f of findings) {
    const key = f.rel + '\u0000' + f.line + '\u0000' + f.rule + '\u0000' + f.content;
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(f);
  }
  list.sort((a, b) => {
    const fa = order.get(a.rel) || 0;
    const fb = order.get(b.rel) || 0;
    if (fa !== fb) return fa - fb;
    if (a.line !== b.line) return a.line - b.line;
    return (RULE_INDEX.get(a.rule) || 0) - (RULE_INDEX.get(b.rule) || 0);
  });

  if (list.length === 0) {
    console.log('STYLE-GATE OK（' + files.length + ' 份文件，' + RULES.length + ' 条规则）');
    return;
  }

  let blocking = 0;
  for (const f of list) {
    if (f.rule === 'W-01' || f.rule === 'W-02' || f.rule === 'W-04' || f.rule === 'W-05' || f.rule === 'W-07' || f.rule === 'W-08') blocking++;
  }
  // 只有警告时判通过与退出码 0，但逐条列出，供评审与后续清理。
  console.log((blocking > 0 ? 'STYLE-GATE FAIL ' : 'STYLE-GATE PASS（无阻断，') + (blocking > 0 ? list.length + ' 项：' : list.length + ' 项警告）：'));
  for (const f of list) console.log(f.rel + ':' + f.line + ' ' + f.rule + ' ' + f.content);
  process.exitCode = blocking > 0 ? 1 : 0;
}

main();
