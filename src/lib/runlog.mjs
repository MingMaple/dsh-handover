/** 运行日志：把压缩结果写到固定文件，便于重启后核对轮内执行与失败原因。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 日志文件位置：用户主目录下的插件自有目录，与工作区无关。 */
function runLogPath() {
  return path.join(os.homedir(), '.dsh', 'storages', 'dsh-handover', 'logs', 'schedule.log');
}

/**
 * 追加一行日志。
 * 日志只用于事后核对，写失败不应影响压缩，因此目录不可写时静默跳过。
 * @param {string} msg 日志正文，按原样追加
 * @returns {void}
 */
export function appendRunLog(msg) {
  try {
    const file = runLogPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const line = new Date().toISOString() + ' ' + String(msg) + String.fromCharCode(10);
    const bom = fs.existsSync(file) ? '' : String.fromCharCode(0xfeff);
    fs.appendFileSync(file, bom + line);
  } catch { /* 日志失败不阻断压缩 */ }
}
