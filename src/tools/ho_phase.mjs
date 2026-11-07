/** ho_phase —— 本会话阶段：水位 / 已压缩次数 / 锁状态 / 建议动作（纯只读，不压缩）。 */
import { textOutput } from '../lib/output.mjs';
import { nameOf } from '../lib/names.mjs';
import { NL } from '../lib/text.mjs';
import { decide } from '../lib/phase.mjs';

export function pmPhaseTool(env) {
  return {
    name: nameOf('phase'),
    description:
      '本会话阶段：水位、已压缩次数、锁状态、建议动作。只读。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        simulateRatio: { type: 'number', description: '演练用：用这个比例替代真实水位（0-1），不写任何状态' },
      },
    },
    output: textOutput(),
    async execute(args, exec) {
      const meId = env.selfId(exec);
      const real = env.selfPct(meId);
      const ratio = typeof args.simulateRatio === 'number' ? args.simulateRatio : (real === null ? null : real / 100);
      const count = env.compactionCount(exec);
      const lock = env.lockState(exec);
      const adv = decide({ ratio, compactionsUsed: count.used, cfg: env.cfg, lockState: lock });
      const out = [];
      out.push('会话      ' + (meId || '未知'));
      out.push('水位      ' + (ratio === null ? '读不到' : (Math.round(ratio * 1000) / 10).toFixed(1) + '%') + (typeof args.simulateRatio === 'number' ? '  （演练模拟值）' : '') + (typeof env.staleNote === 'function' ? env.staleNote(exec) : ''));
      const usedText = count.used + '/' + (env.cfg.maxCompactions) + ' 次';
      out.push('压缩      ' + usedText + (count.note ? '  ' + count.note : ''));
      out.push('锁        ' + lock);
      out.push('建议      ' + adv.action + ' —— ' + adv.reason);
      return { text: out.join(NL) };
    },
  };
}