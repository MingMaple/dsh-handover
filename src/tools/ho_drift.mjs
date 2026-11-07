/** ho_drift —— 交接漂移体检（替代 handover_check.mjs）。 */
import { textOutput } from '../lib/output.mjs';
import { nameOf } from '../lib/names.mjs';
import { NL } from '../lib/text.mjs';
import { computeDrift, driftVerdict } from '../lib/drift.mjs';

export function pmDriftTool(env) {
  return {
    name: nameOf('drift'),
    description:
      '交接漂移体检：Δ＝当前轮−交接轮，超过容忍轮数（默认 3）需刷新交接。只读。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        slack: { type: 'number', description: '容忍轮数（默认 3）' },
        all: { type: 'boolean', description: '列全部会话，而不只是每个项目的在任会话' },
      },
    },
    output: textOutput(),
    async execute(args, exec) {
      const ws = env.resolveWs(exec);
      const res = computeDrift({
        ws,
        cacheDir: env.cacheDir(),
        slack: typeof args.slack === 'number' ? args.slack : env.cfg.driftSlack,
        all: args.all === true,
      });
      const out = [];
      out.push('交接匹配检查（跟着交接走；冗余 ' + res.slack + ' 轮）  工作区根 ' + ws);
      out.push('  项目  会话类型 会话  当前轮  交接轮  Δ  判定');
      for (const r of res.rows) {
        const cells = [r.project, r.kind, r.sid.slice(-8), String(r.turns), r.handoverTurn === null ? '?' : String(r.handoverTurn), r.delta === null ? '?' : String(r.delta), r.verdict];
        out.push('  ' + cells.join('  '));
      }
      if (!res.rows.length) out.push('  读不到任何项目会话（Projects/ 下对应库不存在时属正常）');
      out.push(driftVerdict(res));
      return { text: out.join(NL) };
    },
  };
}