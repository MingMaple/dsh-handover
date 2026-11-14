/** ho_sessions —— 会话清点；action 分流：role 设置角色、new 建会话、prompt 出提示词、archive/unarchive 归档。 */
import { textOutput } from '../lib/output.mjs';
import { nameOf } from '../lib/names.mjs';
import { NL } from '../lib/text.mjs';
import { scanSessions } from '../lib/sessions.mjs';
import { syncCheck } from '../lib/gates.mjs';
import { stamp } from '../lib/brief.mjs';
import { sessionNew, sessionPrompt, sessionArchive, sessionUnarchive, sessionOrder, sessionPlace } from '../lib/session-ops.mjs';
import { createGlobalTask } from '../lib/global-task.mjs';
import { readRoles, resolveRole, ROLE_LABEL, sessionMeta } from '../lib/role.mjs';
import { watermark } from '../lib/facts.mjs';

function list(env, args, exec) {
  const warn = typeof args.warn === "number" ? args.warn : watermark(env.cfg).remindValue;
  const limit = typeof args.limit === "number" ? args.limit : 40;
  const scan = scanSessions({
    dir: env.cacheDir(),
    meId: env.selfId(exec),
    meCwd: env.selfCwd(exec),
    warn,
    silentHours: env.cfg.sessionScanHours,
    projectsOnly: args.include_subagents !== true,
  });
  const store = readRoles(env.cfg);
  const roleOf = (r) => {
    const meta = sessionMeta(r.sid);
    return resolveRole({ cfg: env.cfg, roles: store, sessionId: r.sid, cwd: meta.cwd, firstPrompt: meta.firstPrompt, subagent: meta.subagent, title: r.project });
  };
  const out = [];
  out.push("活跃 / 沉默线：最后活动 " + stamp(scan.cutoffMs) + " 之后算活跃（" + scan.silentHours + " 小时；Charter 7.2.3）");
  for (const r of scan.rows.slice(0, limit)) {
    const pct = r.pct === null ? "水位 ?" : "水位 " + r.pct.toFixed(1) + "%";
    const lab = r.mtime >= scan.cutoffMs ? "活跃" : "沉默";
    const flag = r.pct !== null && r.pct >= warn ? "  【进预警区】" : "";
    const info = roleOf(r);
    out.push(r.kind + " " + r.sid + "  " + r.project + "  " + pct + "  " + r.state + "  角色 " + (ROLE_LABEL[info.role] || info.role) + "  最后活动 " + stamp(r.mtime) + "  【" + lab + "】" + flag);
  }
  const notifProjects = new Set(scan.notify.map((r) => r.project));
  const skipProjects = new Set(scan.skip.map((r) => r.project));
  out.push("通知判定：活跃项目 " + notifProjects.size + " 个，需要通知 " + scan.notify.length + " 个会话（仅各项目在任）/ 沉默项目 " + skipProjects.size + " 个，跳过 " + scan.skip.length + " 个会话（沉默项目全部＋已交出的旧会话）");
  for (const r of scan.notify) out.push("  要通知【在任】" + r.project + "(" + r.sid + ")  最后活动 " + stamp(r.mtime));
  if (scan.skip.length) out.push("  跳过（沉默项目，含其已交出的旧会话）：" + scan.skip.map((x) => x.project + "(" + x.sid.slice(-8) + ")").join("、"));
  const gate = syncCheck(env.resolveWs(exec));
  if (gate.error) out.push("通用约束条闸门（Charter §7.2.3）：读不到 §8.1.1.4 正文 —— 请人工核 " + gate.path);
  else if (!gate.ok) {
    const bad = gate.libraries.filter((l) => !l.ok).map((l) => l.name + "(缺 " + l.missing.length + " 行)");
    out.push("通用约束条闸门（Charter §7.2.3「闸门」）：**未过** —— " + bad.join("、"));
    out.push("判定：通用约束条有库缺，交接前必须补齐（Charter §7.2.3 闸门）");
    return out.join(NL);
  } else out.push("通用约束条闸门（Charter §7.2.3「闸门」）：" + gate.total + "/" + gate.total + " 已落位");
  const verdict = scan.hot.length
    ? "判定：" + scan.hot.length + " 个会话已进预警区（>=" + warn + "%），按 Charter 7.2.3 先收齐交接再换会话"
    : scan.unknown.length
      ? "判定：" + scan.unknown.length + " 个会话水位无法读取，需人工判断"
      : "判定：没有会话进入预警区（>=" + warn + "%），可以继续";
  out.push(verdict);
  return out.join(NL);
}

export function pmSessionsTool(env) {
  return {
    name: nameOf('sessions'),
    description: '会话清点与调度；action=role 设置角色、new 建会话（可用 from_task 把全局任务独立）、task-init 建全局任务库、order 下指令、place 移入工作区、prompt 出提示词、archive/unarchive 归档。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'role', 'new', 'task-init', 'order', 'place', 'prompt', 'archive', 'unarchive'], description: '缺省 list' },
        order: { type: 'string', enum: ['handover', 'compact'], description: 'order 的动作：handover 让它写交接再换任；compact 给它排压缩（先要有合格交接）' },
        resume: { type: 'string', enum: ['continue', 'wait'], description: 'order=compact 时的去向：缺省 wait（交接后收尾，压缩后不唤醒）；continue 表示压缩后按交接继续' },
        include_subagents: { type: 'boolean', description: 'list 时含子会话' },
        limit: { type: 'number', description: 'list 行数（默认 40）' },
        warn: { type: 'number', description: 'list 预警阈值（默认 ' + watermark(env.cfg).remind + '）' },
        session_id: { type: 'string', description: 'role/order/place/archive/unarchive 的目标会话' },
        role: { type: 'string', enum: ['global', 'project', 'misc', 'plain'], description: 'role 要设成的角色；new 时也据此登记接任者角色' },
        project: { type: 'string', description: '项目名（role=project 必填；new 时为换任项目）' },
        migrate: { type: 'string', enum: ['auto', 'direct'], description: 'role 时项目与杂项互转的方式：auto（缺省）先快照再移动；direct 直接建新体系' },
        from_task: { type: 'string', description: 'new 时把某个全局任务整体独立为项目或杂项会话（沿用现有体系，不重建、不重新注册）' },
        task: { type: 'string', description: '任务名（task-init 必填；role=misc 必填；new 时为换任项目）' },
        notify: { type: 'boolean', description: 'role 时投整理指令（默认 true，会唤醒它一轮）' },
        title: { type: 'string', description: 'new 的标题；prompt 用于推断代际' },
        workspace: { type: 'string', description: 'new 必填：目标工作区的 id、标题或路径；new 时不给也能按 project 自动匹配同名工作区' },
        cwd: { type: 'string', description: 'new 的工作目录，必须是某个已注册工作区的根（与 workspace 二选一）' },
        message: { type: 'string', description: 'new 的启动提示词；不给则自动生成' },
        force: { type: 'boolean', description: 'new 越过 <' + watermark(env.cfg).remind + ' 复用判据；order=compact 越过 120 秒去抖；archive 允许停掉在跑的' },
        kind: { type: 'string', enum: ['global', 'project', 'misc', 'migration'], description: 'prompt 的类型；new 时用作角色候选' },
        sessionId: { type: 'string', description: 'prompt：新会话自己的 id' },
        globalSessionId: { type: 'string', description: 'prompt：现任全局 id' },
        extra: { type: 'string', description: 'prompt 附加一句；order 时作为「全局附加」拼进指令' },
        confirm: { type: 'boolean', description: 'new、order 需要当前用户明确同意后传 true；否则只报错、不做任何事' },
      },
    },
    output: textOutput(),
    async execute(args, exec) {
      const action = typeof args.action === 'string' && args.action ? args.action : 'list';
      if (action === 'list') return { text: list(env, args, exec) };
      if (action === 'task-init') {
        const info = env.roleOf(exec);
        if (!info || info.role !== 'global') throw new Error('task-init 只对全局会话开放');
        const ws = env.resolveWs(exec);
        const r = createGlobalTask(ws, args.task);
        const out = [];
        out.push('已建立全局任务库：' + r.dir);
        out.push('  新建 ' + r.created.length + ' 个文件' + (r.created.length ? '：' + r.created.join('、') : ''));
        out.push('交接：_Control_Center/tasks/' + String(args.task) + '/Handover.md；用 ho_handover(action=…, task="' + String(args.task) + '") 读写。');
        out.push('体系注册已登记进 _Control_Center/records/systems.md；计划用 ho_docmap(action="plan", task="' + String(args.task) + '", mode="write")。');
        out.push('要独立为项目或杂项会话：ho_sessions(action="new", role="project"|"misc", from_task="' + String(args.task) + '", …)（须用户确认）。');
        return { text: out.join(NL) };
      }
      if (action === 'new') return { text: await sessionNew(env, args, exec) };
      if (action === 'order') return { text: await sessionOrder(env, args) };
      if (action === 'place') return { text: await sessionPlace(env, args) };
      if (action === 'prompt') return { text: sessionPrompt(env, args, exec) };
      if (action === 'archive') return { text: await sessionArchive(env, args, exec) };
      if (action === 'unarchive') return { text: await sessionUnarchive(env, args) };
      if (action === 'role') {
        if (typeof env.applyRole !== 'function') throw new Error('宿主侧没有装配 applyRole');
        const r = await env.applyRole({
          sessionId: args.session_id, role: args.role, project: args.project, task: args.task,
          wake: args.notify !== false, migrate: args.migrate,
        });
        const out = [];
        out.push(r.ok ? '已设定角色：' + (ROLE_LABEL[r.role] || r.role) : '设定失败：' + r.error);
        if (r.ok) {
          out.push('  存活会话当场生效：' + (r.live ? '是（工具集与提示段已换）' : '否（下次开轮时生效）'));
          if (r.migrated) out.push('  身份互转：' + r.migrated + ' —— ' + r.migrationSummary);
          out.push('  首轮指令：' + (r.delivered ? '已投递（会唤醒它一轮）' : (r.error ? '投递失败：' + r.error : '未投递')));
          out.push('  注册名：' + (r.registeredName || '尚未注册（由该会话首轮与用户确认后用 ho_office action="register" 注册）'));
        }
        return { text: out.join(NL) };
      }
      throw new Error('未知 action：' + action);
    },
  };
}