/**
 * 角色装配：会话标题、角色判定、提示段注册与角色设定入口。
 * 共享状态由本模块持有；index.mjs 通过返回的句柄读取，
 * 并在会话销毁时调用 disposeSession 清理。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pick } from './text.mjs';
import { projCacheFileOf } from './sessions.mjs';
import {
  ROLES, resolveRole, sessionMeta, handoverPathFor, toolsetFor,
  readRoles, writeRole as writeRoleStore, assertProjectName, assertTaskName,
} from './role.mjs';
import { manualFor, firstRoundMessageFor } from './manual.mjs';
import { sendPrompt } from './prompt.mjs';
import { routeWorkspace } from './workspace.mjs';
import { stampTz } from './brief.mjs';
import { activeConsentsFor } from './consent.mjs';
import { systemBlock, registrySignature } from './system.mjs';
import { migrateIdentity, removeRegistryProject } from './identity.mjs';
import { loadOffice, lineageKeyOf, syncHolderKind, removeHolder, registerHolder } from './office.mjs';

/** 创建角色装配。runtime 提供 ctx、cfg、env、perStep、registered、initErrors、walkUpToWorkspace。 */
export function createRoleAssembly(runtime) {
  const { ctx, cfg, env, perStep, registered, initErrors, walkUpToWorkspace } = runtime;
  const msgOf = (e) => String(e && e.message ? e.message : e);

  const sectionDispose = new Map();       // sessionId → 撤销提示段
  const appliedText = new Map();          // sessionId → 上次装配的提示段正文（文本未变不重装）
  const systemSig = new Map();            // sessionId → 上次装配时的体系注册签名（热更新）
  const consentSig = new Map();           // sessionId → 上次装配时的授权签名（授权出现或过期时重装）
  const legacyRestrict = new Map();       // sessionId → 撤销限制（仅无按步解析的内核）
  const appliedRole = new Map();          // sessionId → 上次装配的角色
  const roleCache = new Map();            // sessionId → { at, info }（每步过滤用，短 TTL）
  const roleState = { last: null };

  /**
   * 插件卸载时回收挂在会话作用域上的资源。
   * 提示段与旧内核限制由 agent.ctx 持有，不会随插件 fiber 自动释放；
   * 不回收会让已卸载的插件继续占据系统提示词。
   */
  function disposeAll() {
    for (const d of sectionDispose.values()) { try { d(); } catch { /* 段已失效 */ } }
    for (const d of legacyRestrict.values()) { try { d(); } catch { /* 限制已失效 */ } }
    sectionDispose.clear();
    legacyRestrict.clear();
    appliedText.clear();
    systemSig.clear();
    consentSig.clear();
    appliedRole.clear();
    roleCache.clear();
  }
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => disposeAll, 'dsh-handover: 角色提示段回收');
  }

  // ---------------- 会话标题：运行时 header.title 往往为空，改读投影缓存
  function titleOf(sessionId) {
    try {
      const a = ctx.agents && typeof ctx.agents.get === 'function' ? ctx.agents.get(sessionId) : null;
      const t = a && a.session && a.session.header ? String(a.session.header.title || '') : '';
      if (t) return t;
    } catch { /* ignore */ }
    // 只按会话 id 直读单个投影文件；全目录扫描在会话多时每次要几毫秒。
    try {
      const one = projCacheFileOf(String(sessionId || ''));
      const row = one ? pick(one.data, 'record', 'rows', 'title', 'val') : null;
      if (typeof row === 'string') return row;
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

  function scopedMetaOf(h, sid) {
    return { title: (h && h.title) || titleOf(sid), cwd: (h && h.cwd) || '' };
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
    try { writeRoleStore(cfg, sid, { role, project, task, source: 'user' }); }
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

  /** 会话新建后立即按已登记角色装配（不唤醒会话、不投递消息）。 */
  function applyScopedLive(sid, info) {
    try {
      const a = agentOf(String(sid || ''));
      if (!a) return false;
      const i = Object.assign({ role: 'plain', project: '', task: '', source: 'live' }, info || {});
      if (!i.role) i.role = 'plain';
      applyRoleTo(a, i);
      return true;
    } catch { return false; }
  }

  /** 重装某会话的提示段：文档定位写盘后与授权到达后各调用一次；不唤醒会话，不投递消息。 */
  function refreshPromptFor(sid) {
    try {
      const id = String(sid || '');
      if (!id) return false;
      const a = agentOf(id);
      if (!a) return false;
      applyRoleTo(a);
      return true;
    } catch { return false; }
  }

  /** 会话销毁时清空该会话的全部装配状态。 */
  function disposeSession(sid) {
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
  }

  return {
    sectionDispose, appliedText, systemSig, consentSig, legacyRestrict, appliedRole, roleCache, roleState,
    titleOf, agentOf, isChildSession, infoFor, roleMode, handoverInfoFor,
    workspaceForSid, workspaceForAgent, applySection, applyLegacyRestrict, applyRoleTo,
    applyRole, applyScopedLive, refreshPromptFor, scopedMetaOf, disposeSession,
  };
}
