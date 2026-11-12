/** ho_succeed —— 换任自服务：在任会话在用户授权后，自行校验交接、建接任会话并登记在任。 */
import { textOutput } from '../lib/output.mjs';
import { nameOf } from '../lib/names.mjs';
import { runSuccession } from '../lib/succession.mjs';

export function pmSucceedTool(env) {
  return {
    name: nameOf('succeed'),
    description:
      '换任：校验本会话交接，建接任会话并登记在任；须当前用户先授权（/allow-succeed）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        note: { type: 'string', description: '写进在任登记的备注（可选）' },
        force: { type: 'boolean', description: '本会话水位未到线时仍换任（默认不传）' },
      },
    },
    output: textOutput(),
    async execute(args, exec) {
      return { text: await runSuccession(env, exec, { note: args && args.note, force: args && args.force === true }) };
    },
  };
}
