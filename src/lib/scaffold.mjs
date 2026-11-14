/**
 * 首次安装向导：在用户粘贴的目录里建「全局根」，并把整套文件体系铺好。
 * 只用 node:fs / node:path（跨平台，Windows / macOS / Linux / Android 的 PRoot Ubuntu 都一样）。
 * 安全边界：只新建；目标已存在且非空就一个字都不改。已有文件绝不覆盖。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 插件自带的模板目录（dist/templates 或 src/templates）。 */
const TPL = new URL('../templates/', import.meta.url);

function template(name) {
  return fs.readFileSync(new URL(name, TPL), 'utf8');
}

const DEFAULT_ROOT_NAME = '_Workspace';

/** 目录清单（'/' 分隔，落地时换成本机分隔符）。 */
const DIRS = [
  '_Control_Center/records',
  '_Control_Center/rules',
  '_Control_Center/standards',
  '_Control_Center/templates',
  '_Control_Center/tools',
  '_Control_Center/tasks',
  '_Control_Center/user',
  'Projects',
  '_Project_Meta',
  '_Misc/tasks',
  '_Archives/_Global/Backups',
  '_Temp',
];

const FILES = [
  ['_Control_Center/records/Global_Handover.md', 'Handover.global.skeleton.md'],
  ['_Control_Center/records/Global_Changelog.md', 'Changelog.skeleton.md'],
  // 全局总注册：只列各任务体系文件的路径；由 ho_docmap 或 scaffold 维护。
  ['_Control_Center/records/systems.md', 'Systems.global.skeleton.md'],
  ['_Control_Center/rules/Workspace_Charter.md', 'Charter.skeleton.md'],
  ['_Control_Center/templates/Prompt_Templates.md', 'Prompt_Templates.md'],
  ['_Control_Center/templates/Plan.skeleton.md', 'Plan.skeleton.md'],
  ['_Control_Center/templates/System.skeleton.md', 'System.skeleton.md'],
  // 通用规范：一条规范一个子目录，各角色会话都可读，只有全局写。
  ['_Control_Center/standards/README.md', 'standards/README.md'],
  ['_Control_Center/standards/写作规范/README.md', 'standards/写作规范/README.md'],
  ['_Control_Center/standards/写作规范/依据_论文.md', 'standards/写作规范/依据_论文.md'],
  // 规则类：工作区没有这份时，ho_charter 会退回同名内置版本；这里先铺一份可改的默认口径。
  ['_Control_Center/rules/Handover_Rules.md', 'rules/Handover_Rules.md'],
  ['_Control_Center/rules/Migration_Rules.md', 'rules/Migration_Rules.md'],
  ['_Control_Center/rules/Misc_Task_Standard.md', 'rules/Misc_Task_Standard.md'],
  ['_Control_Center/rules/Delegation_Rules.md', 'rules/Delegation_Rules.md'],
  ['_Control_Center/user/Writing_Rules.md', 'rules/Writing_Rules.md'],
];

/** 规整用户粘贴的路径：去掉引号/尾分隔符、展开 ~、解析成绝对路径。 */
function normalizeParent(input) {
  let s = String(input || '').trim();
  if (!s) return { error: '先粘贴一个目录（父目录，全局根会建在它里面）' };
  s = s.replace(/^["']+|["']+$/g, '').trim();
  if (!s) return { error: '先粘贴一个目录' };
  if (s === '~') s = os.homedir();
  else if (s.startsWith('~/') || s.startsWith('~\\')) s = path.join(os.homedir(), s.slice(2));
  const abs = path.resolve(s);
  let st = null;
  try { st = fs.statSync(abs); } catch { st = null; }
  if (st && !st.isDirectory()) return { error: '这不是一个目录：' + abs, path: abs };
  // 目标父目录不存在就建：允许直接指定尚不存在的路径。
  if (!st) {
    try { fs.mkdirSync(abs, { recursive: true }); }
    catch (e) { return { error: '建不出这个目录：' + abs + '（' + String(e && e.message ? e.message : e) + '）', path: abs }; }
  }
  return { parent: abs, createdParent: !st };
}

/**
 * 在既有的全局根上补齐缺失的目录与说明文件：只新建，不覆盖，不删任何东西。
 * 用途：插件新增了目录（例如通用规范库）后，已部署的工作区靠它一次补齐。
 */
export function ensureScaffold(root) {
  const abs = String(root || '');
  let st = null;
  try { st = fs.statSync(abs); } catch { st = null; }
  if (!st || !st.isDirectory()) return { ok: false, error: '全局根不存在或不是目录：' + (abs || '（空）') };

  const created = [];
  const written = [];
  const skipped = [];
  const missingTemplates = [];
  for (const d of DIRS) {
    const p = path.join(abs, d.split('/').join(path.sep));
    if (!fs.existsSync(p)) created.push(d);
    try {
      fs.mkdirSync(p, { recursive: true });
    } catch (e) {
      return { ok: false, error: '建目录失败：' + d + '（' + String(e && e.message ? e.message : e) + '）', created, written, skipped };
    }
  }
  for (const [rel, tpl] of FILES) {
    const dst = path.join(abs, rel.split('/').join(path.sep));
    if (fs.existsSync(dst)) { skipped.push(rel); continue; }
    let body = '';
    try {
      body = template(tpl);
    } catch {
      // 内置模板缺失时不写空文件，登记后由调用方报出，避免静默留下半套体系。
      missingTemplates.push(rel);
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, body, 'utf8');
      written.push(rel);
    } catch (e) {
      return { ok: false, error: '写文件失败（' + rel + '）：' + (e && e.message ? e.message : e), created, written, skipped, missingTemplates };
    }
  }
  return { ok: true, created, written, skipped, missingTemplates };
}

/**
 * 建全局根。
 * @param parentInput 用户在设置页粘贴的路径
 * @param opts {{ name?: string }} 根目录名，默认 _Workspace
 * @returns {{ ok: boolean, root?: string, created?: string[], written?: string[], skipped?: string[], error?: string }}
 */
export function createGlobalWorkspace(parentInput, opts) {
  const t = normalizeParent(parentInput);
  if (t.error) return { ok: false, error: t.error };

  const name = (opts && typeof opts.name === 'string' && opts.name.trim()) || DEFAULT_ROOT_NAME;
  if (name.indexOf('/') !== -1 || name.indexOf('\\') !== -1 || name === '.' || name === '..') {
    return { ok: false, error: '根目录名不能带路径分隔符：' + name };
  }
  const sameName = path.basename(t.parent).toLowerCase() === name.toLowerCase();
  const root = sameName ? t.parent : path.join(t.parent, name);

  let existed = false;
  if (fs.existsSync(root)) {
    let names = null;
    try { names = fs.readdirSync(root); } catch { /* 读不了当作非空 */ }
    if (names === null || names.length > 0) {
      return { ok: false, root, error: '目标已存在且非空，未做任何改动：' + root };
    }
    existed = true;
  }

  try {
    fs.mkdirSync(root, { recursive: true });
  } catch (e) {
    return { ok: false, root, error: '建目录失败：' + (e && e.message ? e.message : e) };
  }

  // 铺目录与说明文件走同一套清单：init 与 scaffold 两处不得各写一份。
  const sc = ensureScaffold(root);
  if (!sc.ok) return { ok: false, root, created: sc.created, written: sc.written, error: sc.error };
  return { ok: true, root, existed, created: sc.created, written: sc.written, skipped: sc.skipped };
}
