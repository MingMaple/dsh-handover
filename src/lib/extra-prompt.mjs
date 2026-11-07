/**
 * 用户全局前置提示词：存在本机 ~/.dsh/storages/ 下。
 * 与插件自身的会话约束无关：仅当用户显式开启且内容非空时注入全部会话；
 * 关闭或留空时不注册提示段，不占用注入点位，避免与其他提示词插件冲突。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 与官方 SECTION_ORDERS 对齐：FILE_REFERENCE=900，工具段从 1000 起。 */
export const EXTRA_PROMPT_ORDER = 950;
export const EXTRA_PROMPT_SECTION = 'dsh-handover:extra-prompt';
const EXTRA_PROMPT_MAX = 20000;

function storePath() {
  return path.join(os.homedir(), '.dsh', 'storages', 'dsh-handover.extra-prompt.json');
}

/** 返回 { enabled, text }。旧文件只有 text 时，按「内容非空即开启」迁移。 */
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

/** 保存并返回 { enabled, text }；空内容一律视为关闭。 */
export function writeExtraPrompt(text, enabled) {
  const clean = String(text == null ? '' : text).trim();
  if (clean.length > EXTRA_PROMPT_MAX) throw new Error('全局前置提示词过长（上限 ' + EXTRA_PROMPT_MAX + ' 字符）');
  const on = enabled !== false && clean.length > 0;
  const p = storePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const body = { enabled: on, text: clean, updatedAt: new Date().toISOString() };
  fs.writeFileSync(p, JSON.stringify(body, null, 2) + '\n', 'utf8');
  return body;
}
