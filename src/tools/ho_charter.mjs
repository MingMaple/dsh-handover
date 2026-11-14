/** ho_charter —— 按节读规则正文；doc="runtime" 取插件自带的完整流程手册。 */
import path from 'node:path';
import { nameOf } from '../lib/names.mjs';
import { textOutput } from '../lib/output.mjs';
import { NL, readUtf8, isFile, sectionLines } from '../lib/text.mjs';
import { charterPath, canonicalBlock } from '../lib/charter.mjs';

// tpl＝工作区没有这份时退回的**内置同名模板**（dist/templates 下）。插件不依赖旧全局的文件。
const FILES = [
  { key: 'charter', rel: ['_Control_Center', 'rules', 'Workspace_Charter.md'], tpl: 'Charter.skeleton.md' },
  { key: 'handover_rules', rel: ['_Control_Center', 'rules', 'Handover_Rules.md'], tpl: 'rules/Handover_Rules.md' },
  { key: 'migration_rules', rel: ['_Control_Center', 'rules', 'Migration_Rules.md'], tpl: 'rules/Migration_Rules.md' },
  { key: 'misc_standard', rel: ['_Control_Center', 'rules', 'Misc_Task_Standard.md'], tpl: 'rules/Misc_Task_Standard.md' },
  { key: 'delegation_rules', rel: ['_Control_Center', 'rules', 'Delegation_Rules.md'], tpl: 'rules/Delegation_Rules.md' },
  { key: 'writing_rules', rel: ['_Control_Center', 'user', 'Writing_Rules.md'], tpl: 'rules/Writing_Rules.md' },
];

function bundledTemplate(name) {
  return readUtf8(new URL('../templates/' + name, import.meta.url));
}

const DOC_KEYS = FILES.map((f) => f.key).concat(['runtime']);

/** 插件自带的手册：src/templates 与 dist/templates 下都有。 */
function runtimeManualPath() {
  return new URL('../templates/Runtime_Manual.md', import.meta.url);
}

export function pmCharterTool(env) {
  return {
    name: nameOf('charter'),
    description:
      '按节取规则正文，避免整篇读；doc="runtime" 取完整流程。只读。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        doc: { type: 'string', enum: DOC_KEYS, description: '默认 charter；runtime＝插件完整流程手册' },
        section: { type: 'string', description: '节标题片段；留空则只返回目录（## 行清单）' },
        maxLines: { type: 'number', description: '最多返回多少行（默认 120）' },
      },
    },
    output: textOutput(),
    async execute(args, exec) {
      const ws = env.resolveWs(exec);
      const doc = args.doc || "charter";
      const max = typeof args.maxLines === "number" ? args.maxLines : 120;
      const section = args.section;
      if (doc === 'runtime') {
        const text = readUtf8(runtimeManualPath());
        if (!section) return { text };
        const lines = sectionLines(text, section);
        if (!lines) throw new Error("运行期手册里未找到节：" + section);
        return { text: lines.slice(0, max).join(NL) };
      }
      const spec = FILES.find((f) => f.key === doc);
      if (!spec) throw new Error("未知文档：" + doc);
      const file = path.join.apply(path, [ws].concat(spec.rel));
      // 缺文件不算失败：退回插件自带默认口径，并明确告诉调用者「用的是内置那份」。
      let text = '';
      let fromBundle = false;
      try {
        if (!isFile(file)) throw new Error('missing');
        text = readUtf8(file);
      } catch {
        if (!spec.tpl) throw new Error('读不到规则文件，且没有内置版本：' + file);
        text = bundledTemplate(spec.tpl);
        fromBundle = true;
      }
      // 口径：内置=默认本体，工作区同名文件=本地化覆盖。所以这里不写「没有/缺失」，只标注来源。
      const note = fromBundle ? '（插件内置默认口径 · 要本地化就写到 ' + file + '）' : '';
      if (!section) {
        const heads = text.split(NL).filter((l) => l.startsWith("## "));
        return { text: [note, file, "共 " + heads.length + " 节：", ...heads.slice(0, max)].filter(Boolean).join(NL) };
      }
      if (fromBundle) text = note + NL + NL + text;
      if (section === "8.1.1.4") {
        const cp = charterPath(ws);
        const src = isFile(cp) ? readUtf8(cp) : bundledTemplate('Charter.skeleton.md');
        const blk = canonicalBlock(src);
        if (!blk) throw new Error("无法获取 §8.1.1.4 正文（结构变了）");
        const head = isFile(cp) ? '' : '（工作区没有 ' + cp + ' —— 下面是插件自带骨架里的通用约束条。）' + NL + NL;
        return { text: head + blk.body.slice(0, max).join(NL) };
      }
      const lines = sectionLines(text, section);
      if (!lines) throw new Error("未找到节：" + section + "（可先不带 section 调一次看目录）");
      return { text: lines.slice(0, max).join(NL) };
    },
  };
}
