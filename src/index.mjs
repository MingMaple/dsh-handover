/**
 * dsh-handover —— 全局运行期插件。
 * 判定条件写入代码，执行流程写入工具。
 * 规则正文保留在磁盘，需要时用 ho_docmap(action="rules-read") 按节读取（完整流程 doc="runtime"）。
 * 按会话角色装配工具与提示段：全局 5 个工具加 peer、项目与杂项各 4 个加 peer、普通 0 个。
 * 源码不热加载：改动后须重启 DSH。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDir, readJsonDir, pick } from './lib/text.mjs';
import { resolveConfig } from './lib/config.mjs';
import { projCacheDir, readSelfPressure } from './lib/sessions.mjs';
import { createScheduler } from './lib/schedule.mjs';
import { compactInTurn, INLINE_UNAVAILABLE, INLINE_NO_METER, serviceOf } from './lib/engine.mjs';
import { appendRunLog } from './lib/runlog.mjs';
import { createSkipLogger } from './lib/skip-log.mjs';
import { compactionStateOf, stalePressureNote, logRecordsOf, visibleTextOf } from './lib/events.mjs';
import { deriveSegments } from './lib/segments.mjs';
import { extractSnapshot, writeSnapshot } from './lib/checkpoint.mjs';
import { handoverMtimeMs, fileSha256 } from './lib/handover-io.mjs';
import { judgeTrigger } from './lib/triggers.mjs';
import {
  pressureLineText, tierPromptText, hardPromptText,
  successionPromptText, successionBlockText, successionCeilingText, roiAdviceText,
} from './lib/inject.mjs';
import { pressureOf, roiOf, lowRoiStreakOf, normWater } from './lib/pressure.mjs';
import { anchorPathFor, mergeAnchor } from './lib/anchor.mjs';
import { extractConstraints, probeConstraints } from './lib/constraints.mjs';
import { renderCapsule } from './lib/capsule.mjs';
import { readSessionState, writeSessionState, storeInfo as storeInfoOf } from './lib/store.mjs';
import { adoptLegacyStore } from './lib/compat.mjs';
import { judgeAssistantCompact } from './lib/compact-gate.mjs';
import { lintGlobal, lintProject } from './lib/lint.mjs';
import { signalOf } from './lib/abort.mjs';
import { pmStatusTool } from './tools/ho_status.mjs';
import { pmSessionsTool } from './tools/ho_sessions.mjs';
import { pmHandoverTool } from './tools/ho_handover.mjs';
import { pmWorkspaceTool } from './tools/ho_workspace.mjs';
import { pmDocmapTool } from './tools/ho_docmap.mjs';
import { pmPeerTool, collabMemberReason } from './tools/peer.mjs';
import { resolveRegistry } from './lib/registry.mjs';
import { registerStatusRoute } from './lib/webroute.mjs';
import { createApi, statusSnapshot, resolveShortSid } from './lib/api.mjs';
import { registerRpcCarrier } from './lib/rpc-carrier.mjs';
import { NAMES, PEER_NAME } from './lib/names.mjs';
import { readExtraPrompt, writeExtraPrompt, EXTRA_PROMPT_ORDER, EXTRA_PROMPT_SECTION } from './lib/extra-prompt.mjs';
import {
  ROLES, resolveRole, sessionMeta, handoverPathFor, toolsetFor,
  readRoles, writeRole, assertProjectName, assertTaskName,
} from './lib/role.mjs';
import { manualFor, firstRoundMessageFor } from './lib/manual.mjs';
import { sendPrompt } from './lib/prompt.mjs';
import { routeWorkspace } from './lib/workspace.mjs';
import { stampTz } from './lib/brief.mjs';
import { grantConsent, activeConsentsFor } from './lib/consent.mjs';
import { systemBlock, registrySignature } from './lib/system.mjs';
import { migrateIdentity, removeRegistryProject } from './lib/identity.mjs';
import { loadOffice, lineageKeyOf, syncHolderKind, removeHolder, registerHolder } from './lib/office.mjs';
import { moveStatus } from './lib/mover.mjs';
import { judgeRotateGate } from './lib/succession.mjs';

export const name = 'dsh-handover';
// 必需服务（名称已核对）：插件名与内核服务名一一对应。
// dsh-agent→agents、dsh-compaction→compaction、dsh-api-session-controller→sessionController。
// 只 inject 确定存在的服务：多写一个不存在的名称，cordis 会使整个插件静默不激活。
// agents 与 compaction 按运行期解析（ctx[name] → ctx.get(name)）。
// 无法获取时由 ho_status（view="diag"）报出，ho_handover（action="compact"）明确报错。
export const inject = ['tools', 'systemPrompt', 'sessionController'];

/** 自身包信息：dist 内读取 ./package.json，源码树内回退到 ../package.json。 */
function pkgInfo() {
  for (const rel of ['./package.json', '../package.json']) {
    try {
      const j = JSON.parse(fs.readFileSync(new URL(rel, import.meta.url), 'utf8'));
      if (j && j.version) return { name: String(j.name || ''), version: String(j.version) };
    } catch { /* 尝试下一个 */ }
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
  // cwd 的父目录已删除（或 cwd 为盘符根）时，向上无法找到工作区。
  // 若原样返回 start，写操作会在该失效路径上重建一套 _Control_Center。
  // 该目录没有对应工作区，后续流程无法识别。
  // 此时以登记表记录的工作区为准；登记表也查不到时才返回 start。
  try {
    const fromReg = routeWorkspace({ cfg: {} });
    if (fromReg && fromReg !== start && isDir(path.join(fromReg, '_Control_Center'))) return fromReg;
  } catch { /* 登记表无法读取时保持旧行为 */ }
  return start;
}

function msgOf(e) {
  return String(e && e.message ? e.message : e);
}

/**
 * 压缩调度器依赖的 2 个函数：入参为**会话 id**，须按 id 解析角色与交接路径。
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
  const registered = new Set();           // 已注册的工具名（旧内核的限制式裁剪使用）
  // 自 0.2.2 起，工具按「步」解析（tools.resolve）：可用工具集合每步重算，角色过滤写入注册条件。
  // 更早的内核忽略注册选项，只能退回 agent 作用域的 restrict。2 条路径按能力择一，不并行。
  const perStep = (() => { try { return !!(ctx.tools && typeof ctx.tools.resolve === 'function'); } catch { return false; } })();
  const sectionDispose = new Map();       // sessionId → 撤销提示段
  const appliedText = new Map();          // sessionId → 上次装配的提示段正文（文本未变不重装）
  const systemSig = new Map();            // sessionId → 上次装配时的体系注册签名（热更新）
  const consentSig = new Map();           // sessionId → 上次装配时的授权签名（授权出现或过期时重装）
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
    controller: () => serviceOf(ctx, null, 'sessionController'),
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
    selfPressure(id) {
      if (!id) return { used: null, win: null };
      return readSelfPressure(this.cacheDir(), id);
    },
    registry() { return resolveRegistry(ctx); },
    /** 可选旁路模型的句柄；取不到时返回 null，由调用方回退代码抽取。 */
    llm() { return serviceOf(ctx, null, 'llm'); },
    /** 迁移感知：根目录是否已迁移到其他位置（原路径成为 junction）。供提示段与 ho_status（view="diag"）使用。 */
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
        out[name] = !!serviceOf(ctx, null, name);
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
        const v = serviceOf(c, null, name);
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
    /** 自身版本：从 dist/package.json 读取，设置页与 ho_status（view="diag"）共用同一值。 */
    version() {
      try { return pkgInfo().version; } catch { return '?'; }
    },
    /** 当前已装配提示段的会话数（诊断用）。 */
    assembledCount() { return sectionDispose.size; },
    log(m) {
      try { if (ctx.logger && typeof ctx.logger.warn === 'function') ctx.logger.warn(String(m)); } catch { /* ignore */ }
    },
  };

  // ---------------- 会话标题：运行时 header.title 往往为空，改读投影缓存
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
    } catch { /* 回退到列表查找 */ }
    // 宿主的注册表键不保证等于会话 id：无法取到实例时，按会话头 id 在活体列表中再查一次。
    // 缺这一层，休眠会话在设置页修改角色时会被判为「不在内存」，须等重启才装配。
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
   * 仅凭会话头即可判定的子级会话。
   * 子会话与团队成员的会话都带 origin=subagent 或 parentSession。
   * 只读 header，不访问磁盘，可置于「每一步」的条件启用中。
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
  // 写角色表是所有角色变更的唯一入口。
  // 写入后立即使每步过滤的短缓存失效，下一步即按新角色判定。
  env.writeRole = (sid, patch) => {
    const saved = writeRole(cfg, sid, patch);
    roleCache.delete(String(sid || ''));
    return saved;
  };
  // 建会话后的可核验核对：直接读回角色表，避免只写不验。
  env.roleEntryOf = (sid) => {
    const key = String(sid || '');
    if (key === '') return null;
    return readRoles(cfg).sessions[key] || null;
  };

  /** 当前生效的裁剪机制，供 ho_status（view="diag"）报出。 */
  function roleMode() {
    if (cfg.roleGating === 'off') return '关闭（roleGating=off，所有会话可见全部工具）';
    return perStep
      ? '按步过滤（工具表每步重算，换角色下一轮即生效）'
      : '旧式收窄（内核不支持按步解析，改用 agent 作用域 restrict）';
  }

  function handoverInfoFor(info, ws) {
    if (cfg.handoverPath && info.role === 'global') {
      return { path: cfg.handoverPath, kind: 'global', scope: '_Global', role: info.role, project: info.project, task: info.task, ws };
    }
    const t = handoverPathFor(ws, info);
    return Object.assign({ ws, role: info.role, project: info.project, task: info.task }, t);
  }

  /** 仅按会话 id 推断工作区根：优先活体 cwd，其次会话元数据，最后取配置。 */
  function workspaceForSid(sid) {
    if (cfg.workspaceRoot) return String(cfg.workspaceRoot);
    const a = agentOf(sid);
    const cwd = a && a.session && a.session.header ? String(a.session.header.cwd || '') : (sessionMeta(sid).cwd || '');
    return walkUpToWorkspace(cwd || process.cwd());
  }

  env.handoverFor = (exec) => handoverInfoFor(env.roleOf(exec), env.resolveWs(exec));
  /** 跨会话使用：按 id 计算该会话自身的角色与交接路径，不借用调用者上下文。 */
  env.handoverForSid = (sid) => {
    const id = String(sid || '');
    return handoverInfoFor(infoFor(id, {}), workspaceForSid(id));
  };
  env.infoOfSid = (sid) => infoFor(String(sid || ''), {});
  env.agentOfSid = (sid) => agentOf(String(sid || ''));
  env.compactionStateOfSid = (sid) => compactionStateOf(String(sid || ''), null);

  // ---------------- 按角色装配：工具可见性由每步条件即时计算，此处只维护提示段（旧内核另加 restrict）
  function workspaceForAgent(agent) {
    if (cfg.workspaceRoot) return cfg.workspaceRoot;
    const cwd = agent && agent.session && agent.session.header ? String(agent.session.header.cwd || '') : '';
    return walkUpToWorkspace(cwd || process.cwd());
  }

  /** 注册/替换本会话的角色提示段；普通会话不注册。 */
  function applySection(agent, sid, info) {
    let text = '';
    let ws = '';
    try {
      ws = workspaceForAgent(agent);
      // 体系注册与授权状态均按会话实时计算：写入磁盘后重装一次即生效，不另设注入点。
      const system = systemBlock(ws, info);
      const consents = activeConsentsFor(sid);
      text = manualFor(info, { ws, cfg, move: typeof env.moveInfo === 'function' ? env.moveInfo() : null, system, consents });
      consentSig.set(sid, consents.map((r) => r.kind + ':' + r.until).join('|'));
      systemSig.set(sid, registrySignature(ws, info));
    } catch (e) {
      initErrors.push('角色提示段：' + msgOf(e));
      return;
    }
    // 正文未变时不动提示段。宿主把系统提示词作为节点存进历史，撤销后重新注册等同于重写该节点。
    // 重写会使改动点往下的前缀缓存全部失效。
    // 授权签名与体系注册签名会因文件 mtime 抖动而变化，这种抖动不应连带作废前缀缓存。
    // 因此以「正文是否逐字相同」为最终判据。
    if (text && appliedText.get(sid) === text) return;
    const old = sectionDispose.get(sid);
    if (typeof old === 'function') { try { old(); } catch { /* 旧段已失效 */ } }
    sectionDispose.delete(sid);
    appliedText.set(sid, text);
    const sc = agent && agent.ctx ? agent.ctx : null;
    if (text && sc && sc.systemPrompt && typeof sc.systemPrompt.section === 'function') {
      try {
        sectionDispose.set(sid, sc.systemPrompt.section({ name: 'dsh-handover:manual', order: 100, text, interpolate: false }));
      } catch (e) {
        // 插件重载后，旧实例注册在 agent 作用域上的同名提示段仍然存在。
        // 宿主按 agent 持有该段，插件卸载不移除；该段既无法移除，也不能重复注册。
        // 因此视为已就位并沿用旧文本；修改文本须重启 DSH 或重建会话。
        if (!/already registered/.test(msgOf(e))) initErrors.push('角色提示段：' + msgOf(e));
      }
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

  /** 使一个活体会话的提示段与本会话当前角色对齐。info 可传入已解析的角色，省去一次判定。 */
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

  /**
   * 设置角色：写入角色表，需要时完成身份互转。
   * 存活会话当场更换提示段，随后投递首轮指令。
   */
  async function applyRole(input) {
    const i = input || {};
    const sid = String(i.sessionId || '').trim();
    const role = String(i.role || '').trim();
    const project = String(i.project || '').trim();
    const task = String(i.task || '').trim();
    if (!sid) return { ok: false, error: '缺少会话 id' };
    if (ROLES.indexOf(role) === -1) return { ok: false, error: '角色只接受 global、project、misc、plain' };
    if (role === 'project' && !project) return { ok: false, error: '项目角色须填写项目名' };
    if (role === 'misc' && !task) return { ok: false, error: '杂项角色须填写任务名' };
    // 名称要落成目录：不合法时立即拒绝，不待写角色表或拼接路径时才失败。
    if (role === 'project') { try { assertProjectName(project); } catch (e) { return { ok: false, error: msgOf(e) }; } }
    if (role === 'misc') { try { assertTaskName(task); } catch (e) { return { ok: false, error: msgOf(e) }; } }
    const ws = routeWorkspace(env);
    // 仅在无全局会话时允许将会话设为全局；已有在任全局会话时，只允许同一会话重复确认。
    if (role === 'global') {
      try {
        const office = loadOffice(ws);
        const cur = office.lineages['全局'] && office.lineages['全局'].current;
        if (cur && cur.sessionId && String(cur.sessionId) !== sid) {
          return { ok: false, error: '已有全局在任：' + (cur.name || '') + '（' + cur.sessionId + '）。同一时刻仅允许一个全局会话，须先在设置页处理在任会话。' };
        }
      } catch { /* 登记表无法读取时不阻断，按首次设置处理 */ }
    }
    const before = readRoles(cfg).sessions[sid] || {};
    const prevRole = String(before.role || '');
    let migration = null;
    // 项目与杂项互转：先做快照再移动，或按用户选择直接新建。
    if ((prevRole === 'project' || prevRole === 'misc') && (role === 'project' || role === 'misc') && prevRole !== role) {
      try {
        migration = migrateIdentity({
          ws,
          prev: { role: prevRole, project: String(before.project || ''), task: String(before.task || '') },
          next: { role, project, task },
          mode: i.migrate === 'direct' ? 'direct' : 'auto',
        });
      } catch (e) {
        return { ok: false, error: '身份互转未完成：' + msgOf(e) };
      }
    }
    try { writeRole(cfg, sid, { role, project, task, source: 'user' }); }
    catch (e) { return { ok: false, error: '写角色表失败：' + msgOf(e) }; }
    // 注册同步：项目、杂项、全局角色更新名册类别；普通角色只清除注册，文件与目录原位保留。
    try {
      const oldProjectDir = prevRole === 'project' && before.project ? path.join(ws, '_Project_Meta', String(before.project)) : '';
      const oldTaskDir = prevRole === 'misc' && before.task ? path.join(ws, '_Misc', 'tasks', String(before.task)) : '';
      const markerOf = (dir) => path.join(dir, '.deregistered.json');
      if (role === 'project') {
        fs.mkdirSync(path.join(ws, '_Project_Meta', project), { recursive: true });
        try { fs.rmSync(markerOf(path.join(ws, '_Project_Meta', project)), { force: true }); } catch { /* ignore */ }
      }
      if (role === 'misc') {
        fs.mkdirSync(path.join(ws, '_Misc', 'tasks', task), { recursive: true });
        try { fs.rmSync(markerOf(path.join(ws, '_Misc', 'tasks', task)), { force: true }); } catch { /* ignore */ }
      }
      if (role === 'plain') {
        for (const dir of [oldProjectDir, oldTaskDir]) {
          if (!dir || !fs.existsSync(dir)) continue;
          try { fs.writeFileSync(markerOf(dir), JSON.stringify({ at: new Date().toISOString(), sessionId: sid }), 'utf8'); } catch { /* ignore */ }
        }
        if (prevRole === 'project' && before.project) { try { removeRegistryProject(ws, String(before.project)); } catch { /* ignore */ } }
        if (prevRole === 'project' || prevRole === 'misc' || prevRole === 'global') {
          try { removeHolder(ws, { kind: prevRole, project: String(before.project || ''), task: String(before.task || ''), sessionId: sid }); } catch { /* ignore */ }
        }
      } else if (role === 'project' || role === 'misc' || role === 'global') {
        const okKind = syncHolderKind(ws, { kind: role, project, task, sessionId: sid });
        if (!okKind) {
          registerHolder(ws, { kind: role, project, task, name: titleOf(sid) || (role === 'project' ? project : task), sessionId: sid });
        }
      }
    } catch (e) { void e; }
    roleCache.delete(sid);
    const info = { role, project, task, source: 'store', sessionId: sid };
    let live = false;
    try {
      const a = agentOf(sid);
      if (a) { live = true; applyRoleTo(a, info); }
    } catch { /* 活体会话装配失败不影响写盘 */ }
    let delivered = false;
    let error = '';
    let registeredName = '';
    try {
      const lin = { project: role === 'project' ? project : '', task: role === 'misc' ? task : '', kind: role };
      const cur = loadOffice(ws).lineages[lineageKeyOf(lin.kind, lin.project, lin.task)];
      if (cur && cur.current && String(cur.current.sessionId) === sid) registeredName = String(cur.current.name || '');
    } catch { /* 无法读取登记表时不写名字 */ }
    const msg = firstRoundMessageFor(info, {
      previousRole: prevRole,
      migrate: i.migrate === 'direct' ? 'direct' : 'auto',
      moveNote: migration ? migration.summary : '',
      name: registeredName,
    });
    if (i.wake !== false && msg) {
      try {
        const r = await sendPrompt(env.controller(), sid, msg, 'queue');
        delivered = !!(r && r.accepted);
      } catch (e) {
        error = msgOf(e);
      }
    }
    return {
      ok: true, role, project, task, live, delivered, error,
      migrated: migration ? migration.mode : '',
      migrationSummary: migration ? migration.summary : '',
      registeredName,
    };
  }
  env.applyRole = applyRole;

  /** 会话新建后立即按已登记角色装配（不唤醒会话、不投递消息）。 */
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

  /** 重装某会话的提示段：文档定位写盘后与授权到达后各调用一次；不唤醒会话，不投递消息。 */
  env.refreshPromptFor = (sid) => {
    try {
      const id = String(sid || '');
      if (!id) return false;
      const a = agentOf(id);
      if (!a) return false;
      applyRoleTo(a);
      return true;
    } catch { return false; }
  };

  // ---------------- 调度器（续跑文案须按角色取交接路径）
  // 注意：调度器收到的是会话 id 字符串，不是 exec；此处使用按 id 解析的版本，直接读取角色表与磁盘。
  const schedDeps = { ctx, cfg, logger: (ctx.logger || null), roleOf: null, handoverFor: null };
  try {
    scheduler = createScheduler(schedDeps);
    if (typeof ctx.effect === "function") ctx.effect(() => () => { try { scheduler.dispose(); } catch { /* ignore */ } });
  } catch (e) { schedulerError = msgOf(e); }
  Object.assign(schedDeps, schedDepsFor(env));

  // ---------------- 压缩主链：轮首注入压力行、到线注入提示、强制线强制压缩 ----------------
  // 整理线与建议线只注入提示，绝不调用压缩 API；只有强制线由插件兜底压缩。
  // 全部注入都在本会话的步骤边界生成，作为末尾消息追加；不改 system 头，不逐步注入。
  // 触发范围限于会话自身：每次步骤边界只读该会话水位。
  // 不枚举其他会话，也不在启动或空闲时巡检。

  const inline = { inflight: new Set(), lastAt: new Map(), disabled: false, lastError: '' };

  function inlineCooldownLeft(sessionId, ms) {
    if (!ms || ms <= 0) return 0;
    const at = inline.lastAt.get(sessionId);
    return at ? Math.max(0, ms - (Date.now() - at)) : 0;
  }

  function noteInline(msg) {
    try { appendRunLog(msg); } catch { /* ignore */ }
    env.log('dsh-handover: ' + msg);
  }

  function pctText(ratio) {
    return ratio === null || ratio === undefined ? '?' : (Math.round(ratio * 1000) / 10) + '%';
  }

  /**
   * 末尾上下文消息：用户角色、自有 source.kind。
   * 宿主对 system/message 的校验要求 source.kind 为 system-prompt，且系统提示投影会把任何
   * 尾部 system 节点当作最新提示词重新渲染；因此按宿主自带的 runtime-context 同一路径注入，
   * 既不改 system 头，也不破坏前缀缓存。
   */
  function contextMessage(text, kind) {
    const body = String(text || '');
    return {
      id: typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random().toString(16).slice(2),
      role: 'user',
      content: [{ type: 'text', text: body }],
      source: { kind: 'dsh-handover', form: 'snapshot', sections: [{ name: 'dsh-handover:' + String(kind || 'note'), text: body }] },
    };
  }

  function adoptFor(sid) {
    try {
      const r = adoptLegacyStore(sid);
      if (r.adopted.length) env.log('已接入旧位置会话产物：' + sid + '（' + r.adopted.join('、') + '）');
    } catch { /* 兼容模块失败不阻断主流程 */ }
  }

  function readState(sid) {
    adoptFor(sid);
    try { return readSessionState(sid); } catch { return null; }
  }

  function saveState(sid, state) {
    if (!state) return;
    adoptFor(sid);
    try { writeSessionState(sid, state, (m) => env.log(m)); } catch (e) { env.log('会话状态写入失败（' + sid + '）：' + msgOf(e)); }
  }

  /** 表面未闭合工具调用数：工具调用块数减工具结果数。 */
  function openToolCalls(session) {
    try {
      const nodes = session && session.surface ? session.surface.nodes || [] : [];
      let pending = 0;
      for (const seq of nodes) {
        const event = session.eventAt(seq);
        if (!event) continue;
        if (event.type === 'assistant/message') {
          const content = event.data && event.data.message ? event.data.message.content : null;
          if (!Array.isArray(content)) continue;
          for (const block of content) if (block && block.type === 'tool-call') pending += 1;
        } else if (event.type === 'tool/result') {
          pending -= 1;
        }
      }
      return pending;
    } catch { return 0; }
  }

  /** 轮内压缩失败或引擎不可用时保留可见告知；例行成功不投任何消息。 */
  function notifyInlineStop(sessionId, err) {
    const text = [
      '【dsh-handover】现象：轮内压缩未执行。原因：' + msgOf(err) + '。',
      '交接与快照已落盘，历史未被压缩。处置：将本条消息原样告知当前用户；不要改用轮后压缩冒充完成。',
    ].join(String.fromCharCode(10));
    try { sendPrompt(env.controller(), sessionId, text, 'queue').catch(() => {}); } catch { /* ignore */ }
  }

  function autoSnapshotFor(sid) {
    try {
      const recs = logRecordsOf(sid) || [];
      const segs = deriveSegments(recs);
      const sinceSeq = segs.length
        ? segs[segs.length - 1].summarySeq
        : (recs.length > 150 ? recs[recs.length - 150].seq : -1);
      return extractSnapshot(recs, { sid, ws: workspaceForSid(sid), sinceSeq });
    } catch (e) {
      env.log('自动压缩快照失败（' + sid + '）：' + msgOf(e));
      return null;
    }
  }

  /** 锚点路径：会话目录内的 anchor.md；解析失败返回空串。 */
  function anchorFileFor(sid) {
    try { return anchorPathFor(sid); } catch { return ''; }
  }

  /** 取表面事件中的最近用户消息，跳过插件自身注入与子会话。 */
  function recentUserMessages(session, limit) {
    const nodes = session && session.surface ? session.surface.nodes || [] : [];
    const max = Number(limit) > 0 ? Math.floor(limit) : 20;
    const out = [];
    for (let i = nodes.length - 1; i >= 0 && out.length < max; i -= 1) {
      let event = null;
      try { event = session.eventAt ? session.eventAt(nodes[i]) : null; } catch { event = null; }
      if (!event || event.type !== 'user/message') continue;
      const src = event.data && event.data.source ? event.data.source : null;
      if (src && src.kind === 'dsh-handover') continue;
      const text = visibleTextOf(event).trim();
      if (!text) continue;
      out.unshift({ seq: nodes[i], text });
    }
    return out;
  }

  /** 本会话第一条用户消息：目标口径取它，避免后续追问覆盖原始目标。 */
  function firstUserMessage(session) {
    const nodes = session && session.surface ? session.surface.nodes || [] : [];
    for (const seq of nodes) {
      let event = null;
      try { event = session.eventAt ? session.eventAt(seq) : null; } catch { event = null; }
      if (!event || event.type !== 'user/message') continue;
      const src = event.data && event.data.source ? event.data.source : null;
      if (src && src.kind === 'dsh-handover') continue;
      const text = visibleTextOf(event).trim();
      if (text) return { seq, text };
    }
    return null;
  }

  /**
   * 压缩前锚点 patch：目标取首条用户消息首行，约束取规则抽取；
   * 最近一条用户消息与助手自述合并为状态，避免目标随追问漂移。
   */
  function anchorPatchFor(session, status) {
    const messages = recentUserMessages(session, 20);
    const first = firstUserMessage(session);
    const last = messages.length ? messages[messages.length - 1] : null;
    const goalLine = first ? String(first.text).split(String.fromCharCode(10))[0].trim() : '';
    const lastLine = last ? String(last.text).split(String.fromCharCode(10))[0].trim() : '';
    const constraints = extractConstraints(messages, { max: Number(cfg.constraintMax) || 8 });
    const patch = {
      goal: goalLine.length > 200 ? goalLine.slice(0, 200) : goalLine,
      constraints: constraints.map((c) => c.text),
    };
    const parts = [];
    if (lastLine) parts.push(lastLine.length > 80 ? lastLine.slice(0, 80) : lastLine);
    const text = typeof status === 'string' ? status.trim() : '';
    if (text) parts.push(text);
    if (parts.length) {
      const joined = parts.join('；');
      patch.status = joined.length > 200 ? joined.slice(0, 200) : joined;
    }
    return patch;
  }

  /** 写锚点：失败只留痕，不阻断压缩；胶囊降级为「目标未核」。 */
  function writeAnchorFor(sid, session, status) {
    const file = anchorFileFor(sid);
    if (!file) return { ok: false, path: '', sections: null, tokens: 0, overBudget: false };
    try {
      const saved = mergeAnchor(sid, anchorPatchFor(session, status), cfg);
      if (saved.overBudget) {
        noteInline('anchor over budget ' + sid + ' tokens=' + saved.tokens
          + ' limit=' + (Number(cfg.anchorMaxTokens) || 1500));
      }
      return { ok: true, path: saved.path, sections: saved.sections, tokens: saved.tokens, overBudget: saved.overBudget };
    } catch (e) {
      noteInline('anchor write failed ' + sid + ': ' + msgOf(e));
      return { ok: false, path: file, sections: null, tokens: 0, overBudget: false };
    }
  }

  /** 压缩后表面可见文本，供约束探针核对。 */
  function surfaceTextsOf(session) {
    const nodes = session && session.surface ? session.surface.nodes || [] : [];
    const out = [];
    for (const seq of nodes) {
      let event = null;
      try { event = session.eventAt(seq); } catch { event = null; }
      if (!event) continue;
      const text = visibleTextOf(event);
      if (text) out.push(text);
    }
    return out;
  }

  /**
   * 自触发早退留痕：同一会话同一原因 5 分钟内只写一条，避免每步刷屏。
   * 触发未介入时，日志必须能回答「为什么没介入」。
   */
  const noteTriggerSkip = createSkipLogger({ write: appendRunLog, pct: pctText });

  /** 压缩成功后的统一收尾：计数、收益、日志、胶囊与换任提示。 */
  function afterCompact(sid, by, r, extra) {
    const e = extra || {};
    const st = readState(sid) || readSessionState(sid);
    const logState = compactionStateOf(sid, null) || {};
    const beforeCount = Math.max(Number(logState.used) || 0, Number(st.compactions) || 0);
    st.compactions = beforeCount + 1;
    st.notified = {};
    st.skipTierOnce = true;
    st.lastCompactAt = Date.now();
    const tokensBefore = r && typeof r.tokensBefore === 'number' ? r.tokensBefore : null;
    const tokensAfter = r && typeof r.tokensAfter === 'number' ? r.tokensAfter : null;
    const roi = roiOf(tokensBefore, tokensAfter);
    st.tokensBefore = tokensBefore;
    st.tokensAfter = tokensAfter;
    st.roi = roi;
    if (roi !== null) {
      st.roiHistory = (Array.isArray(st.roiHistory) ? st.roiHistory : []).concat([roi]).slice(-3);
    }
    const floor = Number(cfg.roiFloor) || 0.30;
    st.lowRoiStreak = lowRoiStreakOf(st.roiHistory, floor);
    const shadowed = r && r.result && r.result.shadowedTokenCount !== undefined
      ? r.result.shadowedTokenCount
      : (r && r.range && typeof r.range.shadowTokens === 'number' ? r.range.shadowTokens : null);
    noteInline('inline compacted ' + sid + ' by=' + by
      + ' seqs=' + (r && r.range ? r.range.start + '-' + r.range.end : '?')
      + ' shadowed=' + (shadowed === null ? '?' : shadowed)
      + ' tokensBefore=' + (tokensBefore === null ? '?' : tokensBefore)
      + ' tokensAfter=' + (tokensAfter === null ? '?' : tokensAfter)
      + ' roi=' + (roi === null ? '?' : roi.toFixed(3)));
    const max = Number(cfg.maxCompactionsPerSession) || 4;
    noteInline('换任计数 ' + st.compactions + '/' + max);
    const anchor = e.anchor || null;
    const capsuleBody = typeof e.capsuleBody === 'string' ? e.capsuleBody.trim() : '';
    const capsuleSource = e.source === 'assistant' && capsuleBody ? 'assistant' : 'mechanism';
    let missing = [];
    if (capsuleSource === 'mechanism' && anchor && Array.isArray(anchor.constraints)
      && anchor.constraints.length && e.session) {
      const probe = probeConstraints(surfaceTextsOf(e.session), anchor.constraints.map((text) => ({ text })));
      missing = probe.missing;
    }
    st.pendingMessages = Array.isArray(st.pendingMessages) ? st.pendingMessages : [];
    const capsuleText = renderCapsule({
      source: capsuleSource,
      body: capsuleSource === 'assistant' ? capsuleBody : '',
      anchor,
      anchorPath: e.anchorPath || '',
      before: tokensBefore,
      after: tokensAfter,
      shadow: shadowed,
      count: st.compactions,
      max,
      missing,
      cfg,
    });
    const capsuleChars = capsuleText.length;
    const capsuleLimit = Number(cfg.capsuleMaxChars) || 1600;
    const capsuleOver = capsuleChars > capsuleLimit;
    if (capsuleOver) {
      noteInline('capsule over budget ' + sid + ' chars=' + capsuleChars + ' limit=' + capsuleLimit);
    }
    st.pendingMessages.push({ kind: 'post-compact', text: capsuleText });
    if (roi !== null && st.lowRoiStreak >= 2) {
      st.pendingMessages.push({ kind: 'succession-advice', text: roiAdviceText(roi, floor, st.lowRoiStreak) });
      noteInline('低收益换任建议 ' + sid + ' streak=' + st.lowRoiStreak);
    }
    const prompted = Number(st.succession && st.succession.promptedCount) || 0;
    if (st.compactions >= max && prompted < st.compactions) {
      st.succession = { promptedCount: st.compactions, promptedAt: Date.now() };
      st.pendingMessages.push({ kind: 'succession', text: successionPromptText(st.compactions, max, cfg) });
      noteInline('换任提示 ' + sid + ' 计数 ' + st.compactions + '/' + max);
    }
    saveState(sid, st);
    return { st, capsuleChars, capsuleOver, capsuleSource, capsuleBodyChars: capsuleBody.length };
  }

  /** 强制压缩：先写锚点，再压缩；锚点失败只留痕，不阻断压缩。 */
  async function forceCompact(agent, sid, signal) {
    const snap = autoSnapshotFor(sid);
    if (snap) snap.snapshotPath = writeSnapshot(snap).path;
    const anchor = writeAnchorFor(sid, agent.session, '');
    inline.inflight.add(sid);
    const started = Date.now();
    try {
      const r = await compactInTurn(ctx, agent, cfg, signal, { shadowTarget: cfg.shadowTarget });
      if (r && r.status === 'ok') {
        afterCompact(sid, 'force', r, { session: agent.session, anchor: anchor.sections, anchorPath: anchor.path, source: 'mechanism' });
        return r;
      }
      noteInline('inline compact skipped ' + sid + ' reason=' + (r && r.reason ? r.reason : (r && r.status ? r.status : 'unknown')));
      return null;
    } catch (e) {
      const code = e && e.code ? e.code : '';
      const detail = msgOf(e);
      if (code === INLINE_UNAVAILABLE || code === INLINE_NO_METER) {
        inline.disabled = true;
        inline.lastError = detail;
        noteInline('inline compact unavailable ' + sid + ': ' + detail);
        notifyInlineStop(sid, e);
      } else {
        noteInline('inline compact failed ' + sid + ' after ' + (Date.now() - started) + 'ms: ' + detail);
        const aborted = signal && signal.aborted;
        const transient = /busy|already in progress|surface changed|aborted|abort/i.test(detail);
        if (!aborted && !transient) notifyInlineStop(sid, e);
      }
      return null;
    } finally {
      inline.lastAt.set(sid, Date.now());
      inline.inflight.delete(sid);
    }
  }

  /**
   * 单个会话的步骤边界判定：轮次起点只注入水位行；到线判定与强制压缩只在轮内步骤分隔时做。
   * 待注入消息可在任意步骤取走。返回要追加到本步骤末尾的上下文消息。
   */
  async function autoTriggerFor(agent, payload) {
    const out = [];
    const h = agent && agent.session ? agent.session.header : null;
    const sid = String((h && h.id) || (agent && agent.id) || '');
    if (inline.disabled) {
      noteTriggerSkip(sid, 'inline-disabled', null);
      return out;
    }
    if (!sid) {
      noteTriggerSkip(sid, 'no-sid', null);
      return out;
    }
    if (isChildSession(agent)) {
      noteTriggerSkip(sid, 'subagent', null);
      return out;
    }
    let info = null;
    const hit = roleCache.get(sid);
    if (hit && Date.now() - hit.at < 2000) info = hit.info;
    else {
      try { info = infoFor(sid, scopedMetaOf(h, sid)); } catch { info = null; }
      if (info) roleCache.set(sid, { at: Date.now(), info });
    }
    if (!info || !info.role) {
      noteTriggerSkip(sid, 'no-role', null);
      return out;
    }
    if (info.role === 'plain') {
      noteTriggerSkip(sid, 'plain', null);
      return out;
    }
    if (inline.inflight.has(sid)) {
      noteTriggerSkip(sid, 'inline-inflight', null);
      return out;
    }
    if (scheduler && scheduler.pending && typeof scheduler.pending.has === 'function' && scheduler.pending.has(sid)) {
      noteTriggerSkip(sid, 'scheduler-pending', null);
      return out;
    }
    const stepNum = Number(payload && payload.step);
    const atTurnStart = !Number.isFinite(stepNum) || stepNum <= 1;
    const signal = payload ? payload.signal : undefined;
    const st = readState(sid);
    if (!st) return out;

    // 待注入消息：压缩后的胶囊、低收益建议与换任提示；由压缩入口写入，下一处步骤边界取走。
    if (Array.isArray(st.pendingMessages) && st.pendingMessages.length) {
      for (const m of st.pendingMessages) out.push(contextMessage(m.text, m.kind));
      st.pendingMessages = [];
      saveState(sid, st);
    }

    if (atTurnStart) {
      // 轮次起点：只注入水位行并记历史，不做到线判定、不压缩。
      const self = readSelfPressure(projCacheDir(), sid);
      const { used, win } = normWater(self);
      if (used === null || win === null) {
        out.push(contextMessage(pressureLineText(pressureOf({ used: null, win: null, cfg })), 'water'));
        noteTriggerSkip(sid, 'no-pressure', null);
        saveState(sid, st);
        return out;
      }
      st.usageHistory = (Array.isArray(st.usageHistory) ? st.usageHistory : [])
        .concat([{ at: Date.now(), used }])
        .slice(-6);
      const profile = pressureOf({ used, win, cfg, history: st.usageHistory });
      out.push(contextMessage(pressureLineText(profile), 'water'));
      st.lastWaterAt = Date.now();
      if (st.skipTierOnce) st.skipTierOnce = false;
      saveState(sid, st);
      return out;
    }

    // 轮内步骤分隔：到线判定与强制压缩只在此处发生。
    const self = readSelfPressure(projCacheDir(), sid);
    const { used, win } = normWater(self);
    if (used === null || win === null) {
      noteTriggerSkip(sid, 'no-pressure', null);
      return out;
    }
    const profile = pressureOf({ used, win, cfg, history: st.usageHistory });
    const cs = compactionStateOf(sid, null) || {};
    // 两级计数：助手入口与提示在达到 maxCompactionsPerSession 后关闭；强制线兜底到 hardCap。
    const maxCompactions = Number(cfg.maxCompactionsPerSession) || 4;
    const hardCap = Number(cfg.maxCompactionsHardCap) || 6;
    const usedCompactions = Math.max(Number(cs.used) || 0, Number(st.compactions) || 0);
    const ratio = used / win;
    // 闸门取 3 项冷却的最大值：summary 静默期、调度器冷却、轮内压缩冷却。
    // 任一未结束即不判定，避免刚压缩完又在下一步重复压缩。
    const sinceSummary = cs.lastSummaryMs ? Date.now() - cs.lastSummaryMs : Infinity;
    const quietLeft = sinceSummary < 120000 ? 120000 - sinceSummary : 0;
    const schedCool = scheduler && typeof scheduler.cooldownLeft === 'function'
      ? scheduler.cooldownLeft(sid, cfg.triggerCooldownMs)
      : 0;
    const action = judgeTrigger({
      used,
      win,
      bands: profile.bands,
      cfg,
      lockState: cs.lock,
      cooldownLeftMs: Math.max(quietLeft, schedCool, inlineCooldownLeft(sid, cfg.triggerCooldownMs)),
      inTurn: true,
      notifiedSoft: !!(st.notified && st.notified.soft),
      notifiedAdvise: !!(st.notified && st.notified.advise),
    });
    if (action.action === 'notifySoft' || action.action === 'notifyAdvise') {
      const level = action.action === 'notifySoft' ? 'soft' : 'advise';
      st.notified = st.notified && typeof st.notified === 'object' ? st.notified : {};
      st.notified[level] = Date.now();
      if (usedCompactions >= hardCap) {
        out.push(contextMessage(successionCeilingText(usedCompactions, hardCap), 'succession'));
        noteInline('压缩硬上限 ' + sid + ' level=' + level + ' count=' + usedCompactions + '/' + hardCap);
        saveState(sid, st);
        return out;
      }
      if (usedCompactions >= maxCompactions) {
        out.push(contextMessage(successionBlockText(usedCompactions, maxCompactions, cfg), 'succession'));
        noteInline('换任提示 ' + sid + ' level=' + level + ' count=' + usedCompactions + '/' + maxCompactions);
        saveState(sid, st);
        return out;
      }
      st.lastTierPromptAt = Date.now();
      out.push(contextMessage(tierPromptText(level, profile), 'tier-' + level));
      noteInline('提示压缩 ' + sid + ' level=' + level + ' ratio=' + pctText(ratio));
      saveState(sid, st);
      return out;
    }
    if (action.action !== 'force') {
      noteTriggerSkip(sid, 'not-triggered', ratio);
      saveState(sid, st);
      return out;
    }
    if (usedCompactions >= hardCap) {
      // 硬上限：连强制线也不再压缩，只发换任指令。每轮一条，去重留痕。
      out.push(contextMessage(successionCeilingText(usedCompactions, hardCap), 'succession'));
      noteTriggerSkip(sid, 'compaction-limit', ratio);
      saveState(sid, st);
      return out;
    }
    // 强制线：提示后立即强制压缩；助手计数达上限但未到硬上限时仍由插件兜底。
    out.push(contextMessage(hardPromptText(profile), 'hard'));
    st.lastTierPromptAt = Date.now();
    saveState(sid, st);
    const r = await forceCompact(agent, sid, signal);
    if (r) {
      const st2 = readState(sid);
      if (st2 && Array.isArray(st2.pendingMessages) && st2.pendingMessages.length) {
        for (const m of st2.pendingMessages) out.push(contextMessage(m.text, m.kind));
        st2.pendingMessages = [];
        saveState(sid, st2);
      }
    }
    return out;
  }

  /**
   * 步骤边界监听：只处理本次步骤所属的会话，不枚举其他会话；注入一律追加到末尾。
   * 先执行 next() 取得宿主决策，再把消息追加到该决策末尾。
   * 这样宿主拒绝或取消本步骤时原样返回决策，本钩子自身失败也不阻断步骤。
   */
  async function onPreStep(payload, next) {
    let decision;
    try {
      decision = typeof next === 'function' ? await next() : undefined;
    } catch (e) {
      env.log('步骤前置失败：' + msgOf(e));
      throw e;
    }
    try {
      const agent = payload && payload.agent ? payload.agent : null;
      if (!agent || !decision || decision.kind === 'reject') return decision;
      if (payload && payload.signal && payload.signal.aborted) return decision;
      const extra = await autoTriggerFor(agent, payload);
      if (!extra.length) return decision;
      const messages = Array.isArray(decision.messages) ? decision.messages : [];
      return Object.assign({}, decision, { messages: [...messages, ...extra] });
    } catch (e) {
      env.log('到线判定失败：' + msgOf(e));
      return decision;
    }
  }

  if (typeof ctx.on === 'function') {
    const listen = (opts) => ctx.on('agent/pre-step', onPreStep, opts);
    try { listen({ global: true }); }
    catch {
      try { listen(); }
      catch (e) { initErrors.push('步骤边界监听：' + msgOf(e)); }
    }
  }

  // ---------------- 压缩入口与换任硬闸：供工具与换任流程调用 ----------------

  /** 助手执行入口：轮内压缩，零可见消息。先写锚点，再压缩。 */
  env.assistantCompact = async (exec, opts) => {
    const a = opts || {};
    const agent = exec && exec.agent ? exec.agent : null;
    const sid = env.selfId(exec);
    if (!agent || !sid) return { ok: false, reason: '未取得本会话或会话不在内存中。' };
    const capsule = typeof a.capsule === 'string' ? a.capsule.trim() : '';
    if (!capsule) return { ok: false, reason: '缺少 `capsule` 或正文为空。' };
    const info = env.roleOf(exec) || {};
    const st = readState(sid) || {};
    const cs = compactionStateOf(sid, exec) || {};
    const anchorPath = anchorFileFor(sid);
    let anchorWritable = false;
    if (anchorPath) {
      try { fs.mkdirSync(path.dirname(anchorPath), { recursive: true }); anchorWritable = true; } catch { anchorWritable = false; }
    }
    const mode = a.mode === 'aggressive' || a.mode === 'minimal' ? a.mode : 'auto';
    const shadowTarget = mode === 'aggressive' ? 0.70 : mode === 'minimal' ? 0.40 : (Number(cfg.shadowTarget) || 0.55);
    const gate = judgeAssistantCompact({
      sid,
      role: info.role,
      anchorPath,
      anchorWritable,
      lockState: cs.lock || 'clean',
      inflight: inline.inflight.has(sid),
      schedulerPending: !!(scheduler && scheduler.pending && typeof scheduler.pending.has === 'function' && scheduler.pending.has(sid)),
      pendingCompaction: false,
      pendingToolCalls: openToolCalls(agent.session),
      compactionCount: Math.max(Number(cs.used) || 0, Number(st.compactions) || 0),
      maxCompactions: Number(cfg.maxCompactionsPerSession) || 4,
    });
    if (!gate.ok) return { ok: false, reason: gate.reason, checks: gate.checks };
    inline.inflight.add(sid);
    const started = Date.now();
    try {
      const snap = autoSnapshotFor(sid);
      if (snap) snap.snapshotPath = writeSnapshot(snap).path;
      const anchor = writeAnchorFor(sid, agent.session, a.status);
      const r = await compactInTurn(ctx, agent, cfg, signalOf(exec), {
        shadowTarget,
        keepMinMessages: cfg.keepMinMessages,
        minKeepTokens: cfg.minKeepTokens,
        boundary: a.boundary === true,
        mode,
      });
      if (r && r.status === 'ok') {
        const compacted = afterCompact(sid, 'assistant', r, {
          session: agent.session,
          anchor: anchor.sections,
          anchorPath: anchor.path,
          source: 'assistant',
          capsuleBody: capsule,
        });
        const after = readState(sid) || {};
        const max = Number(cfg.maxCompactionsPerSession) || 4;
        return {
          ok: true,
          status: 'ok',
          tokensBefore: r.tokensBefore,
          tokensAfter: r.tokensAfter,
          roi: roiOf(r.tokensBefore, r.tokensAfter),
          anchorPath: anchor.path || anchorPath,
          anchorTokens: anchor.tokens || 0,
          anchorOverBudget: anchor.overBudget === true,
          capsuleChars: compacted.capsuleChars,
          capsuleBodyChars: compacted.capsuleBodyChars,
          capsuleSource: compacted.capsuleSource,
          capsuleOverBudget: compacted.capsuleOver,
          remaining: Math.max(0, max - (Number(after.compactions) || 0)),
          mode,
          boundary: a.boundary === true,
        };
      }
      noteInline('inline compact skipped ' + sid + ' reason=' + (r && r.reason ? r.reason : (r && r.status ? r.status : 'unknown')));
      return { ok: false, status: r && r.status ? r.status : 'no-range', reason: '本轮没有可压缩范围或表面不一致：' + (r && r.reason ? r.reason : 'unknown') };
    } catch (e) {
      const detail = msgOf(e);
      noteInline('inline compact failed ' + sid + ' by=assistant after ' + (Date.now() - started) + 'ms: ' + detail);
      return { ok: false, status: 'failed', reason: detail };
    } finally {
      inline.lastAt.set(sid, Date.now());
      inline.inflight.delete(sid);
    }
  };

  /** 交接步骤留痕：read → archive → new；rotate 单独记录换任依据，供换任硬闸核验。 */
  env.noteHandoverStep = (exec, kind, data) => {
    const sid = env.selfId(exec);
    if (!sid) return;
    const st = readState(sid) || {};
    const flow = st.handoverFlow && typeof st.handoverFlow === 'object' ? st.handoverFlow : {};
    const now = Date.now();
    if (kind === 'read') {
      flow.readAt = now;
      flow.readPath = String((data && data.path) || '');
    } else if (kind === 'archive') {
      flow.archiveAt = now;
      flow.archivePath = String((data && data.dest) || '');
      flow.archiveSha256 = String((data && data.sha256) || '');
    } else if (kind === 'new') {
      flow.newAt = Number(data && data.mtime) || now;
      flow.newPath = String((data && data.path) || '');
    } else if (kind === 'rotate') {
      flow.rotatedAt = Number(data && data.at) || now;
      flow.rotatePath = String((data && data.path) || '');
      flow.rotateSha256 = String((data && data.sha256) || '');
      flow.rotateNoArchive = !!(data && data.archived === false);
    }
    st.handoverFlow = flow;
    saveState(sid, st);
  };

  /** 换任硬闸：以 rotate 留痕为准，判据集中在 lib/succession.mjs。 */
  env.successionGate = (exec) => {
    const sid = env.selfId(exec);
    const info = env.roleOf(exec) || {};
    const hp = env.handoverFor(exec) || {};
    const st = readState(sid || '') || {};
    const flow = st.handoverFlow && typeof st.handoverFlow === 'object' ? st.handoverFlow : {};
    let lint = { verdict: '读不到', reasons: ['无交接路径'] };
    if (hp.path) {
      try { lint = info.role === 'global' ? lintGlobal(hp.path) : lintProject(hp.path); } catch (e) { lint = { verdict: '读不到', reasons: [msgOf(e)] }; }
    }
    const cs = compactionStateOf(sid, exec) || {};
    const schedPending = !!(scheduler && scheduler.pending && typeof scheduler.pending.has === 'function' && scheduler.pending.has(sid));
    return judgeRotateGate({
      flow,
      archiveSha256: flow.archivePath ? fileSha256(flow.archivePath) : '',
      archiveMtimeMs: flow.archivePath ? (handoverMtimeMs(flow.archivePath) || 0) : 0,
      handoverMtimeMs: hp.path ? handoverMtimeMs(hp.path) : null,
      lint,
      lock: cs.lock || 'clean',
      compactionPending: inline.inflight.has(sid) || schedPending,
      openToolCalls: openToolCalls(exec && exec.agent ? exec.agent.session : null),
    });
  };

  /** 供 ho_status 读取会话状态与存储位置。 */
  env.sessionState = (exec) => {
    const sid = env.selfId(exec);
    return sid ? readState(sid) : null;
  };
  env.storeInfo = (exec) => {
    const sid = env.selfId(exec);
    return sid ? storeInfoOf(sid) : null;
  };
  env.compactionLimit = () => Number(cfg.maxCompactionsPerSession) || 4;
  env.inlineRunning = (sid) => inline.inflight.has(String(sid || ''));

  // ---------------- 用户全局前置提示词（段序 950，位于工具段之前）
  // 与插件自身的会话约束无关：仅在用户开启且内容非空时注册；关闭或留空时不占用注入位置。
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

  // ---------------- 工具注册（5 个 ho_* 与 1 个 peer）
  // 自 0.2.2 起，工具按「步」解析：可用工具集合每一步重算。子会话排除与角色过滤在此一并完成，
  // 不再另用 agent 作用域 restrict；与 restrict 并用时，换角色或须等待重启，或互相覆盖。
  const roleToolsets = new Map(ROLES.map((r) => [r, new Set(toolsetFor(r).allow)]));
  /** 每步过滤：子会话一律不可见；角色按当前角色表计算；无 agent 的路径（命令行、演练）放行。 */
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
    pmStatusTool(env, { schedulerReady: () => scheduler !== null, schedulerError: () => schedulerError }),
    pmHandoverTool(env),
    pmDocmapTool(env),
    pmSessionsTool(env),
    pmWorkspaceTool(env),
  ];
  const keys = ['status', 'handover', 'docmap', 'sessions', 'workspace'];
  for (let i = 0; i < tools.length; i++) {
    const key = keys[i];
    try {
      // 名称以工厂自带的为准；工厂未写时才用位置表补充。顺序错位时报告，避免静默使用错误名称。
      if (!tools[i].name) tools[i].name = NAMES[key];
      else if (tools[i].name !== NAMES[key]) initErrors.push('工具名错位：数组第 ' + i + ' 项是 ' + tools[i].name + '，位置表期望 ' + NAMES[key]);
      ctx.tools.register(tools[i], { when: visibleTo(tools[i].name) });
      registered.add(tools[i].name);
    } catch (e) {
      initErrors.push(key + '：' + msgOf(e));
    }
  }

  const peerTools = [pmPeerTool(env)];
  for (const t of peerTools) {
    try {
      ctx.tools.register(t, { when: visibleTo(t && t.name ? String(t.name) : '') });
      if (t && t.name) registered.add(t.name);
    } catch (e) {
      initErrors.push((t && t.name ? String(t.name) : 'peer') + '：' + msgOf(e));
    }
  }

  // ---------------- 会话守卫（Charter §7.2.4）：新建会话与设置角色仅属全局；
  // 会话之间可直接用 peer（action=send）通信，无须经全局转述。
  // directPeer=off 时退回「只能向全局报告」的旧口径。
  if (cfg.wakeAuthority !== 'off' && typeof ctx.tools.guard === 'function') {
    try {
      ctx.tools.guard((exec) => {
        const nm = exec && exec.name;
        if (nm !== PEER_NAME) return undefined;
        let args = (exec && exec.arguments) || {};
        if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
        const action = String(args.action || '');
        // list／status／peek／rename 的权限由工具内部按角色判定，此处只处理 2 类有外部影响的动作。
        if (action !== 'send' && action !== 'new') return undefined;
        const sid = env.selfId(exec) || '';
        let info;
        try { info = env.roleOf(exec); } catch { info = { role: 'plain', source: 'error' }; }
        const mk = (allow, why) => {
          guardLast = { sid, allow, source: why, title: titleOf(sid) };
          if (allow) return undefined;
          if (action === 'new') return '会话创建仅属全局：非全局会话不得新建平级会话（杂项会话建在 Misc 下者除外）。';
          return '会话间通信受限（directPeer=off）。非全局会话只能向在任全局会话报告，不得唤醒其他会话。';
        };
        if (info.role === 'global') return mk(true, '全局角色');
        if (action === 'send') {
          // 会话之间可直接通信；向全局报告亦走此路径。仅 directPeer=off 时退回旧口径。
          const target = String(args.session_id || '');
          let t = null;
          try { t = target ? infoFor(target, {}) : null; } catch { t = null; }
          const tRole = t ? t.role : '未知';
          if (t && t.role === 'global') return mk(true, '向在任全局会话报告');
          if (cfg.directPeer !== 'off') return mk(true, '会话之间直接通信（' + info.role + ' 至 ' + tRole + '）');
          return mk(false, 'directPeer=off：仅允许向全局报告（' + info.role + ' 至 ' + tRole + '）');
        }
        // action=new：只有杂项会话可以建在 Misc 下
        const target = String(args.workspace || args.cwd || '').toLowerCase();
        if (info.role === 'misc' && target.indexOf('misc') !== -1) return mk(true, '杂项会话新建于 Misc');
        return mk(false, '非全局角色不得新建平级会话（' + info.role + '）');
      });
    } catch { /* 旧版本无 guard：退化为规则约束 */ }
  }

  // ---------------- 协作守卫：协作注册期间，被交办方不得经由 DSH 自带的 send_message 发送明文消息。
  // 不改动 DSH 本体，只挂一层工具守卫；普通会话与普通对话不受影响。
  if (typeof ctx.tools.guard === 'function') {
    try {
      ctx.tools.guard((exec) => {
        const nm = exec && exec.name;
        if (nm !== 'send_message') return undefined;
        const sid = env.selfId(exec) || '';
        let why = '';
        try { why = collabMemberReason(sid); } catch { why = ''; }
        if (!why) return undefined;
        guardLast = { sid, allow: false, source: '协作注册', title: titleOf(sid) };
        return why;
      });
    } catch { /* 旧版本无 guard：退化为规则约束 */ }
  }

  // ---------------- 会话生命周期：创建时装配提示段；开轮前按角色表核对一次
  // 此处不处理工具可见性：自 0.2.2 起，每步条件已按当前角色计算（见 visibleTo），换角色下一轮即生效。
  function scopedMetaOf(h, sid) {
    return { title: (h && h.title) || titleOf(sid), cwd: (h && h.cwd) || '' };
  }
  if (typeof ctx.on === 'function') {
    try {
      // 事件作用域：宿主以 agent 作为事件的作用域载体。
      // 插件在根作用域直接注册时，收不到其他会话的事件。传入 { global: true } 才能收到全部会话的事件（0.2.2 支持；旧内核忽略该项，退回直接注册）。
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
          appliedText.delete(sid);
          systemSig.delete(sid);
          consentSig.delete(sid);
          roleCache.delete(sid);
        } catch { /* ignore */ }
      });
      // 开轮前核对：休眠期间角色可能已被修改，宿主恢复同一活体时不保证再次发出创建事件。
      // 状态切换到 running 时核对一次，使提示段与旧内核的限制同角色表对齐。
      onAgentEvent('agent/status', (payload) => {
        try {
          if (!payload) return;
          const agent = payload.agent || null;
          if (!agent) return;
          const h = agent.session && agent.session.header ? agent.session.header : null;
          const sid = String((h && h.id) || agent.id || '');
          if (!sid) return;
          if (payload.status !== 'running') return;
          const info = infoFor(sid, scopedMetaOf(h, sid));
          // 角色未变时仍须核对授权签名与体系注册签名：授权到达或注册改写后，下一轮即应看到新内容。
          let sig = '';
          try { sig = activeConsentsFor(sid).map((r) => r.kind + ':' + r.until).join('|'); } catch { sig = ''; }
          let sysSig = '';
          try { sysSig = registrySignature(workspaceForAgent(agent), info); } catch { sysSig = ''; }
          if (appliedRole.get(sid) === info.role && consentSig.get(sid) === sig && systemSig.get(sid) === sysSig) return;
          env.log('开轮前重装提示段：' + sid + ' · 已装配 ' + (appliedRole.get(sid) || '-') + ' · 目标 ' + info.role);
          applyRoleTo(agent, info);
        } catch (e) { env.log('开轮前装配失败：' + msgOf(e)); }
      });
    } catch (e) {
      initErrors.push('会话事件监听：' + msgOf(e));
    }

    // 插件重新加载（停用后启用，或启动时活体会话早于插件）时，已存在的会话不再收到
    // 创建事件；此处补充一次装配，否则其提示段会随旧实例一起消失。
    // agents 未在 inject 中声明，激活瞬间可能尚未就绪，故首次未取到时延迟重试一次。
    const reapplyLive = () => {
      let agents = serviceOf(ctx, null, 'agents');
      if (!agents || typeof agents.list !== 'function') return 0;
      let n = 0;
      for (const a of agents.list()) {
        try {
          // 插件重载时正在运行的会话不再收到 running 事件，此处补记轮内状态，
          // 否则提醒须待下一轮才判定。
          const h = a && a.session && a.session.header ? a.session.header : null;
          const sid = String((h && h.id) || (a && a.id) || '');
          applyRoleTo(a); n++;
        } catch { /* 单个会话装配失败不影响插件激活 */ }
      }
      if (n > 0) env.log('补充装配 ' + n + ' 个活体会话');
      return n;
    };
    try {
      if (reapplyLive() === 0) {
        let disposed = false;
        const t = setTimeout(() => {
          if (disposed) return;
          try { reapplyLive(); } catch { /* ignore */ }
        }, 1200);
        if (t && typeof t.unref === 'function') t.unref();
        // 必须随插件卸载清理：只 unref 不清除时，重载后的旧实例仍会遍历活体重新装配，
        // 既拖慢首轮，也会把「同名段已注册」一类的失败塞进 initErrors。
        if (typeof ctx.effect === 'function') {
          ctx.effect(() => () => { disposed = true; clearTimeout(t); }, 'dsh-handover: 补充装配重试');
        }
      }
    } catch { /* 无法取得 agents 服务时跳过补充装配 */ }
  }

  // ---------------- 设置页数据接口：主通道为 DSH 认证的 /api 载体，旧通道为 /dsh-handover HTTP 路由
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
    // 预热状态快照：设置页直接读取缓存，避免请求时现算等待。
    try {
      // 仅在最近 5 分钟内有人查看设置页时预热：无人查看即不计算，避免空转占用宿主主线程。
      const warm = () => {
        if (Date.now() - (env.lastStatusCallAt || 0) > 5 * 60 * 1000) return;
        try { statusSnapshot(env, pageInfo, 'warm'); } catch { /* ignore */ }
      };
      // 预热间隔必须大于快照自身的缓存有效期，否则每次心跳都恰好过期、等于全量现算。
      const t0 = setTimeout(warm, 1500);
      if (t0 && typeof t0.unref === 'function') t0.unref();
      const iv = setInterval(warm, 60000);
      if (iv && typeof iv.unref === 'function') iv.unref();
      if (typeof ctx.effect === 'function') ctx.effect(() => () => { clearTimeout(t0); clearInterval(iv); }, 'dsh-handover: 状态预热');
    } catch { /* ignore */ }
  } catch (e) {
    initErrors.push('设置页路由：' + msgOf(e));
  }

  // ---------------- 聊天页命令：用户在输入框输入 /allow-reset 即可授权上下文重置
  // 设计理由：设置页须切换页面并填写会话 id，操作步骤较多。斜杠命令由用户亲手输入，
  // 天然满足「同意只能由用户作出」的判据，且不产生模型消息、不消耗 token。
  try {
    const allowCommands = [
      {
        name: 'allow-reset',
        description: '允许本会话换任一次（经 rotate 重写交接，换到接任会话；由当前用户授权，5 分钟有效）',
        hint: '可留空，默认授权本会话；填写 8 位短号或 session-id 则授权对应会话',
        kind: 'succeed',
        note: '聊天页命令 /allow-reset',
        action: '上下文重置',
      },
    ];
    const registerAllow = (service) => {
      if (!service || typeof service.register !== 'function') return;
      for (const cmd of allowCommands) {
        const d = service.register({
          name: cmd.name,
          description: cmd.description,
          input: { hint: cmd.hint },
          handler: ({ agent, rawInput }) => {
            const arg = String(rawInput || '').trim();
            const sid = arg ? resolveShortSid(env, arg) : (agent && agent.id ? String(agent.id) : '');
            if (!sid) return { kind: 'error', text: '无法获取会话 id：请写成 /' + cmd.name + ' session-xxxx' };
            const g = grantConsent(sid, cmd.note, cmd.kind);
            // 授权到达后立即重装提示段：目标会话下一轮即可看到该行（当前空闲亦然）。
            try { env.refreshPromptFor(sid); } catch { /* 装配失败不影响授权本身 */ }
            try { env.log(cmd.action + '授权（命令）：' + sid); } catch { /* ignore */ }
            return { kind: 'success', text: '已允许 ' + sid + ' 在 ' + g.minutes + ' 分钟内' + cmd.action + '一次（用后即失效）。' };
          },
        });
        if (typeof d === 'function' && typeof ctx.effect === 'function') {
          ctx.effect(() => d, 'dsh-handover: /' + cmd.name);
        }
      }
    };
    // 可选服务：可用 ctx.inject 时走注入（旧宿主没有 commands 时插件照常激活），否则直接获取。
    if (typeof ctx.inject === 'function') {
      ctx.inject(['commands'], (scope) => {
        try { registerAllow(scope && scope.commands); } catch (e) { initErrors.push('命令注册：' + msgOf(e)); }
      });
    } else {
      registerAllow(ctx.commands);
    }
  } catch (e) {
    initErrors.push('命令注册：' + msgOf(e));
  }

  // 插件重载后，已存在的会话不会自动重装提示段，故补注册提醒段。
  // 角色提示段（manual）由宿主按 agent 持有，同名段无法修改文本；提醒段为新段，可以补注册。
  try {
    const timer = setTimeout(() => {
      Promise.resolve().then(async () => {
        try {
          const controller = typeof env.controller === 'function' ? env.controller() : null;
          if (!controller || typeof controller.list !== 'function') return;
          const rows = await controller.list();
          for (const row of rows || []) {
            if (!row || row.agentAvailable !== true) continue;
            const info = env.infoOfSid(row.sessionId);
            if (!info || ['global', 'project', 'misc'].indexOf(info.role) === -1) continue;
            env.refreshPromptFor(row.sessionId);
          }
        } catch (e) { void e; }
      });
    }, 1500);
    if (typeof ctx.effect === 'function') ctx.effect(() => () => clearTimeout(timer), 'dsh-handover: 启动补注册提醒段');
  } catch (e) {
    initErrors.push('启动补注册：' + msgOf(e));
  }
}