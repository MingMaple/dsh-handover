/**
 * 换任自服务：在任会话在用户授权后，自己校验交接、建接任会话、登记在任并投递启动提示词。
 *
 * 越权防线：建什么角色的会话只认会话自身已登记的角色（env.roleOf），不采信调用参数；
 * 名字只认登记表的历史最大号（nextName），不采信会话自述。
 * 全部校验（角色、授权、交接结构、在任身份、工作区、提示词）都在第一次写盘之前完成：
 * 任何一项不通过，整体不落任何写操作，只返回中文原因。
 */
import fs from 'node:fs';
import { NL, readUtf8 } from './text.mjs';
import { lineageKeyOf, loadOffice, nextName, registerHolder, stampNow } from './office.mjs';
import { checkConsent, consumedConsent } from './consent.mjs';
import { newSessionIn } from './session-create.mjs';
import { sendPrompt } from './prompt.mjs';
import { resolveWorkspaceFor, promptFor, workspaceIdOfPath, workspacePathOf } from './session-ops.mjs';
import { watermark } from './facts.mjs';

/** 交接里不得残留的占位符。 */
export const HANDOVER_PLACEHOLDERS = ['待填', 'TODO', '（建完后填）', '<填'];

function msgOf(e) {
  return String(e && e.message ? e.message : e);
}

/** 现任全局会话 id（登记表是唯一事实源）；没有记录或读不到时返回空串。 */
function currentGlobalId(ws) {
  try {
    const lin = loadOffice(ws).lineages['全局'];
    return lin && lin.current && lin.current.sessionId ? String(lin.current.sessionId) : '';
  } catch { return ''; }
}

/**
 * 找接任指令节：含「## 下一步」或「## 2.」这类标题；没有标题时接受 §2 的写法。
 * 判据与 ho_gate 的交接体检一致：这一节至少要有一个条目（列表、表格或编号行）。
 */
function nextSectionOf(text) {
  const lines = text.split(NL);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.startsWith('## ')) continue;
    if (l.indexOf('下一步') !== -1 || /^##\s*2(?:[.、\s]|$)/.test(l)) { start = i; break; }
  }
  if (start === -1) {
    if (/§\s*2/.test(text)) return { ok: true };
    return { ok: false, reason: '缺少接任指令节：应有「## 下一步」或「## 2.」一节' };
  }
  const rows = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) break;
    const t = lines[i].trim();
    if (/^[-*]\s+/.test(t)) rows.push(t);
    else if (/^\|/.test(t) && t.indexOf('---') === -1) rows.push(t);
    else if (/^\d+[.、]\s+/.test(t)) rows.push(t);
  }
  if (!rows.length) return { ok: false, reason: '「下一步」一节没有列出任何条目' };
  return { ok: true };
}

/** 交接结构检查（只判结构）：返回缺项列表，空数组表示通过。 */
export function auditHandover(file) {
  const problems = [];
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return ['交接路径不是文件：' + file];
  } catch {
    return ['交接文件不存在：' + file];
  }
  let text = '';
  try { text = readUtf8(file).replace(/^\uFEFF/, ''); } catch (e) { return ['交接文件读取失败：' + msgOf(e)]; }
  if (!text.trim()) return ['交接文件为空：' + file];
  const next = nextSectionOf(text);
  if (!next.ok) problems.push(next.reason);
  for (const p of HANDOVER_PLACEHOLDERS) {
    if (text.indexOf(p) !== -1) problems.push('仍有占位符：' + p);
  }
  return problems;
}

/** 在旧会话的交接末尾追加「换任登记」：先备份到同目录 .bak，再追加。 */
function appendSuccessionBlock(file, lines) {
  const cur = readUtf8(file);
  const bom = cur.charCodeAt(0) === 0xFEFF ? '\uFEFF' : '';
  const body = bom ? cur.slice(1) : cur;
  fs.copyFileSync(file, file + '.bak');
  const gap = body.endsWith(NL) ? NL : NL + NL;
  const block = ['## 换任登记', ''].concat(lines).join(NL);
  fs.writeFileSync(file, bom + body + gap + block + NL, 'utf8');
  return file + '.bak';
}

/**
 * 执行一次换任自服务。
 * @param {object} env 插件环境
 * @param {object} exec 工具执行上下文
 * @param {object} [opts] { note, force }：force 为 true 时越过「水位未到线」判据
 * @returns {Promise<string>} 中文结果或失败原因
 */
export async function runSuccession(env, exec, opts) {
  const o = opts || {};
  const note = typeof o.note === 'string' ? o.note.trim() : '';
  const reject = (reason) => '换任未执行，未做任何写入。' + NL + reason;

  // 1. 自身角色与类别：只认已登记的角色。
  const info = env.roleOf(exec) || {};
  const kind = String(info.role || 'plain');
  if (kind === 'plain') return reject('普通会话不参与换任。');
  if (kind !== 'global' && kind !== 'project' && kind !== 'misc') return reject('本会话角色无法用于换任：' + kind);
  const project = String(info.project || '');
  const task = String(info.task || '');
  const key = lineageKeyOf(kind, project, task);
  if (!key) return reject(kind === 'project' ? '项目名缺失，无法确定类别。' : '任务名缺失，无法确定类别。');

  // 2. 用户授权：AI 不能自行批准。
  const selfId = env.selfId(exec);
  if (!selfId) return reject('无法获取当前会话 id，无法校验授权。');
  const cs = checkConsent(selfId, 'succeed');
  if (!cs.ok) {
    return reject([
      cs.reason + '。',
      '授权方式（任选其一）：',
      '  ① 在聊天框发送 /allow-succeed（最快，仅授权本会话）；',
      '  ② 在设置页的 dsh-handover 中，点击「授权」里的「授权换任」。',
      '授权有效期 5 分钟，用后失效。',
    ].join(NL));
  }

  // 3. 交接结构检查（只判结构，不判质量）。
  const hp = env.handoverFor(exec) || {};
  const handoverFile = hp.path ? String(hp.path) : '';
  if (!handoverFile) return reject('没有交接路径：' + (hp.reason || '本会话角色未确定'));
  const problems = auditHandover(handoverFile);
  if (problems.length) {
    return reject(['交接结构未通过：' + handoverFile]
      .concat(problems.map((p) => '  - ' + p))
      .concat(['补齐后重新调用 ho_succeed。'])
      .join(NL));
  }

  // 4. 在任身份与重复换任：登记表是唯一记录。
  const ws = String(env.resolveWs(exec) || '');
  if (!ws) return reject('无法确定工作区根，读不到在任登记表。');
  const store = loadOffice(ws);
  const lin = store.lineages[key];
  // 只有本类别的在任者本人可换任：既防旧会话复活，也防同项目的旁支会话抢先。
  if (!lin || !lin.current || !lin.current.sessionId) {
    return reject('本类别（' + key + '）在在任登记表里还没有现任记录：先由全局建会话并登记，再换任。');
  }
  if (String(lin.current.sessionId) !== String(selfId)) {
    return reject('本会话不是在任者：本类别现任为 ' + String(lin.current.name || '（未命名）')
      + '（' + String(lin.current.sessionId) + '），不得换任。');
  }
  {
    const history = Array.isArray(lin.history) ? lin.history : [];
    const closed = history.find((h) => h && String(h.sessionId || '') === String(selfId) && h.to);
    if (closed) {
      const curName = lin.current && lin.current.name ? lin.current.name : '（空缺）';
      return reject('本类别已为本会话记过一次换任（' + String(closed.to || '') + '，现任 ' + curName + '），旧会话不得再次换任。');
    }
  }

  // 4.1 水位未到线：本会话就是在任者且水位低于提醒线时，换任通常是多余的。
  // 放在授权与交接校验之后、任何写入之前；取不到水位就跳过。
  if (o.force !== true) {
    let pct = null;
    try { pct = typeof env.selfPct === 'function' ? env.selfPct(selfId) : null; } catch { pct = null; }
    if (pct !== null && pct !== undefined && Number(pct) < watermark(env.cfg).warnValue) {
      return reject('本会话水位 ' + Number(pct).toFixed(1) + '%，尚未到线，通常无需换任；确需换任请传 force=true。');
    }
  }

  // 5. 分配编号：登记表历史最大号加一，不采用会话自述。
  const name = nextName(store, key);

  // 6. 确定工作区：与 ho_sessions(action="new") 同一套解析。
  // 杂项接任者落回**本会话所在的注册工作区**（按会话 cwd 反查）；反查不到才退回工作区根。
  let workspaceId = '';
  try {
    let wsOpt = {};
    if (kind === 'misc') {
      const selfCwd = typeof env.selfCwd === 'function' ? String(env.selfCwd(exec) || '') : '';
      wsOpt = selfCwd && workspaceIdOfPath(env, selfCwd) ? { cwd: selfCwd } : { workspace: ws };
    }
    workspaceId = resolveWorkspaceFor(env, exec, kind, project, task, wsOpt);
  } catch (e) {
    return reject(msgOf(e));
  }

  // 7. 拼启动提示词：末尾追加交接路径与「先读交接、读毕报到」。
  // 「全局 id」填**现任全局**：项目与杂项换任时，已交出的旧会话不是全局，不能顶替这个位置。
  let prompt = '';
  try {
    const globalId = kind === 'global' ? selfId : (currentGlobalId(ws) || selfId);
    const base = promptFor(env, { ws, kind, project, task, title: name, sessionId: '', globalSessionId: globalId, extra: '' });
    prompt = base + NL + NL + [
      '接任交接：' + handoverFile,
      '先读这份交接再动手；读毕向当前用户报告当前停在哪一步、交接列有哪些待办，然后等待当前用户指派任务。',
    ].join(NL);
  } catch (e) {
    return reject('启动提示词生成失败：' + msgOf(e));
  }

  // 8. 建会话：失败即停止，不登记。
  const made = await newSessionIn(env, { workspaceId, title: name, role: kind, project, task });
  const sessionId = made && made.sessionId ? String(made.sessionId) : '';
  if (!sessionId) return reject('建会话失败，未做任何登记：' + ((made && made.error) || '原因未知'));
  // 提示词里预留的是「建完后填」，拿到会话 id 后在这里替换成真实 id。
  const text = prompt.split('（建完后填）').join(sessionId);

  // 9. 登记在任：原在任者自动进历史，Registry.md 在役列同步。
  let reg = null;
  try {
    reg = registerHolder(ws, { kind, project, task, name, sessionId, workspace: workspacePathOf(env, workspaceId) || ws, note });
  } catch (e) {
    return [
      '会话已建 ' + sessionId + '（' + name + '），但登记在任失败：' + msgOf(e),
      '启动提示词尚未投递；先修好登记表，再用 peer（action="send"）通知它。',
    ].join(NL);
  }

  // 10. 投递启动提示词：失败要如实报出，会话已经存在。
  let delivered = false;
  let deliveryError = '';
  try {
    const r = await sendPrompt(env.controller(), sessionId, text, 'queue');
    delivered = !!(r && r.accepted);
    if (!delivered) deliveryError = '会话控制器未接受（accepted=false）';
  } catch (e) {
    deliveryError = msgOf(e);
  }

  // 11. 旧会话的交接末尾追加换任登记；写前备份。
  let appendNote = '';
  try {
    const bak = appendSuccessionBlock(handoverFile, [
      '- 接任者：' + name,
      '- 会话 id：' + sessionId,
      '- 时刻：' + stampNow(),
      ...(note ? ['- 备注：' + note] : []),
      '- 旧会话停止作业。',
    ]);
    appendNote = '已写入交接末尾（备份 ' + bak + '）';
  } catch (e) {
    appendNote = '换任登记写入失败：' + msgOf(e);
  }

  // 12. 消费授权：一次授权只够换任一次。
  try { consumedConsent(selfId, 'succeed'); } catch { /* 授权文件损坏不影响本次结果 */ }

  // 13. 结果。
  const out = [];
  out.push('换任完成：' + name + '（' + sessionId + '）');
  out.push('在任登记：' + key + (reg && reg.registry && reg.registry.changed && reg.registry.changed.length
    ? '，Registry.md 已同步在役列' : ''));
  out.push('启动提示词：' + (delivered ? '已投递' : '未送达：' + deliveryError + '。会话已建，可用 peer（action="send"）补投'));
  out.push('交接登记：' + appendNote);
  out.push('本会话到此停止，等待当前用户在新会话中派任务。');
  return out.join(NL);
}
