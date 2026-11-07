/**
 * 压缩授权：压缩会丢历史，所以「同意」必须由用户自己产生，AI 不能自己给自己批。
 *
 * 做法：唯一的授权入口是设置页上的一次点击（用户在场、只能是用户按），
 * 授权一次有效 5 分钟、只对指定会话生效；`ho_checkpoint`、全局代排与调度器三处都校验它。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CONSENT_TTL_MS = 5 * 60 * 1000;

function consentPath() {
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  return path.join(home, '.dsh', 'storages', 'dsh-handover.consent.json');
}

function readAll() {
  try {
    const t = fs.readFileSync(consentPath(), 'utf8').replace(/^\uFEFF/, '');
    const v = JSON.parse(t);
    return v && typeof v === 'object' ? v : {};
  } catch { return {}; }
}

function writeAll(v) {
  const p = consentPath();
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch { /* ignore */ }
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

function stampNow() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ' +0800';
}

/** 用户点了一次「允许该会话压缩一次」。 */
export function grantConsent(sessionId, note) {
  const sid = String(sessionId || '');
  if (!sid) throw new Error('缺少会话 id');
  const all = readAll();
  const now = Date.now();
  all[sid] = { at: now, until: now + CONSENT_TTL_MS, atText: stampNow(), note: String(note || '') };
  writeAll(all);
  return { sessionId: sid, until: new Date(all[sid].until).toISOString(), minutes: CONSENT_TTL_MS / 60000, atText: all[sid].atText };
}

/** 授权是否有效（每次读取时一并清除已过期者）。 */
export function checkConsent(sessionId) {
  const sid = String(sessionId || '');
  if (!sid) return { ok: false, reason: '没有会话 id' };
  const all = readAll();
  const hit = all[sid];
  const now = Date.now();
  let dirty = false;
  for (const k of Object.keys(all)) {
    if (!all[k] || !all[k].until || all[k].until <= now) { delete all[k]; dirty = true; }
  }
  if (dirty) { try { writeAll(all); } catch { /* ignore */ } }
  if (!hit || !hit.until || hit.until <= now) {
    return { ok: false, reason: '用户还没有在设置页点「允许压缩」' };
  }
  return { ok: true, until: hit.until, leftMs: hit.until - now, atText: hit.atText || '' };
}

export function consumedConsent(sessionId) {
  const all = readAll();
  const sid = String(sessionId || '');
  if (all[sid]) { delete all[sid]; try { writeAll(all); } catch { /* ignore */ } }
}

export function listConsent() {
  const all = readAll();
  const now = Date.now();
  return Object.keys(all).map((sid) => ({
    sessionId: sid,
    leftMs: Math.max(0, (all[sid].until || 0) - now),
    atText: all[sid].atText || '',
    note: all[sid].note || '',
  })).filter((r) => r.leftMs > 0);
}
