/**
 * dsh-handover —— 全局运行期插件。
 * 判定条件写入代码，执行流程写入工具。
 * 规则正文保留在磁盘，需要时用 ho_docmap(action="rules-read") 按节读取（完整流程 doc="runtime"）。
 * 按会话角色装配工具与提示段：全局 5 个工具加 peer、项目与杂项各 4 个加 peer、普通 0 个。
 * 源码不热加载：改动后须重启 DSH。
 */
import fs from 'node:fs';
import path from 'node:path';
import { isDir } from './lib/text.mjs';
import { resolveConfig } from './lib/config.mjs';
import { projCacheDir, readSelfPressure } from './lib/sessions.mjs';
import { serviceOf } from './lib/engine.mjs';
import { compactionStateOf, stalePressureNote } from './lib/events.mjs';
import { handoverMtimeMs, fileSha256 } from './lib/handover-io.mjs';
import { readSessionState, writeSessionState, storeInfo as storeInfoOf } from './lib/store.mjs';
import { adoptLegacyStore } from './lib/compat.mjs';
import { lintGlobal, lintProject } from './lib/lint.mjs';
import { resolveRegistry } from './lib/registry.mjs';
import { readRoles, writeRole, toolsetFor } from './lib/role.mjs';
import { routeWorkspace } from './lib/workspace.mjs';
import { moveStatus } from './lib/mover.mjs';
import { judgeRotateGate } from './lib/succession.mjs';
import { createAnchorOps } from './lib/anchor-ops.mjs';
import { createInlineEngine } from './lib/inline-engine.mjs';
import { createRoleAssembly } from './lib/role-assembly.mjs';
import { createToolRegistry } from './lib/tool-registry.mjs';
import { createLifecycle } from './lib/lifecycle.mjs';

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

export function walkUpToWorkspace(start, onMiss) {
  let cur = start;
  for (let i = 0; i < 8 && cur; i++) {
    if (isDir(path.join(cur, '_Control_Center'))) return cur;
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  // cwd 的父目录已删除（或 cwd 为盘符根）时，向上无法找到工作区。
  // 此时以登记表记录的工作区为准；登记表也查不到时返回空串（没有工作区根）。
  // 不得原样返回 start：那会把进程 cwd 当成工作区，
  // 交接、归档与目录创建都会落到 DSH 进程目录（D-112）。
  try {
    const fromReg = routeWorkspace({ cfg: {} });
    if (fromReg && fromReg !== start && isDir(path.join(fromReg, '_Control_Center'))) return fromReg;
  } catch { /* 登记表无法读取时按没有工作区根处理 */ }
  if (typeof onMiss === 'function') { try { onMiss(start); } catch { /* 上报失败不影响解析结果 */ } }
  return '';
}

function msgOf(e) {
  return String(e && e.message ? e.message : e);
}

export function createInitErrors(limit) {
  const max = Number(limit) > 0 ? Number(limit) : 50;
  const list = [];
  const rawPush = list.push.bind(list);
  // 诊断只保留去重后的 max 条：同一失败每步重试会反复 push，不能让数组无界增长（D-109）。
  list.push = (...msgs) => {
    let len = list.length;
    for (const raw of msgs) {
      const m = String(raw);
      if (list.includes(m)) continue;
      if (list.length >= max) list.shift();
      len = rawPush(m);
    }
    return len;
  };
  return list;
}

export function apply(ctx, config) {
  const cfg = resolveConfig(config);
  const initErrors = createInitErrors(50);
  const registered = new Set();           // 已注册的工具名（旧内核的限制式裁剪使用）
  let workspaceMissLogged = false;
  /** 工作区解析失败只报一次：日志与 initErrors 各记一条，避免每步重复累积（D-112）。 */
  const noteWorkspaceMiss = (start) => {
    if (workspaceMissLogged) return;
    workspaceMissLogged = true;
    const m = '工作区解析：' + String(start || '') + ' 向上 8 级与注册表均无 _Control_Center，按「没有工作区根」处理';
    env.log(m);
    initErrors.push(m);
  };
  const resolveWorkRoot = (start) => walkUpToWorkspace(start, noteWorkspaceMiss);
  // 自 0.2.2 起，工具按「步」解析（tools.resolve）：可用工具集合每步重算，角色过滤写入注册条件。
  // 更早的内核忽略注册选项，只能退回 agent 作用域的 restrict。2 条路径按能力择一，不并行。
  const perStep = (() => { try { return !!(ctx.tools && typeof ctx.tools.resolve === 'function'); } catch { return false; } })();
  let roleOps = null;                     // 角色装配句柄（见 lib/role-assembly.mjs）
  let toolOps = null;                     // 工具注册句柄（见 lib/tool-registry.mjs）
  let lifecycleOps = null;                // 生命周期接线句柄（见 lib/lifecycle.mjs）

  const env = {
    cfg,
    cacheDir: () => projCacheDir(),
    controller: () => serviceOf(ctx, null, 'sessionController'),
    resolveWs(exec) {
      if (cfg.workspaceRoot) return cfg.workspaceRoot;
      const cwd = exec && exec.agent && exec.agent.session && exec.agent.session.header ? exec.agent.session.header.cwd : null;
      return resolveWorkRoot(cwd || process.cwd());
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
        const src = cfg.workspaceRoot || resolveWorkRoot(process.cwd());
        const st = moveStatus({ src });
        return st && st.phase && st.phase !== 'none' ? st : null;
      } catch { return null; }
    },
    guardLast() { return toolOps ? toolOps.guardLast() : null; },
    injectList: () => inject.slice(),
    initErrors: () => initErrors.slice(),
    guardAvailable: () => { try { return !!(ctx.tools && typeof ctx.tools.guard === 'function'); } catch { return false; } },
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
    assembledCount() { return roleOps ? roleOps.sectionDispose.size : 0; },
    log(m) {
      try { if (ctx.logger && typeof ctx.logger.warn === 'function') ctx.logger.warn(String(m)); } catch { /* ignore */ }
    },
  };

  // ---------------- 角色装配（实现见 lib/role-assembly.mjs）
  // 提示段、角色缓存与旧内核限制的状态由模块持有；此处只保留 env 上的对外入口。
  roleOps = createRoleAssembly({ ctx, cfg, env, perStep, registered, initErrors, walkUpToWorkspace: resolveWorkRoot });
  const {
    agentOf, isChildSession, infoFor, scopedMetaOf, workspaceForSid, roleCache, titleOf,
  } = roleOps;

  env.roleOf = (exec) => infoFor(env.selfId(exec) || '', { cwd: env.selfCwd(exec) || '' });
  env.toolsetOf = (role) => toolsetFor(role);
  env.roleState = () => ({ mode: roleOps.roleMode(), last: roleOps.roleState.last, count: roleOps.appliedRole.size });
  env.rolesSnapshot = () => readRoles(cfg).sessions;
  // 写角色表是所有角色变更的唯一入口。
  // 写入后立即使每步过滤的短缓存失效，下一步即按新角色判定。
  env.writeRole = (sid, patch) => {
    const saved = writeRole(cfg, sid, patch);
    roleOps.roleCache.delete(String(sid || ''));
    return saved;
  };
  // 建会话后的可核验核对：直接读回角色表，避免只写不验。
  env.roleEntryOf = (sid) => {
    const key = String(sid || '');
    if (key === '') return null;
    return readRoles(cfg).sessions[key] || null;
  };
  env.handoverFor = (exec) => roleOps.handoverInfoFor(env.roleOf(exec), env.resolveWs(exec));
  /** 跨会话使用：按 id 计算该会话自身的角色与交接路径，不借用调用者上下文。 */
  env.handoverForSid = (sid) => {
    const id = String(sid || '');
    return roleOps.handoverInfoFor(infoFor(id, {}), workspaceForSid(id));
  };
  env.infoOfSid = (sid) => infoFor(String(sid || ''), {});
  env.agentOfSid = (sid) => agentOf(String(sid || ''));
  env.compactionStateOfSid = (sid) => compactionStateOf(String(sid || ''), null);
  env.applyRole = roleOps.applyRole;
  env.chooseMigration = roleOps.chooseMigration;
  env.applyScopedLive = roleOps.applyScopedLive;
  env.refreshPromptFor = roleOps.refreshPromptFor;


  // ---------------- 压缩主链：轮首注入压力行、到线注入提示、强制线强制压缩 ----------------
  // 整理线与建议线只注入提示，绝不调用压缩 API；只有强制线由插件兜底压缩。
  // 全部注入都在本会话的步骤边界生成，作为末尾消息追加；不改 system 头，不逐步注入。
  // 触发范围限于会话自身：每次步骤边界只读该会话水位。
  // 不枚举其他会话，也不在启动或空闲时巡检。
  // 实现已抽到 lib/inline-engine.mjs 与 lib/anchor-ops.mjs，共享状态经 runtime 注入。

  const inline = { inflight: new Set(), lastAt: new Map(), disabled: false, lastError: '' };

  // 会话状态读写（压缩主链与角色装配共用）：兼容旧位置并留痕。
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

  // 锚点与快照操作：纯函数为主，依赖 workspaceForSid、noteInline、env.log。
  // noteInline 由 inline-engine 提供，二者互相引用：anchorOps 先以转发函数占位，
  // engine 建立后再由 runtime.noteInline 回填，调用发生在建好之后。
  const runtime = {
    ctx, cfg, env, inline, roleCache,
    readState, saveState, infoFor, scopedMetaOf, isChildSession, workspaceForSid,
    noteInline: null, anchorOps: null,
  };
  let engine = null;
  const anchorOps = createAnchorOps({
    workspaceForSid,
    noteInline: (m) => engine.noteInline(m),
    log: (m) => env.log(m),
    cfg,
  });
  runtime.anchorOps = anchorOps;
  engine = createInlineEngine(runtime);
  runtime.noteInline = engine.noteInline;

  // 步骤边界监听：到线判定与强制压缩只在轮内步骤分隔时做。
  if (typeof ctx.on === 'function') {
    const listen = (opts) => ctx.on('agent/pre-step', engine.onPreStep, opts);
    try { listen({ global: true }); }
    catch {
      try { listen(); }
      catch (e) { initErrors.push('步骤边界监听：' + msgOf(e)); }
    }
  }

  // ---------------- 压缩入口与换任硬闸：供工具与换任流程调用 ----------------

  /** 助手执行入口：轮内压缩，零可见消息。先写锚点，再压缩。 */
  env.assistantCompact = engine.assistantCompact;

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
    return judgeRotateGate({
      flow,
      archiveSha256: flow.archivePath ? fileSha256(flow.archivePath) : '',
      archiveMtimeMs: flow.archivePath ? (handoverMtimeMs(flow.archivePath) || 0) : 0,
      handoverMtimeMs: hp.path ? handoverMtimeMs(hp.path) : null,
      lint,
      lock: cs.lock || 'clean',
      compactionPending: inline.inflight.has(sid),
      openToolCalls: engine.openToolCalls(exec && exec.agent ? exec.agent.session : null),
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

  // ---------------- 用户全局前置提示词与生命周期接线（实现见 lib/lifecycle.mjs）
  lifecycleOps = createLifecycle({
    ctx, cfg, env, roleOps, pkgInfo, initErrors,
    toolCount: () => (toolOps ? toolOps.tools.length + toolOps.peerTools.length : 0),
  });
  env.extraPrompt = lifecycleOps.extraPrompt;
  env.extraPromptEnabled = lifecycleOps.extraPromptEnabled;
  env.setExtraPrompt = lifecycleOps.setExtraPrompt;
  lifecycleOps.initExtraPrompt();

  // ---------------- 工具注册与会话守卫（实现见 lib/tool-registry.mjs）
  toolOps = createToolRegistry({
    ctx, cfg, env, perStep, registered, initErrors,
    isChildSession, infoFor, scopedMetaOf, roleCache, titleOf,
  });

  // ---------------- 生命周期、设置页、命令与启动补注册（实现见 lib/lifecycle.mjs）
  lifecycleOps.installAgentEvents();

  lifecycleOps.installSettingsPage();

  lifecycleOps.installCommands();

  lifecycleOps.scheduleStartupRefresh();
}