/** ho_pack —— 打包族：action=check（前置闸门）、pack（打包）、verify（校包）、restore（默认预演）。 */
import { textOutput } from '../lib/output.mjs';
import { nameOf } from '../lib/names.mjs';
import { packCheck, packNow, packVerify, packRestore } from '../lib/pack-ops.mjs';

export function pmPackTool(env) {
  return {
    name: nameOf('pack'),
    description: '迁移包四合一：check 前置闸门、pack 打包、verify 校包、restore 恢复（默认预演）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['check', 'pack', 'verify', 'restore'], description: '缺省 pack' },
        kind: { type: 'string', enum: ['project', 'task', 'global'], description: 'pack 的目标类型' },
        name: { type: 'string', description: 'pack 的项目名、任务名' },
        out: { type: 'string', description: 'pack 的输出目录' },
        note: { type: 'string', description: 'pack 写进 MIGRATION.md 的说明' },
        items: { type: 'array', items: { type: 'string' }, description: 'check 检查的项目名（global 表示全局）' },
        min_age_min: { type: 'number', description: 'check 要求静止分钟（默认 90）' },
        pack: { type: 'string', description: 'verify/restore 的包路径' },
        target: { type: 'string', description: 'restore 的目标根（默认当前）' },
        apply: { type: 'boolean', description: 'restore 时 true 才写入' },
        dry_run: { type: 'boolean', description: 'pack 只列清单；restore 只预演' },
        format: { type: 'string', enum: ['auto', '7z', 'tar'], description: 'pack 的归档格式：auto＝有 7-Zip 用 7z，否则内置 tar.gz（默认）' },
      },
    },
    output: textOutput(),
    async execute(args, exec) {
      const action = typeof args.action === 'string' && args.action ? args.action : 'pack';
      if (action === 'check') return { text: packCheck(env, args, exec) };
      if (action === 'verify') return { text: packVerify(env, args, exec) };
      if (action === 'restore') return { text: packRestore(env, args, exec) };
      if (action !== 'pack') throw new Error('未知 action：' + action + '（check、pack、verify、restore）');
      return { text: packNow(env, args, exec) };
    },
  };
}