/**
 * 会话投递的唯一入口：把一条纯文本作为用户消息排进目标会话。
 * 角色整理指令、换任启动提示词、压缩后继续，三处都用它，避免各自拼一套 requestId 与中止信号。
 */

/** 投递一条文本；controller 由调用方按自己的服务句柄给出。 */
export function sendPrompt(controller, sessionId, text, mode) {
  if (!controller || typeof controller.prompt !== 'function') throw new Error('sessionController.prompt 不可用');
  const requestId = (globalThis.crypto && globalThis.crypto.randomUUID)
    ? globalThis.crypto.randomUUID()
    : String(Date.now());
  return controller.prompt({
    requestId,
    sessionId: String(sessionId),
    mode: mode || 'queue',
    content: [{ type: 'text', text: String(text) }],
  }, new AbortController().signal);
}
