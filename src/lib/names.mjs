/**
 * 工具名集中管理：ho_* 由 PREFIX 与 KEYS 生成，peer_* 由 PEER_KEYS 生成。
 * 工具文件一律用 nameOf、peerNameOf 取名，index.mjs 启动时校验位置表，改名只需改这里。
 */
const PREFIX = 'ho';

export const nameOf = (key) => PREFIX + '_' + key;

/**
 * ho_* 16 个。合并过的家族（刻意保持旧名，参数里用 action 分流）：
 *   ho_pack     —— 打包 / 校验 / 预演 / 恢复（原 ho_pack_verify、ho_pack_restore、ho_pack_precheck）
 *   ho_sessions —— 清点 / 设定角色 / 建会话 / 出提示词 / 归档 / 解归档（原 ho_session_new、ho_prompt、ho_session_archive、ho_session_unarchive）
 *   ho_profile  —— 骨架读取 / 注册 / 校验 / 预设
 */
const KEYS = [
  'brief', 'gate', 'sessions', 'phase', 'charter',
  'handover', 'checkpoint', 'snapshot', 'diag',
  'drift', 'changelog', 'tokens',
  'pack', 'workspace', 'init', 'profile',
];

export const NAMES = KEYS.reduce((acc, k) => { acc[k] = nameOf(k); return acc; }, {});

export const TOOL_NAMES = KEYS.map((k) => NAMES[k]);

/** 平级会话工具：名字固定为 peer_*，不走 PREFIX。 */
export const peerNameOf = (key) => 'peer_' + key;

const PEER_KEYS = ['list', 'status', 'send', 'new', 'rename', 'peek'];

export const PEER_NAMES = PEER_KEYS.map((k) => peerNameOf(k));

export const ALL_TOOL_NAMES = TOOL_NAMES.concat(PEER_NAMES);
