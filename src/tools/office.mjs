/** 在任登记实现 —— 查在任与首次注册名称。经 ho_sessions 的 office-read、office-register 动作暴露。 */
import { textOutput } from '../lib/output.mjs';
import { nameOf } from '../lib/names.mjs';
import { NL } from '../lib/text.mjs';
import { loadOffice, resolveOffice, rowsOf, formatRow, officePath, registerHolder, lineageKeyOf } from '../lib/office.mjs';

function validDisplayName(name) {
  const s = String(name || '').trim();
  if (!s) return '现象：注册名为空。原因：在任登记要求唯一显示名。处置：传入 1 至 40 个字符的注册名。';
  if (s.length > 40) return '现象：注册名超过 40 个字符。原因：显示名长度上限为 40 个字符。处置：缩短后重试。';
  if (/[\\/:*?"<>|\r\n]/.test(s)) return '现象：注册名含路径分隔符或换行符。原因：显示名不得含路径分隔符与控制字符。处置：删除上述字符后重试。';
  return '';
}

/**
 * 构造 `office` 工具定义。
 *
 * 注册名一经写入即固定，改名只由全局会话处理，避免多个会话争用同一类别。
 *
 * @param {object} env 插件环境，提供 `resolveWs`、`selfId` 与 `roleOf`。
 * @returns {object} 工具定义，供宿主注册。
 * 副作用：首次注册时写入在任登记表。
 */
export function pmOfficeTool(env) {
  return {
    name: nameOf('office'),
    description:
      '在任登记：查询在任会话，或由本会话首次注册自身名称。注册后不得自行修改名称。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['read', 'register'], description: '动作。缺省 `read`；`register` 为首次注册名称。' },
        name: { type: 'string', description: '`action=register` 时的注册名，不超过 40 个字符，不含路径分隔符。例：`Demo1`。' },
        query: { type: 'string', description: '要查的名称，例如「全局」「全局3」「Demo1」。多个名称用空格或逗号分隔；留空时列出全部在任会话。' },
        json: { type: 'boolean', description: '为 `true` 时输出机器可读 JSON，供脚本解析。' },
      },
    },
    output: textOutput(),
    async execute(args, exec) {
      const ws = env.resolveWs(exec);
      if (!ws) return { text: '现象：未找到工作区根。原因：本实例尚未接入工作区。处置：先在设置页接入工作区，再重试。' };
      const action = typeof args.action === 'string' && args.action ? args.action : 'read';
      if (action === 'register') {
        const meId = String(env.selfId(exec) || '');
        if (!meId) throw new Error('现象：未取得本会话 id。原因：宿主未提供会话标识。处置：重启 DSH 后重试注册。');
        let info = null;
        try { info = env.roleOf(exec); } catch { info = null; }
        const role = info && info.role ? info.role : 'plain';
        if (role !== 'project' && role !== 'misc' && role !== 'global') {
          throw new Error('现象：本会话为普通会话，没有注册名。原因：在任登记只对全局、项目与杂项会话开放。处置：先在设置页设定项目或杂项角色，再注册。');
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
          throw new Error('现象：类别「' + key + '」已有在任会话 ' + (cur.name || '') + '（' + cur.sessionId + '）。原因：同一类别同时只允许一个在任会话。处置：由全局会话先处理该在任会话，再重试。');
        }
        if (cur && String(cur.sessionId) === meId) {
          if (String(cur.name || '') === name) return { text: '已注册：' + name + '（' + key + '）。注册后不得自行修改。' };
          throw new Error('现象：本会话已注册为「' + cur.name + '」，注册名不可自行修改。原因：注册名一经写入即固定。处置：改名由全局会话处理。');
        }
        const reg = registerHolder(ws, { kind, project, task, name, sessionId: meId });
        try { if (typeof env.refreshPromptFor === 'function') env.refreshPromptFor(meId); } catch { /* 重装失败不影响注册 */ }
        return { text: '已注册：' + name + '（' + reg.key + '，会话 ' + meId + '）。注册后不得自行修改；改名由全局会话处理。' };
      }
      const store = loadOffice(ws);
      const rows = rowsOf(store);
      if (!rows.length) {
        return { text: '在任登记表为空（`' + officePath(ws) + '`）。处置：先登记一次在任会话，再查询。' };
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
        if (r.vacant) { out.push(t + '  — 类别「' + r.key + '」当前空缺，无人在任。'); continue; }
        const row = { key: r.key, kind: r.lineage.kind, project: r.lineage.project, task: r.lineage.task, current: r.lineage.current };
        out.push(formatRow(row, t));
        hits.push({ askedAs: t, via: r.via, key: r.key, kind: r.lineage.kind, name: r.lineage.current.name, sessionId: r.lineage.current.sessionId });
      }
      if (args.json) return { text: JSON.stringify({ updatedAt: store.updatedAt || '', hits, lines: out }, null, 2) };
      return { text: out.join(NL) };
    },
  };
}
