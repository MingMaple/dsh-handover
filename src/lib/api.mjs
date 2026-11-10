/**
 * 设置页数据与动作的唯一实现：HTTP 路由（旧通道）和 /api 载体（新通道）都调它。
 * 返回统一信封：{ ok:true, value } | { ok:false, error:{code,message,details}, http }。
 * http 只是给旧 HTTP 通道用的状态码提示，载体通道不用它。
 */
import fs from 'node:fs';
import path from 'node:path';
import { isDir } from './text.mjs';
import { buildStatus } from './status.mjs';
import { createGlobalWorkspace } from './scaffold.mjs';
import { probeMove, startMove, moveStatus, cleanupOld, stageSwitch, repairLink, stageRetarget, applyRetarget } from './mover.mjs';
import { routeWorkspace } from './workspace.mjs';
import { grantConsent, listConsent, consumedConsent } from './consent.mjs';
import { newSessionIn } from './session-create.mjs';

function msgOf(e) { return String(e && e.message ? e.message : e); }

/** 当前全局根：先按 cwd 推断，推不出来再查注册表里标题含「全局」的那个。 */
export function currentRoot(env) {
  let ws = '';
  try { ws = String(routeWorkspace(env) || ''); } catch { ws = ''; }
  if (ws && isDir(path.join(ws, '_Control_Center'))) return ws;
  try {
    const reg = env.registry && env.registry();
    const list = reg && typeof reg.list === 'function' ? reg.list() || [] : [];
    for (const w of list) {
      const p = String((w && w.path) || '');
      if (!p) continue;
      if (String((w && w.title) || '').indexOf('全局') === -1) continue;
      if (isDir(path.join(p, '_Control_Center'))) return p;
    }
  } catch { /* ignore */ }
  return ws || '';
}

/** 状态快照缓存：设置页只取现成结果，不让请求等待现算。 */
const statusCache = new WeakMap();   // env → { at, json, ms }
const STATUS_TTL_MS = 30000;

function invalidateStatus(env) { try { statusCache.delete(env); } catch { /* ignore */ } }

export function statusSnapshot(env, info, why) {
  const now = Date.now();
  const hit = statusCache.get(env);
  if (hit && now - hit.at < STATUS_TTL_MS) {
    env.log('状态快照：命中缓存（' + (why || 'call') + '，' + hit.ms + ' ms 前计算）');
    return hit.json;
  }
  const t0 = Date.now();
  const json = buildStatus(env, info);
  const ms = Date.now() - t0;
  statusCache.set(env, { at: Date.now(), json, ms });
  env.log('状态快照：现算 ' + ms + ' ms（' + (why || 'call') + '）');
  return json;
}

/** 允许在设置页与聊天命令里填短号：session-xxxx… 前 8 位即可，这里补全成完整 id。 */
export function resolveShortSid(env, input) {
  const s = String(input || '').trim();
  if (!s) return '';
  if (s.indexOf('session-') === 0) return s;
  try {
    const dir = typeof env.cacheDir === 'function' ? env.cacheDir() : '';
    if (dir) {
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.json')) continue;
        const stem = name.replace('.json', '');
        if (stem.indexOf('session-' + s) === 0) return stem;
        if (stem.slice(8, 8 + s.length) === s) return stem;
      }
    }
  } catch { /* 找不到就按原样 */ }
  return s;
}

/** 在已注册的工作区里建一个「全局」会话：先按工作区 id，抓不到再用 cwd。 */
async function createGlobalSession(env, rootPath, title) {
  let workspaceId = '';
  try {
    const reg = env.registry && env.registry();
    const list = reg && typeof reg.list === 'function' ? (reg.list() || []) : [];
    const norm = (s) => String(s || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const hit = list.find((w) => w && norm(w.path) === norm(rootPath));
    if (hit) workspaceId = String(hit.id || '');
  } catch { workspaceId = ''; }
  const made = await newSessionIn(env, {
    workspaceId,
    cwd: workspaceId ? '' : rootPath,
    title: title || '全局',
    role: 'global',
  });
  return { sessionId: made.sessionId || '', error: made.error || '', workspaceId };
}

export function createApi(env, info) {
  const ok = (value) => ({ ok: true, value });
  const bad = (code, message, http) => ({ ok: false, error: { code, message, details: {} }, http: http || 400 });
  const boom = (e, http) => bad('failed', msgOf(e), http || 400);

  async function call(method, payload) {
    const p = payload && typeof payload === 'object' ? payload : {};
    try {
      if (method === 'status') {
        env.lastStatusCallAt = Date.now();   // 供预热判断「最近有人看过设置页」
        return ok(statusSnapshot(env, info, 'call'));
      }

      if (method === 'setup') {
        const r = createGlobalWorkspace(p.parent, { name: p.name });
        invalidateStatus(env);
        return r && r.ok ? ok(r) : { ok: false, error: { code: 'setup-failed', message: String((r && r.error) || '建立失败'), details: {} }, http: 400 };
      }

      if (method === 'deploy') {
        // 一键部署：建文件体系 → 注册「全局」工作区 → 建「全局」会话（三件事一次做完）。
        const scaffold = createGlobalWorkspace(p.parent, { name: p.name });
        if (!scaffold || scaffold.ok !== true) {
          return { ok: false, error: { code: 'setup-failed', message: String((scaffold && scaffold.error) || '建立失败'), details: {} }, http: 400 };
        }
        let ws = null;
        let workspaceError = '';
        try {
          const reg = env.registry && env.registry();
          if (reg && typeof reg.create === 'function') ws = await reg.create(scaffold.root, '全局');
          else workspaceError = 'workspaceRegistry 不可用';
        } catch (e) { workspaceError = '注册工作区失败：' + msgOf(e); }
        const made = await createGlobalSession(env, scaffold.root, '全局');
        invalidateStatus(env);
        env.log('一键部署：体系 ' + scaffold.root + '；工作区 ' + (ws ? String(ws.id) : '失败') + '；会话 ' + (made.sessionId || '失败'));
        return ok({
          root: scaffold.root,
          created: scaffold.created || [],
          written: scaffold.written || [],
          workspace: ws ? { id: String(ws.id || ''), title: String(ws.title || '全局'), path: String(ws.path || scaffold.root) } : null,
          workspaceError,
          sessionId: made.sessionId || '',
          sessionError: made.error || '',
        });
      }

      if (method === 'global-session') {
        // 已接入工作区但没有全局会话时，补建一个（不建体系、不动既有文件）。
        const root = currentRoot(env);
        if (!root) return bad('no-workspace', '未找到全局根（工作区未接入）');
        const made = await createGlobalSession(env, root, p.title || '全局');
        invalidateStatus(env);
        if (!made.sessionId) return bad('session-failed', made.error || '建会话失败');
        env.log('补建全局会话：' + made.sessionId);
        return ok({ root, sessionId: made.sessionId });
      }

      if (method === 'register') {
        const target = String(p.path || '').trim();
        if (!target) return bad('bad-request', '缺少 path（已存在的绝对目录）');
        let st = null;
        try { st = fs.statSync(target); } catch { st = null; }
        if (!st || !st.isDirectory()) return bad('bad-request', '目录不存在或不是目录：' + target);
        const reg = env.registry && env.registry();
        if (!reg || typeof reg.create !== 'function') {
          return { ok: false, error: { code: 'no-registry', message: 'workspaceRegistry 不可用', details: { hint: '请手工把这个路径粘进 DSH 的新建工作区：' + target } }, http: 501 };
        }
        const title = String(p.title || '').trim() || target.split(/[\\/]/).filter(Boolean).pop() || target;
        try {
          const w = await reg.create(target, title);
          invalidateStatus(env);
          return ok({
            id: String((w && w.id) || ''),
            title: String((w && w.title) || title),
            path: String((w && w.path) || target),
          });
        } catch (e) {
          return { ok: false, error: { code: 'register-failed', message: '建工作区失败：' + msgOf(e), details: {} }, http: 500 };
        }
      }

      if (method === 'extra-prompt') {
        if (typeof p.text !== 'string') return bad('bad-request', '缺少 text（空字符串＝不注入）');
        // 写入门禁：内容与开关都没变就不写。提示词一改，下一次请求的整段前缀缓存失效。
        let before = '';
        let beforeEnabled = false;
        try { before = String(env.extraPrompt() || ''); } catch { before = ''; }
        try { beforeEnabled = env.extraPromptEnabled() === true; } catch { beforeEnabled = false; }
        const nextEnabled = typeof p.enabled === 'boolean' ? p.enabled : (String(p.text).trim() !== '');
        if (before === p.text && beforeEnabled === nextEnabled) {
          return ok({ unchanged: true, chars: p.text.length, enabled: beforeEnabled, note: '内容与开关均未变化，已跳过写入（避免无谓的缓存失效）。' });
        }
        try {
          const r = env.setExtraPrompt(p.text, nextEnabled);
          invalidateStatus(env);
          env.log('全局前置提示词：' + (r.enabled ? '已开启' : '已关闭') + '，' + r.chars + ' 字符（下一次请求前缀缓存失效）');
          return ok(Object.assign({}, r, {
            changed: true,
            note: '已保存。提示词位于段序 950，改动会让下一次请求的整段前缀缓存失效，建议在压缩或换任的边界处修改。',
          }));
        } catch (e) { return boom(e); }
      }

      if (method === 'role') {
        if (typeof env.applyRole !== 'function') return { ok: false, error: { code: 'not-ready', message: '宿主侧没有装配 applyRole', details: {} }, http: 501 };
        const r = await env.applyRole({
          sessionId: p.session_id || p.sessionId,
          role: p.role,
          project: p.project,
          task: p.task,
          wake: p.wake !== false,
        });
        env.log('会话角色：' + (r.ok ? (r.role + ' · 存活=' + r.live + ' · 已投递=' + r.delivered) : ('失败 ' + r.error)));
        invalidateStatus(env);
        return r.ok ? ok(r) : bad('bad-request', String(r.error || '设定失败'));
      }

      if (method === 'move.probe') {
        const src = currentRoot(env);
        if (!src) return bad('no-workspace', '未找到全局根（工作区未接入）');
        return ok(await probeMove({ src, to: p.to }));
      }

      if (method === 'move.start') {
        const src = currentRoot(env);
        if (!src) return bad('no-workspace', '未找到全局根（工作区未接入）');
        env.log('搬迁：开始复制 ' + src + ' → ' + String(p.to || ''));
        const startedAt = Date.now();
        const r = await startMove({ src, to: p.to });
        env.log('搬迁：' + (r.ok ? '校验通过' : '校验有差异') + '，用时 ' + Math.round((Date.now() - startedAt) / 1000) + ' s');
        return r.ok ? ok(r) : { ok: false, error: { code: 'verify-failed', message: '复制完成但校验有差异，未生成切换脚本', details: r.report }, http: 500 };
      }

      if (method === 'move.switch') {
        const r = stageSwitch({ relaunch: p.relaunch === true });
        env.log('搬迁：后台切换助手 ' + (r.already ? '无需再派（已切换）' : '已派出 pid=' + r.pid));
        return ok(r);
      }

      if (method === 'move.status') {
        // 一律以搬迁标记里的源路径为准：修改登记生效后当前工作区根已经变成新位置，
        // 再拿它去比对会把「已经是新位置」误报成「还指着旧路径」。
        return ok(moveStatus());
      }

      if (method === 'consent.grant') {
        const sid = resolveShortSid(env, p.session_id);
        if (!sid) return bad('bad-request', '缺少 session_id');
        const kind = p.kind === 'succeed' ? 'succeed' : 'compact';
        const g = grantConsent(sid, kind === 'succeed' ? '设置页点击换任' : '设置页点击', kind);
        env.log((kind === 'succeed' ? '换任' : '压缩') + '授权：' + sid + '（5 分钟）');
        invalidateStatus(env);
        return ok(g);
      }

      if (method === 'consent.list') return ok({ rows: listConsent() });

      if (method === 'consent.revoke') {
        const sid = String(p.session_id || '').trim();
        if (sid) consumedConsent(sid, p.kind === 'succeed' ? 'succeed' : 'compact');
        invalidateStatus(env);
        return ok({ revoked: sid });
      }

      if (method === 'move.retarget') {
        // 不是「等退出再改」时的即时执行：只在 DSH 已退出后由助手调用；页面走 stageRetarget。
        const plan = applyRetarget();
        invalidateStatus(env);
        return ok(plan);
      }

      if (method === 'move.retarget-stage') {
        const r = stageRetarget();
        env.log('搬迁：登记修改登记助手 ' + (r.already ? '无需（已在新位置）' : '已派出 pid=' + r.pid));
        return ok(r);
      }

      if (method === 'move.repair') {
        const r = repairLink();
        env.log('搬迁：重建链接 ' + (r.already ? '已存在' : r.src + ' → ' + r.dst));
        invalidateStatus(env);
        return ok(r);
      }

      if (method === 'move.cleanup') {
        const r = await cleanupOld({ confirm: p.confirm === true });
        env.log('搬迁：清理旧副本 ' + (r.removed || []).length + ' 个');
        return ok(r);
      }

      return bad('unknown-method', '未知方法：' + method, 404);
    } catch (e) {
      return boom(e);
    }
  }

  return { call, methods: ['status', 'setup', 'deploy', 'global-session', 'register', 'extra-prompt', 'role', 'move.probe', 'move.start', 'move.switch', 'move.status', 'move.retarget', 'move.retarget-stage', 'move.repair', 'move.cleanup', 'consent.grant', 'consent.list', 'consent.revoke'] };
}
