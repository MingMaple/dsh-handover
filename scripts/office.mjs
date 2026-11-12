#!/usr/bin/env node
/**
 * 命令行查在任登记表：`node scripts/office.mjs 全局 全局3 Demo1`
 *
 * 与工具 ho_office 同一份实现、同一份记录（_Control_Center/records/Office.json），
 * 区别只是不起会话也能查。工作区根按 --root → DSH_OFFICE_ROOT → 从 cwd 向上找 _Control_Center 的顺序解析。
 */
import path from 'node:path';
import { isDir } from '../src/lib/text.mjs';
import { loadOffice, resolveOffice, rowsOf, formatRow, officePath, KIND_LABEL } from '../src/lib/office.mjs';

function walkUp(start) {
  let cur = path.resolve(start);
  for (let i = 0; i < 8 && cur; i++) {
    if (isDir(path.join(cur, '_Control_Center'))) return cur;
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return '';
}

const argv = process.argv.slice(2);
let root = process.env.DSH_OFFICE_ROOT || process.env.DSH_HANDOVER_ROOT || '';
let json = false;
let all = false;
const queries = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--root') { root = argv[++i] || ''; continue; }
  if (a === '--json') { json = true; continue; }
  if (a === '--all' || a === '-a') { all = true; continue; }
  if (a === '-h' || a === '--help') {
    console.log('用法：node scripts/office.mjs [查询…] [--all] [--json] [--root <工作区根>]');
    console.log('示例：node scripts/office.mjs 全局 全局3 Demo1');
    process.exit(0);
  }
  queries.push(a);
}
if (!root) root = walkUp(process.cwd());
if (!root) {
  console.error('找不到工作区根（没有 _Control_Center）：用 --root 指定，例如 --root <全局根绝对路径>');
  process.exit(2);
}

const store = loadOffice(root);
const rows = rowsOf(store);
if (!rows.length) {
  console.error('在任登记表是空的：' + officePath(root));
  console.log('提示：由全局会话用 ho_sessions / 换任流程登记一次在任会话，登记表随之生成。');
  process.exit(2);
}

if (all || !queries.length) {
  if (json) {
    console.log(JSON.stringify({ updatedAt: store.updatedAt || '', rows }, null, 2));
  } else {
    let lastKind = '';
    for (const r of rows) {
      if (r.kind !== lastKind) {
        console.log((lastKind ? '\n' : '') + '【' + (KIND_LABEL[r.kind] || r.kind) + '】');
        lastKind = r.kind;
      }
      console.log(formatRow(r));
    }
  }
  process.exit(0);
}

let miss = 0;
const hits = [];
for (const q of queries) {
  const r = resolveOffice(store, q);
  if (!r.ok) { console.log(q + '  — ' + r.reason); miss++; continue; }
  if (r.vacant) { console.log(q + '  — 类别「' + r.key + '」当前空缺（无人在任）'); continue; }
  const row = { key: r.key, kind: r.lineage.kind, project: r.lineage.project, task: r.lineage.task, current: r.lineage.current };
  if (!json) console.log(formatRow(row, q));
  hits.push({ askedAs: q, via: r.via, key: r.key, kind: r.lineage.kind, name: r.lineage.current.name, sessionId: r.lineage.current.sessionId });
}
if (json) console.log(JSON.stringify({ updatedAt: store.updatedAt || '', hits }, null, 2));
process.exit(miss ? 1 : 0);
