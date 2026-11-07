/** peer_peek —— 可选监测：读另一个会话日志里最近若干条对话。只读，但内容进本会话上下文。 */
import { textOutput } from '../lib/output.mjs';
import { peerNameOf } from '../lib/names.mjs';
import { NL } from '../lib/text.mjs';
import { findSessionLog, decodeSessionLog, conversation, stamp } from '../lib/peer.mjs';

export function pmPeerPeekTool(env) {
  return {
    name: peerNameOf('peek'),
    description:
      '查看指定会话近期的对话（消耗本会话 token）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['session_id'],
      properties: {
        session_id: { type: 'string', description: '目标会话 id' },
        limit: { type: 'number', description: '取最近多少条（默认 8，上限 40）' },
      },
    },
    output: textOutput(),
    async execute(args) {
      const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(40, Math.trunc(args.limit))) : 8;
      const file = findSessionLog(args.session_id);
      if (file === null) return { text: 'no session log found for ' + args.session_id };
      const events = decodeSessionLog(file);
      if (events === null) return { text: 'this Node build has no zstd support; cannot read the session log' };
      const items = conversation(events, limit);
      const head = 'session ' + args.session_id + '  |  最近 ' + String(items.length) + ' 条  |  ' + file;
      if (items.length === 0) return { text: head + NL + '(没有可读的对话内容)' };
      const body = items
        .map((it) => {
          const one = it.text.replace(/\s+/g, ' ').trim();
          const cut = one.length > 400 ? one.slice(0, 400) + ' …' : one;
          return '[' + stamp(it.t) + ' ' + it.who + '] ' + cut;
        })
        .join(NL);
      return { text: head + NL + body };
    },
  };
}
