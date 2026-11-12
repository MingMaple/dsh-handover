/** dsh-handover 配置：全部可被 profile patch 的 config 覆盖。 */
export const DEFAULTS = {
  workspaceRoot: '',            // 留空则从会话 cwd 推导（向上找 _Control_Center 目录）
  warnRatio: 0.32,
  handoverRatio: 0.35,
  hardRatio: 0.85,
  maxCompactions: 3,
  autoResume: true,
  sessionScanHours: 12,
  handoverPath: '',        // 留空 = 按会话角色解析（全局 records/Global_Handover.md；项目 _Project_Meta/<项目>/Handover.md；杂项 _Misc/tasks/<任务>/Handover.md）。非空则强制该路径（演练用）
  rolesPath: '',           // 留空 = ~/.dsh/storages/dsh-handover.roles.json
  // 续跑提示：{n} {max} {handover} {role} 会被替换成真值；{handover} 是本会话自己的交接绝对路径。
  // 只在助手登记压缩时选 resume=continue（默认）才投递；resume=wait 表示已收尾，不唤醒。
  resumePrompt: '【dsh-handover 自动续跑·第 {n}/{max} 次压缩】压缩已完成，历史已被摘要替换。第一步：ho_handover(action=read) 取回本会话的交接（{handover}）；然后按 §2「下一步」继续（若 §2 已无待办，向当前用户一句话收尾并停止）。不要复述交接内容，不要重做已完成的事。完整流程：ho_charter(doc="runtime")。',
  resumePromptUnknown: '【dsh-handover 自动续跑·第 {n}/{max} 次压缩】压缩已完成，历史已被摘要替换。本会话是普通会话，不参与交接；如需继续，请由全局会话为其指定角色。',
  compactTimeoutMs: 120000,
  compactAttempts: 3,
  waitIdleMs: 180000,      // 等会话空闲的上限（超过就放弃并回告）
  driftSlack: 3,           // Δ交接容忍轮数（超过即需刷交接）
  wakeAuthority: 'on',     // 会话守卫硬拦：on / off（off＝连 peer 的 new 动作也不拦）
  directPeer: 'on',        // 会话之间直接 peer（action="send"）：on 允许（不经全局转述）；off 退回「只能向全局报告」的旧口径
  roleGating: 'on',        // 按角色裁剪工具与提示段：on / off（off＝所有会话都看得见全部工具）
  reuseCheck: true,        // 建新会话前查在任会话水位（低于 warnRatio 拒绝）
  prepackMinAgeMin: 90,    // 打包前要求会话静止分钟数
  packFormat: 'auto',      // 归档格式：auto（有 7-Zip 用 7z，否则内置 tar.gz）、7z、tar
  sevenZipPath: '',        // 留空则自动探测 C:\Program Files\7-Zip\7z.exe
};

export function resolveConfig(raw) {
  const out = { ...DEFAULTS };
  if (raw && typeof raw === "object") {
    for (const k of Object.keys(DEFAULTS)) {
      if (raw[k] !== undefined && raw[k] !== null) out[k] = raw[k];
    }
  }
  return out;
}
