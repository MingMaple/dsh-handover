/**
 * 一次性授权：压缩会丢历史，换任会换掉在任会话，所以「同意」必须由用户自己产生，AI 不能自己给自己批。
 *
 * 做法：授权入口只有用户亲手产生的那一次（设置页点击或聊天页斜杠命令），
 * 授权一次有效 5 分钟、只对指定会话与指定种类生效；压缩与换任各有各的授权，互不顶替。
 * 种类取 compact（压缩）或 succeed（换任），缺省为 compact；旧文件里没有 kind 的条目按 compact 处理。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CONSENT_TTL_MS = 5 * 60 * 1000;
export const CONSENT_KINDS = ['compact', 'succeed'];
const DEFAULT_KIND = 'compact';

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

function kindOf(kind) {
  const k = String(kind === undefined || kind === null ? '' : kind).trim();
  if (!k) return DEFAULT_KIND;
  if (CONSENT_KINDS.indexOf(k) === -1) throw new Error('未知授权种类：' + k + '（只能是 compact 或 succeed）');
  return k;
}

/**
 * 存储键：压缩沿用会话 id 本身（兼容旧文件），换任另加后缀，两种授权可以同时存在。
 */
function keyFor(sid, kind) {
  return kind === DEFAULT_KIND ? sid : sid + '|' + kind;
}

function sidOfKey(key) {
  return key.indexOf('|') === -1 ? key : key.slice(0, key.indexOf('|'));
}

/** 条目自身的种类优先；旧条目没有 kind，按 compact 处理。 */
function kindOfEntry(key, entry) {
  const k = entry && entry.kind ? String(entry.kind) : '';
  if (CONSENT_KINDS.indexOf(k) !== -1) return k;
  return key.indexOf('|succeed') === -1 ? DEFAULT_KIND : 'succeed';
}

/** 用户授权一次：kind 缺省为压缩。 */
export function grantConsent(sessionId, note, kind) {
  const sid = String(sessionId || '');
  if (!sid) throw new Error('缺少会话 id');
  const k = kindOf(kind);
  const all = readAll();
  const now = Date.now();
  const key = keyFor(sid, k);
  all[key] = { at: now, until: now + CONSENT_TTL_MS, atText: stampNow(), note: String(note || ''), kind: k };
  writeAll(all);
  return { sessionId: sid, kind: k, until: new Date(all[key].until).toISOString(), minutes: CONSENT_TTL_MS / 60000, atText: all[key].atText };
}

/** 授权是否有效（每次读取时一并清除已过期者）。 */
export function checkConsent(sessionId, kind) {
  const sid = String(sessionId || '');
  const k = kindOf(kind);
  if (!sid) return { ok: false, reason: '没有会话 id' };
  const all = readAll();
  const key = keyFor(sid, k);
  const hit = all[key];
  const now = Date.now();
  let dirty = false;
  for (const keyName of Object.keys(all)) {
    if (!all[keyName] || !all[keyName].until || all[keyName].until <= now) { delete all[keyName]; dirty = true; }
  }
  if (dirty) { try { writeAll(all); } catch { /* ignore */ } }
  if (!hit || !hit.until || hit.until <= now) {
    return {
      ok: false,
      kind: k,
      reason: k === 'succeed' ? '当前用户还没有授权换任（聊天页命令 /allow-succeed）' : '当前用户还没有在设置页点「授权压缩」',
    };
  }
  return { ok: true, kind: k, until: hit.until, leftMs: hit.until - now, atText: hit.atText || '' };
}

export function consumedConsent(sessionId, kind) {
  const all = readAll();
  const sid = String(sessionId || '');
  const key = keyFor(sid, kindOf(kind));
  if (all[key]) { delete all[key]; try { writeAll(all); } catch { /* ignore */ } }
}

export function listConsent() {
  const all = readAll();
  const now = Date.now();
  const rows = Object.keys(all).map((key) => ({
    sessionId: sidOfKey(key),
    kind: kindOfEntry(key, all[key]),
    leftMs: Math.max(0, (all[key].until || 0) - now),
    atText: all[key].atText || '',
    note: all[key].note || '',
  })).filter((r) => r.leftMs > 0);
  return rows.sort((a, b) => a.sessionId.localeCompare(b.sessionId, 'zh') || a.kind.localeCompare(b.kind));
}

/**
 * 某会话当前有效的授权（只读，不清过期条目）。
 * 提示段与 ho_status 共用：授权一旦写入，下一轮重建提示段时就能看见；过期自然消失。
 */
export function activeConsentsFor(sessionId) {
  const sid = String(sessionId || '');
  if (!sid) return [];
  const all = readAll();
  const now = Date.now();
  const rows = [];
  for (const key of Object.keys(all)) {
    const entry = all[key];
    if (!entry || !entry.until || entry.until <= now) continue;
    if (sidOfKey(key) !== sid) continue;
    rows.push({
      kind: kindOfEntry(key, entry),
      until: entry.until,
      leftMs: entry.until - now,
      atText: entry.atText || '',
      note: entry.note || '',
    });
  }
  return rows.sort((a, b) => a.kind.localeCompare(b.kind));
}

const KIND_LABEL = { compact: '压缩', succeed: '换任' };

function untilText(ms) {
  const d = new Date(ms);
  const off = -d.getTimezoneOffset();
  const pad = (n) => String(n).padStart(2, '0');
  const a = Math.abs(off);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' '
    + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ' ' + (off >= 0 ? '+' : '-') + pad(Math.floor(a / 60)) + pad(a % 60);
}

/** 提示段用：每种有效授权一行，极短；无授权返回空数组（不占位）。 */
export function consentPromptLines(rows) {
  return (rows || []).map((r) => '当前用户已授权' + KIND_LABEL[r.kind] + '，至 ' + untilText(r.until) + '（一次性，用后失效）。');
}

/** ho_status 用：一行状态，压缩与换任各说一句，未授权的写「无授权」。 */
export function formatConsentLine(rows) {
  const hit = new Map((rows || []).map((r) => [r.kind, r]));
  const parts = CONSENT_KINDS.map((k) => {
    const r = hit.get(k);
    if (!r) return KIND_LABEL[k] + ' 无授权';
    const min = Math.max(1, Math.ceil(r.leftMs / 60000));
    return KIND_LABEL[k] + ' 剩余 ' + min + ' 分钟（至 ' + untilText(r.until) + '，一次性）';
  });
  return parts.join('；');
}
