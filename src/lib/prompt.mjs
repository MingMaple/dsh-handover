/**
 * 会话投递的唯一入口：把一条纯文本作为用户消息排进目标会话。
 * 角色整理指令、换任启动提示词、压缩后继续，3 处都用它，避免各自拼一套 requestId 与中止信号。
 */

/**
 * 投递一条文本。
 * @param {object} controller 会话控制器，由调用方按自己的服务句柄给出
 * @param {string} sessionId 目标会话 id
 * @param {string} text 正文，按纯文本投递
 * @param {string} [mode] 投递模式，缺省 queue
 * @param {AbortSignal} [signal] 本次工具调用的中止信号
 * @returns {Promise<object>} 宿主返回的投递结果，含 accepted 字段
 * @throws {Error} 控制器没有 prompt 方法时抛出：此时无法投递，调用方须报错而不是静默跳过
 */
export function sendPrompt(controller, sessionId, text, mode, signal) {
  if (!controller || typeof controller.prompt !== 'function') throw new Error('sessionController.prompt 不可用');
  const requestId = (globalThis.crypto && globalThis.crypto.randomUUID)
    ? globalThis.crypto.randomUUID()
    : String(Date.now());
  return controller.prompt({
    requestId,
    sessionId: String(sessionId),
    mode: mode || 'queue',
    content: [{ type: 'text', text: String(text) }],
  }, signal || new AbortController().signal);
}
