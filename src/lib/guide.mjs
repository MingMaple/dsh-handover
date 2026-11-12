/**
 * 设置页「使用说明」的内容：面向人，不面向模型。
 * 数据放宿主侧，客户端只负责渲染——改文案不用动客户端 bundle。
 * 行文用标准书面语：不用口语化的示例句，示例一律写成可以直接提的要求。
 * 水位与工具数由 facts.mjs、names.mjs 推导，不在这里重复写死。
 */
import { compactSummaryText, watermark } from './facts.mjs';
import { ALL_TOOL_NAMES } from './names.mjs';

/** 首次安装、尚未接入工作区时的下一步（设置页与工具输出共用同一份）。 */
export const SETUP_STEPS = [
  '准备一个长期存在的目录作为全局根的上级目录，不要选临时目录或下载目录。',
  '在本页下方的输入框中粘贴该目录的绝对路径，点「一键部署」：插件会在其中建立 _Workspace 与整套结构，注册为「全局」工作区，并新建一个「全局」会话。',
  '在左侧「全局」工作区中打开新会话即可开始。若只想先铺文件，可点「仅建立文件体系」，之后再注册工作区。',
  '工作区已接入但还没有全局会话时，本页会单独出现「全局会话」卡片，可随时补建。',
  '新建项目或杂项会话时，应当指明目标工作区；找不到工作区时，插件会把已注册的工作区列出来，不会静默落到别处。',
];

export function buildGuide(cfg) {
  const w = watermark(cfg);
  const compact = compactSummaryText(cfg);
  const toolCount = ALL_TOOL_NAMES.length;
  return {
  intro: [
    '本插件的全部功能都在对话中调用：不必记命令，也不必操作菜单，用中文说明要做的事，全局会话会选择相应的工具执行。',
    '工具与提示按会话角色载入：全局会话可见全部 ' + toolCount + ' 个工具，项目与杂项会话只载入自己需要的几个，普通会话不载入插件工具，也不注入提示段。角色在下方「会话角色」中指定。',
    '本页除首次安装、全局前置提示词与会话角色外均为只读；需要最新读数时，点击右上角的「刷新」。',
  ],
  situations: [
    { when: '首次安装', say: '部署全局文件体系', what: '本页「一键部署」可一次完成三件事：建文件体系、注册「全局」工作区、建「全局」会话' },
    { when: '作业开始与结束', say: '先出一份起始简报', what: '汇总上下文水位、通用约束条闸门、会话清点与阶段建议（ho_status view=brief）' },
    { when: '查阅规则', say: '把 Charter 第 7.2.3 节取出来', what: '按节返回规则正文，避免整篇读取（ho_charter；完整流程用 doc="runtime"）' },
    { when: '交接与压缩续跑', say: '先把交接文档写好，再压缩并继续', what: '写自己角色的交接、体检、登记压缩，并由助手选择压缩后去向：继续工作时用 resume=continue，任务已收尾时用 resume=wait（压缩后不唤醒）（ho_handover、ho_checkpoint）' },
    { when: '接近上下文上限', say: '查一下本会话的上下文水位', what: compact + '（ho_status view=phase；同一行还会列出当前授权及其剩余分钟）' },
    { when: '换任', say: '让在任会话自己完成换任', what: '用户先发送 /allow-succeed 授权，在任会话随后校验交接、建接任会话并登记在任（ho_succeed）；授权到达后该会话的提示段会立刻多一行，不必等它自己去查' },
    { when: '会话角色', say: '把 Demo1 设成项目角色，并让它整理自己的文件', what: '写角色表、当场收窄该会话的工具与提示、投递一次性整理指令（ho_sessions action=role / 本页会话角色）' },
    { when: '通知项目会话', say: '通知 Demo 更新交接文档', what: '投递一条消息；会话之间可直接对话，不必经全局转述；会消耗目标会话一整轮 token，应尽量少用（peer action=send）' },
    { when: '全局前置提示词', say: '把这段设为全局前置提示词', what: '保存到本机；仅在你开启且内容非空时注入全部会话，关闭或留空时不注册提示段' },
    { when: '项目骨架', say: '注册 Demo 的骨架', what: '读取、注册、校验项目或杂项的骨架档案；由该项目会话自己写文件并注册（ho_profile）' },
    { when: '文档定位', say: '把本项目的文档定位写进提示段', what: '每个血脉一份 map：路径、一句话介绍、什么时候该读；只指路，读不读由会话自己判断（ho_docmap；空 map 不注入）' },
    { when: '查看会话', say: '列出当前活跃的会话', what: '水位、运行状态、活跃或沉默、在任或前任（ho_sessions）' },
    { when: '打包迁移', say: '把 Demo 打包成迁移包', what: '收集文件、逐文件 sha256、7z、自检、绝对路径体检（ho_backup action=pack）' },
    { when: '在新机器恢复', say: '预演这次恢复', what: '校验、列出覆盖清单、备份、写入；默认仅预演（ho_backup action=restore）' },
    { when: '删除会话', say: '把这个会话归档', what: '官方仅提供归档；需要再次唤醒时须先解归档（ho_sessions action=archive、unarchive）' },
    { when: '建立工作区', say: '把这个目录注册为工作区', what: 'init 在指定目录下建整套全局文件体系；list、create、delete 管理注册，删除只删注册（ho_workspace）' },
    { when: '自检', say: '检查插件当前状态', what: '服务可解析性、压缩调度器、压缩计数、本会话角色与工具集（ho_status view=diag）' },
    { when: '查在任', say: '现在 Mingent 是谁在任', what: '按全局、项目、杂项查现任会话的名字与会话 id（ho_office）；不起会话也可用命令行 node scripts/office.mjs 同名查询' },
  ],
  groups: [
    {
      title: '只读工具（不消耗任何会话的 token）',
      tools: [
        ['ho_status', '会话状态：view=phase 水位与建议（默认）、brief 起始简报、diag 插件自检、drift 交接漂移、tokens token 体检'],
        ['ho_gate', '通用约束条闸门（按库型判定）＋交接文档体检＋文档定位 map 的路径检查'],
        ['ho_sessions', '会话清点；也用于设定角色、建会话、出提示词、归档'],
        ['ho_charter', '按节返回规则正文；doc="runtime" 取完整流程手册'],
        ['ho_office', '在任登记表：查全局、项目、杂项现在由哪个会话在任（名字与会话 id）'],
        ['ho_docmap', '本血脉的文档定位：读、写、查；只指路，不规定读多少'],
      ],
    },
    {
      title: '写工具（会改动文件；均带备份或预演）',
      tools: [
        ['ho_handover', '读写、追加、归档本会话自己的交接（写前备份、写后按角色体检）'],
        ['ho_checkpoint', '写交接、登记压缩，回合结束后自动压缩并自动续跑'],
        ['ho_changelog', '按固定表格追加一行台账'],
        ['ho_backup', 'action：snapshot 库快照、check 前置闸门、pack 打包、verify 校验、restore 恢复（默认预演）'],
        ['ho_workspace', 'init 首次建体系；list、create、delete 工作区；move-* 搬迁全局根目录'],
        ['ho_profile', '项目或杂项骨架：读取、注册、校验、取预设'],
        ['ho_succeed', '换任自服务：在任会话经用户授权后自行校验交接、建接任会话并登记在任'],
      ],
    },
    {
      title: '平级会话工具',
      tools: [
        ['peer', 'action：list 会话一览、status 单会话详情、send 投消息（耗对方 token）、peek 读近期对话、rename 改标题、new 新建'],
      ],
    },
  ],
  rules: [
    '交接线：上下文水位达到 ' + w.warn + ' 时提醒，达到 ' + w.handover + ' 时写交接并压缩，' + w.hard + ' 为硬上限；同一会话最多压缩 ' + w.max + ' 次，第四段改用新建会话。',
    '压缩不可逆：历史会被摘要替换，因此必须先写出合格的交接文档；体检未通过时，插件拒绝安排压缩。',
    '会话之间可直接 peer（action=send）对话，不必经全局转述；默认沉默仍适用：只在到交接线且已写交接、需用户决定、发现全局口径有误时发一条，任务完成不向全局报告。',
    '用户授权（压缩或换任）写入后，目标会话的提示段会立刻多一行提示与到期时刻；授权过期或用掉后自动消失，不留占位。',
    '压缩后的去向由助手在登记时选择：任务未完成用 continue 续跑，任务已收尾用 wait 静默收尾，等用户派新任务。',
    '交接文件按角色分离：全局写 _Control_Center/records/Global_Handover.md，项目写 _Project_Meta/<项目>/Handover.md，杂项写 _Misc/tasks/<任务>/Handover.md，互不串用。',
    '会话本身不迁移：跨机器、跨平台的连续性依托交接文档。',
    '全局前置提示词属于用户内容，不是插件约束；关闭或留空时不占用注入点位，可与其它提示词插件并存。',
    '项目与杂项的骨架由各自会话注册；构建型、动画型等项目不必套用插件类项目的文档集。',
    '迁移只搬运文件与清单，不改写文件内容：包内写死的绝对路径会以清单形式报出，由用户或项目会话自行修改；库内引用一律使用相对路径。',
    '插件本体为公开件，不含任何用户项目、会话或账号数据；用户数据与角色表都保存在本机。',
  ],
  };
}

/** 默认配置下的说明文本；设置页按实际配置调用 buildGuide。 */
const GUIDE = buildGuide();
