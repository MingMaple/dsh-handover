/**
 * 设置页数据的**旧通道**：GET /dsh-handover/status.json、POST /setup /register /extra-prompt /role。
 *
 * 主通道是 DSH 认证的 /api 载体（见 rpc-carrier.mjs）：本机 GUI 服务器对裸请求一律返回 403。
 * 这里保留给没有 connection 服务的宿主与 CLI 作兜底，实现统一委托 api.mjs，避免两套逻辑漂移。
 */
import { createApi } from './api.mjs';

const ROUTE = '/dsh-handover';
const MAX_BODY = 64 * 1024;

/** 读 JSON 请求体；出错返回 { error }。 */
function readJson(req) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let size = 0;
    const chunks = [];
    try {
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) { finish({ error: '请求体过大' }); try { req.destroy(); } catch { /* ignore */ } return; }
        chunks.push(c);
      });
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8').trim();
        if (!text) { finish({ value: {} }); return; }
        try { finish({ value: JSON.parse(text) }); } catch { finish({ error: '请求体不是合法 JSON' }); }
      });
      req.on('error', () => finish({ error: '读取请求体失败' }));
    } catch {
      finish({ error: '读取请求体失败' });
    }
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function msgOf(e) { return String(e && e.message ? e.message : e); }

export function registerStatusRoute(ctx, env, info, apiIn) {
  const install = (wctx) => {
    try {
      const webServer = wctx && wctx.webServer;
      if (!webServer || typeof webServer.register !== 'function') {
        env.log('状态路由：webServer 不可用，跳过设置页 HTTP 兜底（主通道是 /api 载体）');
        return;
      }
      const api = apiIn || createApi(env, info);

      /** 旧通道出口：把统一信封翻成 { ok, ...value }（页面两种通道都能吃）。 */
      const reply = (res, r) => {
        if (!r || r.ok !== true) {
          const err = (r && r.error) || {};
          const out = { ok: false, error: String(err.message || '失败') };
          if (err.details && typeof err.details === 'object') Object.assign(out, err.details);
          sendJson(res, (r && r.http) || 400, out);
          return;
        }
        const v = r.value && typeof r.value === 'object' ? r.value : { value: r.value };
        sendJson(res, 200, Object.assign({ ok: true }, v));
      };

      const readBody = async (req, res) => {
        const body = await readJson(req);
        if (body.error) { sendJson(res, 400, { ok: false, error: body.error }); return null; }
        return body.value || {};
      };

      const dispose = webServer.register({
        kind: 'prefix',
        path: ROUTE,
        handler: async (req, res) => {
          try {
            const pathname = String((req && req.url) || '').split('?')[0];
            const method = String((req && req.method) || 'GET').toUpperCase();
            const tail = pathname.slice(ROUTE.length);
            env.log('HTTP ' + method + ' ' + pathname);

            if (tail === '/status.json') {
              if (method !== 'GET' && method !== 'HEAD') {
                res.writeHead(405, { allow: 'GET, HEAD' });
                res.end();
                return;
              }
              const r = await api.call('status', {});
              if (r.ok !== true) { sendJson(res, r.http || 500, { error: String((r.error && r.error.message) || '失败') }); return; }
              const body = JSON.stringify(r.value);
              res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
              res.end(method === 'HEAD' ? undefined : body);
              return;
            }

            if (tail === '/setup' || tail === '/register' || tail === '/extra-prompt' || tail === '/role') {
              if (method !== 'POST') { res.writeHead(405, { allow: 'POST' }); res.end(); return; }
              const input = await readBody(req, res);
              if (input === null) return;
              const name = tail.slice(1);
              const r = await api.call(name, input);
              if (name === 'setup') {
                env.log('首次安装向导：' + (r.ok ? '已建 ' + String((r.value && r.value.root) || '') : '失败 ' + String((r.error && r.error.message) || '')));
              }
              if (name === 'extra-prompt') {
                env.log('全局前置提示词：' + (r.ok ? (String((r.value && r.value.chars) || 0) + ' 字符') : '失败'));
              }
              reply(res, r);
              return;
            }

            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('404');
          } catch (e) {
            try { sendJson(res, 500, { error: msgOf(e) }); } catch { /* 已结束 */ }
          }
        },
      });
      if (typeof wctx.effect === 'function') wctx.effect(() => dispose, 'dsh-handover: 设置页路由');
    } catch (e) {
      env.log('状态路由注册失败：' + msgOf(e));
    }
  };
  try {
    if (typeof ctx.inject === 'function') ctx.inject(['webServer'], install);
  } catch (e) {
    env.log('状态路由装配失败：' + msgOf(e));
  }
}
