/**
 * 设置页用的状态快照（只读）：插件自身状态 ＋ 闸门 ＋ 交接体检 ＋ 会话水位 ＋ 最近一次守卫判定。
 * 全部读本地文件，不唤醒任何会话、不花任何会话的 token。
 * 任何一段出错都只让该段带 error 字段，不让整页 500。
 */
import fs from 'node:fs';
import path from 'node:path';
import { isDir } from './text.mjs';
import { syncCheck } from './gates.mjs';
import { lintGlobal, lintProject } from './lint.mjs';
import { scanSessions } from './sessions.mjs';
import { routeWorkspace, hasCenter } from './workspace.mjs';
import { stampTz } from './brief.mjs';
import { buildGuide, SETUP_STEPS } from './guide.mjs';
import { readRoles, resolveRole, ROLE_LABEL, sessionMeta } from './role.mjs';
import { listConsent } from './consent.mjs';
import { listProfiles } from './profile.mjs';

function guard(fn, fallback) {
  try { return fn(); } catch (e) { return { ...fallback, error: String(e && e.message ? e.message : e) }; }
}

/** 项目交接体检：_Project_Meta/<项目>/Handover.md。 */
function lintProjects(ws) {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(path.join(ws, '_Project_Meta')).sort(); } catch { return out; }
  for (const name of dirs) {
    const dir = path.join(ws, '_Project_Meta', name);
    try { if (!isDir(dir)) continue; } catch { continue; }
    const r = lintProject(path.join(dir, 'Handover.md'));
    out.push({ name, verdict: r.verdict, reasons: Array.isArray(r.reasons) ? r.reasons.slice(0, 5) : [] });
  }
  return out;
}

export function buildStatus(env, extra) {
  const info = extra || {};
  const ws = routeWorkspace(env);
  const found = hasCenter(ws);
  const warn = Math.round((env.cfg.warnRatio || 0.32) * 100);
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
        map[sid] = { role: String(e.role || ''), project: String(e.project || ''), task: String(e.task || ''), setAt: String(e.setAt || ''), bootstrappedAt: String(e.bootstrappedAt || '') };
      }
      return map;
    }, {}),
    consent: guard(() => listConsent(), []),
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
    return {
      global: { verdict: g.verdict, reasons: Array.isArray(g.reasons) ? g.reasons.slice(0, 5) : [] },
      projects,
      fail: projects.filter((p) => p.verdict === '不合格').length,
    };
  }, { global: { verdict: '读不到', reasons: [] }, projects: [], fail: 0 });

  out.sessions = guard(() => {
    const scan = scanSessions({
      dir: env.cacheDir(),
      meId: null,
      meCwd: null,
      warn,
      silentHours: env.cfg.sessionScanHours,
      projectsOnly: true,
    });
    const store = readRoles(env.cfg);
    const roleOf = (sid, cwd, firstPrompt, title) => {
      const meta = sessionMeta(sid);
      return resolveRole({ cfg: env.cfg, roles: store, sessionId: sid, cwd, firstPrompt, subagent: meta.subagent, title });
    };
    const wide = scanSessions({
      dir: env.cacheDir(), meId: null, meCwd: null, warn, silentHours: env.cfg.sessionScanHours, projectsOnly: false,
    });
    const all = wide.rows.filter((r) => r.kind === '平级').map((r) => {
      const meta = sessionMeta(r.sid);
      const info = roleOf(r.sid, meta.cwd, meta.firstPrompt, r.project);
      return {
        sid: r.sid,
        title: r.project === '-' ? '' : r.project,
        role: info.role,
        roleLabel: ROLE_LABEL[info.role] || info.role,
        source: info.source,
        project: info.project,
        task: info.task,
        pct: r.pct,
        state: r.state,
        active: r.mtime >= scan.cutoffMs,
        seen: stampTz(r.mtime),
      };
    });
    return {
      rows: scan.rows.slice(0, 60).map((r) => {
        const meta = sessionMeta(r.sid);
        const info = roleOf(r.sid, meta.cwd, meta.firstPrompt, r.project);
        return {
          sid: r.sid, project: r.project, pct: r.pct, state: r.state,
          role: info.role, roleLabel: ROLE_LABEL[info.role] || info.role,
          active: r.mtime >= scan.cutoffMs, seen: stampTz(r.mtime),
        };
      }),
      all,
      notify: scan.notify.map((r) => ({ sid: r.sid, project: r.project })),
      hot: scan.hot.length,
      unknown: scan.unknown.length,
      cutoff: stampTz(scan.cutoffMs),
      silentHours: scan.silentHours,
      verdict: scan.hot.length
        ? scan.hot.length + ' 个会话已进预警区（不低于 ' + warn + '%），应先收齐交接，再换会话'
        : '没有会话进入预警区。',
    };
  }, { rows: [], notify: [], hot: 0, unknown: 0 });

  // 设置页用：已接入工作区但没有全局会话时，给出补建入口。
  out.globalSessions = guard(() => {
    const all = (out.sessions && Array.isArray(out.sessions.all)) ? out.sessions.all : [];
    return all.filter((r) => r && r.role === 'global').length;
  }, 0);

  if (out.gate && !out.gate.ok && !out.gate.error) out.notes.push('通用约束条闸门未过：向对应项目会话派发，全局不代写项目库内文件。');
  if (out.handover && out.handover.fail) out.notes.push(out.handover.fail + ' 个项目交接体检不合格，交接前必须先补。');
  return out;
}