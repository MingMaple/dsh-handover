/**
 * 路径等价键：跨平台比较同一路径时用。
 * Windows 与 macOS 的默认文件系统不区分大小写，Linux 区分；因此只在 win32 与 darwin 上折叠大小写。
 * 反斜杠一律折成正斜杠，去掉末尾分隔符，便于比较用户输入与登记表里的路径。
 * `platform` 可显式传入，便于按平台写单元测试。
 */
import path from 'node:path';

/** 返回用于比较的路径键。 */
export function pathKey(p, platform) {
  const plat = platform || process.platform;
  const norm = String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
  return (plat === 'win32' || plat === 'darwin') ? norm.toLowerCase() : norm;
}

/** 两个路径是否指向同一位置（按当前或指定平台判定）。 */
export function samePath(a, b, platform) {
  return pathKey(a, platform) === pathKey(b, platform);
}

/** 把工作区相对路径（'/' 分隔）转成本机路径。 */
export function relToAbs(root, rel) {
  return path.join(root, String(rel).split('/').join(path.sep));
}
