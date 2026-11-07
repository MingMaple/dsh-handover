/** ho_tokens —— token 体检（替代 token_probe/token_survey 的常用判据）。 */
import { textOutput } from '../lib/output.mjs';
import { nameOf } from '../lib/names.mjs';
import { NL, pick } from '../lib/text.mjs';
import { findLog, decodeLog, turnStarts } from '../lib/zstd-log.mjs';

function analyzeLog(records) {
  const turns = turnStarts(records).length;
  let steps = 0, outTok = 0, maxResult = 0, toolResults = 0;
  const perTurn = new Map();
  for (const r of records) {
    if (!r || !r.type) continue;
    if (r.type === 'step/start') {
      steps++;
      const t = pick(r, 'data', 'turn');
      if (typeof t === 'number') perTurn.set(t, (perTurn.get(t) || 0) + 1);
    } else if (r.type === 'assistant/message') {
      const u = pick(r, 'data', 'usage');
      if (u && typeof u.outputTokens === 'number') outTok += u.outputTokens;
    } else if (r.type === 'tool/result') {
      toolResults++;
      try { const len = JSON.stringify(pick(r, 'data') || '').length; if (len > maxResult) maxResult = len; } catch { /* ignore */ }
    }
  }
  const heavyTurns = Array.from(perTurn.values()).filter((n) => n > 20).length;
  return { turns, steps, outTok, maxResult, toolResults, heavyTurns, perStep: steps ? Math.round(outTok / steps) : 0 };
}

export function pmTokensTool(env) {
  return {
    name: nameOf('tokens'),
    description:
      '会话 token 体检：轮数、步数、每步 token、最贵单条返回。只读。',
    parameters: {
      type: 'object', additionalProperties: false, required: ['sessions'],
      properties: { sessions: { type: 'array', items: { type: 'string' }, description: '会话 id 列表' } },
    },
    output: textOutput(),
    async execute(args, exec) {
      const out = [];
      const list = Array.isArray(args.sessions) ? args.sessions.filter((s) => typeof s === 'string' && s.trim() !== '') : [];
      if (!list.length) throw new Error('sessions 不能为空（给会话 id 数组）');
      out.push('会话 轮 步 输出tok 每步tok 最贵返回 超20步轮 判定');
      for (const sid of list) {
        const full = sid.indexOf('session-') === 0 ? sid : 'session-' + sid;
        const log = findLog(full);
        if (!log) { out.push(sid + '  ERR 日志找不到'); continue; }
        const recs = decodeLog(log);
        if (!recs) { out.push(sid + '  ERR 日志解不出'); continue; }
        const m = analyzeLog(recs);
        const verdict = m.perStep > 2000 ? '偏贵（每步 >2k）' : m.heavyTurns > 0 ? '有超 20 步的轮' : '正常';
        out.push([sid.slice(-8), m.turns, m.steps, m.outTok, m.perStep, Math.round(m.maxResult / 1024) + 'KB', m.heavyTurns, verdict].join('  '));
      }
      return { text: out.join(NL) };
    },
  };
}