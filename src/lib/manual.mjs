/**
 * 逐角色的系统提示段与一次性引导（1.0）。
 * 职责边界：本文件只写会话定位、写入范围、任务流程、水位与压缩、交接与体系注册、暂任与协作。
 * 其他行为约束由用户通过「全局前置提示词」注入。
 * 所有角色共用同一份任务流程文本，避免同一规则多处维护。
 */
import { handoverPathFor, scopeLabel } from './role.mjs';
import { handoverRuleText, watermark } from './facts.mjs';
import { consentPromptLines } from './consent.mjs';

const NL = String.fromCharCode(10);

/** 插件完整手册的指针（三档角色共用）。 */
const RUNTIME_POINTER = '细节按节取：ho_charter(doc="runtime", section=…)。';

/** 通用规范的位置与查找范围（三档角色共用，必须同一句）。 */
const STANDARDS_POINTER = '通用规范在 _Control_Center/standards/（每条一个子目录）；当前用户提到「按某某规范进行」时，本库（本会话所在的工作区）与该目录都算查找范围。';

/** 写入范围：未指明写本库；明确写通用规范才写规范库。 */
const STANDARDS_WRITE_PREFIX = '当前用户提到「把某某写成规范」时：未指明范围就写本库；';
const STANDARDS_WRITE_TARGET = '说「写入通用规范库」「写成通用规范」「写成共用规范」的';
const STANDARDS_WRITE_GLOBAL = STANDARDS_WRITE_PREFIX + STANDARDS_WRITE_TARGET + '，写 _Control_Center/standards/。';
const STANDARDS_WRITE_SCOPED = STANDARDS_WRITE_PREFIX + STANDARDS_WRITE_TARGET + '，不得写 _Control_Center，报全局。';

/** 写作规范指针：只有一行，不注入正文。 */
const WRITING_POINTER = '写作规范见 _Control_Center/standards/写作规范/README.md（W-01 至 W-42）；全部产出按它执行。';

/** 暂任与协作的落点：规范与提示词随任务库独立。 */
const DELEGATION_POINTER = '暂任与协作：规范在任务库 rules/Delegation_Rules.md，协作模板在 templates/Prompt_Templates.md。';

/** 协作收结果的口径：被派方不发消息，协调方按完成顺序收集最终回复。 */
const COLLAB_LINE = '协作收结果：进入协作前先 peer(action="collab", sessions=[…]) 注册；协作期间被交办方不能向交办者或同组成员发明文消息，工具端会拒绝，DSH 自带的 send_message 也由插件守卫拦住；普通对话不需要注册。协调方用 peer(action="collect", sessions=[…], timeout_ms=…) 取先完成者的最终回复，timeout_ms 按任务预估设置、最低 120000；collect 取回全部结果后限制自动解除。';

/** 写交接的固定流程（三档角色共用）：只写这一行，细则在规范与模板里。 */
const HANDOVER_FLOW = '写交接按固定流程：先读上一份交接，再归档上一份，再读模板 _Control_Center/templates/Handover.md，最后 ho_handover(action="new") 新建空白写入；不得在旧文件上续写。';

/** 复用准则：全局、项目、杂项三处同一句。 */
function reuseRule(cfg) {
  return '指派任务或新建会话前，先用 ho_office（空参数）查一次在任；同一类别已有在任且其水位低于 '
    + watermark(cfg).handover + ' 时，直接用 peer（action="send"）复用，不新建；确需另建（原会话不可用、需并行、当前用户明确要求）时才新建。';
}

/** 两级任务流程全文（三档角色共用）。 */
function workflowLines(cfg) {
  return [
    '三、任务流程',
    '- 层级一（轻量）：单文件修改、局部命名、语法修复、格式化、内容读取，直接执行，跳过计划与查证。',
    '- 当前用户说「讨论一下」，或你已就流程问过当前用户时，执行前须再确认；当前用户明确「直接做」除外。',
    '- 层级二（繁重）：新增功能、多文件联动、重构、架构或接口变更，按下述顺序执行。',
    '- 先写行动计划 PLAN.md（任务根）：任务是繁重的就该写详细计划，与水位无关；写完回看上下文核对，发现缺口时给出方案询问当前用户，优劣不明时并列全部方案。',
    '- 再判断纯窗口是否可能超过 40%（不计当前占用）：超过时在计划里安排拆子智能体，你只做统筹与收尾；不超过也不禁止派子智能体，按成本自己定，不派就自己做完。子智能体提示词由你放入规范文件地址与体系说明，插件不向其上下文注入内容。',
    '- 当前用户确认后执行。余量不足时先刷新交接，再请求压缩或换任；恢复后按「先读交接、再读计划、后执行」。',
    '- 每轮只做与当前任务直接相关的事；未经要求的检查不设立，工具正常返回即予采信。',
  ];
}

/** 上下文与压缩段落（三档角色共用）。 */
function rhythmLines(cfg) {
  const w = watermark(cfg);
  return [
    '四、上下文与压缩',
    '- 水位 ' + w.remind + ' 与 ' + w.remind2 + ' 各提醒一次，由插件在系统提示中后台注入，不生成用户消息、不独立成轮。',
    '- 判断标准：' + w.remind + ' 档为完成剩余流程后不超过 ' + Math.round((cfg && cfg.margin1 !== undefined ? cfg.margin1 : 0.45) * 100) + '%；'
      + w.remind2 + ' 档为不超过 ' + Math.round((cfg && cfg.margin2 !== undefined ? cfg.margin2 : 0.55) * 100) + '%。',
    '- ' + handoverRuleText(cfg) + '用户可随时要求换任。',
    '- 压缩前先刷新交接；压缩后先读交接、再读计划、后执行。',
    '- 压缩须当前用户点击「授权压缩」，再写交接并 ho_checkpoint(confirm=true)；任务未完成传 resume=continue，已收尾传 resume=wait，不再唤醒。',
    '- 关键步骤传 at_risk=true 暂缓；85% 硬上限保留。',
  ];
}

/** 全局会话的常驻段：身份、权限、流程、节奏、交接与体系、按需取用。 */
export function globalManual(opts) {
  const o = opts || {};
  const lines = [
    'dsh-handover 运行期（全局）',
    '',
    '一、身份',
    '本会话为全局管理会话，协调会话、维护登记与交接。',
    '',
    '二、权限',
    '可写 _Control_Center、_Project_Meta 与项目结构；Projects 及各项目库内文件只读，不得代写；项目内作业不代办。',
    '新建会话与设定角色仅属全局；会话间可直接 peer（action="send"）；换任须当前用户授权（/allow-succeed 或设置页）后由在任会话调用 ho_succeed。',
    reuseRule(o.cfg),
    '',
    ...workflowLines(o.cfg),
    '',
    ...rhythmLines(o.cfg),
    '',
    '五、交接与体系',
    '交接：_Control_Center/records/Global_Handover.md。',
    HANDOVER_FLOW,
    '体系注册：_Control_Center/records/systems.md 只列各任务体系文件的路径；本段只注入这些引用，不注入各任务正文。',
    '全局任务库：_Control_Center/tasks/<任务名>/；每个任务有独立交接与计划，任务可一键独立为项目或杂项会话。',
    COLLAB_LINE,
    WRITING_POINTER,
    DELEGATION_POINTER,
    '',
    '六、按需取用',
    RUNTIME_POINTER,
    STANDARDS_POINTER,
    STANDARDS_WRITE_GLOBAL,
  ];
  const sys = o.system || '';
  if (sys) lines.push('', sys);
  const cs = consentBlock(o);
  if (cs.length) lines.push('', ...cs);
  const mv = moveLine(o);
  if (mv) lines.push(mv);
  return lines.join(NL);
}

/** 项目与杂项会话的提示段：写入范围、交接、流程、体系注册内容、规范指针。 */
export function scopedManual(info, opts) {
  const o = opts || {};
  const hp = handoverPathFor(o.ws, info);
  const label = scopeLabel(info);
  const lines = [
    'dsh-handover 运行期（' + label + '）',
    '',
    '一、身份与边界',
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
      : '交接路径未解析（缺角色或名称），请先在设置页设定角色。',
    HANDOVER_FLOW,
    '名称已注册，不得自行修改；需要改名由全局处理。',
    '',
    ...workflowLines(o.cfg),
    '',
    ...rhythmLines(o.cfg),
    '',
    '五、交接与体系',
    '会话间可直接 peer（action="send"）；默认沉默：仅在水位 ' + watermark(o.cfg).remind + ' 且已写交接、需当前用户决定、全局口径有误时向全局报告；任务完成不报全局。',
    WRITING_POINTER,
    DELEGATION_POINTER,
    COLLAB_LINE,
    '',
    '六、按需取用',
    RUNTIME_POINTER,
    STANDARDS_POINTER,
    STANDARDS_WRITE_SCOPED,
  ];
  const sys = o.system || '';
  if (sys) lines.push('', sys);
  const cs = consentBlock(o);
  if (cs.length) lines.push('', ...cs);
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

/** 用户已授权的提示行：每种有效授权一行，无授权不占位。 */
function consentBlock(opts) {
  try { return consentPromptLines(opts && opts.consents); } catch { return []; }
}

export function manualFor(info, opts) {
  const role = info && info.role ? info.role : 'plain';
  if (role === 'global') return globalManual(opts);
  if (role === 'project' || role === 'misc') return scopedManual(info, opts);
  return '';
}

/**
 * 设定角色后投递的一次性首轮消息：讨论体系、注册名称；互转时先说明迁移结果。
 * 由 applyRole 在写角色表之后投递，不改变角色本身。
 */
export function firstRoundMessageFor(info, opts) {
  const o = opts || {};
  const role = info && info.role ? info.role : 'plain';
  if (role === 'plain') return '';
  const label = scopeLabel(info);
  const lines = [];
  lines.push('【dsh-handover 角色设定】本会话已设为「' + label + '」。');
  if (o.previousRole === 'project' || o.previousRole === 'misc') {
    if (o.previousRole !== role) {
      lines.push(o.migrate === 'direct'
        ? '已按「直接建」处理：旧文件未搬动，请按体系模板建立本任务体系。'
        : '已按标准流程完成迁移：' + (o.moveNote || '旧库已快照后移动，位置见交接。'));
      lines.push('若当前用户希望改用另一种方式，请说明差异，不要自行再搬一次。');
    } else {
      lines.push('角色未变：沿用既有体系与注册名。');
    }
  } else {
    lines.push('首轮固定事项：一、了解本会话既有产出与任务；二、读体系模板并初拟体系；三、与当前用户二选一——全权交你直接建成并注册，或讨论定稿后建成并注册。');
  }
  lines.push('名称：' + (o.name ? '本会话注册名为「' + o.name + '」，不得自行修改。' : '本会话尚无注册名。与当前用户确认名称后，用 ho_office(action="register", name="…") 注册；注册后不得自行修改，改名须找全局。'));
  lines.push('体系注册：用 ho_docmap(action="write", entries=[…]) 写入目录结构、规范文件与计划；模板见任务库 rules 与 templates 目录。');
  lines.push('约束：只改动本会话所属范围；不每轮回执，不发送确认类消息。');
  return lines.join(NL);
}
