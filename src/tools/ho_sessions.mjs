/** ho_sessions —— 会话调度与在任登记：list 清点、role 设角色、new 建会话、prompt 出提示词、archive/unarchive 归档；office.read/register 管在任；succeed 换任。 */
import { textOutput } from '../lib/output.mjs';
import { nameOf } from '../lib/names.mjs';
import { NL } from '../lib/text.mjs';
import { scanSessions } from '../lib/sessions.mjs';
import { syncCheck } from '../lib/gates.mjs';
import { stamp } from '../lib/brief.mjs';
import { signalOf } from '../lib/abort.mjs';
import { sessionNew, sessionPrompt, sessionArchive, sessionUnarchive, sessionOrder, sessionPlace } from '../lib/session-ops.mjs';
import { createGlobalTask } from '../lib/global-task.mjs';
import { readRoles, resolveRole, ROLE_LABEL, sessionMeta } from '../lib/role.mjs';
import { pmOfficeTool } from './office.mjs';
import { pmSucceedTool } from './succeed.mjs';

export const ACTIONS = ['list', 'role', 'new', 'task-init', 'order', 'place', 'prompt', 'archive', 'unarchive', 'office-read', 'office-register', 'succeed'];

function list(env, args, exec) {
  const limit = typeof args.limit === "number" ? args.limit : 40;
  const scan = scanSessions({
    dir: env.cacheDir(),
    meId: env.selfId(exec),
    meCwd: env.selfCwd(exec),
    cfg: env.cfg,
    silentHours: env.cfg.sessionScanHours,
    projectsOnly: args.include_subagents !== true,
  });
  const store = readRoles(env.cfg);
  const roleOf = (r) => {
    const meta = sessionMeta(r.sid);
    return resolveRole({ cfg: env.cfg, roles: store, sessionId: r.sid, cwd: meta.cwd, firstPrompt: meta.firstPrompt, subagent: meta.subagent, title: r.project });
  };
  const out = [];
  out.push("活跃与沉默线：最后活动晚于 " + stamp(scan.cutoffMs) + " 记为活跃（" + scan.silentHours + " 小时；Charter 7.2.3）");
  for (const r of scan.rows.slice(0, limit)) {
    const pct = r.pct === null ? "水位 ?" : "水位 " + r.pct.toFixed(1) + "%";
    const lab = r.mtime >= scan.cutoffMs ? "活跃" : "沉默";
    const flag = scan.hot.includes(r.sid) ? "  【进入预警区】" : "";
    const info = roleOf(r);
    out.push(r.kind + " " + r.sid + "  " + r.project + "  " + pct + "  " + r.state + "  角色 " + (ROLE_LABEL[info.role] || info.role) + "  最后活动 " + stamp(r.mtime) + "  【" + lab + "】" + flag);
  }
  const notifProjects = new Set(scan.notify.map((r) => r.project));
  const skipProjects = new Set(scan.skip.map((r) => r.project));
  out.push("通知判定：活跃项目 " + notifProjects.size + " 个，需要通知 " + scan.notify.length + " 个会话（仅各项目在任）。沉默项目 " + skipProjects.size + " 个，跳过 " + scan.skip.length + " 个会话（沉默项目全部与已交出的旧会话）。");
  for (const r of scan.notify) out.push("  要通知【在任】" + r.project + "(" + r.sid + ")  最后活动 " + stamp(r.mtime));
  if (scan.skip.length) out.push("  跳过（沉默项目，含其已交出的旧会话）：" + scan.skip.map((x) => x.project + "(" + x.sid.slice(-8) + ")").join("、"));
  const gate = syncCheck(env.resolveWs(exec));
  if (gate.error) out.push("通用约束条闸门（Charter §7.2.3）：读不到 §8.1.1.4 正文。处置：人工核对 `" + gate.path + "`。");
  else if (!gate.ok) {
    const bad = gate.libraries.filter((l) => !l.ok).map((l) => l.name + "（缺 " + l.missing.length + " 行）");
    out.push("通用约束条闸门（Charter §7.2.3「闸门」）：未通过。" + bad.join("、"));
    out.push("判定：通用约束条有库缺，交接前必须补齐（Charter §7.2.3 闸门）");
    return out.join(NL);
  } else out.push("通用约束条闸门（Charter §7.2.3「闸门」）：" + gate.total + "/" + gate.total + " 已落位");
  const verdict = scan.hot.length
    ? "判定：" + scan.hot.length + " 个会话已过整理线（soft）。处置：按 Charter 7.2.3 先收齐交接，再换会话。"
    : scan.unknown.length
      ? "判定：" + scan.unknown.length + " 个会话水位无法读取，需人工判断。"
      : "判定：没有会话进入预警区（未过整理线），可以继续。";
  out.push(verdict);
  return out.join(NL);
}

/**
 * 构造 `sessions` 工具定义。
 *
 * 调度动作只对全局会话开放，项目与杂项会话只保留 `succeed`，避免越权。
 *
 * @param {object} env 插件环境，提供 `resolveWs`、`roleOf`、`selfId`、`applyRole` 与 `controller`。
 * @returns {object} 工具定义，供宿主注册。
 * 副作用：设角色、建会话、投提示词与归档会话。
 */
export function pmSessionsTool(env) {
  const office = pmOfficeTool(env);
  const succeed = pmSucceedTool(env);
  return {
    name: nameOf('sessions'),
    description: '会话清点与调度；项目与杂项只用 succeed。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ACTIONS, description: '动作，缺省 `list`。各动作所需参数见下。' },
        order: { type: 'string', enum: ['handover', 'compact'], description: '`order` 投递给目标会话的指令：`handover` 要求写交接，`compact` 要求压缩。' },
        include_subagents: { type: 'boolean', description: '`list` 是否连子会话一并列出。缺省 `false`，只列平级会话。' },
        limit: { type: 'number', description: '`list` 最多返回的行数，缺省 40。例：`20`。' },
        session_id: { type: 'string', description: '目标会话 id，取自 `list` 输出的会话号。例：`session-3f2a9c`。' },
        role: { type: 'string', enum: ['global', 'project', 'misc', 'plain'], description: '`role` 设定的新角色。选 `project` 时须同时给 `project`。' },
        project: { type: 'string', description: '`role`、`prompt` 的项目名，角色为 `project` 时必填。例：`Demo`。' },
        migrate: { type: 'string', enum: ['auto', 'direct'], description: '身份互转方式：`auto` 自动判断，`direct` 直接转换。缺省 `auto`。' },
        from_task: { type: 'string', description: '`new` 的来源任务名，由全局任务派生会话时填。例：`巡检`。' },
        task: { type: 'string', description: '任务名。`task-init` 必填；`role` 用于指定杂项任务。例：`巡检`。' },
        notify: { type: 'boolean', description: '`role` 是否唤醒目标会话一轮。缺省 `true`。' },
        title: { type: 'string', description: '`new`、`prompt` 的新会话标题，同时作为注册名。例：`Demo 2`。' },
        workspace: { type: 'string', description: '`new`、`place` 的目标工作区，可传 id、标题或路径。例：`_Workspace`。' },
        cwd: { type: 'string', description: '`new` 的工作目录绝对路径，与 `workspace` 二选一。' },
        message: { type: 'string', description: '`new` 投递给新会话的首条消息正文，可省略。' },
        force: { type: 'boolean', description: '`succeed` 在水位未到线时仍执行换任。缺省 `false`。' },
        kind: { type: 'string', enum: ['global', 'project', 'misc', 'migration'], description: '`prompt` 的模板类型，决定提示词口径。例：`project`。' },
        sessionId: { type: 'string', description: '`prompt` 填进模板的本会话 id，缺省留占位符。' },
        globalSessionId: { type: 'string', description: '`prompt` 填进模板的全局会话 id，缺省留占位符。' },
        extra: { type: 'string', description: '`order`、`prompt` 附加给目标会话的指令正文，可省略。' },
        confirm: { type: 'boolean', description: '`new`、`order` 须传 `true`，表示当前用户已确认。缺省视为未确认。' },
        name: { type: 'string', description: '`office-register` 的注册显示名，1 至 40 个字符。例：`Demo1`。' },
        query: { type: 'string', description: '`office-read` 要查的名称，多个用空格分隔。例：`全局 Demo1`。' },
        json: { type: 'boolean', description: '`office-read` 为 `true` 时输出 JSON，供脚本解析。' },
        note: { type: 'string', description: '`succeed` 写入在任登记的备注，可省略。' },
      },
    },
    output: textOutput(),
    async execute(args, exec) {
      const action = typeof args.action === 'string' && args.action ? args.action : 'list';
      if (ACTIONS.indexOf(action) === -1) throw new Error('现象：`action` 取值不在允许范围。原因：收到 `' + action + '`。处置：改用 ' + ACTIONS.join('、') + ' 之一后重试。');
      let info = null;
      try { info = env.roleOf(exec); } catch { info = null; }
      const role = info && info.role ? info.role : '';
      if ((role === 'project' || role === 'misc') && action !== 'succeed') {
        throw new Error('现象：当前会话不能执行 `' + action + '`。原因：该动作只对全局会话开放；项目与杂项会话仅可用 `succeed`。处置：改由全局会话执行。');
      }
      if (action === 'office-read') return office.execute({ action: 'read', query: args.query, json: args.json }, exec);
      if (action === 'office-register') {
        if (!String(args.name || '').trim()) throw new Error('现象：`office-register` 缺少 `name`。原因：注册须给出显示名。处置：传入 1 至 40 个字符的注册名后重试。');
        return office.execute({ action: 'register', name: args.name }, exec);
      }
      if (action === 'succeed') return succeed.execute({ note: args.note, force: args.force }, exec);
      if (action === 'task-init' && !String(args.task || '').trim()) throw new Error('现象：`task-init` 缺少 `task`。原因：建立全局任务库须给出任务名。处置：传入 `task` 后重试。');
      if (action === 'role' && (!String(args.session_id || '').trim() || !String(args.role || '').trim())) throw new Error('现象：role 缺少 session_id 或 role。原因：设定角色须指明目标会话与新角色。处置：补齐后重试。');
      if (['order', 'place', 'archive', 'unarchive'].indexOf(action) !== -1 && !String(args.session_id || '').trim()) throw new Error('现象：' + action + ' 需要 session_id。原因：该动作须指明目标会话。处置：补齐 `session_id` 后重试。');
      if (action === 'list') return { text: list(env, args, exec) };
      if (action === 'task-init') {
        const info = env.roleOf(exec);
        if (!info || info.role !== 'global') throw new Error('现象：当前会话不能执行 `task-init`。原因：该动作只对全局会话开放。处置：改由全局会话执行。');
        const ws = env.resolveWs(exec);
        const r = createGlobalTask(ws, args.task);
        const out = [];
        out.push('已建立全局任务库：`' + r.dir + '`');
        out.push('  新建 ' + r.created.length + ' 个文件' + (r.created.length ? '：' + r.created.join('、') : ''));
        out.push('交接：`_Control_Center/tasks/' + String(args.task) + '/Handover.md`；用 `ho_handover(action=…, task="' + String(args.task) + '")` 读写。');
        out.push('体系注册已登记进 `_Control_Center/records/systems.md`；计划用 `ho_docmap(action="plan-write", task="' + String(args.task) + '")`。');
        out.push('独立为项目或杂项会话：`ho_sessions(action="new", role="project"|"misc", from_task="' + String(args.task) + '", …)`，须当前用户确认。');
        return { text: out.join(NL) };
      }
      if (action === 'new') return { text: await sessionNew(env, args, exec, signalOf(exec)) };
      if (action === 'order') return { text: await sessionOrder(env, args, signalOf(exec)) };
      if (action === 'place') return { text: await sessionPlace(env, args) };
      if (action === 'prompt') return { text: sessionPrompt(env, args, exec) };
      if (action === 'archive') return { text: await sessionArchive(env, args, exec) };
      if (action === 'unarchive') return { text: await sessionUnarchive(env, args) };
      if (action === 'role') {
        if (typeof env.applyRole !== 'function') throw new Error('现象：无法设定角色。原因：宿主侧没有装配 `applyRole`。处置：确认 DSH 版本与插件装配后重启。');
        const r = await env.applyRole({
          sessionId: args.session_id, role: args.role, project: args.project, task: args.task,
          wake: args.notify !== false, migrate: args.migrate,
        });
        const out = [];
        out.push(r.ok ? '已设定角色：' + (ROLE_LABEL[r.role] || r.role) : '现象：角色设定失败。原因：' + r.error + '。处置：核对会话 id 与角色参数后重试。');
        if (r.ok) {
          out.push('  存活会话当场生效：' + (r.live ? '是（工具集与提示段已更换）' : '否（下次开轮时生效）'));
          if (r.migrated) out.push('  身份互转：' + r.migrated + '。' + r.migrationSummary);
          out.push('  首轮指令：' + (r.delivered ? '已投递，将唤醒该会话一轮' : (r.error ? '投递失败。原因：' + r.error + '。' : '未投递')));
          out.push('  注册名：' + (r.registeredName || '尚未注册。处置：由该会话首轮与当前用户确认后，执行 `ho_sessions(action="office-register")`。'));
        }
        return { text: out.join(NL) };
      }
      throw new Error('现象：`action` 取值未知：`' + action + '`。原因：该取值不在允许清单内。处置：改用 ' + ACTIONS.join('、') + ' 之一。');
    },
  };
}