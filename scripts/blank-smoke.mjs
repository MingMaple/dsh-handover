/**
 * 空白环境冒烟：不依赖任何真实工作区，验「装上就能跑」。
 * 1) 宿主半在假 ctx 上 apply：22 个工具、手册段、状态路由（200/404/405/HEAD）、只读工具不抛
 * 2) 浏览器半在假 window/React 上装载：bundle 外形、settings.section 注册、成体视图能渲染
 * 用法：node scripts/blank-smoke.mjs [--dist <dist 目录>]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { listFiles, scanFiles } from './lib/register.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const argIdx = process.argv.indexOf('--dist');
const dist = argIdx !== -1 ? path.resolve(process.argv[argIdx + 1]) : path.join(repo, 'dist');

const fails = [];
const ok = (cond, msg, extra) => { if (!cond) fails.push(msg + (extra ? ' → ' + extra : '')); };

// 空白 HOME：没有 workspace.json、没有 _Control_Center
const BLANK = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-handover-blank-'));
process.env.USERPROFILE = BLANK;
process.env.HOME = BLANK;

const { apply, schedDepsFor } = await import(pathToFileURL(path.join(dist, 'index.mjs')).href);
const reg = { tools: [], sections: [], logs: [], listeners: {} };
const ctx = {
  tools: { register: (t, o) => { reg.tools.push(t); (reg.toolOpts = reg.toolOpts || []).push(o); }, restrict() { }, guard: (fn) => { reg.guardFn = fn; } },
  systemPrompt: { section: (s) => { reg.sections.push(s); return () => { reg.disposed = (reg.disposed || 0) + 1; }; } },
  sessionController: {},
  logger: { warn: (m) => reg.logs.push(String(m)), error: (m) => reg.logs.push(String(m)), info() { } },
  effect: (fn) => fn(),
  on: (n, cb) => { (reg.listeners[n] = reg.listeners[n] || []).push(cb); },
  get: () => null,
  inject: (names, cb) => { (reg.injects = reg.injects || []).push({ names, cb }); reg.injectNames = names; reg.injectCb = cb; },
};
apply(ctx, {});

ok(reg.tools.length === 22, '工具数应为 22', String(reg.tools.length));
ok(reg.sections.length === 0, '未开启全局前置提示词时不得注册提示段', String(reg.sections.length));
ok(reg.tools.filter((t) => !t || !t.name || !t.description || !t.execute).length === 0, '每个工具都要有 name/description/execute');
// 上下文成本守门：工具描述是每次请求都要付的固定开销，单条不得超过预算（加权 token）。
const budget = await import(pathToFileURL(path.join(dist, 'lib', 'facts.mjs')).href);
const fatDesc = reg.tools.filter((t) => budget.estimateTokens(t.description) > budget.TOKEN_BUDGET.toolDescTokens).map((t) => t.name);
ok(fatDesc.length === 0, '单条工具描述应不超过 ' + budget.TOKEN_BUDGET.toolDescTokens + ' token（上下文成本）', fatDesc.join(','));
ok(reg.tools.filter((t) => t.name.startsWith('ho_')).length === 16, 'ho_* 应为 16 个', String(reg.tools.filter((t) => t.name.startsWith('ho_')).length));
ok(reg.tools.filter((t) => t.name.startsWith('peer_')).length === 6, 'peer_* 应为 6 个');
// 每步条件启用：内核 0.2.2 起工具按「步」解析，子会话在解析工具表这一步就要被排除，
// 否则它的首轮提示词会带着 22 个用不了的 schema（每步白付约 2.5k token）。
ok((reg.toolOpts || []).length === 22 && (reg.toolOpts || []).every((o) => o && typeof o.when === 'function'), '22 个工具都应带每步启用条件', String((reg.toolOpts || []).length));
{
  const gate = (reg.toolOpts || [])[0] && reg.toolOpts[0].when;
  ok(typeof gate === 'function', '每步启用条件应可调用');
  if (typeof gate === 'function') {
    ok(gate({ agent: { session: { header: { id: 'session-root', cwd: '/tmp/x' } } } }) === true, '根级会话的工具条件应放行（收窄交给角色裁剪）');
    ok(gate({ agent: { session: { header: { id: 'session-sub', origin: 'subagent' } } } }) === false, '子会话的工具条件应拒绝');
    ok(gate({ agent: { session: { header: { id: 'session-child', parentSession: 'session-root' } } } }) === false, '带父会话的会话也应拒绝');
    ok(gate({}) === true, '没有 agent 的调用应放行（命令行与演练路径）');
  }
}
// 可选注入多了 connection（/api 载体）。两个都必须是**可选**的，否则旧宿主整插件不激活。
const injectNames = (reg.injects || []).map((i) => i.names.join(','));
ok(injectNames.some((n) => n.indexOf('webServer') !== -1), '应把 webServer 作为可选注入', injectNames.join(' | '));
ok(injectNames.some((n) => n.indexOf('connection') !== -1), '应把 connection 作为可选注入', injectNames.join(' | '));
// 多了 commands（/allow-compact 聊天页命令），同样必须是可选的。
ok((reg.injects || []).every((i) => i.names.every((n) => ['webServer', 'connection', 'commands'].indexOf(n) !== -1)), '可选注入只允许 webServer／connection／commands', injectNames.join(' | '));
ok(injectNames.some((n) => n.indexOf('commands') !== -1), '应把 commands 作为可选注入（/allow-compact）', injectNames.join(' | '));

let route = null;
const wsInject = (reg.injects || []).find((i) => i.names.indexOf('webServer') !== -1);
ok(!!wsInject, '应有 webServer 的可选注入');
wsInject.cb({ webServer: { register: (r) => { route = r; return () => { }; } }, effect: (fn) => fn() });
ok(route && route.kind === 'prefix' && route.path === '/dsh-handover', '状态路由挂在 /dsh-handover');

// ---------- /api 载体（主通道：GUI 只信这个，裸 fetch 拿不到数据）
let carrier = null;
const connInject = (reg.injects || []).find((i) => i.names.indexOf('connection') !== -1);
ok(!!connInject, '应有 connection 的可选注入');
connInject.cb({
  connection: { fetch: { register: (spec) => { carrier = spec; return () => { }; } }, rpc: { call: async () => ({}) } },
  effect: (fn) => fn(),
});
ok(carrier && carrier.path === '/api/dsh-handover', '载体路径应为 /api/dsh-handover', carrier && carrier.path);
ok(carrier && Array.isArray(carrier.methods) && carrier.methods.indexOf('POST') !== -1, '载体应只收 POST');
ok(carrier && carrier.requestBody === 'buffered', '载体应声明 requestBody=buffered', carrier && carrier.requestBody);

async function rpcCall(method, payload) {
  const body = JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'dsh-handover', payload: { method, payload: payload || {} } });
  const req = new Request('http://127.0.0.1/api/dsh-handover', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  const res = await carrier.fetch(req);
  return res.json();
}
const rpcStatus = await rpcCall('status', {});
ok(rpcStatus && rpcStatus.type === 'server-response' && rpcStatus.rpcId === 'r1', '载体应回 server-response 信封', JSON.stringify(rpcStatus && rpcStatus.type));
ok(rpcStatus && rpcStatus.result && rpcStatus.result.ok === true, '载体 status 应成功', JSON.stringify(rpcStatus && rpcStatus.result && rpcStatus.result.error));
ok(rpcStatus && rpcStatus.result && rpcStatus.result.value && rpcStatus.result.value.plugin, '载体 status 应带 plugin 段');
const rpcMove = await rpcCall('move.status', {});
ok(rpcMove && rpcMove.result && rpcMove.result.ok === true && rpcMove.result.value && typeof rpcMove.result.value.phase === 'string', '载体 move.status 应成功', JSON.stringify(rpcMove && rpcMove.result && rpcMove.result.error));
const rpcBad = await rpcCall('nope.nope', {});
ok(rpcBad && rpcBad.result && rpcBad.result.ok === false && /未知方法/.test(String(rpcBad.result.error.message)), '载体未知方法应回 ok:false', JSON.stringify(rpcBad && rpcBad.result));
const rpcBadEnv = await carrier.fetch(new Request('http://127.0.0.1/api/dsh-handover', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"type":"x"}' }));
const badEnv = await rpcBadEnv.json();
ok(badEnv && badEnv.result && badEnv.result.ok === false && /信封不合法/.test(String(badEnv.result.error.message)), '载体应拒非法信封', JSON.stringify(badEnv && badEnv.result));
const rpcGet = await carrier.fetch(new Request('http://127.0.0.1/api/dsh-handover', { method: 'GET' }));
ok(rpcGet.status === 405, '载体 GET 应 405', String(rpcGet.status));

async function call(method, url) {
  const res = { code: 0, headers: null, body: undefined, writeHead(c, h) { this.code = c; this.headers = h; }, end(b) { this.body = b; } };
  await route.handler({ method, url }, res);
  return res;
}
const r1 = await call('GET', '/dsh-handover/status.json');
ok(r1.code === 200, 'GET status.json 应 200', String(r1.code));
let payload = null;
try { payload = JSON.parse(r1.body); } catch (e) { fails.push('返回不是 JSON：' + e.message); }
if (payload) {
  ok(payload.plugin.version && payload.plugin.version !== '?', '应报出版本号', String(payload.plugin.version));
  ok(payload.plugin.tools === 22, 'payload 工具数应为 22', String(payload.plugin.tools));
  ok(payload.workspace && payload.workspace.found === false, '空白 HOME 下应判定为没找到工作区', JSON.stringify(payload.workspace));
  ok(Array.isArray(payload.notes) && payload.notes.length > 0, '没找到工作区时应给中文提示');
  ok(payload.guide && Array.isArray(payload.guide.situations) && payload.guide.situations.length >= 8, 'payload 应带「怎么用」的时机表');
  ok(payload.guide && payload.guide.groups.reduce((a, g) => a + g.tools.length, 0) === 22, '使用说明里应列全 22 个工具', payload.guide && String(payload.guide.groups.reduce((a, g) => a + g.tools.length, 0)));
  ok(payload.plugin.initErrors && payload.plugin.initErrors.length === 0, '初始化错误应为空', JSON.stringify(payload.plugin.initErrors));
}
ok((await call('GET', '/dsh-handover/nope.json')).code === 404, '未知路径应 404');
ok((await call('POST', '/dsh-handover/status.json')).code === 405, 'POST 应 405');
const head = await call('HEAD', '/dsh-handover/status.json');
ok(head.code === 200 && head.body === undefined, 'HEAD 应 200 且无 body');

// ---------- 首次安装向导 ----------
const { syncCheck } = await import(pathToFileURL(path.join(dist, 'lib', 'gates.mjs')).href);
const { lintGlobal } = await import(pathToFileURL(path.join(dist, 'lib', 'lint.mjs')).href);

/** 模拟带 JSON body 的 POST。 */
async function postJson(url, payload, method = 'POST') {
  const listeners = {};
  const req = {
    method,
    url,
    on: (ev, cb) => { (listeners[ev] = listeners[ev] || []).push(cb); },
    destroy: () => { },
  };
  const res = { code: 0, body: undefined, writeHead(c) { this.code = c; }, end(b) { this.body = b; } };
  const pending = route.handler(req, res);
  setTimeout(() => {
    const buf = Buffer.from(JSON.stringify(payload || {}), 'utf8');
    (listeners.data || []).forEach((f) => f(buf));
    (listeners.end || []).forEach((f) => f());
  }, 0);
  await pending;
  let json = null;
  try { json = JSON.parse(res.body); } catch (e) { json = null; }
  return { code: res.code, json };
}

const PARENT = path.join(BLANK, 'mother');
fs.mkdirSync(PARENT, { recursive: true });
const s1 = await postJson('/dsh-handover/setup', { parent: PARENT });
ok(s1.code === 200 && s1.json && s1.json.ok, '建全局根：应成功', JSON.stringify(s1.json));
const root = s1.json && s1.json.root;
ok(!!root && fs.existsSync(root), '建全局根：目录应存在', String(root));
ok(fs.existsSync(path.join(root, '_Control_Center', 'records', 'Global_Handover.md')), '建全局根：交接骨架应在');
ok(fs.existsSync(path.join(root, '_Control_Center', 'rules', 'Workspace_Charter.md')), '建全局根：Charter 骨架应在');
ok(fs.existsSync(path.join(root, '_Control_Center', 'templates', 'Prompt_Templates.md')), '建全局根：提示词模板应在');
ok(fs.existsSync(path.join(root, 'Projects')) && fs.existsSync(path.join(root, '_Project_Meta')), '建全局根：项目目录应在');

// cwd 已失效（旧路径被删）时，根解析必须退回登记表，不能在幽灵路径上重建 _Control_Center
if (root) {
  const regDir0 = path.join(BLANK, '.dsh', 'storages');
  fs.mkdirSync(regDir0, { recursive: true });
  fs.writeFileSync(path.join(regDir0, 'workspace.json'), JSON.stringify({ tables: { workspaces: { w9: { id: 'w9', title: '全局', path: root } } } }, null, 2));
  const wsMod = await import(pathToFileURL(path.join(dist, 'lib', 'workspace.mjs')).href);
  const picked = wsMod.routeWorkspace({ cfg: {} });
  ok(picked === root, 'cwd 失效时根解析应退回登记表里的工作区', String(picked));
}

if (root) {
  const g = syncCheck(root);
  ok(g.ok === true && g.bodyLines === 24, '骨架上的闸门应通过且正文为 24 行', JSON.stringify({ ok: g.ok, bodyLines: g.bodyLines, total: g.total }));
  const lh = lintGlobal(path.join(root, '_Control_Center', 'records', 'Global_Handover.md'));
  ok(lh.verdict === '通过', '骨架交接应通过全局体检', JSON.stringify(lh).slice(0, 160));
}

const s2 = await postJson('/dsh-handover/setup', { parent: PARENT });
ok(s2.code === 400 && s2.json && s2.json.ok === false, '目标已存在时应拒绝且不改动', JSON.stringify(s2.json && s2.json.error));
// 目标父目录不存在就自建（用户自选路径是合法需求）
const AUTO_PARENT = path.join(BLANK, 'auto-parent', 'nested');
const s3 = await postJson('/dsh-handover/setup', { parent: AUTO_PARENT });
ok(s3.code === 200 && s3.json && s3.json.ok === true, '父目录不存在时应自建并成功', JSON.stringify(s3.json && s3.json.error));
ok(fs.existsSync(path.join(AUTO_PARENT, '_Workspace', '_Control_Center', 'records')), '应在 <父目录>/_Workspace 下铺好文件体系');
const notADir = path.join(BLANK, 'a-file.txt');
fs.writeFileSync(notADir, 'x');
const sFile = await postJson('/dsh-handover/setup', { parent: notADir });
ok(sFile.code === 400 && sFile.json && !sFile.json.ok, '父路径是文件时应报错', JSON.stringify(sFile.json && sFile.json.error));
// ---------- 全局前置提示词 ----------
const EXTRA_NAME = 'dsh-handover:extra-prompt';
const e1 = await postJson('/dsh-handover/extra-prompt', { text: '  测试用全局前置提示词  ', enabled: true });
ok(e1.code === 200 && e1.json && e1.json.ok && e1.json.chars > 0 && e1.json.enabled === true, '全局前置提示词：开启并保存应成功', JSON.stringify(e1.json));
const section = reg.sections.filter((x) => x.name === EXTRA_NAME).pop();
ok(!!section, '全局前置提示词：应注册为系统提示段');
ok(section && section.order === 950, '全局前置提示词：段序应 950（工具段 1000 之前）', section && String(section.order));
ok(section && section.interpolate === false, '全局前置提示词：应原样保留（interpolate:false）');
ok(section && section.text === '测试用全局前置提示词', '全局前置提示词：应去掉首尾空白', section && JSON.stringify(section.text));
const st2 = await call('GET', '/dsh-handover/status.json');
let payload2 = null;
try { payload2 = JSON.parse(st2.body); } catch (e) { /* ignore */ }
ok(payload2 && payload2.extraPrompt === '测试用全局前置提示词' && payload2.extraPromptEnabled === true, '全局前置提示词：状态页应读回内容与开关', payload2 && JSON.stringify({ t: payload2.extraPrompt, e: payload2.extraPromptEnabled }));
const e2 = await postJson('/dsh-handover/extra-prompt', { text: '测试用全局前置提示词', enabled: false });
ok(e2.code === 200 && e2.json && e2.json.ok && e2.json.enabled === false && e2.json.registered === false, '全局前置提示词：关闭后应释放提示段', JSON.stringify(e2.json));
ok(reg.disposed >= 1, '全局前置提示词：关闭时应释放上一段', String(reg.disposed));
const st3 = await call('GET', '/dsh-handover/status.json');
let payload3 = null;
try { payload3 = JSON.parse(st3.body); } catch (e) { /* ignore */ }
ok(payload3 && payload3.extraPromptEnabled === false, '全局前置提示词：关闭后状态页应显示未开启');
const e3 = await postJson('/dsh-handover/extra-prompt', { text: '   ', enabled: true });
ok(e3.code === 200 && e3.json && e3.json.ok && e3.json.chars === 0 && e3.json.enabled === false, '全局前置提示词：空内容不得开启', JSON.stringify(e3.json));

const s4 = await postJson('/dsh-handover/register', { path: root || PARENT });
ok(s4.code === 501 && s4.json && s4.json.ok === false && String(s4.json.hint || '').indexOf(root || PARENT) !== -1, '无 workspaceRegistry 时应回退给「手工粘贴路径」的提示', JSON.stringify(s4.json));

const initTool = reg.tools.find((t) => t.name === 'ho_init');
ok(!!initTool, '应注册 ho_init（首次安装工具）');
if (initTool) {
  const PARENT2 = path.join(BLANK, 'mother2');
  fs.mkdirSync(PARENT2, { recursive: true });
  const ri = await initTool.execute({ parent: PARENT2 }, null);
  ok(/已建立全局文件体系/.test(ri.text), 'ho_init 应建树并报出路径', ri.text.split('\n')[0]);
  const ri2 = await initTool.execute({ parent: PARENT2 }, null);
  ok(/未建立/.test(ri2.text), 'ho_init 对非空目标应拒绝且不改动', ri2.text.split('\n')[0]);
}

const readonly = ['ho_diag', 'ho_phase', 'ho_brief', 'ho_sessions', 'ho_gate', 'ho_charter', 'ho_drift', 'ho_workspace'];
for (const t of reg.tools) {
  if (readonly.indexOf(t.name) === -1) continue;
  try {
    const args = t.name === 'ho_gate' ? { scope: 'all' } : t.name === 'ho_workspace' ? { action: 'list' } : t.name === 'ho_charter' ? { doc: 'runtime' } : {};
    const out = await t.execute(args, null);
    ok(out && typeof out.text === 'string' && out.text.length > 0, t.name + ' 在空白环境应返回文本');
  } catch (e) {
    fails.push(t.name + ' 在空白环境抛错：' + (e && e.message ? e.message : e));
  }
}

// ---------- 角色：判定、路径、工具集、续跑文案、按角色装配 ----------
const DIST = (rel) => pathToFileURL(path.join(dist, rel)).href;
const { resolveRole, handoverPathFor, toolsetFor, writeRole, readRoles } = await import(DIST('lib/role.mjs'));
const { fillResumePrompt } = await import(DIST('lib/schedule.mjs'));
const { resolveConfig } = await import(DIST('lib/config.mjs'));

// 建一个像样的工作区，好让 cwd 推导走到 _Control_Center
const WS = path.join(BLANK, 'ws');
fs.mkdirSync(path.join(WS, '_Control_Center'), { recursive: true });
fs.mkdirSync(path.join(WS, 'Projects', 'Demo', 'Demo库'), { recursive: true });
fs.mkdirSync(path.join(WS, '_Misc', 'tasks', '抢名额'), { recursive: true });

const rTitle = resolveRole({ sessionId: 'session-t1', title: '全局9' });
ok(rTitle.role === 'global' && rTitle.source === 'title', '角色判定：标题含「全局」→ global', JSON.stringify(rTitle));
const rCwd = resolveRole({ sessionId: 'session-t2', title: 'Demo1', cwd: path.join(WS, 'Projects', 'Demo', 'Demo库') });
ok(rCwd.role === 'project' && rCwd.project === 'Demo', '角色判定：cwd 在 Projects/<名>/ → project', JSON.stringify(rCwd));
const rMisc = resolveRole({ sessionId: 'session-t3', title: '杂项1', cwd: path.join(WS, '_Misc', 'tasks', '抢名额') });
ok(rMisc.role === 'misc' && rMisc.task === '抢名额', '角色判定：cwd 在 _Misc/tasks/<任务>/ → misc', JSON.stringify(rMisc));
const rPrompt = resolveRole({ sessionId: 'session-t4', title: '', firstPrompt: '先看 ' + path.join(WS, 'Projects', 'Study', 'Study库') + ' 里的内容' });
ok(rPrompt.role === 'project' && rPrompt.project === 'Study', '角色判定：首条提示里的 Projects/<名> → project', JSON.stringify(rPrompt));
const rPlain = resolveRole({ sessionId: 'session-t5', title: '随便', cwd: '/tmp' });
ok(rPlain.role === 'plain', '角色判定：都不中 → plain（普通会话）', JSON.stringify(rPlain));

writeRole({}, 'session-t6', { role: 'misc', task: 'X', source: 'user' });
const rStore = resolveRole({ sessionId: 'session-t6', title: '全局10' });
ok(rStore.role === 'misc' && rStore.source === 'store', '角色表优先于标题推断', JSON.stringify(rStore));
ok(readRoles({}).sessions['session-t6'] && readRoles({}).sessions['session-t6'].task === 'X', '角色表应可读回');

// 回归锁：首条提示里的 `Projects/**` 通配曾被当成项目名 `**、_Project_Meta`，
// 于是交接路径、备份目录、归档目录全落在这个 Windows 非法名字上（实测四类报错）。
const rGlob = resolveRole({ sessionId: 'session-glob-prompt', title: 'Android AI Agent 3', cwd: 'C:/Users/x/.dsh/profiles/desktop', firstPrompt: '- 动 _Control_Center/**、Projects/**、_Project_Meta/** 前先问用户。' });
ok(rGlob.role === 'plain', '首条提示里的 Projects/** 通配不得被当成项目名', JSON.stringify(rGlob));
const hpBad = handoverPathFor(WS, { role: 'project', project: '**、_Project_Meta' });
ok(hpBad.path === null && /不合法/.test(String(hpBad.reason || '')), '非法项目名不得拼出交接路径', JSON.stringify(hpBad));
{
  let badWrite = '';
  try { writeRole({}, 'session-bad-name', { role: 'project', project: '**、_Project_Meta' }); } catch (e) { badWrite = e.message; }
  ok(/不合法/.test(badWrite), '角色表不得写入含非法字符的项目名', badWrite);
  ok(readRoles({}).sessions['session-bad-name'] === undefined, '非法项目名不得落盘', JSON.stringify(readRoles({}).sessions['session-bad-name']));
}

const hpG = handoverPathFor(WS, { role: 'global' });
ok(/Global_Handover\.md$/.test(hpG.path), '全局交接路径', hpG.path);
const hpP = handoverPathFor(WS, { role: 'project', project: 'Demo' });
ok(/_Project_Meta/.test(hpP.path) && /Demo/.test(hpP.path) && /Handover\.md$/.test(hpP.path), '项目交接路径应落 _Project_Meta/<项目>/Handover.md', hpP.path);
const hpM = handoverPathFor(WS, { role: 'misc', task: '抢名额' });
ok(/_Misc/.test(hpM.path) && /抢名额/.test(hpM.path) && /Handover\.md$/.test(hpM.path), '杂项交接路径应落 _Misc/tasks/<任务>/Handover.md', hpM.path);
const hpU = handoverPathFor(WS, { role: 'plain' });
ok(hpU.path === null && !!hpU.reason, '普通会话不得给出交接路径（不退回全局）', JSON.stringify(hpU));

const tsG = toolsetFor('global');
ok(tsG.allow.length === 22 && tsG.deny.length === 0, '全局应可见全部 22 个工具', JSON.stringify([tsG.allow.length, tsG.deny.length]));
const tsP = toolsetFor('project');
ok(tsP.allow.length === 9, '项目角色应可见 9 个工具', String(tsP.allow.length));
ok(tsP.allow.indexOf('ho_handover') !== -1 && tsP.allow.indexOf('ho_checkpoint') !== -1, '项目角色必须能写自己的交接与压缩');
ok(tsP.allow.indexOf('ho_pack') === -1 && tsP.allow.indexOf('ho_sessions') === -1, '项目角色不该看见全局管理工具');
ok(tsP.deny.indexOf('ho_handover') === -1 && tsP.deny.indexOf('run_code') === -1, 'deny 名单不得含保留名或本角色已允许的工具');
const tsM = toolsetFor('misc');
ok(tsM.allow.length === 9 && tsM.allow.indexOf('peer_new') !== -1 && tsM.allow.indexOf('ho_gate') === -1, '杂项角色：9 个，含 peer_new、不含 ho_gate', String(tsM.allow.length));
const tsU = toolsetFor('plain');
ok(tsU.allow.length === 0 && tsU.deny.length === 22, '普通会话不载入任何插件工具', JSON.stringify([tsU.allow.length, tsU.deny.length]));
const rSub = resolveRole({ sessionId: 'session-sub', title: 'Demo1', cwd: path.join(WS, 'Projects', 'Demo', 'Demo库'), subagent: true });
ok(rSub.role === 'plain' && rSub.source === 'subagent', '子会话默认按普通处理，不按 cwd 判项目', JSON.stringify(rSub));

// ---------- 骨架档案：预设、默认骨架、注册、校验 ----------
const prof = await import(DIST('lib/profile.mjs'));
const pjs = prof.presets();
ok(Object.keys(pjs).length === 4 && pjs.application && pjs.animation && pjs.library && pjs.general, '应提供 application、animation、library、general 四套预设');
const dflt = prof.readProfile(WS, { role: 'project', project: 'Demo' });
ok(dflt.exists === false && dflt.profile.root === 'Projects/Demo', '未注册项目应回默认骨架', JSON.stringify(dflt.profile));
const metaDir = path.join(WS, '_Project_Meta', 'Demo');
fs.mkdirSync(metaDir, { recursive: true });
fs.writeFileSync(path.join(metaDir, 'Project_Overview.md'), 'x');
fs.writeFileSync(path.join(metaDir, 'Handover.md'), '# x');
fs.writeFileSync(path.join(WS, 'Projects', 'Demo', 'README.md'), 'x');
const pf = { schema: 1, kind: 'application', root: 'Projects/Demo', required: ['README.md'], optional: ['SKILL.md'], docs: [], meta: ['Project_Overview.md', 'Handover.md'], gate: { libraryBlock: false }, handover: { extraSections: [] } };
fs.writeFileSync(prof.profilePathFor(WS, { role: 'project', project: 'Demo' }), JSON.stringify(pf, null, 2));
const rd = prof.readProfile(WS, { role: 'project', project: 'Demo' });
ok(rd.exists && rd.profile.kind === 'application', '应读回已写骨架', JSON.stringify(rd.profile));
const pv = prof.validateProfile(WS, { role: 'project', project: 'Demo' }, rd.profile);
ok(pv.ok, '骨架校验应通过', JSON.stringify(pv));
const badPf = prof.normalizeProfile({ ...pf, required: ['../x'] }, { role: 'project', project: 'Demo' });
ok(badPf.errors.length > 0, '骨架不应接受 .. 路径', JSON.stringify(badPf.errors));
const profTool = reg.tools.find((t) => t.name === 'ho_profile');
ok(!!profTool, '应注册 ho_profile');
if (profTool) {
  const profExec = { agent: { session: { header: { id: 'session-prof', cwd: path.join(WS, 'Projects', 'Demo', 'Demo库'), title: 'Demo1' } } } };
  const pres = await profTool.execute({ action: 'presets' }, profExec);
  ok(/application/.test(pres.text) && /animation/.test(pres.text), 'ho_profile 应返回预设');
  const rr = await profTool.execute({ action: 'read' }, profExec);
  ok(/已注册/.test(rr.text) && /application/.test(rr.text), 'ho_profile read 应读到已注册骨架');
  const vv = await profTool.execute({ action: 'validate' }, profExec);
  ok(/结论：通过/.test(vv.text), 'ho_profile validate 应通过', vv.text.slice(0, 120));
  // 项目会话只处理自己的骨架：传别的项目名要报错，不能静默忽略入参（实测踩过）。
  let crossErr = '';
  try { await profTool.execute({ action: 'validate', project: '学习' }, profExec); } catch (e) { crossErr = e.message; }
  ok(/只能读写自己的骨架/.test(crossErr), '项目会话传别的项目名应明确报错', crossErr);
}

// 回归锁：压缩调度器拿的是**会话 id 字符串**。早期版本这里错配了 exec 版函数，
// 结果续跑消息永远走 resumePromptUnknown（连全局会话都被写成「本会话还没设定角色」）。
{
  const seen = [];
  const deps = schedDepsFor({
    infoOfSid: (sid) => { seen.push(sid); return { role: 'global', project: '', task: '', sessionId: sid }; },
    handoverForSid: (sid) => ({ path: 'W/_Control_Center/records/Global_Handover.md', sessionId: sid }),
  });
  const info = deps.roleOf('session-abc');
  const hp = deps.handoverFor('session-abc');
  ok(info && info.role === 'global', '调度器按会话 id 解析角色（不是 exec）', JSON.stringify(info));
  ok(seen.indexOf('session-abc') !== -1, '传给 roleOf 的就是会话 id 原文', JSON.stringify(seen));
  ok(hp && /Global_Handover\.md$/.test(hp.path), '调度器能拿到本会话的交接绝对路径', JSON.stringify(hp));
}
const tcfg = resolveConfig({});
const tp = fillResumePrompt(tcfg, { n: 2, handover: hpP.path, role: 'project' });
ok(tp.indexOf(hpP.path) !== -1, '续跑文案应带本会话的交接绝对路径', tp.slice(0, 90));
ok(tp.indexOf('Global_Handover.md') === -1, '项目会话的续跑文案不得出现全局交接路径');
const tu = fillResumePrompt(tcfg, { n: 1, handover: '', role: 'plain' });
ok(/普通会话，不参与交接/.test(tu), '普通会话的续跑文案应说明不参与交接', tu.slice(0, 90));
const tg = fillResumePrompt(tcfg, { n: 3, handover: hpG.path, role: 'global' });
ok(tg.indexOf('第 3/3 次压缩') !== -1, '续跑文案应填上次数', tg.slice(0, 40));
ok(tcfg.directPeer === 'on', '会话之间直接对话应默认允许', String(tcfg.directPeer));
ok(tg.indexOf('收尾并停止') !== -1, '续跑文案应允许交接无待办时收尾停止', tg.slice(0, 120));

const listeners = (reg.listeners && reg.listeners['agent/created']) || [];
ok(listeners.length === 1, '应监听 agent/created 且只一处', String(listeners.length));
const calls = { restrict: [], sections: [], injected: [], lifted: 0 };
const projAgent = {
  id: 'session-proj',
  session: { header: { id: 'session-proj', title: 'Demo1', cwd: path.join(WS, 'Projects', 'Demo', 'Demo库') } },
  ctx: {
    tools: { restrict: (f) => { calls.restrict.push(f); return () => { calls.lifted++; }; } },
    systemPrompt: { section: (o) => { calls.sections.push(o); return () => { }; } },
  },
  inject: (m) => calls.injected.push(m),
};
for (const cb of listeners) cb({ agent: projAgent, source: 'fresh' });
ok(calls.restrict.length === 1, '项目角色应调用 restrict 一次', String(calls.restrict.length));
ok(calls.restrict[0] && Array.isArray(calls.restrict[0].deny) && calls.restrict[0].deny.length === 13, 'restrict 的 deny 名单应为 13 个', JSON.stringify(calls.restrict[0] && calls.restrict[0].deny && calls.restrict[0].deny.length));
ok(Array.isArray(calls.restrict[0] && calls.restrict[0].deny) && calls.restrict[0].deny.indexOf('ho_pack') !== -1 && calls.restrict[0].deny.indexOf('ho_handover') === -1, 'deny 名单应与角色矩阵一致');
ok(calls.sections.length === 1 && calls.sections[0].name === 'dsh-handover:manual', '应注册同名提示段遮蔽兜底段');
const secNorm = String(calls.sections[0].text).replace(/\\/g, '/');
ok(secNorm.indexOf('Projects/Demo') !== -1 && secNorm.indexOf('_Project_Meta/Demo/Handover.md') !== -1, '项目提示段应含自己的路径', secNorm.slice(0, 200));
ok(secNorm.indexOf('任务完成不报全局') !== -1, '项目提示段应写明任务完成不向全局报告', secNorm.slice(0, 400));
ok(secNorm.indexOf('任务达成') === -1, '项目提示段不得再出现任务达成');
ok(secNorm.indexOf('可直接 peer_send') !== -1, '项目提示段应允许会话之间直接对话', secNorm.slice(0, 400));
ok(secNorm.indexOf('resume=wait') !== -1, '项目提示段应说明收尾压缩不唤醒');
ok(budget.estimateTokens(calls.sections[0].text) <= budget.TOKEN_BUDGET.projectTokens, '项目提示段应控制在 ' + budget.TOKEN_BUDGET.projectTokens + ' token 内（成本守门）', String(budget.estimateTokens(calls.sections[0].text)));
ok(calls.sections[0].text.indexOf('子智能体') === -1, '项目段不得携带子智能体派发纪律（不属于本插件）');
// 真实工作区路径 + 迁移提示是最坏情形，预算另设一档
{
  const man = await import(pathToFileURL(path.join(dist, 'lib', 'manual.mjs')).href);
  const longWs = path.join(os.tmpdir(), 'Project_Mate', '_Workspace');
  const otherWs = path.join(os.tmpdir(), 'Project_Mate', '_Workspace_2');
  const worst = man.scopedManual({ role: 'project', project: 'Demo', task: '' }, { ws: longWs, move: { phase: 'switched', dst: otherWs, src: longWs } });
  ok(budget.estimateTokens(worst) <= budget.TOKEN_BUDGET.projectWorstTokens, '项目段在真实长路径与迁移提示下仍应在预算内', String(budget.estimateTokens(worst)));
}
ok(secNorm.indexOf('_Temp/Demo/') !== -1 && secNorm.indexOf('_Archives/Demo/') !== -1, '项目提示段应含临时与归档路径', secNorm.slice(0, 300));
// 回归锁：早期版本用 agent.inject({source:{kind:'plugin'}}) 投一次性引导，v4 格式准入拒绝该 source，
// 抛在写盘编码阶段 → 坏事件留在缓冲 → 该会话之后每次开轮都 agent.failed。这条断言防止再写回历史。
ok(calls.injected.length === 0, '不得向会话历史写插件消息（历史一律由提示段承载）', JSON.stringify(calls.injected.map((m) => m && m.source)));
for (const cb of listeners) cb({ agent: projAgent, source: 'resume' });
ok(calls.injected.length === 0, '重复装配也不得写历史', String(calls.injected.length));
ok(calls.lifted >= 1, '重复装配前应先撤销旧限制', String(calls.lifted));

const gCalls = { restrict: 0, sections: [], injected: 0 };
const globAgent = {
  id: 'session-glob',
  session: { header: { id: 'session-glob', title: '全局9', cwd: WS } },
  ctx: {
    tools: { restrict: () => { gCalls.restrict++; return () => { }; } },
    systemPrompt: { section: (o) => { gCalls.sections.push(o); return () => { }; } },
  },
  inject: () => { gCalls.injected++; },
};
for (const cb of listeners) cb({ agent: globAgent, source: 'fresh' });
ok(gCalls.restrict === 0, '全局角色不应被裁剪', String(gCalls.restrict));
ok(gCalls.sections.length === 1 && gCalls.sections[0].name === 'dsh-handover:manual', '全局也应遮蔽兜底段');
// 常驻段只放每轮判定，一次性流程下沉手册；上限按加权 token 计。
ok(budget.estimateTokens(gCalls.sections[0].text) <= budget.TOKEN_BUDGET.globalTokens, '全局提示段应控制在 ' + budget.TOKEN_BUDGET.globalTokens + ' token 内（硬上限）', String(budget.estimateTokens(gCalls.sections[0].text)));
ok(gCalls.sections[0].text.indexOf('反模式') === -1, '全局段不得携带反模式纪律（不属于本插件）');
ok(gCalls.sections[0].text.indexOf('send_message 续用') === -1, '全局段不得携带子智能体续用纪律（不属于本插件）');
// 真机最坏情形：长路径 + 迁移提示行
{
  const man2 = await import(pathToFileURL(path.join(dist, 'lib', 'manual.mjs')).href);
  const longWs2 = path.join(os.tmpdir(), 'Project_Mate', '_Workspace');
  const otherWs2 = path.join(os.tmpdir(), 'Project_Mate', '_Workspace_2');
  const gWorst = man2.globalManual({ ws: longWs2, move: { phase: 'switched', dst: otherWs2, src: longWs2 } });
  ok(budget.estimateTokens(gWorst) <= budget.TOKEN_BUDGET.globalWorstTokens, '全局段在长路径与迁移提示下仍应在预算内', String(budget.estimateTokens(gWorst)));
}
ok(gCalls.sections[0].text.indexOf('前置提示词') === -1, '插件角色段不得再携带前置提示词（由用户全局前置提示词注入）');
// 结构只保留会话定位、权限、节奏、交接与按需取用五节
{
  const g = gCalls.sections[0].text;
  const cnt = (k) => g.split(k).length - 1;
  const secs = ['一、身份', '二、权限', '三、节奏', '四、交接', '五、按需取用'];
  const bad = secs.filter((k) => cnt(k) !== 1);
  ok(bad.length === 0, '全局段五节骨架应各出现一次', bad.join(','));
  const absent = ['子智能体', '反模式', '自检'];
  const still = absent.filter((k) => g.indexOf(k) !== -1);
  ok(still.length === 0, '插件角色段不得携带非会话约束', still.join(','));
  ok(cnt('换任') <= 2, '「换任」在全局段出现不应超过两处', String(cnt('换任')));
}
ok(gCalls.injected === 0, '全局不再重复注入工作流（提示段里已有）', String(gCalls.injected));
// 分层护栏——常驻段只留判定，工作流细节必须留在手册里
{
  const g0 = String(gCalls.sections[0].text);
  ok(g0.indexOf('ho_pack') === -1 && g0.indexOf('move-probe') === -1, '常驻段不得回灌工作流细节（应放手册）');
  ok(g0.indexOf('ho_charter(doc="runtime", section=…') !== -1, '常驻段应给出按节取用的指针');
  const rm = fs.readFileSync(path.join(dist, 'templates', 'Runtime_Manual.md'), 'utf8');
  ok(rm.indexOf('## 11. 首次安装') !== -1 && rm.indexOf('## 12. 提示词预算') !== -1, '手册应含首次安装与提示词预算两节');
  ok(rm.indexOf('续用优先') !== -1, '手册 §5 应含子智能体续用纪律');
  // 项目名先按 cwd 认——换任时插件自己写的启动提示词解析不出项目名，旧逻辑会把新会话整行过滤掉
  const sess = await import(pathToFileURL(path.join(dist, 'lib', 'sessions.mjs')).href);
  const fake = { record: { identity: { cwd: path.join(WS, 'Projects', 'Demo', 'Demo库') }, rows: {} } };
  ok(sess.projectOf(fake).real === true && sess.projectOf(fake).project === 'Demo', '应按 cwd 识别项目会话', JSON.stringify(sess.projectOf(fake)));
  // 换任启动提示词不得再写「然后接着干」——没任务时它会抠字眼给自己找活
  const opsSrc = fs.readFileSync(path.join(dist, 'lib', 'session-ops.mjs'), 'utf8');
  ok(opsSrc.indexOf('接着干') === -1, '启动提示词与交接提示不得再出现「接着干」');
  ok(opsSrc.indexOf('任务达成') === -1 && opsSrc.indexOf('三种时机') !== -1, '启动提示词应改为三种时机且不再含任务达成');
  const ckSrc = fs.readFileSync(path.join(dist, 'tools', 'ho_checkpoint.mjs'), 'utf8');
  ok(ckSrc.indexOf('resume') !== -1, 'ho_checkpoint 应支持 resume 选择压缩后去向');
  const idxSrc = fs.readFileSync(path.join(dist, 'index.mjs'), 'utf8');
  ok(idxSrc.indexOf('directPeer') !== -1, '会话守卫应支持直接对话开关');
  // 语体扫描——界面与文档一律标准书面语（口语词、感叹号、图形结论、全角斜杠、时间缺时区）。
  {
    const uiFiles = listFiles(path.join(repo, 'src'), ['.mjs', '.js'], { skip: ['templates'] });
    const docFiles = [path.join(repo, 'README.md')]
      .concat(listFiles(path.join(repo, 'src', 'templates'), ['.md']))
      .filter((f) => f.indexOf('Writing_Rules.md') === -1);
    const uiHits = scanFiles(uiFiles, { ui: true });
    const docHits = scanFiles(docFiles, { ui: false });
    const fmt = (hs) => hs.slice(0, 6).map((h) => path.relative(repo, h.file) + ':' + h.line + ' ' + h.rules.join('、')).join(' | ');
    ok(uiHits.length === 0, '界面文案应一律使用标准书面语（词表与符号扫描）', fmt(uiHits));
    ok(docHits.length === 0, '文档文案应一律使用标准书面语（词表与符号扫描）', fmt(docHits));
  }
  ok(opsSrc.indexOf('不得自行开展作业') !== -1 && opsSrc.indexOf('待用户指派') !== -1, '启动提示词应先报告再待指派');
}

const unrCalls = { restrict: 0 };
const unrAgent = {
  id: 'session-unr',
  session: { header: { id: 'session-unr', title: '随便', cwd: '/tmp/x' } },
  ctx: {
    tools: { restrict: (f) => { unrCalls.restrict++; unrCalls.lastDeny = (f && f.deny) || null; return () => { }; } },
    systemPrompt: { section: () => () => { } },
  },
  inject: () => { throw new Error('未设角色的会话不应写历史'); },
};
for (const cb of listeners) cb({ agent: unrAgent, source: 'fresh' });
ok(true, '未设角色的会话装配不应抛错');
// 回归锁：ho_sessions(action="new") 是「先 create（触发 agent/created）→ 再写角色表」，
// 出生时必然未设角色（判为普通）。若当场收窄，新会话会在角色写入前一直只有 0 个工具
// （2026-10-24 全局9 接任实撞）。⇒ 未设角色出生不得当场 restrict，由延迟复核按真角色装配。
ok(unrCalls.restrict === 0, '未设角色出生时不得当场收窄（等角色表到位再装）', String(unrCalls.restrict));
// 延迟复核要真的「补装」，不能只是「什么都不做」：角色表随后写入 ⇒ 1.5 s 后应按真角色改造工具集。
// 用独立的假会话（session-late），别占用后面 order 用例要用的「无角色」会话。
const lateCalls = { restrict: 0, lastDeny: null };
const lateAgent = {
  id: 'session-late',
  session: { header: { id: 'session-late', title: '随便', cwd: '/tmp/y' } },
  ctx: {
    tools: { restrict: (f) => { lateCalls.restrict++; lateCalls.lastDeny = (f && f.deny) || null; return () => { }; } },
    systemPrompt: { section: () => () => { } },
  },
  inject: () => { throw new Error('未设角色的会话不应写历史'); },
};
for (const cb of listeners) cb({ agent: lateAgent, source: 'fresh' });
ok(lateCalls.restrict === 0, '未设角色出生时也不得对第二个会话当场收窄', String(lateCalls.restrict));
writeRole({}, 'session-late', { role: 'project', project: 'Demo', source: 'user' });
await new Promise((res) => setTimeout(res, 1700));
ok(lateCalls.restrict === 1, '角色后到时延迟复核应补装真角色', String(lateCalls.restrict));
ok(lateCalls.restrict === 1 && lateCalls.lastDeny && lateCalls.lastDeny.length === 13, '补装后 deny 名单应为项目角色的 13 个', JSON.stringify(lateCalls.lastDeny && lateCalls.lastDeny.length));

// 0.2.2 起工具按「步」解析：出生后第一轮就按当时的限制出工具表。
// 子级 Agent（子会话、团队成员的运行时子级）与用户会话无关，必须出生即收窄，不能留真空。
// 判定优先看会话头（origin=subagent 或 parentSession），不依赖投影缓存是否已落盘。
{
  const childCalls = { restrict: 0, lastDeny: null };
  const childAgent = {
    id: 'session-child',
    session: { header: { id: 'session-child', title: '', cwd: '/tmp/z', origin: 'subagent' } },
    ctx: {
      tools: { restrict: (f) => { childCalls.restrict++; childCalls.lastDeny = (f && f.deny) || null; return () => { }; } },
      systemPrompt: { section: () => () => { } },
    },
    inject: () => { throw new Error('子会话不应写历史'); },
  };
  for (const cb of listeners) cb({ agent: childAgent, source: 'fresh' });
  ok(childCalls.restrict === 1, '子级 Agent 出生即按普通角色收窄（工具按步解析，不留真空）', String(childCalls.restrict));
  ok(childCalls.lastDeny && childCalls.lastDeny.length === 22, '子级 Agent 的 deny 名单应为全部 22 个', JSON.stringify(childCalls.lastDeny && childCalls.lastDeny.length));
}

// ---------- 角色路由 ----------
const noRole = await postJson('/dsh-handover/role', { session_id: 'session-r1', role: 'project' });
ok(noRole.code === 400 && /项目名/.test(String(noRole.json && noRole.json.error)), '设项目角色缺项目名应 400', JSON.stringify(noRole.json));
const badRole = await postJson('/dsh-handover/role', { session_id: 'session-r1', role: 'boss' });
ok(badRole.code === 400, '未知角色应 400', JSON.stringify(badRole.json));
const okRole = await postJson('/dsh-handover/role', { session_id: 'session-r1', role: 'project', project: 'Demo', wake: false });
ok(okRole.code === 200 && okRole.json && okRole.json.ok === true && okRole.json.role === 'project', '设角色应成功', JSON.stringify(okRole.json));
ok(readRoles({}).sessions['session-r1'] && readRoles({}).sessions['session-r1'].project === 'Demo', '角色应落盘');
// ---------- ho_sessions(action=order)：全局远程下指令 ----------
const sessTool = reg.tools ? reg.tools.find((t) => t.name === 'ho_sessions') : null;
ok(!!sessTool, '应注册 ho_sessions');
const globExec = (args) => ({ name: 'ho_sessions', arguments: args, agent: { session: { header: { id: 'session-glob', cwd: WS, title: '全局9' } } } });
const orderCall = async (args) => {
  try { const out = await sessTool.execute(args, globExec(args)); return String(out && out.text ? out.text : out); }
  catch (e) { return 'ERR:' + e.message; }
};
const oNoSid = await orderCall({ action: 'order', order: 'handover' });
ok(/order 需要 session_id/.test(oNoSid), 'order 缺 session_id 应报错', oNoSid);
const oBad = await orderCall({ action: 'order', order: 'wave', session_id: 'session-r1' });
ok(/只能是 handover 或 compact/.test(oBad), 'order 取值应受限', oBad);
// 交接／压缩指令必须先问用户
const oNoConfirm = await orderCall({ action: 'order', order: 'handover', session_id: 'session-unr' });
ok(/需要用户确认/.test(oNoConfirm), 'order 未确认应拒绝', oNoConfirm);
const oUnr = await orderCall({ action: 'order', order: 'handover', session_id: 'session-unr', confirm: true });
ok(/没有交接路径/.test(oUnr), '未设角色的会话不能下交接指令（避免退回全局交接）', oUnr);
const oCold = await orderCall({ action: 'order', order: 'compact', session_id: 'session-r1', confirm: true });
ok(/不在内存/.test(oCold), '休眠会话不能排压缩（compactNow 需要活体 agent）', oCold);
const pNoSid = await orderCall({ action: 'place' });
ok(/place 需要 session_id/.test(pNoSid), 'place 缺 session_id 应报错', pNoSid);
const pNoWs = await orderCall({ action: 'place', session_id: 'session-r1' });
ok(/place 需要 workspace/.test(pNoWs), 'place 缺 workspace 应报错', pNoWs);
// ---------- 唤醒权守卫（按角色） ----------
writeRole({}, 'session-glob', { role: 'global' });
const guardExec = (name, argsObj, sid, cwd, title) => ({
  name,
  arguments: argsObj,
  agent: { session: { header: { id: sid, cwd: cwd, title: title } } },
});
ok(typeof reg.guardFn === 'function', '应注册工具守卫', typeof reg.guardFn);
if (typeof reg.guardFn === 'function') {
  const gGlobal = reg.guardFn(guardExec('peer_send', { session_id: 'session-proj-x' }, 'session-glob', WS, '全局9'));
  ok(gGlobal === undefined, '全局角色 peer_send 应放行', String(gGlobal));
  const gReport = reg.guardFn(guardExec('peer_send', { session_id: 'session-glob' }, 'session-proj', path.join(WS, 'Projects', 'Demo', 'Demo库'), 'Demo1'));
  ok(gReport === undefined, '项目会话向全局报告应放行', String(gReport));
  const gPeer = reg.guardFn(guardExec('peer_send', { session_id: 'session-proj' }, 'session-proj', path.join(WS, 'Projects', 'Demo', 'Demo库'), 'Demo1'));
  ok(gPeer === undefined, '会话之间可直接对话，不必经全局转述', String(gPeer));
  const gNew = reg.guardFn(guardExec('peer_new', { workspace: 'Demo库' }, 'session-proj', path.join(WS, 'Projects', 'Demo', 'Demo库'), 'Demo1'));
  ok(typeof gNew === 'string' && /仅属全局/.test(gNew), '项目会话不得建平级会话', String(gNew));
  const gMisc = reg.guardFn(guardExec('peer_new', { workspace: 'Misc' }, 'session-misc', path.join(WS, '_Misc', 'tasks', '抢名额'), '杂项1'));
  ok(gMisc === undefined, '杂项会话自建 Misc 换任应放行', String(gMisc));
}

const st4 = await call('GET', '/dsh-handover/status.json');
let payload4 = null;
try { payload4 = JSON.parse(st4.body); } catch (e) { /* ignore */ }
ok(payload4 && payload4.roles && payload4.roles['session-r1'], '状态页应带角色表', JSON.stringify(payload4 && payload4.roles));

// ---------- 浏览器半 ----------
let loaded = null;
globalThis.window = { __ModuleLoader__: { load: (r) => { loaded = r; } } };
const styles = [];
globalThis.document = {
  querySelector: (sel) => {
    const m = /data-plugin-css="([^"]+)"/.exec(String(sel));
    if (!m) return null;
    return styles.find((t) => t.dataset && t.dataset.pluginCss === m[1]) || null;
  },
  createElement: () => ({ dataset: {}, textContent: '' }),
  head: { appendChild: (t) => styles.push(t) },
};

const plainRows = [];
for (let i = 0; i < 10; i++) {
  plainRows.push({
    sid: 'session-p' + i, title: '旧会话' + i, role: 'plain', roleLabel: '普通', source: 'none',
    project: '', task: '', pct: i + 1, state: 'idle', active: false, seen: '2026-10-21 20:19 +0800',
  });
}

const FIXTURE = {
  generatedAt: '2026-11-07 21:25 +0800',
  plugin: { name: '@mingmaple/dsh-handover', version: 'test', tools: 22, inject: ['tools', 'systemPrompt'], initErrors: [], scheduler: '就绪' },
  workspace: { root: 'C:/ws', found: true },
  guardLast: { allow: true, source: 'title', title: '全局1', sid: 'session-x' },
  guide: payload ? payload.guide : { intro: ['说明'], situations: [{ when: 'w', say: 's', what: 'x' }], groups: [{ title: 'g', tools: [['ho_x', 'y']] }], rules: ['r'] },
  extraPrompt: '',
  extraPromptEnabled: false,
  gate: { ok: true, verdict: '全部落位。', total: 1, bodyLines: 24, libraries: [{ name: 'Mine', ok: true, titleOk: true, waterOk: true, missing: 0, lines: 24 }] },
  handover: { global: { verdict: '通过', reasons: [] }, projects: [{ name: 'Mine', verdict: '通过', reasons: [] }, { name: 'Idle', verdict: '缺节', reasons: ['缺 ## 1. 正在做的事（2026-10-12 起的强制项，本项目还没补）'] }], fail: 0 },
  sessions: {
    rows: [
      { sid: 'session-y', project: 'Mine', pct: 34.6, state: 'idle', active: true, seen: '2026-10-23 23:19 +0800' },
      { sid: 'session-l', project: 'Study', pct: 50, state: 'idle', active: false, seen: '2026-10-22 20:00 +0800' },
    ],
    all: [
      { sid: 'session-g1', title: '全局1', role: 'global', roleLabel: '全局', source: 'title', project: '', task: '', pct: 40, state: 'idle', active: true, seen: '2026-11-07 21:00 +0800' },
      { sid: 'session-y', title: 'Mine1', role: 'project', roleLabel: '项目', source: 'store', project: 'Mine', task: '', pct: 34.6, state: 'idle', active: true, seen: '2026-10-23 23:19 +0800' },
      { sid: 'session-l', title: 'Study1', role: 'project', roleLabel: '项目', source: 'cwd', project: 'Study', task: '', pct: 50, state: 'idle', active: false, seen: '2026-10-22 20:00 +0800' },
    ].concat(plainRows),
    notify: [{ sid: 'session-y', project: 'Mine' }], hot: 2, unknown: 0, cutoff: '2026-11-07 09:25 +0800', silentHours: 12,
    verdict: '2 个会话已进预警区（≥32%），应先收齐交接再换会话',
  },
  consent: [{ sessionId: 'session-y', leftMs: 120000 }],
  notes: [],
};
globalThis.fetch = async () => ({ ok: true, json: async () => FIXTURE });

await import(pathToFileURL(path.join(dist, 'client.js')).href);
ok(loaded && loaded.id === '@mingmaple/dsh-handover', 'client.js 应注册正确 bundle id', loaded && loaded.id);

function fakeReact(preloaded) {
  const createElement = (type, props, ...kids) => ({ type, props: props || {}, kids: kids.flat().filter((k) => k !== null && k !== undefined && k !== false) });
  // 只把首个 useState 预置为夹具（该组件首个状态正是读数），其余状态按各自初值，避免误填。
  let first = true;
  return {
    createElement,
    useState: (init) => {
      const v = first && preloaded !== null && preloaded !== undefined ? preloaded : init;
      first = false;
      return [v, () => { }];
    },
    useEffect: (fn) => { try { fn(); } catch (e) { /* 假 React 里跑一次 */ } },
    useCallback: (fn) => fn,
    useId: () => 'id',
    useRef: (v) => ({ current: v }),
    Fragment: 'Fragment',
  };
}

const exp = loaded.factory((name) => {
  if (name === 'react') return fakeReact(null);
  throw new Error('不应 require：' + name);
});
ok(typeof exp.apply === 'function', 'exports.apply 应为函数');
ok(Array.isArray(exp.inject) && exp.inject.indexOf('slots') !== -1, 'exports.inject 应含 slots');

let slotOpts = null;
let Comp = null;
exp.apply({ slots: { inject: (n, cb) => { ok(n === 'settings.section', '应注册进 settings.section', n); cb(); }, register: (o, c) => { slotOpts = o; Comp = c; } } });
ok(slotOpts && slotOpts.id === 'handover', '槽位选项不对', JSON.stringify(slotOpts));
ok(slotOpts && slotOpts.label === 'dsh-handover', '导航标签就是产品名 dsh-handover（不加中文前缀）', JSON.stringify(slotOpts && slotOpts.label));
ok(typeof Comp === 'function', '应给出组件');
ok(!!Comp({}), '空数据渲染应返回元素');

const exp2 = loaded.factory((name) => (name === 'react' ? fakeReact(FIXTURE) : (() => { throw new Error('x'); })));
let Comp2 = null;
exp2.apply({ slots: { inject: (n, cb) => cb(), register: (o, c) => { Comp2 = c; } } });
const tree = Comp2({});
function textOf(node, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
  if (Array.isArray(node)) { node.forEach((n) => textOf(n, out)); return out; }
  // 组件节点（如 Folded）也要展开，否则表格内容不会被断言看到。
  if (typeof node.type === 'function') { textOf(node.type(node.props || {}), out); return out; }
  if (node.kids) node.kids.forEach((n) => textOf(n, out));
  return out;
}
const text = textOf(tree).join(' ');
const treeJson = JSON.stringify(tree);
for (const want of ['dsh-handover', '刷新', '读数', '压缩授权', '会话角色', '全局前置提示词', '会话水位', '通用约束条闸门', '交接文档体检', '使用说明']) {
  ok(text.indexOf(want) !== -1, '成体视图应出现「' + want + '」');
}

// 回到重构前的版式——常用区直接展开，只折叠低频项；授权可直接点。
const sections = tree.kids.filter((k) => k && k.type === 'section');
const cardTitles = sections.map((sec) => textOf(sec.kids[0]).join(''));
const wantOrder = ['压缩授权', '移动全局根目录', '会话角色', '全局前置提示词', '会话水位', '通用约束条闸门', '交接文档体检', '插件', '会话间通信守卫', '使用说明'];
ok(JSON.stringify(cardTitles) === JSON.stringify(wantOrder), '分区应自上而下为授权、迁移、角色、提示词、只读数据、插件、守卫、说明', JSON.stringify(cardTitles));

const folds = treeJson.split('"details"').length - 1;
ok(folds === 3, '只折叠低频项（迁移、前置提示词、使用说明），常用区直接展开', String(folds));

// 压缩授权：给出可点击的会话按钮，用户不必手填 id。
const allowBtns = [];
(function walk(n) {
  if (!n || typeof n !== 'object') return;
  if (Array.isArray(n)) { n.forEach(walk); return; }
  if (n.type === 'button' && textOf(n).join('').indexOf('允许 ') === 0) allowBtns.push(textOf(n).join(''));
  (n.kids || []).forEach(walk);
})(tree);
ok(allowBtns.length >= 3, '压缩授权应提供可点击的会话按钮', JSON.stringify(allowBtns.slice(0, 5)));
ok(text.indexOf('允许 y') !== -1, '授权按钮须带会话短号');

// 角色下拉含普通，不再回退到空值。
ok(text.indexOf('普通') !== -1, '角色下拉应含普通选项');
ok(fs.readFileSync(path.join(dist, 'client.js'), 'utf8').indexOf('value: "plain"') !== -1, '角色下拉应含普通选项（源码核对）');

// 角色列与选择框合并：不再单列「当前角色」，操作只有一个按钮。
ok(text.indexOf('当前角色') === -1, '角色不应占两列（当前角色与选择框合并）');
ok(text.indexOf('设置并通知') === -1, '操作列只保留一个按钮');
const setBtns = text.split('设置角色').length - 1;
ok(setBtns >= 5, '每行一个「设置角色」按钮', String(setBtns));
ok(fs.readFileSync(path.join(dist, 'client.js'), 'utf8').indexOf('通知该会话') !== -1, '设置成功后按钮应变为通知动作');

// 移动全局根目录：默认折叠。
const migrateCard = sections.find((sec) => textOf(sec.kids[0]).join('') === '移动全局根目录');
const migrateDetail = migrateCard.kids[1].kids[0];
ok(migrateDetail && migrateDetail.type === 'details' && migrateDetail.props.open !== true, '移动全局根目录应默认折叠');

// 交接体检只写问题，不带括注。
ok(text.indexOf('缺 ## 1. 正在做的事') !== -1 && text.indexOf('强制项') === -1, '交接体检的问题列不应带括注说明');

// 会话水位只列项目会话，并给出本轮需通知。
ok(text.indexOf('Mine') !== -1 && text.indexOf('34.6%') !== -1, '会话水位应列出项目会话与水位');
ok(text.indexOf('本轮需通知') !== -1, '水位段应给出本轮需通知');
ok(text.indexOf('Study1') !== -1, '角色表应列出平级会话');

// 版式约束：无进度条、无图形结论符号。
ok(treeJson.indexOf('dshh-bar') === -1, '不得使用进度条');
const clientSrc = fs.readFileSync(path.join(dist, 'client.js'), 'utf8');
ok(!/[\u2705\u274C\u26A0\u2717]/.test(clientSrc), '界面不得使用图形结论符号');
ok(clientSrc.indexOf('delWord.trim() !== "删除"') !== -1, '删除旧副本须输入确认词');

// 未接入工作区：首次安装置顶。
const NOT_READY = {
  generatedAt: '2026-11-07 21:25 +0800',
  plugin: { name: '@mingmaple/dsh-handover', version: 'test', tools: 22, inject: ['tools'], initErrors: [], scheduler: '就绪' },
  workspace: { root: '', found: false },
  setup: { steps: ['准备一个长期存在的目录', '粘贴路径后点击「建立全局文件体系」'] },
  guide: payload ? payload.guide : null,
  notes: ['未找到 _Control_Center：这个实例还没接入工作区。'],
};
const exp3 = loaded.factory((name) => (name === 'react' ? fakeReact(NOT_READY) : (() => { throw new Error('x'); })));
let Comp3 = null;
exp3.apply({ slots: { inject: (n, cb) => cb(), register: (o, c) => { Comp3 = c; } } });
const tree3 = Comp3({});
const sections3 = tree3.kids.filter((k) => k && k.type === 'section');
const titles3 = sections3.map((sec) => textOf(sec.kids[0]).join(''));
ok(titles3[0] === '首次安装', '未接入工作区时首次安装置顶', JSON.stringify(titles3));
ok(textOf(tree3).join(' ').indexOf('建立全局文件体系') !== -1, '未接入时应能建立文件体系');
ok(textOf(tree3).join(' ').indexOf('待处理') !== -1, '未接入时应显示待处理项');

ok(styles.length === 1, '样式只注入一次（幂等）', String(styles.length));

// ---------- 搬迁（mover）：两棵假树全流程（空白 HOME 下，标记与脚本都落在 BLANK 里）
const mv = await import(pathToFileURL(path.join(dist, 'lib/mover.mjs')).href);
const mvRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-handover-move-'));
const srcDir = path.join(mvRoot, 'src');
fs.mkdirSync(path.join(srcDir, '_Control_Center'), { recursive: true });
fs.mkdirSync(path.join(srcDir, 'sub'), { recursive: true });
fs.writeFileSync(path.join(srcDir, 'a.txt'), 'AAA');
fs.writeFileSync(path.join(srcDir, 'sub', 'b.txt'), 'BBBB');
const dstDir = path.join(mvRoot, 'dst');

const probe = await mv.probeMove({ src: srcDir, to: dstDir });
ok(probe.ok, '预检应通过', JSON.stringify(probe.problems));
ok(probe.files === 2 && probe.bytes === 7, '预检应数出 2 文件 / 7 字节', JSON.stringify({ f: probe.files, b: probe.bytes }));
const probeInner = await mv.probeMove({ src: srcDir, to: path.join(srcDir, 'inside') });
ok(!probeInner.ok && probeInner.problems.join(' ').indexOf('内部') !== -1, '目标在源内部应拒绝', JSON.stringify(probeInner.problems));
const probeSame = await mv.probeMove({ src: srcDir, to: srcDir });
ok(!probeSame.ok && probeSame.problems.join(' ').indexOf('相同') !== -1, '目标等于源应拒绝', JSON.stringify(probeSame.problems));

const started = await mv.startMove({ src: srcDir, to: dstDir });
ok(started.ok && started.report.files === 2, '复制应通过全量校验', JSON.stringify(started.report));
// to 是**父目录**，真正的根是 <父>/<当前根名>
ok(probe.dst === path.join(dstDir, 'src'), '目标根应为「父目录/当前根名」', probe.dst);
ok(fs.existsSync(path.join(started.marker.dst, 'sub', 'b.txt')), '目标应真的有文件');
const sp = mv.scriptPaths();
ok(fs.existsSync(sp.helper) && fs.existsSync(sp.cmd) && fs.existsSync(sp.sh), '切换助手与两个平台启动器应已生成');
const helperText = fs.readFileSync(sp.helper, 'utf8');
ok(helperText.indexOf('renameSync') !== -1 && helperText.indexOf('symlinkSync') !== -1, '助手应含改名与建链接');
ok(helperText.indexOf('process.kill') !== -1, '助手应以「父进程是否存活」判断 DSH 是否退出');
ok(helperText.indexOf('powershell') === -1 && helperText.indexOf('bash') === -1, '助手不得依赖 PowerShell／bash（跨平台）');

const stVerified = mv.moveStatus({ src: srcDir });
ok(stVerified.phase === 'verified', '校验完状态应为 verified', stVerified.phase);
// 模拟切换：改名 + 建链接（助手在 DSH 退出后做的事，这里用 Node 等价物）
const oldDir = srcDir + '.old-test';
fs.renameSync(srcDir, oldDir);
fs.symlinkSync(started.marker.dst, srcDir, process.platform === 'win32' ? 'junction' : 'dir');
const stSwitched = mv.moveStatus({ src: srcDir });
ok(stSwitched.phase === 'switched', '建链接后状态应为 switched', stSwitched.phase + ' / ' + stSwitched.linkTarget);
ok(stSwitched.olds.length === 1, '应找到 1 个旧副本', JSON.stringify(stSwitched.olds.map((o) => o.path)));
const refuse = await mv.cleanupOld({ src: srcDir, confirm: false }).then(() => 'no-error', (e) => 'err:' + e.message);
ok(String(refuse).indexOf('明确确认') !== -1, '未确认不得删旧副本', String(refuse));
const cleaned = await mv.cleanupOld({ src: srcDir, confirm: true });
ok(cleaned.ok && cleaned.removed.length === 1 && !fs.existsSync(oldDir), '清旧副本应删掉 .old 目录', JSON.stringify(cleaned.removed));
const stCleaned = mv.moveStatus({ src: srcDir });
ok(stCleaned.phase === 'switched+cleaned', '清理后状态应记 switched+cleaned', stCleaned.phase);

// 原路径被手工删掉（资源管理器误删）后应能看见并一键重建；只建链接，不动文件
try { fs.unlinkSync(srcDir); } catch (e) { fs.rmSync(srcDir, { recursive: true, force: true }); }
const stMissing = mv.moveStatus({ src: srcDir });
ok(stMissing.srcExists === false, '原路径被删后 srcExists 应为 false', String(stMissing.srcExists));
ok(stMissing.canRepair === true, '目标还在时应报「可重建」', JSON.stringify({ dst: stMissing.dstExists, repair: stMissing.canRepair }));
const repaired = mv.repairLink();
ok(repaired.ok && repaired.repaired === true, '重建链接应成功', JSON.stringify(repaired));
const stRepaired = mv.moveStatus({ src: srcDir });
ok(stRepaired.srcExists === true && stRepaired.canRepair === false, '重建后原路径应恢复为链接', JSON.stringify({ s: stRepaired.srcExists, t: stRepaired.linkTarget }));
ok(stRepaired.phase === 'switched+cleaned', '重建后状态应保持 switched+cleaned', stRepaired.phase);

// 压缩授权——AI 不能自己批，只有用户点的那一下才算
const cs0 = await import(pathToFileURL(path.join(dist, 'lib/consent.mjs')).href);
const SID = 'session-test-0001';
const before = cs0.checkConsent(SID);
ok(before.ok === false, '没有用户授权时应判为未授权', JSON.stringify(before));
const g1 = cs0.grantConsent(SID, '冒烟');
ok(g1.minutes === 5, '授权有效期应为 5 分钟', String(g1.minutes));
const after = cs0.checkConsent(SID);
ok(after.ok === true, '用户授权后应判为已授权', JSON.stringify(after));
ok(after.leftMs > 0 && after.leftMs <= 5 * 60 * 1000, '剩余时间应在 5 分钟内', String(after.leftMs));
ok(Array.isArray(cs0.listConsent()) && cs0.listConsent().length === 1, '授权列表应列出 1 条');
cs0.consumedConsent(SID);
ok(cs0.checkConsent(SID).ok === false, '用掉一次后授权应失效');
ok(cs0.CONSENT_TTL_MS === 5 * 60 * 1000, '授权时限常量应为 5 分钟');

// 登记改址——只替换路径字符串、先备份、其余内容不动
const regDir = path.join(BLANK, '.dsh', 'storages');
fs.mkdirSync(regDir, { recursive: true });
const regFile = path.join(regDir, 'workspace.json');
const fakeWs = { tables: { workspaces: { w1: { id: 'w1', title: '全局', path: srcDir, sessionIds: ['s1'] } } }, other: 'keep-me' };
fs.writeFileSync(regFile, JSON.stringify(fakeWs, null, 2), 'utf8');
const planRt = mv.retargetPlan({ src: srcDir, dst: started.marker.dst });
ok(planRt.needed === true, '登记里仍有旧路径时应报「需要改址」', JSON.stringify(planRt.files));
ok(planRt.total >= 1, '应数出至少一处旧路径', String(planRt.total));
const doneRt = mv.applyRetarget({ src: srcDir, dst: started.marker.dst });
ok(doneRt.written.length === 1, '应改写 1 个登记文件', JSON.stringify(doneRt.written));
const afterRt = JSON.parse(fs.readFileSync(regFile, 'utf8'));
ok(afterRt.tables.workspaces.w1.path === started.marker.dst, '工作区路径应改成新位置', afterRt.tables.workspaces.w1.path);
ok(afterRt.other === 'keep-me', '登记里的其他字段应原样保留');
ok(fs.existsSync(doneRt.written[0].backup), '改写前应留下备份');
ok(mv.retargetPlan({ src: srcDir, dst: started.marker.dst }).needed === false, '改完之后应不再需要改址');

// 超长路径删除（Windows 上 fs.rm 遇 >260 字符会整体报 EPERM，rmTree 逐项删应成功）
let deepPath = path.join(mvRoot, 'deep');
for (let i = 0; i < 8; i++) deepPath = path.join(deepPath, 'dir-' + i + '-' + 'x'.repeat(40));
fs.mkdirSync(deepPath, { recursive: true });
const deepFile = path.join(deepPath, 'y'.repeat(90) + '.txt');
fs.writeFileSync(deepFile, 'deep');
if (process.platform === 'win32') ok(deepFile.length > 260, '构造的路径应超过 260 字符', String(deepFile.length));
const delDeep = await mv.rmTree(path.join(mvRoot, 'deep'));
ok(delDeep.ok && !fs.existsSync(path.join(mvRoot, 'deep')), 'rmTree 应删掉超长路径树', JSON.stringify(delDeep.fails));
fs.rmSync(mvRoot, { recursive: true, force: true });

fs.rmSync(BLANK, { recursive: true, force: true });
console.log('');
if (fails.length) {
  console.log('SMOKE FAIL ' + fails.length + ' 项：');
  for (const f of fails) console.log('  - ' + f);
  process.exit(1);
}
console.log('SMOKE OK（空白环境冒烟全过）');

