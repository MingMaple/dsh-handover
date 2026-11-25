/**
 * 首次安装向导：在用户粘贴的目录里建「全局根」，并把整套文件体系铺好。
 * 只用 node:fs / node:path（跨平台，Windows / macOS / Linux / Android 的 PRoot Ubuntu 都一样）。
 * 安全边界：只新建；目标已存在且非空就什么都不写。已有文件绝不覆盖。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathKey } from './pathkey.mjs';

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
  'Projects',
  '_Project_Meta',
  '_Misc/tasks',
  '_Archives/_Global/Backups',
  '_Temp',
];

/** 机制规则清单：正文随插件本体分发，不铺到工作区；工作区留同名文件即视为本地化覆盖。对齐检查用它识别遗留副本。 */
export const MECHANISM_RULES = [
  'Handover_Rules.md',
  'Migration_Rules.md',
  'Misc_Task_Standard.md',
  'Delegation_Rules.md',
  'External_Takeover_Rules.md',
  'Team_Collab_Rules.md',
];

/** 工作区相对路径 ← 内置模板名。对齐检查复用它判断「工作区副本 vs 内置本体」。 */
export const FILES = [
  ['_Control_Center/records/Global_Handover.md', 'Handover.global.skeleton.md'],
  ['_Control_Center/records/Global_Changelog.md', 'Changelog.skeleton.md'],
  // 全局总注册：只列各任务体系文件的路径；由 ho_docmap 或 scaffold 维护。
  ['_Control_Center/records/systems.md', 'Systems.global.skeleton.md'],
  ['_Control_Center/rules/Workspace_Charter.md', 'Charter.skeleton.md'],
  ['_Control_Center/templates/Prompt_Templates.md', 'Prompt_Templates.md'],
  ['_Control_Center/templates/Handover.md', 'Handover.template.md'],
  ['_Control_Center/templates/Plan.skeleton.md', 'Plan.skeleton.md'],
  ['_Control_Center/templates/System.skeleton.md', 'System.skeleton.md'],
  // 通用规范目录只建空壳：规范属工作区数据，插件不预置任何正文。
  // 机制规则不落工作区：它们属插件功能，正文随包分发，会话按 rules-read 读取，不铺副本。
  // 工作区只放属于工作区自身的 2 类：章程骨架与模板骨架。
  // 工作区只放属于工作区自身的 2 类：章程骨架与模板骨架。规范与个人内容由工作区自己维护，插件既不预置也不写盘。
];

/** 规整用户粘贴的路径：去掉引号与末尾分隔符、展开 ~、解析成绝对路径。
 * @param {string} input 用户在设置页粘贴的路径
 * @returns {{parent?:string, createdParent?:boolean, path?:string, error?:string}} 成功给 parent，失败给 error
 */
function normalizeParent(input) {
  let s = String(input || '').trim();
  if (!s) return { error: '现象：未填写目录。原因：全局根需要建在父目录中。处置：填写父目录后重试。' };
  s = s.replace(/^["']+|["']+$/g, '').trim();
  if (!s) return { error: '现象：目录名为空。原因：输入只含引号或空白。处置：填写有效路径后重试。' };
  if (s === '~') s = os.homedir();
  else if (s.startsWith('~/') || s.startsWith('~\\')) s = path.join(os.homedir(), s.slice(2));
  const abs = path.resolve(s);
  let st = null;
  try { st = fs.statSync(abs); } catch { st = null; }
  if (st && !st.isDirectory()) {
    return { error: '现象：该路径不是目录：' + abs + '。原因：全局根必须建在目录中。处置：改填目录路径后重试。', path: abs };
  }
  // 目标父目录不存在就建：允许直接指定尚不存在的路径。
  if (!st) {
    try { fs.mkdirSync(abs, { recursive: true }); }
    catch (e) {
      return { error: '现象：无法创建该目录：' + abs + '。原因：' + String(e && e.message ? e.message : e) + '。处置：检查路径权限后重试，或改填已有目录。', path: abs };
    }
  }
  return { parent: abs, createdParent: !st };
}

/**
 * 在既有的全局根上补齐缺失的目录与说明文件：只新建，不覆盖，不删除任何文件。
 * 用途：插件新增了目录（例如通用规范库）后，已部署的工作区靠它一次补齐。
 * @param {string} root 已有全局根
 * @returns {{ok:boolean, created?:string[], written?:string[], skipped?:string[], missingTemplates?:string[], error?:string}}
 */
export function ensureScaffold(root) {
  const abs = String(root || '');
  let st = null;
  try { st = fs.statSync(abs); } catch { st = null; }
  if (!st || !st.isDirectory()) {
    return { ok: false, error: '现象：全局根不存在或不是目录：' + (abs || '（空）') + '。原因：补齐骨架要求目标目录已存在。处置：先建该目录，或改用 ho_workspace(action="create")。' };
  }

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
      return {
        ok: false,
        error: '现象：建目录失败：' + d + '。原因：' + String(e && e.message ? e.message : e) + '。处置：检查该路径的权限后重试。',
        created, written, skipped,
      };
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
      return {
        ok: false,
        error: '现象：写文件失败：' + rel + '。原因：' + (e && e.message ? e.message : e) + '。处置：检查目录权限与磁盘空间后重试。',
        created, written, skipped, missingTemplates,
      };
    }
  }
  return { ok: true, created, written, skipped, missingTemplates };
}

/**
 * 建全局根。
 * @param {string} parentInput 用户在设置页粘贴的父目录路径
 * @param {{name?:string}} [opts] 根目录名，缺省 _Workspace
 * @returns {{ok:boolean, root?:string, existed?:boolean, created?:string[], written?:string[], skipped?:string[], error?:string}}
 */
export function createGlobalWorkspace(parentInput, opts) {
  const t = normalizeParent(parentInput);
  if (t.error) return { ok: false, error: t.error };

  const name = (opts && typeof opts.name === 'string' && opts.name.trim()) || DEFAULT_ROOT_NAME;
  if (name.indexOf('/') !== -1 || name.indexOf('\\') !== -1 || name === '.' || name === '..') {
    return { ok: false, error: '现象：根目录名含路径分隔符：' + name + '。原因：根目录名只能是单级名字。处置：去掉分隔符后重试。' };
  }
  const sameName = pathKey(path.basename(t.parent)) === pathKey(name);
  const root = sameName ? t.parent : path.join(t.parent, name);

  let existed = false;
  if (fs.existsSync(root)) {
    let names = null;
    try { names = fs.readdirSync(root); } catch { /* 读不了当作非空 */ }
    if (names === null || names.length > 0) {
      return {
        ok: false,
        root,
        error: '现象：目标目录已存在且非空：' + root + '。原因：向导只新建，不覆盖已有内容。处置：改选空目录，或先移走已有内容后重试。',
      };
    }
    existed = true;
  }

  try {
    fs.mkdirSync(root, { recursive: true });
  } catch (e) {
    return { ok: false, root, error: '现象：无法创建全局根。原因：' + (e && e.message ? e.message : e) + '。处置：检查父目录权限后重试。' };
  }

  // 铺目录与写说明文件共用同一套清单：init 与 scaffold 不各写一份，避免 2 处清单走偏。
  const sc = ensureScaffold(root);
  if (!sc.ok) return { ok: false, root, created: sc.created, written: sc.written, error: sc.error };
  // 模板缺失不能静默算成功：文件体系只铺了一半，须让调用方报出来。
  if (Array.isArray(sc.missingTemplates) && sc.missingTemplates.length) {
    return {
      ok: false, root, existed,
      created: sc.created, written: sc.written, skipped: sc.skipped,
      missingTemplates: sc.missingTemplates,
      error: '现象：内置模板缺失，工作区未完整铺开。原因：缺 ' + sc.missingTemplates.join('、')
        + '。处置：重新安装插件后重试，或按 `_Control_Center` 模板目录手工补齐这些文件。',
    };
  }
  return { ok: true, root, existed, created: sc.created, written: sc.written, skipped: sc.skipped };
}
