/**
 * 注入文本：纯函数，输入固定、输出固定，便于表格驱动单测。
 *
 * 3 类文本：
 *   1. 轮首压力画像一行；
 *   2. 到线提示（整理线与建议线同一句式，只改措辞）与强制线提示；
 *   3. 压缩后胶囊由 lib/capsule.mjs 渲染，本文件只提供换任与收益提示。
 */

const NL = String.fromCharCode(10);

function pct(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '未核';
  const n = Math.round(v * 1000) / 10;
  return (Number.isInteger(n) ? String(n) : n.toFixed(1)) + '%';
}

function kText(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '未核';
  return Math.round(v / 1000) + 'K';
}

/** 3 档线文本。 */
function bandText(bands) {
  const b = bands || {};
  return kText(b.soft) + '/' + kText(b.advise) + '/' + kText(b.hard);
}

/**
 * 压力画像一行：上下文、余量、近 3 轮增速与 3 档线。
 * 未知值写「未核」，不编造。
 */
export function pressureLineText(profile) {
  const p = profile || {};
  const win = typeof p.win === 'number' && Number.isFinite(p.win) && p.win > 0 ? p.win : null;
  const used = win !== null && typeof p.used === 'number' && Number.isFinite(p.used) ? p.used : null;
  const known = used !== null;
  const ratioOk = known && typeof p.ratio === 'number' && Number.isFinite(p.ratio);
  const head = known
    ? '上下文 ' + kText(used) + '/' + kText(win) + '（' + (ratioOk ? Math.round(p.ratio * 100) + '%' : '未核') + '）'
    : '上下文 未核';
  const headroom = known && typeof p.headroom === 'number' && Number.isFinite(p.headroom)
    ? '余 ' + kText(p.headroom)
    : '余 未核';
  const g = p.growth;
  const growthPart = typeof g === 'number' && Number.isFinite(g)
    ? '近3轮 ' + (g > 0 ? '+' : '') + kText(g) + '/轮'
    : '近3轮 未核';
  const bandPart = win !== null ? '线 ' + bandText(p.bands) : '线 未核/未核/未核';
  return head + '｜' + headroom + '｜' + growthPart + '｜' + bandPart;
}

/**
 * 到线提示：level 取 soft 或 advise。
 * @param {'soft'|'advise'} level
 * @param {{used?:number, win?:number, ratio?:number, bands?:object}} profile 压力画像
 */
export function tierPromptText(level, profile) {
  const p = profile || {};
  const head = '上下文 ' + kText(p.used) + '/' + kText(p.win) + '（' + pct(p.ratio) + '）。';
  const bands = '3 档 ' + bandText(p.bands) + '。';
  const call = level === 'advise'
    ? '已过建议线，建议尽快择机压缩。请将当前任务做到合适断点处后进行上下文压缩流程。按胶囊标准写：目标、已定方案、下一步、易错点、必须遵守的约束原文、需要保留的原文位置。再调用 ho_handover(action="compact", capsule=…)。'
    : '已过整理线，可择机压缩。请将当前任务做到合适断点处后进行上下文压缩流程。按胶囊标准写：目标、已定方案、下一步、易错点、必须遵守的约束原文、需要保留的原文位置。再调用 ho_handover(action="compact", capsule=…)。';
  const summary = '可压：边界已到；缓压：推导未落盘或有错在追。';
  return head + bands + call + summary;
}

/** 强制线提示：在强制压缩之前注入，含实际用量；强制线不要求助手先到断点。 */
export function hardPromptText(profile) {
  const p = profile || {};
  const bands = p.bands || {};
  return '上下文 ' + kText(p.used) + '/' + kText(p.win) + '（' + pct(p.ratio) + '），已到强制线 '
    + kText(bands.hard) + '。插件将立即执行压缩。';
}

/** 静态 rubric：fire 4 条、suppress 4 条，各一行，总长不超过 220 字。 */
export function rubricText() {
  return [
    '压缩 rubric（可压，满足任一且无缓压）：',
    '- 子任务闭环：该项完成、计划某节完成、构建或测试通过、提交完成。',
    '- 即将切换阶段：换模块、换文件群、换问题域。',
    '- 噪声不少于 30%，或单条不少于 8K 的工具结果已消费完。',
    '- 余量低于预计下一阶段增量。',
    '缓压（满足任一即延后）：',
    '- 多步推导未落盘，证据正在用。',
    '- 有未解决的错误正在追。',
    '- 上一条工具结果尚未消费。',
    '- 距上次压缩不足 3 轮，或水位低于整理线且非用户要求。',
  ].join(NL);
}

/**
 * 换任提示：助手压缩次数刚达上限时注入。
 * 此时不再写断点句，改为预告下次到线执行换任流程。
 */
export function successionPromptText(count, max, cfg) {
  const hardCap = Number(cfg && cfg.maxCompactionsHardCap) || 6;
  return '压缩计数已达 ' + count + '/' + max + '，助手入口与到线提示不再请求压缩。'
    + '强制线仍由插件兜底压缩至 ' + hardCap + ' 次。'
    + '下次到线将不再压缩，而是执行换任流程：'
    + 'ho_handover(action="rotate", text=…) 一步完成，'
    + '再请用户授权并调用 ho_sessions(action="succeed")'
    + '（授权方式：聊天框发送 /allow-reset，或在设置页点击「授权重置」）。';
}

/** 到线文本：压缩计数达助手上限后替换「请压缩」提示，要求先到断点再办换任。 */
export function successionBlockText(count, max, cfg) {
  const hardCap = Number(cfg && cfg.maxCompactionsHardCap) || 6;
  return '上下文已达分档线，压缩计数 ' + count + '/' + max + '：助手入口与提示不再请求压缩，'
    + '强制线仍兜底至 ' + hardCap + ' 次。'
    + '请将当前任务做到合适断点处后进行换任流程：'
    + 'ho_handover(action="rotate", text=…) 一步完成，'
    + '再请用户授权并调用 ho_sessions(action="succeed")（授权方式同上）。';
}

/** 到线文本：压缩计数达硬上限后注入，此后不再压缩；命令式，措辞最重。 */
export function successionCeilingText(count, hardCap) {
  return '压缩计数已达硬上限 ' + count + '/' + hardCap + '，此后不再压缩，强制线也不再兜底。'
    + '你必须立即把断点设在当前工作附近，尽快办理换任：'
    + 'ho_handover(action="rotate", text=…) 一步完成，'
    + '再请用户授权并调用 ho_sessions(action="succeed")（授权方式同上）。'
    + '继续推进只会让上下文继续上涨，且无法再压缩。';
}

/**
 * 全局换任通知：项目与杂项在发现全局换代时追加一行，带新任 session id。
 * 旧提示段里的全局 id 已不可用，本行同时给出替代值。
 */
export function rotationNoticeText(holder) {
  const h = holder || {};
  const name = h.name || '新任全局';
  const sid = h.sessionId ? '（' + h.sessionId + '）' : '';
  const since = h.since ? '，自 ' + h.since : '';
  return '全局已换任：' + name + sid + since + '。提示段里的全局 session id 作废，发消息按此 id。';
}

/** 收益偏低提示：连续 2 次低于下限时追加，要求立即换任。 */
export function roiAdviceText(roi, floor, streak) {
  return '连续 ' + streak + ' 次压缩缩减低于 ' + pct(floor) + '（最近 ' + pct(roi) + '）：'
    + '你必须尽快把断点设在当前工作附近，做到后立即进行换任流程，不要依靠反复压缩维持上下文。';
}
