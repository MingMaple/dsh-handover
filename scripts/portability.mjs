/**
 * 跨平台可移植性测试（1.0）：
 * 1. 路径等价键按平台折叠大小写：Windows 与 macOS 折叠，Linux 保留；
 * 2. 7-Zip 探测覆盖 Windows、macOS、Linux 的常见位置与 PATH；
 * 3. 工作区相对路径一律用 path.sep 组装，不写死分隔符；
 * 4. 迁移助手不依赖 PowerShell 或 bash，链接类型按平台选择；
 * 5. 路径比较不再无条件折叠大小写。
 *
 * 全程只读源码与构建产物，不碰真实工作区与真实 HOME。
 * 用法：node scripts/portability.mjs [--dist <dist 目录>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const dist = (() => {
  const i = process.argv.indexOf('--dist');
  return i !== -1 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : path.join(repo, 'dist');
})();

const fails = [];
function ok(cond, msg, extra) {
  if (cond) console.log('  通过 ' + msg);
  else { fails.push(msg + (extra ? ' → ' + extra : '')); console.log('  未通过 ' + msg + (extra ? ' → ' + extra : '')); }
}
function section(t) { console.log(''); console.log('== ' + t + ' =='); }
const imp = (rel) => import(pathToFileURL(path.join(dist, rel)).href);
const read = (rel) => fs.readFileSync(path.join(repo, rel), 'utf8');

const { pathKey, samePath, relToAbs } = await imp('lib/pathkey.mjs');

section('1 路径等价键');
ok(pathKey('C:\\Data\\WS\\', 'win32') === 'c:/data/ws', 'Windows 折叠大小写并去分隔符', pathKey('C:\\Data\\WS\\', 'win32'));
ok(pathKey('C:\\Data\\WS', 'darwin') === 'c:/data/ws', 'macOS 折叠大小写', pathKey('C:\\Data\\WS', 'darwin'));
ok(pathKey('/data/WS', 'linux') === '/data/WS', 'Linux 保留大小写', pathKey('/data/WS', 'linux'));
ok(samePath('C:\\A\\b', 'c:/a/B', 'win32') === true, 'Windows 两种写法视为同一路径');
ok(samePath('/data/WS', '/data/ws', 'linux') === false, 'Linux 大小写不同视为不同路径');
ok(relToAbs('/root', 'a/b') === path.join('/root', 'a', 'b'), '相对路径按平台分隔符组装');

section('2 7-Zip 探测');
const seven = read('src/lib/sevenzip.mjs');
for (const p of ['/usr/bin/7z', '/usr/local/bin/7z', '/opt/homebrew/bin/7z', '/usr/bin/7za', '/opt/homebrew/bin/7zz', '7z.exe']) {
  ok(seven.indexOf(p) !== -1, '候选含 ' + p);
}
ok(seven.indexOf('BARE') !== -1, 'PATH 上的 7z、7zz、7za 也探测');

section('3 路径组装');
ok(read('src/lib/scaffold.mjs').indexOf(".split('/').join(path.sep)") !== -1, '脚手架用 path.sep 组装相对路径');
ok(read('src/lib/archive.mjs').indexOf(".split('/').join(path.sep)") !== -1, '归档恢复用 path.sep 组装相对路径');

section('4 迁移与链接');
const mover = read('src/lib/mover.mjs');
ok(mover.indexOf("process.platform === 'win32' ? 'junction' : 'dir'") !== -1, '链接类型按平台选择');
ok(mover.indexOf('不依赖 PowerShell') !== -1, '迁移助手不依赖外部 shell');
ok(mover.indexOf("process.platform === 'win32' ? t.toLowerCase() : t") !== -1, '链接目标比较按平台折叠大小写');

section('5 路径比较不再无条件折叠');
const files = ['src/lib/mover.mjs', 'src/lib/api.mjs', 'src/lib/session-ops.mjs', 'src/lib/status.mjs', 'src/lib/scaffold.mjs', 'src/tools/ho_workspace.mjs'];
const bad = files.filter((f) => read(f).indexOf(".replace(/\\/+$/, '').toLowerCase()") !== -1);
ok(bad.length === 0, '以上文件不再写死「转斜杠 + 去尾 + 小写」', bad.join(', '));
ok(read('src/lib/pathkey.mjs').indexOf('process.platform') !== -1, '大小写折叠集中在 pathkey.mjs');

console.log('');
if (fails.length) {
  console.log('PORTABILITY FAIL ' + fails.length + ' 项：');
  for (const f of fails) console.log('  - ' + f);
  process.exit(1);
}
console.log('PORTABILITY OK（跨平台检查全过）');
