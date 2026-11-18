/**
 * 身份互转（1.0）：项目与杂项互换时先按归档规范做整库快照，再移动体系；
 * 也支持「直接建」：旧体系移入备份目录，不搬入新位置，新体系由会话按模板建立。
 *
 * 本模块只处理文件与登记，不改角色表；角色表由调用方写。
 */
import fs from 'node:fs';
import path from 'node:path';
import { NL, readUtf8, isDir, isFile } from './text.mjs';
import { stampNow, loadOffice, saveOffice, lineageKeyOf } from './office.mjs';
import { packDirTarGz } from './archive.mjs';
import { sevenZipBin, pack as pack7z } from './sevenzip.mjs';

function p2(n) { return String(n).padStart(2, '0'); }

function stampCompact() {
  const d = new Date();
  return d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '_' + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds());
}

function dateOnly() {
  const d = new Date();
  return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
}

function backupDirFor(ws) {
  return path.join(String(ws || ''), '_Archives', '_Global', 'Backups', '身份迁移_' + stampCompact());
}

/** 整库快照：有 7-Zip 出 .7z，否则出内置 .tar.gz。返回 { dir, made }。 */
function snapshotDirs(ws, dirs, dirOpt) {
  const dir = dirOpt || backupDirFor(ws);
  const made = [];
  const bin = sevenZipBin();
  let usedDir = false;
  for (const item of dirs || []) {
    const abs = String(item.abs || '');
    if (!abs || !isDir(abs)) continue;
    usedDir = true;
    fs.mkdirSync(dir, { recursive: true });
    const name = String(item.name || path.basename(abs));
    if (bin) {
      const out = path.join(dir, name + '.7z');
      const r = pack7z(bin, out, abs);
      if (r.code !== 0) throw new Error('快照失败（7-Zip，' + name + '）：' + r.out);
      made.push(out);
    } else {
      const out = path.join(dir, name + '.tar.gz');
      packDirTarGz(abs, out);
      made.push(out);
    }
  }
  return { dir: usedDir ? dir : '', made };
}

function listDir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

/** 把 srcDir 下的条目移入 destDir；冲突即中止。移完删除空源目录。 */
function moveContents(srcDir, destDir) {
  if (!isDir(srcDir)) return [];
  fs.mkdirSync(destDir, { recursive: true });
  const moved = [];
  for (const name of listDir(srcDir)) {
    const s = path.join(srcDir, name);
    const d = path.join(destDir, name);
    if (fs.existsSync(d)) throw new Error('目标已存在同名条目：' + d);
    fs.renameSync(s, d);
    moved.push(name);
  }
  try { fs.rmdirSync(srcDir); } catch { /* 非空或已删，保留 */ }
  return moved;
}

/**
 * 项目库根 Projects/<项目>/ 下通常只有一个 <项目>库 包装层；转杂项时拆掉这层，
 * 让杂项任务目录本身就是库根（与现有杂项任务一致），否则再转回项目会多套一层。
 */
function moveProjectLibInto(srcLib, destLib, oldName) {
  if (!isDir(srcLib)) return [];
  fs.mkdirSync(destLib, { recursive: true });
  const moved = [];
  const names = listDir(srcLib);
  const libName = oldName + '库';
  for (const name of names) {
    const s = path.join(srcLib, name);
    if (isDir(s) && (name === libName || (names.length === 1 && name.endsWith('库')))) {
      moved.push(...moveContents(s, destLib));
      try { fs.rmdirSync(s); } catch { /* 非空或已删 */ }
      continue;
    }
    const d = path.join(destLib, name);
    if (fs.existsSync(d)) throw new Error('目标已存在同名条目：' + d);
    fs.renameSync(s, d);
    moved.push(name);
  }
  try { fs.rmdirSync(srcLib); } catch { /* 非空或已删 */ }
  return moved;
}

function moveOne(srcFile, destFile) {
  if (!isFile(srcFile)) return false;
  if (fs.existsSync(destFile)) throw new Error('目标已存在同名文件：' + destFile);
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  fs.renameSync(srcFile, destFile);
  return true;
}

/** 改骨架档案：文件名与 root 字段。 */
function rewriteProfile(srcFile, destFile, root) {
  if (!isFile(srcFile)) return false;
  let v = {};
  try { v = JSON.parse(readUtf8(srcFile)); } catch { v = {}; }
  v.root = root;
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  fs.writeFileSync(destFile, JSON.stringify(v, null, 2) + NL, 'utf8');
  // 原地改写（srcFile === destFile）时不能把刚写好的文件删掉。
  if (path.resolve(srcFile) !== path.resolve(destFile)) fs.rmSync(srcFile, { force: true });
  return true;
}

/** 把注册与交接里的旧根路径改为新根，减少迁移后的失效条目。 */
function rewritePaths(file, from, to) {
  if (!isFile(file)) return false;
  let text = '';
  try { text = readUtf8(file); } catch { return false; }
  const next = text.split(from).join(to);
  if (next !== text) fs.writeFileSync(file, next, 'utf8');
  return next !== text;
}

// ---------------------------------------------------------------- 名册（Registry.md）

function registryFile(ws) {
  return path.join(String(ws || ''), '_Project_Meta', 'Registry.md');
}

function backupOnce(file) {
  try { if (isFile(file)) fs.copyFileSync(file, file + '.bak-' + stampCompact()); } catch { /* 备份失败不阻断，调用方另报 */ }
}

/** 从项目清单删除一行；找不到返回 false。 */
export function removeRegistryProject(ws, name) {
  const file = registryFile(ws);
  if (!isFile(file)) return false;
  const text = readUtf8(file).replace(/^\uFEFF/, '');
  const lines = text.split(NL);
  let inTable = false;
  let removed = false;
  const out = [];
  for (const line of lines) {
    if (line.startsWith('## ')) inTable = line.indexOf('项目清单') !== -1;
    if (inTable && line.startsWith('|')) {
      const cells = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      if (cells[0] === String(name).trim()) { removed = true; continue; }
    }
    out.push(line);
  }
  if (removed) { backupOnce(file); fs.writeFileSync(file, out.join(NL), 'utf8'); }
  return removed;
}

/** 追加一行项目；已有同名行则返回 false。 */
function addRegistryProject(ws, name) {
  const file = registryFile(ws);
  if (!isFile(file)) return false;
  const text = readUtf8(file).replace(/^\uFEFF/, '');
  const lines = text.split(NL);
  const row = '| ' + name + ' | `Projects/' + name + '/` | — | 进行中 | 无 | — | ' + dateOnly() + ' | general |';
  let inTable = false;
  let lastRow = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('## ')) inTable = line.indexOf('项目清单') !== -1;
    if (!inTable || !line.startsWith('|')) continue;
    const cells = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    if (cells[0] === String(name).trim()) return false;
    lastRow = i;
  }
  if (lastRow === -1) return false;
  lines.splice(lastRow + 1, 0, row);
  backupOnce(file);
  fs.writeFileSync(file, lines.join(NL), 'utf8');
  return true;
}

// ---------------------------------------------------------------- 在任登记改名

function moveOfficeLineage(ws, prev, next) {
  const store = loadOffice(ws);
  const oldKey = lineageKeyOf(prev.kind || prev.role, prev.project, prev.task);
  const newKey = lineageKeyOf(next.kind || next.role, next.project, next.task);
  if (!oldKey || !newKey) return { moved: false };
  const lin = store.lineages[oldKey];
  if (!lin) return { moved: false };
  if (oldKey === newKey) {
    // 同名互转：类别键不变，但类别、项目与任务字段要跟着改。
    const copy = JSON.parse(JSON.stringify(lin));
    copy.kind = next.kind || next.role;
    copy.project = String(next.project || '');
    copy.task = String(next.task || '');
    store.lineages[oldKey] = copy;
    backupOnce(path.join(String(ws || ''), '_Control_Center', 'records', 'Office.json'));
    saveOffice(ws, store);
    return { moved: false, updated: true, oldKey, newKey };
  }
  if (store.lineages[newKey]) {
    throw new Error('名册里已有「' + newKey + '」：先在设置页清理或在职会话处理，再转换身份');
  }
  const copy = JSON.parse(JSON.stringify(lin));
  copy.kind = next.kind || next.role;
  copy.project = String(next.project || '');
  copy.task = String(next.task || '');
  store.lineages[newKey] = copy;
  delete store.lineages[oldKey];
  backupOnce(path.join(String(ws || ''), '_Control_Center', 'records', 'Office.json'));
  saveOffice(ws, store);
  return { moved: true, oldKey, newKey };
}

// ---------------------------------------------------------------- 主流程

/**
 * 互转前置检查：名册冲突、备份落点与目标目录占用全部在移动前判完。
 * 任一项成立即抛错，此时尚未快照、尚未移动，源目录与角色表保持原状。
 * @param {object} o { ws, prev, next, mode, oldName, newName, backupDir }
 */
function preflightMigrate(o) {
  const prev = o.prev || {};
  const next = o.next || {};
  if (prev.role !== 'global-task') {
    const store = loadOffice(o.ws);
    const oldKey = lineageKeyOf(prev.kind || prev.role, prev.project, prev.task);
    const newKey = lineageKeyOf(next.kind || next.role, next.project, next.task);
    if (oldKey && newKey && oldKey !== newKey && store.lineages[newKey]) {
      throw new Error('名册里已有「' + newKey + '」：先在设置页清理或在职会话处理，再转换身份');
    }
  }
  if (o.mode === 'direct') {
    for (const name of ['旧体系_' + o.oldName, '旧元数据_' + o.oldName]) {
      const dest = path.join(o.backupDir, name);
      if (fs.existsSync(dest)) throw new Error('备份位置已存在：' + dest);
    }
    return;
  }
  const destLib = next.role === 'misc'
    ? path.join(o.ws, '_Misc', 'tasks', o.newName)
    : path.join(o.ws, 'Projects', o.newName, o.newName + '库');
  if (isDir(destLib) && listDir(destLib).length) throw new Error('目标目录已存在且非空：' + destLib);
  if (next.role === 'project') {
    const destMeta = path.join(o.ws, '_Project_Meta', o.newName);
    if (isDir(destMeta) && listDir(destMeta).length) throw new Error('目标目录已存在且非空：' + destMeta);
  }
}

/**
 * 执行身份互转。
 * @param {object} input { ws, prev, next, mode: 'auto'|'direct' }
 * @returns {{ mode, snapshot, moved, summary }}
 */
export function migrateIdentity(input) {
  const i = input || {};
  const ws = String(i.ws || '');
  const prev = i.prev || {};
  const next = i.next || {};
  const mode = i.mode === 'direct' ? 'direct' : 'auto';
  if (!ws) throw new Error('缺工作区根。请提供 ws 参数。');
  const prevKind = prev.role;
  const nextKind = next.role;
  const prevOk = prevKind === 'project' || prevKind === 'misc' || prevKind === 'global-task';
  if (!prevOk || (nextKind !== 'project' && nextKind !== 'misc')) {
    throw new Error('身份互转只处理项目、杂项与全局任务。请调整 prev.role 与 next.role。');
  }
  if (prevKind === nextKind) throw new Error('身份未变化，无需迁移。');

  const oldName = prevKind === 'project' ? String(prev.project || '') : String(prev.task || '');
  const newName = nextKind === 'project' ? String(next.project || '') : String(next.task || '');
  if (!oldName || !newName) throw new Error('缺旧名或新名。请提供 prev 与 next 的名称。');

  const srcLib = prevKind === 'project' ? path.join(ws, 'Projects', oldName)
    : prevKind === 'misc' ? path.join(ws, '_Misc', 'tasks', oldName)
      : path.join(ws, '_Control_Center', 'tasks', oldName);
  const srcMeta = prevKind === 'project' ? path.join(ws, '_Project_Meta', oldName) : '';
  const snapName = prevKind === 'project' ? 'Projects_' + oldName : prevKind === 'misc' ? '_Misc_' + oldName : '全局任务_' + oldName;
  // 备份落点先定下来：前置检查与后续移动必须指向同一目录，跨秒也不同名。
  const backupDir = backupDirFor(ws);
  preflightMigrate({ ws, prev, next, mode, oldName, newName, backupDir });
  const snap = snapshotDirs(ws, [
    { abs: srcLib, name: snapName },
    { abs: srcMeta, name: '_Project_Meta_' + oldName },
  ], backupDir);

  if (mode === 'direct') {
    // 直接建：旧体系整体移入备份目录，新位置只建空目录，由会话按模板建立。
    const movedTo = [];
    if (isDir(srcLib)) { movedTo.push(moveDirInto(srcLib, path.join(snap.dir || backupDir, '旧体系_' + oldName))); }
    if (isDir(srcMeta)) { movedTo.push(moveDirInto(srcMeta, path.join(snap.dir || backupDir, '旧元数据_' + oldName))); }
    if (prevKind === 'project') removeRegistryProject(ws, oldName);
    const target = nextKind === 'project'
      ? path.join(ws, 'Projects', newName, newName + '库')
      : path.join(ws, '_Misc', 'tasks', newName);
    fs.mkdirSync(target, { recursive: true });
    if (nextKind === 'project') {
      fs.mkdirSync(path.join(ws, '_Project_Meta', newName), { recursive: true });
      addRegistryProject(ws, newName);
    }
    const office = moveOfficeLineage(ws, prev, next);
    return {
      mode,
      snapshot: snap,
      moved: movedTo.length > 0,
      summary: '直接建：旧体系已移入 ' + (snap.dir || '备份目录') + '。新位置 ' + target + ' 为空目录。名册已调整' + (office.moved ? '，在任登记已改名' : ''),
    };
  }

  // auto：快照后移动体系。
  let destLib = '';
  let destMeta = '';
  if (nextKind === 'misc') {
    destLib = path.join(ws, '_Misc', 'tasks', newName);
    destMeta = destLib;
  } else {
    destLib = path.join(ws, 'Projects', newName, newName + '库');
    destMeta = path.join(ws, '_Project_Meta', newName);
  }
  fs.mkdirSync(destLib, { recursive: true });
  fs.mkdirSync(destMeta, { recursive: true });

  const moved = [];
  const toProject = nextKind === 'project';
  // 布局沿用现有项目：库内容进 Projects/<项目>/<项目>库，项目档案进 _Project_Meta/<项目>/。
  const rootRel = toProject ? 'Projects/' + newName : '_Misc/tasks/' + newName;
  const oldRoot = prevKind === 'project' ? 'Projects/' + oldName
    : prevKind === 'misc' ? '_Misc/tasks/' + oldName : '_Control_Center/tasks/' + oldName;

  if (isDir(srcLib)) {
    moved.push(...(prevKind === 'project' ? moveProjectLibInto(srcLib, destLib, oldName) : moveContents(srcLib, destLib)));
  }

  // 归位顺序：先把档案放到目标角色该在的位置，再挪其余内容。否则档案会随库被搬进库根。
  // 目标为项目时还会漏进 _Project_Meta。
  // 2026-11-16 第二轮测试：杂项转项目时档案落在库根、元数据目录为空。
  const metaDir = toProject ? destMeta : destLib;
  if (toProject) {
    for (const name of ['Handover.md', 'System.md', 'Project_Overview.md']) {
      if (moveOne(path.join(destLib, name), path.join(metaDir, name))) moved.push(name);
    }
  }

  const profileFrom = prevKind === 'project' ? path.join(srcMeta, 'project.profile.json') : path.join(destLib, 'task.profile.json');
  const profileTo = toProject ? path.join(destMeta, 'project.profile.json') : path.join(destLib, 'task.profile.json');
  if (isFile(profileFrom) && rewriteProfile(profileFrom, profileTo, rootRel)) moved.push(path.basename(profileTo));

  if (prevKind === 'project') {
    if (moveOne(path.join(srcMeta, 'Handover.md'), path.join(metaDir, 'Handover.md'))) moved.push('Handover.md');
    const sysTo = path.join(metaDir, 'System.md');
    if (moveOne(path.join(srcMeta, 'System.md'), sysTo)) {
      rewritePaths(sysTo, oldRoot, rootRel);
      moved.push('System.md');
    }
    for (const name of listDir(srcMeta)) {
      const s = path.join(srcMeta, name);
      const d = path.join(destLib, name);
      if (fs.existsSync(d)) continue;
      fs.renameSync(s, d);
      moved.push(name);
    }
    removeRegistryProject(ws, oldName);
  } else {
    // 迁入方不是项目：体系与交接由上面的归位与档案改写处理，只剩路径需要就地改正。
    const sysInPlace = path.join(metaDir, 'System.md');
    if (isFile(sysInPlace)) rewritePaths(sysInPlace, oldRoot, rootRel);
  }
  try { if (isDir(srcMeta)) fs.rmdirSync(srcMeta); } catch { /* 留空目录不影响使用 */ }
  try { if (isDir(srcLib)) fs.rmdirSync(srcLib); } catch { /* 留空目录不影响使用 */ }
  if (nextKind === 'project') addRegistryProject(ws, newName);

  const office = prevKind === 'global-task'
    ? { moved: false }
    : moveOfficeLineage(ws, prev, next);
  return {
    mode,
    snapshot: snap,
    moved: moved.length > 0,
    summary: '已快照 ' + (snap.made.length) + ' 份到 ' + (snap.dir || '备份目录') + '。体系已移至 ' + destLib
      + (office.moved ? '。在任登记由「' + office.oldKey + '」改为「' + office.newKey + '」' : ''),
  };
}

/** 把 srcDir 整体移入 destParent/<name>；返回目标路径。 */
function moveDirInto(srcDir, destDir) {
  if (fs.existsSync(destDir)) throw new Error('备份位置已存在：' + destDir);
  fs.mkdirSync(path.dirname(destDir), { recursive: true });
  fs.renameSync(srcDir, destDir);
  return destDir;
}

export { stampNow };
