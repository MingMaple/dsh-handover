/**
 * 对齐检查：插件换版后，把「工作区里已落地的文件体系」与当前插件口径对一遍。
 *
 * 只读，不写盘。2 个消费者共用这一份结论：
 * - `ho_status(view="align")`：全局会话点击设置页按钮后，一条命令拿到全部机械可判的缺项；
 * - 设置页「对齐检查」按钮的唤醒词：携带内置标准文件 `templates/Align_Check.md` 的绝对路径。
 *
 * 口径：工作区同名文件是「本地化覆盖」，插件自带的模板是「本体」。
 * 覆盖可以合法地多出内容，但本体新增的节不会自动出现在覆盖里，这正是换版后须补的主项。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS } from './config.mjs';
import { FILES, MECHANISM_RULES } from './scaffold.mjs';
import { listProfiles } from './profile.mjs';
import { checkRegistries } from './system.mjs';
import { syncCheck } from './gates.mjs';
import { loadOffice, lineageKeyOf } from './office.mjs';
import { lintGlobal, lintProject } from './lint.mjs';
import { readUtf8, isFile, isDir } from './text.mjs';

const TPL = new URL('../templates/', import.meta.url);

/** 内置标准文件的绝对路径：唤醒词里给这一条，全局按它执行。 */
export function alignDocPath() {
  return fileURLToPath(new URL('Align_Check.md', TPL));
}

/** 记录类文件不是模板，比节标题没有意义，跳开。 */
function isRecord(rel) {
  return rel.indexOf('_Control_Center/records/') === 0;
}

/** 取二三级标题（`## ` 与 `### `），去掉编号与空白后比较。 */
function headings(text) {
  const out = [];
  for (const raw of String(text || '').split(String.fromCharCode(10))) {
    const line = raw.trim();
    if (!line.startsWith('## ')) continue;
    const t = line.replace(/^#+\s+/, '').trim();
    if (t) out.push(t);
  }
  return out;
}

/** 工作区副本 vs 内置模板：只报「本体有、覆盖里没有」的节，以及整份缺失。 */
function copyDrift(ws) {
  const rows = [];
  for (const [rel, tpl] of FILES) {
    if (isRecord(rel)) continue;
    const file = path.join(ws, rel.split('/').join(path.sep));
    let bundled = '';
    try { bundled = fs.readFileSync(new URL(tpl, TPL), 'utf8'); } catch { continue; }
    if (!isFile(file)) {
      rows.push({ rel, exists: false, bundledOnly: [], wsExtra: 0 });
      continue;
    }
    let local = '';
    try { local = readUtf8(file); } catch { local = ''; }
    const bh = headings(bundled);
    const lh = headings(local);
    const localSet = new Set(lh);
    const bundledSet = new Set(bh);
    const missing = bh.filter((t) => !localSet.has(t));
    const extra = lh.filter((t) => !bundledSet.has(t));
    if (missing.length || !local) rows.push({ rel, exists: true, bundledOnly: missing, wsExtra: extra.length });
  }
  return rows;
}

/** 遗留副本：机制规则已改为随插件本体分发，工作区若仍有同名文件，会盖住内置版本。 */
function legacyRules(ws) {
  const dir = path.join(ws, '_Control_Center', 'rules');
  return MECHANISM_RULES
    .filter((name) => isFile(path.join(dir, name)))
    .map((name) => ({ rel: '_Control_Center/rules/' + name, name }));
}

/** 配置里被本工作区改过的键（与插件默认值对照）。 */
function configDrift(cfg) {
  const out = [];
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  for (const key of Object.keys(DEFAULTS)) {
    if (!(key in c)) continue;
    const now = c[key];
    if (JSON.stringify(now) === JSON.stringify(DEFAULTS[key])) continue;
    out.push({ key, value: now, def: DEFAULTS[key] });
  }
  return out;
}

/** 目录下的交接体检：全局按全局结构，项目与杂项都按项目交接的结构判据（与设置页同口径）。 */
function lintHandover(kind, name, file) {
  const r = kind === 'global' ? lintGlobal(file) : lintProject(file);
  return { kind, name, verdict: r.verdict, reasons: Array.isArray(r.reasons) ? r.reasons.slice(0, 3) : [] };
}

/** 在任登记覆盖情况：登记里有、目录没有；目录有、登记没有。 */
function officeGap(ws) {
  const store = loadOffice(ws);
  const lineages = (store && store.lineages) || {};
  const globalLin = lineages[lineageKeyOf('global')] || null;
  const has = (kind, name) => {
    const lin = lineages[lineageKeyOf(kind, name, name)];
    return lin && lin.current && String(lin.current.sessionId || '') ? lin.current : null;
  };
  const unregistered = [];
  const look = (kind, dir, label) => {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (!isDir(path.join(dir, name))) continue;
      if (label === 'project' && name === 'Registry.md') continue;
      if (!has(kind, name)) unregistered.push({ kind, name });
    }
  };
  look('project', path.join(ws, '_Project_Meta'), 'project');
  look('misc', path.join(ws, '_Misc', 'tasks'), 'misc');
  return {
    global: globalLin && globalLin.current && globalLin.current.sessionId
      ? { name: String(globalLin.current.name || ''), sessionId: String(globalLin.current.sessionId) }
      : null,
    unregistered,
  };
}

/**
 * 出一次对齐报告。
 * @param {string} ws 工作区根
 * @param {object} env 插件环境，取 `cfg`
 * @returns {object} 分组结果；全部分组只列「有缺」的项
 */
export function alignReport(ws, env) {
  const root = String(ws || '');
  const cfg = (env && env.cfg) || {};
  const out = {
    root,
    docPath: alignDocPath(),
    connected: isDir(path.join(root, '_Control_Center')),
    config: [],
    copies: [],
    legacy: [],
    profiles: [],
    registries: { rows: [], unset: 0 },
    gate: { ok: true, total: 0, libraries: [] },
    handover: { global: null, rows: [] },
    office: { global: null, unregistered: [] },
  };
  if (!out.connected) return out;

  out.config = configDrift(cfg);
  out.copies = copyDrift(root);
  out.legacy = legacyRules(root);

  for (const p of listProfiles(root)) {
    if (!p.exists) out.profiles.push({ name: p.name, role: p.role, kind: p.kind, exists: false, missing: [] });
    else if (!p.ok) out.profiles.push({ name: p.name, role: p.role, kind: p.kind, exists: true, missing: p.missing || [] });
  }

  const reg = checkRegistries(root);
  out.registries.rows = reg.rows
    .filter((r) => !r.exists || !r.entries || (r.bad && r.bad.length))
    .map((r) => ({ label: r.label, exists: r.exists, entries: r.entries || 0, bad: r.bad ? r.bad.length : 0 }));
  out.registries.unset = out.registries.rows.filter((r) => !r.exists).length;

  const gate = syncCheck(root);
  out.gate = {
    ok: !!gate.ok,
    total: gate.total || 0,
    libraries: (gate.libraries || []).filter((r) => !r.ok)
      .map((r) => ({ name: r.name, missing: r.missing ? r.missing.length : 0, readError: r.readError || '' })),
  };

  out.handover.global = lintHandover('global', '全局', path.join(root, '_Control_Center', 'records', 'Global_Handover.md'));
  let projNames = [];
  try { projNames = fs.readdirSync(path.join(root, '_Project_Meta')); } catch { projNames = []; }
  for (const name of projNames) {
    if (!isDir(path.join(root, '_Project_Meta', name))) continue;
    out.handover.rows.push(lintHandover('project', name, path.join(root, '_Project_Meta', name, 'Handover.md')));
  }
  let miscNames = [];
  try { miscNames = fs.readdirSync(path.join(root, '_Misc', 'tasks')); } catch { miscNames = []; }
  for (const name of miscNames) {
    if (!isDir(path.join(root, '_Misc', 'tasks', name))) continue;
    out.handover.rows.push(lintHandover('misc', name, path.join(root, '_Misc', 'tasks', name, 'Handover.md')));
  }

  out.office = officeGap(root);
  return out;
}

/** 有没有任何须补项：供唤醒词与设置页判断「是否值得打扰用户」。 */
export function alignHasGap(res) {
  const r = res || {};
  return !!(
    (r.config && r.config.length)
    || (r.copies && r.copies.length)
    || (r.legacy && r.legacy.length)
    || (r.profiles && r.profiles.length)
    || (r.registries && r.registries.rows.length)
    || (r.gate && (r.gate.libraries.length || !r.gate.ok))
    || (r.handover && r.handover.rows.some((x) => x.verdict !== '通过' && x.verdict !== '缺节'))
    || (r.handover && r.handover.global && r.handover.global.verdict !== '通过')
    || (r.office && r.office.unregistered.length)
  );
}

/**
 * 渲染成文本：只列缺项，目标 40 行以内。
 * @param {object} res alignReport 的结果
 * @param {object} [opts] `{ version, verbose }`
 * @returns {string}
 */
export function renderAlign(res, opts) {
  const r = res || {};
  const o = opts || {};
  const out = [];
  out.push('对齐检查  插件 ' + String(o.version || '?') + '  工作区 ' + (r.root || '（未接入）'));
  if (!r.connected) {
    out.push('  结论：本实例未接入工作区，没有可对齐的文件体系。');
    return out.join(String.fromCharCode(10));
  }
  out.push('  内置标准文件 `' + r.docPath + '`');
  let gap = 0;

  if (r.config && r.config.length) {
    gap += r.config.length;
    out.push('');
    out.push('配置（本工作区改过 ' + r.config.length + ' 项，换版后须确认是否随新版调整）');
    for (const c of r.config.slice(0, 6)) out.push('  ' + c.key + ' = ' + JSON.stringify(c.value) + '（默认 ' + JSON.stringify(c.def) + '）');
  }

  if (r.copies && r.copies.length) {
    gap += r.copies.length;
    out.push('');
    out.push('工作区副本与内置本体不一致 ' + r.copies.length + ' 份（只列「本体有、副本无」的节）');
    for (const c of r.copies.slice(0, 8)) {
      if (!c.exists) out.push('  缺整份：' + c.rel);
      else out.push('  ' + c.rel + '  缺节 ' + c.bundledOnly.length + (c.bundledOnly.length ? '：' + c.bundledOnly.slice(0, 2).join('／') : ''));
    }
  }

  if (r.legacy && r.legacy.length) {
    gap += r.legacy.length;
    out.push('');
    out.push('遗留机制规则副本 ' + r.legacy.length + ' 份（正文已随插件分发，工作区同名文件会盖住内置版本）');
    for (const x of r.legacy.slice(0, 8)) out.push('  ' + x.rel + '  未改动则删除，确有本地化改动则保留并记一句用途');
  }

  if (r.profiles && r.profiles.length) {
    gap += r.profiles.length;
    out.push('');
    out.push('骨架档案（project.profile.json / task.profile.json）');
    for (const p of r.profiles.slice(0, 8)) {
      out.push('  ' + p.name + '  ' + (p.exists ? '有档案但校验未过：缺 ' + p.missing.join('、') : '未注册'));
    }
  }

  if (r.registries && r.registries.rows.length) {
    gap += r.registries.rows.length;
    out.push('');
    out.push('体系注册（System.md）');
    for (const x of r.registries.rows.slice(0, 10)) {
      out.push('  ' + x.label + '  ' + (x.exists ? (x.entries ? '失效 ' + x.bad + ' 条' : '空表') : '缺文件'));
    }
  }

  if (r.gate && r.gate.libraries.length) {
    gap += r.gate.libraries.length;
    out.push('');
    out.push('通用约束条（库内 RULES.md）未通过 ' + r.gate.libraries.length + ' 个');
    for (const g of r.gate.libraries.slice(0, 6)) {
      out.push('  ' + g.name + '  ' + (g.readError ? '读不到' : '缺 ' + g.missing + ' 行'));
    }
  }

  const badHo = (r.handover && r.handover.rows ? r.handover.rows : []).filter((x) => x.verdict !== '通过' && x.verdict !== '缺节');
  if (badHo.length || (r.handover && r.handover.global && r.handover.global.verdict !== '通过')) {
    gap += badHo.length + 1;
    out.push('');
    out.push('交接文档体检未通过');
    for (const h of badHo.slice(0, 6)) out.push('  ' + (h.kind === 'project' ? '项目' : '杂项') + '「' + h.name + '」' + h.verdict + (h.reasons.length ? '：' + h.reasons[0] : ''));
    const g = r.handover && r.handover.global;
    if (g && g.verdict !== '通过') out.push('  全局交接 ' + g.verdict + (g.reasons.length ? '：' + g.reasons[0] : ''));
  }

  if (r.office && r.office.unregistered.length) {
    gap += r.office.unregistered.length;
    out.push('');
    out.push('在任登记缺条目 ' + r.office.unregistered.length + ' 个（有目录、未登记）');
    for (const u of r.office.unregistered.slice(0, 8)) out.push('  ' + (u.kind === 'project' ? '项目' : '杂项') + '「' + u.name + '」');
  }

  out.push('');
  out.push(gap ? '判定：' + gap + ' 项须确认；按 `Align_Check.md` 出清单后先问用户补哪些，未获选择不写文件。' : '判定：全部对齐，无需补。');
  return out.join(String.fromCharCode(10));
}
