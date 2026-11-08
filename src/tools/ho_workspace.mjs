/** ho_workspace —— 工作区生命周期：list / create / delete（官方 workspaceRegistry）＋ 全局根目录搬迁。 */
import fs from 'node:fs';
import { nameOf } from '../lib/names.mjs';
import path from 'node:path';
import { textOutput } from '../lib/output.mjs';
import { NL } from '../lib/text.mjs';
import { workspaceRows } from '../lib/registry.mjs';
import { probeMove, startMove, moveStatus, cleanupOld, stageSwitch, repairLink, stageRetarget } from '../lib/mover.mjs';
import { currentRoot } from '../lib/api.mjs';

const BAD = '不能删除「全局」工作区（那是管理会话的家）。';

function gb(n) {
  const v = Number(n) || 0;
  if (v >= 1024 * 1024 * 1024) return (v / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  if (v >= 1024 * 1024) return (v / (1024 * 1024)).toFixed(1) + ' MB';
  if (v >= 1024) return (v / 1024).toFixed(1) + ' KB';
  return v + ' B';
}

function renderProbe(p) {
  const out = [];
  out.push('搬迁预检：' + (p.ok ? '通过' : '不通过'));
  out.push('  源  ' + p.src + (p.srcIsLink ? '（已是链接，指向 ' + p.linkTarget + '）' : ''));
  out.push('  复制源  ' + p.copyFrom);
  out.push('  目标  ' + p.dst);
  out.push('  总大小  ' + p.files + ' 文件 · ' + gb(p.bytes) + '（' + p.dirs + ' 子目录）');
  if (p.freeBytes !== null && p.freeBytes !== undefined) out.push('  目标盘可用  ' + gb(p.freeBytes));
  for (const w of p.warnings || []) out.push('  注意：' + w);
  for (const x of p.problems || []) out.push('  未通过：' + x);
  if (p.ok) out.push('提示：复制完会生成切换脚本；切换那一步需要**完全退出 DSH** 再跑（源目录被占用）。');
  return out.join(NL);
}

export function pmWorkspaceTool(env) {
  return {
    name: nameOf('workspace'),
    description:
      '工作区 list、create、delete；move-* 搬整个全局根目录（探针、执行、状态、清旧副本）。删除只删注册。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'create', 'delete', 'move-probe', 'move', 'move-switch', 'move-status', 'move-retarget', 'move-repair', 'move-cleanup'],
          description: 'list / create / delete / move-probe / move / move-switch / move-status / move-retarget / move-repair / move-cleanup',
        },
        path: { type: 'string', description: 'create 用：目录绝对路径；默认要求已存在，ensure=true 时自动创建' },
        title: { type: 'string', description: 'create 用：显示标题' },
        ensure: { type: 'boolean', description: 'create 用：目录不存在时自动创建（默认 false，不替你建目录）' },
        workspace: { type: 'string', description: 'delete 用：工作区 id、标题、路径' },
        to: { type: 'string', description: 'move 用：新根绝对路径（父目录可自动建）' },
        confirm: { type: 'boolean', description: 'move-cleanup 用：true 才真的删旧副本' },
      },
    },
    output: textOutput(),
    async execute(args) {
      const reg = env.registry();
      const action = String(args.action || '');
      const out = [];

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
        out.push('工作区（退化：读 workspace.json，' + rows.length + ' 个）');
        for (const r of rows) out.push('  ' + r.id + '  ' + r.title + '  ' + r.path + '  会话 ' + r.sessions);
        return { text: out.join(NL) };
      }

      if (action === 'create') {
        if (!reg || typeof reg.create !== 'function') throw new Error('workspaceRegistry.create 不可用');
        const p = String(args.path || '').trim();
        if (!p) throw new Error('create 需要 path（目录绝对路径）');
        let st = null;
        try { st = fs.statSync(p); } catch { st = null; }
        if ((!st || !st.isDirectory()) && args.ensure === true) {
          try { fs.mkdirSync(p, { recursive: true }); st = fs.statSync(p); } catch (e) { throw new Error('建目录失败：' + p + '（' + String(e && e.message ? e.message : e) + '）'); }
        }
        if (!st || !st.isDirectory()) throw new Error('目录不存在或不是目录：' + p + '（默认不替你建目录；要建请传 ensure=true，或先手工建好）');
        const title = String(args.title || '').trim() || p.split(/[\\/]/).filter(Boolean).pop() || p;
        let w = null;
        try { w = await reg.create(p, title); } catch (e) { throw new Error('建工作区失败：' + String(e && e.message ? e.message : e)); }
        out.push('已注册工作区 ' + String(w && w.id ? w.id : '?') + '  ' + String(w && w.title ? w.title : title));
        out.push('路径 ' + String(w && w.path ? w.path : p));
        out.push('同一路径重复调用返回原记录、不改标题；新登记的工作区排在列表最前。');
        return { text: out.join(NL) };
      }

      if (action === 'delete') {
        if (!reg || typeof reg.delete !== 'function') throw new Error('workspaceRegistry.delete 不可用');
        const key = String(args.workspace || '').trim();
        if (!key) throw new Error('delete 需要 workspace（id、标题、路径）');
        let list = [];
        try { list = reg.list() || []; } catch { list = []; }
        const norm = (s) => String(s || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
        const hit = list.find((w) => String(w.id) === key || w.title === key || norm(w.path) === norm(key));
        if (!hit) throw new Error('找不到工作区：' + key);
        if (String(hit.title || '').indexOf('全局') !== -1) throw new Error(BAD);
        const ok = await reg.delete(hit.id);
        out.push((ok ? '已删除工作区注册 ' : '该工作区不存在（无操作）') + String(hit.id) + '  ' + String(hit.title || '-'));
        out.push('注意：只删注册；目录与全部会话日志都保留在原处。');
        return { text: out.join(NL) };
      }

      if (action === 'move-probe' || action === 'move') {
        const src = currentRoot(env);
        if (!src) throw new Error('未找到全局根（工作区未接入）');
        const to = String(args.to || '').trim();
        if (!to) throw new Error(action === 'move' ? 'move 需要 to（新根绝对路径）' : 'move-probe 需要 to（新根绝对路径）');
        if (action === 'move-probe') {
          const p = await probeMove({ src, to });
          return { text: renderProbe(p) };
        }
        const p = await probeMove({ src, to });
        if (!p.ok) return { text: renderProbe(p) + NL + '未开始复制。' };
        const r = await startMove({ src, to });
        if (!r.ok) {
          out.push('复制完成但**校验有差异**，未生成切换脚本。');
          out.push('  文件 源 ' + r.report.files + ' / 目标 ' + r.report.copies);
          out.push('  缺失 ' + r.report.missingCount + ' 条' + (r.report.missing.length ? '：' + r.report.missing.join('、') : ''));
          out.push('  多出 ' + r.report.extraCount + ' 条' + (r.report.extra.length ? '：' + r.report.extra.join('、') : ''));
          out.push('处置：清空目标目录后重跑，或先停掉在写文件的会话。');
          return { text: out.join(NL) };
        }
        out.push('复制并校验通过：' + r.report.files + ' 文件 · ' + gb(r.report.bytes));
        out.push('  sha256 清单摘要 ' + r.report.digest);
        out.push('  目标  ' + r.marker.dst);
        out.push('  切换助手  ' + r.marker.script.helper);
        out.push('  手工启动器（Windows、POSIX）  ' + r.marker.script.cmd + ' 、 ' + r.marker.script.sh);
        out.push('');
        out.push('下一步（三条，顺序不能换）：');
        out.push('  ① 完全退出 DSH（源目录被占用，改名会失败）');
        out.push('  ② 执行 ho_workspace(action="move-switch") 派后台助手（推荐）；助手会等待 DSH 退出后自动完成');
        out.push('  ③ 重新启动 DSH；确认无误后在设置页点「删除旧副本」');
        return { text: out.join(NL) };
      }

      if (action === 'move-switch') {
        const r = stageSwitch({ relaunch: args.relaunch === true });
        if (r.already) { out.push('已经是切换态（旧路径就是 junction），无需再切。'); return { text: out.join(NL) }; }
        out.push('已派出后台切换助手（pid ' + r.pid + '）。');
        out.push('  它会在你**完全退出 DSH** 后自动完成：旧目录改名、原位建 junction、校验指向' + (r.relaunch ? '，然后重新启动 DSH' : '') + '。');
        out.push('  日志：' + r.log);
        out.push('  提醒：从现在起不要改这个工作区里的文件（改动只会落在还活着的旧目录上）。');
        return { text: out.join(NL) };
      }

      if (action === 'move-status') {
        const st = moveStatus();   // 以标记里的源路径为准：修改登记后当前根已是新位置，拿它比对会误报
        const label = { none: '没有搬迁记录', verified: '已复制校验通过，等待切换', switched: '已切换（旧路径是 junction）', partial: '复制有差异，未生成脚本' };
        out.push('搬迁状态：' + (label[st.phase] || st.phase));
        out.push('  源  ' + st.src + (st.linkTarget ? '（→ ' + st.linkTarget + '）' : ''));
        if (st.dst) out.push('  目标  ' + st.dst);
        if (st.marker && st.marker.files) out.push('  清单  ' + st.marker.files + ' 文件 · ' + (st.marker.digest || '').slice(0, 16) + '…');
        if (st.retarget) {
          if (st.retarget.needed) {
            out.push('  DSH 登记仍指着旧路径：' + st.retarget.total + ' 处');
            for (const f of st.retarget.files) out.push('    ' + f.path + '  ×' + f.count);
            out.push('  修改登记：ho_workspace(action="move-retarget")（退出 DSH 后由助手改写，先备份）');
          } else {
            out.push('  DSH 登记已在新位置（无需修改登记）');
          }
        }
        if (st.olds && st.olds.length) {
          for (const o of st.olds) out.push('  旧副本  ' + o.path + '  ' + gb(o.bytes));
          out.push('  删除：ho_workspace(action="move-cleanup", confirm=true)');
        } else if (st.phase === 'switched') {
          out.push('  没有旧副本残留');
        }
        return { text: out.join(NL) };
      }

      if (action === 'move-retarget') {
        const r = stageRetarget();
        if (r.already) { out.push('DSH 登记已在新位置，无需修改登记。'); return { text: out.join(NL) }; }
        if (!r.ok) { out.push('派助手失败：' + r.error); out.push('  手工执行：' + (r.script && r.script.helper)); return { text: out.join(NL) }; }
        out.push('已派出登记修改登记助手（pid ' + r.pid + '）。');
        out.push('  它会在你完全退出 DSH 后改写这些登记（每份先备份）：');
        for (const f of (r.plan.files || [])) if (f.count) out.push('    ' + f.path + '  ×' + f.count);
        out.push('  只改登记文本，不动任何数据文件；日志：' + (r.script && r.script.log));
        return { text: out.join(NL) };
      }

      if (action === 'move-repair') {
        const r = repairLink();
        if (r.already) { out.push('原路径已是指向新根的链接，无需重建。'); return { text: out.join(NL) }; }
        out.push('已重建链接：' + r.src + ' → ' + r.dst + '（' + r.kind + '）');
        out.push('  说明：只建链接，未改动任何文件。');
        return { text: out.join(NL) };
      }

      if (action === 'move-cleanup') {
        if (args.confirm !== true) throw new Error('move-cleanup 需要 confirm=true（会真删旧副本目录）');
        const r = await cleanupOld({ confirm: true });
        out.push(r.note);
        for (const p of r.removed) out.push('  已删 ' + p);
        if (r.bytes) out.push('  释放 ' + gb(r.bytes));
        return { text: out.join(NL) };
      }

      throw new Error('action 只能是 list / create / delete / move-probe / move / move-switch / move-status / move-retarget / move-repair / move-cleanup');
    },
  };
}
