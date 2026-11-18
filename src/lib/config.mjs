/** dsh-handover 配置：全部可被 profile patch 的 config 覆盖。 */
export const DEFAULTS = {
  workspaceRoot: '',            // 留空则从会话 cwd 推导：向上查找 _Control_Center 目录
  maxCompactionsPerSession: 4,  // 助手压缩次数上限：达到后助手入口与到线提示关闭，强制线仍兜底
  maxCompactionsHardCap: 6,     // 压缩硬上限：达到后连强制线也不再压缩，只能换任
  hostSummaryRatio: 0.80,       // 宿主压缩引擎默认阈值，只读观测，不参与判定
  // 压力遥测：3 档直接按当前窗口比例计算；窗口读不到（非有效正数/为空）时不判定。
  reservedOutput: 13000,        // 预留输出，只用于余量展示，不参与分档计算
  softRatio: 0.35,              // 整理线：当前窗口比例
  adviseRatio: 0.50,            // 建议线：当前窗口比例
  hardRatioCap: 0.65,           // 强制线：当前窗口比例
  triggerCooldownMs: 300000,    // 自触发冷却：压缩完成后 5 分钟内不再判定
  summaryQuietMs: 120000,       // summary 静默期：摘要后 2 分钟内不再判定（D-124）
  shadowTarget: 0.55,           // auto 模式的遮蔽比
  keepMinMessages: 20,          // 保留尾部至少覆盖最近多少条表面消息
  minKeepTokens: 8000,          // 保留尾部 token 下限
  fullCompact: true,            // 助手线全量压缩：true 压到当前步之前；false 退回保留尾部策略
  roiFloor: 0.30,               // 压缩收益下限：连续低于此值即建议换任
  anchorMaxTokens: 1500,       // 锚点总长参考上限（超限只报告，不裁剪）
  capsuleMaxChars: 4600,       // 胶囊渲染后参考上限（超限只报告，不裁剪）
  constraintMax: 8,             // 会话约束条数上限
  bypassModel: false,          // 旁路语义摘要：默认关闭
  bypassModelMaxChars: 200,    // 旁路摘要字数上限
  recallLimit: 8,              // ho_status(view="recall") 默认返回条数
  sessionScanHours: 12,
  // 留空 = 按会话角色解析：全局取 records/Global_Handover.md，项目取 _Project_Meta/<项目>/Handover.md，
  // 杂项取 _Misc/tasks/<任务>/Handover.md。非空则强制该路径，供演练使用。
  handoverPath: '',
  rolesPath: '',           // 留空 = ~/.dsh/storages/dsh-handover.roles.json
  compactTimeoutMs: 120000,
  driftSlack: 3,           // Δ交接容忍轮数（超过即需刷交接）
  wakeAuthority: 'on',     // 会话守卫硬拦：on / off（off＝连 peer 的 new 动作也不拦）
  directPeer: 'on',        // 会话之间直接 peer（action="send"）：on 允许（不经全局转述）；off 退回「只能向全局报告」的旧口径
  roleGating: 'on',        // 按角色裁剪工具与提示段：on / off（off＝除子会话外的所有会话都看得见全部工具）
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
