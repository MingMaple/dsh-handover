/** ho_diag —— 诊断：服务是否可解析、调度器是否就绪、配置是否如预期。不写任何东西。 */
import fs from 'node:fs';
import { nameOf } from '../lib/names.mjs';
import path from 'node:path';
import { textOutput } from '../lib/output.mjs';
import { NL } from '../lib/text.mjs';
import { eventsOf, countCompactions } from '../lib/events.mjs';

export function pmDiagTool(env, state) {
  return {
    name: nameOf('diag'),
    description:
      '插件自检：服务、调度器、压缩计数、工作区是否接入。只读。',
    parameters: { type: "object", additionalProperties: false, properties: {} },
    output: textOutput(),
    async execute(args, exec) {
      const out = [];
      const meId = env.selfId(exec);
      out.push("会话      " + (meId || "?"));
      out.push("调度器    " + (state.schedulerReady() ? "就绪" : "未就绪" + (state.schedulerError() ? "：" + state.schedulerError() : "（稍后重试或重启）")));
      if (typeof env.injectList === 'function') out.push('inject    ' + env.injectList().join(' / '));
      if (typeof env.initErrors === 'function') {
        const errs = env.initErrors();
        out.push('初始化    ' + (errs.length ? '有 ' + errs.length + ' 处失败：' + errs.join('；') : '无错误'));
      }
      if (typeof env.probeServices === "function") {
        const svc = env.probeServices();
        out.push("服务      " + Object.keys(svc).map((k) => k + "=" + (svc[k] ? "可用" : "—")).join("  "));
      }
      if (typeof env.guardLast === "function") {
        const g = env.guardLast();
        out.push("唤醒判定  " + (g
          ? (g.allow ? "放行" : "拦截") + " · 依据 " + g.source + (g.title ? " · 标题 " + g.title : "") + " · 会话 " + g.sid
          : "本进程还没有 peer_send、peer_new 调用"));
      }
      if (typeof env.probeAgentScope === "function") {
        const a = env.probeAgentScope(exec);
        const show = ["compaction", "compactNow", "tokenMeter", "sessions", "llm", "agents"]
          .map((k) => k + "=" + (a[k] ? "可用" : "—")).join("  ");
        out.push("会话作用域 " + (a.ctx ? show : "无法获取 exec.agent.ctx"));
      }
      const st = typeof env.compactionState === "function"
        ? env.compactionState(exec)
        : (() => { const c = countCompactions(eventsOf(exec)); return { used: c.used, lock: c.lock, source: 'events' }; })();
      out.push("压缩      " + st.used + "/" + env.cfg.maxCompactions + " 次；锁 " + st.lock + "；来源 " + st.source);
      out.push("水位      " + (env.selfPct(meId) === null ? "读不到" : env.selfPct(meId).toFixed(1) + "%") + (typeof env.staleNote === "function" ? env.staleNote(exec) : ""));
      const ws = env.resolveWs(exec);
      let wsOk = false;
      try { wsOk = fs.existsSync(path.join(ws, '_Control_Center')); } catch { wsOk = false; }
      if (typeof env.roleOf === "function") {
        try {
          const info = env.roleOf(exec);
          const ts = typeof env.toolsetOf === 'function' ? env.toolsetOf(info.role) : null;
          out.push("角色      " + info.role + (info.project ? "（项目 " + info.project + "）" : info.task ? "（任务 " + info.task + "）" : "") + " · 依据 " + info.source + (ts ? " · 可见工具 " + ts.allow.length + "/" + (ts.allow.length + ts.deny.length) : ""));
          if (typeof env.roleState === "function") {
            const rs = env.roleState();
            out.push("角色收窄  " + (rs.gating || "未触发") + (rs.last ? " · 最近：" + rs.last.sid + " → " + rs.last.role + "（" + rs.last.at + "）" : ""));
            if (rs.bootstrap) out.push("一次性引导 " + rs.bootstrap);
          }
        } catch (e) {
          out.push("角色      判定失败：" + (e && e.message ? e.message : e));
        }
      }
      out.push("工作区    " + ws + (wsOk
        ? "  已接入"
        : "  — 未接入（未找到 _Control_Center）：让用户走设置页「首次安装」，或本会话直接 ho_init(parent=\"<目录>\", register=true)"));
      try {
        const mv = typeof env.moveInfo === "function" ? env.moveInfo() : null;
        if (mv) out.push("迁移      " + mv.phase + " · " + mv.src + (mv.dst ? "  →  " + mv.dst : ""));
      } catch { /* ignore */ }
      out.push("配置      warn=" + env.cfg.warnRatio + " handover=" + env.cfg.handoverRatio + " hard=" + env.cfg.hardRatio + " max=" + env.cfg.maxCompactions);
      if (typeof env.handoverFor === "function") {
        try {
          const hp = env.handoverFor(exec);
          out.push("交接路径  " + (hp && hp.path ? hp.path + "（" + hp.kind + "）" : "无 —— " + ((hp && hp.reason) || "角色未定")));
        } catch (e) {
          out.push("交接路径  解析失败：" + (e && e.message ? e.message : e));
        }
      } else {
        out.push("交接路径  " + (env.cfg.handoverPath || "（按角色解析）"));
      }
      return { text: out.join(NL) };
    },
  };
}