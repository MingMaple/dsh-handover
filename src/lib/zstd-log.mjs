/** DSH 会话日志：定位 + 多帧 zstd 解码（坏帧跳过）。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

export function logsRoot() {
  return path.join(os.homedir(), '.dsh', 'sessions');
}

/** 在 ~/.dsh/sessions 下找 <sid>/session.v4.jsonl.zstd（深度 ≤3）。 */
export function findLog(sid, root) {
  let hit = null;
  const base = root || logsRoot();
  const walk = (dir, depth) => {
    if (hit || depth > 3) return;
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      const p = path.join(dir, e.name);
      if (e.name === sid) {
        const f = path.join(p, 'session.v4.jsonl.zstd');
        if (fs.existsSync(f)) { hit = f; return; }
      }
      walk(p, depth + 1);
    }
  };
  walk(base, 0);
  return hit;
}

/** 解码多帧 zstd 日志，返回事件数组（坏帧跳过）。 */
export function decodeLog(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch { return null; }
  const starts = [];
  let i = 0;
  while (true) { const j = buf.indexOf(MAGIC, i); if (j < 0) break; starts.push(j); i = j + 4; }
  if (!starts.length) return null;
  starts.push(buf.length);
  let text = "";
  for (let k = 0; k < starts.length - 1; k++) {
    try { text += zlib.zstdDecompressSync(buf.subarray(starts[k], starts[k + 1])).toString("utf8"); } catch { /* 坏帧 */ }
  }
  const out = [];
  for (const line of text.split(String.fromCharCode(10))) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* 非 JSON 行 */ }
  }
  return out;
}

/** 取 turn/start 事件的时间戳序列（按时间排序）。 */
export function turnStarts(records) {
  const starts = [];
  for (const r of records) {
    if (!r || r.type !== "turn/start") continue;
    const turn = r.data && typeof r.data.turn === "number" ? r.data.turn : null;
    if (turn !== null && typeof r.time === "number") starts.push({ turn, time: r.time });
  }
  return starts.sort((a, b) => a.time - b.time);
}