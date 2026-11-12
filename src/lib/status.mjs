/**
 * 设置页用的状态快照（只读）：插件自身状态 ＋ 闸门 ＋ 交接体检 ＋ 会话水位 ＋ 最近一次守卫判定。
 * 全部读本地文件，不唤醒任何会话、不花任何会话的 token。
 * 任何一段出错都只让该段带 error 字段，不让整页 500。
 */
import fs from 'node:fs';
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

function guard(fn, fallback) {
  try { return fn(); } catch (e) { return { ...fallback, error: String(e && e.message ? e.message : e) }; }
}

/**
 * 在任登记：Office.json 每条血脉的现任（全局、各项目、各杂项任务）。
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
 * 杂项交接体检：按 Office.json 里已登记的杂项血脉找任务目录。
 * 登记名与目录名不一致（例如登记「抢名额脚本」、目录是 `_Misc/微信志愿抢名额`）时报「未找到」，
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
  const warn = Math.round((env.cfg.warnRatio || 0.32) * 100);
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
      warn: Math.round((env.cfg.warnRatio !== undefined ? env.cfg.warnRatio : 0.32) * 100),
      handover: Math.round((env.cfg.handoverRatio !== undefined ? env.cfg.handoverRatio : 0.35) * 100),
      hard: Math.round((env.cfg.hardRatio !== undefined ? env.cfg.hardRatio : 0.85) * 100),
    }), { warn: 32, handover: 35, hard: 85 }),
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
    const mapRow = (r) => {
      const meta = sessionMeta(r.sid);
      const info = roleOf(r.sid, meta.cwd, meta.firstPrompt, r.project);
      const d = dutyOf(r.sid);
      return {
        sid: r.sid,
        title: r.project === '-' ? '' : r.project,
        project: r.project,
        role: info.role,
        roleLabel: ROLE_LABEL[info.role] || info.role,
        source: info.source,
        projectName: info.project,
        task: info.task,
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
    const all = wide.rows.filter((r) => r.kind === '平级').map(mapRow);
    // 在任集合：全局、各项目、各杂项任务的现任各一行；普通会话不在登记表里，因此不出现。
    const rows = all.filter((r) => r.onduty).slice(0, 60);
    // 通知：每条血脉的现任，若本轮仍活跃；退休会话即使更活跃也不通知。
    const notify = [];
    for (const sid of duty.map.keys()) {
      const hit = rows.find((r) => r.sid === sid);
      if (hit && hit.mtime >= wide.cutoffMs) notify.push({ sid: hit.sid, key: hit.dutyKey, name: hit.dutyName });
    }
    const hot = rows.filter((r) => r.pct !== null && r.pct >= warn).length;
    return {
      rows,
      all,
      notify,
      onduty: duty.map.size,
      hot,
      unknown: wide.unknown.length,
      cutoff: stampTz(wide.cutoffMs),
      silentHours: wide.silentHours,
      verdict: hot
        ? hot + ' 个在任会话已进预警区（不低于 ' + warn + '%），应先收齐交接，再换会话'
        : '没有在任会话进入预警区。',
    };
  }, { rows: [], notify: [], hot: 0, unknown: 0 });

  // 设置页用：已接入工作区但没有全局会话时，给出补建入口。
  out.globalSessions = guard(() => {
    const all = (out.sessions && Array.isArray(out.sessions.all)) ? out.sessions.all : [];
    return all.filter((r) => r && r.role === 'global').length;
  }, 0);

  return out;
}