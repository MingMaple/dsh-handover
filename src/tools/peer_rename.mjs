/** peer_rename —— 改会话显示标题：命名约定 项目会话 <项目名><N>、全局 全局<N>。 */
import { textOutput } from '../lib/output.mjs';
import { peerNameOf } from '../lib/names.mjs';

export function pmPeerRenameTool(env) {
  return {
    name: peerNameOf('rename'),
    description:
      '只改显示标题，不唤醒目标会话。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['session_id', 'title'],
      properties: {
        session_id: { type: 'string', description: '目标会话 id' },
        title: { type: 'string', description: '新的显示标题（如 Demo4 / DemoB4 / 全局11）' },
      },
    },
    output: textOutput(),
    async execute(args) {
      const controller = env.controller();
      if (!controller || typeof controller.rename !== 'function') {
        throw new Error('peer_rename：sessionController.rename 不可用（插件未注入该服务）');
      }
      const title = String(args.title ?? '').trim();
      if (title === '') throw new Error('peer_rename: title 不能为空');
      await controller.rename({ sessionId: args.session_id, title });
      return { text: 'renamed ' + args.session_id + ' -> ' + title };
    },
  };
}
