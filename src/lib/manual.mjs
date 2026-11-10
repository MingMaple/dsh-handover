/**
 * 逐角色的系统提示段与一次性引导。
 * 职责边界：本文件只写会话定位、写入范围、交接路径、水位与换任、向全局汇报。
 * 其他行为约束（不虚构、最小改动、文风等）不属于本插件，由用户按需通过「全局前置提示词」注入。
 * 文字一律标准书面语；代码里不用反引号拼提示词。
 */
import { handoverPathFor, scopeLabel } from './role.mjs';
import { handoverRuleText, watermark } from './facts.mjs';

const NL = String.fromCharCode(10);

/** 完整流程的指针句（三档角色共用）。 */
const RUNTIME_POINTER = '细节按节取：ho_charter(doc="runtime", section=…)。';

/**
 * 复用准则：全局、项目、杂项三处必须同一句。
 * 派活与新建会话前先查在任，低水位在任直接复用；确需另建才新建。
 */
function reuseRule(cfg) {
  return '指派任务或新建会话前，先用 ho_office（空参数）查一次在任；同一类别已有在任且其水位低于 '
    + watermark(cfg).warn + ' 时，直接用 peer_send 复用，不新建；确需另建（原会话不可用、需并行、用户明确要求）时才新建。';
}

/** 全局会话的常驻段：五节骨架（身份、权限、节奏、交接、按需取用）。 */
export function globalManual(opts) {
  const o = opts || {};
  const lines = [
    'dsh-handover 运行期（全局）',
    '',
    '一、身份',
    '本会话为全局管理会话，协调会话、维护规则与交接。',
    '',
    '二、权限',
    '可写 _Control_Center、_Project_Meta 与项目结构；Projects 及各项目库内文件只读，不得代写；项目内作业不代办。',
    '新建会话与设定角色仅属全局；会话间可直接 peer_send；换任须用户授权（/allow-succeed 或设置页）后由在任会话调用 ho_succeed，不再请求全局。',
    reuseRule(o.cfg),
    '',
    '三、节奏',
    handoverRuleText(o.cfg),
    '压缩须用户点「压缩授权」，再写交接并 ho_checkpoint(confirm=true)；任务未完成传 resume=continue，已收尾传 resume=wait，不再唤醒。confirm 仅表意图，授权以点击为准。关键步骤传 at_risk=true 暂缓。',
    '',
    '四、交接',
    '交接：_Control_Center/records/Global_Handover.md。',
    '',
    '五、按需取用',
    RUNTIME_POINTER,
  ];
  const mv = moveLine(o);
  if (mv) lines.push(mv);
  return lines.join(NL);
}

/** 项目与杂项会话的提示段：只写本角色自己的写入范围、交接与水位。 */
export function scopedManual(info, opts) {
  const o = opts || {};
  const hp = handoverPathFor(o.ws, info);
  const label = scopeLabel(info);
  const lines = [
    'dsh-handover 运行期（' + label + '）',
    info.role === 'project'
      ? '只可写本库与元数据目录，不得写 _Control_Center 及其他项目。'
      : '只可写本任务目录与元数据目录，不得写 _Control_Center、Projects 及其他任务。',
    info.role === 'project'
      ? '库根：Projects/' + info.project + '/；元数据：_Project_Meta/' + info.project + '/。'
      : '任务目录：_Misc/tasks/' + info.task + '/。',
    info.role === 'project'
      ? '骨架：_Project_Meta/' + info.project + '/project.profile.json；未注册时先通读本库并 ho_profile(action=register)。'
      : '骨架：_Misc/tasks/' + info.task + '/task.profile.json；未注册时先通读本任务并 ho_profile(action=register)。',
    info.role === 'project'
      ? '临时与归档：_Temp/' + info.project + '/{Snapshots,Scratch}、_Archives/' + info.project + '/。'
      : '临时与归档：_Temp/_Misc/' + info.task + '/Snapshots/、_Archives/_Misc/' + info.task + '/。',
    hp.path
      ? '交接：' + hp.path + '（ho_handover 默认）。'
      : '交接路径未解析（缺角色或项目名），请先在设置页设定角色。',
    handoverRuleText(o.cfg) + '压缩须用户点「压缩授权」，再由本会话执行 ho_checkpoint(confirm=true)；收尾时传 resume=wait，不再唤醒。',
    '会话间可直接 peer_send；默认沉默：仅在水位 ' + watermark(o.cfg).warn + ' 且已写交接、需用户决定、全局口径有误时向全局报告；任务完成不报全局。',
    reuseRule(o.cfg),
    RUNTIME_POINTER,
  ];
  const mv = moveLine(o);
  if (mv) lines.push(mv);
  return lines.join(NL);
}

/** 迁移提示行（只有真的搬过才出现）。 */
function moveLine(opts) {
  const mv = opts && opts.move;
  if (!mv || mv.phase !== 'switched') return '';
  return '已迁移至 ' + (mv.dst || '?') + '；' + (mv.src || '?') + ' 现为链接，勿再手工迁移。';
}

export function manualFor(info, opts) {
  const role = info && info.role ? info.role : 'plain';
  if (role === 'global') return globalManual(opts);
  if (role === 'project' || role === 'misc') return scopedManual(info, opts);
  return '';
}

/** 「整理所属文件」一次性指令：设定项目或杂项角色后投递，唤醒它自己做。 */
export function organizeMessageFor(info, opts) {
  const o = opts || {};
  const role = info && info.role ? info.role : 'plain';
  if (role === 'plain') return '';
  const head = '【dsh-handover 角色设定】本会话已设定为「' + scopeLabel(info) + '」。请按下列结构核对自身文件：缺失的目录应建立，位置不当的文件应归位；既有文件就地保留，不得删除或修改内容。';
  if (role === 'project') {
    const p = info.project;
    return [
      head,
      '先通读本库，确定本项目的骨架：代码与文档主体、必需文件、临时与归档位置。构建型、动画型等项目不必套用插件类项目的文档集。',
      '把结论写入 _Project_Meta/' + p + '/project.profile.json；字段格式见 ho_profile(action=presets)。',
      '写入后调用 ho_profile(action=register) 校验并登记；返回缺失项时按清单补齐。',
      '约束：仅可改动本库与 _Project_Meta/' + p + '/；不得改动 _Control_Center 及其他项目；移动较大文件前先执行 ho_snapshot。可用工具：ho_snapshot、ho_handover、ho_phase、ho_checkpoint、ho_profile、peer_send。',
      '完成后以一句话向用户说明「注册了哪些骨架项、仍缺哪些」，无需每轮回执。',
    ].join(NL);
  }
  if (role === 'misc') {
    const t = info.task;
    return [
      head,
      '先通读本任务目录，确定本任务的骨架：工作文件、规则文件、交接、快照与归档位置。',
      '把结论写入 _Misc/tasks/' + t + '/task.profile.json；字段格式见 ho_profile(action=presets)。',
      '写入后调用 ho_profile(action=register) 校验并登记。',
      '约束：仅可改动 _Misc/tasks/' + t + '/、_Temp/_Misc/' + t + '/、_Archives/_Misc/' + t + '/；_Control_Center、Projects 与其他任务不得写入。工具：ho_snapshot、ho_handover、ho_phase、ho_checkpoint、ho_profile、peer_send。',
      '完成后以一句话说明改动即可。',
    ].join(NL);
  }
  return [
    head,
    '- _Control_Center/{records,rules,user,templates,tools} — 交接、规则、写作规范、模板、脚本。',
    '- _Project_Meta/Registry.md 与各项目元数据目录。',
    '- Projects/、_Misc/tasks/、_Archives/、_Temp/ — 只维护结构，不代写项目库内文件。',
    '约束：项目库内文件由该项目会话自行整理；骨架由项目自己注册，缺则派发，不代写。',
    '完成后以一句话汇报即可。',
  ].join(NL);
}
