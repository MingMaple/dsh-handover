/**
 * 会话管理的实现。原 ho_session_new 等 4 个入口的代码已并入本文件。
 * 对外只经 ho_sessions(action=…) 暴露，省去 4 份 schema 的固定开销。
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { NL, readUtf8, isDir, isFile } from './text.mjs';
import { handoverPathFor, assertProjectName, assertTaskName, PENDING_MIGRATION } from './role.mjs';
import { workspaceRows } from './registry.mjs';
import { bandsFor } from './pressure.mjs';
import { sendPrompt } from './prompt.mjs';
import { newSessionIn } from './session-create.mjs';
import { ABORTED_TEXT, aborted } from './abort.mjs';
import { lineageKeyOf, loadOffice, nextName, registerHolder } from './office.mjs';
import { migrateIdentity } from './identity.mjs';
import { detachGlobalTask, syncGlobalRefs } from './system.mjs';
import { stampTz } from './brief.mjs';
import { pathKey } from './pathkey.mjs';

const FENCE = String.fromCharCode(96, 96, 96);

/** 路径比较：先比写法；再取 realpath 比，兼容旧的 junction 路径与真实路径。 */
function sameLoosePath(a, b) {
  if (pathKey(a) === pathKey(b)) return true;
  try { return pathKey(fs.realpathSync(String(a))) === pathKey(fs.realpathSync(String(b))); } catch { return false; }
}

/** 在 ~/.dsh/storages/workspace.json 里按 id、标题、路径找 workspaceId。 */
function findWorkspaceId(key) {
  const file = path.join(os.homedir(), '.dsh', 'storages', 'workspace.json');
  const data = JSON.parse(readUtf8(file));
  const tables = (data && data.tables && data.tables.workspaces) || {};
  for (const id of Object.keys(tables)) {
    const w = tables[id] || {};
    if (id === key) return id;
    if (w.title === key) return id;
    if (sameLoosePath(w.path, key)) return id;
  }
  return null;
}

/**
 * 新建会话落在哪个工作区：优先用用户指定的 workspace 或 cwd。项目按标题或路径自动匹配；全局落到当前工作区。
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
      throw new Error('找不到工作区：' + key + NL + '已注册的工作区：' + NL + choices + NL + '可传 id、标题或路径；如需新建工作区，用 ho_workspace(action="create", path="<目录>")。');
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
      throw new Error('cwd 不在任何已注册工作区中：' + o.cwd + NL + '已注册的工作区：' + NL + choices
        + NL + '处置方式：把 cwd 改为某个工作区的根，或先注册该目录：ho_workspace(action="create", path="' + o.cwd + '")。');
    }
    return wid;
  }
  if (project) {
    // 项目会话：按项目名找同名工作区，或路径落在 Projects/<项目>、_Project_Meta/<项目> 下的工作区。
    // 路径比较按平台折算大小写：Windows/macOS 折叠，Linux 区分；目录段必须整段相等，
    // 避免「Demo」误匹配「Demo2」的工作区。此前固定用小写 `/projects/` 与 pathKey 比较，
    // Linux 上 pathKey 保留 `Projects` 原样，项目工作区反而匹配不到。
    const folded = process.platform === 'win32' || process.platform === 'darwin';
    const wantSeg = folded ? String(project).toLowerCase() : String(project);
    const projDir = folded ? 'projects' : 'Projects';
    const metaDir = folded ? '_project_meta' : '_Project_Meta';
    const hit = rows.find((r) => {
      if (String(r.title || '') === String(project)) return true;
      const segs = pathKey(r.path).split('/');
      for (let i = 0; i < segs.length - 1; i++) {
        if (segs[i + 1] !== wantSeg) continue;
        if (segs[i] === projDir || segs[i] === metaDir) return true;
      }
      return false;
    });
    if (!hit) {
      // 全局任务独立且暂不迁移时，目标项目目录尚不存在，回落到调用者所在工作区。
      if (o.fallbackWs === true) return pickWorkspace(ws);
      throw new Error('项目「' + project + '」尚无对应工作区。' + NL + '已注册的工作区：' + NL + choices
        + NL + '方案一：先 ho_workspace(action="create", path="<该项目目录>", title="' + project + '")，再建会话；'
        + NL + '方案二：把 workspace 传成上列任一工作区。');
    }
    return String(hit.id);
  }
  if (wantGlobalWs) return pickWorkspace(ws);
  if (o.fallbackWs === true) return pickWorkspace(ws);
  throw new Error('新建会话须指明工作区：传 workspace（id、标题或路径），或 cwd（某个已注册工作区的根）。' + NL
    + '已注册的工作区：' + NL + choices + NL
    + '全局会话落在标题含「全局」的工作区。项目会话同时传 project 与该项目的 workspace；杂项会话传该项目之外的独立工作区。');
}

/**
 * 某个目录是不是已注册工作区的根：是则返回 workspaceId，否则返回空串（不抛错）。
 * 换任时用来让接任者落回本会话所在的那个工作区，而不是工作区根。
 */
export function workspaceIdOfPath(env, p) {
  const want = pathKey(p);
  if (!want || want === '-') return '';
  const hit = listWorkspaces(env).find((r) => {
    const rp = String(r.path || '');
    return rp && rp !== '-' && sameLoosePath(rp, p);
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
 * 复用判据：同一类别已有在任会话且其水位未到整理线时，返回中文拒绝理由；否则返回空串。
 * 只读在任登记表与水位缓存，不写任何文件；取不到水位就放行。
 */
function reuseBlocker(env, ws, kind, key) {
  if (env.cfg.reuseCheck === false) return '';
  if (!ws || !kind || !key) return '';
  const lin = loadOffice(ws).lineages[key];
  const cur = lin && lin.current;
  if (!cur || !cur.sessionId) return '';
  let used = null;
  let win = null;
  try {
    const p = typeof env.selfPressure === 'function' ? env.selfPressure(cur.sessionId) : null;
    used = p && typeof p.used === 'number' && Number.isFinite(p.used) ? p.used : null;
    win = p && typeof p.win === 'number' && Number.isFinite(p.win) && p.win > 0 ? p.win : null;
  } catch { used = null; win = null; }
  if (used === null || win === null) return '';
  const bands = bandsFor(env.cfg, win);
  if (bands === null) return '';
  const soft = bands.soft;
  if (used >= soft) return '';
  const label = kind === 'global' ? '全局类别' : kind === 'project' ? '项目「' + key + '」' : '杂项任务「' + key + '」';
  return '拒绝新建：' + label + '已有在任会话 ' + (cur.name || '（未命名）') + '（' + cur.sessionId + '），水位 '
    + used + ' token，未到整理线 ' + soft + '。建议用 peer（action="send"）复用；确需另建，请传 force=true。';
}

export async function sessionNew(env, args, exec, signal) {
  const ws = env.resolveWs(exec);
  const controller = env.controller();
  // 换任（新建接班会话）先问用户。
  if (args.confirm !== true) throw new Error('新建会话（换任）须经当前用户确认：先说明将建立接任会话并取得同意，再传 confirm=true');
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

  // 角色要落成「类别名 + 角色」的持久化条目：先把必要字段校验完，避免会话建完才在登记时失败。
  if (finalRole === 'project' && project === '') {
    throw new Error('现象：新建项目会话缺少项目名。原因：角色为 project 时须给出 project，否则角色表与在任登记都无法落条目。处置：补传 project（或改传 role=global 或 misc 与对应名称）后重试。');
  }
  if (finalRole === 'misc' && task === '') {
    throw new Error('现象：新建杂项会话缺少任务名。原因：角色为 misc 时须给出 task，否则角色表与在任登记都无法落条目。处置：补传 task 后重试。');
  }

  // 建会话之前先读在任登记表：同类已有低水位在任会话时，复用比新建更省。校验在一切写入之前。
  if (args.force !== true && officeKind) {
    const block = reuseBlocker(env, ws, officeKind, lineageKeyOf(officeKind, project, task));
    if (block) throw new Error(block);
  }

  // 迁移方式：缺省 ask（先建会话与登记，迁移留待会话首轮确认）。auto 与 direct 保持旧语义。
  const migrateMode = args.migrate === 'direct' ? 'direct' : args.migrate === 'auto' ? 'auto' : 'ask';
  // 全局任务独立且不迁时，新会话尚未有目标项目目录，工作区只能回落到调用者所在的那个。
  const askKeep = !!args.from_task && migrateMode === 'ask';

  // ---- 工作区解析：新建会话必须落到明确的工作区，不允许静默落进调用者所在的工作区。
  // 先解析再迁移：解析失败时不得已经把任务库移走（D-128）。
  const workspaceId = resolveWorkspaceFor(env, exec, finalRole, project, task, {
    workspace: args.workspace,
    cwd: args.cwd,
    wantGlobal: title.indexOf('全局') !== -1 || args.role === 'global' || args.kind === 'global',
    fallbackWs: askKeep,
  });

  // 全局任务整体独立：ask 时先建会话与登记，文件体系留在原处，迁移由新会话首轮确认。
  let migrated = null;
  let layout = finalRole === 'project' || finalRole === 'misc' ? finalRole : '';
  let layoutName = finalRole === 'project' ? project : (finalRole === 'misc' ? task : '');
  let pending = null;
  if (args.from_task) {
    let caller = null;
    try { caller = env.roleOf(exec); } catch { caller = null; }
    if (!caller || caller.role !== 'global') throw new Error('from_task 只对全局会话开放');
    const oldTask = String(args.from_task).trim();
    assertTaskName(oldTask);
    if (finalRole !== 'project' && finalRole !== 'misc') throw new Error('from_task 须同时给 role=project 或 role=misc');
    if (migrateMode === 'ask') {
      layout = 'global-task';
      layoutName = oldTask;
      pending = {
        kind: PENDING_MIGRATION,
        from: { role: 'global-task', project: '', task: oldTask },
        to: { role: finalRole, project, task },
        at: stampTz(Date.now()),
      };
      out.push('全局任务已独立：文件体系仍在 _Control_Center/tasks/' + oldTask + '/，迁移待新会话首轮确认。');
    } else {
      migrated = migrateIdentity({
        ws,
        prev: { role: 'global-task', task: oldTask },
        next: { role: finalRole, project, task },
        mode: migrateMode,
      });
      out.push('全局任务已独立：' + migrated.summary);
    }
  }

  if (aborted(signal)) throw new Error(ABORTED_TEXT);
  const made = await newSessionIn(env, { workspaceId, title, role: finalRole, project, task, layout, layoutName, pending }, signal);
  const sessionId = made.sessionId || '';
  if (!sessionId) throw new Error(made.error || 'create 没有返回 sessionId');
  if (made.error) throw new Error(made.error + '（会话 id：' + sessionId + '；不回收已建会话）');
  out.push('已建会话 ' + sessionId + (finalRole ? '，角色 ' + finalRole + (project ? '（' + project + '）' : '') : ''));
  // 建会话即登记在任：全局手工建/换会话与自服务换任共用一张登记表，不让注册表漏记或与实况分叉。
  try {
    if (officeKind) {
      const key = lineageKeyOf(officeKind, project, task);
      // 缺 title 时按在任表自动起名：空名 registerHolder 必然失败，留下未登记的会话（D-129）。
      const regName = title.trim() ? title : nextName(loadOffice(ws), key);
      // 工作区一栏写**实际落点**（用户指定的那个工作区），不是调用者自己所在的工作区根。
      const reg = registerHolder(ws, {
        kind: officeKind, project, task, name: regName, sessionId,
        workspace: workspacePathOf(env, workspaceId) || ws,
      });
      out.push('在任登记：' + reg.key + ' → ' + regName + (reg.previous ? '（原 ' + reg.previous.name + ' 进历史）' : ''));
    }
  } catch (e) {
    // 与 session-create 同口径：已建会话不回收，但必须让调用方看到失败（D-129）。
    throw new Error('会话已建成，但在任登记失败：' + String(e && e.message ? e.message : e)
      + '（会话 id：' + sessionId + '；不回收已建会话）。处置：用 ho_sessions(action="office-register", name="…") 补登');
  }
  // 独立且未迁：全局总注册撤行 + 打标记。只删行会在下次同步时被重新登记，标记先行才稳。
  if (pending && args.from_task) {
    try {
      const d = detachGlobalTask(ws, String(args.from_task).trim());
      out.push('全局总注册：已撤行' + (d.changed ? '（已改写）' : '（无变化）') + '；重复同步不会再登记。');
    } catch (e) {
      out.push('全局总注册撤行失败：' + String(e && e.message ? e.message : e) + '。处置：用 ho_docmap(action="registry-check") 核对后手工撤行。');
    }
  } else if (migrated) {
    // 迁移后体系注册换了位置：按磁盘重算一次，旧行随旧路径消失。
    try { syncGlobalRefs(ws); } catch { /* 总注册写失败不影响迁移结果 */ }
  }
  const meId = env.selfId(exec) || '（未知）';
  // 交接路径按**新会话自身的布局**取用：类别换了而布局未迁时，交接仍在旧布局。
  const hp = handoverPathFor(ws, { role: finalRole, project, task, layout, layoutName });
  const handover = (finalRole === 'global' ? env.cfg.handoverPath : '') || hp.path
    || (finalRole === 'misc' ? path.join(ws, '_Control_Center', 'rules', 'Misc_Task_Standard.md') : '');
  const pendingLines = pending ? [
    '身份已独立，文件体系未动：体系仍在 ' + (hp.path ? path.dirname(hp.path) : '原布局') + '。',
    '首轮只问不搬：先问当前用户一句「是否迁移文件体系」，答复前不得移动任何文件。',
    '报数：库内写死绝对路径的命中数由插件在角色设定消息里给出；逐条核对后再动手。',
    '答复后用 ho_sessions(action="migration-choice", migrate=true 或 false) 了结，不要自行搬移。',
    '迁移后向当前用户列出文件体系，含目录结构与规范文件。请其选择：一键建成，或先修改。',
  ] : [];
  const bootstrap = finalRole === 'project' || finalRole === 'misc' ? [
    '若交接为空、本会话是新任务的起点：先问清当前用户要做的事：目标、范围与保留要求。',
    '理解后列出任务大纲或解析，请当前用户确认理解是否正确。',
    '确认后给出初步文件体系，请其选择：一键建成，或先修改。',
  ] : [];
  const text = args.message || [
    ...pendingLines,
    '先读交接：' + handover + '。',
    '读毕先向当前用户报告，不得自行开展作业。报告 3 项：一、当前停在哪一步；二、交接列有哪些待办；三、建议先做哪一条。',
    ...bootstrap,
    '待当前用户指派后再开始作业。交接无待办时如实说明，不得编造任务。',
    '本会话 id：' + sessionId,
    (finalRole === 'project' ? '全局会话 id：' : '创建者会话 id：') + meId,
    '默认沉默：仅在下列 3 种时机向全局发送一条 peer（action="send"）。水位不低于建议线（advise）且已写交接；需当前用户决定；全局口径有误。',
    '任务完成不报全局，任务属本会话内部事务。会话之间可直接 peer（action="send"），不必经全局转述。',
    '不得每轮回执，不得发送「收到」「已完成」一类确认；全局以文件末态为准。',
  ].join(NL);
  if (aborted(signal)) {
    out.push(ABORTED_TEXT);
    return out.join(NL);
  }
  let r = null;
  try {
    r = await sendPrompt(env.controller(), sessionId, text, 'queue', signal);
  } catch (e) {
    // 已建成会话与已投递消息都不回收；中止按可读文案返回。
    if (aborted(signal)) {
      out.push(ABORTED_TEXT);
      return out.join(NL);
    }
    throw e;
  }
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
    extraLines.push('作业前读库根 SKILL.md；修改文档时按 `ho_docmap(action="rules-read", doc=…)` 取对应规范。');
    extraLines.push('进入预警区后写交接。上下文重置与换任须由当前用户授权：在聊天框发送 /allow-reset，再由本会话调用 succeed 完成，不向全局请求。');
  }
  if (kind === 'misc') extraLines.push('标准见 `ho_docmap(action="rules-read", doc="misc_standard")`。换任须经当前用户授权，再由本会话调用 ho_sessions(action="succeed")。');
  if (kind === 'migration') extraLines.push('迁移口径见 `ho_docmap(action="rules-read", doc="migration_rules")`。通过顶层闸门后再开始作业。');
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
  out.push('提醒：归档会话会被 archived-session-gate 拦截，无法唤醒；如需使用，请先执行 action="unarchive"。');
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
  return '已解归档 ' + sid + NL + '该会话已回到原工作区位置，可再次唤醒。';
}

// ---------------------------------------------------------------- action: order

/** 交接流程的标准指令（全局下给某个会话；路径按它自己的角色解析，不借调用者上下文）。 */
function orderHandoverText(env, sid, extra) {
  const hp = env.handoverForSid(sid);
  const info = env.infoOfSid(sid);
  const lines = [];
  lines.push("【全局指令：执行交接流程】将当前工作写成交接。写毕立即停止操作，等待换任；本轮不再进行项目作业。");
  lines.push("");
  lines.push("1) 目标文件：" + (hp && hp.path ? hp.path : "（角色未定，须先由全局设定角色）"));
  lines.push("   按固定流程重写：一步完成归档旧交接、写入新正文与结构体检。承接项由返回给出，需自行并入新正文。不传 path：路径已按本会话角色（" + (info && info.role ? info.role : "unknown") + "）解析。");
  lines.push("2) 必写 5 项。1）当前进度（版本、产物、是否通过）。2）环境与路径（版本号、安装位置、下载源）。3）下一步清单，按顺序列出，每条可直接执行。4）已完成待验收与要求未实现的部分。5）已知问题与已出现的错误。");
  lines.push("3) 机密只写位置，不写值：密码、token、密钥均写明所在文件。");
  lines.push("4) 写毕只向全局回一条 peer（action=\"send\"）：`交接已写 <绝对路径>`，附一句状态，不复述全文。");
  lines.push("5) 不得压缩上下文，不得新建会话（新建会话属全局权限）。");
  if (extra) lines.push("6) 全局附加：" + extra);
  return lines.join(NL);
}

export async function sessionOrder(env, args, signal) {
  const sid = String(args.session_id || "").trim();
  const order = String(args.order || "").trim();
  if (!sid) throw new Error("order 需要 session_id");
  if (order !== "handover" && order !== "compact") throw new Error("order 只能是 handover 或 compact");
  // 给别的会话下「交接、压缩」指令，也要先问用户。
  if (args.confirm !== true) throw new Error("下发交接或压缩指令须经当前用户确认：先说明将唤醒目标会话，取得同意后传 confirm=true");
  const extra = typeof args.extra === "string" ? args.extra.trim() : "";
  const hp = env.handoverForSid(sid);
  const info = env.infoOfSid(sid);
  const out = [];
  out.push("目标 " + sid + " · 角色 " + ((info && info.role) || "unknown") + " · 交接 " + ((hp && hp.path) || "（未解析）"));
  if (!hp || !hp.path) {
    out.push("没有交接路径：先为目标会话设定角色（ho_sessions(action=\"role\")），否则该会话会退回全局交接。");
    return out.join(NL);
  }
  if (order === "handover") {
    const text = orderHandoverText(env, sid, extra);
    const r = await sendPrompt(env.controller(), sid, text, "queue", signal);
    out.push("已投递交接指令 accepted=" + String(r && r.accepted) + "（将唤醒目标会话一轮）");
    out.push("收到目标会话回的 `交接已写 <路径>` 后，再用 ho_sessions(action=\"new\") 建立接任会话。");
    return out.join(NL);
  }
  // order === compact：不再由全局代排。压缩只能在目标会话自身的轮次内执行，
  // 到线提示后由该会话的助手调用 ho_handover(action="compact")，或由插件在强制线强制压缩。
  out.push("压缩不由全局代排：判定权归目标会话的助手。");
  out.push("处置：用 peer 通知目标会话，请其在安全断点调用 compact。到强制线时插件会自行强制压缩。");
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
  out.push("若提示 cwd 不匹配：目标会话的 cwd 与该工作区根不一致，用 ho_sessions(action=list) 查看 cwd。");
  return out.join(NL);
}
