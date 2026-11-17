/** 依赖 dist 的测试前置：dist 不存在时先构建，避免新环境直接失败。 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

if (!fs.existsSync('dist/index.mjs')) {
  const r = spawnSync(process.execPath, ['scripts/build.mjs'], { stdio: 'inherit' });
  process.exit(r.status === null ? 1 : r.status);
}
