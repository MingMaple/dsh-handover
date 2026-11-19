/**
 * 身份互转（1.0）：项目与杂项互换时先按归档规范做整库快照，再移动体系；
 * 也支持「直接建」：旧体系移入备份目录，不搬入新位置，新体系由会话按模板建立。
 *
 * 1.0.3 起：迁移只回清单，不机械改写 System.md 正文——正文里的身份与路径由会话重写，
 * 清单逐项列出须重写的文件；备份文件（.bak）不随迁，单独列入清单。
 *
 * 本模块只处理文件与登记，不改角色表；角色表由调用方写。
 */
import fs from 'node:fs';
import path from 'node:path';
import { NL, readUtf8, isDir, isFile } from './text.mjs';
import { stampNow, loadOffice, saveOffice, lineageKeyOf } from './office.mjs';
import { packDirTarGz } from './archive.mjs';
import { sevenZipBin, pack as pack7z } from './sevenzip.mjs';
import { handoverPathFor } from './role.mjs';
import { DETACHED_MARKER } from './system.mjs';

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

/**
 * 目录里除备份（`*.bak`）之外的条目。迁移时备份不随迁，遗留在目标目录里的备份
 * 不应把「可迁入」判成「已占用」——否则来回转一次就再也迁不回来。
 */
function liveEntries(dir) {
  return listDir(dir).filter((n) => !/\.bak$/i.test(n));
}

/** 备份文件不随迁：移动后原目录残留由它造成，清单逐条列出，不静默丢弃。 */
function isBakName(name) {
  return /\.bak($|-)/.test(String(name || ''));
}

/** 把 srcDir 下的条目移入 destDir；冲突即中止。移完删除空源目录。hold 中的名字留在原处，由调用方直接归位。 */
function moveContents(srcDir, destDir, rec, hold) {
  if (!isDir(srcDir)) return [];
  fs.mkdirSync(destDir, { recursive: true });
  const holdSet = Array.isArray(hold) ? hold : [];
  const moved = [];
  for (const name of listDir(srcDir)) {
    const s = path.join(srcDir, name);
    const d = path.join(destDir, name);
    if (holdSet.indexOf(name) !== -1) continue;
    if (isBakName(name)) { if (rec) rec('skip', s, d, '备份文件不随迁'); continue; }
    if (fs.existsSync(d)) throw new Error('目标已存在同名条目：' + d);
    fs.renameSync(s, d);
    if (rec) rec('move', s, d);
    moved.push(name);
  }
  try { fs.rmdirSync(srcDir); } catch { /* 非空或已删，保留 */ }
  return moved;
}

/**
 * 项目库根 Projects/<项目>/ 下通常只有一个 <项目>库 包装层；转杂项时拆掉这层，
 * 让杂项任务目录本身就是库根（与现有杂项任务一致），否则再转回项目会多套一层。
 */
function moveProjectLibInto(srcLib, destLib, oldName, rec) {
  if (!isDir(srcLib)) return [];
  fs.mkdirSync(destLib, { recursive: true });
  const moved = [];
  const names = listDir(srcLib);
  const libName = oldName + '库';
  for (const name of names) {
    const s = path.join(srcLib, name);
    if (isDir(s) && (name === libName || (names.length === 1 && name.endsWith('库')))) {
      moved.push(...moveContents(s, destLib, rec));
      try { fs.rmdirSync(s); } catch { /* 非空或已删 */ }
      continue;
    }
    const d = path.join(destLib, name);
    if (isBakName(name)) { if (rec) rec('skip', s, d, '备份文件不随迁'); continue; }
    if (fs.existsSync(d)) throw new Error('目标已存在同名条目：' + d);
    fs.renameSync(s, d);
    if (rec) rec('move', s, d);
    moved.push(name);
  }
  try { fs.rmdirSync(srcLib); } catch { /* 非空或已删 */ }
  return moved;
}

function moveOne(srcFile, destFile, rec) {
  if (!isFile(srcFile)) return false;
  if (fs.existsSync(destFile)) throw new Error('目标已存在同名文件：' + destFile);
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  fs.renameSync(srcFile, destFile);
  if (rec) rec('move', srcFile, destFile);
  return true;
}

/** 改骨架档案：文件名与 root 字段。 */
function rewriteProfile(srcFile, destFile, root, rec) {
  if (!isFile(srcFile)) return false;
  let v = {};
  try { v = JSON.parse(readUtf8(srcFile)); } catch { v = {}; }
  v.root = root;
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  fs.writeFileSync(destFile, JSON.stringify(v, null, 2) + NL, 'utf8');
  // 原地改写（srcFile === destFile）时不能把刚写好的文件删掉。
  if (path.resolve(srcFile) !== path.resolve(destFile)) fs.rmSync(srcFile, { force: true });
  if (rec) rec('rewrite', destFile, null, 'root 改为 ' + root);
  return true;
}

/**
 * 临时与归档随布局走：`_Temp/<范围>` 与 `_Archives/<范围>` 整体改名到新范围，
 * 新布局再建空目录，避免迁移后快照与归档对上不号。
 */
function moveScopeDirs(ws, oldScope, newScope, rec) {
  if (!oldScope || !newScope || oldScope === newScope) return;
  for (const base of ['_Temp', '_Archives']) {
    const from = path.join(String(ws || ''), base, oldScope);
    const to = path.join(String(ws || ''), base, newScope);
    if (!isDir(from)) continue;
    if (fs.existsSync(to)) { rec('skip', from, to, '目标范围已存在，未合并'); continue; }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    rec('move', from, to);
  }
}

function ensureScopeDirs(ws, scope, rec) {
  if (!scope) return;
  for (const abs of [path.join(String(ws || ''), '_Temp', scope, 'Snapshots'), path.join(String(ws || ''), '_Archives', scope)]) {
    const had = fs.existsSync(abs);
    fs.mkdirSync(abs, { recursive: true });
    if (!had) rec('mkdir', abs, null, '新布局建空目录');
  }
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
  if (isDir(destLib) && liveEntries(destLib).length) throw new Error('目标目录已存在且非空：' + destLib);
  if (next.role === 'project') {
    const destMeta = path.join(o.ws, '_Project_Meta', o.newName);
    if (isDir(destMeta) && liveEntries(destMeta).length) throw new Error('目标目录已存在且非空：' + destMeta);
  }
}

/**
 * 执行身份互转。
 * @param {object} input { ws, prev, next, mode: 'auto'|'direct' }
 * @returns {{ mode, snapshot, moved, summary, changes }}
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

  // 清单与移动由同一函数产出：每做一步记一条，调用方不再另算一遍。
  const changes = [];
  const rec = (op, from, to, note) => {
    changes.push({ op, from: from ? String(from) : '', to: to ? String(to) : '', note: note ? String(note) : '' });
  };

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

  // 全局任务独立后留下的标记：迁移完成即失效，先移走，免得随库搬进新布局。
  if (prevKind === 'global-task') {
    const marker = path.join(srcLib, DETACHED_MARKER);
    if (fs.existsSync(marker)) { fs.rmSync(marker, { force: true }); rec('remove', marker, '', '独立标记随迁移失效'); }
  }

  // 旧布局与新布局的范围名：临时与归档按布局改名，不按类别猜。
  const prevInfo = prevKind === 'project' ? { role: 'project', project: oldName }
    : prevKind === 'misc' ? { role: 'misc', task: oldName } : { role: 'global-task', task: oldName };
  const nextInfo = nextKind === 'project' ? { role: 'project', project: newName } : { role: 'misc', task: newName };
  const oldScope = handoverPathFor(ws, prevInfo).scope;
  const newScope = handoverPathFor(ws, nextInfo).scope;

  if (mode === 'direct') {
    // 直接建：旧体系整体移入备份目录，新位置只建空目录，由会话按模板建立。
    const movedTo = [];
    if (isDir(srcLib)) { movedTo.push(moveDirInto(srcLib, path.join(snap.dir || backupDir, '旧体系_' + oldName))); rec('move', srcLib, path.join(snap.dir || backupDir, '旧体系_' + oldName), '旧体系移入备份'); }
    if (isDir(srcMeta)) { movedTo.push(moveDirInto(srcMeta, path.join(snap.dir || backupDir, '旧元数据_' + oldName))); rec('move', srcMeta, path.join(snap.dir || backupDir, '旧元数据_' + oldName), '旧元数据移入备份'); }
    if (prevKind === 'project') {
      if (removeRegistryProject(ws, oldName)) rec('registry', registryFile(ws), '', '删除项目行「' + oldName + '」');
    }
    const target = nextKind === 'project'
      ? path.join(ws, 'Projects', newName, newName + '库')
      : path.join(ws, '_Misc', 'tasks', newName);
    fs.mkdirSync(target, { recursive: true });
    rec('mkdir', target, '', '新位置空目录');
    if (nextKind === 'project') {
      fs.mkdirSync(path.join(ws, '_Project_Meta', newName), { recursive: true });
      rec('mkdir', path.join(ws, '_Project_Meta', newName), '', '新元数据空目录');
      if (addRegistryProject(ws, newName)) rec('registry', registryFile(ws), '', '新增项目行「' + newName + '」');
    }
    moveScopeDirs(ws, oldScope, newScope, rec);
    ensureScopeDirs(ws, newScope, rec);
    const office = moveOfficeLineage(ws, prev, next);
    return {
      mode,
      snapshot: snap,
      moved: movedTo.length > 0,
      changes,
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
  // 档案直接归位：先搬进库根再搬出来，清单里会留下已经不存在的中转路径。
  const ARCHIVE_NAMES = ['Handover.md', 'System.md', 'Project_Overview.md'];
  const holdNames = toProject ? ARCHIVE_NAMES : null;

  if (isDir(srcLib)) {
    moved.push(...(prevKind === 'project' ? moveProjectLibInto(srcLib, destLib, oldName, rec) : moveContents(srcLib, destLib, rec, holdNames)));
  }

  // 归位顺序：先把档案放到目标角色该在的位置，再挪其余内容。否则档案会随库被搬进库根。
  // 目标为项目时还会漏进 _Project_Meta。
  // 2026-11-16 第二轮测试：杂项转项目时档案落在库根、元数据目录为空。
  const metaDir = toProject ? destMeta : destLib;
  if (toProject) {
    for (const name of ARCHIVE_NAMES) {
      if (moveOne(path.join(srcLib, name), path.join(metaDir, name), rec)) moved.push(name);
    }
  }

  const profileFrom = prevKind === 'project' ? path.join(srcMeta, 'project.profile.json') : path.join(destLib, 'task.profile.json');
  const profileTo = toProject ? path.join(destMeta, 'project.profile.json') : path.join(destLib, 'task.profile.json');
  if (isFile(profileFrom) && rewriteProfile(profileFrom, profileTo, rootRel, rec)) moved.push(path.basename(profileTo));

  if (prevKind === 'project') {
    if (moveOne(path.join(srcMeta, 'Handover.md'), path.join(metaDir, 'Handover.md'), rec)) moved.push('Handover.md');
    // 体系注册正文不机械改写：标题、描述与路径由会话按清单改写。
    if (moveOne(path.join(srcMeta, 'System.md'), path.join(metaDir, 'System.md'), rec)) moved.push('System.md');
    for (const name of listDir(srcMeta)) {
      const s = path.join(srcMeta, name);
      const d = path.join(destLib, name);
      if (isBakName(name)) { rec('skip', s, d, '备份文件不随迁'); continue; }
      if (fs.existsSync(d)) continue;
      fs.renameSync(s, d);
      rec('move', s, d);
      moved.push(name);
    }
    if (removeRegistryProject(ws, oldName)) rec('registry', registryFile(ws), '', '删除项目行「' + oldName + '」');
  }
  try { if (isDir(srcMeta)) fs.rmdirSync(srcMeta); } catch { /* 留空目录不影响使用 */ }
  try { if (isDir(srcLib)) fs.rmdirSync(srcLib); } catch { /* 留空目录不影响使用 */ }
  // 备份文件留在原目录时，把残留连同内容一并列出，不静默丢弃。
  for (const dir of [srcLib, srcMeta]) {
    if (!dir || !isDir(dir)) continue;
    const left = listDir(dir);
    if (left.length) rec('residue', dir, '', '残留：' + left.join('、'));
  }
  if (nextKind === 'project' && addRegistryProject(ws, newName)) rec('registry', registryFile(ws), '', '新增项目行「' + newName + '」');

  moveScopeDirs(ws, oldScope, newScope, rec);
  ensureScopeDirs(ws, newScope, rec);

  // 须由会话改写的身份字段：这几处写死了旧类别与旧路径，机械替换会改坏正文结构。
  for (const name of ['System.md', 'Handover.md', 'Project_Overview.md']) {
    const f = path.join(metaDir, name);
    if (isFile(f)) rec('manual', f, '', '须由会话改写身份字段');
  }

  const office = prevKind === 'global-task'
    ? { moved: false }
    : moveOfficeLineage(ws, prev, next);
  return {
    mode,
    snapshot: snap,
    moved: moved.length > 0,
    changes,
    summary: '已快照 ' + (snap.made.length) + ' 份到 ' + (snap.dir || '备份目录') + '。体系已移至 ' + destLib
      + '。清单 ' + changes.length + ' 项'
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
