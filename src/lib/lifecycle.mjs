/**
 * 生命周期与外围接线：会话事件、活体补充装配、设置页路由、聊天页命令与启动补注册。
 * 另含用户全局前置提示词的注册与保存。
 * 依赖通过 runtime 注入；角色装配与状态清理统一走 roleOps。
 */
import { serviceOf } from './engine.mjs';
import { createApi, statusSnapshot, resolveShortSid } from './api.mjs';
import { registerStatusRoute } from './webroute.mjs';
import { registerRpcCarrier } from './rpc-carrier.mjs';
import { readExtraPrompt, writeExtraPrompt, EXTRA_PROMPT_ORDER, EXTRA_PROMPT_SECTION } from './extra-prompt.mjs';
import { grantConsent, activeConsentsFor } from './consent.mjs';
import { registrySignature } from './system.mjs';

/** 创建生命周期接线。runtime 提供 ctx、cfg、env、roleOps、pkgInfo、initErrors、schedulerInfo、toolCount。 */
export function createLifecycle(runtime) {
  const { ctx, cfg, env, roleOps, pkgInfo, initErrors, schedulerInfo, toolCount } = runtime;
  const msgOf = (e) => String(e && e.message ? e.message : e);

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
  function extraPrompt() { try { return readExtraPrompt().text; } catch { return ''; } }
  function extraPromptEnabled() { try { return readExtraPrompt().enabled; } catch { return false; } }
  function setExtraPrompt(text, enabled) {
    const saved = writeExtraPrompt(text, enabled);
    const r = applyExtraPrompt(saved);
    return { ok: true, chars: saved.text.length, enabled: saved.enabled, registered: r.registered, error: r.error || '' };
  }
  /** 激活时按磁盘状态注册一次。 */
  function initExtraPrompt() {
    try { applyExtraPrompt(readExtraPrompt()); } catch (e) { initErrors.push('全局前置提示词：' + msgOf(e)); }
  }

  // ---------------- 会话生命周期：创建时装配提示段；开轮前按角色表核对一次
  // 此处不处理工具可见性：自 0.2.2 起，每步条件已按当前角色计算，换角色下一轮即生效。
  function installAgentEvents() {
    if (typeof ctx.on !== 'function') return;
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
          if (agent) roleOps.applyRoleTo(agent);
        } catch (e) { env.log('角色装配失败：' + msgOf(e)); }
      });
      onAgentEvent('agent/disposed', (payload) => {
        try {
          const agent = payload && payload.agent ? payload.agent : null;
          const h = agent && agent.session ? agent.session.header : null;
          const sid = String((h && h.id) || (agent && agent.id) || '');
          if (!sid) return;
          roleOps.disposeSession(sid);
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
          const info = roleOps.infoFor(sid, roleOps.scopedMetaOf(h, sid));
          // 角色未变时仍须核对授权签名与体系注册签名：授权到达或注册改写后，下一轮即应看到新内容。
          let sig = '';
          try { sig = activeConsentsFor(sid).map((r) => r.kind + ':' + r.until).join('|'); } catch { sig = ''; }
          let sysSig = '';
          try { sysSig = registrySignature(roleOps.workspaceForAgent(agent), info); } catch { sysSig = ''; }
          if (roleOps.appliedRole.get(sid) === info.role && roleOps.consentSig.get(sid) === sig && roleOps.systemSig.get(sid) === sysSig) return;
          env.log('开轮前重装提示段：' + sid + ' · 已装配 ' + (roleOps.appliedRole.get(sid) || '-') + ' · 目标 ' + info.role);
          roleOps.applyRoleTo(agent, info);
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
          roleOps.applyRoleTo(a); n++;
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
  function installSettingsPage() {
    try {
      const info = pkgInfo();
      const st = schedulerInfo();
      const pageInfo = {
        name: info.name,
        version: info.version,
        tools: toolCount(),
        scheduler: st.ready ? '就绪' : '未就绪' + (st.error ? '：' + st.error : ''),
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
  }

  // ---------------- 聊天页命令：用户在输入框输入 /allow-reset 即可授权上下文重置
  // 设计理由：设置页须切换页面并填写会话 id，操作步骤较多。斜杠命令由用户亲手输入，
  // 天然满足「同意只能由用户作出」的判据，且不产生模型消息、不消耗 token。
  function installCommands() {
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
  }

  // 插件重载后，已存在的会话不会自动重装提示段，故补注册提醒段。
  // 角色提示段（manual）由宿主按 agent 持有，同名段无法修改文本；提醒段为新段，可以补注册。
  function scheduleStartupRefresh() {
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

  return {
    applyExtraPrompt, extraPrompt, extraPromptEnabled, setExtraPrompt, initExtraPrompt,
    installAgentEvents, installSettingsPage, installCommands, scheduleStartupRefresh,
  };
}
