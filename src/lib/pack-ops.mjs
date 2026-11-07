/**
 * 打包、校验、预演、恢复的实现（原 ho_pack / ho_pack_verify / ho_pack_restore / ho_pack_precheck 的代码搬到这里）。
 * 对外只经 ho_pack(action=…) 暴露，少 3 份 schema 的固定开销。
 * 共同口径：只报告绝对路径、不改写文件内容；恢复默认预演、覆盖前备份、从不删除目标文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { NL, isDir, isFile } from './text.mjs';
import { sevenZipBin, pack as z7pack, test as z7test, extract } from './sevenzip.mjs';
import { packDirTarGz, listTarGz, extractTarGz, detectFormat, safeRel } from './archive.mjs';
import { scanAbsoluteRefs, renderAbsoluteRefs } from './absrefs.mjs';
import { stampTz } from './brief.mjs';
import { scanSessions } from './sessions.mjs';
import { lintProject } from './lint.mjs';

const SKIP_DIRS = ['__pycache__', '.git', 'node_modules', '.obsidian'];
const SKIP_FILES = ['.DS_Store', 'Thumbs.db'];

/**
 * 选归档格式：auto（有 7-Zip 用 7z，否则用内置 tar.gz）、7z、tar。
 * 内置归档器是**功能等价**的兜底：空白机器上没有 7-Zip 也必须能打包、校验、恢复。
 */
function chooseFormat(args, cfg) {
  const want = String((args && args.format) || (cfg && cfg.packFormat) || 'auto').toLowerCase();
  if (want === '7z') {
    const bin = sevenZipBin(cfg && cfg.sevenZipPath);
    if (!bin) throw new Error('指定了 format=7z，但本机没有 7-Zip。去掉 format 用 auto，或写 format="tar" 用内置归档器。');
    return { fmt: '7z', bin };
  }
  if (want === 'tar' || want === 'targz' || want === 'tar.gz') return { fmt: 'tar', bin: '' };
  const bin = sevenZipBin(cfg && cfg.sevenZipPath);
  return bin ? { fmt: '7z', bin } : { fmt: 'tar', bin: '' };
}

/** 解包到 dir（按魔数判断格式，不看扩展名）。返回 { code, out }。 */
function unpack(packPath, dir) {
  const fmt = detectFormat(packPath);
  if (fmt === 'targz') {
    try {
      const r = extractTarGz(packPath, dir);
      const out = 'tar.gz 解包：写入 ' + r.written + ' 个文件、' + r.dirs + ' 个目录' + (r.skipped.length ? '；跳过 ' + r.skipped.length + ' 条（' + r.skipped[0] + '）' : '');
      return { code: 0, out };
    } catch (e) {
      return { code: -1, out: 'tar.gz 解包失败：' + (e && e.message ? e.message : e) };
    }
  }
  if (fmt === '7z') {
    const bin = sevenZipBin('');
    if (!bin) return { code: -1, out: '这个包是 7z 格式，但本机没有 7-Zip；装一个 7-Zip，或改用 tar.gz 包。' };
    fs.mkdirSync(dir, { recursive: true });
    return run7zSafe(bin, packPath, dir);
  }
  return { code: -1, out: '认不出包格式（既不是 7z 魔数也不是 gzip）：' + packPath };
}

/** 包内路径必须相对且不越界：拒绝绝对路径、盘符、..（防止恢复时写到目标目录之外）。 */
function unsafeManifestPaths(manifest) {
  const files = Array.isArray(manifest && manifest.files) ? manifest.files : [];
  const bad = [];
  for (const f of files) {
    const rel = safeRel(f && f.path);
    if (rel === null) bad.push(String(f && f.path));
  }
  return bad;
}

function run7zSafe(bin, packPath, dir) {
  try {
    return extract(bin, packPath, dir);
  } catch (e) {
    return { code: -1, out: String(e && e.message ? e.message : e) };
  }
}

export function stampNow() {
  const d = new Date();
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function walk(root, rel, out) {
  let names = [];
  try { names = fs.readdirSync(path.join(root, rel)); } catch { return out; }
  for (const name of names) {
    const abs = path.join(root, rel, name);
    const r = rel ? rel + '/' + name : name;
    let st;
    try { st = fs.statSync(abs); } catch { continue; }
    if (st.isDirectory()) {
      if (SKIP_DIRS.indexOf(name) !== -1) continue;
      walk(root, r, out);
    } else if (st.isFile()) {
      if (SKIP_FILES.indexOf(name) !== -1) continue;
      if (name.endsWith('.pyc')) continue;
      out.push({ rel: r, abs, bytes: st.size });
    }
  }
  return out;
}

// ---------------------------------------------------------------- action: check

export function packCheck(env, args, exec) {
  const ws = env.resolveWs(exec);
  const items = Array.isArray(args.items) && args.items.length ? args.items : [];
  if (!items.length) throw new Error('action=check 需要 items（项目名列表，写 global 表示全局）');
  const minAge = (typeof args.min_age_min === 'number' ? args.min_age_min : (env.cfg.prepackMinAgeMin || 90)) * 60000;
  const now = Date.now();
  const scan = scanSessions({ dir: env.cacheDir(), meId: env.selfId(exec), warn: 32, silentHours: env.cfg.sessionScanHours });
  const out = [];
  let bad = 0;
  for (const item of items) {
    const why = [];
    if (item !== 'global') {
      const live = scan.rows.filter((r) => r.project === item);
      if (live.length) {
        const best = live.slice().sort((a, b) => b.mtime - a.mtime)[0];
        if (best.state === 'running') why.push('会话 ' + best.sid + ' 正在跑');
        if (now - best.mtime < minAge) why.push('最后活动距今 ' + Math.round((now - best.mtime) / 60000) + ' 分钟 < ' + Math.round(minAge / 60000));
      }
      const hand = path.join(ws, '_Project_Meta', item, 'Handover.md');
      if (!isFile(hand)) why.push('缺交接：' + hand);
      else {
        const r = lintProject(hand);
        if (r.verdict !== '通过' && r.verdict !== '缺节') why.push('交接体检 ' + r.verdict + (r.reasons.length ? '：' + r.reasons[0] : ''));
      }
    } else {
      const hand = path.join(ws, '_Control_Center', 'records', 'Global_Handover.md');
      if (!isFile(hand)) why.push('缺全局交接');
    }
    if (why.length) { bad++; out.push('未通过 ' + item + '：' + why.join('；')); }
    else out.push('通过 ' + item + '：可打包');
  }
  out.push(bad ? '判定：' + bad + ' 项未就绪，应待会话静止并补齐交接后再打包' : '判定：全部就绪，可以打包');
  return out.join(NL);
}

// ---------------------------------------------------------------- action: pack

export function packNow(env, args, exec) {
  const ws = env.resolveWs(exec);
  const kind = args.kind || 'global';
  const name = args.name || '';
  const roots = [];
  if (kind === 'global') {
    roots.push(['_Control_Center', path.join(ws, '_Control_Center')]);
    roots.push(['_Project_Meta', path.join(ws, '_Project_Meta')]);
  } else if (kind === 'project') {
    if (!name) throw new Error('kind=project 需要 name');
    roots.push(['Projects/' + name, path.join(ws, 'Projects', name)]);
    roots.push(['_Project_Meta/' + name, path.join(ws, '_Project_Meta', name)]);
    roots.push(['_Archives/' + name + '/Handover', path.join(ws, '_Archives', name, 'Handover')]);
  } else if (kind === 'task') {
    if (!name) throw new Error('kind=task 需要 name');
    roots.push(['_Misc/tasks/' + name, path.join(ws, '_Misc', 'tasks', name)]);
  } else throw new Error('未知 kind：' + kind);
  const entries = [];
  for (const [label, abs] of roots) {
    if (!isDir(abs)) continue;
    for (const it of walk(abs, '', [])) entries.push({ rel: label + '/' + it.rel, abs: it.abs, bytes: it.bytes });
  }
  if (!entries.length) throw new Error('没有可打包的文件：' + roots.map((r) => r[0]).join('、'));
  const total = entries.reduce((a, b) => a + b.bytes, 0);
  const out = [];
  out.push('目标 ' + kind + (name ? ':' + name : '') + ' → ' + entries.length + ' 个文件 / ' + (total / 1048576).toFixed(2) + ' MB');
  if (args.dry_run) {
    for (const e of entries.slice(0, 20)) out.push('  ' + e.rel + '  ' + e.bytes + ' B');
    const pre = scanAbsoluteRefs(ws, entries.map((e) => e.rel));
    out.push(...renderAbsoluteRefs(pre, { title: '绝对路径体检（源目录）', max: 5 }));
    out.push('（dry_run：不打包）');
    return out.join(NL);
  }
  const stamp = stampNow();
  const label = kind === 'global' ? '全局' : name;
  const stagingRoot = path.join(ws, '_Temp', '_Global', 'Scratch', 'pack-' + stamp);
  const payload = path.join(stagingRoot, 'payload');
  const files = [];
  for (const e of entries) {
    const dest = path.join(payload, e.rel.split('/').join(path.sep));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(e.abs, dest);
    files.push({ path: e.rel, bytes: e.bytes, sha256: sha256(dest) });
  }
  const abs = scanAbsoluteRefs(payload, files.map((f) => f.path));
  const manifest = {
    kind,
    name: name || null,
    createdAt: new Date().toISOString(),
    createdAtLocal: stampTz(Date.now()),
    sourcePlatform: process.platform,
    fileCount: files.length,
    bytes: total,
    note: args.note || '',
    absoluteRefs: { totalHits: abs.totalHits, files: abs.hits.length, scanned: abs.scanned, crlf: abs.crlf, lf: abs.lf, nonUtf8: abs.nonUtf8.length, detail: abs.hits },
    files,
  };
  fs.writeFileSync(path.join(stagingRoot, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  fs.writeFileSync(path.join(stagingRoot, 'CHECKSUMS.sha256'), files.map((f) => f.sha256 + '  ' + f.path).join(NL) + NL, 'utf8');
  const absLines = renderAbsoluteRefs(abs, { title: '绝对路径体检（包内）', max: 200 });
  const md = ['# 迁移包（最简版）', '', '- 目标: ' + kind + (name ? ':' + name : ''), '- 生成: ' + manifest.createdAt, '- 文件: ' + files.length + ' 个 / ' + total + ' B', '- 说明: ' + (args.note || '（无）'), '', ...absLines, '', '## 跨平台注意', '', '- **库内引用一律相对路径**：本包里有 ' + abs.totalHits + ' 处写死的绝对路径，插件**只报告、不改写**文件内容——迁移后需由人或项目会话自己改。', '- 源平台 ' + manifest.sourcePlatform + '；换行 CRLF ' + abs.crlf + ' 个 / LF ' + abs.lf + ' 个' + (abs.nonUtf8.length ? '；非 UTF-8 ' + abs.nonUtf8.length + ' 个' : '') + '。', '- 目标机若是别的系统（Windows ↔ macOS/Linux）：盘符、路径分隔符、大小写敏感性、换行、编码都要项目会话自己核一遍。', '', '## 目标环境前置（先做这两件，再做恢复）', '', '1. 安装 dsh-handover 插件（否则本工具不存在）；', '2. 打开本包随附的交接文件（_Project_Meta/<项目名>/Handover.md 或全局 _Control_Center/records/Global_Handover.md），按它恢复状态。', '', '## 恢复', '', 'ho_pack(action="restore", pack="<本包绝对路径>", dry_run=true)   # 先预演，再加 apply=true', '', '> 会话本身**不迁移**：连续性只靠交接文档。'].join(NL);
  fs.writeFileSync(path.join(stagingRoot, 'MIGRATION.md'), md, 'utf8');
  const outDir = args.out || path.join(ws, '_Archives', '_Global', 'Backups');
  fs.mkdirSync(outDir, { recursive: true });
  const pick = chooseFormat(args, env.cfg);
  const ext = pick.fmt === '7z' ? '.7z' : '.tar.gz';
  const archive = path.join(outDir, label + '-migration-' + stamp + ext);
  if (fs.existsSync(archive)) throw new Error('目标包已存在，不覆盖：' + archive);
  if (pick.fmt === '7z') {
    const a = z7pack(pick.bin, archive, stagingRoot);
    if (a.code !== 0) throw new Error('7z 打包失败（' + a.code + '）：' + a.error + String.fromCharCode(10) + a.out.slice(-400));
    const t = z7test(pick.bin, archive);
    if (t.code !== 0) throw new Error('7z 自检失败（' + t.code + '）：' + t.out.slice(-400));
    out.push('自检 7z t 通过');
  } else {
    const r = packDirTarGz(stagingRoot, archive);
    const listed = listTarGz(archive);
    const unsafe = listed.filter((x) => !x.safe);
    if (listed.length < r.files) throw new Error('tar.gz 自检失败：回读条目 ' + listed.length + ' < 写入文件 ' + r.files);
    if (unsafe.length) throw new Error('tar.gz 自检失败：含不安全路径 ' + unsafe[0].rel);
    out.push('自检 tar.gz 通过（' + r.files + ' 文件、' + r.entries + ' 条目，内置归档器）');
  }
  try { fs.rmSync(stagingRoot, { recursive: true, force: true }); } catch { /* 留着也无害 */ }
  out.push('已打包 ' + archive + '（' + fs.statSync(archive).size + ' B，格式 ' + pick.fmt + '）');
  out.push('绝对路径体检：' + (abs.totalHits ? abs.totalHits + ' 处（清单见 MIGRATION.md，插件不改写文件内容）' : '无'));
  return out.join(NL);
}

// ---------------------------------------------------------------- action: verify

export function packVerify(env, args, exec) {
  const ws = env.resolveWs(exec);
  const packPath = args.pack;
  if (!packPath) throw new Error('action=verify 需要 pack（包路径）');
  if (!fs.existsSync(packPath)) throw new Error('包不存在：' + packPath);
  const tmp = path.join(ws, '_Temp', '_Global', 'Scratch', 'verify-' + stampNow());
  const ex = unpack(packPath, tmp);
  if (ex.code !== 0) throw new Error('解包失败：' + String(ex.out).slice(-300));
  const mf = path.join(tmp, 'manifest.json');
  if (!fs.existsSync(mf)) throw new Error('包内缺 manifest.json：' + packPath);
  const manifest = JSON.parse(fs.readFileSync(mf, 'utf8'));
  const unsafe = unsafeManifestPaths(manifest);
  if (unsafe.length) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    throw new Error('包内路径不安全（必须是相对路径、不含 ..）：' + unsafe.slice(0, 3).join('；'));
  }
  const same = [], drift = [], missing = [];
  for (const f of manifest.files) {
    const local = path.join(ws, f.path.split('/').join(path.sep));
    if (!fs.existsSync(local)) { missing.push(f.path); continue; }
    if (sha256(local) === f.sha256) same.push(f.path); else drift.push(f.path);
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  const out = [];
  out.push('包 ' + packPath);
  out.push('文件 ' + manifest.files.length + ' 个；一致 ' + same.length + ' / 漂移 ' + drift.length + ' / 缺失 ' + missing.length);
  for (const p of drift.slice(0, 10)) out.push('  漂移：' + p);
  for (const p of missing.slice(0, 10)) out.push('  缺失：' + p);
  out.push(drift.length === 0 && missing.length === 0 ? '判定：包内即现版，可直接用' : '判定：**包已作废**（盘上已变），必须重打');
  return out.join(NL);
}

// ---------------------------------------------------------------- action: restore

export function packRestore(env, args, exec) {
  const ws = env.resolveWs(exec);
  const target = args.target || ws;
  const packPath = args.pack;
  if (!packPath) throw new Error('action=restore 需要 pack（包路径）');
  if (!fs.existsSync(packPath)) throw new Error('包不存在：' + packPath);
  const apply = args.apply === true && args.dry_run !== true;
  const tmp = path.join(ws, '_Temp', '_Global', 'Scratch', 'restore-' + stampNow());
  const ex = unpack(packPath, tmp);
  if (ex.code !== 0) throw new Error('解包失败：' + String(ex.out).slice(-300));
  const mf = path.join(tmp, 'manifest.json');
  if (!fs.existsSync(mf)) throw new Error('包内缺 manifest.json');
  const manifest = JSON.parse(fs.readFileSync(mf, 'utf8'));
  const unsafe = unsafeManifestPaths(manifest);
  if (unsafe.length) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    throw new Error('包内路径不安全（必须是相对路径、不含 ..），已中止、未写任何文件：' + unsafe.slice(0, 3).join('；'));
  }
  const bad = [];
  for (const f of manifest.files) {
    const src = path.join(tmp, 'payload', f.path.split('/').join(path.sep));
    if (!fs.existsSync(src)) { bad.push('缺文件 ' + f.path); continue; }
    if (sha256(src) !== f.sha256) bad.push('哈希不符 ' + f.path);
  }
  if (bad.length) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    throw new Error('校验未通过，已中止（未复制任何文件）：' + bad.slice(0, 5).join('；'));
  }
  const abs = scanAbsoluteRefs(path.join(tmp, 'payload'), manifest.files.map((f) => f.path));
  const crossPlatform = manifest.sourcePlatform && manifest.sourcePlatform !== process.platform;
  const backupDir = path.join(ws, '_Temp', '_Global', 'Snapshots', 'restore-' + stampNow());
  const adds = [], overwrites = [];
  for (const f of manifest.files) {
    const dest = path.join(target, f.path.split('/').join(path.sep));
    if (fs.existsSync(dest)) overwrites.push(f.path); else adds.push(f.path);
  }
  if (apply) {
    for (const f of manifest.files) {
      const src = path.join(tmp, 'payload', f.path.split('/').join(path.sep));
      const dest = path.join(target, f.path.split('/').join(path.sep));
      if (fs.existsSync(dest)) {
        const bak = path.join(backupDir, f.path.split('/').join(path.sep));
        fs.mkdirSync(path.dirname(bak), { recursive: true });
        fs.copyFileSync(dest, bak);
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  const out = [];
  out.push('包 ' + packPath + '，目标 ' + target);
  out.push('文件 ' + manifest.files.length + ' 个；新增 ' + adds.length + ' / 覆盖 ' + overwrites.length);
  for (const p of overwrites.slice(0, 10)) out.push('  覆盖：' + p);
  if (crossPlatform) out.push('注意：源平台 ' + manifest.sourcePlatform + ' ≠ 本机 ' + process.platform + '：路径分隔符、盘符、大小写、换行、编码都需要项目会话自己核一遍。');
  out.push(...renderAbsoluteRefs(abs, { title: '绝对路径体检（恢复前）', max: 20 }));
  if (abs.totalHits) out.push('  ⇒ 这些位置插件**不会**改；迁移后由人或项目会话按新机器改，库内引用统一用相对路径。');
  if (!apply) out.push('**预演**：未写入任何文件。确认无误后用 apply=true 再调一次。');
  else out.push('已写入；被覆盖的旧文件备份在 ' + backupDir);
  return out.join(NL);
}
