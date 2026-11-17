/**
 * 锚点与快照操作：压缩前的锚点 patch、锚点写入、自动快照。
 * 纯函数为主，副作用仅留痕；依赖通过 runtime 注入（workspaceForSid、noteInline、env.log）。
 */
import { logRecordsOf, visibleTextOf } from './events.mjs';
import { deriveSegments } from './segments.mjs';
import { extractSnapshot } from './checkpoint.mjs';
import { anchorPathFor, mergeAnchor } from './anchor.mjs';
import { extractConstraints } from './constraints.mjs';

/** 创建锚点/快照操作集。runtime 提供 workspaceForSid、noteInline、log、cfg。 */
export function createAnchorOps(runtime) {
  const { workspaceForSid, noteInline, log, cfg } = runtime;
  const msgOf = (e) => String(e && e.message ? e.message : e);

  function autoSnapshotFor(sid) {
    try {
      const recs = logRecordsOf(sid) || [];
      const segs = deriveSegments(recs);
      const sinceSeq = segs.length
        ? segs[segs.length - 1].summarySeq
        : (recs.length > 150 ? recs[recs.length - 150].seq : -1);
      return extractSnapshot(recs, { sid, ws: workspaceForSid(sid), sinceSeq });
    } catch (e) {
      log('自动压缩快照失败（' + sid + '）：' + msgOf(e));
      return null;
    }
  }

  /** 锚点路径：会话目录内的 anchor.md；解析失败返回空串。 */
  function anchorFileFor(sid) {
    try { return anchorPathFor(sid); } catch { return ''; }
  }

  /** 取表面事件中的最近用户消息，跳过插件自身注入与子会话。 */
  function recentUserMessages(session, limit) {
    const nodes = session && session.surface ? session.surface.nodes || [] : [];
    const max = Number(limit) > 0 ? Math.floor(limit) : 20;
    const out = [];
    for (let i = nodes.length - 1; i >= 0 && out.length < max; i -= 1) {
      let event = null;
      try { event = session.eventAt ? session.eventAt(nodes[i]) : null; } catch { event = null; }
      if (!event || event.type !== 'user/message') continue;
      const src = event.data && event.data.source ? event.data.source : null;
      if (src && src.kind === 'dsh-handover') continue;
      const text = visibleTextOf(event).trim();
      if (!text) continue;
      out.unshift({ seq: nodes[i], text });
    }
    return out;
  }

  /** 本会话第一条用户消息：目标口径取它，避免后续追问覆盖原始目标。 */
  function firstUserMessage(session) {
    const nodes = session && session.surface ? session.surface.nodes || [] : [];
    for (const seq of nodes) {
      let event = null;
      try { event = session.eventAt ? session.eventAt(seq) : null; } catch { event = null; }
      if (!event || event.type !== 'user/message') continue;
      const src = event.data && event.data.source ? event.data.source : null;
      if (src && src.kind === 'dsh-handover') continue;
      const text = visibleTextOf(event).trim();
      if (text) return { seq, text };
    }
    return null;
  }

  /**
   * 压缩前锚点 patch：目标取首条用户消息首行，约束取规则抽取；
   * 最近一条用户消息与助手自述合并为状态，避免目标随追问漂移。
   */
  function anchorPatchFor(session, status) {
    const messages = recentUserMessages(session, 20);
    const first = firstUserMessage(session);
    const last = messages.length ? messages[messages.length - 1] : null;
    const goalLine = first ? String(first.text).split(String.fromCharCode(10))[0].trim() : '';
    const lastLine = last ? String(last.text).split(String.fromCharCode(10))[0].trim() : '';
    const constraints = extractConstraints(messages, { max: Number(cfg.constraintMax) || 8 });
    const patch = {
      goal: goalLine.length > 200 ? goalLine.slice(0, 200) : goalLine,
      constraints: constraints.map((c) => c.text),
    };
    const parts = [];
    if (lastLine) parts.push(lastLine.length > 80 ? lastLine.slice(0, 80) : lastLine);
    const text = typeof status === 'string' ? status.trim() : '';
    if (text) parts.push(text);
    if (parts.length) {
      const joined = parts.join('；');
      patch.status = joined.length > 200 ? joined.slice(0, 200) : joined;
    }
    return patch;
  }

  /** 写锚点：失败只留痕，不阻断压缩；胶囊降级为「目标未核」。 */
  function writeAnchorFor(sid, session, status) {
    const file = anchorFileFor(sid);
    if (!file) return { ok: false, path: '', sections: null, tokens: 0, overBudget: false };
    try {
      const saved = mergeAnchor(sid, anchorPatchFor(session, status), cfg);
      if (saved.overBudget) {
        noteInline('anchor over budget ' + sid + ' tokens=' + saved.tokens
          + ' limit=' + (Number(cfg.anchorMaxTokens) || 1500));
      }
      return { ok: true, path: saved.path, sections: saved.sections, tokens: saved.tokens, overBudget: saved.overBudget };
    } catch (e) {
      noteInline('anchor write failed ' + sid + ': ' + msgOf(e));
      return { ok: false, path: file, sections: null, tokens: 0, overBudget: false };
    }
  }

  /** 压缩后表面可见文本，供约束探针核对。 */
  function surfaceTextsOf(session) {
    const nodes = session && session.surface ? session.surface.nodes || [] : [];
    const out = [];
    for (const seq of nodes) {
      let event = null;
      try { event = session.eventAt(seq); } catch { event = null; }
      if (!event) continue;
      const text = visibleTextOf(event);
      if (text) out.push(text);
    }
    return out;
  }

  return { autoSnapshotFor, anchorFileFor, recentUserMessages, firstUserMessage, anchorPatchFor, writeAnchorFor, surfaceTextsOf };
}
