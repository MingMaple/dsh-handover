/** ho_brief —— 一条命令汇总：水位 + 闸门 + 会话清点 + 阶段建议。 */
import { textOutput } from '../lib/output.mjs';
import { nameOf } from '../lib/names.mjs';
import { NL } from '../lib/text.mjs';
import { syncCheck } from '../lib/gates.mjs';
import { scanSessions, readSelfPressure } from '../lib/sessions.mjs';
import { composeBrief } from '../lib/brief.mjs';
import { decide } from '../lib/phase.mjs';
import { computeDrift } from '../lib/drift.mjs';
import { watermark } from '../lib/facts.mjs';

export function pmBriefTool(env) {
  const w = watermark(env.cfg);
  return {
    name: nameOf('brief'),
    description:
      '起始与收束的单条命令：水位、闸门、会话清点、阶段建议。只读。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        threshold: { type: 'number', description: '预警阈值百分比（默认 ' + w.warnValue + '）' },
      },
    },
    output: textOutput(),
    async execute(args, exec) {
      const ws = env.resolveWs(exec);
      const warn = typeof args.threshold === "number" ? args.threshold : w.warnValue;
      const gate = syncCheck(ws);
      const meId = env.selfId(exec);
      const self = readSelfPressure(env.cacheDir(), meId);
      const scan = scanSessions({
        dir: env.cacheDir(),
        meId,
        meCwd: env.selfCwd(exec),
        warn,
        silentHours: env.cfg.sessionScanHours,
      });
      const drift = computeDrift({ ws, cacheDir: env.cacheDir(), slack: env.cfg.driftSlack, all: false });
      const ratio = self.used === null || self.win === null ? null : self.used / self.win;
      const adv = decide({ ratio, compactionsUsed: 0, cfg: env.cfg, lockState: "unknown" });
      const selfPct = self.used === null || self.win === null ? null : (self.used / self.win) * 100;
      const ok = gate.ok && (selfPct === null || selfPct < warn);
      const lines = composeBrief({
        cfg: env.cfg,
        selfUsed: self.used,
        selfWin: self.win,
        gate,
        scan,
        drift,
        advice: { text: adv.action + " —— " + adv.reason },
        ok,
      });
      return { text: lines.join(NL) };
    },
  };
}