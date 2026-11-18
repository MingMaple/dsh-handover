/**
 * 用户全局前置提示词：保存于本机 `~/.dsh/storages/` 下。
 * 该提示词与插件自身的会话约束无关，只表达用户本人的偏好。
 * 仅在用户显式开启且内容非空时注入全部会话。
 * 关闭或留空时不注册提示段，也不占用注入点位，以免与其他提示词插件冲突。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 段序 950：位于官方 FILE_REFERENCE（900）之后、工具段（1000）之前，与 SECTION_ORDERS 对齐。 */
export const EXTRA_PROMPT_ORDER = 950;
export const EXTRA_PROMPT_SECTION = 'dsh-handover:extra-prompt';
const EXTRA_PROMPT_MAX = 20000;
/** 旧通道请求体上限 64 KB，留出 JSON 信封与转义余量；20000 个中文字符约 60 KB，按字节须再判一次。 */
const EXTRA_PROMPT_MAX_BYTES = 56 * 1024;

function storePath() {
  return path.join(os.homedir(), '.dsh', 'storages', 'dsh-handover.extra-prompt.json');
}

/**
 * 读取已保存的提示词。
 * 旧版文件只有 text 字段时，按「内容非空即开启」迁移，避免升级后开关状态丢失。
 * @returns {{enabled:boolean, text:string}} 文件缺失或内容损坏时返回关闭状态与空正文
 */
export function readExtraPrompt() {
  try {
    const j = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
    const text = typeof j.text === 'string' ? j.text : '';
    const enabled = typeof j.enabled === 'boolean' ? j.enabled : text.trim() !== '';
    return { enabled, text };
  } catch {
    return { enabled: false, text: '' };
  }
}

/**
 * 保存提示词并返回落盘内容。
 * 空内容一律视为关闭，因此关闭无需另行传 enabled=false。
 * @param {string} text 提示词正文
 * @param {boolean} [enabled] 开关；传 false 时即使正文非空也不注入
 * @returns {{enabled:boolean, text:string, updatedAt:string}}
 * @throws {Error} 正文超过 20000 字符时抛出，避免把过长的前缀写进每一轮请求
 */
export function writeExtraPrompt(text, enabled) {
  const clean = String(text == null ? '' : text).trim();
  const bytes = Buffer.byteLength(clean, 'utf8');
  if (clean.length > EXTRA_PROMPT_MAX) {
    throw new Error('现象：全局前置提示词过长（' + clean.length + ' 字符）。原因：上限为 ' + EXTRA_PROMPT_MAX + ' 字符。处置：精简正文后重试。');
  }
  if (bytes > EXTRA_PROMPT_MAX_BYTES) {
    throw new Error('现象：全局前置提示词过长（' + clean.length + ' 字符，UTF-8 ' + bytes + ' 字节）。原因：上限为 ' + EXTRA_PROMPT_MAX + ' 字符且 ' + EXTRA_PROMPT_MAX_BYTES + ' 字节（旧通道请求体 64 KB）；多字节字符按字节计会超限。处置：精简正文后重试。');
  }
  const on = enabled !== false && clean.length > 0;
  const p = storePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const body = { enabled: on, text: clean, updatedAt: new Date().toISOString() };
  fs.writeFileSync(p, JSON.stringify(body, null, 2) + '\n', 'utf8');
  return body;
}
