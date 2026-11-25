/**
 * 逐角色的系统提示段与一次性引导（1.0）。
 * 职责边界：本文件只写会话定位、写入范围、任务流程、水位与压缩、交接与体系注册、暂任与协作。
 * 其他行为约束由当前用户通过「全局前置提示词」注入。
 * 所有角色共用同一份任务流程文本，避免同一规则多处维护。
 */
import path from 'node:path';
import { handoverPathFor, scopeLabel, layoutOf, layoutScopeOf, LAYOUT_LABEL } from './role.mjs';
import { consentPromptLines } from './consent.mjs';
import { rubricText } from './inject.mjs';
import { bandsText } from './facts.mjs';
import { scanReportText, scanSampleLines } from './path-scan.mjs';

const NL = String.fromCharCode(10);

/** 插件完整手册的指针（各档角色共用）。 */
const RUNTIME_POINTER = '细节按节取用：ho_docmap(action="rules-read", doc="runtime", section=…)。';

/** 通用规范的位置与查找范围（各档角色共用，必须同一句）。 */
const STANDARDS_POINTER = '通用规范位于 _Control_Center/standards/（每条规范一个子目录）。该目录由工作区自管，插件只建空目录，不预置任何规范。当前用户提出「按某某规范进行」时，查找范围包括本库（本会话所在的工作区）与该目录。';

/** 写入范围：未指明写本库；明确写通用规范才写规范库。 */
const STANDARDS_WRITE_PREFIX = '当前用户提出「把某某写成规范」时：未指明范围则写本库；';
const STANDARDS_WRITE_TARGET = '当前用户说「写入通用规范库」「写成通用规范」「写成共用规范」时';
const STANDARDS_WRITE_GLOBAL = STANDARDS_WRITE_PREFIX + STANDARDS_WRITE_TARGET + '，写 _Control_Center/standards/。';
const STANDARDS_WRITE_SCOPED = STANDARDS_WRITE_PREFIX + STANDARDS_WRITE_TARGET + '，不得写 _Control_Center，只报全局。';

/** 工作区规范指针：只有一行，不注入正文。规范由工作区建立与登记，插件只提供查找口径。 */
const WRITING_POINTER = '工作区的全局共用规范放在 _Control_Center/standards/ 下，每条一个子目录，入口为子目录内的 README.md。当前用户提出「按某某规范进行」或指明某个规范名时，先查该目录与本库。找到即按其条款执行；插件不预置正文，也不据缺失情形推断条款。';

/** 暂任与协作的落点：规范与提示词随任务库独立。 */
const DELEGATION_POINTER = '暂任：当前用户说「交接给外部会话」「交给另一个会话」「暂任」即暂任，不是换任。承接方是不在 DSH 内的外部会话。它没有 ho_* 与 peer，只有宿主文件工具与宿主子智能体。规则见任务库 rules/External_Takeover_Rules.md。范围可为一件事，也可为整个项目：整项目由外部会话自行推进，何时交回由当前用户定。步骤：刷新交接；把提示词写入任务库 Delegation_Prompt.md（旧提示词归档到 _archive/）；回复中的代码块只给一行索引「请阅读 <Delegation_Prompt.md 绝对路径> 和 <交接绝对路径>」。索引只在交出当轮给一次。用户补充或修改口径时先讨论敲定，敲定后重写提示词再给一次索引。此后问答直接回答问题本身。暂任不改变交接归属与在任登记：不申请授权、不建接任会话，交出方仍是在任者。细则见任务库 rules/Delegation_Rules.md，协作模板见 templates/Prompt_Templates.md。席位变更仅在当前用户明确要求时另行办理。';

/** 协作收结果的口径：被派方不发消息，协调方按完成顺序收集最终回复。guard=false 时如实说明拦截不可用（D-110）。 */
function collabLine(guard) {
  const enforced = guard === false
    ? '当前内核无 tools.guard，插件无法在工具端拦截，务必遵守本条。'
    : '工具端会拒绝。宿主自带的 send_message 亦由插件守卫拦截。';
  return '协作收结果：进入协作前，先以 peer(action="collab", sessions=[…]) 注册。协作期间，被交办方不得向交办者或同组成员发送明文消息，' + enforced + '普通对话无需注册。协调方以 peer(action="collect", sessions=[…], timeout_ms=…) 取先完成者的最终回复。timeout_ms 按任务预估设置，最低 120000。collect 取回全部结果后，限制自动解除。';
}

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
    '- 当前用户确认后执行。余量不足时先压缩或办理更替会话。压缩后按胶囊继续。更替会话后按「先读交接、再读计划、后执行」恢复。',
    '- 每轮只做与当前任务直接相关的事；未经要求的检查不发起，工具正常返回即予采信。',
  ];
}

/**
 * 本机 shell 的转写注意事项：Windows 控制台代码页与 POSIX locale 不同，按平台各给一段。
 * 此前固定写 Windows PowerShell 5.1 与 gb2312，Linux 会话读到的是不适用的口径。
 */
function shellWriteLine() {
  if (process.platform === 'win32') {
    return '- 本机 shell 是 Windows PowerShell 5.1，默认编码 gb2312。Get-Content 按 ANSI 解码，Set-Content -Encoding utf8 再编码。用它们转写含中文的文件会出现双重编码，得到乱码（典型「绗笁鏂」）。转写文本一律用 node 脚本，或 [IO.File]::ReadAllText 与 WriteAllText 配 UTF-8 无 BOM。不要把 Get-Content 管道给 Set-Content。';
  }
  return '- 本机 shell 是 POSIX sh 或 bash，默认编码由 locale 决定。转写含中文的文本用 node 脚本，或经 printf、cat、iconv 显式指定 UTF-8。不要依赖未固定 locale 的管道与重定向完成转码。';
}

/** 上下文与压缩段落（各档角色共用）。 */
function rhythmLines(cfg) {
  const c = cfg || {};
  const max = Number(c.maxCompactionsPerSession) || 4;
  const cap = Number(c.maxCompactionsHardCap) || 6;
  return [
    '四、上下文与压缩',
    '- 分档按 token：整理线 soft、建议线 advise、强制线 hard。' + bandsText(c),
    '- 到整理线与建议线由插件注入提示。建议线先写胶囊再压缩：请将当前任务做到合适断点处后进行上下文压缩流程。按胶囊标准写：目标、已定方案、下一步、易错点、必须遵守的约束原文、需要保留的原文位置。再调用 ho_handover(action="compact", capsule=…)。到强制线由插件机制兜底：插件将立即执行压缩。',
    '- 每轮开始时注入一行压力画像；到线提示同一会话同一档位只注入一次，压缩成功后重置。注入只追加到末尾，不改系统提示结构。',
    rubricText(),
    '- 压缩计数：助手压缩与强制压缩都计。达到 ' + max + ' 次后助手入口与提示关闭，强制线仍兜底至 ' + cap + ' 次；此后只能写交接并更替会话。',
    '- 压缩后以胶囊为准，不读旧交接全文；交接只在更替会话时使用。助手胶囊由本会话自述目标、已定方案、下一步与易错点。机制兜底胶囊只放目标、约束逐条原文与状态，另附最近 6 轮按关键词抽取的句子。关键词为下一步、待办、未完成、待确认、待修、错误、失败、异常、路径，抽不到写「（无）」。助手胶囊与 DSH 摘要互补。',
    '- 微观层：微快照只在压缩前写入，助手入口与强制线各一次。快照 6 项为目标、已确认事实、未决、下一步、指针与时刻；缺项写「未核，待确认」。快照与锚点存放在会话目录内 dsh-handover/，随会话删除而消失。',
    '- 换任一步到位：ho_handover(action="rotate", text=…) 归档旧交接并写入新正文。随后由当前用户发送 /allow-reset 或点击「授权重置」，再调用 ho_sessions(action="succeed")。未获授权不得建接任会话；不得用同会话压缩冒充清空上下文。',
    '- 交接只写在途与指针，篇幅以结构控制为主。写作目标 500 行以内。单次读取超过 600 行即截断。超限先删过期内容，不删在途信息。不粘贴大段代码、日志与命令输出，需要时给出路径。',
    '- 整篇重写交接用 action="rotate"；不经该动作而手改交接的，更替会话会被拒绝。',
    '- 探查与批量任务先量后取：用脚本统计行数、字段数与文件数。不要把整份 CSV、题面或日志一次性刷进上下文。单条工具结果将超过约 100 行或 4KB 时，改用 offset/limit，或只取表头与计数。',
    '- 脚本回显只给汇总与失败项，不超过 40 行。同一批数据不为探查另写脚本；分析、生成、自测在一个脚本里完成。',
    shellWriteLine(),
    '- 原文用 ho_status(view="recall", query="…") 按 seq 回读，命中时给出前后三行。需要邻近事件时用 around 展开。',
    '- 强制线提示与强制压缩由插件执行；助手不重复调用压缩。计数达上限后助手不再压缩，由插件按硬上限兜底。',
  ];
}

/**
 * 5 种触发词的规范指针：全局段与项目、杂项段共用这一处生成，不重复维护。
 * 机制规则以插件本体为准，按 rules-read 的 doc 键读取，不指向工作区路径；
 * 工作区放同名覆盖件且有意本地化时，rules-read 自行优先，本条不必改。
 */
function triggerIndexLines() {
  return [
    '触发索引（用户说到下列词时，先读对应规范再动作）：',
    '- 「暂任」「交给外部会话」：读 `ho_docmap(action="rules-read", doc="delegation_rules")` 与 `doc="external_takeover_rules"`；承接方是不在 DSH 内的外部会话，没有 ho_* 与 peer。',
    '- 「归还」：读 `ho_docmap(action="rules-read", doc="delegation_rules")` §4 归还三法；身份字段填暂任者。',
    '- 「团队协作」：读 `ho_docmap(action="rules-read", doc="team_collab_rules")`；仅插件会话之间用 peer。',
    '- 「切换身份」：读 `ho_docmap(action="rules-read", doc="charter")` 第七章；设定用 ho_sessions(action="role", session_id=…, role=…)。',
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
    collabLine(o.guard),
    ABORT_LINE,
    SKIP_LINE,
    WRITING_POINTER,
    DELEGATION_POINTER,
    '',
    '六、按需取用',
    RUNTIME_POINTER,
    STANDARDS_POINTER,
    STANDARDS_WRITE_GLOBAL,
    ...triggerIndexLines(o),
  ];
  const sys = o.system || '';
  if (sys) lines.push('', sys);
  const cs = consentBlock(o);
  if (cs.length) lines.push('', ...cs);
  const mv = moveLine(o);
  if (mv) lines.push(mv);
  return lines.join(NL);
}

/** 项目、杂项与全局任务的提示段：写入范围、交接、流程、体系注册内容、规范指针。全部路径按布局取。 */
export function scopedManual(info, opts) {
  const o = opts || {};
  const hp = handoverPathFor(o.ws, info);
  const lay = layoutOf(info);
  const label = scopeLabel(info);
  const scope = layoutScopeOf(lay);
  const pathLines = [];
  if (lay.kind === 'project') {
    pathLines.push('库根：Projects/' + lay.name + '/；元数据：_Project_Meta/' + lay.name + '/。');
    pathLines.push('骨架：_Project_Meta/' + lay.name + '/project.profile.json；未注册时先通读本库，再调用 ho_docmap(action="profile-register")。');
    pathLines.push('临时与归档：_Temp/' + scope + '/{Snapshots,Scratch}、_Archives/' + scope + '/。');
  } else if (lay.kind === 'misc') {
    pathLines.push('任务目录：_Misc/tasks/' + lay.name + '/。');
    pathLines.push('骨架：_Misc/tasks/' + lay.name + '/task.profile.json；未注册时先通读本任务，再调用 ho_docmap(action="profile-register")。');
    pathLines.push('临时与归档：_Temp/' + scope + '/Snapshots/、_Misc/tasks/' + lay.name + '/_archive/。');
  } else if (lay.kind === 'global-task') {
    pathLines.push('任务目录：_Control_Center/tasks/' + lay.name + '/。');
    pathLines.push('骨架：_Control_Center/tasks/' + lay.name + '/task.profile.json；未注册时先通读本任务，再调用 ho_docmap(action="profile-register")。');
    pathLines.push('临时与归档：_Temp/' + scope + '/Snapshots/、_Archives/' + scope + '/。');
  } else {
    pathLines.push('本会话没有可用的体系落点：请在设置页重新设定角色。');
  }
  // 类别与布局不同时并写两者：权限看类别，落点看布局，只写一项会让会话找错目录。
  const axesLine = lay.differs
    ? '类别：' + label + '｜体系落点：' + (LAYOUT_LABEL[lay.kind] || lay.kind) + '「' + lay.name + '」。迁移未办，文件仍在后者。'
    : '';
  const head = [
    'dsh-handover 运行期（' + label + '）',
    '',
    '一、身份与边界',
  ];
  if (axesLine) head.push(axesLine);
  if (info.pending) {
    head.push('迁移待确认：文件体系仍在旧布局。本会话首轮先问当前用户是否迁移文件体系。得到答复前不移动任何文件。答复后用 ho_sessions 的 migration-choice 了结。迁移后列出文件体系，并请用户选择一键建成或先修改。');
  }
  const lines = head.concat([
    info.role === 'project'
      ? '只可写本库与元数据目录，不得写 _Control_Center 及其他项目。'
      : '只可写本任务目录与元数据目录，不得写 _Control_Center、Projects 及其他任务。',
    ...pathLines,
    hp.path
      ? '交接：' + hp.path + '（ho_handover 默认）。'
      : '交接路径未解析（缺角色或名称）。请先在设置页设定角色。',
    HANDOVER_FLOW,
    '名称已注册，不得自行修改；需要改名由全局处理。',
    ...(info.fork
      ? ['并行分叉：本会话是分叉副本，与同家族其他会话共用这份交接；交接只读、不落笔，也不改在任登记。要承接在任、接手落笔，须当前用户明确指示。']
      : []),
    '',
    ...workflowLines(o.cfg),
    '',
    ...rhythmLines(o.cfg),
    '',
    '五、交接与体系',
    '会话间可直接 peer（action="send"）。默认沉默：仅在 3 种情形下向全局报告。其一为水位达到建议线（advise）且已写交接；其二为需当前用户决定；其三为全局口径有误。任务完成不报全局。',
    WRITING_POINTER,
    DELEGATION_POINTER,
    collabLine(o.guard),
    ABORT_LINE,
    SKIP_LINE,
    '',
    '六、按需取用',
    RUNTIME_POINTER,
    STANDARDS_POINTER,
    STANDARDS_WRITE_SCOPED,
    ...triggerIndexLines(o),
  ]);
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
  if (role === 'project' || role === 'misc' || role === 'global-task') return scopedManual(info, opts);
  return '';
}

/** 迁移清单的人读摘要：只给条目数与跳过、残留项，不贴全表。 */
function changesBlock(changes) {
  const ch = Array.isArray(changes) ? changes : [];
  if (!ch.length) return [];
  const count = (op) => ch.filter((c) => c.op === op).length;
  const lines = ['迁移清单：共 ' + ch.length + ' 项（移动 ' + count('move') + '，新建目录 ' + count('mkdir')
    + '，改写 ' + count('rewrite') + '，登记 ' + count('registry') + '，跳过 ' + count('skip') + '）。'];
  for (const c of ch.filter((x) => x.op === 'skip' || x.op === 'residue').slice(0, 6)) {
    lines.push('  ' + (c.op === 'skip' ? '跳过' : '残留') + '：' + c.from + (c.note ? '（' + c.note + '）' : ''));
  }
  const manual = ch.filter((c) => c.op === 'manual').map((c) => c.from);
  if (manual.length) {
    lines.push('须由本会话改写身份字段的文件：');
    for (const f of manual) lines.push('  ' + f);
    lines.push('改写范围：System.md 的标题与描述、交接的身份与寻址一节。');
    lines.push('另含 Project_Overview.md 中涉及类别与路径的句子。逐句核对，不整篇机械替换。');
  }
  return lines;
}

/**
 * 设定角色后投递的一次性首轮消息：讨论体系、注册名称；互转时先说明迁移结果。
 * 待确认迁移时只投问句，不搬文件——搬与不搬由当前用户答复后经 migration-choice 执行。
 * 由 applyRole 在写角色表之后投递，不改变角色本身。
 */
export function firstRoundMessageFor(info, opts) {
  const o = opts || {};
  const role = info && info.role ? info.role : 'plain';
  if (role === 'plain') return '';
  const label = scopeLabel(info);
  const lay = layoutOf(info);
  const lines = [];
  lines.push('【dsh-handover 角色设定】本会话已设为「' + label + '」。');
  if (o.pending) {
    const where = o.pendingPath || '';
    lines.push('身份已切换，文件体系未动。类别为 ' + label + '，体系仍在' + (LAYOUT_LABEL[lay.kind] || lay.kind) + '「' + lay.name + '」' + (where ? '（' + where + '）' : '') + '。');
    lines.push('首轮只问不搬：先问当前用户一句「是否迁移文件体系」。得到答复前不得移动任何文件，也不得自行改角色表。');
    lines.push('报数：' + scanReportText(o.scan) + '迁到新布局后，这些写死的路径要逐一核对。');
    for (const s of scanSampleLines(o.scan, 3)) lines.push(s);
    lines.push('2 种后果：不迁移，文件零移动，只改身份与登记，体系按原位置继续使用。');
    lines.push('迁移，按清单搬移，交接、体系注册与总览中的身份字段由本会话重写。');
    lines.push('迁移后向当前用户列出文件体系，含目录结构与规范文件。请其选择：一键建成，或先修改。');
    lines.push('答复后用 ho_sessions(action="migration-choice", migrate=true 或 false) 了结。');
    lines.push('true 执行迁移并回清单，false 清除待确认、原地保留。');
  } else if (o.previousRole === 'project' || o.previousRole === 'misc') {
    if (o.inPlace) {
      lines.push('身份已改为「' + label + '」，文件已在同名布局原位，未移动、也无需询问。按新身份口径核对体系注册与交接的身份字段即可。');
    } else if (o.previousRole !== role) {
      lines.push(o.migrate === 'direct'
        ? '已按「直接建」处理：旧文件未移动，请按体系模板建立本任务体系。'
        : '已按标准流程完成迁移：' + (o.moveNote || '旧库已快照后移动，位置见交接。'));
      lines.push('若当前用户希望改用另一种方式，请说明差异，不得自行再次迁移。');
    } else {
      lines.push('角色未变：沿用既有体系与注册名。');
    }
  } else {
    lines.push('首轮按这个顺序做，不得跳步。');
    lines.push('一、先列出本会话目前已管着的文件与目录，说清哪些要继续用。');
    lines.push('二、按体系模板设计一套初步文件体系，整段贴到回复里。');
    lines.push('三、问当前用户：一键建立，还是继续讨论。');
    lines.push('四、选讨论就按意见改到用户满意为止；选一键建立才动手建目录。');
    lines.push('五、未经用户同意，不得创建任何目录，也不得写体系注册。');
  }
  for (const l of changesBlock(o.changes)) lines.push(l);
  lines.push('名称：' + (o.name ? '本会话注册名为「' + o.name + '」，不得自行修改。' : '本会话尚无注册名。与当前用户确认名称后，用 ho_sessions(action="office-register", name="…") 注册。注册后不得自行修改，改名由全局处理。'));
  lines.push('体系注册：用 ho_docmap(action="registry-write", entries=[…]) 写入目录结构、规范文件与计划。模板见任务库 rules 与 templates 目录。');
  lines.push('约束：只改动本会话所属范围；不每轮回执，不发送确认类消息。');
  return lines.join(NL);
}
