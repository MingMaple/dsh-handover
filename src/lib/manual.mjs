/**
 * 逐角色的系统提示段与一次性引导（1.0）。
 * 职责边界：本文件只写会话定位、写入范围、任务流程、水位与压缩、交接与体系注册、暂任与协作。
 * 其他行为约束由当前用户通过「全局前置提示词」注入。
 * 所有角色共用同一份任务流程文本，避免同一规则多处维护。
 */
import { handoverPathFor, scopeLabel } from './role.mjs';
import { consentPromptLines } from './consent.mjs';
import { rubricText } from './inject.mjs';

const NL = String.fromCharCode(10);

/** 插件完整手册的指针（各档角色共用）。 */
const RUNTIME_POINTER = '细节按节取用：ho_docmap(action="rules-read", doc="runtime", section=…)。';

/** 通用规范的位置与查找范围（各档角色共用，必须同一句）。 */
const STANDARDS_POINTER = '通用规范位于 _Control_Center/standards/（每条规范一个子目录）。当前用户提出「按某某规范进行」时，查找范围包括本库（本会话所在的工作区）与该目录。';

/** 写入范围：未指明写本库；明确写通用规范才写规范库。 */
const STANDARDS_WRITE_PREFIX = '当前用户提出「把某某写成规范」时：未指明范围则写本库；';
const STANDARDS_WRITE_TARGET = '当前用户说「写入通用规范库」「写成通用规范」「写成共用规范」时';
const STANDARDS_WRITE_GLOBAL = STANDARDS_WRITE_PREFIX + STANDARDS_WRITE_TARGET + '，写 _Control_Center/standards/。';
const STANDARDS_WRITE_SCOPED = STANDARDS_WRITE_PREFIX + STANDARDS_WRITE_TARGET + '，不得写 _Control_Center，只报全局。';

/** 写作规范指针：只有一行，不注入正文。 */
const WRITING_POINTER = '写作规范见 _Control_Center/standards/写作规范/README.md（W-01 至 W-42），全部产出均按该规范执行。';

/** 暂任与协作的落点：规范与提示词随任务库独立。 */
const DELEGATION_POINTER = '暂任：当前用户说「交接给外部会话」「交给另一个会话」「暂任」即暂任，不是换任。步骤：刷新交接；把提示词写入任务库 Delegation_Prompt.md（旧提示词归档到 _archive/）；回复中的代码块只给一行索引「请阅读 <Delegation_Prompt.md 绝对路径> 和 <交接绝对路径>」。暂任不改变交接归属与在任登记：不申请授权、不建接任会话，交出方仍是在任者。席位变更仅在当前用户明确要求时另行办理。细则见任务库 rules/Delegation_Rules.md，协作模板见 templates/Prompt_Templates.md。';

/** 协作收结果的口径：被派方不发消息，协调方按完成顺序收集最终回复。 */
const COLLAB_LINE = '协作收结果：进入协作前，先以 peer(action="collab", sessions=[…]) 注册。协作期间，被交办方不得向交办者或同组成员发送明文消息，工具端会拒绝。宿主自带的 send_message 亦由插件守卫拦截。普通对话无需注册。协调方以 peer(action="collect", sessions=[…], timeout_ms=…) 取先完成者的最终回复。timeout_ms 按任务预估设置，最低 120000。collect 取回全部结果后，限制自动解除。';

/** 写交接的固定流程（各档角色共用）：只写这一行，细则在规范与模板里。 */
const HANDOVER_FLOW = '写交接按固定流程执行。以 ho_handover(action="rotate", text=…) 一步完成归档旧交接、写入新正文与结构体检。返回的承接项需自行并入新正文。';
const ABORT_LINE = '终止按钮只让当前工具调用提前返回。已发出的消息不撤回，已建成的会话不回滚，已写入的交接与快照保留。';
const SKIP_LINE = '自触发未介入时写日志，带上 sid、reason、ratio。同一会话同一原因 5 分钟内只写一条。';

/** 复用准则：全局、项目、杂项各处同一句。 */
function reuseRule(cfg) {
  return '派发任务或新建会话前，先用 ho_sessions(action="office-read") 查询一次在任。同一类别已有在任会话且其水位未到整理线时，直接用 peer（action="send"）复用，不新建。只有原会话不可用、需并行或当前用户明确要求时，才另行新建。';
}

/** 两级任务流程全文（各档角色共用）。 */
function workflowLines(cfg) {
  return [
    '三、任务流程',
    '- 层级一（轻量）：单文件修改、局部命名、语法修复、格式化与内容读取，直接执行，跳过计划与查证。',
    '- 当前用户说「讨论一下」，或已就流程向当前用户确认过时，执行前须再次确认。当前用户明确要求「直接做」时除外。',
    '- 层级二（繁重）：新增功能、多文件联动、重构、架构或接口变更，按下述顺序执行。',
    '- 先判断纯窗口是否可能超过 40%（不计当前占用）。超过时，写计划就把拆子智能体安排进去，本会话只做统筹与收尾。未超过时，计划按本会话自行完成编写。',
    '- 写行动计划 PLAN.md（任务根）：先读模板 `_Control_Center/templates/Plan.skeleton.md`，再把上一份计划归档到任务根 `_archive/`。随后新建空白文件，按模板节次写入。不读旧计划，不在旧计划上改写。写完回看上下文核对；发现缺口时给出方案询问当前用户，优劣不明时并列全部方案。',
    '- 任务收尾时把当前计划归档到任务根 `_archive/`，并从注册文件删除「计划」一行。',
    '- 子智能体（细则见 Charter §十一 与运行时手册 §12.4）：仅在单块 ≥15 步或需读 ≥10 个文件时派出。同时须确需隔离、结果可机械验收，并发 ≤3。单个子智能体自身亦需十余步，结论还需回读。可由脚本批量处理再抽检者，先编写脚本。同一批文件的下一道工序交回原作者续用，不另开会话。提示词由本会话派发时，应写入规范文件地址与体系说明；插件不向其上下文注入内容。',
    '- 当前用户确认后执行。余量不足时先压缩或办理更替会话。压缩后按胶囊继续。更替会话后按「先读交接、再读计划、后执行」恢复。任务已收尾时选 resume=wait，压缩后不唤醒。',
    '- 每轮只做与当前任务直接相关的事；未经要求的检查不发起，工具正常返回即予采信。',
  ];
}

/** 上下文与压缩段落（各档角色共用）。 */
function rhythmLines(cfg) {
  const c = cfg || {};
  const max = Number(c.maxCompactionsPerSession) || 4;
  const cap = Number(c.maxCompactionsHardCap) || 6;
  return [
    '四、上下文与压缩',
    '- 分档按 token：整理线 soft、建议线 advise、强制线 hard。分档按窗口纯比例：整理线 35%、建议线 50%、强制线 65%。上述均为可用窗口比例，不设绝对上限。可用窗口 = 窗口 − 预留输出 13K。200K 窗实得 65K/94K/122K，1M 窗约 345K/494K/642K。窗口读不到时退回绝对预算 80K/120K/180K。',
    '- 到整理线与建议线由插件注入提示。建议线先写胶囊再压缩：先把任务收到安全断点。按胶囊标准写：目标、已定方案、下一步、易错点、必须遵守的约束原文、需要保留的原文位置。再调用 ho_handover(action="compact", capsule=…)。到强制线由插件机制兜底压缩。',
    '- 每轮开始时注入一行压力画像；到线提示同一会话同一档位只注入一次，压缩成功后重置。注入只追加到末尾，不改系统提示结构。',
    rubricText(),
    '- 压缩计数：助手压缩与强制压缩都计。达到 ' + max + ' 次后助手入口与提示关闭，强制线仍兜底至 ' + cap + ' 次；此后只能写交接并更替会话。',
    '- 压缩后以胶囊为准，不读旧交接全文；交接只在更替会话时使用。助手胶囊由本会话自述目标、已定方案、下一步与易错点。机制兜底胶囊含约束逐条原文、已确认事实与指针、未完成与下一步，并给出锚点路径。助手胶囊与 DSH 摘要互补。',
    '- 微观层：工具失败、文件写入、计划或待办变更时触发微快照。快照 6 项为目标、已确认事实、未决、下一步、指针与时刻；缺项写「未核，待确认」。快照与锚点存放在会话目录内 dsh-handover/，随会话删除而消失。',
    '- 换任一步到位：ho_handover(action="rotate", text=…) 归档旧交接并写入新正文。随后由当前用户发送 /allow-reset 或点击「授权重置」，再调用 ho_sessions(action="succeed")。未获授权不得建接任会话；不得用同会话压缩冒充清空上下文。',
    '- 交接只写在途与指针，篇幅以结构控制为主，不规定字节与页数。单份全文不超过 500 行；超限先删过期内容，不删在途信息。不粘贴大段代码、日志与命令输出，需要时给出路径。',
    '- 事件级微快照由插件自动落盘，不必手工写入。整篇重写交接用 action="rotate"；不经该动作而手改交接的，更替会话会被拒绝。',
    '- 探查与批量任务先量后取：用脚本统计行数、字段数与文件数。不要把整份 CSV、题面或日志一次性刷进上下文。单条工具结果将超过约 100 行或 4KB 时，改用 offset/limit，或只取表头与计数。',
    '- 脚本回显只给汇总与失败项，不超过 40 行。同一批数据不为探查另写脚本；分析、生成、自测在一个脚本里完成。',
    '- 本机 shell 是 Windows PowerShell 5.1，默认编码 gb2312。Get-Content 按 ANSI 解码，Set-Content -Encoding utf8 再编码。用它们转写含中文的文件会出现双重编码，得到乱码（典型「绗笁鏂」）。转写文本一律用 node 脚本，或 [IO.File]::ReadAllText 与 WriteAllText 配 UTF-8 无 BOM。不要把 Get-Content 管道给 Set-Content。',
    '- 原文用 ho_status(view="recall", query="…") 按 seq 回读，命中时给出前后三行。需要邻近事件时用 around 展开。',
    '- 强制线提示与强制压缩由插件执行；助手不重复调用压缩。计数达上限后助手不再压缩，由插件按硬上限兜底。',
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
    '可写 _Control_Center、_Project_Meta 与项目结构。Projects 及各项目库内文件只读，不得代写；项目内作业不由全局代办。',
    '新建会话与设定角色仅属全局；会话间可直接 peer（action="send"）。换任须由当前用户授权：/allow-reset 或设置页「授权重置」。授权后在任会话以 ho_handover(action="rotate", text=…) 重写交接。再调用 ho_sessions(action="succeed") 办理。',
    reuseRule(o.cfg),
    '',
    ...workflowLines(o.cfg),
    '',
    ...rhythmLines(o.cfg),
    '',
    '五、交接与体系',
    '交接：_Control_Center/records/Global_Handover.md。',
    HANDOVER_FLOW,
    '体系注册：_Control_Center/records/systems.md 只列各任务体系文件的路径。本段只注入这些引用，不注入各任务正文。',
    '全局任务库：_Control_Center/tasks/<任务名>/。每个任务各有独立交接与计划，并可一键独立为项目或杂项会话。',
    COLLAB_LINE,
    ABORT_LINE,
    SKIP_LINE,
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
      ? '骨架：_Project_Meta/' + info.project + '/project.profile.json；未注册时先通读本库，再调用 ho_docmap(action="profile-register")。'
      : '骨架：_Misc/tasks/' + info.task + '/task.profile.json；未注册时先通读本任务，再调用 ho_docmap(action="profile-register")。',
    info.role === 'project'
      ? '临时与归档：_Temp/' + info.project + '/{Snapshots,Scratch}、_Archives/' + info.project + '/。'
      : '临时与归档：_Temp/_Misc/' + info.task + '/Snapshots/、_Archives/_Misc/' + info.task + '/。',
    hp.path
      ? '交接：' + hp.path + '（ho_handover 默认）。'
      : '交接路径未解析（缺角色或名称）。请先在设置页设定角色。',
    HANDOVER_FLOW,
    '名称已注册，不得自行修改；需要改名由全局处理。',
    '',
    ...workflowLines(o.cfg),
    '',
    ...rhythmLines(o.cfg),
    '',
    '五、交接与体系',
    '会话间可直接 peer（action="send"）。默认沉默：仅在 3 种情形下向全局报告。其一为水位达到建议线（advise）且已写交接；其二为需当前用户决定；其三为全局口径有误。任务完成不报全局。',
    WRITING_POINTER,
    DELEGATION_POINTER,
    COLLAB_LINE,
    ABORT_LINE,
    SKIP_LINE,
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
        ? '已按「直接建」处理：旧文件未移动，请按体系模板建立本任务体系。'
        : '已按标准流程完成迁移：' + (o.moveNote || '旧库已快照后移动，位置见交接。'));
      lines.push('若当前用户希望改用另一种方式，请说明差异，不得自行再次迁移。');
    } else {
      lines.push('角色未变：沿用既有体系与注册名。');
    }
  } else {
    lines.push('首轮固定事项：一、了解本会话既有产出与任务。二、读体系模板并初拟体系。三、与当前用户确认一种方式：由本会话直接建成并注册，或先讨论定稿再建成并注册。');
  }
  lines.push('名称：' + (o.name ? '本会话注册名为「' + o.name + '」，不得自行修改。' : '本会话尚无注册名。与当前用户确认名称后，用 ho_sessions(action="office-register", name="…") 注册。注册后不得自行修改，改名由全局处理。'));
  lines.push('体系注册：用 ho_docmap(action="registry-write", entries=[…]) 写入目录结构、规范文件与计划。模板见任务库 rules 与 templates 目录。');
  lines.push('约束：只改动本会话所属范围；不每轮回执，不发送确认类消息。');
  return lines.join(NL);
}
