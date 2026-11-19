/**
 * 库内绝对路径扫描：迁移之前先报数，让用户在「迁」与「不迁」之间看清代价。
 *
 * 只读，不改任何文件。扫描范围是库根（含元数据目录）下的文档与脚本。
 * 按扩展名白名单取文件，跳过临时、归档与依赖目录。单文件与总量都有上限，避免一次迁移询问拖住一轮。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 参与扫描的扩展名：文档、配置、脚本与表格文本。 */
const EXT = ['.md', '.txt', '.json', '.mjs', '.js', '.cjs', '.yml', '.yaml', '.ps1', '.sh', '.cmd', '.bat', '.csv'];
/** 不参与扫描的目录名：临时、归档与依赖。 */
const SKIP_DIRS = ['node_modules', 'dist', '_Archives', '_Temp', '_archive'];
/** 单文件上限：再大的文件多是日志或数据，逐行判绝对路径没有意义。 */
const MAX_FILE_BYTES = 512 * 1024;
/** 总量上限：命中总量后停止遍历，并在结果里标明已截断。 */
const MAX_TOTAL_BYTES = 48 * 1024 * 1024;
const MAX_FILES = 4000;
const MAX_DEPTH = 8;
const DEFAULT_SAMPLES = 5;

/** 写死的绝对路径：盘符、UNC 与常见 Unix 根。 */
const ABS_RE = /(?:[A-Za-z]:[\\/]|\\\\[A-Za-z0-9._$-]+[\\/]|\/(?:Users|home|mnt|opt|var|private|root)\/)/;

/**
 * 扫描库内写死绝对路径。
 * @param {string} root 工作区根（绝对路径）
 * @param {object} [opts] { samples?: 样例条数, exts?: 覆盖扩展名白名单 }
 * @returns {{ root: string, exists: boolean, files: number, lines: number, scanned: number, truncated: boolean, samples: object[] }}
 */
export function scanAbsolutePaths(root, opts) {
  const o = opts || {};
  const ws = String(root || '');
  const exts = Array.isArray(o.exts) && o.exts.length ? o.exts : EXT;
  const sampleMax = Number.isFinite(o.samples) && o.samples > 0 ? Math.floor(o.samples) : DEFAULT_SAMPLES;
  const out = { root: ws, exists: false, files: 0, lines: 0, scanned: 0, truncated: false, samples: [] };
  if (!ws) return out;
  try { if (!fs.statSync(ws).isDirectory()) return out; } catch { return out; }
  out.exists = true;
  let budget = MAX_TOTAL_BYTES;
  let stopped = false;

  const walk = (dir, depth) => {
    if (stopped || depth > MAX_DEPTH) return;
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    names.sort();
    for (const name of names) {
      if (stopped) return;
      if (out.scanned >= MAX_FILES) { out.truncated = true; stopped = true; return; }
      const abs = path.join(dir, name);
      let st = null;
      try { st = fs.lstatSync(abs); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (SKIP_DIRS.indexOf(name) !== -1 || name.charAt(0) === '.') continue;
        walk(abs, depth + 1);
        continue;
      }
      if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
      if (exts.indexOf(path.extname(name).toLowerCase()) === -1) continue;
      if (budget - st.size < 0) { out.truncated = true; stopped = true; return; }
      budget -= st.size;
      out.scanned += 1;
      let text = '';
      try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
      const rows = text.split(/\r?\n/);
      let hits = 0;
      for (let i = 0; i < rows.length; i++) {
        if (!ABS_RE.test(rows[i])) continue;
        hits += 1;
        if (out.samples.length < sampleMax) {
          out.samples.push({
            file: path.relative(ws, abs).replace(/\\/g, '/'),
            line: i + 1,
            text: rows[i].trim().slice(0, 120),
          });
        }
      }
      if (hits) { out.files += 1; out.lines += hits; }
    }
  };

  walk(ws, 0);
  return out;
}

/**
 * 多根合并扫描：一次迁移可能同时涉及库根与元数据目录，2 处都要报数。
 * 数值相加、样例合并、任一根截断即视为截断；根不存在时跳过，不报错。
 * @param {string[]} roots 绝对目录
 * @param {object} [opts] 同 scanAbsolutePaths
 * @returns 与 scanAbsolutePaths 同形
 */
export function scanRoots(roots, opts) {
  const o = opts || {};
  const sampleMax = Number.isFinite(o.samples) && o.samples > 0 ? Math.floor(o.samples) : DEFAULT_SAMPLES;
  const uniq = Array.from(new Set((Array.isArray(roots) ? roots : []).map((r) => String(r || '')).filter(Boolean)));
  const acc = { root: uniq.join(';'), exists: false, files: 0, lines: 0, scanned: 0, truncated: false, samples: [] };
  for (const r of uniq) {
    const one = scanAbsolutePaths(r, Object.assign({}, o, { samples: sampleMax }));
    if (!one.exists) continue;
    acc.exists = true;
    acc.files += one.files;
    acc.lines += one.lines;
    acc.scanned += one.scanned;
    acc.truncated = acc.truncated || one.truncated;
    for (const s of one.samples) {
      if (acc.samples.length >= sampleMax) break;
      acc.samples.push(s);
    }
  }
  return acc;
}

/** 报数行：迁移问句与迁移结果共用同一句口径。 */
export function scanReportText(scan) {
  const r = scan || {};
  if (!r.exists) return '库根读不到，绝对路径引用数未核。';
  const tail = r.truncated ? '（扫描提前结束，实际可能更多）' : '';
  if (!r.files) return '库内未发现写死的绝对路径' + tail + '。';
  return '库内写死绝对路径：' + r.files + ' 个文件、' + r.lines + ' 行' + tail + '。';
}

/** 样例行：最多 3 条，带文件与行号，供用户判断是否值得改动。 */
export function scanSampleLines(scan, max) {
  const list = scan && Array.isArray(scan.samples) ? scan.samples : [];
  const n = Number.isFinite(max) && max > 0 ? Math.floor(max) : 3;
  return list.slice(0, n).map((s) => '  ' + s.file + ':' + s.line + '  ' + s.text);
}
