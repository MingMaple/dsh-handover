/** 起始简报：水位、闸门、活跃与沉默、预警、阶段与提示，一行一字段。 */
import { driftVerdict } from './drift.mjs';

function pad2(n) { return n < 10 ? "0" + n : "" + n; }

export function stamp(ms) {
  const d = new Date(ms);
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
}

/** 带时区偏移的时间戳（硬规定：对用户可见的时间一律带偏移，例 2026-10-23 21:40 +0800）。 */
export function stampTz(ms) {
  const d = new Date(ms);
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const a = Math.abs(off);
  return stamp(ms) + " " + sign + pad2(Math.floor(a / 60)) + pad2(a % 60);
}

/** 会话短号：去掉 session- 前缀后取末 8 位。 */
function sidShort(sid) {
  const s = sid.indexOf('session-') === 0 ? sid.slice(8) : sid;
  return s.slice(0, 8);
}

function thousands(n) {
  const s = String(n);
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ",";
    out += s[i];
  }
  return out;
}

export function composeBrief(input) {
  const out = [];
  const cfg = input.cfg || {};
  out.push('== 起始简报 ' + stamp(Date.now()) + ' ==');
  if (input.selfUsed === null || input.selfWin === null) {
    out.push('水位   无法读取，需人工判断');
  } else {
    const pct = (input.selfUsed / input.selfWin) * 100;
    const warn = cfg.warnRatio === undefined ? 0.32 : cfg.warnRatio;
    out.push("水位   " + pct.toFixed(1) + "%（" + thousands(input.selfUsed) + " / " + thousands(input.selfWin) + "）→ " + (pct >= warn * 100 ? "已过阈值，该写交接" : "可继续"));
  }
  const gate = input.gate;
  if (!gate || gate.error) {
    out.push('闸门   ' + (gate && gate.error ? gate.error : '读不到') + ' · 退出码 ? · ?');
    if (gate && gate.noWorkspace) out.push('       首次安装？把工作区接入即可：ho_workspace(action="create", path="<绝对目录>", title="全局")，再开一个标题含「全局」的会话。');
  } else {
    out.push("闸门   " + gate.total + " 库 · 正文 " + gate.bodyLines + " 行 · 退出码 " + (gate.ok ? 0 : 10) + " · 判定：" + gate.verdict);
  }
  const scan = input.scan;
  if (!scan) {
    out.push('活跃   读不到（投影缓存目录不可用）');
  } else {
    const notifProjects = new Set(scan.notify.map((r) => r.project));
    const skipProjects = new Set(scan.skip.map((r) => r.project));
    out.push("活跃   " + notifProjects.size + " 个项目，需要通知 " + scan.notify.length + " 个会话：" + (scan.notify.length ? scan.notify.map((r) => r.project + "(" + sidShort(r.sid) + ",在任)").join("、") : "无"));
    out.push("沉默   " + skipProjects.size + " 个项目，跳过 " + scan.skip.length + " 个会话（不唤醒，省 token）");
    if (scan.hot.length) out.push("预警   " + scan.hot.length + " 个会话已进预警区（≥" + Math.round(scan.warn) + "%）—— 全为退场、前任则可忽略");
  }
  if (input.drift) {
    out.push('Δ交接  ' + driftVerdict(input.drift));
    const stale = input.drift.rows.filter((r) => r.verdict === '需刷交接');
    if (stale.length) out.push('        需刷：' + stale.map((r) => r.project + '(' + sidShort(r.sid) + ')').join('、'));
  } else {
    out.push('Δ交接  读不到（会话日志不可用）');
  }
  if (input.advice && input.advice.text) out.push('阶段   ' + input.advice.text);
  out.push('提示   ' + (input.ok ? '按「活跃」名单逐个用 peer（action="send"）广播本会话 id 并记回 §3；可正常开始作业' : '本会话已过阈值或闸门异常，应先收齐交接，再开展新任务'));
  return out;
}