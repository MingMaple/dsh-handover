/** 闸门：通用约束条同步复核与交接文档体检。 */
import path from 'node:path';
import { readUtf8, isFile, isDir } from './text.mjs';
import fs from 'node:fs';
import { charterPath, canonicalBlock, TITLE_KEY, WATER_KEY } from './charter.mjs';
import { readProfile, listProfiles } from './profile.mjs';
import { checkRegistries } from './system.mjs';

/**
 * 读 Registry.md 的「形态」列 → { 项目名: 形态 }。
 * 口径（Charter §1.6、§2.5）：只有 library 才受通用约束条闸门管；artifact、shortcut、product 属工程型，豁免。
 * 缺该列或读不到 → 全部按 library 处理（向后兼容）。
 */
function registryForms(ws) {
  const p = path.join(ws, '_Project_Meta', 'Registry.md');
  if (!isFile(p)) return {};
  let text = '';
  try { text = readUtf8(p); } catch { return {}; }
  const out = {};
  let head = null;
  for (const raw of text.split(/\r?\n/)) {
    const s = raw.trim();
    if (!s.startsWith('|')) continue;
    const cells = s.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    if (!head) {
      if (cells.indexOf('项目名') !== -1) head = cells;
      continue;
    }
    if (head.indexOf('形态') === -1) return {};
    if (cells.every((c) => /^[-:\s]*$/.test(c))) continue;
    const iName = head.indexOf('项目名');
    const iForm = head.indexOf('形态');
    if (cells.length <= Math.max(iName, iForm)) continue;
    out[cells[iName]] = cells[iForm].replace(/`/g, '').trim();
  }
  return out;
}

/** 工作区下所有「库型」项目库（带 RULES.md）：返回 [{ name, root }]；工程型按形态跳过。 */
function libraryRoots(ws) {
  const forms = registryForms(ws);
  const projDir = path.join(ws, 'Projects');
  const out = [];
  let projects = [];
  try { projects = fs.readdirSync(projDir); } catch { return out; }
  for (const name of projects) {
    const pdir = path.join(projDir, name);
    if (!isDir(pdir)) continue;
    const form = forms[name] || 'library';
    if (form !== 'library') continue;
    // 骨架档案可让项目决定是否启用 24 行约束条；未注册时按默认（启用）处理。
    const pf = readProfile(ws, { role: 'project', project: name });
    if (pf.exists && pf.profile.gate && pf.profile.gate.libraryBlock === false) continue;
    let libs = [];
    try { libs = fs.readdirSync(pdir); } catch { continue; }
    for (const lib of libs) {
      const root = path.join(pdir, lib);
      if (!isDir(root)) continue;
      if (isFile(path.join(root, 'RULES.md'))) out.push({ name, root });
    }
  }
  return out;
}

/** 插件内置的 Charter 骨架（dist/templates/Charter.skeleton.md）；工作区那份只是覆盖。 */
function bundledCharter() {
  try {
    const p = new URL('../templates/Charter.skeleton.md', import.meta.url);
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

/** 同步复核：返回 { libraries, total, missing, verdict, ok }。 */
export function syncCheck(ws) {
  const charter = charterPath(ws);
  // 口径：**插件自带的这套默认规则才是本体**，工作区里的同名文件是「本地化覆盖」。
  // 所以只有「连 _Control_Center 都没有」才算没接入工作区；有目录但没 Charter 时用内置那份继续跑。
  const hasCenter = isDir(path.join(ws, '_Control_Center'));
  let text = '';
  let builtin = false;
  if (isFile(charter)) {
    text = readUtf8(charter);
  } else if (hasCenter) {
    text = bundledCharter();
    builtin = true;
  } else {
    return {
      error: '本实例尚未接入工作区：读不到 ' + charter,
      path: charter,
      ok: false,
      noWorkspace: true,
    };
  }
  const blk = canonicalBlock(text);
  if (!blk || !blk.body || blk.body.length === 0) {
    return { error: '无法取得 §8.1.1.4 的正文（结构可能已变更）', path: charter, ok: false };
  }
  const rows = [];
  let bad = 0;
  for (const lib of libraryRoots(ws)) {
    const rules = readUtf8(path.join(lib.root, 'RULES.md'));
    const missing = blk.body.filter((l) => rules.indexOf(l) === -1);
    const titleOk = rules.indexOf(TITLE_KEY) !== -1;
    const waterOk = rules.indexOf(WATER_KEY) !== -1;
    const ok = titleOk && missing.length === 0 && waterOk;
    if (!ok) bad++;
    rows.push({ name: lib.name, titleOk, waterOk, missing, total: blk.body.length, ok });
  }
  return {
    libraries: rows,
    profiles: listProfiles(ws),
    total: rows.length,
    bodyLines: blk.body.length,
    builtin,
    missing: bad,
    ok: bad === 0,
    verdict: bad === 0

      ? "全部落位。"
      : bad + ' 个库有缺，向对应项目会话派发（由该会话写进本库 RULES.md；全局不得修改项目库内文件）。',
  };
}

export function renderSyncCheck(res) {
  const out = [];
  if (res.error) { out.push(res.error + '：' + res.path); return out; }
  out.push('通用约束条同步复核  库数 ' + res.total + '  正文 ' + res.bodyLines + ' 行  来源 §8.1.1.4' + (res.builtin ? '（工作区无 Workspace_Charter.md，采用插件内置口径）' : ''));
  for (const r of res.libraries) {
    const flag = r.ok ? '通过' : '未通过';
    out.push('  ' + r.name + '  标题 ' + (r.titleOk ? '通过' : '缺') + '  正文 ' + (r.total - r.missing.length) + '/' + r.total +
      '  水位自查 ' + (r.waterOk ? '通过' : '缺') + '  ' + flag);
    for (const m of r.missing.slice(0, 3)) out.push("        缺：" + m.slice(0, 70));
  }
  const ps = res.profiles || [];
  if (ps.length) {
    out.push('');
    out.push('项目与杂项骨架');
    for (const p of ps) {
      const flag = p.exists ? (p.ok ? '通过' : '未通过') : '待注册';
      const miss = p.missing && p.missing.length ? '  缺 ' + p.missing.join('、') : '';
      out.push('  ' + p.name + '  ' + flag + '  类别 ' + p.kind + miss);
    }
  }
  out.push('');
  out.push('判定：' + res.verdict);
  return out;
}

/** 体系注册：只检查表内路径是否仍然存在（不判字数、不判内容）。 */
export function docmapReport(ws) {
  return checkRegistries(ws);
}

export function renderDocmapCheck(res) {
  const out = [];
  out.push('体系注册  任务 ' + res.rows.length + ' 个');
  if (!res.rows.length) {
    out.push('  尚无任何任务注册（空注册不注入正文，属正常）');
    out.push('判定：无需检查');
    return out;
  }
  for (const r of res.rows) {
    out.push('  ' + r.label + '  ' + r.rel + '  ' + (r.exists ? r.entries + ' 条' : '未设置') + '  ' + (r.bad.length ? '失效 ' + r.bad.length + ' 条' : '路径全部存在'));
    for (const b of r.bad.slice(0, 3)) out.push('        失效：' + b.path + ' —— ' + b.problem);
  }
  out.push('判定：' + (res.missing === 0
    ? '全部落位。'
    : res.missing + ' 条路径失效，由该类别在任会话用 ho_docmap(action="write") 更新。'));
  return out;
}