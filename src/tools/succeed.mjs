/** 换任实现 —— 在任会话在用户授权后，自行校验交接、建接任会话并登记在任。经 ho_sessions 的 succeed 动作暴露。 */
import { textOutput } from '../lib/output.mjs';
import { nameOf } from '../lib/names.mjs';
import { runSuccession } from '../lib/succession.mjs';

/**
 * 构造 `succeed` 工具定义。
 *
 * 换任须先由用户授权，工具只做交接校验与会话登记，避免会话自行重置。
 *
 * @param {object} env 插件环境，提供角色、在任登记与会话控制。
 * @returns {object} 工具定义，供宿主注册。
 * 副作用：建接任会话、登记在任并投递启动提示词。
 */
export function pmSucceedTool(env) {
  return {
    name: nameOf('succeed'),
    description:
      '换任：校验本会话交接，建立接任会话并登记在任。须由当前用户先行授权 `/allow-reset`。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        note: { type: 'string', description: '写入在任登记的备注，可选。例：`交接已复核`。' },
        force: { type: 'boolean', description: '本会话水位未到线时仍执行换任。缺省不传。' },
      },
    },
    output: textOutput(),
    async execute(args, exec) {
      return { text: await runSuccession(env, exec, { note: args && args.note, force: args && args.force === true }) };
    },
  };
}
