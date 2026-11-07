/** peer_list —— 平级会话一览：id / 项目 / 水位 / 运行状态。只读本地投影缓存，不激活任何会话。 */
import { textOutput } from '../lib/output.mjs';
import { peerNameOf } from '../lib/names.mjs';
import { NL } from '../lib/text.mjs';
import { readProjCache, rowLine, sessionRows, stamp } from '../lib/peer.mjs';

export function pmPeerListTool(env) {
  return {
    name: peerNameOf('list'),
    description:
      '会话清点（只读缓存，不激活任何会话）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        include_subagents: { type: 'boolean', description: '同时列出 origin=subagent 的子会话' },
        limit: { type: 'number', description: '最多列出多少行（默认 40）' },
      },
    },
    output: textOutput(),
    async execute(args) {
      const controller = env.controller();
      if (!controller || typeof controller.list !== 'function') {
        throw new Error('peer_list：sessionController 不可用（插件未注入该服务）');
      }
      const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(200, Math.trunc(args.limit))) : 40;
      const rows = await sessionRows(controller, args.include_subagents === true);
      if (rows.length === 0) return { text: 'no sessions' };
      const lines = rows.slice(0, limit).map((row) => {
        const cache = readProjCache(row.sessionId);
        const state = row.running ? 'running' : row.agentAvailable ? 'idle' : 'cold';
        return rowLine(row.sessionId, cache, state) + ' | ' + stamp(row.updatedAt);
      });
      return { text: lines.join(NL) };
    },
  };
}
