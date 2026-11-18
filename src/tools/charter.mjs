/** 规则正文实现 —— 按节读规则正文；doc="runtime" 取插件自带的完整流程手册。经 ho_docmap 的 rules-read 动作暴露。 */
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

/**
 * 构造 `charter` 工具定义。
 *
 * 工作区缺文件时退回插件内置模板，保证规则正文始终可读。
 *
 * @param {object} env 插件环境，提供 `resolveWs`。
 * @returns {object} 工具定义，供宿主注册。
 * 副作用：无；只读文件。
 */
export function pmCharterTool(env) {
  return {
    name: nameOf('charter'),
    description:
      '按节读取规则正文，避免整篇读取；`doc="runtime"` 取完整流程手册。只读，不修改任何文件。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        doc: { type: 'string', enum: DOC_KEYS, description: '文档名。缺省 `charter`；`runtime` 为插件完整流程手册。例：`handover_rules`。' },
        section: { type: 'string', description: '节标题片段。留空时只返回目录，即 `##` 行清单。例：`8.1.1.4`。' },
        maxLines: { type: 'number', description: '最多返回的行数。默认 120。例：`60`。' },
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
        if (!lines) throw new Error("现象：运行期手册中未找到该节：`" + section + "`。原因：节标题片段与手册标题不一致。处置：省略 `section` 取目录，再按目录传入完整标题。");
        return { text: lines.slice(0, max).join(NL) };
      }
      const spec = FILES.find((f) => f.key === doc);
      if (!spec) throw new Error("现象：`doc` 取值未知：`" + doc + "`。原因：该取值不在允许清单内。处置：改用 " + DOC_KEYS.join('、') + " 之一。");
      const file = path.join.apply(path, [ws].concat(spec.rel));
      // 缺文件不算失败：退回插件自带默认口径，并明确告诉调用者「用的是内置那份」。
      let text = '';
      let fromBundle = false;
      try {
        if (!isFile(file)) throw new Error('missing');
        text = readUtf8(file);
      } catch {
        if (!spec.tpl) throw new Error('现象：规则文件无法读取，且没有内置版本：`' + file + '`。原因：该文档没有随插件分发的模板。处置：按分发包补回该文件，或改用其他 `doc` 取值。');
        text = bundledTemplate(spec.tpl);
        fromBundle = true;
      }
      // 口径：内置=默认本体，工作区同名文件=本地化覆盖。所以这里不写「没有/缺失」，只标注来源。
      const note = fromBundle ? '（插件内置默认口径；如需本地化，写入 `' + file + '`）' : '';
      if (!section) {
        const heads = text.split(NL).filter((l) => l.startsWith("## "));
        return { text: [note, file, "共 " + heads.length + " 节：", ...heads.slice(0, max)].filter(Boolean).join(NL) };
      }
      if (fromBundle) text = note + NL + NL + text;
      // 通用约束条特例只属于 Charter：其他 doc 配该节时按各自正文查找，避免串文档。
      if (doc === "charter" && section === "8.1.1.4") {
        const cp = charterPath(ws);
        const src = isFile(cp) ? readUtf8(cp) : bundledTemplate('Charter.skeleton.md');
        const blk = canonicalBlock(src);
        if (!blk) throw new Error("现象：无法取得 §8.1.1.4 正文。原因：通用约束条结构已变更，正文块无法定位。处置：核对 `Workspace_Charter.md` 中 §8.1.1.4 的标题与正文块格式。");
        const head = isFile(cp) ? '' : '（工作区无 `' + cp + '`，以下为插件自带骨架中的通用约束条。）' + NL + NL;
        return { text: head + blk.body.slice(0, max).join(NL) };
      }
      const lines = sectionLines(text, section);
      if (!lines) throw new Error("现象：未找到节：`" + section + "`。原因：节标题片段与文档标题不一致。处置：先省略 `section` 调用一次，按返回目录重试。");
      return { text: lines.slice(0, max).join(NL) };
    },
  };
}
