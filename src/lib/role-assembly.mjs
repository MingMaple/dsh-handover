/**
 * 角色装配：会话标题、角色判定、提示段注册与角色设定入口。
 * 共享状态由本模块持有；index.mjs 通过返回的句柄读取，
 * 并在会话销毁时调用 disposeSession 清理。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pick, NL } from './text.mjs';
import { projCacheFileOf } from './sessions.mjs';
import {
  ROLES, PENDING_MIGRATION, resolveRole, sessionMeta, handoverPathFor, toolsetFor, layoutOf, layoutRootRel, layoutMetaRel,
  readRoles, writeRole as writeRoleStore, assertProjectName, assertTaskName, roleFromPath,
} from './role.mjs';
import { manualFor, firstRoundMessageFor } from './manual.mjs';
import { sendPrompt } from './prompt.mjs';
import { routeWorkspace } from './workspace.mjs';
import { stampTz } from './brief.mjs';
import { activeConsentsFor } from './consent.mjs';
import { systemBlock, registrySignature, syncGlobalRefs } from './system.mjs';
import { migrateIdentity } from './identity.mjs';
import { scanRoots } from './path-scan.mjs';
import { loadOffice, lineageKeyOf, syncHolderKind, removeHoldersBySession, registerHolder, nextName } from './office.mjs';
import { placeSession, placeNotice, workspaceTargetFor } from './place.mjs';
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
      // 装配只认角色注册文件：标题、cwd 与首条提示不再参与（D-105）。
      registeredOnly: true,
    });
  }

  /** 当前生效的裁剪机制，供 ho_status（view="diag"）报出。 */
  function roleMode() {
    if (cfg.roleGating === 'off') return '关闭（roleGating=off，除子会话外的所有会话可见全部工具）';
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

  /**
   * 唯一的工作区解析入口：配置根 → 会话 cwd 向上 → 登记表路由（D-103）。
   * 角色写入、在任登记与提示段都走这一条，避免同一会话落到 2 个工作区。
   */
  function workspaceFor(cwd) {
    if (cfg.workspaceRoot) return String(cfg.workspaceRoot);
    const fromCwd = cwd ? walkUpToWorkspace(cwd) : '';
    return fromCwd || routeWorkspace(env) || '';
  }

  /** 仅按会话 id 推断工作区根：优先活体 cwd，其次会话元数据。 */
  function workspaceForSid(sid) {
    if (cfg.workspaceRoot) return String(cfg.workspaceRoot);
    const a = agentOf(sid);
    const cwd = a && a.session && a.session.header ? String(a.session.header.cwd || '') : (sessionMeta(sid).cwd || '');
    return workspaceFor(cwd);
  }

  // ---------------- 按角色装配：工具可见性由每步条件即时计算，此处只维护提示段（旧内核另加 restrict）
  function workspaceForAgent(agent) {
    if (cfg.workspaceRoot) return cfg.workspaceRoot;
    const cwd = agent && agent.session && agent.session.header ? String(agent.session.header.cwd || '') : '';
    return workspaceFor(cwd);
  }

  /** 注册/替换本会话的角色提示段；普通会话不注册。wsOpt 由 applyRole 传入，保证与本会话的工作区同源。 */
  function applySection(agent, sid, info, wsOpt) {
    let text = '';
    let ws = '';
    try {
      ws = wsOpt || workspaceForAgent(agent);
      // 体系注册与授权状态均按会话实时计算：写入磁盘后重装一次即生效，不另设注入点。
      const system = systemBlock(ws, info);
      const consents = activeConsentsFor(sid);
      text = manualFor(info, {
        ws, cfg,
        move: typeof env.moveInfo === 'function' ? env.moveInfo() : null,
        system, consents,
        guard: typeof env.guardAvailable === 'function' ? env.guardAvailable() : true,
      });
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
    const sc = agent && agent.ctx ? agent.ctx : null;
    let placed = true;
    if (text && sc && sc.systemPrompt && typeof sc.systemPrompt.section === 'function') {
      try {
        sectionDispose.set(sid, sc.systemPrompt.section({ name: 'dsh-handover:manual', order: 100, text, interpolate: false }));
      } catch (e) {
        // 插件重载后，旧实例注册在 agent 作用域上的同名提示段仍然存在。
        // 宿主按 agent 持有该段，插件卸载不移除；该段既无法移除，也不能重复注册。
        // 因此视为已就位并沿用旧文本；修改文本须重启 DSH 或重建会话。
        if (/already registered/.test(msgOf(e))) placed = true;
        else { placed = false; initErrors.push('角色提示段：' + msgOf(e)); }
      }
    }
    // 只有确认就位才记正文：注册失败时保留空值，下一次装配会真正重试；
    // 先记后注册会让该会话整个生命周期都缺角色提示段（D-102）。
    if (placed) appliedText.set(sid, text);
    else appliedText.delete(sid);
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
  /**
   * 分叉继承：宿主分叉只复制历史，不复制角色条目（header 的 isSeeded 为真即分叉，新会话为假）。
   * 注册是家族属性，可沿用；在任是唯一属性，绝不随分叉复制，故此处不碰登记表。
   * 角色按会话工作目录推断（项目库、杂项任务目录）；推不出或落在全局根时不动，留给用户显式设定。
   * @returns {object|null} 新写入的条目；未处理时返回 null
   */
  function inheritForkRole(sid, agent) {
    const h = agent && agent.session ? agent.session.header : null;
    if (!h || h.isSeeded !== true) return null;
    try {
      if (readRoles(cfg).sessions[sid]) return null;
    } catch { return null; }
    let byPath = null;
    try { byPath = roleFromPath(String(h.cwd || '')); } catch { byPath = null; }
    if (!byPath || (byPath.role !== 'project' && byPath.role !== 'misc')) return null;
    const name = byPath.role === 'project' ? byPath.project : byPath.task;
    try {
      const entry = writeRoleStore(cfg, sid, {
        role: byPath.role, project: byPath.project || '', task: byPath.task || '',
        source: 'fork', layout: byPath.role, layoutName: name,
      });
      env.log('分叉继承注册：' + sid + ' → ' + (byPath.role === 'project' ? '项目「' + name + '」' : '杂项「' + name + '」') + '（在任未变）');
      // 分叉的目录通常就是角色目录，顺手挂进对应工作区，侧栏才归到同一组；挂不上不影响角色。
      try { placeSession(env, sid, { role: byPath.role, project: byPath.project || '', task: byPath.task || '' }, workspaceForAgent(agent)).catch(() => { }); } catch { /* 无注册表时跳过 */ }
      return entry;
    } catch (e) {
      env.log('分叉继承失败：' + msgOf(e));
      return null;
    }
  }

  function applyRoleTo(agent, infoOpt, wsOpt) {
    const h = agent && agent.session ? agent.session.header : null;
    const sid = String((h && h.id) || (agent && agent.id) || '');
    if (!sid) return;
    // 子会话一律不装配：即使标题含「全局」或角色表里有条目，也不注册提示段（D-105）。
    if (isChildSession(agent)) return;
    inheritForkRole(sid, agent);
    let info = infoOpt || null;
    if (!info) {
      try { info = infoFor(sid, scopedMetaOf(h, sid)); } catch { return; }
    }
    applySection(agent, sid, info, wsOpt);
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
    const ws = workspaceForSid(sid);
    // 无工作区根即拒绝写入，避免在进程目录建出孤立体系（D-112）。
    if (!ws) {
      return { ok: false, error: '解析不到工作区根：未写入角色表、未建立目录，也未登记在任。请确认当前目录位于 _Control_Center 所在的工作区，或在设置页接入工作区。' };
    }
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
    const prevProject = String(before.project || '');
    const prevTask = String(before.task || '');
    const prevPending = before.pending && before.pending.kind === PENDING_MIGRATION ? before.pending : null;
    // 迁移方式：缺省 ask（先问后迁）。显式 auto 与 direct 保持 1.0.2 语义，不问也不留 pending。
    const mode = i.migrate === 'direct' ? 'direct' : i.migrate === 'auto' ? 'auto' : 'ask';
    const sameIdentity = prevRole === role && prevProject === project && prevTask === task;
    // 同一身份：不写盘、不登记。要唤醒时只补投首轮流程消息，避免「确认设置」与「唤醒」2 步
    // 因为第二次点击被判成重复设置而丢掉首轮流程。
    if (sameIdentity && !prevPending) {
      if (i.wake === false) {
        return { ok: true, unchanged: true, role, project, task, live: false, delivered: false, error: '' };
      }
      let delivered = false;
      let error = '';
      let regName = '';
      try {
        const cur = loadOffice(ws).lineages[lineageKeyOf(role, project, task)];
        if (cur && cur.current && String(cur.current.sessionId) === sid) regName = String(cur.current.name || '');
      } catch { /* 读不到登记表时不写名字 */ }
      try {
        const msg = firstRoundMessageFor({ role, project, task, layout: String(before.layout || ''), layoutName: String(before.layoutName || '') }, {
          previousRole: prevRole,
          migrate: mode,
          freshLayout: !String(before.layout || ''),
          name: regName,
        });
        if (msg) {
          const r = await sendPrompt(env.controller(), sid, msg, 'queue');
          delivered = !!(r && r.accepted);
        }
      } catch (e) {
        error = msgOf(e);
      }
      return { ok: true, unchanged: true, role, project, task, live: false, delivered, error };
    }
    let migration = null;
    let pending = null;
    let inPlace = false;
    let layout = '';
    let layoutName = '';
    const interConvert = (prevRole === 'project' || prevRole === 'misc') && (role === 'project' || role === 'misc') && prevRole !== role;
    if (prevPending && sameIdentity) {
      // 重复设定同一身份：沿用未处理的迁移，不把布局当成已迁。
      layout = String(before.layout || '');
      layoutName = String(before.layoutName || '');
      pending = prevPending;
    } else if (interConvert) {
      const newName = role === 'project' ? project : task;
      const lay = layoutOf({ role: prevRole, project: prevProject, task: prevTask, layout: before.layout, layoutName: before.layoutName });
      const layKind = lay.kind === 'global' ? '' : lay.kind;
      const layName = lay.name;
      if (layKind === role && layName === newName) {
        // 目标类别与当前布局同类同名：文件已经在位，不迁移，也不留待确认。
        layout = layKind;
        layoutName = layName;
        inPlace = true;
      } else if (mode === 'ask') {
        // 先问后迁：文件零移动，只把新身份与旧布局分别记下。改名同样先问，不直接搬移。
        layout = layKind;
        layoutName = layName;
        pending = {
          kind: PENDING_MIGRATION,
          // from 记布局侧的身份：迁移按它取源目录，与类别无关。
          from: { role: layKind, project: layKind === 'project' ? layName : '', task: layKind === 'project' ? '' : layName },
          to: { role, project, task },
          at: stampTz(Date.now()),
        };
      } else {
        try {
          migration = migrateIdentity({
            ws,
            prev: { role: prevRole, project: prevProject, task: prevTask },
            next: { role, project, task },
            mode: mode === 'direct' ? 'direct' : 'auto',
          });
        } catch (e) {
          return { ok: false, error: '身份互转未完成：' + msgOf(e) };
        }
        layout = role;
        layoutName = newName;
      }
    } else {
      layout = role === 'project' || role === 'misc' ? role : '';
      layoutName = role === 'project' ? project : (role === 'misc' ? task : '');
    }
    // 设为普通时不再保留项目名或任务名：名字留着会让设置页仍显示旧身份，像是没注销。
    const keepName = role === 'project' || role === 'misc';
    try { writeRoleStore(cfg, sid, { role, project: keepName ? project : '', task: keepName ? task : '', source: 'user', layout, layoutName, pending }); }
    catch (e) { return { ok: false, error: '写角色表失败：' + msgOf(e) }; }
    // 注册同步：项目、杂项、全局角色更新名册类别；普通角色只清除注册，文件与目录原位保留。
    // 类别与布局不同（先不迁）时不动新布局的目录：那里还没有本任务的任何文件。
    const localProject = layout === 'project';
    const localMisc = layout === 'misc';
    try {
      const oldProjectDir = prevRole === 'project' && prevProject ? path.join(ws, '_Project_Meta', prevProject) : '';
      const oldTaskDir = prevRole === 'misc' && prevTask ? path.join(ws, '_Misc', 'tasks', prevTask) : '';
      const markerOf = (dir) => path.join(dir, '.deregistered.json');
      if (role === 'project' && localProject) {
        fs.mkdirSync(path.join(ws, '_Project_Meta', project), { recursive: true });
        try { fs.rmSync(markerOf(path.join(ws, '_Project_Meta', project)), { force: true }); } catch { /* ignore */ }
      }
      if (role === 'misc' && localMisc) {
        fs.mkdirSync(path.join(ws, '_Misc', 'tasks', task), { recursive: true });
        try { fs.rmSync(markerOf(path.join(ws, '_Misc', 'tasks', task)), { force: true }); } catch { /* ignore */ }
      }
      if (role === 'plain') {
        for (const dir of [oldProjectDir, oldTaskDir]) {
          if (!dir || !fs.existsSync(dir)) continue;
          try { fs.writeFileSync(markerOf(dir), JSON.stringify({ at: new Date().toISOString(), sessionId: sid }), 'utf8'); } catch { /* ignore */ }
        }
        // 按会话全表扫描清除：角色表可能被手工改过，prevRole 不可信，注册残留须一并清掉。
        // 文件与目录原位保留；Registry.md 对应行的「在役会话」格随即清空。
        try { removeHoldersBySession(ws, sid); } catch { /* ignore */ }
      } else if (!pending && (role === 'project' || role === 'misc' || role === 'global')) {
        // 待确认迁移时不登记新身份：文件仍在旧布局，登记留给迁移或了结时更新。
        const okKind = syncHolderKind(ws, { kind: role, project, task, sessionId: sid });
        if (!okKind) {
          // 全局名不采信会话标题：按登记表历史最大号自动命名（无在任为「全局1」，已有则最大号 +1）（D-104）。
          const name = role === 'global'
            ? nextName(loadOffice(ws), '全局')
            : (titleOf(sid) || (role === 'project' ? project : task));
          registerHolder(ws, { kind: role, project, task, name, sessionId: sid });
        }
      }
    } catch (e) {
      // 登记失败必须可见：静默吞掉会让全局在任表为空，从而绕过单全局约束（D-104）。
      const m = '角色登记：' + msgOf(e);
      env.log(m);
      initErrors.push(m);
    }
    roleCache.delete(sid);
    const info = { role, project, task, layout, layoutName, source: 'store', sessionId: sid };
    if (pending) info.pending = pending;
    // 落位：角色生效后把会话移入对应工作区（项目→本项目库，杂项→_Misc，全局→工作区根）。
    // 缺工作区时按约定建目录并注册；失败只记录并回报，不推翻已写入的角色。
    let placed = null;
    let placeError = '';
    if (!pending && (role === 'project' || role === 'misc' || role === 'global')) {
      try { placed = await placeSession(env, sid, { role, project, task }, ws); }
      catch (e) {
        placeError = msgOf(e);
        env.log('角色落位：' + placeError);
      }
    }
    let live = false;
    try {
      const a = agentOf(sid);
      if (a) { live = true; applyRoleTo(a, info, ws); }
    } catch { /* 活体会话装配失败不影响写盘 */ }
    let delivered = false;
    let error = '';
    let registeredName = '';
    try {
      const lin = { project: role === 'project' ? project : '', task: role === 'misc' ? task : '', kind: role };
      const cur = loadOffice(ws).lineages[lineageKeyOf(lin.kind, lin.project, lin.task)];
      if (cur && cur.current && String(cur.current.sessionId) === sid) registeredName = String(cur.current.name || '');
    } catch { /* 无法读取登记表时不写名字 */ }
    // 待确认迁移时先报数：只扫「这次要搬的那处体系」——库根加元数据目录，
    // 不扫整个工作区，否则数字里混进别的项目，用户据此判断会失真。
    let scan = null;
    if (pending) {
      try {
        const lay = layoutOf(info);
        const rels = [layoutRootRel(lay), layoutMetaRel(lay)].filter(Boolean);
        scan = scanRoots(Array.from(new Set(rels.map((r) => path.join(ws, r)))));
      } catch { scan = null; }
    }
    const msgBody = firstRoundMessageFor(info, {
      previousRole: prevRole,
      migrate: mode,
      inPlace,
      moveNote: migration ? migration.summary : '',
      changes: migration ? migration.changes : null,
      pending,
      pendingPath: pending ? handoverPathFor(ws, info).path : '',
      scan,
      name: registeredName,
    });
    let placeLine = placeNotice(workspaceTargetFor(ws, { role, project, task }), placed, placeError);
    const msg = placeLine ? (msgBody + (msgBody ? NL : '') + placeLine) : msgBody;
    if (i.wake !== false && msg) {
      try {
        const r = await sendPrompt(env.controller(), sid, msg, 'queue');
        delivered = !!(r && r.accepted);
      } catch (e) {
        error = msgOf(e);
      }
    }
    return {
      ok: true, role, project, task, layout, layoutName, live, delivered, error,
      placed, placeError,
      migrated: migration ? migration.mode : '',
      migrationSummary: migration ? migration.summary : '',
      changes: migration ? (migration.changes || []) : [],
      pending: !!pending,
      pendingPath: pending ? handoverPathFor(ws, info).path : '',
      registeredName,
    };
  }

  /**
   * 了结待确认的迁移：migrate=true 搬移并回清单，false 只清 pending、文件零移动。
   * 仅限本会话：sessionId 由工具取自身 id，不接受代他人调用。
   * @param {{ sessionId?: string, apply?: boolean }} input
   */
  function chooseMigration(input) {
    const i = input || {};
    const sid = String(i.sessionId || '').trim();
    if (!sid) return { ok: false, error: '缺少会话 id' };
    const entry = readRoles(cfg).sessions[sid] || {};
    const pending = entry.pending && entry.pending.kind === PENDING_MIGRATION ? entry.pending : null;
    if (!pending) return { ok: false, error: '本会话没有待确认的迁移：pending 不存在，可能已经处理过' };
    const role = String(entry.role || '');
    const project = String(entry.project || '');
    const task = String(entry.task || '');
    const ws = workspaceForSid(sid);
    if (!ws) return { ok: false, error: '解析不到工作区根：未改动文件，pending 保留' };
    if (i.apply !== true) {
      try { writeRoleStore(cfg, sid, { pending: null }); }
      catch (e) { return { ok: false, error: '清 pending 失败：' + msgOf(e) }; }
      // 不迁移：身份按新口径生效，登记跟到新身份；新身份已有同名在任时不动登记。
      let regNote = '';
      try {
        if (role === 'project' || role === 'misc') {
          const key = lineageKeyOf(role, project, task);
          const store = loadOffice(ws);
          const cur = store.lineages[key] && store.lineages[key].current;
          if (cur && cur.sessionId && String(cur.sessionId) !== sid) {
            regNote = '；名册里已有同名在任，登记未改';
          } else {
            const name = titleOf(sid) || (role === 'project' ? project : task);
            registerHolder(ws, { kind: role, project, task, name, sessionId: sid });
          }
        }
      } catch (e) { regNote = '；登记未改：' + msgOf(e); }
      roleCache.delete(sid);
      refreshPromptFor(sid);
      return {
        ok: true, migrated: false, changes: [],
        layout: String(entry.layout || ''), layoutName: String(entry.layoutName || ''),
        summary: '不迁移：文件零移动，身份改为新类别，体系仍在原布局。' + regNote,
      };
    }
    let m = null;
    try {
      m = migrateIdentity({ ws, prev: pending.from, next: { role, project, task }, mode: 'auto' });
    } catch (e) {
      return { ok: false, error: '迁移未完成：' + msgOf(e) + '。文件未移动，pending 保留' };
    }
    const layout = role === 'project' || role === 'misc' ? role : '';
    try { writeRoleStore(cfg, sid, { layout, layoutName: '', pending: null }); }
    catch (e) { return { ok: false, error: '迁移已完成，但写角色表失败：' + msgOf(e) }; }
    roleCache.delete(sid);
    // 体系注册跟着新布局重算：旧行由磁盘扫描自然消失，新行按新位置登记。
    try { syncGlobalRefs(ws); } catch { /* 总注册写失败不影响迁移结果 */ }
    refreshPromptFor(sid);
    return {
      ok: true, migrated: true, layout, layoutName: '',
      changes: m.changes || [], summary: m.summary,
      manual: (m.changes || []).filter((c) => c.op === 'manual').map((c) => c.from),
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
    applyRole, chooseMigration, applyScopedLive, refreshPromptFor, scopedMetaOf, disposeSession,
  };
}
