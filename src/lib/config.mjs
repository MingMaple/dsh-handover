/** dsh-handover 配置：全部可被 profile patch 的 config 覆盖。 */
export const DEFAULTS = {
  workspaceRoot: '',            // 留空则从会话 cwd 推导：向上查找 _Control_Center 目录
  maxCompactionsPerSession: 4,  // 助手压缩次数上限：达到后助手入口与到线提示关闭，强制线仍兜底
  maxCompactionsHardCap: 6,     // 压缩硬上限：达到后连强制线也不再压缩，只能换任
  hostSummaryRatio: 0.80,       // 宿主压缩引擎默认阈值，只读观测，不参与判定
  // 压力遥测：可用窗口 = 窗口 − 预留输出。分档默认按可用窗口纯比例，不设绝对上限。
  budgetMode: 'ratio',          // ratio（默认）按窗口纯比例；absolute 才只用下面的绝对预算
  budgetSoft: 80000,            // 绝对整理线：窗口读不到或 budgetMode=absolute 时使用
  budgetAdvise: 120000,         // 绝对建议线：窗口读不到或 budgetMode=absolute 时使用
  budgetHard: 180000,           // 绝对强制线：窗口读不到或 budgetMode=absolute 时使用
  reservedOutput: 13000,        // 预留输出，计算可用窗口时扣除
  softRatio: 0.35,              // 整理线：可用窗口比例（不再与绝对预算取小）
  adviseRatio: 0.50,            // 建议线：可用窗口比例（不再与绝对预算取小）
  hardRatioCap: 0.65,           // 强制线：可用窗口比例（不再与绝对预算取小）
  triggerCooldownMs: 300000,    // 自触发冷却：压缩完成后 5 分钟内不再判定
  retainTokens: 20000,          // 轮内压缩保留尾部的参考值（新范围选择改用 keepMinMessages 与 minKeepTokens）
  shadowTarget: 0.55,           // auto 模式的遮蔽比
  keepMinMessages: 20,          // 保留尾部至少覆盖最近多少条表面消息
  minKeepTokens: 8000,          // 保留尾部 token 下限
  boundaryCompact: true,        // 允许在阶段边界压缩
  roiFloor: 0.30,               // 压缩收益下限：连续低于此值即建议换任
  anchorMaxTokens: 1500,       // 锚点总长参考上限（超限只报告，不裁剪）
  capsuleMaxChars: 1600,       // 胶囊参考字数上限（超限只报告，不裁剪）
  constraintMax: 8,             // 会话约束条数上限
  pureWindowRatio: 0.40,       // 纯窗口线：繁重任务预计超过 40% 时引入子智能体
  backfillMergeMs: 300000,     // 回填合并窗口：5 分钟
  snapshotMinGapMs: 60000,     // 微快照最小间隔，避免同一批事件反复落盘
  bypassModel: false,          // 旁路语义摘要：默认关闭
  bypassModelMaxChars: 200,    // 旁路摘要字数上限
  recallLimit: 8,              // ho_status(view="recall") 默认返回条数
  autoResume: true,
  sessionScanHours: 12,
  // 留空 = 按会话角色解析：全局取 records/Global_Handover.md，项目取 _Project_Meta/<项目>/Handover.md，
  // 杂项取 _Misc/tasks/<任务>/Handover.md。非空则强制该路径，供演练使用。
  handoverPath: '',
  rolesPath: '',           // 留空 = ~/.dsh/storages/dsh-handover.roles.json
  // 续跑提示：{n} {handover} {role} 会被替换成真值；{handover} 是本会话自己的交接绝对路径。
  // 只在助手登记压缩时选 resume=continue（默认）才投递；resume=wait 表示已收尾，不唤醒。
  resumePrompt: [
    '【dsh-handover 自动续跑·第 {n} 次压缩】压缩已完成，历史已由摘要替换。',
    '按以下顺序执行：',
    '1. 调用 ho_handover(action=read)，取回本会话交接（{handover}）。',
    '2. 调用 ho_docmap(action="plan-read")，读取行动计划；未建立计划时跳过本步。',
    '3. 按交接 §2 与行动计划继续执行；§2 无待办时，向当前用户作一句总结后收尾并停止。',
    '约束：不复述交接内容；不重做已完成事项。',
    '完整流程：ho_docmap(action="rules-read", doc="runtime")。',
  ].join(String.fromCharCode(10)),
  resumePromptUnknown: [
    '【dsh-handover 自动续跑·第 {n} 次压缩】压缩已完成，历史已由摘要替换。',
    '本会话为普通会话，不参与交接；如需继续，由全局会话为其指定角色。',
  ].join(String.fromCharCode(10)),
  compactTimeoutMs: 120000,
  compactAttempts: 3,
  waitIdleMs: 180000,      // 等会话空闲的上限（超过就放弃并回告）
  driftSlack: 3,           // Δ交接容忍轮数（超过即需刷交接）
  wakeAuthority: 'on',     // 会话守卫硬拦：on / off（off＝连 peer 的 new 动作也不拦）
  directPeer: 'on',        // 会话之间直接 peer（action="send"）：on 允许（不经全局转述）；off 退回「只能向全局报告」的旧口径
  roleGating: 'on',        // 按角色裁剪工具与提示段：on / off（off＝所有会话都看得见全部工具）
  reuseCheck: true,        // 建新会话前查在任会话水位（未到整理线拒绝，建议复用）
  prepackMinAgeMin: 90,    // 打包前要求会话静止分钟数
  packFormat: 'auto',      // 归档格式：auto（有 7-Zip 用 7z，否则内置 tar.gz）、7z、tar
  sevenZipPath: '',        // 留空则自动探测：常见安装位置（Windows、macOS、Linux）与 PATH 上的 7z
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
