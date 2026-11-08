/**
 * 会话管理的实现（原 ho_session_new / ho_prompt / ho_session_archive / ho_session_unarchive 的代码搬到这里）。
 * 对外只经 ho_sessions(action=…) 暴露，少 4 份 schema 的固定开销。
 */
import os from 'node:os';
import path from 'node:path';
import { NL, readUtf8, isDir, isFile } from './text.mjs';
import { handoverPathFor, assertProjectName, assertTaskName } from './role.mjs';
import { readHandover } from './handover-io.mjs';
import { scanSessions } from './sessions.mjs';
import { workspaceRows } from './registry.mjs';
import { checkConsent } from './consent.mjs';
import { watermark } from './facts.mjs';
import { sendPrompt } from './prompt.mjs';
import { newSessionIn } from './session-create.mjs';

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

export async function sessionNew(env, args, exec) {
  const ws = env.resolveWs(exec);
  const controller = env.controller();
  // 换任（新建接班会话）先问用户。
  if (args.confirm !== true) throw new Error('新建会话（换任）需要用户确认：先向用户说明要建接班会话并得到同意，再传 confirm=true');
  if (!controller) throw new Error('ctx.sessionController 不可用');
  // 名字要落成目录：先校验，别等会话建完、写角色表时才失败（那样会留下一个没有角色的会话）。
  if (args.project) assertProjectName(String(args.project));
  if (args.task) assertTaskName(String(args.task));
  const out = [];
  const title = String(args.title || '');
  if (args.project && title.indexOf('全局') === -1 && args.force !== true && env.cfg.reuseCheck !== false) {
    const scan = scanSessions({
      dir: env.cacheDir(),
      meId: env.selfId(exec),
      warn: watermark(env.cfg).warnValue,
      silentHours: env.cfg.sessionScanHours,
    });
    const live = scan.rows.filter((r) => r.project === args.project && r.kind === '平级' && r.pct !== null);
    if (live.length) {
      const best = live.slice().sort((a, b) => b.mtime - a.mtime)[0];
      if (best.pct < watermark(env.cfg).warnValue) {
        throw new Error('拒绝新建：项目「' + args.project + '」在任会话 ' + best.sid + ' 水位 ' + best.pct.toFixed(1) + '%（<' + watermark(env.cfg).warn + '），按 Charter §7.2.1 应复用现有会话；确实要建请加 force=true');
      }
    }
  }
  // 角色先算好：新建会话按它登记并当场装配。
  let role = args.role || (args.project ? 'project' : args.kind || '');
  if (role === 'session') role = '';
  const project = args.project || '';
  const task = args.task || '';
  const finalRole = title.indexOf('全局') !== -1 ? 'global'
    : (role === 'project' || role === 'misc' ? role : (project ? 'project' : ''));

  // ---- 工作区解析：新建会话必须落到明确的工作区，不允许静默落进调用者所在的工作区。
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
  const wantGlobalWs = title.indexOf('全局') !== -1 || args.role === 'global' || args.kind === 'global';
  let workspaceId = '';
  if (args.workspace) {
    workspaceId = pickWorkspace(args.workspace);
  } else if (args.cwd) {
    if (!isDir(args.cwd)) throw new Error('cwd 不存在：' + args.cwd);
    // cwd 若正好是已注册工作区的根，必须按 workspaceId 建；否则会话会落进「未分组」。
    let wid = null;
    try { wid = findWorkspaceId(args.cwd); } catch { wid = null; }
    if (!wid) {
      throw new Error('cwd 不在任何已注册工作区里：' + args.cwd + NL + '已注册的工作区：' + NL + choices
        + NL + '要么把 cwd 换成某个工作区的根，要么先注册它：ho_workspace(action="create", path="' + args.cwd + '")。');
    }
    workspaceId = wid;
  } else if (args.project) {
    // 项目会话：按项目名找同名工作区，或路径落在 Projects/<项目>、_Project_Meta/<项目> 下的工作区。
    const want = String(args.project).toLowerCase();
    const hit = rows.find((r) => {
      if (String(r.title || '') === String(args.project)) return true;
      const p = normPath(r.path);
      return p.indexOf('/projects/' + want) !== -1 || p.indexOf('/_project_meta/' + want) !== -1;
    });
    if (!hit) {
      throw new Error('项目「' + args.project + '」还没有对应的工作区。' + NL + '已注册的工作区：' + NL + choices
        + NL + '做法一：ho_workspace(action="create", path="<该项目目录>", title="' + args.project + '") 后再建会话；'
        + NL + '做法二：把 workspace 传成上面某个工作区。');
    }
    workspaceId = String(hit.id);
  } else if (wantGlobalWs) {
    workspaceId = pickWorkspace(ws);
  } else {
    throw new Error('新建会话必须指明工作区：传 workspace（id、标题或路径），或 cwd（某个已注册工作区的根）。' + NL
      + '已注册的工作区：' + NL + choices + NL
      + '全局会话落在标题含「全局」的工作区；项目会话同时传 project 与该项目的工作区；杂项会话传该项目外的独立工作区。');
  }

  const made = await newSessionIn(env, { workspaceId, title, role: finalRole, project, task });
  const sessionId = made.sessionId || '';
  if (!sessionId) throw new Error(made.error || 'create 没有返回 sessionId');
  out.push('已建会话 ' + sessionId + (finalRole ? '，角色 ' + finalRole + (project ? '（' + project + '）' : '') : ''));
  const meId = env.selfId(exec) || '（未知）';
  // 交接路径按**接任者自身的角色**取用：项目换任读取项目交接，不再退回全局交接。
  const hp = handoverPathFor(ws, finalRole === 'project' && project ? { role: 'project', project } : { role: 'global' });
  const handover = env.cfg.handoverPath || (hp.path || '');
  const text = args.message || [
    '读一下 ' + handover + ' 。',
    '读毕先向用户报告，不得自行开展作业：其一，当前停在哪一步；其二，交接列有哪些待办；其三，你建议先做哪一条。待用户指派后再动手；交接中无待办者，如实说明即可，不得自行编造任务。',
    '本会话 id：' + sessionId,
    (finalRole === 'project' ? '现任全局 id：' : '上任全局 id：') + meId,
    '默认沉默：仅在三种时机各发一条 peer_send 至现任全局——≥' + watermark(env.cfg).warn + ' 且已写交接、需用户决定、发现全局口径有误；任务完成不向全局报告（任务属本会话内部事务）。会话之间可直接 peer_send，不必经全局转述；不得每轮回执，亦不得发送「收到」「已完成」一类确认（全局只看文件末态）。',
  ].join(NL);
  const r = await sendPrompt(env.controller(), sessionId, text, 'queue');
  out.push('已投启动提示词 accepted=' + String(r && r.accepted) + '（' + text.length + ' 字）');
  return out.join(NL);
}

// ---------------------------------------------------------------- action: prompt

export function sessionPrompt(env, args, exec) {
  const ws = env.resolveWs(exec);
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
    tpl = '> （插件内置模板 · 要本地化就写到 ' + file + '）' + NL + NL + tpl;
  }
  const skeleton = blockAfter(tpl, '1 共用骨架');
  if (!skeleton) throw new Error('模板缺 §1 共用骨架，拒绝渲染：' + file);
  const kind = args.kind || 'project';
  const project = args.project || '';
  const task = args.task || '';
  const target = handoverPathFor(ws, kind === 'project'
    ? { role: 'project', project }
    : kind === 'misc' && task ? { role: 'misc', task } : { role: 'global' });
  const firstPath = kind === 'global'
    ? (env.cfg.handoverPath || target.path)
    : kind === 'project' ? target.path
      : kind === 'misc' ? (target.path || path.join(ws, '_Control_Center', 'rules', 'Misc_Task_Standard.md'))
        : path.join(ws, '_Control_Center', 'rules', 'Migration_Rules.md');
  if (!firstPath) throw new Error('kind=' + kind + ' 需要 project、task 参数才能算交接路径');
  const numMatch = String(args.title || '').match(/([0-9]+)/);
  const ordinal = numMatch ? numMatch[1] : 'N';
  const roleText = kind === 'global'
    ? '第 ' + ordinal + ' 任全局（管理会话）'
    : kind === 'project'
      ? '「' + project + '」项目的执行对话'
      : kind === 'misc' ? '杂项任务会话' : '新机器接手会话';
  const scopeText = kind === 'project'
    ? '库根 Projects/' + project + ' 与 _Project_Meta/' + project
    : '工作区根 ' + ws;
  const filled = fill(skeleton, {
    '<角色>': roleText,
    '<绝对路径>': firstPath,
    '<本会话 id>': args.sessionId || '（建完后填）',
    '<全局 id>': args.globalSessionId || '（现任全局 id）',
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
    extraLines.push('库根：Projects/' + project + '/ ；元数据：_Project_Meta/' + project + '/ ；快照：_Temp/' + project + '/Snapshots/');
    extraLines.push('开始作业前应先读：_Project_Meta/' + project + '/Handover.md，然后读库根 SKILL.md；修改文档时再读 _Control_Center/rules/ 对应规范。');
    extraLines.push('换任由全局执行：进入预警区后只写交接、通知全局并提醒用户，不得自行建立会话。');
  }
  if (kind === 'misc') extraLines.push('标准见 rules/Misc_Task_Standard.md；换任可自行以 peer_new 落到 Misc。');
  if (kind === 'migration') extraLines.push('迁移口径见 rules/Migration_Rules.md；应先通过顶层闸门再开始作业。');
  if (args.extra) extraLines.push(String(args.extra));
  return [body].concat(extraLines.length ? ['', ...extraLines] : []).join(NL);
}

// ---------------------------------------------------------------- action: archive / unarchive

export async function sessionArchive(env, args, exec) {
  const reg = env.registry();
  if (!reg || typeof reg.archiveSession !== 'function') {
    throw new Error('workspaceRegistry.archiveSession 不可用（先跑 ho_diag 看服务可见性）');
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
    throw new Error('workspaceRegistry.unarchiveSession 不可用（先跑 ho_diag 看服务可见性）');
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
  lines.push("   直接 ho_handover(action=\"write\", text=...)——不要传 path，路径已按你的角色（" + (info && info.role ? info.role : "unknown") + "）解析好。");
  lines.push("2) 必写：① 现在在做什么、到哪一步（版本、产物、是否通过）② 环境与路径（版本号、安装位置、用的下载源）③ 下一步清单：按顺序、每条可直接执行 ④ 已完成待验收、要求了没落地 ⑤ 已知坑与踩过的错。");
  lines.push("3) 机密只写位置不写值（密码、token、密钥一律写「在哪个文件」）。");
  lines.push("4) 写完只回一条 peer_send 给全局：`交接已写 <绝对路径>` ＋ 一句话状态；不要复述全文。");
  lines.push("5) 不要压缩上下文、不要建会话（建会话是全局的权限）。");
  if (extra) lines.push("6) 全局附加：" + extra);
  return lines.join(NL);
}

export async function sessionOrder(env, args) {
  const sid = String(args.session_id || "").trim();
  const order = String(args.order || "").trim();
  if (!sid) throw new Error("order 需要 session_id");
  if (order !== "handover" && order !== "compact") throw new Error("order 只能是 handover 或 compact");
  // 给别的会话下「交接、压缩」指令，也要先问用户。
  if (args.confirm !== true) throw new Error("下交接、压缩指令需要用户确认：先说明会唤醒目标会话并让它交接或压缩，得到同意后传 confirm=true");
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
    out.push("已压满 " + used + "/" + max + "：不再压缩。应执行 ho_sessions(action=\"new\") 换任；新会话读毕交接会先向你报告，等待指派。");
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
    out.push("请用户到设置页的 dsh-handover 中，点「压缩授权」的「允许该会话压缩一次」（5 分钟内有效），再重下这条指令。");
    return out.join(NL);
  }
  const resume = args.resume === "continue" ? "continue" : "wait";
  env.schedule(sid, n, { resume });
  out.push("用户已授权（" + (cs.atText || '') + " 点击，剩 " + Math.round((cs.leftMs || 0) / 1000) + " 秒）。");
  out.push("已登记压缩（它自己第 " + n + "/" + max + " 次）：等它空闲后执行。");
  if (resume === "wait") {
    out.push("去向：wait（缺省）—— 压缩后不再唤醒它，等用户派新任务，或由新会话接手。");
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
  if (!reg || typeof reg.get !== "function") throw new Error("workspaceRegistry 不可用（先跑 ho_diag）");
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
