/**
 * DSH 认证的 /api 载体（客户端设置页取数/下指令的**主通道**）。
 *
 * 为什么不用裸 fetch：本机 GUI 服务器对非浏览器策略的请求直接 403「Browser access is disabled」，
 * 而 DSH 的 /api 载体自带浏览器鉴权与 Host/Origin 信任，dsh-im 的设置页正是走这条。
 * 契约（与 DSH 内置管理 RPC 一致）：
 *   入：POST /api/dsh-handover  body={type:'client-request', rpcId, method:'dsh-handover', payload:{method, payload}}
 *   出：{type:'server-response', rpcId, result:{ok:true,value} | {ok:false,error:{code,message,details}}}
 * 旧宿主没有 connection 服务时静默跳过，HTTP 路由继续兜底。
 */
const CARRIER_PATH = '/api/dsh-handover';
const CARRIER_METHOD = 'dsh-handover';

export function registerRpcCarrier(ctx, api, log) {
  const say = typeof log === 'function' ? log : () => {};
  let inner;
  try {
    inner = (cc) => {
      const conn = cc && cc.connection ? cc.connection : null;
      const reg = conn && conn.fetch && typeof conn.fetch.register === 'function' ? conn.fetch : null;
      if (!reg) { say('载体：connection.fetch.register 不可用，退回 HTTP 路由'); return; }
      let dispose = null;
      try {
        dispose = reg.register.call(reg, {
          path: CARRIER_PATH,
          methods: ['POST'],
          requestBody: 'buffered',
          async fetch(request) {
            if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
            let msg = null;
            try { msg = await request.json(); } catch { return new Response('body is not JSON', { status: 400 }); }
            const rpcId = msg && typeof msg.rpcId === 'string' ? msg.rpcId : 'invalid-request';
            const call = msg && msg.payload;
            const sane = msg && msg.type === 'client-request' && msg.method === CARRIER_METHOD
              && call && typeof call.method === 'string' && Object.prototype.hasOwnProperty.call(call, 'payload');
            if (!sane) {
              return Response.json({ type: 'server-response', rpcId, result: { ok: false, error: { code: 'bad-request', message: '信封不合法', details: {} } } });
            }
            let r;
            try { r = await api.call(call.method, call.payload); }
            catch (e) { r = { ok: false, error: { code: 'failed', message: String(e && e.message ? e.message : e), details: {} } }; }
            say('载体 ' + call.method + (r.ok ? ' ok' : (' 失败：' + String((r.error && r.error.message) || ''))));
            return Response.json({ type: 'server-response', rpcId, result: r });
          },
        });
        say('载体：已注册 ' + CARRIER_PATH);
      } catch (e) {
        say('载体注册失败：' + String(e && e.message ? e.message : e));
        return;
      }
      try {
        if (typeof cc.effect === 'function') cc.effect(() => dispose, 'dsh-handover: /api 载体');
      } catch { /* ignore */ }
    };
  } catch (e) {
    say('载体装配失败：' + String(e && e.message ? e.message : e));
    return;
  }
  try {
    if (typeof ctx.inject === 'function') ctx.inject(['connection'], inner);
    else say('载体：宿主不支持 ctx.inject，退回 HTTP 路由');
  } catch (e) {
    say('载体装配失败：' + String(e && e.message ? e.message : e));
  }
}
