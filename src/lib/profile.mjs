/**
 * 项目与杂项的骨架档案：由本会话自行判断、写入、注册；插件只校验与引用。
 * 项目：_Project_Meta/<项目>/project.profile.json
 * 杂项：_Misc/tasks/<任务>/task.profile.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { isFile } from './text.mjs';

const PROFILE_SCHEMA = 1;
export const PROFILE_KINDS = ['application', 'animation', 'library', 'general'];
const PROJECT_FILE = 'project.profile.json';
const TASK_FILE = 'task.profile.json';

const PRESETS = {
  application: {
    kind: 'application',
    required: ['README.md', 'src'],
    optional: ['SKILL.md', 'CHANGELOG.md'],
    docs: ['docs/'],
    gate: { libraryBlock: false },
    notes: '构建型项目：不要求插件类项目的文档集。',
  },
  animation: {
    kind: 'animation',
    required: ['README.md'],
    optional: ['src', 'public', 'assets'],
    docs: [],
    gate: { libraryBlock: false },
    notes: '动画与视频项目：不要求代码库式的目录与文档。',
  },
  library: {
    kind: 'library',
    required: ['README.md', 'RULES.md'],
    optional: ['docs/', 'SKILL.md'],
    docs: ['docs/'],
    gate: { libraryBlock: true },
    notes: '库型项目：启用 24 行通用约束条校验。',
  },
  general: {
    kind: 'general',
    required: [],
    optional: [],
    docs: [],
    gate: { libraryBlock: false },
    notes: '通用骨架：只保留最小约束。',
  },
};

export function presets() {
  return JSON.parse(JSON.stringify(PRESETS));
}

export function profilePathFor(ws, info) {
  if (!ws || !info) return null;
  if (info.role === 'project' && info.project) return path.join(ws, '_Project_Meta', info.project, PROJECT_FILE);
  if (info.role === 'misc' && info.task) return path.join(ws, '_Misc', 'tasks', info.task, TASK_FILE);
  return null;
}

/** 未注册时的默认骨架：沿用现有目录约定，24 行约束条默认启用（向后兼容）。 */
function defaultProfile(info) {
  const base = {
    schema: PROFILE_SCHEMA,
    kind: 'general',
    root: '',
    required: [],
    optional: [],
    docs: [],
    meta: [],
    gate: { libraryBlock: true },
    handover: { extraSections: [] },
    notes: '未注册：按默认骨架运行。',
  };
  if (info && info.role === 'project' && info.project) {
    base.root = 'Projects/' + info.project;
    base.required = [];
    base.optional = ['SKILL.md'];
    base.meta = [];
    base.notes = '未注册：按默认骨架运行，请由本项目会话补注册。';
  } else if (info && info.role === 'misc' && info.task) {
    base.root = '_Misc/tasks/' + info.task;
    base.required = [];
    base.notes = '未注册：按默认骨架运行，请由本任务会话补注册。';
  }
  return base;
}

function cleanList(v, field, errors) {
  if (v === undefined) return [];
  if (!Array.isArray(v)) { errors.push(field + ' 必须是数组'); return []; }
  const out = [];
  for (const x of v) {
    const s = String(x == null ? '' : x).trim().replace(/\\/g, '/');
    if (!s) continue;
    if (path.isAbsolute(s) || /^[A-Za-z]:/.test(s) || s.split('/').indexOf('..') !== -1) {
      errors.push(field + ' 不得使用绝对路径或 ..：' + s);
      continue;
    }
    if (out.indexOf(s) === -1) out.push(s);
  }
  return out;
}

/** 规范化并校验结构；返回 { profile, errors }。路径越界与类型错误进 errors。 */
export function normalizeProfile(raw, info) {
  const errors = [];
  const src = raw && typeof raw === 'object' ? raw : {};
  const kind = PROFILE_KINDS.indexOf(String(src.kind || '')) !== -1 ? String(src.kind) : 'general';
  const rootDefault = info && info.role === 'project' && info.project
    ? 'Projects/' + info.project
    : (info && info.role === 'misc' && info.task ? '_Misc/tasks/' + info.task : '');
  const root = String(src.root || rootDefault).trim().replace(/\\/g, '/');
  if (path.isAbsolute(root) || /^[A-Za-z]:/.test(root) || root.split('/').indexOf('..') !== -1) {
    errors.push('root 不得使用绝对路径或 ..');
  }
  const profile = {
    schema: PROFILE_SCHEMA,
    kind,
    root,
    required: cleanList(src.required, 'required', errors),
    optional: cleanList(src.optional, 'optional', errors),
    docs: cleanList(src.docs, 'docs', errors),
    meta: cleanList(src.meta, 'meta', errors),
    gate: { libraryBlock: !!(src.gate && src.gate.libraryBlock === true) },
    handover: { extraSections: cleanList(src.handover && src.handover.extraSections, 'handover.extraSections', errors) },
    notes: String(src.notes == null ? '' : src.notes).trim(),
  };
  return { profile, errors };
}

export function readProfile(ws, info) {
  const p = profilePathFor(ws, info);
  if (!p) return { exists: false, path: null, profile: defaultProfile(info), errors: [] };
  if (!isFile(p)) return { exists: false, path: p, profile: defaultProfile(info), errors: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const r = normalizeProfile(raw, info);
    return { exists: true, path: p, profile: r.profile, errors: r.errors };
  } catch (e) {
    return { exists: true, path: p, profile: defaultProfile(info), errors: ['读或解析失败：' + (e && e.message ? e.message : String(e))] };
  }
}

export function writeProfile(ws, info, raw) {
  const p = profilePathFor(ws, info);
  if (!p) throw new Error('当前角色没有骨架路径（须为项目或杂项）');
  const r = normalizeProfile(raw, info);
  if (r.errors.length) throw new Error('骨架结构不合法：' + r.errors.join('；'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  if (isFile(p)) fs.copyFileSync(p, p + '.bak');
  fs.writeFileSync(p, JSON.stringify(r.profile, null, 2) + String.fromCharCode(10), 'utf8');
  return { path: p, profile: r.profile };
}

/** 校验：结构错误与必需项缺失分开报；docs 与 optional 不强制存在。 */
export function validateProfile(ws, info, profile) {
  const p = profile || readProfile(ws, info).profile;
  const errors = [];
  const missing = [];
  const root = path.join(ws, p.root || '');
  for (const rel of p.required || []) {
    const f = path.join(root, rel);
    if (!fs.existsSync(f)) missing.push(rel);
  }
  const metaRoot = info && info.role === 'project' && info.project
    ? path.join(ws, '_Project_Meta', info.project)
    : (info && info.role === 'misc' && info.task ? path.join(ws, '_Misc', 'tasks', info.task) : null);
  // meta 条目相对档案目录（_Project_Meta/<项目>/ 或 _Misc/tasks/<任务>/），不是库内路径；
  // 报缺时给全路径，避免被读成库内或某个 _meta/ 子目录。
  const metaLabel = info && info.role === 'project' && info.project
    ? '_Project_Meta/' + info.project + '/'
    : (info && info.task ? '_Misc/tasks/' + info.task + '/' : '');
  if (metaRoot) {
    for (const rel of p.meta || []) {
      if (!fs.existsSync(path.join(metaRoot, rel))) missing.push(metaLabel + rel);
    }
  }
  return { ok: errors.length === 0 && missing.length === 0, errors, missing };
}

/** 已注册骨架清单（读文件，不写）：项目与杂项各一组。 */
export function listProfiles(ws) {
  const out = [];
  const scan = (dir, role, nameKey) => {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names) {
      const d = path.join(dir, name);
      try { if (!fs.statSync(d).isDirectory()) continue; } catch { continue; }
      const file = path.join(d, role === 'project' ? PROJECT_FILE : TASK_FILE);
      const info = { role, project: role === 'project' ? name : '', task: role === 'misc' ? name : '' };
      const r = readProfile(ws, info);
      const v = validateProfile(ws, info, r.profile);
      out.push({
        role, name, path: file, exists: r.exists,
        kind: r.profile.kind, ok: v.ok, missing: v.missing, errors: r.errors.concat(v.errors),
      });
    }
  };
  scan(path.join(ws, '_Project_Meta'), 'project');
  scan(path.join(ws, '_Misc', 'tasks'), 'misc');
  return out;
}
