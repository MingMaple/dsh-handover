/**
 * 工具注册与会话守卫：按角色计算每步可见性，注册 5 个 ho_* 与 peer，并挂载 2 类工具守卫。
 * 依赖通过 runtime 注入；角色缓存与角色判定来自 lib/role-assembly.mjs，二者共用同一份状态。
 */
import { pmStatusTool } from '../tools/ho_status.mjs';
import { pmSessionsTool } from '../tools/ho_sessions.mjs';
import { pmHandoverTool } from '../tools/ho_handover.mjs';
import { pmWorkspaceTool } from '../tools/ho_workspace.mjs';
import { pmDocmapTool } from '../tools/ho_docmap.mjs';
import { pmPeerTool, collabMemberReason } from '../tools/peer.mjs';
import { NAMES, PEER_NAME } from './names.mjs';
import { ROLES, toolsetFor } from './role.mjs';

/** 创建工具注册表。runtime 提供 ctx、cfg、env、perStep、registered、initErrors 与角色判定函数。 */
export function createToolRegistry(runtime) {
  const {
    ctx, cfg, env, perStep, registered, initErrors,
    isChildSession, infoFor, scopedMetaOf, roleCache, titleOf,
    schedulerReady, schedulerError,
  } = runtime;
  const msgOf = (e) => String(e && e.message ? e.message : e);
  let guardLast = null;

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
    pmStatusTool(env, { schedulerReady, schedulerError }),
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

  return { tools, peerTools, visibleTo, guardLast: () => guardLast };
}
