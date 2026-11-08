/** ho_checkpoint —— 写交接 + 登记压缩；压缩由调度器在轮次结束后执行（交接路径按角色）。 */
import { textOutput } from '../lib/output.mjs';
import { nameOf } from '../lib/names.mjs';
import { NL } from '../lib/text.mjs';
import { readHandover, writeHandover } from '../lib/handover-io.mjs';
import { eventsOf, countCompactions } from '../lib/events.mjs';
import { decide } from '../lib/phase.mjs';
import { checkConsent, consumedConsent } from '../lib/consent.mjs';

export function pmCheckpointTool(env) {
  return {
    name: nameOf('checkpoint'),
    description:
      '写交接、登记压缩；回合结束后自动压缩。resume=continue（默认）压缩后续跑；resume=wait 表示任务已收尾，压缩后不唤醒。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        handover_text: { type: 'string', description: '要写入的交接正文；不给则要求磁盘上已有合格交接' },
        handover_path: { type: 'string', description: '覆盖交接路径（演练用）' },
        resume: { type: 'string', enum: ['continue', 'wait'], description: '压缩后的去向：continue（默认）按交接 §2 继续；wait 表示本轮任务已收尾，压缩后不唤醒，等用户派新任务' },
        at_risk: { type: 'boolean', description: '当前处在关键步骤：为 true 时，水位在提醒线～交接线之间只提醒、不压缩（过交接线仍会压）' },
        force: { type: 'boolean', description: '忽略关键步骤判定，直接排压缩' },
        confirm: { type: 'boolean', description: '判定为「可压缩」后须经用户同意才传 true；还需用户在设置页点「允许压缩」（5 分钟一次性授权），否则不排压缩' },
      },
    },
    output: textOutput(),
    async execute(args, exec) {
      const ws = env.resolveWs(exec);
      const meId = env.selfId(exec);
      if (!meId) throw new Error("拿不到本会话 id，无法调度压缩");
      const info = env.roleOf(exec);
      const target = args.handover_path
        ? { path: args.handover_path, kind: info.role === 'project' ? 'project' : info.role === 'misc' ? 'misc' : 'global' }
        : env.handoverFor(exec);
      if (!target || !target.path) {
        return { text: [
          '没有可用的交接路径：' + (target && target.reason ? target.reason : '未知'),
          '先指定角色（设置页的 dsh-handover 中「会话角色」），或显式传 handover_path="<交接文件绝对路径>"。',
          '压缩会丢历史，没有合格交接就不排压缩。',
        ].join(NL) };
      }
      const file = target.path;
      const st = typeof env.compactionState === "function" ? env.compactionState(exec) : null;
      const count = st ? { used: st.used, lock: st.lock } : countCompactions(eventsOf(exec));
      const self = env.selfPct(meId);
      const ratio = self === null ? null : self / 100;
      const out = [];
      const recentSec = st && st.lastSummaryMs ? (Date.now() - st.lastSummaryMs) / 1000 : null;
      if (recentSec !== null && recentSec < 120 && args.force !== true) {
        out.push("拒绝排压缩：" + Math.round(recentSec) + " 秒前刚完成一次压缩（日志里有 compaction/summary），避免重复排程。");
        out.push("等一轮让投影缓存刷新；确实要再压一次请加 force=true。");
        return { text: out.join(NL) };
      }
      if (count.lock === "open") {
        out.push("拒绝排压缩：检测到未闭合的压缩锁（compaction/start 无配对 end）。");
        out.push("处理：等当前压缩结束后用 ho_phase 复查；若长时间不动，说明上次压缩崩在中间。");
        return { text: out.join(NL) };
      }
      const adv = decide({ ratio, compactionsUsed: count.used, cfg: env.cfg, lockState: count.lock });
      if (adv.action === "new_session") {
        out.push("不建议压缩：" + adv.reason);
        out.push('下一步：用 ho_handover(action=write) 写交接，再由全局 ho_sessions(action="new") 建新会话。');
        return { text: out.join(NL) };
      }
      if (adv.action === "pause" && args.at_risk === true && args.force !== true) {
        out.push("已暂停（关键步骤）：" + adv.reason);
        out.push("到阶段边界再调一次 ho_checkpoint（不带 at_risk 或带 force）。");
        return { text: out.join(NL) };
      }
      if (adv.action === "continue" && args.force !== true) {
        out.push("水位未到线（" + (ratio === null ? "读不到" : (Math.round(ratio * 1000) / 10).toFixed(1) + "%") + "）：不压。");
        out.push("需要强制演练可加 force=true。");
        return { text: out.join(NL) };
      }
      // 判断逻辑不动；只有判定可以压缩之后，才停下来问用户。
      if (args.confirm !== true) {
        out.push('判定：可以压缩（' + adv.reason + '）。');
        out.push('水位 ' + (ratio === null ? '读不到' : (Math.round(ratio * 1000) / 10).toFixed(1) + '%') + '，已压缩 ' + count.used + '/3。');
        out.push('压缩会丢历史并自动续跑 —— 先问用户「要压缩吗？」，回答同意后再调 ho_checkpoint(confirm=true)；不同意就保持原样。');
        return { text: out.join(NL) };
      }
      let wrote = null;
      if (typeof args.handover_text === "string" && args.handover_text.trim() !== "") {
        wrote = writeHandover(ws, file, args.handover_text, "write", { kind: target.kind, info });
        out.push("交接已写入 " + file + "（" + wrote.bytes + " B，备份：" + (wrote.backup || "无") + "）· 角色 " + info.role);
        out.push("体检 " + wrote.verdict + (wrote.reasons.length ? "：" : " · 结构齐备"));
        for (const r of wrote.reasons) out.push("  - " + r);
        if (wrote.verdict !== "通过") {
          out.push("体检不通过 ⇒ 不排压缩（先补结构，压缩后就没机会改了）。");
          return { text: out.join(NL) };
        }
      } else {
        const cur = readHandover(file);
        if (cur.text === null || cur.text.trim() === "") {
          out.push("没有交接正文，磁盘上也没有：" + file);
          out.push("拒绝压缩 —— 压缩会丢历史，必须先有交接。");
          return { text: out.join(NL) };
        }
        out.push("沿用磁盘上已有交接：" + file);
      }
      // 严格闸门：confirm=true 只表示意图，是否同意以用户点过授权为准。
      // 任何角色（全局、项目、杂项）都靠同一条判据：用户是否在设置页点过授权。
      // 会话自行判断水位与询问用户，用户点授权后自行排压缩，不必上报全局。
      const cs = checkConsent(meId);
      if (!cs.ok) {
        out.push('交接已写好，但**没有排压缩**：' + cs.reason + '。');
        out.push('授权方式（任选其一）：① 在聊天框发送 /allow-compact（最快，仅授权本会话）；② 在设置页的 dsh-handover 中点击「压缩授权」一次。授权有效期 5 分钟，其后须再调用 ho_checkpoint(confirm=true)。');
        out.push('如此设限的原因：压缩会丢弃历史，而参数由 AI 自行填写——惟有用户在设置页当面点击的那一次，方视为同意。');
        return { text: out.join(NL) };
      }
      // 成本提示：低于交接线强行压缩会白付一次摘要，且本轮前缀缓存失效。
      const handoverRatio = (env.cfg && env.cfg.handoverRatio) || 0.35;
      if (ratio !== null && ratio < handoverRatio) {
        out.push('注意成本：当前水位 ' + (Math.round(ratio * 1000) / 10) + '% 低于交接线 ' + Math.round(handoverRatio * 100) + '% —— 属于提前压缩，会白付一次摘要调用，且本轮前缀缓存失效。');
      }
      consumedConsent(meId);
      const n = count.used + 1;
      const resume = args.resume === 'wait' ? 'wait' : 'continue';
      env.schedule(meId, n, { resume });
      out.push('用户已授权（' + cs.atText + ' 点击，剩 ' + Math.round(cs.leftMs / 1000) + ' 秒）。');
      out.push("已登记压缩（第 " + n + "/" + env.cfg.maxCompactions + " 次）。本回合结束后执行。");
      if (resume === 'wait') {
        out.push("去向：wait —— 压缩完成后不会唤醒本会话，等你派新任务。");
      } else {
        out.push("去向：continue —— 压缩完成后自动收到续跑消息；若 60 秒内没有续跑消息，用 ho_phase 看状态。");
      }
      out.push("压缩期间不要结束会话。");
      return { text: out.join(NL) };
    },
  };
}
