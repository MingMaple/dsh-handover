/**
 * dsh-handover —— 全局运行期插件。
 * 判据进代码、流程进工具；规则正文留磁盘，需要时用 ho_charter 取节（完整流程 doc="runtime"）。
 * 按会话角色载入工具与提示段：全局 22 个工具、项目 9、杂项 9、普通 0。
 * 源码不热加载：改完要重启 DSH。
 */
import fs from 'node:fs';
import path from 'node:path';
import { isDir, readJsonDir, pick } from './lib/text.mjs';
import { resolveConfig } from './lib/config.mjs';
import { projCacheDir, pressurePct } from './lib/sessions.mjs';
import { createScheduler } from './lib/schedule.mjs';
import { compactionStateOf, stalePressureNote } from './lib/events.mjs';
import { pmBriefTool } from './tools/ho_brief.mjs';
import { pmGateTool } from './tools/ho_gate.mjs';
import { pmSessionsTool } from './tools/ho_sessions.mjs';
import { pmPhaseTool } from './tools/ho_phase.mjs';
import { pmCharterTool } from './tools/ho_charter.mjs';
import { pmHandoverTool } from './tools/ho_handover.mjs';
import { pmCheckpointTool } from './tools/ho_checkpoint.mjs';
import { pmSnapshotTool } from './tools/ho_snapshot.mjs';
import { pmDiagTool } from './tools/ho_diag.mjs';
import { pmDriftTool } from './tools/ho_drift.mjs';
import { pmChangelogTool } from './tools/ho_changelog.mjs';
import { pmTokensTool } from './tools/ho_tokens.mjs';
import { pmPackTool } from './tools/ho_pack.mjs';
import { pmWorkspaceTool } from './tools/ho_workspace.mjs';
import { pmInitTool } from './tools/ho_init.mjs';
import { pmProfileTool } from './tools/ho_profile.mjs';
import { pmPeerListTool } from './tools/peer_list.mjs';
import { pmPeerStatusTool } from './tools/peer_status.mjs';
import { pmPeerSendTool } from './tools/peer_send.mjs';
import { pmPeerNewTool } from './tools/peer_new.mjs';
import { pmPeerRenameTool } from './tools/peer_rename.mjs';
import { pmPeerPeekTool } from './tools/peer_peek.mjs';
import { resolveRegistry } from './lib/registry.mjs';
import { registerStatusRoute } from './lib/webroute.mjs';
import { createApi, statusSnapshot } from './lib/api.mjs';
import { registerRpcCarrier } from './lib/rpc-carrier.mjs';
import { NAMES } from './lib/names.mjs';
import { readExtraPrompt, writeExtraPrompt, EXTRA_PROMPT_ORDER, EXTRA_PROMPT_SECTION } from './lib/extra-prompt.mjs';
import {
  ROLES, resolveRole, sessionMeta, handoverPathFor, toolsetFor,
  readRoles, writeRole, assertProjectName, assertTaskName,
} from './lib/role.mjs';
import { manualFor, organizeMessageFor } from './lib/manual.mjs';
import { sendPrompt } from './lib/prompt.mjs';
import { resolveShortSid } from './lib/api.mjs';
import { routeWorkspace } from './lib/workspace.mjs';
import { stampTz } from './lib/brief.mjs';
import { grantConsent } from './lib/consent.mjs';

export const name = 'dsh-handover';
// 必需服务（名字已核对：dsh-agent→agents、dsh-compaction→compaction、dsh-api-session-controller→sessionController）。
// 只 inject 一定存在的服务：多写一个不存在的名字，cordis 会让整个插件静默不激活。
// agents / compaction 用运行时解析（ctx[name] → ctx.get(name)），无法获取由 ho_diag 报出来、ho_checkpoint 明确报错。
export const inject = ['tools', 'systemPrompt', 'sessionController'];

/** 自身包信息：dist 里读 ./package.json，源码树里退回 ../package.json。 */
function pkgInfo() {
  for (const rel of ['./package.json', '../package.json']) {
    try {
      const j = JSON.parse(fs.readFileSync(new URL(rel, import.meta.url), 'utf8'));
      if (j && j.version) return { name: String(j.name || ''), version: String(j.version) };
    } catch { /* 试下一个 */ }
  }
  return { name: '@mingmaple/dsh-handover', version: '?' };
}

function walkUpToWorkspace(start) {
  let cur = start;
  for (let i = 0; i < 8 && cur; i++) {
    if (isDir(path.join(cur, '_Control_Center'))) return cur;
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  // cwd 的父目录已删（或 cwd 是盘符根）时，向上找不到工作区。
  // 若把 start 原样返回，写操作就会在那个已失效的路径上重建一套 _Control_Center（幽灵目录）。
  // 此时以登记表里的工作区为准；登记也找不到才退回 start。
  try {
    const fromReg = routeWorkspace({ cfg: {} });
    if (fromReg && fromReg !== start && isDir(path.join(fromReg, '_Control_Center'))) return fromReg;
  } catch { /* 登记读不到就保持旧行为 */ }
  return start;
}

function msgOf(e) {
  return String(e && e.message ? e.message : e);
}

/**
 * 压缩调度器用的两个依赖：入参是**会话 id**，必须按 id 解析角色与交接路径。
 * 单独导出，便于冒烟测试直接验证。
 */
export function schedDepsFor(env) {
  return {
    roleOf: (sid) => env.infoOfSid(sid),
    handoverFor: (sid) => env.handoverForSid(sid),
  };
}

export function apply(ctx, config) {
  const cfg = resolveConfig(config);
  const initErrors = [];
  const registered = new Set();           // 已注册的工具名（旧内核的限制式裁剪要用）
  // 0.2.2 起工具按「步」解析（tools.resolve）：可用工具集合每一步重算，角色过滤直接放进注册条件。
  // 更早的内核忽略注册选项，只能退回 agent 作用域的 restrict；两条路径按能力二选一，不并行。
  const perStep = (() => { try { return !!(ctx.tools && typeof ctx.tools.resolve === 'function'); } catch { return false; } })();
  const sectionDispose = new Map();       // sessionId → 撤销提示段
  const legacyRestrict = new Map();       // sessionId → 撤销限制（仅无按步解析的内核）
  const appliedRole = new Map();          // sessionId → 上次装配的角色
  const roleCache = new Map();            // sessionId → { at, info }（每步过滤用，短 TTL）
  const roleState = { last: null };
  let scheduler = null;
  let schedulerError = "";
  let guardLast = null;

  const env = {
    cfg,
    cacheDir: () => projCacheDir(),
    controller: () => {
      try { if (ctx.sessionController) return ctx.sessionController; } catch { /* ignore */ }
      try { return typeof ctx.get === 'function' ? ctx.get('sessionController') : null; } catch { return null; }
    },
    resolveWs(exec) {
      if (cfg.workspaceRoot) return cfg.workspaceRoot;
      const cwd = exec && exec.agent && exec.agent.session && exec.agent.session.header ? exec.agent.session.header.cwd : null;
      return walkUpToWorkspace(cwd || process.cwd());
    },
    selfId(exec) {
      const h = exec && exec.agent && exec.agent.session ? exec.agent.session.header : null;
      return h && h.id ? h.id : null;
    },
    selfCwd(exec) {
      const h = exec && exec.agent && exec.agent.session ? exec.agent.session.header : null;
      return h && h.cwd ? h.cwd : null;
    },
    selfPct(id) {
      if (!id) return null;
      const target = id.indexOf('session-') === 0 ? id : 'session-' + id;
      for (const f of readJsonDir(this.cacheDir())) {
        const stem = f.name.replace('.json', '');
        if (stem === target || stem === id) return pressurePct(f.data);
      }
      return null;
    },
    schedule(sessionId, n, opts) {
      if (!scheduler) throw new Error("压缩调度器未就绪" + (schedulerError ? "：" + schedulerError : "（服务尚未注入）"));
  // consent 已由入口工具校验并消费；此处不再复查，复查必然落空。
      scheduler.request(sessionId, Object.assign({ n, consent: 'checked' }, opts || {})).catch(() => {});
    },
    registry() { return resolveRegistry(ctx); },
    /** 迁移感知：根目录是否已搬到别处（旧路径变 junction）。给提示段与 ho_diag 用。 */
    moveInfo() {
      try {
        const src = cfg.workspaceRoot || walkUpToWorkspace(process.cwd());
        const st = moveStatus({ src });
        return st && st.phase && st.phase !== 'none' ? st : null;
      } catch { return null; }
    },
    guardLast() { return guardLast; },
    injectList: () => inject.slice(),
    initErrors: () => initErrors.slice(),
    probeServices() {
      const out = {};
      for (const name of ['tools', 'systemPrompt', 'sessionController', 'agents', 'compaction', 'tokenMeter', 'llm', 'sessions', 'commands', 'workspaceRegistry']) {
        let v = null;
        try { v = ctx[name]; } catch { /* ignore */ }
        if (!v) { try { v = typeof ctx.get === 'function' ? ctx.get(name) : null; } catch { /* ignore */ } }
        out[name] = !!v;
      }
      return out;
    },
    probeAgentScope(exec) {
      const out = { ctx: false, compaction: false, compactNow: false, tokenMeter: false, sessions: false, llm: false, agents: false };
      let c = null;
      try { c = exec && exec.agent ? exec.agent.ctx : null; } catch { /* ignore */ }
      if (!c) return out;
      out.ctx = true;
      for (const name of ['compaction', 'tokenMeter', 'sessions', 'llm', 'agents']) {
        let v = null;
        try { v = c[name]; } catch { /* ignore */ }
        if (!v) { try { v = typeof c.get === 'function' ? c.get(name) : null; } catch { /* ignore */ } }
        out[name] = !!v;
        if (name === 'compaction' && v && typeof v.compactNow === 'function') out.compactNow = true;
      }
      return out;
    },
    compactionCount(exec) {
      const st = compactionStateOf(this.selfId(exec), exec);
      return { used: st.used, note: '' };
    },
    lockState(exec) {
      return compactionStateOf(this.selfId(exec), exec).lock;
    },
    compactionState(exec) {
      return compactionStateOf(exec ? this.selfId(exec) : null, exec);
    },
    staleNote(exec) {
      try { return stalePressureNote(this.selfId(exec)); } catch { return ''; }
    },
    /** 自身版本：从 dist/package.json 读，设置页与 ho_diag 共用同一值。 */
    version() {
      try { return pkgInfo().version; } catch { return '?'; }
    },
    /** 当前已装配提示段的会话数（诊断用）。 */
    assembledCount() { return sectionDispose.size; },
    log(m) {
      try { if (ctx.logger && typeof ctx.logger.warn === 'function') ctx.logger.warn(String(m)); } catch { /* ignore */ }
    },
  };

  // ---------------- 会话标题：运行时 header.title 常常是空的，退回投影缓存
  function titleOf(sessionId) {
    try {
      const a = ctx.agents && typeof ctx.agents.get === 'function' ? ctx.agents.get(sessionId) : null;
      const t = a && a.session && a.session.header ? String(a.session.header.title || '') : '';
      if (t) return t;
    } catch { /* ignore */ }
    try {
      const target = String(sessionId || '');
      for (const f of readJsonDir(projCacheDir())) {
        const stem = f.name.replace('.json', '');
        if (stem !== target && stem !== (target.indexOf('session-') === 0 ? target : 'session-' + target)) continue;
        const row = pick(f.data, 'record', 'rows', 'title', 'val');
        if (typeof row === 'string') return row;
      }
    } catch { /* ignore */ }
    return '';
  }

  function agentOf(sid) {
    const want = String(sid || '');
    try {
      const a = ctx.agents && typeof ctx.agents.get === 'function' ? ctx.agents.get(want) : null;
      if (a) return a;
    } catch { /* 退回列表查找 */ }
    // 宿主的注册表键不保证就是会话 id：取不到时按会话头的 id 在活体列表里再找一次。
    // 少了这一层，休眠会话在设置页被改角色时会被判成「不在内存」，只能等重启才装配。
    try {
      const list = ctx.agents && typeof ctx.agents.list === 'function' ? (ctx.agents.list() || []) : [];
      for (const a of list) {
        const h = a && a.session ? a.session.header : null;
        if (h && String(h.id || '') === want) return a;
      }
    } catch { /* ignore */ }
    return null;
  }

  /**
   * 会话头就能判定的子级会话：子会话与团队成员的会话都带 origin=subagent 或 parentSession。
   * 只读 header，不碰磁盘，可放在「每一步」的条件启用里。
   */
  function isChildSession(agent) {
    try {
      const h = agent && agent.session ? agent.session.header : null;
      if (!h) return false;
      return h.origin === 'subagent' || !!h.parentSession;
    } catch { return false; }
  }


  // ---------------- 角色判定
  function infoFor(sid, opts) {
    const o = opts || {};
    const meta = sessionMeta(sid);
    return resolveRole({
      cfg,
      sessionId: sid,
      title: o.title !== undefined ? o.title : titleOf(sid),
      cwd: o.cwd || meta.cwd,
      firstPrompt: meta.firstPrompt,
      subagent: meta.subagent,
    });
  }

  env.roleOf = (exec) => infoFor(env.selfId(exec) || '', { cwd: env.selfCwd(exec) || '' });
  env.toolsetOf = (role) => toolsetFor(role);
  env.roleState = () => ({ mode: roleMode(), last: roleState.last, count: appliedRole.size });
  env.rolesSnapshot = () => readRoles(cfg).sessions;
  // 写角色表是一切角色变更的唯一入口：写完立刻让每步过滤的短缓存失效，下一步就用新角色。
  env.writeRole = (sid, patch) => {
    const saved = writeRole(cfg, sid, patch);
    roleCache.delete(String(sid || ''));
    return saved;
  };

  /** 当前生效的裁剪机制，供 ho_diag 报出。 */
  function roleMode() {
    if (cfg.roleGating === 'off') return '关闭（roleGating=off，所有会话可见全部工具）';
    return perStep
      ? '按步过滤（工具表每步重算，换角色下一轮即生效）'
      : '旧式收窄（内核不支持按步解析，用 agent 作用域 restrict）';
  }

  function handoverInfoFor(info, ws) {
    if (cfg.handoverPath && info.role === 'global') {
      return { path: cfg.handoverPath, kind: 'global', scope: '_Global', role: info.role, project: info.project, task: info.task, ws };
    }
    const t = handoverPathFor(ws, info);
    return Object.assign({ ws, role: info.role, project: info.project, task: info.task }, t);
  }

  /** 只按会话 id 推工作区根：优先活体 cwd，其次会话元数据，最后配置。 */
  function workspaceForSid(sid) {
    if (cfg.workspaceRoot) return String(cfg.workspaceRoot);
    const a = agentOf(sid);
    const cwd = a && a.session && a.session.header ? String(a.session.header.cwd || '') : (sessionMeta(sid).cwd || '');
    return walkUpToWorkspace(cwd || process.cwd());
  }

  env.handoverFor = (exec) => handoverInfoFor(env.roleOf(exec), env.resolveWs(exec));
  /** 跨会话用：凭 id 算它自己的角色与交接路径（不借调用者的上下文）。 */
  env.handoverForSid = (sid) => {
    const id = String(sid || '');
    return handoverInfoFor(infoFor(id, {}), workspaceForSid(id));
  };
  env.infoOfSid = (sid) => infoFor(String(sid || ''), {});
  env.agentOfSid = (sid) => agentOf(String(sid || ''));
  env.compactionStateOfSid = (sid) => compactionStateOf(String(sid || ''), null);

  // ---------------- 按角色装配：工具可见性由每步条件即时算，这里只维护提示段（旧内核另加 restrict）
  function workspaceForAgent(agent) {
    if (cfg.workspaceRoot) return cfg.workspaceRoot;
    const cwd = agent && agent.session && agent.session.header ? String(agent.session.header.cwd || '') : '';
    return walkUpToWorkspace(cwd || process.cwd());
  }

  /** 注册/替换本会话的角色提示段；普通会话不注册。 */
  function applySection(agent, sid, info) {
    const old = sectionDispose.get(sid);
    if (typeof old === 'function') { try { old(); } catch { /* 旧段已失效 */ } }
    sectionDispose.delete(sid);
    let text = '';
    try {
      const ws = workspaceForAgent(agent);
      text = manualFor(info, { ws, cfg, move: typeof env.moveInfo === 'function' ? env.moveInfo() : null });
    } catch (e) {
      initErrors.push('角色提示段：' + msgOf(e));
      return;
    }
    const sc = agent && agent.ctx ? agent.ctx : null;
    if (!text || !sc || !sc.systemPrompt || typeof sc.systemPrompt.section !== 'function') return;
    try {
      sectionDispose.set(sid, sc.systemPrompt.section({ name: 'dsh-handover:manual', order: 100, text, interpolate: false }));
    } catch (e) {
      // 插件重载后，旧实例注册在 agent 作用域上的同名提示段仍在（宿主按 agent 持有，插件卸载不移除），
      // 既无法移除也不能重复注册：视为已就位，沿用旧文本；换文本需重启 DSH 或让会话重建。
      if (!/already registered/.test(msgOf(e))) initErrors.push('角色提示段：' + msgOf(e));
    }
  }

  /** 旧内核（没有按步解析）才用的限制式裁剪。 */
  function applyLegacyRestrict(agent, sid, info) {
    const old = legacyRestrict.get(sid);
    if (typeof old === 'function') { try { old(); } catch { /* 旧限制已失效 */ } }
    legacyRestrict.delete(sid);
    if (cfg.roleGating === 'off' || info.role === 'global') return;
    try {
      const sc = agent && agent.ctx ? agent.ctx : null;
      if (!sc || !sc.tools || typeof sc.tools.restrict !== 'function') return;
      const deny = toolsetFor(info.role).deny.filter((n) => registered.has(n));
      if (deny.length) legacyRestrict.set(sid, sc.tools.restrict({ deny }));
    } catch { /* 旧内核裁剪失败只影响可见工具，不影响其余功能 */ }
  }

  /** 让一个活体会话的提示段与本会话当前角色对齐。info 可传入已解析好的角色，省一次判定。 */
  function applyRoleTo(agent, infoOpt) {
    const h = agent && agent.session ? agent.session.header : null;
    const sid = String((h && h.id) || (agent && agent.id) || '');
    if (!sid) return;
    let info = infoOpt || null;
    if (!info) {
      try { info = infoFor(sid, scopedMetaOf(h, sid)); } catch { return; }
    }
    applySection(agent, sid, info);
    if (!perStep) applyLegacyRestrict(agent, sid, info);
    appliedRole.set(sid, info.role);
    roleState.last = { sid, role: info.role, at: stampTz(Date.now()) };
  }

  /** 设定角色：写角色表 → 存活会话当场换提示段（工具在下一步按新角色重算）→ 可选投整理指令。 */
  async function applyRole(input) {
    const i = input || {};
    const sid = String(i.sessionId || '').trim();
    const role = String(i.role || '').trim();
    const project = String(i.project || '').trim();
    const task = String(i.task || '').trim();
    if (!sid) return { ok: false, error: '缺会话 id' };
    if (ROLES.indexOf(role) === -1) return { ok: false, error: '角色只能是 global、project、misc、plain' };
    if (role === 'project' && !project) return { ok: false, error: '项目角色要填项目名' };
    if (role === 'misc' && !task) return { ok: false, error: '杂项角色要填任务名' };
    // 名字要落成目录：不合法就当场拒绝，别等写角色表或拼路径时才失败。
    if (role === 'project') { try { assertProjectName(project); } catch (e) { return { ok: false, error: msgOf(e) }; } }
    if (role === 'misc') { try { assertTaskName(task); } catch (e) { return { ok: false, error: msgOf(e) }; } }
    try { writeRole(cfg, sid, { role, project, task, source: 'user' }); }
    catch (e) { return { ok: false, error: '写角色表失败：' + msgOf(e) }; }
    roleCache.delete(sid);
    const info = { role, project, task, source: 'store', sessionId: sid };
    let live = false;
    try {
      const a = agentOf(sid);
      if (a) { live = true; applyRoleTo(a, info); }
    } catch { /* 活体装配失败不影响写盘 */ }
    let delivered = false;
    let error = '';
    const msg = organizeMessageFor(info, { ws: routeWorkspace(env) });
    if (i.wake !== false && msg) {
      try {
        const r = await sendPrompt(env.controller(), sid, msg, 'queue');
        delivered = !!(r && r.accepted);
      } catch (e) {
        error = msgOf(e);
      }
    }
    return { ok: true, role, project, task, live, delivered, error };
  }
  env.applyRole = applyRole;

  /** 会话新建后立即按已登记角色装配（不唤醒、不投消息）。 */
  env.applyScopedLive = (sid, info) => {
    try {
      const a = agentOf(String(sid || ''));
      if (!a) return false;
      const i = Object.assign({ role: 'plain', project: '', task: '', source: 'live' }, info || {});
      if (!i.role) i.role = 'plain';
      applyRoleTo(a, i);
      return true;
    } catch { return false; }
  };

  // ---------------- 调度器（续跑文案要按角色取交接路径）
  // 注意：调度器拿到的是会话 id 字符串，不是 exec；这里用按 id 解析的版本，直接读角色表与磁盘。
  const schedDeps = { ctx, cfg, logger: (ctx.logger || null), roleOf: null, handoverFor: null };
  try {
    scheduler = createScheduler(schedDeps);
    if (typeof ctx.effect === "function") ctx.effect(() => () => { try { scheduler.dispose(); } catch { /* ignore */ } });
  } catch (e) { schedulerError = msgOf(e); }
  Object.assign(schedDeps, schedDepsFor(env));

  // ---------------- 用户全局前置提示词（段序 950＝工具段之前）
  // 与插件自身的会话约束无关：仅当用户开启且内容非空时注册；关闭或留空时完全不占用注入点位。
  let extraDispose = null;
  function applyExtraPrompt(state) {
    try { if (typeof extraDispose === 'function') extraDispose(); } catch { /* 旧段已失效 */ }
    extraDispose = null;
    const enabled = !!(state && state.enabled === true);
    const body = String(state && state.text ? state.text : '').trim();
    if (!enabled || !body) return { registered: false, chars: body.length, enabled: false };
    if (!ctx.systemPrompt || typeof ctx.systemPrompt.section !== 'function') return { registered: false, chars: body.length, enabled: true, error: 'systemPrompt.section 不可用' };
    try {
      extraDispose = ctx.systemPrompt.section({
        name: EXTRA_PROMPT_SECTION,
        order: EXTRA_PROMPT_ORDER,
        text: body,
        interpolate: false,
      });
      return { registered: true, chars: body.length, enabled: true };
    } catch (e) {
      return { registered: false, chars: body.length, enabled: true, error: msgOf(e) };
    }
  }
  env.extraPrompt = () => { try { return readExtraPrompt().text; } catch { return ''; } };
  env.extraPromptEnabled = () => { try { return readExtraPrompt().enabled; } catch { return false; } };
  env.setExtraPrompt = (text, enabled) => {
    const saved = writeExtraPrompt(text, enabled);
    const r = applyExtraPrompt(saved);
    return { ok: true, chars: saved.text.length, enabled: saved.enabled, registered: r.registered, error: r.error || '' };
  };
  try { applyExtraPrompt(readExtraPrompt()); } catch (e) { initErrors.push('全局前置提示词：' + msgOf(e)); }

  // ---------------- 工具注册（16 个 ho_* + 6 个 peer_*）
  // 0.2.2 起工具按「步」解析：可用工具集合每一步重算。子会话排除与角色过滤都在这里一次做完，
  // 不再另用 agent 作用域 restrict —— 两套机制并行时，换角色要么等到重启、要么互相覆盖。
  const roleToolsets = new Map(ROLES.map((r) => [r, new Set(toolsetFor(r).allow)]));
  /** 每步过滤：子会话一律不可用；角色按当前角色表算；「无 agent」的路径（命令行、演练）放行。 */
  function visibleTo(name) {
    return (c) => {
      const agent = c && c.agent ? c.agent : null;
      if (isChildSession(agent)) return false;
      if (!perStep || cfg.roleGating === 'off' || !agent) return true;
      const h = agent.session && agent.session.header ? agent.session.header : null;
      const sid = String((h && h.id) || agent.id || '');
      if (!sid) return true;
      let info = null;
      const hit = roleCache.get(sid);
      if (hit && Date.now() - hit.at < 2000) info = hit.info;
      else {
        try { info = infoFor(sid, scopedMetaOf(h, sid)); } catch { info = null; }
        if (info) roleCache.set(sid, { at: Date.now(), info });
      }
      if (!info) return true;
      const allow = roleToolsets.get(info.role);
      return allow ? allow.has(name) : true;
    };
  }
  const tools = [
    pmBriefTool(env),
    pmGateTool(env),
    pmSessionsTool(env),
    pmPhaseTool(env),
    pmCharterTool(env),
    pmHandoverTool(env),
    pmCheckpointTool(env),
    pmSnapshotTool(env),
    pmDiagTool(env, { schedulerReady: () => scheduler !== null, schedulerError: () => schedulerError }),
    pmDriftTool(env),
    pmChangelogTool(env),
    pmTokensTool(env),
    pmPackTool(env),
    pmWorkspaceTool(env),
    pmInitTool(env),
    pmProfileTool(env),
  ];
  const keys = ['brief', 'gate', 'sessions', 'phase', 'charter', 'handover', 'checkpoint', 'snapshot', 'diag', 'drift', 'changelog', 'tokens', 'pack', 'workspace', 'init', 'profile'];
  for (let i = 0; i < tools.length; i++) {
    const key = keys[i];
    try {
      // 名字以工厂自带的为准；工厂没写才用位置表补，且顺序错位时报出来（不再静默错名）。
      if (!tools[i].name) tools[i].name = NAMES[key];
      else if (tools[i].name !== NAMES[key]) initErrors.push('工具名错位：数组第 ' + i + ' 项是 ' + tools[i].name + '，位置表期望 ' + NAMES[key]);
      ctx.tools.register(tools[i], { when: visibleTo(tools[i].name) });
      registered.add(tools[i].name);
    } catch (e) {
      initErrors.push(key + '：' + msgOf(e));
    }
  }

  const peerTools = [
    pmPeerListTool(env),
    pmPeerStatusTool(env),
    pmPeerSendTool(env),
    pmPeerNewTool(env),
    pmPeerRenameTool(env),
    pmPeerPeekTool(env),
  ];
  for (const t of peerTools) {
    try {
      ctx.tools.register(t, { when: visibleTo(t && t.name ? String(t.name) : '') });
      if (t && t.name) registered.add(t.name);
    } catch (e) {
      initErrors.push((t && t.name ? String(t.name) : 'peer_?') + '：' + msgOf(e));
    }
  }

  // ---------------- 会话守卫（Charter §7.2.4）：新建会话与设定角色仅属全局；
  // 会话之间允许直接 peer_send（不必经全局转述），directPeer=off 时退回「只能向全局报告」的旧口径。
  if (cfg.wakeAuthority !== 'off' && typeof ctx.tools.guard === 'function') {
    try {
      ctx.tools.guard((exec) => {
        const nm = exec && exec.name;
        if (nm !== 'peer_send' && nm !== 'peer_new') return undefined;
        const sid = env.selfId(exec) || '';
        const args = (exec && exec.arguments) || {};
        let info;
        try { info = env.roleOf(exec); } catch { info = { role: 'plain', source: 'error' }; }
        const mk = (allow, why) => {
          guardLast = { sid, allow, source: why, title: titleOf(sid) };
          if (allow) return undefined;
          if (nm === 'peer_new') return '会话创建仅属全局：非全局会话不得新建平级会话（杂项自建 Misc 换任除外）。';
          return '会话间通信受限（directPeer=off）：非全局会话只能向现任全局报告，不得唤醒其他会话。';
        };
        if (info.role === 'global') return mk(true, 'global/' + info.source);
        if (nm === 'peer_send') {
          // 会话之间可直接对话；向全局报告也在此路。directPeer=off 才退回旧口径。
          const target = String(args.session_id || '');
          let t = null;
          try { t = target ? infoFor(target, {}) : null; } catch { t = null; }
          if (t && t.role === 'global') return mk(true, 'report-to-global/' + (t.source || ''));
          if (cfg.directPeer !== 'off') return mk(true, 'direct/' + info.role + ' → ' + (t ? t.role : 'unknown'));
          return mk(false, info.source + '/' + info.role + ' → ' + (t ? t.role : 'unknown'));
        }
        // peer_new：只有杂项可以自建 Misc 换任
        const target = String(args.workspace || args.cwd || '').toLowerCase();
        if (info.role === 'misc' && target.indexOf('misc') !== -1) return mk(true, 'misc/' + info.source);
        return mk(false, info.source + '/' + info.role);
      });
    } catch { /* 老版本没有 guard：退化为规则约束 */ }
  }

  // ---------------- 会话生命周期：创建时装配提示段；开轮前按角色表核对一次
  // 工具可见性不在这里处理：0.2.2 起每步条件已按当前角色算好（见 visibleTo），换角色下一轮即生效。
  function scopedMetaOf(h, sid) {
    return { title: (h && h.title) || titleOf(sid), cwd: (h && h.cwd) || '' };
  }
  if (typeof ctx.on === 'function') {
    try {
      // 事件作用域：宿主以 agent 作为事件的作用域载体，插件在根作用域裸注册收不到别的会话的事件。
      // 传 { global: true } 才能收到全部会话的事件（0.2.2 支持；旧内核忽略选项，退回裸注册）。
      const onAgentEvent = (name, fn) => {
        try { ctx.on(name, fn, { global: true }); return true; }
        catch { try { ctx.on(name, fn); return true; } catch (e) { env.log('会话事件监听失败（' + name + '）：' + msgOf(e)); return false; } }
      };
      onAgentEvent('agent/created', (payload) => {
        try {
          const agent = payload && payload.agent ? payload.agent : null;
          if (agent) applyRoleTo(agent);
        } catch (e) { env.log('角色装配失败：' + msgOf(e)); }
      });
      onAgentEvent('agent/disposed', (payload) => {
        try {
          const agent = payload && payload.agent ? payload.agent : null;
          const h = agent && agent.session ? agent.session.header : null;
          const sid = String((h && h.id) || (agent && agent.id) || '');
          if (!sid) return;
          const d = sectionDispose.get(sid);
          if (typeof d === 'function') { try { d(); } catch { /* ignore */ } }
          sectionDispose.delete(sid);
          const ld = legacyRestrict.get(sid);
          if (typeof ld === 'function') { try { ld(); } catch { /* ignore */ } }
          legacyRestrict.delete(sid);
          appliedRole.delete(sid);
          roleCache.delete(sid);
        } catch { /* ignore */ }
      });
      // 开轮前核对：休眠期间角色可能被改过，而宿主恢复同一活体时不保证再发创建事件。
      // 状态切到 running 时核一次，提示段与旧内核的限制同角色表对齐。
      onAgentEvent('agent/status', (payload) => {
        try {
          if (!payload || payload.status !== 'running') return;
          const agent = payload.agent || null;
          if (!agent) return;
          const h = agent.session && agent.session.header ? agent.session.header : null;
          const sid = String((h && h.id) || agent.id || '');
          if (!sid) return;
          const info = infoFor(sid, scopedMetaOf(h, sid));
          if (appliedRole.get(sid) === info.role) return;
          env.log('开轮前换装：' + sid + ' · 已装 ' + (appliedRole.get(sid) || '-') + ' · 目标 ' + info.role);
          applyRoleTo(agent, info);
        } catch (e) { env.log('开轮前装配失败：' + msgOf(e)); }
      });
    } catch (e) {
      initErrors.push('会话事件监听：' + msgOf(e));
    }

    // 插件重新加载（停用再启用、或启动时活体会话早于插件）时，已存在的会话不会再收到
    // 创建事件；这里补一次装配，否则它们的提示段会随旧实例一起消失。
    // agents 未在 inject 里声明，激活瞬间可能还取不到，所以取不到时延迟再试一次。
    const reapplyLive = () => {
      let agents = null;
      try { agents = ctx.agents; } catch { agents = null; }
      if (!agents || typeof agents.list !== 'function') {
        try { agents = typeof ctx.get === 'function' ? ctx.get('agents') : null; } catch { agents = null; }
      }
      if (!agents || typeof agents.list !== 'function') return 0;
      let n = 0;
      for (const a of agents.list()) {
        try { applyRoleTo(a); n++; } catch { /* 单个会话装配失败不影响插件激活 */ }
      }
      if (n > 0) env.log('补装配 ' + n + ' 个活体会话');
      return n;
    };
    try {
      if (reapplyLive() === 0) {
        const t = setTimeout(() => { try { reapplyLive(); } catch { /* ignore */ } }, 1200);
        if (t && typeof t.unref === 'function') t.unref();
      }
    } catch { /* 拿不到 agents 服务就跳过补装配 */ }
  }

  // ---------------- 设置页数据接口：主通道＝DSH 认证的 /api 载体；旧通道＝/dsh-handover HTTP 路由
  try {
    const info = pkgInfo();
    const pageInfo = {
      name: info.name,
      version: info.version,
      tools: tools.length + peerTools.length,
      scheduler: scheduler ? '就绪' : '未就绪' + (schedulerError ? '：' + schedulerError : ''),
    };
    const api = createApi(env, pageInfo);
    env.api = api;
    registerStatusRoute(ctx, env, pageInfo, api);
    registerRpcCarrier(ctx, api, (m) => env.log(m));
  // 预热状态快照：设置页直接取缓存，避免请求等待现算。
    try {
      // 只在「最近 5 分钟有人看过设置页」时预热：没人看就不算，避免空转占宿主主线程。
      const warm = () => {
        if (Date.now() - (env.lastStatusCallAt || 0) > 5 * 60 * 1000) return;
        try { statusSnapshot(env, pageInfo, 'warm'); } catch { /* ignore */ }
      };
      const t0 = setTimeout(warm, 1500);
      if (t0 && typeof t0.unref === 'function') t0.unref();
      const iv = setInterval(warm, 30000);
      if (iv && typeof iv.unref === 'function') iv.unref();
      if (typeof ctx.effect === 'function') ctx.effect(() => () => { clearInterval(iv); }, 'dsh-handover: 状态预热');
    } catch { /* ignore */ }
  } catch (e) {
    initErrors.push('设置页路由：' + msgOf(e));
  }

  // ---------------- 聊天页命令：用户在自己的输入框敲 /allow-compact 即可授权压缩
  // 为什么要有它：设置页要切页面、还要填会话 id，太绕。斜杠命令是「用户亲手敲的一行」，
  // 天然满足「只有用户能产生同意」这条判据，且不产生模型消息、不花 token。
  try {
    const registerAllowCompact = (service) => {
      if (!service || typeof service.register !== 'function') return;
      const d = service.register({
        name: 'allow-compact',
        description: '允许本会话压缩一次（用户授权，5 分钟有效；可带会话短号授权别的会话）',
        input: { hint: '可留空＝本会话；填 8 位短号或 session-id 则授权那个会话' },
        handler: ({ agent, rawInput }) => {
          const arg = String(rawInput || '').trim();
          const sid = arg ? resolveShortSid(env, arg) : (agent && agent.id ? String(agent.id) : '');
          if (!sid) return { kind: 'error', text: '拿不到会话 id：请写成 /allow-compact session-xxxx' };
          const g = grantConsent(sid, '聊天页命令 /allow-compact');
          try { env.log('压缩授权（命令）：' + sid); } catch { /* ignore */ }
          return { kind: 'success', text: '已允许 ' + sid + ' 在 ' + g.minutes + ' 分钟内压缩一次（用掉即失效）。' };
        },
      });
      if (typeof d === 'function' && typeof ctx.effect === 'function') {
        ctx.effect(() => d, 'dsh-handover: /allow-compact');
      }
    };
    // 可选服务：能用 ctx.inject 就走注入（老宿主没有 commands 时插件照常激活），否则退回直取。
    if (typeof ctx.inject === 'function') {
      ctx.inject(['commands'], (scope) => {
        try { registerAllowCompact(scope && scope.commands); } catch (e) { initErrors.push('命令注册：' + msgOf(e)); }
      });
    } else {
      registerAllowCompact(ctx.commands);
    }
  } catch (e) {
    initErrors.push('命令注册：' + msgOf(e));
  }
}