/**
 * 设置页用的状态快照（只读）：插件自身状态 ＋ 闸门 ＋ 交接体检 ＋ 会话水位 ＋ 最近一次守卫判定。
 * 全部读本地文件，不唤醒任何会话、不花任何会话的 token。
 * 任何一段出错都只让该段带 error 字段，不让整页 500。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncCheck } from './gates.mjs';
import { lintGlobal, lintProject } from './lint.mjs';
import { scanSessions } from './sessions.mjs';
import { routeWorkspace, hasCenter } from './workspace.mjs';
import { stampTz } from './brief.mjs';
import { buildGuide, SETUP_STEPS } from './guide.mjs';
import { readRoles, resolveRole, ROLE_LABEL, sessionMeta } from './role.mjs';
import { listConsent } from './consent.mjs';
import { listProfiles } from './profile.mjs';
import { loadOffice, readRegistryProjects, KIND_LABEL } from './office.mjs';
import { checkRegistries } from './system.mjs';
import { legacyInfo } from './legacy.mjs';

function guard(fn, fallback) {
  try { return fn(); } catch (e) { return { ...fallback, error: String(e && e.message ? e.message : e) }; }
}

/**
 * DSH 工作区索引：读 `~/.dsh/storages/workspace.json`（只读）。
 * 返回 { list, bySession, archived }：
 * - list：按登记顺序的工作区（key、title、path）；
 * - bySession：sessionId → 工作区；
 * - archived：已归档会话 id，设置页不再罗列。
 * 读不到时全部为空，调用方据此退化为「按会话目录分组、只按归档表过滤」。
 */
function loadWorkspaceIndex() {
  const out = { list: [], bySession: new Map(), archived: new Set() };
  let v = null;
  try {
    const file = path.join(os.homedir(), '.dsh', 'storages', 'workspace.json');
    v = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch { return out; }
  if (!v || typeof v !== 'object') return out;
  const tables = v.tables && v.tables.workspaces ? v.tables.workspaces : {};
  const order = v.global && Array.isArray(v.global.workspaceIds) && v.global.workspaceIds.length
    ? v.global.workspaceIds : Object.keys(tables);
  for (const key of order) {
    const w = tables[key];
    if (!w) continue;
    const item = { key: String(key), title: String(w.title || ''), path: String(w.path || '') };
    out.list.push(item);
    for (const sid of (Array.isArray(w.sessionIds) ? w.sessionIds : [])) out.bySession.set(String(sid), item);
  }
  for (const sid of (v.global && Array.isArray(v.global.archivedSessionIds) ? v.global.archivedSessionIds : [])) {
    out.archived.add(String(sid));
  }
  return out;
}

/** 仍然存在的会话目录：`~/.dsh/sessions` 下以 session- 开头的目录名（含已归档里恢复不了的会话就自然不在）。 */
function liveSessionDirs() {
  const set = new Set();
  try {
    const walk = (dir, depth) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        if (e.name.indexOf('session-') === 0) set.add(e.name);
        else if (depth < 4) walk(path.join(dir, e.name), depth + 1);
      }
    };
    walk(path.join(os.homedir(), '.dsh', 'sessions'), 0);
  } catch { /* 读不到就返回空集 */ }
  return set;
}

/** 在任登记：Office.json 中每条登记（全局、各项目、各杂项任务）的现任。
 * 返回 sessionId → { key, kind, kindLabel, name }；读不到登记表时为空表，调用方据此退化为「不过滤」。
 * 普通会话不登记，因此不会被当成在任会话。
 */
function loadDuty(ws) {
  const map = new Map();
  let office = null;
  try { office = loadOffice(ws); } catch { office = null; }
  const lineages = (office && office.lineages) || {};
  for (const key of Object.keys(lineages)) {
    const lin = lineages[key] || {};
    const cur = lin.current;
    if (!cur || !cur.sessionId) continue;
    map.set(String(cur.sessionId), {
      key,
      kind: String(lin.kind || ''),
      kindLabel: KIND_LABEL[lin.kind] || '',
      project: String(lin.project || ''),
      task: String(lin.task || ''),
      name: String(cur.name || key),
    });
  }
  return { map, office };
}

/** 项目交接体检：只查 Registry.md 已登记的项目，未登记的旧目录不在此列。 */
function lintProjects(ws) {
  const out = [];
  let names = [];
  try { names = readRegistryProjects(ws); } catch { return out; }
  for (const name of names) {
    const r = lintProject(path.join(ws, '_Project_Meta', name, 'Handover.md'));
    out.push({ name, verdict: r.verdict, reasons: Array.isArray(r.reasons) ? r.reasons.slice(0, 5) : [] });
  }
  return out;
}

/** 杂项目录：规范位置 `_Misc/tasks/<任务>/`，兼容旧布局 `_Misc/<任务>/`；两处都没有就返回空串。 */
function miscDir(ws, task) {
  const name = String(task || '').trim();
  if (!name) return '';
  const cands = [path.join(ws, '_Misc', 'tasks', name), path.join(ws, '_Misc', name)];
  for (const dir of cands) {
    try { if (fs.statSync(dir).isDirectory()) return dir; } catch { /* 继续看下一个 */ }
  }
  return '';
}

/**
 * 杂项交接体检：按 Office.json 里已登记的杂项条目找任务目录。
 * 登记名与目录名不一致（例如登记「示例任务」、目录名不同）时报「未找到」，
 * 不猜近似目录：猜错会把别人的交接算到这条任务头上。
 */
function lintMisc(ws, office) {
  const out = [];
  const lineages = (office && office.lineages) || {};
  for (const key of Object.keys(lineages)) {
    const lin = lineages[key] || {};
    if (String(lin.kind || '') !== 'misc') continue;
    const name = String(lin.task || key).trim();
    if (!name) continue;
    const dir = miscDir(ws, name);
    const r = dir
      ? lintProject(path.join(dir, 'Handover.md'))
      : { verdict: '未找到', reasons: ['按登记名找不到任务目录：_Misc/tasks/' + name + ' 或 _Misc/' + name] };
    out.push({ name, verdict: r.verdict, reasons: Array.isArray(r.reasons) ? r.reasons.slice(0, 5) : [] });
  }
  return out;
}

export function buildStatus(env, extra) {
  const info = extra || {};
  const ws = routeWorkspace(env);
  const found = hasCenter(ws);
  const warn = Math.round((env.cfg.remindRatio || 0.35) * 100);
  const duty = loadDuty(ws);
  const onDuty = (sid) => (duty.map.size ? duty.map.has(String(sid || '')) : true);
  const dutyOf = (sid) => duty.map.get(String(sid || '')) || null;
  const out = {
    generatedAt: stampTz(Date.now()),
    plugin: {
      name: info.name || '@mingmaple/dsh-handover',
      version: info.version || '?',
      tools: typeof info.tools === 'number' ? info.tools : 0,
      inject: guard(() => env.injectList(), []),
      initErrors: guard(() => env.initErrors(), []),
      scheduler: info.scheduler || '未知',
    },
    workspace: { root: ws, found },
    ratios: guard(() => ({
      remind: Math.round((env.cfg.remindRatio !== undefined ? env.cfg.remindRatio : 0.35) * 100),
      remind2: Math.round((env.cfg.remind2Ratio !== undefined ? env.cfg.remind2Ratio : 0.5) * 100),
      handover: Math.round((env.cfg.handoverRatio !== undefined ? env.cfg.handoverRatio : 0.35) * 100),
      hard: Math.round((env.cfg.hardRatio !== undefined ? env.cfg.hardRatio : 0.85) * 100),
    }), { remind: 35, remind2: 50, handover: 35, hard: 85 }),
    guardLast: guard(() => env.guardLast(), null),
    extraPrompt: guard(() => (typeof env.extraPrompt === 'function' ? env.extraPrompt() : ''), ''),
    extraPromptEnabled: guard(() => (typeof env.extraPromptEnabled === 'function' ? env.extraPromptEnabled() : false), false),
    extraPromptOrder: 950,
    roles: guard(() => {
      const store = readRoles(env.cfg);
      const map = {};
      for (const sid of Object.keys(store.sessions)) {
        const e = store.sessions[sid] || {};
        map[sid] = { role: String(e.role || ''), project: String(e.project || ''), task: String(e.task || ''), setAt: String(e.setAt || '') };
      }
      return map;
    }, {}),
    consent: guard(() => listConsent().map((r) => ({ ...r, onduty: onDuty(r.sessionId) })), []),
    profiles: guard(() => listProfiles(ws), []),
    guide: guard(() => buildGuide(env.cfg), { intro: [], situations: [], groups: [], rules: [] }),
    gate: null,
    handover: null,
    sessions: null,
    notes: [],
  };

  if (!found) {
    out.notes.push('未找到 _Control_Center：这个实例还没接入工作区。可在插件 config 里写 workspaceRoot。');
    out.notes.push('插件本身已加载：工具与设置页不依赖工作区，只有闸门、交接、会话三段需要工作区。');
    out.setup = { steps: SETUP_STEPS };
    return out;
  }

  out.gate = guard(() => {
    const g = syncCheck(ws);
    return {
      ok: !!g.ok,
      error: g.error || '',
      verdict: g.verdict || '',
      total: g.total || 0,
      bodyLines: g.bodyLines || 0,
      libraries: (g.libraries || []).map((r) => ({
        name: r.name, ok: !!r.ok, titleOk: !!r.titleOk, waterOk: !!r.waterOk,
        missing: r.missing ? r.missing.length : 0, lines: r.total || 0,
      })),
    };
  }, { ok: false, libraries: [] });

  out.handover = guard(() => {
    const g = lintGlobal(path.join(ws, '_Control_Center', 'records', 'Global_Handover.md'));
    const projects = lintProjects(ws);
    const misc = lintMisc(ws, duty.office);
    const bad = projects.concat(misc).filter((p) => p.verdict === '不合格');
    return {
      global: { verdict: g.verdict, reasons: Array.isArray(g.reasons) ? g.reasons.slice(0, 5) : [] },
      projects,
      misc,
      fail: bad.length,
    };
  }, { global: { verdict: '读不到', reasons: [] }, projects: [], misc: [], fail: 0 });

  out.systems = guard(() => {
    const r = checkRegistries(ws);
    return { rows: r.rows.map((x) => ({ label: x.label, rel: x.rel, exists: x.exists, entries: x.entries, bad: x.bad.length })), missing: r.missing };
  }, { rows: [], missing: 0 });

  try {
    const legacy = legacyInfo(ws);
    if (legacy.exists) {
      out.notes.push('检测到旧文档定位（_Control_Center/records/docmap/）：执行 ho_workspace(action="migrate") 并入体系注册。');
    }
  } catch { /* 旧目录检查失败不影响整页 */ }

  out.sessions = guard(() => {
    const wide = scanSessions({
      dir: env.cacheDir(), meId: null, meCwd: null, warn,
      silentHours: env.cfg.sessionScanHours, projectsOnly: false,
    });
    const store = readRoles(env.cfg);
    const roleOf = (sid, cwd, firstPrompt, title) => {
      const meta = sessionMeta(sid);
      return resolveRole({ cfg: env.cfg, roles: store, sessionId: sid, cwd, firstPrompt, subagent: meta.subagent, title });
    };
    // 工作区与归档：设置页按工作区分组罗列，已归档与目录已不存在的会话不再出现。
    const wsIndex = loadWorkspaceIndex();
    const live = liveSessionDirs();
    // 会话 id 在缓存里有带与不带 session- 前缀两种写法，统一成带前缀再比。
    const sidKey = (sid) => (/^session-/.test(String(sid)) ? String(sid) : 'session-' + String(sid));
    const archived = (sid) => wsIndex.archived.has(sidKey(sid));
    const stillThere = (sid) => live.size === 0 || live.has(sidKey(sid));
    // 真实路径：旧根现为链接，靠 realpath 才能把老会话归到当前工作区。
    const realCache = new Map();
    const realOf = (p) => {
      const key = String(p || '').toLowerCase();
      if (realCache.has(key)) return realCache.get(key);
      let v = '';
      try { v = fs.realpathSync(String(p || '')); } catch { v = ''; }
      realCache.set(key, v);
      return v;
    };
    const wsReal = wsIndex.list.map((w) => ({
      w,
      real: String(realOf(w.path) || w.path || '').replace(/\\/g, '/').toLowerCase(),
    }));
    const wsOf = (sid, cwd) => {
      const direct = wsIndex.bySession.get(sidKey(sid));
      if (direct) return direct;
      // 未登记到工作区的会话：按 cwd（先取真实路径）最长前缀归到工作区。
      const c = String(realOf(cwd) || cwd || '').replace(/\\/g, '/').toLowerCase();
      if (!c) return null;
      let best = null;
      for (const item of wsReal) {
        const wp = item.real;
        if (!wp) continue;
        if ((c === wp || c.indexOf(wp + '/') === 0) && (!best || wp.length > best.real.length)) best = item;
      }
      return best ? best.w : null;
    };
    const mapRow = (r) => {
      const meta = sessionMeta(r.sid);
      const info = roleOf(r.sid, meta.cwd, meta.firstPrompt, r.project);
      const d = dutyOf(r.sid);
      const w = wsOf(r.sid, meta.cwd);
      // 目录已不存在的老会话（旧树里删掉的项目库等）不再罗列。
      const cwdOk = !meta.cwd || !!realOf(meta.cwd);
      return {
        sid: r.sid,
        title: r.project === '-' ? '' : r.project,
        project: r.project,
        role: info.role,
        roleLabel: ROLE_LABEL[info.role] || info.role,
        source: info.source,
        projectName: info.project,
        task: info.task,
        cwdOk,
        // 工作区分组：没有登记归属时留空，客户端归入「未归属工作区」。
        wsKey: w ? w.key : '',
        wsTitle: w ? w.title : '',
        wsPath: w ? w.path : String(meta.cwd || ''),
        // 类别与名称以在任登记为准：登记过的会话才能说清自己是全局、项目还是杂项。
        dutyKind: d ? d.kindLabel : '',
        dutyKey: d ? d.key : '',
        dutyName: d ? d.name : '',
        pct: r.pct,
        state: r.state,
        active: r.mtime >= wide.cutoffMs,
        onduty: !!d,
        mtime: r.mtime,
        seen: stampTz(r.mtime),
      };
    };
    const all = wide.rows
      .filter((r) => r.kind === '平级' && !archived(r.sid) && stillThere(r.sid))
      .map(mapRow)
      .filter((r) => r.wsKey || r.cwdOk);
    // 在任集合：全局、各项目、各杂项任务的现任各一行；普通会话不在登记表里，因此不出现。
    const rows = all.filter((r) => r.onduty).slice(0, 60);
    // 通知：每条登记的在任会话，若本轮仍活跃；已交出的会话即使更活跃也不通知。
    const notify = [];
    for (const sid of duty.map.keys()) {
      const hit = rows.find((r) => r.sid === sid);
      if (hit && hit.mtime >= wide.cutoffMs) notify.push({ sid: hit.sid, key: hit.dutyKey, name: hit.dutyName });
    }
    const hot = rows.filter((r) => r.pct !== null && r.pct >= warn).length;
    return {
      rows,
      all,
      workspaces: wsIndex.list.map((w) => ({ key: w.key, title: w.title || w.path, path: w.path })),
      notify,
      onduty: duty.map.size,
      hot,
      unknown: wide.unknown.length,
      cutoff: stampTz(wide.cutoffMs),
      silentHours: wide.silentHours,
      verdict: hot
        ? hot + ' 个在任会话已过 ' + warn + '% 线，应先收齐交接，再换会话'
        : '没有在任会话超过 ' + warn + '% 线。',
    };
  }, { rows: [], notify: [], hot: 0, unknown: 0 });

  // 设置页用：已接入工作区但没有全局会话时，给出补建入口。
  out.globalSessions = guard(() => {
    const all = (out.sessions && Array.isArray(out.sessions.all)) ? out.sessions.all : [];
    return all.filter((r) => r && r.role === 'global').length;
  }, 0);

  return out;
}