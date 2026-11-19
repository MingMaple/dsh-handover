/**
 * 身份布局四组合模拟：杂项→项目、项目→杂项，各跑「不迁移」与「迁移」。
 *
 * 直接调 lib 复跑，不碰真机会话：每组在临时目录里建一份最小库，
 * 走与真机相同的入口（applyRole 设身份、chooseMigration 了结），
 * 输出目录树、全局总注册、名册与在任登记四项末态，供人工核对。
 *
 * 用法：node scripts/axis-sim.mjs
 * 只写临时目录，结束即删；不写仓库内任何文件。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoleAssembly } from '../src/lib/role-assembly.mjs';
import { readRoles, layoutOf, handoverPathFor } from '../src/lib/role.mjs';
import { syncGlobalRefs } from '../src/lib/system.mjs';
import { loadOffice, registerHolder } from '../src/lib/office.mjs';

const NL = String.fromCharCode(10);

/** 最小库：项目清单表 + 全局总注册 + 一个任务或项目的体系文件。 */
function makeWorkspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-axis-sim-'));
  fs.mkdirSync(path.join(ws, '_Control_Center', 'records'), { recursive: true });
  fs.mkdirSync(path.join(ws, '_Project_Meta'), { recursive: true });
  fs.writeFileSync(path.join(ws, '_Project_Meta', 'Registry.md'),
    '# 注册表' + NL + NL + '## 项目清单' + NL + NL + '| 项目 | 库根 | 元数据 | 状态 | 交接 | 备注 | 更新 | 类型 |' + NL
    + '|---|---|---|---|---|---|---|---|' + NL, 'utf8');
  return ws;
}

function writeFiles(dir, name, withDocs) {
  if (withDocs !== false) {
    fs.mkdirSync(path.join(dir, 'Docs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Docs', 'note.md'), '# 说明' + NL, 'utf8');
  }
  fs.writeFileSync(path.join(dir, 'Handover.md'), '# 交接（' + name + '）' + NL + NL + '## §0 身份与寻址' + NL + NL + '会话类型：' + name + NL, 'utf8');
  fs.writeFileSync(path.join(dir, 'System.md'), '# 体系注册（' + name + '）' + NL + NL + '## 目录结构' + NL + NL + '| 路径 | 用途 |' + NL + '|---|---|' + NL + '| `' + name + '` | 库根 |' + NL, 'utf8');
  fs.writeFileSync(path.join(dir, 'Project_Overview.md'), '# 总览' + NL, 'utf8');
}

function makeMiscTask(ws, task) {
  const dir = path.join(ws, '_Misc', 'tasks', task);
  writeFiles(dir, '杂项任务「' + task + '」');
  fs.writeFileSync(path.join(dir, 'task.profile.json'), JSON.stringify({ schema: 1, kind: 'general', root: '_Misc/tasks/' + task }, null, 2) + NL, 'utf8');
  return dir;
}

function makeProject(ws, project) {
  const meta = path.join(ws, '_Project_Meta', project);
  const lib = path.join(ws, 'Projects', project, project + '库');
  fs.mkdirSync(meta, { recursive: true });
  writeFiles(meta, '项目「' + project + '」', false);
  fs.writeFileSync(path.join(meta, 'project.profile.json'), JSON.stringify({ schema: 1, kind: 'general', root: 'Projects/' + project }, null, 2) + NL, 'utf8');
  fs.mkdirSync(lib, { recursive: true });
  fs.writeFileSync(path.join(lib, 'RULES.md'), '# 规则' + NL, 'utf8');
  fs.mkdirSync(path.join(lib, 'Docs'), { recursive: true });
  fs.writeFileSync(path.join(lib, 'Docs', 'note.md'), '# 说明' + NL, 'utf8');
  return { meta, lib };
}

function assembly(ws, cfg) {
  return createRoleAssembly({
    ctx: { agents: { get: () => null, list: () => [] } },
    cfg,
    env: { log: () => {} },
    perStep: false,
    registered: new Set(),
    initErrors: [],
    walkUpToWorkspace: () => ws,
  });
}

/** 目录树：相对路径逐条列出，最多 40 条。 */
function fileList(ws) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let names = [];
    try { names = fs.readdirSync(dir).sort(); } catch { return; }
    for (const name of names) {
      const abs = path.join(dir, name);
      let st = null;
      try { st = fs.statSync(abs); } catch { continue; }
      if (st.isDirectory()) { out.push(path.relative(ws, abs).replace(/\\/g, '/') + '/'); walk(abs, depth + 1); }
      else out.push(path.relative(ws, abs).replace(/\\/g, '/'));
    }
  };
  walk(ws, 0);
  return out.slice(0, 40);
}

function globalRows(ws) {
  const file = path.join(ws, '_Control_Center', 'records', 'systems.md');
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return ['（无 systems.md）']; }
  const rows = text.split(/\r?\n/).filter((l) => l.trim().startsWith('|') && l.indexOf('任务') === -1 && !/^\|[\s:|-]+\|$/.test(l.trim()));
  return rows.length ? rows : ['（无任务行）'];
}

function registryRow(ws, name) {
  const file = path.join(ws, '_Project_Meta', 'Registry.md');
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return '（无 Registry.md）'; }
  const line = text.split(/\r?\n/).find((l) => l.indexOf('| ' + name + ' |') === 0);
  return line || '（项目清单无该行）';
}

function officeRows(ws) {
  const store = loadOffice(ws);
  const keys = Object.keys(store.lineages || {});
  if (!keys.length) return ['（无在任）'];
  return keys.map((k) => {
    const cur = store.lineages[k].current || {};
    return '  ' + k + '  ' + (store.lineages[k].kind || '') + '  ' + (cur.name || '-') + '  ' + (cur.sessionId || '-');
  });
}

async function run(title, from, to, migrate) {
  const ws = makeWorkspace();
  let dirs = null;
  const fromName = from.role === 'project' ? from.project : from.task;
  const toName = to.role === 'project' ? to.project : to.task;
  if (from.role === 'project') dirs = makeProject(ws, fromName);
  else dirs = makeMiscTask(ws, fromName);
  syncGlobalRefs(ws);
  const cfg = { workspaceRoot: ws, rolesPath: path.join(ws, 'roles.json'), roleGating: 'off' };
  const role = assembly(ws, cfg);
  const sid = 'session-sim-' + from.role + '-' + to.role + '-' + (migrate ? 'migrate' : 'keep');

  await role.applyRole({ sessionId: sid, role: from.role, project: from.project || '', task: from.task || '', wake: false });
  registerHolder(ws, { kind: from.role, project: from.project || '', task: from.task || '', name: fromName + '1', sessionId: sid });
  const switched = await role.applyRole({ sessionId: sid, role: to.role, project: to.project || '', task: to.task || '', wake: false });
  const choice = switched.pending ? role.chooseMigration({ sessionId: sid, apply: migrate }) : { migrated: false, changes: [], summary: '无需迁移' };
  const entry = readRoles(cfg).sessions[sid] || {};
  const info = { role: entry.role, project: entry.project, task: entry.task, layout: entry.layout, layoutName: entry.layoutName };
  const lay = layoutOf(info);
  const hp = handoverPathFor(ws, info);

  console.log('');
  console.log('=== ' + title + ' ===');
  console.log('角色表    role=' + entry.role + '  layout=' + (lay.kind || '-') + (lay.name ? '「' + lay.name + '」' : '')
    + '  pending=' + (entry.pending ? '有' : '无'));
  console.log('交接落点  ' + (hp.path ? path.relative(ws, hp.path).replace(/\\/g, '/') : '（无）'));
  console.log('了结结果  ' + (choice && choice.summary ? choice.summary : '（无）'));
  if (choice && Array.isArray(choice.changes) && choice.changes.length) {
    const n = (op) => choice.changes.filter((c) => c.op === op).length;
    console.log('清单个数  共 ' + choice.changes.length + ' 项：移动 ' + n('move') + '，新建 ' + n('mkdir') + '，跳过 ' + n('skip') + '，残留 ' + n('residue') + '，待改写 ' + n('manual'));
  }
  console.log('目录树：');
  for (const f of fileList(ws)) console.log('  ' + f);
  console.log('全局总注册：');
  for (const r of globalRows(ws)) console.log('  ' + r.trim());
  console.log('项目清单行：' + registryRow(ws, toName).trim());
  console.log('在任登记：');
  for (const r of officeRows(ws)) console.log(r);
  fs.rmSync(ws, { recursive: true, force: true });
}

await run('组合 1：杂项 → 项目（不迁移）', { role: 'misc', task: 'SimT' }, { role: 'project', project: 'SimT' }, false);
await run('组合 2：杂项 → 项目（迁移）', { role: 'misc', task: 'SimT' }, { role: 'project', project: 'SimT' }, true);
await run('组合 3：项目 → 杂项（不迁移）', { role: 'project', project: 'SimP' }, { role: 'misc', task: 'SimP' }, false);
await run('组合 4：项目 → 杂项（迁移）', { role: 'project', project: 'SimP' }, { role: 'misc', task: 'SimP' }, true);

console.log('');
console.log('SIM OK（四组合已跑完；以上为各组末态）');
