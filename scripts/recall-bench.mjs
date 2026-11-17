/**
 * 检索验收：对真实会话日志生成已知答案查询，统计前 3 命中率、指针回读一致率与空结果建议率。
 * 用法：node scripts/recall-bench.mjs --corpus <语料目录> [--queries 6]
 * 语料目录内放 session-*.jsonl.zstd（多帧 zstd 日志）。语料只在本机使用，验收后删除。
 */
import fs from 'node:fs';
import path from 'node:path';
import { decodeLog } from '../src/lib/zstd-log.mjs';
import { visibleTextOf } from '../src/lib/events.mjs';
import { deriveSegments } from '../src/lib/segments.mjs';
import { search } from '../src/lib/recall.mjs';

function argOf(flag, dflt) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const corpusDir = path.resolve(argOf('--corpus', ''));
const wantQueries = Number(argOf('--queries', 6));
if (!argOf('--corpus', '')) {
  console.log('用法：node scripts/recall-bench.mjs --corpus <语料目录> [--queries 6]');
  process.exit(2);
}
if (!fs.existsSync(corpusDir)) {
  console.log('语料目录不存在：' + corpusDir);
  process.exit(2);
}

const files = fs.readdirSync(corpusDir).filter((n) => n.endsWith('.jsonl.zstd')).sort();
if (!files.length) {
  console.log('语料目录内没有 *.jsonl.zstd：' + corpusDir);
  process.exit(2);
}

function countOf(hay, needle) {
  let n = 0;
  let from = 0;
  for (;;) {
    const at = hay.indexOf(needle, from);
    if (at === -1) return n;
    n++;
    from = at + needle.length;
  }
}

/** 取唯一短句：在整份日志中只出现一次，保证答案确定。 */
function uniquePhrase(records, text, allText) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  for (let start = 0; start + 8 <= flat.length && start < 200; start += 4) {
    const window = flat.slice(start, start + 8);
    if (!/[\u4e00-\u9fa5A-Za-z]/.test(window)) continue;
    if (/[\\/:*?"<>|]/.test(window)) continue;
    if (countOf(allText, window.toLowerCase()) === 1) return window;
  }
  return '';
}

const rows = [];
const metrics = {
  literal: { total: 0, top3: 0 },
  bm25: { total: 0, top3: 0 },
  readback: { total: 0, ok: 0 },
  empty: { total: 0, ok: 0 },
};

for (const name of files) {
  const file = path.join(corpusDir, name);
  const records = decodeLog(file) || [];
  const allText = records.map((r) => visibleTextOf(r)).join(String.fromCharCode(10)).toLowerCase();
  const segments = deriveSegments(records);
  const users = records.filter((r) => r && r.type === 'user/message' && typeof r.seq === 'number');
  const picks = [];
  const step = Math.max(1, Math.floor(users.length / (wantQueries * 2)));
  for (let i = 0; i < users.length && picks.length < wantQueries; i += step) {
    const phrase = uniquePhrase(records, visibleTextOf(users[i]), allText);
    if (!phrase) continue;
    picks.push({ phrase, seq: users[i].seq });
  }
  let litHit = 0;
  let bmHit = 0;
  for (const p of picks) {
    const lit = search(records, { query: p.phrase, mode: 'literal', limit: 10, order: 'relevance' });
    const bm = search(records, { query: p.phrase, mode: 'bm25', limit: 10, order: 'relevance' });
    const litRank = lit.hits.findIndex((h) => h.seq === p.seq) + 1;
    const bmRank = bm.hits.findIndex((h) => h.seq === p.seq) + 1;
    metrics.literal.total++;
    metrics.bm25.total++;
    if (litRank > 0 && litRank <= 3) { litHit++; metrics.literal.top3++; }
    if (bmRank > 0 && bmRank <= 3) { bmHit++; metrics.bm25.top3++; }
    for (const res of [lit, bm]) {
      const hit = res.hits.find((h) => h.seq === p.seq);
      if (!hit) continue;
      const got = hit.excerpt.lines.map((l) => l.text).join(' ').toLowerCase();
      metrics.readback.total++;
      if (got.indexOf(p.phrase.toLowerCase()) !== -1) metrics.readback.ok++;
    }
    const at = records.find((r) => r.seq === p.seq);
    metrics.readback.total++;
    if (visibleTextOf(at).toLowerCase().indexOf(p.phrase.toLowerCase()) !== -1) metrics.readback.ok++;
  }
  const empty = search(records, { query: 'zzzqqq_no_such_token_9182', mode: 'literal' });
  metrics.empty.total++;
  if (empty.total === 0 && empty.suggestion && empty.suggestion.keywords.length > 0) metrics.empty.ok++;
  rows.push({
    name,
    events: records.length,
    segments: segments.length,
    queries: picks.length,
    literal: picks.length ? (litHit / picks.length * 100).toFixed(1) + '%' : '-',
    bm25: picks.length ? (bmHit / picks.length * 100).toFixed(1) + '%' : '-',
    empty: empty.suggestion ? '有建议' : '无建议',
  });
}

const pct = (m) => (m.total ? (m.top3 / m.total * 100).toFixed(1) + '%' : '-');
const ratio = (m) => (m.total ? m.ok / m.total : 1);

console.log('检索验收（前 3 命中、回读一致、空结果建议）');
for (const r of rows) {
  console.log('  ' + r.name.slice(0, 40).padEnd(42) + ' 事件 ' + String(r.events).padStart(6)
    + ' · 段 ' + r.segments + ' · 查询 ' + r.queries + ' · 字面 ' + r.literal + ' · 分词 ' + r.bm25 + ' · 空结果 ' + r.empty);
}
const top3 = (metrics.literal.top3 + metrics.bm25.top3) / (metrics.literal.total + metrics.bm25.total);
console.log('');
console.log('字面前 3 命中率 ' + pct(metrics.literal) + '（' + metrics.literal.top3 + '/' + metrics.literal.total + '）');
console.log('分词前 3 命中率 ' + pct(metrics.bm25) + '（' + metrics.bm25.top3 + '/' + metrics.bm25.total + '）');
console.log('合并前 3 命中率 ' + (top3 * 100).toFixed(1) + '%');
console.log('指针回读一致率 ' + (ratio(metrics.readback) * 100).toFixed(1) + '%（' + metrics.readback.ok + '/' + metrics.readback.total + '）');
console.log('空结果带建议率 ' + (ratio(metrics.empty) * 100).toFixed(1) + '%（' + metrics.empty.ok + '/' + metrics.empty.total + '）');
console.log('');
console.log('语料只在本机使用；验收后按用户确认删除，不进入发布包。');

const okTop3 = top3 >= 0.9;
const okBack = ratio(metrics.readback) >= 1;
const okEmpty = ratio(metrics.empty) >= 1;
if (!okTop3 || !okBack || !okEmpty) {
  console.log('RECALL BENCH FAIL：' + [
    okTop3 ? '' : '前 3 命中率低于 90%',
    okBack ? '' : '回读一致率低于 100%',
    okEmpty ? '' : '空结果建议率低于 100%',
  ].filter(Boolean).join('；'));
  process.exit(1);
}
console.log('RECALL BENCH OK（前 3 命中不低于 90%，回读一致 100%，空结果建议 100%）');
