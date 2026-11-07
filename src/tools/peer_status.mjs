/** peer_status —— 单个会话的详细状态（水位 / 运行状态 / 轮步 / cwd / preset / 平级或子会话）。只读本地。 */
import { textOutput } from '../lib/output.mjs';
import { peerNameOf } from '../lib/names.mjs';
import { NL } from '../lib/text.mjs';
import { readProjCache, pressurePct, isSubagent, isBusy, projectName, pick, sessionRows, stamp } from '../lib/peer.mjs';

export function pmPeerStatusTool(env) {
  return {
    name: peerNameOf('status'),
    description:
      '单会话详情：水位、运行状态、轮数、步数、工作目录。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['session_id'],
      properties: {
        session_id: { type: 'string', description: '目标会话 id' },
      },
    },
    output: textOutput(),
    async execute(args) {
      const controller = env.controller();
      if (!controller || typeof controller.list !== 'function') {
        throw new Error('peer_status：sessionController 不可用（插件未注入该服务）');
      }
      const cache = readProjCache(args.session_id);
      const rows = await sessionRows(controller, true);
      const row = rows.find((r) => r.sessionId === args.session_id) ?? null;
      if (cache === null && row === null) return { text: 'unknown session: ' + args.session_id };
      const stats = pick(cache, 'record', 'rows', 'sessionStats', 'val') ?? {};
      const pct = cache === null ? null : pressurePct(cache);
      const lines = [
        'session  ' + args.session_id,
        'kind     ' + (cache === null ? '?' : isSubagent(cache) ? '子会话（subagent）' : '平级会话（peer）'),
        'project  ' + (cache === null ? '-' : projectName(cache)),
        'pressure ' + (pct === null ? '?' : pct.toFixed(1) + '%') + (pct !== null && pct >= 32 ? '  已进入预警区' : ''),
        'state    ' + (isBusy(cache) === true ? 'running' : row === null ? 'cold' : row.agentAvailable ? 'idle' : 'cold'),
        'turns    ' + String(stats.turns ?? '?') + '   steps ' + String(stats.steps ?? '?'),
        'cwd      ' + String(row?.cwd ?? pick(cache, 'record', 'identity', 'cwd') ?? '-'),
        'preset   ' + String(pick(cache, 'record', 'rows', 'agentPreset', 'val') ?? '-'),
        'updated  ' + stamp(row?.updatedAt ?? pick(cache, 'record', 'identity', 'createdAt')),
      ];
      return { text: lines.join(NL) };
    },
  };
}
