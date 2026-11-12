/**
 * 迁移与恢复的端到端自测（不碰真库）：造一个假工作区 → 打包 → 校验 → 改一个字节看失效 → 预演恢复 → 真恢复 → 再恢复一次看备份。
 * 用法：node scripts/e2e-migration.mjs [--dist <dist 目录>]
 * 依赖：7-Zip（自动探测 C:\\Program Files\\7-Zip\\7z.exe）。
 * 全程在系统临时目录里做，结束即删。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const argIdx = process.argv.indexOf('--dist');
const dist = argIdx !== -1 ? path.resolve(process.argv[argIdx + 1]) : path.join(repo, 'dist');

const imp = (rel) => import(pathToFileURL(path.join(dist, rel)).href);
const { pmBackupTool } = await imp('tools/ho_backup.mjs');
const { resolveConfig } = await imp('lib/config.mjs');

const fails = [];
const ok = (cond, msg, extra) => { if (!cond) fails.push(msg + (extra ? ' → ' + extra : '')); else console.log('  通过 ' + msg); };

const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-handover-e2e-'));
const WS = path.join(SB, 'ws');
const OUT = path.join(SB, 'out');
const TGT = path.join(SB, 'target');
const ABS_LINE = '缓存目录写死成了 ' + 'D:' + path.sep + 'Work' + path.sep + 'cache（迁移时须改）';

function w(rel, text) {
  const p = path.join(WS, rel.split('/').join(path.sep));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, 'utf8');
}

w('_Control_Center/records/Global_Handover.md', '# 全局 交接\n\n## 0. 身份与寻址\n\n| 链内代数 | 第 1 代 |\n\n## 2. 下一步\n\n| # | 动作 |\n|---|---|\n| 1 | 试跑 |\n\n## 7. 会话 id 对照\n\n| 角色 | id |\n|---|---|\n| 全局 | session-00000000-0000-0000-0000-000000000000 |\n');
w('_Project_Meta/Demo/Handover.md', '# Demo 交接\n\n## 1. 正在做的事\n\n这是一个用于端到端自测的假项目库，内容足够长以满足体检的最短要求。\n\n## 2. 下一步待办\n\n- 改绝对路径\n');
w('_Control_Center/rules/Note.md', '# 备注\n\n' + ABS_LINE + '\n');
w('_Control_Center/rules/clean.md', '# 干净的相对引用\n\n见 ../records/Global_Handover.md\n');

const cfg = resolveConfig({ workspaceRoot: WS });
const env = {
  cfg,
  resolveWs: () => WS,
  log: () => { },
  cacheDir: () => path.join(SB, 'nocache'),   // 沙箱里没有投影缓存 ⇒ check 只看交接
  selfId: () => null,
  selfCwd: () => null,
};
const packTool = pmBackupTool(env);
/** action 分流：pack／verify／restore 都走同一个工具（合并口径）。 */
const run = (args) => packTool.execute(args, null);

console.log('（沙箱）' + SB);

// 0. 前置闸门：action=check
const r0 = await run({ action: 'check', items: ['global', 'Demo'], min_age_min: 0 });
ok(/判定：/.test(r0.text), 'action=check 应给出判定', r0.text.split('\n').pop());

// 1. 打包
const r1 = await run({ action: 'pack', kind: 'global', out: OUT, note: 'e2e' });
ok(/已打包/.test(r1.text), '打包成功');
ok(/绝对路径体检：\d+ 处/.test(r1.text), '打包输出报出绝对路径处数', r1.text.split('\n').pop());
const packs = fs.readdirSync(OUT).filter((n) => n.endsWith('.7z'));
ok(packs.length === 1, '只出一个包', packs.join(','));
const packPath = path.join(OUT, packs[0]);

// 2. 包内清单与说明
const x1 = path.join(SB, 'x1');
fs.mkdirSync(x1, { recursive: true });
const { execFileSync } = await import('node:child_process');
const sevenZip = ['C:/Program Files/7-Zip/7z.exe', 'C:/Program Files (x86)/7-Zip/7z.exe'].find((p) => fs.existsSync(p));
if (!sevenZip) { console.log('SKIP：本机没有 7-Zip，跳过解包核对'); }
else {
  execFileSync(sevenZip, ['x', '-y', '-o' + x1, packPath], { stdio: 'ignore' });
  const mf = JSON.parse(fs.readFileSync(path.join(x1, 'manifest.json'), 'utf8'));
  ok(mf.absoluteRefs && mf.absoluteRefs.totalHits >= 1, 'manifest 记录了绝对路径命中', JSON.stringify(mf.absoluteRefs && { totalHits: mf.absoluteRefs.totalHits, files: mf.absoluteRefs.files }));
  ok(typeof mf.sourcePlatform === 'string' && /\+\d{4}$/.test(mf.createdAtLocal || ''), 'manifest 带源平台与带偏移的时间');
  const md = fs.readFileSync(path.join(x1, 'MIGRATION.md'), 'utf8');
  ok(md.indexOf('绝对路径体检') !== -1, 'MIGRATION.md 有「绝对路径体检」段');
  ok(md.indexOf('跨平台注意') !== -1, 'MIGRATION.md 有「跨平台注意」段');
  ok(md.indexOf('库内引用一律相对路径') !== -1, 'MIGRATION.md 写明相对路径口径');
}

// 3. 校验通过
const r2 = await run({ action: 'verify', pack: packPath });
ok(/漂移 0/.test(r2.text) && /缺失 0/.test(r2.text), 'pack_verify 判定与盘上一致（漂移 0 / 缺失 0）', r2.text.split('\n')[1]);

// 4. 改盘上文件 → 校验应报不一致
w('_Control_Center/rules/Note.md', '# 备注\n\n改过了\n');
const r3 = await run({ action: 'verify', pack: packPath });
ok(/不一致|缺失|作废/.test(r3.text), '盘上改了之后 verify 报出不一致', r3.text.split('\n').slice(0, 2).join(' / '));

// 5. 预演恢复：不写任何文件
const r4 = await run({ action: 'restore', pack: packPath, target: TGT });
ok(/预演/.test(r4.text), '默认只预演');
const tgtExists = fs.existsSync(TGT);
ok(tgtExists === false, '预演没有创建目标目录', String(tgtExists));
ok(/绝对路径体检（恢复前）/.test(r4.text), '恢复前复检已输出');

// 6. 真恢复
const r5 = await run({ action: 'restore', pack: packPath, target: TGT, apply: true });
ok(/已写入/.test(r5.text), 'apply=true 写入成功');
ok(fs.existsSync(path.join(TGT, '_Control_Center', 'records', 'Global_Handover.md')), '目标目录出现交接文件');
ok(fs.readFileSync(path.join(TGT, '_Control_Center', 'rules', 'Note.md'), 'utf8').indexOf('改过了') === -1, '写回的是包内版本（不是盘上被改过的版本）');

// 7. 再恢复一次 → 覆盖并备份
const r6 = await run({ action: 'restore', pack: packPath, target: TGT, apply: true });
ok(/覆盖/.test(r6.text), '第二次恢复报出覆盖');
const snap = path.join(WS, '_Temp', '_Global', 'Snapshots');
const baks = fs.existsSync(snap) ? fs.readdirSync(snap) : [];
ok(baks.length >= 1, '覆盖前备份目录已建立', baks.join(','));

// 8. 不删除目标文件：放一个包外的文件，恢复后仍在
const keep = path.join(TGT, 'keep.txt');
fs.writeFileSync(keep, 'keep', 'utf8');
await run({ action: 'restore', pack: packPath, target: TGT, apply: true });
ok(fs.existsSync(keep), '恢复不删除目标处原有文件');

fs.rmSync(SB, { recursive: true, force: true });
console.log('');
if (fails.length) {
  console.log('E2E FAIL ' + fails.length + ' 项：');
  for (const f of fails) console.log('  - ' + f);
  process.exit(1);
}
console.log('E2E OK（迁移与恢复端到端全过）');