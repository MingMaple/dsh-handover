/**
 * 会话管理的实现（原 ho_session_new / ho_prompt / ho_session_archive / ho_session_unarchive 的代码搬到这里）。
 * 对外只经 ho_sessions(action=…) 暴露，少 4 份 schema 的固定开销。
 */
import os from 'node:os';
import path from 'node:path';
import { NL, readUtf8, isDir, isFile } from './text.mjs';
import { handoverPathFor, assertProjectName, assertTaskName } from './role.mjs';
import { readHandover } from './handover-io.mjs';
import { workspaceRows } from './registry.mjs';
import { checkConsent } from './consent.mjs';
import { watermark } from './facts.mjs';
import { sendPrompt } from './prompt.mjs';
import { newSessionIn } from './session-create.mjs';
import { lineageKeyOf, loadOffice, registerHolder } from './office.mjs';
import { migrateIdentity } from './identity.mjs';

const FENCE = String.fromCharCode(96, 96, 96);

function normPath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** 在 ~/.dsh/storages/workspace.json 里按 id、标题、路径找 workspaceId。 */
function findWorkspaceId(key) {
  const file = path.join(os.homedir(), '.dsh', 'storages', 'workspace.json');
  const data = JSON.parse(readUtf8(file));
  const tables = (data && data.tables && data.tables.workspaces) || {};
  const want = normPath(key);
  for (const id of Object.keys(tables)) {
    const w = tables[id] || {};
    if (id === key) return id;
    if (w.title === key) return id;
    if (normPath(w.path) === want) return id;
  }
  return null;
}

/**
 * 新建会话落哪个工作区：用户指定的 workspace／cwd 优先，项目按标题或路径自动匹配，全局落到当前工作区。
 * 返回 workspaceId；找不到时抛出可直接展示的中文错误，并列出已注册的工作区。
 * @param {object} env 插件环境
 * @param {object} exec 工具执行上下文（用来取当前工作区根）
 * @param {string} kind 角色：global、project、misc
 * @param {string} project 项目名
 * @param {string} task 任务名
 * @param {object} [opts] { workspace, cwd, wantGlobal }：前两项是用户明确指定的落点
 * @returns {string} workspaceId
 */
export function resolveWorkspaceFor(env, exec, kind, project, task, opts) {
  const o = opts || {};
  const ws = env.resolveWs(exec);
  const rows = listWorkspaces(env);
  const choices = rows.length
    ? rows.map((r) => '  ' + r.id + '  ' + (r.title || '-') + '  ' + (r.path || '-')).join(NL)
    : '  （还没有注册任何工作区）';
  const pickWorkspace = (key) => {
    const wid = findWorkspaceId(key);
    if (!wid) {
      throw new Error('找不到工作区：' + key + NL + '已注册的工作区：' + NL + choices + NL + '传 id、标题或路径都行；要先建工作区，用 ho_workspace(action="create", path="<目录>")。');
    }
    return wid;
  };
  const wantGlobalWs = o.wantGlobal === true || kind === 'global';
  if (o.workspace) return pickWorkspace(o.workspace);
  if (o.cwd) {
    if (!isDir(o.cwd)) throw new Error('cwd 不存在：' + o.cwd);
    // cwd 若正好是已注册工作区的根，必须按 workspaceId 建；否则会话会落进「未分组」。
    let wid = null;
    try { wid = findWorkspaceId(o.cwd); } catch { wid = null; }
    if (!wid) {
      throw new Error('cwd 不在任何已注册工作区里：' + o.cwd + NL + '已注册的工作区：' + NL + choices
        + NL + '要么把 cwd 换成某个工作区的根，要么先注册它：ho_workspace(action="create", path="' + o.cwd + '")。');
    }
    return wid;
  }
  if (project) {
    // 项目会话：按项目名找同名工作区，或路径落在 Projects/<项目>、_Project_Meta/<项目> 下的工作区。
    const want = String(project).toLowerCase();
    const hit = rows.find((r) => {
      if (String(r.title || '') === String(project)) return true;
      const p = normPath(r.path);
      return p.indexOf('/projects/' + want) !== -1 || p.indexOf('/_project_meta/' + want) !== -1;
    });
    if (!hit) {
      throw new Error('项目「' + project + '」还没有对应的工作区。' + NL + '已注册的工作区：' + NL + choices
        + NL + '做法一：ho_workspace(action="create", path="<该项目目录>", title="' + project + '") 后再建会话；'
        + NL + '做法二：把 workspace 传成上面某个工作区。');
    }
    return String(hit.id);
  }
  if (wantGlobalWs) return pickWorkspace(ws);
  throw new Error('新建会话必须指明工作区：传 workspace（id、标题或路径），或 cwd（某个已注册工作区的根）。' + NL
    + '已注册的工作区：' + NL + choices + NL
    + '全局会话落在标题含「全局」的工作区；项目会话同时传 project 与该项目的工作区；杂项会话传该项目外的独立工作区。');
}

/**
 * 某个目录是不是已注册工作区的根：是则返回 workspaceId，否则返回空串（不抛错）。
 * 换任时用来让接任者落回本会话所在的那个工作区，而不是工作区根。
 */
export function workspaceIdOfPath(env, p) {
  const want = normPath(p);
  if (!want || want === '-') return '';
  const hit = listWorkspaces(env).find((r) => {
    const rp = normPath(String(r.path || ''));
    return rp && rp !== '-' && rp === want;
  });
  return hit ? String(hit.id || '') : '';
}

/** workspaceId 对应的根路径；查不到返回空串（登记表的工作区一栏用它写成实际落点）。 */
export function workspacePathOf(env, id) {
  const key = String(id || '');
  if (!key) return '';
  const hit = listWorkspaces(env).find((r) => String(r.id || '') === key);
  return hit && hit.path ? String(hit.path) : '';
}

/** 已注册工作区清单（插件服务优先，退化读 workspace.json）：新建会话时用来列出可选项。 */
function listWorkspaces(env) {
  try {
    const reg = env && typeof env.registry === 'function' ? env.registry() : null;
    const list = reg && typeof reg.list === 'function' ? (reg.list() || []) : [];
    if (list.length) {
      return list.map((w) => ({ id: String((w && w.id) || ''), title: String((w && w.title) || ''), path: String((w && w.path) || '') }));
    }
  } catch { /* 退回读文件 */ }
  try {
    return workspaceRows().map((r) => ({ id: r.id, title: r.title, path: r.path }));
  } catch { return []; }
}


/** 取某个 ## 小节之后第一个代码块的内容（找不到返回 null）。 */
function blockAfter(text, heading) {
  const lines = text.split(NL);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].indexOf('## ') === 0 && lines[i].indexOf(heading) !== -1) { start = i; break; }
  }
  if (start === -1) return null;
  let opened = false;
  const buf = [];
  for (let i = start + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!opened && lines[i].indexOf('## ') === 0) break;
    if (t === FENCE + 'text' || t === FENCE) {
      if (!opened) { opened = true; continue; }
      return buf.join(NL);
    }
    if (opened) buf.push(lines[i]);
  }
  return null;
}

function fill(tpl, map) {
  let t = tpl;
  for (const k of Object.keys(map)) t = t.split(k).join(String(map[k]));
  return t;
}

// ---------------------------------------------------------------- action: new

/**
 * 复用判据：同一类别已有在任会话且其水位低于提醒线时，返回中文拒绝理由；否则返回空串。
 * 只读在任登记表与水位缓存，不写任何文件；取不到水位就放行。
 */
function reuseBlocker(env, ws, kind, key) {
  if (env.cfg.reuseCheck === false) return '';
  if (!ws || !kind || !key) return '';
  const lin = loadOffice(ws).lineages[key];
  const cur = lin && lin.current;
  if (!cur || !cur.sessionId) return '';
  let pct = null;
  try { pct = typeof env.selfPct === 'function' ? env.selfPct(cur.sessionId) : null; } catch { pct = null; }
  if (pct === null || pct === undefined || !(Number(pct) < watermark(env.cfg).reuseValue)) return '';
  const label = kind === 'global' ? '全局类别' : kind === 'project' ? '项目「' + key + '」' : '杂项任务「' + key + '」';
  return '拒绝新建：' + label + '已有在任会话 ' + (cur.name || '（未命名）') + '（' + cur.sessionId + '）水位 '
    + Number(pct).toFixed(1) + '%，低于 ' + watermark(env.cfg).handover + '；建议用 peer（action="send"）复用，确需另建请传 force=true。';
}

export async function sessionNew(env, args, exec) {
  const ws = env.resolveWs(exec);
  const controller = env.controller();
  // 换任（新建接班会话）先问用户。
  if (args.confirm !== true) throw new Error('新建会话（换任）需要当前用户确认：先向当前用户说明要建接班会话并得到同意，再传 confirm=true');
  if (!controller) throw new Error('ctx.sessionController 不可用');
  // 名字要落成目录：先校验，别等会话建完、写角色表时才失败（那样会留下一个没有角色的会话）。
  if (args.project) assertProjectName(String(args.project));
  if (args.task) assertTaskName(String(args.task));
  const out = [];
  const title = String(args.title || '');
  // 角色先算好：新建会话按它做在任判据、登记并当场装配。
  let role = args.role || (args.project ? 'project' : args.kind || '');
  if (role === 'session') role = '';
  const project = args.project || '';
  const task = args.task || '';
  const finalRole = title.indexOf('全局') !== -1 ? 'global'
    : (role === 'project' || role === 'misc' ? role : (project ? 'project' : ''));
  const officeKind = finalRole === 'project' || finalRole === 'misc' || finalRole === 'global' ? finalRole : '';

  // 建会话之前先读在任登记表：同类已有低水位在任会话时，复用比新建更省。校验在一切写入之前。
  if (args.force !== true && officeKind) {
    const block = reuseBlocker(env, ws, officeKind, lineageKeyOf(officeKind, project, task));
    if (block) throw new Error(block);
  }

  // 全局任务整体独立：先把任务库移入项目或杂项位置，沿用现有体系，不重建、不重新注册。
  let migrated = null;
  if (args.from_task) {
    let caller = null;
    try { caller = env.roleOf(exec); } catch { caller = null; }
    if (!caller || caller.role !== 'global') throw new Error('from_task 只对全局会话开放');
    const oldTask = String(args.from_task).trim();
    assertTaskName(oldTask);
    if (finalRole !== 'project' && finalRole !== 'misc') throw new Error('from_task 须同时给 role=project 或 role=misc');
    migrated = migrateIdentity({
      ws,
      prev: { role: 'global-task', task: oldTask },
      next: { role: finalRole, project, task },
      mode: 'auto',
    });
    out.push('全局任务已独立：' + migrated.summary);
  }

  // ---- 工作区解析：新建会话必须落到明确的工作区，不允许静默落进调用者所在的工作区。
  const workspaceId = resolveWorkspaceFor(env, exec, finalRole, project, task, {
    workspace: args.workspace,
    cwd: args.cwd,
    wantGlobal: title.indexOf('全局') !== -1 || args.role === 'global' || args.kind === 'global',
  });

  const made = await newSessionIn(env, { workspaceId, title, role: finalRole, project, task });
  const sessionId = made.sessionId || '';
  if (!sessionId) throw new Error(made.error || 'create 没有返回 sessionId');
  out.push('已建会话 ' + sessionId + (finalRole ? '，角色 ' + finalRole + (project ? '（' + project + '）' : '') : ''));
  // 建会话即登记在任：全局手工建/换会话与自服务换任共用一张登记表，不让注册表漏记或与实况分叉。
  try {
    if (officeKind) {
      // 工作区一栏写**实际落点**（用户指定的那个工作区），不是调用者自己所在的工作区根。
      const reg = registerHolder(ws, {
        kind: officeKind, project, task, name: title, sessionId,
        workspace: workspacePathOf(env, workspaceId) || ws,
      });
      out.push('在任登记：' + reg.key + ' → ' + title + (reg.previous ? '（原 ' + reg.previous.name + ' 进历史）' : ''));
    }
  } catch (e) {
    out.push('在任登记失败：' + String(e && e.message ? e.message : e) + '（不影响会话本身）');
  }
  const meId = env.selfId(exec) || '（未知）';
  // 交接路径按**新会话自身的角色**取用：项目读项目交接、杂项读任务交接，都不退回全局交接。
  // cfg.handoverPath 是「强制全局交接路径」的演练开关，只对全局角色生效。
  const hp = handoverPathFor(ws, finalRole === 'project' && project ? { role: 'project', project }
    : finalRole === 'misc' && task ? { role: 'misc', task } : { role: 'global' });
  const handover = (finalRole === 'global' ? env.cfg.handoverPath : '') || hp.path
    || (finalRole === 'misc' ? path.join(ws, '_Control_Center', 'rules', 'Misc_Task_Standard.md') : '');
  const text = args.message || [
    '先读交接：' + handover + '。',
    '读毕先向当前用户报告，不得自行开展作业：一、当前停在哪一步；二、交接列有哪些待办；三、建议先做哪一条。待当前用户指派后再动手。交接无待办时如实说明，不得编造任务。',
    '本会话 id：' + sessionId,
    (finalRole === 'project' ? '全局会话 id：' : '创建者会话 id：') + meId,
    '默认沉默：仅在三种时机各发一条 peer（action="send"）给全局：水位不低于 ' + watermark(env.cfg).remind + ' 且已写交接、需当前用户决定、全局口径有误。任务完成不报全局，任务属本会话内部事务。会话间可直接 peer（action="send"），不必经全局转述；不得每轮回执，不得发送「收到」「已完成」一类确认，全局以文件末态为准。',
  ].join(NL);
  const r = await sendPrompt(env.controller(), sessionId, text, 'queue');
  out.push('已投启动提示词 accepted=' + String(r && r.accepted) + '（' + text.length + ' 字）');
  return out.join(NL);
}

// ---------------------------------------------------------------- action: prompt

/**
 * 生成某角色会话的启动提示词：工作区没有模板就退回插件自带那份（dist/templates/Prompt_Templates.md）。
 * @param {object} env 插件环境
 * @param {object} opts { ws, kind, project, task, title, sessionId, globalSessionId, extra }
 * @returns {string} 可直接投递的提示词正文
 */
export function promptFor(env, opts) {
  const o = opts || {};
  const ws = String(o.ws || env.resolveWs());
  const file = path.join(ws, '_Control_Center', 'templates', 'Prompt_Templates.md');
  // 工作区没有模板就退回插件自带那份（dist/templates/Prompt_Templates.md），功能不打折。
  let tpl = '';
  let fromBundle = false;
  try {
    if (!isFile(file)) throw new Error('missing');
    tpl = readUtf8(file);
  } catch {
    tpl = readUtf8(new URL('../templates/Prompt_Templates.md', import.meta.url));
    fromBundle = true;
  }
  if (fromBundle) {
    tpl = '> （插件内置模板；本地覆盖写入 ' + file + '）' + NL + NL + tpl;
  }
  const skeleton = blockAfter(tpl, '1 共用骨架');
  if (!skeleton) throw new Error('模板缺 §1 共用骨架，拒绝渲染：' + file);
  const kind = o.kind || 'project';
  const project = o.project || '';
  const task = o.task || '';
  const target = handoverPathFor(ws, kind === 'project'
    ? { role: 'project', project }
    : kind === 'misc' && task ? { role: 'misc', task } : { role: 'global' });
  const firstPath = kind === 'global'
    ? (env.cfg.handoverPath || target.path)
    : kind === 'project' ? target.path
      : kind === 'misc' ? (target.path || path.join(ws, '_Control_Center', 'rules', 'Misc_Task_Standard.md'))
        : path.join(ws, '_Control_Center', 'rules', 'Migration_Rules.md');
  if (!firstPath) throw new Error('kind=' + kind + ' 需要 project、task 参数才能算交接路径');
  const numMatch = String(o.title || '').match(/([0-9]+)/);
  const ordinal = numMatch ? numMatch[1] : 'N';
  const roleText = kind === 'global'
    ? '第 ' + ordinal + ' 任全局（管理会话）'
    : kind === 'project'
      ? '「' + project + '」项目的执行会话'
      : kind === 'misc' ? '杂项任务会话' : '新机器接手会话';
  const scopeText = kind === 'project'
    ? '库根 Projects/' + project + ' 与 _Project_Meta/' + project
    : '工作区根 ' + ws;
  const filled = fill(skeleton, {
    '<角色>': roleText,
    '<绝对路径>': firstPath,
    '<本会话 id>': o.sessionId || '（建完后填）',
    '<全局 id>': o.globalSessionId || '（现任全局 id）',
    '<范围>': scopeText,
  });
  const stripHint = (l) => {
    let i = l.indexOf('|');
    while (i !== -1) {
      if (l[i + 1] === ' ' || l[i + 1] === String.fromCharCode(0x3000)) return l.slice(0, i).replace(/\s+$/, '');
      i = l.indexOf('|', i + 1);
    }
    return l;
  };
  const body = filled.split(NL).map(stripHint).join(NL);
  const extraLines = [];
  if (kind === 'project' && project) {
    extraLines.push('库根：Projects/' + project + '/；元数据：_Project_Meta/' + project + '/；快照：_Temp/' + project + '/Snapshots/');
    extraLines.push('作业前读库根 SKILL.md；修改文档时另读 _Control_Center/rules/ 对应规范。');
    extraLines.push('进入预警区后写交接；请当前用户在聊天框发送 /allow-succeed 授权，再由本会话调用 ho_succeed 完成换任，不向全局请求。');
  }
  if (kind === 'misc') extraLines.push('标准见 rules/Misc_Task_Standard.md；换任须当前用户授权，再由本会话调用 ho_succeed。');
  if (kind === 'migration') extraLines.push('迁移口径见 rules/Migration_Rules.md；通过顶层闸门后再开始作业。');
  if (o.extra) extraLines.push(String(o.extra));
  return [body].concat(extraLines.length ? ['', ...extraLines] : []).join(NL);
}

/** ho_sessions(action="prompt") 的实现：按调用者角色的工作区生成提示词。 */
export function sessionPrompt(env, args, exec) {
  return promptFor(env, {
    ws: env.resolveWs(exec),
    kind: args.kind,
    project: args.project,
    task: args.task,
    title: args.title,
    sessionId: args.sessionId,
    globalSessionId: args.globalSessionId,
    extra: args.extra,
  });
}

// ---------------------------------------------------------------- action: archive / unarchive

export async function sessionArchive(env, args, exec) {
  const reg = env.registry();
  if (!reg || typeof reg.archiveSession !== 'function') {
    throw new Error('workspaceRegistry.archiveSession 不可用（先跑 ho_status（view=diag） 看服务可见性）');
  }
  const sid = String(args.session_id || '').trim();
  if (!sid) throw new Error('必须给 session_id');
  const me = env.selfId(exec);
  if (me && sid === me) throw new Error('不能归档当前会话（会把自己一起停掉）');
  const out = [];
  try {
    await reg.archiveSession(sid, args.force === true ? { stopActivity: true } : {});
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    if (/active/i.test(msg)) throw new Error('该会话仍在运行：' + msg + '——应先令其停止，或加 force=true（将请求终止其工作）');
    throw new Error('归档失败：' + msg);
  }
  out.push('已归档 ' + sid + (args.force === true ? '（已请求停止其工作）' : ''));
  try {
    const archived = reg.archivedSessionIds;
    if (archived && typeof archived.length === 'number') out.push('归档集合现有 ' + archived.length + ' 个');
  } catch { /* ignore */ }
  out.push('提醒：归档会话会被 archived-session-gate 拦住、无法唤醒；要用它请先 action="unarchive"。');
  return out.join(NL);
}

export async function sessionUnarchive(env, args) {
  const reg = env.registry();
  if (!reg || typeof reg.unarchiveSession !== 'function') {
    throw new Error('workspaceRegistry.unarchiveSession 不可用（先跑 ho_status（view=diag） 看服务可见性）');
  }
  const sid = String(args.session_id || '').trim();
  if (!sid) throw new Error('必须给 session_id');
  try { await reg.unarchiveSession(sid); } catch (e) {
    throw new Error('解归档失败：' + String(e && e.message ? e.message : e));
  }
  return '已解归档 ' + sid + NL + '它回到原工作区位置，可以再次唤醒了。';
}

// ---------------------------------------------------------------- action: order

/** 交接流程的标准指令（全局下给某个会话；路径按它自己的角色解析，不借调用者上下文）。 */
function orderHandoverText(env, sid, extra) {
  const hp = env.handoverForSid(sid);
  const info = env.infoOfSid(sid);
  const lines = [];
  lines.push("【全局指令：执行交接流程】将当前工作写成交接，写毕即停止操作，等待换任。本轮不再进行项目作业。");
  lines.push("");
  lines.push("1) 目标文件：" + (hp && hp.path ? hp.path : "（角色未定，须先由全局设定角色）"));
  lines.push("   直接调用 ho_handover(action=\"write\", text=...)，不要传 path：路径已按你的角色（" + (info && info.role ? info.role : "unknown") + "）解析。");
  lines.push("2) 必写：① 当前进度（版本、产物、是否通过）② 环境与路径（版本号、安装位置、下载源）③ 下一步清单，按顺序列出，每条可直接执行 ④ 已完成待验收、要求未实现的部分 ⑤ 已知问题与已踩的错。");
  lines.push("3) 机密只写位置，不写值：密码、token、密钥均写明所在文件。");
  lines.push("4) 写完只回一条 peer（action=\"send\"）给全局：`交接已写 <绝对路径>`，附一句状态，不复述全文。");
  lines.push("5) 不要压缩上下文，不要新建会话（新建会话属全局权限）。");
  if (extra) lines.push("6) 全局附加：" + extra);
  return lines.join(NL);
}

export async function sessionOrder(env, args) {
  const sid = String(args.session_id || "").trim();
  const order = String(args.order || "").trim();
  if (!sid) throw new Error("order 需要 session_id");
  if (order !== "handover" && order !== "compact") throw new Error("order 只能是 handover 或 compact");
  // 给别的会话下「交接、压缩」指令，也要先问用户。
  if (args.confirm !== true) throw new Error("下交接、压缩指令需要当前用户确认：先说明会唤醒目标会话并让它交接或压缩，得到同意后传 confirm=true");
  const extra = typeof args.extra === "string" ? args.extra.trim() : "";
  const hp = env.handoverForSid(sid);
  const info = env.infoOfSid(sid);
  const out = [];
  out.push("目标 " + sid + " · 角色 " + ((info && info.role) || "unknown") + " · 交接 " + ((hp && hp.path) || "（未解析）"));
  if (!hp || !hp.path) {
    out.push("没有交接路径：先给它设置角色（ho_sessions(action=\"role\")），否则它会退回全局交接。");
    return out.join(NL);
  }
  if (order === "handover") {
    const text = orderHandoverText(env, sid, extra);
    const r = await sendPrompt(env.controller(), sid, text, "queue");
    out.push("已投交接指令 accepted=" + String(r && r.accepted) + "（会唤醒它一轮）");
    out.push("等它回一条 `交接已写 <路径>` 之后，再用 ho_sessions(action=\"new\") 建接任会话。");
    return out.join(NL);
  }
  // order === compact
  const agent = typeof env.agentOfSid === "function" ? env.agentOfSid(sid) : null;
  if (!agent) {
    out.push("拒绝排压缩：目标会话不在内存（已休眠）。先让它开一轮（ho_sessions(action=\"order\", order=\"handover\")）再压。");
    return out.join(NL);
  }
  const st = typeof env.compactionStateOfSid === "function" ? env.compactionStateOfSid(sid) : null;
  if (st && st.lock === "open") {
    out.push("拒绝排压缩：它的日志里有未闭合的压缩锁（compaction/start 无配对 end）。先等它结束后复查。");
    return out.join(NL);
  }
  const cur = readHandover(hp.path);
  if (cur.text === null || String(cur.text).trim() === "") {
    out.push("拒绝排压缩：磁盘上没有合格交接 " + hp.path + "。压缩会丢历史 —— 先 order=handover。");
    return out.join(NL);
  }
  const used = st && typeof st.used === "number" ? st.used : 0;
  const max = (env.cfg && env.cfg.maxCompactions) || 3;
  const n = used + 1;
  if (n > max) {
    out.push("已压满 " + used + "/" + max + "：不再压缩。应执行 ho_succeed 自行换任（先请当前用户发送 /allow-succeed 授权）；全局会话自身也可用 ho_sessions(action=\"new\")。新会话读毕交接会先向你报告，等待指派。");
    return out.join(NL);
  }
  const recentSec = st && st.lastSummaryMs ? (Date.now() - st.lastSummaryMs) / 1000 : null;
  if (recentSec !== null && recentSec < 120 && args.force !== true) {
    out.push("拒绝排压缩：" + Math.round(recentSec) + " 秒前它刚压过一次。要再压加 force=true。");
    return out.join(NL);
  }
  // 严格闸门：代排也要用户点过授权，AI 不能自行批准。
  const cs = checkConsent(sid);
  if (!cs.ok) {
    out.push("拒绝排压缩：" + cs.reason + "。");
    out.push("请当前用户到设置页的 dsh-handover 中，点击「授权」里的「授权压缩」（5 分钟内有效），再重下这条指令。");
    return out.join(NL);
  }
  const resume = args.resume === "continue" ? "continue" : "wait";
  env.schedule(sid, n, { resume });
  out.push("当前用户已授权（" + (cs.atText || '') + " 点击，剩 " + Math.round((cs.leftMs || 0) / 1000) + " 秒）。");
  out.push("已登记压缩（它自己第 " + n + "/" + max + " 次）：等它空闲后执行。");
  if (resume === "wait") {
    out.push("去向：wait（缺省）—— 压缩后不再唤醒它，等当前用户派新任务，或由新会话接手。");
  } else {
    out.push("去向：continue —— 压缩后它会自动收到**它自己的**续跑消息（带它自己的交接路径）。");
  }
  out.push("压缩走的是插件调度器（compactNow 只允许空闲时执行），不是给它发消息让它自己压。");
  out.push("若它正在跑，调度器会等它空闲（上限 " + Math.round(((env.cfg && env.cfg.waitIdleMs) || 180000) / 1000) + " 秒）。");
  return out.join(NL);
}

// ---------------------------------------------------------------- action: place

/** 把已存在的会话移进某个工作区（等价图形界面的「移动到工作区」）。
 *  前提：会话 header 里的 cwd 必须正是该工作区根，工作区服务会自己校验。
 */
export async function sessionPlace(env, args) {
  const sid = String(args.session_id || "").trim();
  const key = String(args.workspace || "").trim();
  if (!sid) throw new Error("place 需要 session_id");
  if (!key) throw new Error("place 需要 workspace（id、标题、路径都行）");
  const reg = env.registry();
  if (!reg || typeof reg.get !== "function") throw new Error("workspaceRegistry 不可用（先跑 ho_status（view=diag））");
  const wid = findWorkspaceId(key);
  if (!wid) throw new Error("找不到工作区：" + key);
  const w = reg.get(wid);
  if (!w || typeof w.attachSession !== "function") throw new Error("工作区实体不可用：" + wid);
  await w.attachSession(sid);
  const out = [];
  out.push("已把 " + sid + " 移入工作区「" + (w.title || key) + "」" + (w.path ? "（" + w.path + "）" : ""));
  out.push("若报 cwd 不匹配：它的 cwd 与该工作区根不一致 —— 用 ho_sessions(action=list) 看 cwd。");
  return out.join(NL);
}
