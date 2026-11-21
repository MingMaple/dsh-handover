/**
 * 会话投递的唯一入口：把一条纯文本作为用户消息排进目标会话。
 * 角色整理指令、换任启动提示词、压缩后继续，3 处都用它，避免各自拼一套 requestId 与中止信号。
 */

/**
 * 唤醒冷会话：host 的 prompt 语义是「先显式 resume，再投递」。
 * 已在运行的会话 resume 会失败，失败不阻断投递；控制器没有 resume 时跳过。
 * @returns {Promise<boolean>} 是否完成了一次 resume 调用
 */
export async function wakeSession(controller, sessionId, signal) {
  if (!controller || typeof controller.resume !== 'function') return false;
  try {
    await controller.resume(String(sessionId));
    return true;
  } catch {
    return false;
  }
}

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
export async function sendPrompt(controller, sessionId, text, mode, signal) {
  if (!controller || typeof controller.prompt !== 'function') throw new Error('sessionController.prompt 不可用');
  await wakeSession(controller, sessionId, signal);
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
