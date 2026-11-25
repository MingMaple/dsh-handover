/**
 * 文档校验：工具名集合、旧数与旧术语、内部链接、版本、语体，以及版本说明的对外口吻。
 * 只读，不做任何改写。退出码 0 表示全部通过。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_TOOL_NAMES } from '../src/lib/names.mjs';
import { ENTRY_ACTIONS } from '../src/tools/ho_docmap.mjs';
import { listFiles, scanFiles } from './lib/register.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const readme = path.join(root, 'README.md');
// 归档目录里的版本说明属历史记录，与 docs/releases 同样不参与当前口径检查。
const isArchived = (f) => f.indexOf(path.sep + '_archive' + path.sep) !== -1;
const files = [readme]
  .concat(listFiles(path.join(root, 'docs'), ['.md']))
  .filter((f) => fs.existsSync(f))
  .filter((f) => !isArchived(f));
const releasesDir = path.join(root, 'docs', 'releases');
const releaseFiles = files.filter((f) => path.dirname(f) === releasesDir);
const problems = [];

// 1. README 长度（对外首页承载全部说明，上限放宽）
const readmeLines = fs.readFileSync(readme, 'utf8').split(/\r?\n/).length;
if (readmeLines > 200) problems.push('README 应不超过 200 行（当前 ' + readmeLines + ' 行）');

// 1.1 README「为什么需要」一节为用户 2026-11-13 与 2026-11-15 两次指定的正文（例外 E-01）：逐字比对，改动即失败
// 2026-11-25 外部会话改写过一次，用户认定不如原版，已按原版还原；此后只认这一段。
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

// 3. 工具名：文档里出现的 ho_* 与 peer_* 必须在 names.mjs 中。
// 版本说明属历史记录，可能引用后来撤除的工具名，工具名检查只覆盖当前文档。
for (const file of files) {
  if (path.dirname(file) === releasesDir) continue;
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

// 7. 动作名：提示段、回执与骨架只能教入口实际接受的动作。
// 1.2 合并入口后再保留旧动作名，会让模型照做即被拒绝，属流程阻断；版本说明与归档不在此列。
{
  const actFiles = files.filter((f) => path.dirname(f) !== releasesDir)
    .concat(listFiles(path.join(root, 'src'), ['.md', '.mjs']));
  const re = /ho_docmap\s*\(?\s*action\s*=\s*["']?([a-z][a-z-]*)/g;
  for (const file of actFiles) {
    const text = fs.readFileSync(file, 'utf8');
    let m;
    while ((m = re.exec(text)) !== null) {
      if (ENTRY_ACTIONS.indexOf(m[1]) === -1) {
        problems.push(path.relative(root, file) + ' 出现 ho_docmap 未接受的动作名「' + m[1] + '」');
      }
    }
  }
}

// 8. 对齐检查：标准文件的版本名额与清单列数、当前版本说明的刷新口径、README 的按钮说明。
// 维护纪律靠断言而非记性：超限或不写口径即失败。
{
  const std = path.join(root, 'src', 'templates', 'Align_Check.md');
  if (!fs.existsSync(std)) problems.push('缺少内置标准文件 src/templates/Align_Check.md');
  else {
    const text = fs.readFileSync(std, 'utf8');
    for (const sec of ['§0', '§2', '§3', '§5', '§6']) {
      if (text.indexOf('## ' + sec) === -1) problems.push('Align_Check.md 缺节 ' + sec);
    }
    const vers = new Set();
    const reVer = /自 (\d+\.\d+\.\d+)/g;
    let mv;
    while ((mv = reVer.exec(text)) !== null) vers.add(mv[1]);
    if (vers.size === 0) problems.push('Align_Check.md 的须补清单未标注「自 X.Y.Z」版本');
    else if (vers.size > 3) problems.push('Align_Check.md 收着 ' + vers.size + ' 个行为版本（上限 3）：' + [...vers].join('、'));
    const seg = text.split(/^## §3/m)[1] || '';
    const body = seg.split(/^## /m)[0];
    const rows = body.split(/\r?\n/).filter((l) => l.trim().startsWith('|'));
    const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').length;
    for (const row of rows) {
      if (cells(row) !== 6) problems.push('Align_Check.md §3 表列数不是 6：' + row.trim().slice(0, 40));
    }
  }
  const pkgNow = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const cur = path.join(releasesDir, pkgNow.version + '.md');
  if (fs.existsSync(cur)) {
    const t = fs.readFileSync(cur, 'utf8');
    if (!/\*\*状态刷新\*\*：(建议|无需)/.test(t)) problems.push(path.relative(root, cur) + ' 缺「**状态刷新**：建议 / 无需」一行');
  }
  if (fs.readFileSync(readme, 'utf8').indexOf('对齐检查') === -1) problems.push('README 未写「对齐检查」按钮');
}

// 9. 模板边界：standards 属工作区数据，插件不得预置正文；团队协作口径在 rules 下。
// 归属靠断言固定：任何人把规范正文放回模板目录，检查即失败。
{
  const tplStandards = path.join(root, 'src', 'templates', 'standards');
  if (fs.existsSync(tplStandards)) problems.push('src/templates/standards 不应存在：通用规范属工作区数据，插件不预置正文');
  const collab = path.join(root, 'src', 'templates', 'rules', 'Team_Collab_Rules.md');
  if (!fs.existsSync(collab)) problems.push('缺少 src/templates/rules/Team_Collab_Rules.md');
  const writingTpl = path.join(root, 'src', 'templates', 'rules', 'Writing_Rules.md');
  if (fs.existsSync(writingTpl)) problems.push('插件不应内置写作规则：个人写作口径属工作区数据，正文与模板都不随包');
  const scafSrc = fs.readFileSync(path.join(root, 'src', 'lib', 'scaffold.mjs'), 'utf8');
  if (scafSrc.indexOf('_Control_Center/user') !== -1) problems.push('部署清单不应写用户目录：个人数据不随插件落地');
  // 个人规范不得随包：随包文档与模板里不得出现条款编号或依据材料名。
  const shipped = files.filter((f) => path.dirname(f) !== releasesDir)
    .concat(listFiles(path.join(root, 'src', 'templates'), ['.md']).filter((f) => fs.existsSync(f)));
  for (const file of shipped) {
    const text = fs.readFileSync(file, 'utf8');
    if (/W-\d{2}/.test(text)) {
      problems.push(path.relative(root, file) + ' 引用了作者私有写作规范的条款编号，该规范不随包分发');
    }
    if (text.indexOf('依据_论文') !== -1) {
      problems.push(path.relative(root, file) + ' 引用了作者私有规范的依据材料「依据_论文」，该文件不随包分发');
    }
  }
}

if (problems.length) {
  console.log('CHECK-DOCS FAIL ' + problems.length + ' 项：');
  for (const p of problems) console.log('  - ' + p);
  process.exitCode = 1;
} else {
  console.log('CHECK-DOCS OK（' + files.length + ' 份文档，含版本说明 ' + releaseFiles.length + ' 份，工具名 ' + ALL_TOOL_NAMES.length + ' 个）');
}
