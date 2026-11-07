/** peer_new —— 新建平级会话（无父血缘，永远不会自动通知任何人）。 */
import { randomUUID } from 'node:crypto';
import { peerNameOf } from '../lib/names.mjs';
import { textOutput } from '../lib/output.mjs';
import { resolveWorkspaceId } from '../lib/peer.mjs';

export function pmPeerNewTool(env) {
  return {
    name: peerNameOf('new'),
    description:
      '新建平级会话，可指定工作区与标题。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        cwd: { type: 'string', description: '新会话的工作目录' },
        workspace: {
          type: 'string',
          description:
            '工作区 id、标题、路径。传入后**直接建立在该工作区内**（cwd 取该工作区的 path），不再归入「未分类」。与 cwd 互斥。',
        },
        title: { type: 'string', description: '新会话的显示标题' },
        message: { type: 'string', description: '可选：投递一条起始消息' },
      },
    },
    output: textOutput(),
    async execute(args) {
      const controller = env.controller();
      if (!controller || typeof controller.create !== 'function') {
        throw new Error('peer_new：sessionController.create 不可用（插件未注入该服务）');
      }
      const wantsWorkspace = typeof args.workspace === 'string' && args.workspace.trim() !== '';
      if (wantsWorkspace && args.cwd !== undefined) {
        throw new Error(
          'peer_new: 传 workspace 时不要再传 cwd —— session.create 只接受其中之一（cwd 会自动取该工作区的 path）',
        );
      }
      let request = {};
      if (wantsWorkspace) {
        const workspaceId = resolveWorkspaceId(args.workspace);
        if (workspaceId === null || workspaceId === undefined) {
          throw new Error(
            'peer_new: 找不到工作区「' + args.workspace + '」（可用 id / 标题 / 路径；数据源 storages/workspace.json）',
          );
        }
        request = { workspaceId };
      } else if (args.cwd !== undefined) {
        request = { cwd: args.cwd };
      }
      const created = await controller.create(request);
      const id = created.sessionId;
      if (typeof args.title === 'string' && args.title.trim() !== '') {
        try {
          await controller.rename({ sessionId: id, title: args.title.trim() });
        } catch (error) {
          if (typeof env.log === 'function') env.log('peer_new: 改标题失败：' + String(error));
        }
      }
      let tail = '';
      if (typeof args.message === 'string' && args.message.trim() !== '') {
        await controller.prompt(
          {
            requestId: randomUUID(),
            sessionId: id,
            mode: 'queue',
            content: [{ type: 'text', text: args.message }],
          },
          new AbortController().signal,
        );
        tail = ' (opening message delivered)';
      }
      return { text: 'created ' + id + tail };
    },
  };
}
