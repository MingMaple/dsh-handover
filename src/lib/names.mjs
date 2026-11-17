/**
 * 工具名集中管理：ho_* 由 PREFIX 与 KEYS 生成，平级会话工具固定为 peer。
 * 工具文件一律用 nameOf、PEER_NAME 取名；index.mjs 启动时校验位置表，改名只需改这里。
 *
 * 工具面共 6 个入口：
 *   ho_status    —— 阶段、简报、自检、漂移、token 体检、闸门与原文召回
 *   ho_handover  —— 交接读写、换任重写与压缩登记
 *   ho_docmap    —— 体系注册、计划、骨架、台账与规则正文
 *   ho_sessions  —— 会话调度、在任登记与换任
 *   ho_workspace —— 工作区生命周期与备份迁移
 *   peer         —— 平级会话的动作入口
 */
const PREFIX = 'ho';

export const nameOf = (key) => PREFIX + '_' + key;

const KEYS = ['status', 'handover', 'docmap', 'sessions', 'workspace'];

export const NAMES = KEYS.reduce((acc, k) => { acc[k] = nameOf(k); return acc; }, {});

export const TOOL_NAMES = KEYS.map((k) => NAMES[k]);

/** 平级会话工具：一个入口，动作用 action 分流。 */
export const PEER_NAME = 'peer';

export const ALL_TOOL_NAMES = TOOL_NAMES.concat([PEER_NAME]);
