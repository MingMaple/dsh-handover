/**
 * 用户可见文案的语体扫描：词表、符号与时间格式。
 * 词表只收「脱离上下文即不可解」与「书面语中不出现」两类；新增豁免须在注释里写明理由。
 * 抽取器只取含中文的字符串字面量（跳过注释行），因此工具 description 与错误消息同样覆盖。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 命中即违规：口语、俚语、生造缩略。 */
const BAD_WORDS = [
  '搞定', '弄好', '弄成', '取不到', '装好', '重启过', '接上', '没找到',
  '拍板', '干活', '收工', '开工', '顺手', '回头', '一眼', '一趟',
  '跑一遍', '走一遍', '接着干', '咱们', '咋', '啥', '差不多', '算了',
  '懒得', '省得', '别忘', '别再', '点单', '找活', '白花',
  '整理并设', '改址', '体量', '忙闲', '抠', '跑一轮',
];

/** 符号与格式类规则；source 用于定位，test 返回是否命中。 */
const SYMBOL_RULES = [
  { id: '感叹号', test: (s) => /[!！]/.test(s) },
  { id: '图形结论符号', test: (s) => /[✅❌⚠✗]/.test(s) },
  { id: '全角斜杠', test: (s) => s.indexOf('／') !== -1 },
  { id: '半角箭头', test: (s) => s.indexOf('->') !== -1 || s.indexOf('=>') !== -1 },
  { id: '中文中的半角括号', test: (s) => /[\u4e00-\u9fff][(]/.test(s) },
];

/** 只对界面文件生效的规则：箭头连接句子。 */
const UI_RULES = [
  { id: '箭头连接句子', test: (s) => /[→←]/.test(s) },
];

/** 时间缺时区：2026-11-07 18:50 这类写法。 */
const TIME_RULE = { id: '时间缺时区', test: (s) => /\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?!\s*[+-]\d{4})/.test(s) };

const CJK = /[\u3400-\u9fff]/;

/** 从源码或文档里抽用户可见的中文字符串。返回 [{ line, text }]。 */
function extractStrings(file) {
  const src = fs.readFileSync(file, 'utf8');
  const out = [];
  const ext = path.extname(file).toLowerCase();
  if (ext === '.md') {
    let fence = false;
    src.split(/\r?\n/).forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith('```')) { fence = !fence; return; }
      if (fence || !CJK.test(t)) return;
      out.push({ line: i + 1, text: t });
    });
    return out;
  }
  let offset = 0;
  src.split(/\r?\n/).forEach((line, i) => {
    const t = line.trim();
    offset = i + 1;
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.indexOf('语体豁免') !== -1) return;
    // 单双引号与反引号里的单行字符串；转义引号不参与抽取。
    const re = /'([^'\\]|\\.)*'|"([^"\\]|\\.)*"|`([^`\\]|\\.)*`/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      const lit = m[0];
      if (!CJK.test(lit) && !/[✅❌⚠✗]/.test(lit)) continue;
      out.push({ line: offset, text: lit });
    }
  });
  return out;
}

/** 扫描一组文件：{ file, line, text, rules }。 */
export function scanFiles(files, opts) {
  const o = opts || {};
  const rules = SYMBOL_RULES.concat(o.ui ? UI_RULES : []).concat([TIME_RULE]);
  const hits = [];
  for (const file of files) {
    const strings = extractStrings(file);
    for (const s of strings) {
      const found = [];
      for (const w of BAD_WORDS) if (s.text.indexOf(w) !== -1) found.push('口语词「' + w + '」');
      for (const r of rules) if (r.test(s.text)) found.push(r.id);
      if (found.length) hits.push({ file, line: s.line, text: s.text, rules: found });
    }
  }
  return hits;
}

/** 列出目录下的指定扩展名文件。 */
export function listFiles(dir, exts, opts) {
  const out = [];
  const stack = [dir];
  const skip = (opts && opts.skip) || [];
  while (stack.length) {
    const cur = stack.pop();
    for (const name of fs.readdirSync(cur)) {
      const p = path.join(cur, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) {
        if (skip.some((s) => p.indexOf(s) !== -1)) continue;
        stack.push(p);
      } else if (exts.indexOf(path.extname(name).toLowerCase()) !== -1) out.push(p);
    }
  }
  return out.sort();
}
