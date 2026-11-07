/** peer_send —— 给指定会话投一条消息：唯一会花对方 token 的动作。 */
import { randomUUID } from 'node:crypto';
import { peerNameOf } from '../lib/names.mjs';
import { textOutput } from '../lib/output.mjs';
import { NL } from '../lib/text.mjs';
import { peerMarker } from '../lib/peer.mjs';

export function pmPeerSendTool(env) {
  return {
    name: peerNameOf('send'),
    description:
      '向指定会话投递一条消息；唯一会消耗对方 token 的动作，尽量少用。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['session_id', 'message'],
      properties: {
        session_id: { type: 'string', description: '目标会话 id' },
        message: { type: 'string', description: '要投递的正文' },
        mode: { type: 'string', enum: ['queue', 'steer'], description: 'queue（默认）或 steer' },
      },
    },
    output: textOutput(),
    async execute(args, exec) {
      const controller = env.controller();
      if (!controller || typeof controller.prompt !== 'function') {
        throw new Error('peer_send：sessionController.prompt 不可用（插件未注入该服务）');
      }
      const message = typeof args.message === 'string' ? args.message : '';
      if (message.trim() === '') throw new Error('message 不能为空');
      const mode = args.mode === 'steer' ? 'steer' : 'queue';
      // 来源标记：dsh 把宿主投递的消息记成 source.kind === "user"，不加标记的话，
      // 平级会话的消息在日志和界面上与用户消息完全无法区分。
      const sender = exec?.agent?.session?.header?.id ?? 'unknown';
      const marker = peerMarker(sender);
      const body = message.startsWith(marker) ? message : marker + NL + message;
      const receipt = await controller.prompt(
        {
          requestId: randomUUID(),
          sessionId: args.session_id,
          mode,
          content: [{ type: 'text', text: body }],
        },
        new AbortController().signal,
      );
      return {
        text:
          'accepted=' + String(receipt.accepted) + ' mode=' + mode + ' target=' + args.session_id + ' from=' + sender,
      };
    },
  };
}
