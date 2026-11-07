/**
 * 构建：把 src/ 打成一个可直接安装的 bundle 包（dist/）。
 * 用法：node scripts/build.mjs [--out <目录>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const rootPkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));

const argIdx = process.argv.indexOf("--out");
const dist = argIdx !== -1 && process.argv[argIdx + 1]
  ? path.resolve(process.argv[argIdx + 1])
  : path.join(repo, "dist");

function rmrf(p) { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); }
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    const s = path.join(from, name);
    const d = path.join(to, name);
    if (fs.statSync(s).isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

rmrf(dist);
fs.mkdirSync(dist, { recursive: true });
copyDir(path.join(repo, "src", "lib"), path.join(dist, "lib"));
copyDir(path.join(repo, "src", "tools"), path.join(dist, "tools"));
fs.copyFileSync(path.join(repo, "src", "index.mjs"), path.join(dist, "index.mjs"));
fs.copyFileSync(path.join(repo, "src", "cordis.patch.yml"), path.join(dist, "cordis.patch.yml"));
// 浏览器半（设置页）：必须是已构建好的 __ModuleLoader__ 注册脚本，宿主按 exports["./client"] 取用。
fs.copyFileSync(path.join(repo, "src", "client.js"), path.join(dist, "client.js"));
// 首次安装向导用的模板（Charter 骨架、交接骨架、台账骨架、提示词模板）。
copyDir(path.join(repo, "src", "templates"), path.join(dist, "templates"));

const distPkg = {
  name: rootPkg.name,
  version: rootPkg.version,
  private: true,
  type: "module",
  description: rootPkg.description,
  license: rootPkg.license,
  exports: { ".": "./index.mjs", "./client": "./client.js" },
  dsh: {
    bundle: { patch: "./cordis.patch.yml" },
    client: rootPkg.dsh && rootPkg.dsh.client ? rootPkg.dsh.client : { platform: "web" },
  },
};
fs.writeFileSync(path.join(dist, "package.json"), JSON.stringify(distPkg, null, 2) + "\n");

let files = 0;
walk(dist);
function walk(p) { for (const n of fs.readdirSync(p)) { const q = path.join(p, n); if (fs.statSync(q).isDirectory()) walk(q); else files++; } }
console.log("built " + rootPkg.name + "@" + rootPkg.version + " -> " + dist + " (" + files + " files)");