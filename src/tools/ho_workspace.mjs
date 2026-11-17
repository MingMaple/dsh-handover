/** ho_workspace —— 工作区生命周期、全局根目录迁移，以及备份与迁移包。 */
import fs from 'node:fs';
import { nameOf } from '../lib/names.mjs';
import path from 'node:path';
import { pathKey } from '../lib/pathkey.mjs';
import { textOutput } from '../lib/output.mjs';
import { NL, fmtBytes } from '../lib/text.mjs';
import { workspaceRows } from '../lib/registry.mjs';
import { createGlobalWorkspace, ensureScaffold } from '../lib/scaffold.mjs';
import { probeMove, startMove, moveStatus, cleanupOld, stageSwitch, repairLink, stageRetarget } from '../lib/mover.mjs';
import { currentRoot } from '../lib/api.mjs';
import { pmBackupTool } from './backup.mjs';
import { ABORTED_TEXT, signalOf } from '../lib/abort.mjs';

export const ACTIONS = [
  'init', 'scaffold', 'list', 'create', 'delete',
  'move-probe', 'move', 'move-switch', 'move-status', 'move-retarget', 'move-repair', 'move-cleanup',
  'backup-snapshot', 'backup-check', 'backup-pack', 'backup-verify', 'backup-restore',
];

const BAD = '现象：拒绝删除「全局」工作区。原因：该工作区是管理会话所在的工作区。处置：改为删除其他工作区。';

function renderProbe(p) {
  const out = [];
  out.push('迁移预检：' + (p.ok ? '通过' : '不通过'));
  out.push('  源  ' + p.src + (p.srcIsLink ? '（已是链接，指向 ' + p.linkTarget + '）' : ''));
  out.push('  复制源  ' + p.copyFrom);
  out.push('  目标  ' + p.dst);
  out.push('  总大小  ' + p.files + ' 文件 · ' + fmtBytes(p.bytes) + '（' + p.dirs + ' 子目录）');
  if (p.freeBytes !== null && p.freeBytes !== undefined) out.push('  目标盘可用  ' + fmtBytes(p.freeBytes));
  for (const w of p.warnings || []) out.push('  注意：' + w);
  for (const x of p.problems || []) out.push('  未通过：' + x);
  if (p.ok) out.push('提示：复制完成后生成切换脚本。切换步骤须完全退出 DSH 后再执行，源目录被占用。');
  return out.join(NL);
}

function baseWorkspaceTool(env) {
  return {
    name: nameOf('workspace'),
    description:
      '工作区生命周期：建立全局体系、补齐目录、登记与删除工作区，以及迁移全局根目录。删除只删注册，目录与会话日志一律保留。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['init', 'scaffold', 'list', 'create', 'delete', 'move-probe', 'move', 'move-switch', 'move-status', 'move-retarget', 'move-repair', 'move-cleanup'],
          description: '动作。`init`：首次建立全局体系。`scaffold`：补齐缺失目录与说明。`list`：列出工作区。`create`：登记工作区。`delete`：删除登记。`move-*`：迁移全局根目录。',
        },
        parent: { type: 'string', description: '`init` 用：目标父目录的绝对路径，不存在时创建。全局根建于其中。' },
        name: { type: 'string', description: '`init` 用：全局根目录名。缺省 `_Workspace`。' },
        register: { type: 'boolean', description: '`init` 用：建立后一并注册为工作区。缺省 `false`。' },
        path: { type: 'string', description: '`create` 用：目录绝对路径。缺省要求目录已存在；`ensure=true` 时自动创建。' },
        title: { type: 'string', description: '`create`、`init` 用：工作区显示标题。`init` 缺省为「全局」。' },
        ensure: { type: 'boolean', description: '`create` 用：目录不存在时自动创建。缺省 `false`，即不代建目录。' },
        workspace: { type: 'string', description: '`delete` 用：工作区 id、标题或路径。' },
        to: { type: 'string', description: '`move` 用：新根绝对路径。父目录可自动创建。' },
        confirm: { type: 'boolean', description: '`move-cleanup` 用：为 `true` 时才实际删除旧备份。' },
      },
    },
    output: textOutput(),
    async execute(args) {
      const reg = env.registry();
      const action = String(args.action || '');
      const out = [];

      if (action === 'init') {
        const parent = String(args.parent || '').trim();
        if (!parent) throw new Error('现象：`action="init"` 缺少 `parent`。原因：全局根必须建在指定父目录下。处置：传入父目录绝对路径后重试。');
        const r = createGlobalWorkspace(parent, { name: args.name });
        if (!r.ok) {
          out.push('现象：全局体系未建立。原因：' + r.error + '。');
          if (r.root) out.push('目标：`' + r.root + '`。');
          out.push('');
          out.push('处置：`ho_workspace(action="init", parent="<已存在的目录绝对路径>")`。插件仅新建，不覆盖。');
          return { text: out.join(NL) };
        }
        out.push('已建立全局文件体系：`' + r.root + '`');
        out.push('  目录 ' + r.created.length + ' 个：' + r.created.slice(0, 5).join('、') + (r.created.length > 5 ? '（仅列前 5 个）' : ''));
        out.push('  文件 ' + r.written.length + ' 个：' + (r.written.length ? r.written.join('、') : '（均已存在，未覆盖）'));
        if (r.existed) out.push('  目标原为空目录，直接使用。');
        if (r.createdParent) out.push('  父目录原不存在，已创建。');
        if (r.skipped.length) out.push('  跳过（已存在、未覆盖）：' + r.skipped.join('、'));
        let registered = null;
        if (args.register === true) {
          if (!reg || typeof reg.create !== 'function') {
            out.push('');
            out.push('现象：注册未完成。原因：`workspaceRegistry` 服务不可用。处置：将下列路径粘贴到 DSH 的新建工作区窗口。');
            out.push('  ' + r.root);
            return { text: out.join(NL) };
          }
          const title = String(args.title || '').trim() || '全局';
          try {
            const w = await reg.create(r.root, title);
            registered = w;
            out.push('');
            out.push('已注册工作区：' + title + '（' + String(w && w.id ? w.id : '?') + '）');
          } catch (e) {
            out.push('');
            out.push('现象：注册失败。原因：' + String(e && e.message ? e.message : e) + '。处置：将下列路径粘贴到 DSH 的新建工作区窗口。');
            out.push('  ' + r.root);
            return { text: out.join(NL) };
          }
        }
        out.push('');
        out.push('下一步：');
        if (!registered) {
          out.push('  1. 注册为工作区：`ho_workspace(action="create", path="' + r.root + '", title="全局")`，或将该路径粘贴到 DSH 的新建工作区窗口；');
          out.push('  2. 新建标题含「全局」的会话，闸门、交接体检与会话水位即接入。');
        } else {
          out.push('  新建标题含「全局」的会话，闸门、交接体检与会话水位即接入。');
        }
        out.push('（也可在设置页的 dsh-handover 中完成「首次安装」，效果相同。）');
        return { text: out.join(NL) };
      }

      if (action === 'scaffold') {
        const root = currentRoot(env);
        if (!root) throw new Error('现象：未找到全局根。原因：本实例尚未接入工作区。处置：先执行 `ho_workspace(action="init")` 建立全局体系，或 `action="create"` 登记已有工作区。');
        const r = ensureScaffold(root);
        if (!r.ok) {
          out.push('现象：文件体系未补齐。原因：' + r.error + '。');
          out.push('根目录：`' + root + '`。');
          return { text: out.join(NL) };
        }
        out.push('已核对文件体系：`' + root + '`');
        out.push('  新建目录 ' + r.created.length + ' 个：' + (r.created.length ? r.created.join('、') : '（无缺失）'));
        out.push('  新建文件 ' + r.written.length + ' 个：' + (r.written.length ? r.written.join('、') : '（无缺失）'));
        out.push('  已存在未覆盖 ' + r.skipped.length + ' 个' + (r.skipped.length ? '：' + r.skipped.join('、') : ''));
        if (r.missingTemplates && r.missingTemplates.length) {
          out.push('  内置模板缺失 ' + r.missingTemplates.length + ' 个，未写空文件：' + r.missingTemplates.join('、'));
        }
        out.push('只新建，不覆盖、不删除：已有文件的内容未作任何改动。');
        return { text: out.join(NL) };
      }

      if (action === 'list') {
        if (reg && typeof reg.list === 'function') {
          let list = [];
          try { list = reg.list() || []; } catch { list = []; }
          if (list.length) {
            out.push('工作区（官方注册表，' + list.length + ' 个）');
            for (const w of list) {
              const n = w && w.sessionIds && typeof w.sessionIds.length === 'number' ? w.sessionIds.length : '?';
              out.push('  ' + String(w.id) + '  ' + String(w.title || '-') + '  ' + String(w.path || '-') + '  会话 ' + n);
            }
            return { text: out.join(NL) };
          }
        }
        const rows = workspaceRows();
        out.push('工作区（退化读取 `workspace.json`，' + rows.length + ' 个）');
        for (const r of rows) out.push('  ' + r.id + '  ' + r.title + '  ' + r.path + '  会话 ' + r.sessions);
        return { text: out.join(NL) };
      }

      if (action === 'create') {
        if (!reg || typeof reg.create !== 'function') throw new Error('现象：`workspaceRegistry.create` 不可用。原因：宿主未注入工作区登记服务。处置：确认 DSH 版本后重启；或在新建工作区窗口手动登记。');
        const p = String(args.path || '').trim();
        if (!p) throw new Error('现象：`create` 缺少 `path`。原因：登记工作区须给出目录绝对路径。处置：传入 `path` 后重试。');
        let st = null;
        try { st = fs.statSync(p); } catch { st = null; }
        if ((!st || !st.isDirectory()) && args.ensure === true) {
          try { fs.mkdirSync(p, { recursive: true }); st = fs.statSync(p); } catch (e) { throw new Error('现象：目录创建失败：`' + p + '`。原因：' + String(e && e.message ? e.message : e) + '。处置：核对路径与写入权限后重试，或先手工建好目录。'); }
        }
        if (!st || !st.isDirectory()) throw new Error('现象：目录不存在或不是目录：`' + p + '`。原因：`create` 缺省不代建目录。处置：传入 `ensure=true` 自动创建，或先手工建好目录。');
        const title = String(args.title || '').trim() || p.split(/[\\/]/).filter(Boolean).pop() || p;
        let w = null;
        try { w = await reg.create(p, title); } catch (e) { throw new Error('现象：登记工作区失败。原因：' + String(e && e.message ? e.message : e) + '。处置：核对工作区服务状态后重试。'); }
        out.push('已注册工作区 ' + String(w && w.id ? w.id : '?') + '  ' + String(w && w.title ? w.title : title));
        out.push('路径 ' + String(w && w.path ? w.path : p));
        out.push('同一路径重复调用返回原记录，不改标题；新登记的工作区排在列表最前。');
        return { text: out.join(NL) };
      }

      if (action === 'delete') {
        if (!reg || typeof reg.delete !== 'function') throw new Error('现象：`workspaceRegistry.delete` 不可用。原因：宿主未注入工作区登记服务。处置：确认 DSH 版本后重启，再重试。');
        const key = String(args.workspace || '').trim();
        if (!key) throw new Error('现象：`delete` 缺少 `workspace`。原因：删除登记须指明目标工作区。处置：传入工作区 id、标题或路径后重试。');
        let list = [];
        try { list = reg.list() || []; } catch { list = []; }
        const norm = (s) => pathKey(String(s || ''));
        const hit = list.find((w) => String(w.id) === key || w.title === key || norm(w.path) === norm(key));
        if (!hit) throw new Error('现象：未找到工作区：`' + key + '`。原因：`workspace` 与登记表不匹配。处置：先执行 `ho_workspace(action="list")` 核对 id、标题或路径。');
        if (String(hit.title || '').indexOf('全局') !== -1) throw new Error(BAD);
        const ok = await reg.delete(hit.id);
        out.push((ok ? '已删除工作区注册 ' : '该工作区不存在（无操作）') + String(hit.id) + '  ' + String(hit.title || '-'));
        out.push('注意：只删注册；目录与全部会话日志均保留在原处。');
        return { text: out.join(NL) };
      }

      if (action === 'move-probe' || action === 'move') {
        const src = currentRoot(env);
        if (!src) throw new Error('现象：未找到全局根。原因：本实例尚未接入工作区。处置：先执行 `ho_workspace(action="init")` 建立全局体系，或 `action="create"` 登记已有工作区。');
        const to = String(args.to || '').trim();
        if (!to) throw new Error('现象：`' + action + '` 缺少 `to`。原因：迁移全局根须给出新根绝对路径。处置：传入 `to` 后重试。');
        if (action === 'move-probe') {
          const p = await probeMove({ src, to });
          return { text: renderProbe(p) };
        }
        const p = await probeMove({ src, to });
        if (!p.ok) return { text: renderProbe(p) + NL + '未开始复制。处置：按上列未通过项修正后重试。' };
        const r = await startMove({ src, to, signal: signalOf(exec) });
        if (r.aborted) {
          out.push('已中止：迁移复制被用户终止。已复制的文件保留在目标目录，未校验、未生成切换脚本。');
          out.push(ABORTED_TEXT);
          return { text: out.join(NL) };
        }
        if (!r.ok) {
          out.push('现象：复制完成，但校验存在差异，未生成切换脚本。原因：目标目录与源目录的文件清单不一致。');
          out.push('  文件 源 ' + r.report.files + ' / 目标 ' + r.report.copies);
          out.push('  缺失 ' + r.report.missingCount + ' 条' + (r.report.missing.length ? '：' + r.report.missing.join('、') : ''));
          out.push('  多出 ' + r.report.extraCount + ' 条' + (r.report.extra.length ? '：' + r.report.extra.join('、') : ''));
          out.push('处置：清空目标目录后重跑，或先停止正在写入文件的会话。');
          return { text: out.join(NL) };
        }
        out.push('复制并校验通过：' + r.report.files + ' 文件 · ' + fmtBytes(r.report.bytes));
        out.push('  sha256 清单摘要 ' + r.report.digest);
        out.push('  目标  ' + r.marker.dst);
        out.push('  切换助手  ' + r.marker.script.helper);
        out.push('  手工启动器（Windows、POSIX）  ' + r.marker.script.cmd + ' 、 ' + r.marker.script.sh);
        out.push('');
        out.push('下一步（3 步，顺序不可调换）：');
        out.push('  （1）完全退出 DSH。源目录被占用，改名会失败。');
        out.push('  （2）执行 `ho_workspace(action="move-switch")` 派出后台切换助手，推荐此用法；该助手会在 DSH 退出后自动完成切换。');
        out.push('  （3）重新启动 DSH。确认无误后可在设置页删除旧备份。');
        return { text: out.join(NL) };
      }

      if (action === 'move-switch') {
        const r = stageSwitch({ relaunch: args.relaunch === true });
        if (r.already) { out.push('已处于切换态（原路径即链接），无需再次切换。'); return { text: out.join(NL) }; }
        out.push('已派出后台切换助手（pid ' + r.pid + '）。');
        out.push('  该助手会在完全退出 DSH 后自动完成：旧目录改名、原位建立链接、校验指向' + (r.relaunch ? '，然后重新启动 DSH' : '') + '。');
        out.push('  日志：`' + r.log + '`。');
        out.push('  提醒：此后不得修改该工作区内的文件，改动只会落在仍在使用的旧目录上。');
        return { text: out.join(NL) };
      }

      if (action === 'move-status') {
        const st = moveStatus();   // 以标记里的源路径为准：修改登记后当前根已是新位置，拿它比对会误报
        const label = { none: '没有迁移记录', verified: '已复制并校验通过，待切换', switched: '已切换（原路径为链接）', partial: '复制有差异，未生成脚本' };
        out.push('迁移状态：' + (label[st.phase] || st.phase));
        out.push('  源  `' + st.src + '`' + (st.linkTarget ? '（当前为链接，指向 `' + st.linkTarget + '`）' : ''));
        if (st.dst) out.push('  目标  `' + st.dst + '`');
        if (st.marker && st.marker.files) out.push('  清单  ' + st.marker.files + ' 文件 · ' + (st.marker.digest || '').slice(0, 16) + '…');
        if (st.retarget) {
          if (st.retarget.needed) {
            out.push('  DSH 登记仍指向旧路径：' + st.retarget.total + ' 处');
            for (const f of st.retarget.files) out.push('    ' + f.path + '  ×' + f.count);
            out.push('  处置：执行 `ho_workspace(action="move-retarget")`。退出 DSH 后由助手改写，改写前先备份。');
          } else {
            out.push('  DSH 登记已在新位置（无需修改登记）');
          }
        }
        if (st.olds && st.olds.length) {
          for (const o of st.olds) out.push('  旧备份  ' + o.path + '  ' + fmtBytes(o.bytes));
          out.push('  处置：执行 `ho_workspace(action="move-cleanup", confirm=true)`。');
        } else if (st.phase === 'switched') {
          out.push('  无旧备份');
        }
        return { text: out.join(NL) };
      }

      if (action === 'move-retarget') {
        const r = stageRetarget();
        if (r.already) { out.push('DSH 登记已在新位置，无需修改登记。'); return { text: out.join(NL) }; }
        if (!r.ok) { out.push('现象：派出修改登记的助手失败。原因：' + r.error + '。'); out.push('  处置：手工执行 `' + (r.script && r.script.helper) + '`。'); return { text: out.join(NL) }; }
        out.push('已派出修改登记的助手（pid ' + r.pid + '）。');
        out.push('  该助手会在完全退出 DSH 后改写下列登记（每份先备份）：');
        for (const f of (r.plan.files || [])) if (f.count) out.push('    ' + f.path + '  ×' + f.count);
        out.push('  只改登记文本，不改动任何数据文件；日志：' + (r.script && r.script.log));
        return { text: out.join(NL) };
      }

      if (action === 'move-repair') {
        const r = repairLink();
        if (r.already) { out.push('原路径已是指向新根的链接，无需重建。'); return { text: out.join(NL) }; }
        out.push('已重建链接：`' + r.src + '` 指向 `' + r.dst + '`（' + r.kind + '）。');
        out.push('  说明：仅建立链接，未改动任何文件。');
        return { text: out.join(NL) };
      }

      if (action === 'move-cleanup') {
        if (args.confirm !== true) throw new Error('现象：`move-cleanup` 缺少确认参数。原因：该动作会实际删除旧备份目录。处置：确认后传 `confirm=true` 再调用。');
        const r = await cleanupOld({ confirm: true });
        out.push(r.note);
        for (const p of r.removed) out.push('  已删除 ' + p);
        if (r.bytes) out.push('  释放 ' + fmtBytes(r.bytes));
        return { text: out.join(NL) };
      }

      throw new Error('现象：`action` 取值不在允许范围。原因：收到 `' + action + '`，只接受 init、scaffold、list、create、delete 与 move-* 系列。处置：改用上述取值之一后重试。');
    },
  };
}

/**
 * 构造 `workspace` 合并入口。
 *
 * 生命周期与备份迁移共用一个工具，`backup-*` 动作转交 backup 工具。
 *
 * @param {object} env 插件环境，提供 `registry`、`roleOf` 与 `resolveWs`。
 * @returns {object} 工具定义，供宿主注册。
 * 副作用：建目录、写脚手架、改登记与迁移根目录。
 */
export function pmWorkspaceTool(env) {
  const base = baseWorkspaceTool(env);
  const backup = pmBackupTool(env);
  return {
    name: nameOf('workspace'),
    description: '工作区生命周期与备份迁移。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ACTIONS, description: '动作，必填。例：`init`；`backup-*` 为备份与迁移动作。' },
        parent: { type: 'string', description: '`init` 的目标父目录绝对路径，不存在时创建。' },
        name: { type: 'string', description: '`init` 的全局根目录名；`backup-pack` 的项目名或任务名。' },
        register: { type: 'boolean', description: '`init` 为 `true` 时一并注册为工作区。' },
        path: { type: 'string', description: '`create` 的工作区目录绝对路径。例：`E:/Demo`。' },
        title: { type: 'string', description: '`create`、`init` 的工作区显示标题。例：`全局`。' },
        ensure: { type: 'boolean', description: '`create` 为 `true` 时目录不存在则创建。' },
        workspace: { type: 'string', description: '`delete` 的目标工作区，可传 id、标题或路径。' },
        to: { type: 'string', description: '`move` 的新根绝对路径。例：`E:/_Workspace2`。' },
        confirm: { type: 'boolean', description: '`move-cleanup` 为 `true` 时才删除旧备份。' },
        project: { type: 'string', description: '`backup-snapshot` 的项目名。例：`Demo`。' },
        tag: { type: 'string', description: '`backup-snapshot` 的快照标签。缺省「行为检查」。' },
        kind: { type: 'string', enum: ['project', 'task', 'global'], description: '`backup-pack` 的打包类型。' },
        out: { type: 'string', description: '`backup-pack` 的输出目录。例：`_Temp/Packs`。' },
        note: { type: 'string', description: '`backup-pack` 写入 `MIGRATION.md` 的说明。' },
        items: { type: 'array', items: { type: 'string' }, description: '`backup-check` 检查的项目名，`global` 表示全局。' },
        min_age_min: { type: 'number', description: '`backup-check` 要求的静止分钟数，缺省 90。' },
        pack: { type: 'string', description: '`backup-verify`、`backup-restore` 的包路径。' },
        target: { type: 'string', description: '`backup-restore` 的目标根，缺省为当前根。' },
        apply: { type: 'boolean', description: '`backup-restore` 为 `true` 时才写入。' },
        dry_run: { type: 'boolean', description: '为 `true` 时只统计或列清单，不写盘。' },
        format: { type: 'string', enum: ['auto', '7z', 'tar'], description: '`backup-pack` 的归档格式，缺省 `auto`。' },
      },
    },
    output: textOutput(),
    async execute(args, exec) {
      const action = String(args.action || '');
      if (ACTIONS.indexOf(action) === -1) {
        throw new Error('现象：`action` 取值不在允许范围。原因：收到 `' + action + '`。处置：改用 ' + ACTIONS.join('、') + ' 之一后重试。');
      }
      if (action.indexOf('move-') === 0) {
        let info = null;
        try { info = env.roleOf(exec); } catch { info = null; }
        if (info && info.role && info.role !== 'global') {
          throw new Error('现象：当前会话不能执行 `' + action + '`。原因：全局根目录迁移只对全局会话开放。处置：改由全局会话执行。');
        }
      }
      const need = { create: ['path'], delete: ['workspace'], move: ['to'], 'backup-snapshot': ['project'], 'backup-pack': ['kind'], 'backup-verify': ['pack'], 'backup-restore': ['pack'] }[action];
      for (const f of need || []) {
        if (!String(args[f] === undefined || args[f] === null ? '' : args[f]).trim()) {
          throw new Error('现象：`' + action + '` 缺少 `' + f + '`。原因：该动作必填该参数。处置：补齐 `' + f + '` 后重试。');
        }
      }
      if (action === 'backup-snapshot') return backup.execute({ action: 'snapshot', project: args.project, tag: args.tag, dry_run: args.dry_run }, exec);
      if (action === 'backup-check') return backup.execute({ action: 'check', items: args.items, min_age_min: args.min_age_min }, exec);
      if (action === 'backup-pack') return backup.execute({ action: 'pack', kind: args.kind, name: args.name, out: args.out, note: args.note, format: args.format, dry_run: args.dry_run }, exec);
      if (action === 'backup-verify') return backup.execute({ action: 'verify', pack: args.pack }, exec);
      if (action === 'backup-restore') return backup.execute({ action: 'restore', pack: args.pack, target: args.target, apply: args.apply, dry_run: args.dry_run }, exec);
      return base.execute(args);
    },
  };
}
