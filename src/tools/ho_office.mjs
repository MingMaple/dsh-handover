/** ho_office —— 在任登记表：查在任；也用于会话首次注册自己的名字。 */
import { textOutput } from '../lib/output.mjs';
import { nameOf } from '../lib/names.mjs';
import { NL } from '../lib/text.mjs';
import { loadOffice, resolveOffice, rowsOf, formatRow, officePath, registerHolder, lineageKeyOf } from '../lib/office.mjs';

function validDisplayName(name) {
  const s = String(name || '').trim();
  if (!s) return '名字不能为空';
  if (s.length > 40) return '名字不超过 40 个字符';
  if (/[\\/:*?"<>|\r\n]/.test(s)) return '名字不能含路径分隔符或换行';
  return '';
}

export function pmOfficeTool(env) {
  return {
    name: nameOf('office'),
    description:
      '在任登记：query 查现任（默认）；action=register 由本会话首次注册自己的名字，注册后不得自行修改。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['read', 'register'], description: '缺省 read；register 首次注册名字' },
        name: { type: 'string', description: 'action=register 时的注册名（≤40 字，不含路径分隔符）' },
        query: { type: 'string', description: '要查的名字，如「全局」「全局3」「Demo1」「示例任务」；多个用空格或逗号分隔；留空＝列出全部在任' },
        json: { type: 'boolean', description: 'true 时输出机器可读 JSON（供脚本解析）' },
      },
    },
    output: textOutput(),
    async execute(args, exec) {
      const ws = env.resolveWs(exec);
      if (!ws) return { text: '无法确定工作区根，读不到在任登记表。' };
      const action = typeof args.action === 'string' && args.action ? args.action : 'read';
      if (action === 'register') {
        const meId = String(env.selfId(exec) || '');
        if (!meId) throw new Error('无法获取本会话 id，不能注册');
        let info = null;
        try { info = env.roleOf(exec); } catch { info = null; }
        const role = info && info.role ? info.role : 'plain';
        if (role !== 'project' && role !== 'misc' && role !== 'global') {
          throw new Error('普通会话没有注册名；先在设置页设定项目或杂项角色');
        }
        const name = String(args.name || '').trim();
        const bad = validDisplayName(name);
        if (bad) throw new Error(bad);
        const kind = role;
        const project = role === 'project' ? String(info.project || '') : '';
        const task = role === 'misc' ? String(info.task || '') : '';
        const key = lineageKeyOf(kind, project, task);
        const store = loadOffice(ws);
        const lin = store.lineages[key];
        const cur = lin && lin.current;
        if (cur && cur.sessionId && String(cur.sessionId) !== meId) {
          throw new Error('类别「' + key + '」已有在任会话：' + (cur.name || '') + '（' + cur.sessionId + '）。不得抢注；先由全局处理现任。');
        }
        if (cur && String(cur.sessionId) === meId) {
          if (String(cur.name || '') === name) return { text: '已注册：' + name + '（' + key + '）。注册后不得自行修改。' };
          throw new Error('本会话已注册为「' + cur.name + '」，注册后不得自行修改；改名须找全局。');
        }
        const reg = registerHolder(ws, { kind, project, task, name, sessionId: meId });
        try { if (typeof env.refreshPromptFor === 'function') env.refreshPromptFor(meId); } catch { /* 重装失败不影响注册 */ }
        return { text: '已注册：' + name + '（' + reg.key + '，会话 ' + meId + '）。注册后不得自行修改；改名须找全局。' };
      }
      const store = loadOffice(ws);
      const rows = rowsOf(store);
      if (!rows.length) {
        return { text: '在任登记表还是空的（' + officePath(ws) + '）：先登记一次在任会话，再查。' };
      }
      const raw = String(args.query || '').trim();
      const tokens = raw ? raw.split(/[\s,，、;；]+/).filter(Boolean) : [];
      if (!tokens.length) {
        if (args.json) return { text: JSON.stringify({ updatedAt: store.updatedAt || '', rows }, null, 2) };
        const out = [];
        let lastKind = '';
        for (const r of rows) {
          if (r.kind !== lastKind) {
            if (out.length) out.push('');
            out.push('【' + (r.kind === 'global' ? '全局' : r.kind === 'project' ? '项目' : r.kind === 'misc' ? '杂项' : r.kind) + '】');
            lastKind = r.kind;
          }
          out.push(formatRow(r));
        }
        return { text: out.join(NL) };
      }
      const out = [];
      const hits = [];
      for (const t of tokens) {
        const r = resolveOffice(store, t);
        if (!r.ok) { out.push(t + '  — ' + r.reason); continue; }
        if (r.vacant) { out.push(t + '  — 类别「' + r.key + '」当前空缺（无人在任）'); continue; }
        const row = { key: r.key, kind: r.lineage.kind, project: r.lineage.project, task: r.lineage.task, current: r.lineage.current };
        out.push(formatRow(row, t));
        hits.push({ askedAs: t, via: r.via, key: r.key, kind: r.lineage.kind, name: r.lineage.current.name, sessionId: r.lineage.current.sessionId });
      }
      if (args.json) return { text: JSON.stringify({ updatedAt: store.updatedAt || '', hits, lines: out }, null, 2) };
      return { text: out.join(NL) };
    },
  };
}
