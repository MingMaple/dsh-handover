/**
 * 工具名集中管理：ho_* 由 PREFIX 与 KEYS 生成，平级会话工具固定为 peer。
 * 工具文件一律用 nameOf、PEER_NAME 取名，index.mjs 启动时校验位置表，改名只需改这里。
 *
 * 0.9.15 起按「会话一次要做的一件事」合并（见 CHANGELOG）：
 *   ho_status  —— 阶段、起始简报、自检、交接漂移、token 体检（原 ho_phase、ho_brief、ho_diag、ho_drift、ho_tokens）
 *   ho_backup  —— 快照与迁移包（原 ho_snapshot、ho_pack）
 *   ho_workspace —— 工作区动作，含首次建立的 init（原 ho_init）
 *   peer       —— 平级会话的六个动作（原 peer_list、peer_status、peer_send、peer_new、peer_rename、peer_peek）
 */
const PREFIX = 'ho';

export const nameOf = (key) => PREFIX + '_' + key;

const KEYS = [
  'status', 'gate', 'sessions', 'charter',
  'handover', 'checkpoint', 'changelog',
  'backup', 'workspace', 'profile', 'office', 'succeed', 'docmap',
];

export const NAMES = KEYS.reduce((acc, k) => { acc[k] = nameOf(k); return acc; }, {});

export const TOOL_NAMES = KEYS.map((k) => NAMES[k]);

/** 平级会话工具：一个入口，动作用 action 分流。 */
export const PEER_NAME = 'peer';

export const ALL_TOOL_NAMES = TOOL_NAMES.concat([PEER_NAME]);
