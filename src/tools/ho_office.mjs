/** ho_office —— 在任登记表：查某条类别现在由哪个会话在任（只读）。 */
import { textOutput } from '../lib/output.mjs';
import { nameOf } from '../lib/names.mjs';
import { NL } from '../lib/text.mjs';
import { loadOffice, resolveOffice, rowsOf, formatRow, officePath } from '../lib/office.mjs';

export function pmOfficeTool(env) {
  return {
    name: nameOf('office'),
    description:
      '查在任：输入「全局」「全局3」「项目名」等，返回现任会话的名字与 id；多个用空格分隔，留空列全部。只读。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '要查的名字，如「全局」「全局3」「Mingent」「抢名额脚本」；多个用空格或逗号分隔；留空＝列出全部在任' },
        json: { type: 'boolean', description: 'true 时输出机器可读 JSON（供脚本解析）' },
      },
    },
    output: textOutput(),
    async execute(args, exec) {
      const ws = env.resolveWs(exec);
      if (!ws) return { text: '无法确定工作区根，读不到在任登记表。' };
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
