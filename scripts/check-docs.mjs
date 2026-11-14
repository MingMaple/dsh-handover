/**
 * 文档校验：工具名集合、旧数与旧术语、内部链接、版本、语体，以及版本说明的对外口吻。
 * 只读，不做任何改写。退出码 0 表示全部通过。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_TOOL_NAMES } from '../src/lib/names.mjs';
import { listFiles, scanFiles } from './lib/register.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const readme = path.join(root, 'README.md');
const files = [readme]
  .concat(listFiles(path.join(root, 'docs'), ['.md']))
  .filter((f) => fs.existsSync(f));
const releasesDir = path.join(root, 'docs', 'releases');
const releaseFiles = files.filter((f) => path.dirname(f) === releasesDir);
const problems = [];

// 1. README 长度（对外首页承载全部说明，上限放宽）
const readmeLines = fs.readFileSync(readme, 'utf8').split(/\r?\n/).length;
if (readmeLines > 200) problems.push('README 应不超过 200 行（当前 ' + readmeLines + ' 行）');

// 1.1 README「为什么需要」一节为用户 2026-11-13 与 2026-11-15 两次指定的正文（例外 E-01）：逐字比对，改动即失败
const WHY_PINNED = '单个会话的上下文越用越多，用到一定程度之后，出错的可能也会随之上升；可若这时压缩上下文，或者写好交接换一个会话，又会丢掉已经积累的信息。面对这样的两难，有没有更好的取舍？\n\n本插件一定能很好地帮助你。来试试吧；不满意，随时关闭插件并删除即可。';
{
  const m = fs.readFileSync(readme, 'utf8').match(/## 为什么需要\s*\n+([\s\S]*?)\n+## /);
  const got = m ? m[1].trim() : '';
  if (got !== WHY_PINNED) problems.push('README「为什么需要」一节为用户指定正文（E-01），不得改写');
}
// 2. 旧数与旧术语
const FORBIDDEN = ['21 个工具', '27 个工具', '未分类', '追加系统提示词', '4,028', '4.6 KB', '每库 24 行', 'CHANGELOG'];
// 审阅语境与内部用语：这些词只应出现在桌面审阅材料里，不能进对外文档与版本说明。
const REVIEW_WORDS = ['过目', '待验收', '待您', '待你', '请确认', '麻烦您', '麻烦你', '假宿主', '桩服务', '桩实现'];
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  for (const w of FORBIDDEN) {
    if (text.indexOf(w) !== -1) problems.push(path.relative(root, file) + ' 仍含旧表述「' + w + '」');
  }
  for (const w of REVIEW_WORDS) {
    if (text.indexOf(w) !== -1) problems.push(path.relative(root, file) + ' 含审阅语境或内部用语「' + w + '」');
  }
}

// 2.1 版本说明是对外发布正文：不出现二人体，且每个已发布版本都要有一份。
for (const file of releaseFiles) {
  const text = fs.readFileSync(file, 'utf8');
  const person = text.match(/[您你]/);
  if (person) problems.push(path.relative(root, file) + ' 版本说明不应出现二人体（命中「' + person[0] + '」）');
  if (!/^#\s+\S/.test(text)) problems.push(path.relative(root, file) + ' 版本说明应以一级标题开头');
}
{
  const pkgVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  if (!fs.existsSync(path.join(releasesDir, pkgVersion + '.md'))) {
    problems.push('缺少版本说明 docs/releases/' + pkgVersion + '.md（Release 正文从这里取）');
  }
}

// 3. 工具名：文档里出现的 ho_* 与 peer_* 必须在 names.mjs 中
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  const hits = text.match(/\b(?:ho|peer)_[a-z_]+\b/g) || [];
  for (const name of hits) {
    if (ALL_TOOL_NAMES.indexOf(name) === -1) problems.push(path.relative(root, file) + ' 出现未定义工具名「' + name + '」');
  }
}

// 4. 内部链接可达
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  const re = /\[[^\]]*\]\(([^)\s]+)\)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const target = m[1];
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const clean = target.split('#')[0];
    const abs = path.resolve(path.dirname(file), clean);
    if (!fs.existsSync(abs)) problems.push(path.relative(root, file) + ' 的链接不可达「' + target + '」');
  }
}

// 5. 版本：README 的「当前版本」与 package.json 一致
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const readmeText = fs.readFileSync(readme, 'utf8');
const ver = readmeText.match(/当前版本\s*([0-9]+\.[0-9]+\.[0-9]+)/);
if (!ver) problems.push('README 缺少「当前版本 X.Y.Z」一行');
else if (ver[1] !== pkg.version) problems.push('版本不一致：package.json 为 ' + pkg.version + '，README 为 ' + ver[1]);

// 6. 语体
const hits = scanFiles(files, { ui: false });
for (const h of hits) {
  problems.push(path.relative(root, h.file) + ':' + h.line + ' ' + h.rules.join('、'));
}

if (problems.length) {
  console.log('CHECK-DOCS FAIL ' + problems.length + ' 项：');
  for (const p of problems) console.log('  - ' + p);
  process.exitCode = 1;
} else {
  console.log('CHECK-DOCS OK（' + files.length + ' 份文档，含版本说明 ' + releaseFiles.length + ' 份，工具名 ' + ALL_TOOL_NAMES.length + ' 个）');
}
