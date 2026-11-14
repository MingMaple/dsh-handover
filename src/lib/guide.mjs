/**
 * 设置页「使用说明」与「工具明细」的内容：面向人，不面向模型。
 * 数据放宿主侧，客户端只负责渲染——改文案不用动客户端 bundle。
 * 行文用标准书面语：示例一律写成可以直接提出的要求。
 * 水位与工具数由 facts.mjs、names.mjs 推导，不在这里重复写死。
 */
import { compactSummaryText, watermark } from './facts.mjs';
import { ALL_TOOL_NAMES } from './names.mjs';

/** 首次安装、尚未接入工作区时的下一步（设置页与工具输出共用同一份）。 */
export const SETUP_STEPS = [
  '准备一个长期存在的目录作为全局根的上级目录，不要选临时目录或下载目录。',
  '在本页下方的输入框中填写该目录的绝对路径，点击「一键部署」：插件会在其中建立 _Workspace 与整套结构，注册为「全局」工作区，并新建一个「全局」会话。',
  '在左侧「全局」工作区中打开新会话即可开始。若只想先铺文件，可点击「仅建立文件体系」，之后再注册工作区。',
  '工作区已接入但还没有全局会话时，本页会单独出现「全局会话」卡片，可随时补建。',
  '新建项目或杂项会话时，应当指明目标工作区；找不到工作区时，插件会把已注册的工作区列出来，不会静默落到别处。',
];

export function buildGuide(cfg) {
  const w = watermark(cfg);
  const compact = compactSummaryText(cfg);
  const toolCount = ALL_TOOL_NAMES.length;
  return {
    intro: [
      '插件功能主要在会话中调用：用中文说明要做的事，全局会话会选择相应工具执行，不必记命令；设置页另提供授权、迁移与会话角色等操作入口。',
      '工具与提示按会话角色载入：全局会话可见全部 ' + toolCount + ' 个工具，项目与杂项会话只载入所需的几个，普通会话不载入插件工具，也不注入提示段。角色在下方「会话角色」中指定。',
      '本页除首次安装、全局前置提示词与会话角色外均为只读；需要最新读数时，点击右上角的「刷新」。',
    ],
    situations: [
      { when: '首次安装', say: '部署全局文件体系', what: '本页「一键部署」一次完成三步：建立文件体系、注册「全局」工作区、建立「全局」会话' },
      { when: '作业开始与结束', say: '先出一份起始简报', what: '汇总上下文水位、通用约束条闸门、会话清点、交接漂移与阶段建议（ho_status view=brief）' },
      { when: '查阅规则', say: '取出 Charter 第 7.2.3 节', what: '按节返回规则正文，避免整篇读取；插件用法用 doc="runtime"（ho_charter）' },
      { when: '交接与压缩续跑', say: '写好交接文档后压缩并继续', what: '按固定流程重写交接（读旧交接、归档、读模板、新建写入），体检并登记压缩；未完成用 resume=continue 续跑，已收尾用 resume=wait（ho_handover、ho_checkpoint）' },
      { when: '上下文到 35% 或 50%', say: '查询本会话的上下文水位', what: compact + '；两个线各后台提醒一次，不生成用户消息（ho_status view=phase）' },
      { when: '换任', say: '让在任会话自己完成换任', what: '先由当前用户授权：聊天框发送 /allow-succeed，或在设置页「授权」卡点击「授权换任」；在任会话随后校验交接、建立接任会话并登记在任（ho_succeed）' },
      { when: '会话角色', say: '把 Demo1 设为项目角色', what: '写角色表、当场收窄该会话的工具与提示，并投递首轮体系建立指令；项目与杂项互转默认先快照再移动，也可选直接建（ho_sessions action=role）' },
      { when: '通知会话', say: '通知 Demo 更新交接文档', what: '投递一条消息；会话之间可直接通信，不必经全局转述；会消耗目标会话一整轮 token，应尽量少用（peer action=send）' },
      { when: '多会话协作', say: '把这三件事分给三个会话并收结果', what: '先逐个 send 派任务，再用 collect 列出要等的会话；谁先完成先返回，同时完成就一起返回。被派方做完即结束回合，不发确认或进度消息（peer action=collect）' },
      { when: '全局前置提示词', say: '将这段设为全局前置提示词', what: '在本页保存到本机；仅在开启且内容非空时注入全部会话，关闭或留空时不注册提示段' },
      { when: '项目骨架', say: '注册 Demo 的骨架', what: '读取、注册、校验项目或杂项的骨架档案；档案文件由该项目会话自己写（ho_profile）' },
      { when: '体系注册', say: '把本项目的体系注册写进提示段', what: '每个任务一份体系注册，写目录结构、规范文件与计划；全局总注册只列各任务体系文件路径；写入后热更新（ho_docmap action=write）' },
      { when: '行动计划', say: '为这个任务建立行动计划', what: '写任务根 PLAN.md；旧计划先归档且不再读取；压缩或换任后按「先交接、再计划、后执行」阅读（ho_docmap action=plan）' },
      { when: '暂任交出与归还', say: '把本任务交给另一个会话', what: '先刷新交接，再按任务库内 Delegation_Rules.md 把提示词写入 Delegation_Prompt.md；归还时刷新交接并在交接里写明暂任者（ho_handover）' },
      { when: '查看会话', say: '列出当前会话', what: '水位、运行状态、活跃或沉默、角色与最后活动，并给出本轮通知名单（ho_sessions）' },
      { when: '打包迁移', say: '把 Demo 打包成迁移包', what: '收集文件、逐文件 sha256、7z（无 7-Zip 时用内置 tar.gz）、自检与绝对路径体检（ho_backup action=pack）' },
      { when: '在新机器恢复', say: '预演这次恢复', what: '校验、列出覆盖清单、备份后写入；默认仅预演（ho_backup action=restore）' },
      { when: '归档会话', say: '把这个会话归档', what: 'DSH 只提供归档；再次唤醒须先解归档（ho_sessions action=archive、unarchive）' },
      { when: '建立工作区', say: '把这个目录注册为工作区', what: 'init 在指定目录下建立整套全局文件体系；list、create、delete 管理注册，删除只删注册（ho_workspace）' },
      { when: '旧体系迁移', say: '把旧文档定位并入体系注册', what: '迁移模块读取旧 docmap，并入各任务体系注册，并把旧目录归档；旧目录不删除（ho_workspace action=migrate）' },
      { when: '自检', say: '检查插件当前状态', what: '服务可用性、压缩调度器与压缩计数、本会话角色与工具集、水位与迁移状态（ho_status view=diag）' },
      { when: '查在任', say: '现在 Demo1 由谁在任', what: '按全局、项目、杂项查询现任会话的名字与会话 id（ho_office）；也可用命令行 node scripts/office.mjs 查询' },
      { when: '写作规范', say: '按写作规范检查这份文档', what: '执行 _Control_Center/standards/写作规范/README.md 的 W 条款；插件自带的语体门禁扫描 README、docs、templates 与 src' },
    ],
    groups: [
      {
        title: '只读工具（不消耗任何会话的 token）',
        tools: [
          ['ho_status', '会话状态：view=phase 水位与建议（默认）、brief 起始简报、diag 插件自检、drift 交接漂移、tokens token 体检'],
          ['ho_gate', '通用约束条闸门（按库型判定）＋交接文档体检＋体系注册路径检查'],
          ['ho_sessions', '会话清点与通知名单；也用于设定角色、身份互转、建会话、出提示词、归档'],
          ['ho_charter', '按节返回规则正文；doc="runtime" 取完整插件手册'],
          ['ho_office', '在任登记表：查在任；action=register 用于会话首次注册自己的名字'],
          ['ho_docmap', '体系注册与文档定位：read、write、check；action=plan 读写计划并归档旧计划'],
        ],
      },
      {
        title: '写工具（会改动文件；均带备份或预演）',
        tools: [
          ['ho_handover', '读写、新建、追加、归档本会话自己的交接；整篇重写用 new 先归档旧交接再新建写入，写后按角色体检'],
          ['ho_checkpoint', '写交接、登记压缩；回合结束后压缩，并按 resume 决定是否续跑'],
          ['ho_changelog', '按固定表格追加一行台账'],
          ['ho_backup', 'action：snapshot 库快照、check 前置闸门、pack 打包、verify 校验、restore 恢复（默认预演）'],
          ['ho_workspace', 'init 首次建体系；scaffold 补齐；migrate 旧体系迁移；list、create、delete 工作区；move-* 迁移全局根目录'],
          ['ho_profile', '项目或杂项骨架：读取、注册、校验、取预设'],
          ['ho_succeed', '换任自服务：在任会话经当前用户授权后自行校验交接、建接任会话并登记在任'],
        ],
      },
      {
        title: '平级会话工具',
        tools: [
          ['peer', 'action：list 会话一览、status 单会话详情、send 投消息（wait=true 同轮等回复）、wait 等单个回复、collect 收集先完成的最终回复、peek 读近期会话历史、rename 改标题、new 新建'],
        ],
      },
    ],
    rules: [
      '水位 ' + w.remind + ' 与 ' + w.remind2 + ' 各后台提醒一次；' + w.handover + ' 后可压缩，' + w.hard + ' 为硬上限；同一会话最多压缩 ' + w.max + ' 次，第 ' + (w.max + 1) + ' 次换任。',
      '压缩不可逆：历史会被摘要替换，因此必须先写出合格的交接文档；体检未通过时，插件拒绝安排压缩。',
      '压缩或换任后按「先读交接、再读计划、后执行」恢复；没有计划则跳过第二步。',
      '会话之间可直接用 peer（action=send）通信，不必经全局转述；默认沉默仍适用：仅在到交接线、需当前用户决定、发现全局口径有误时发送一条。',
      '当前用户授权（压缩或换任）写入后，目标会话的提示段会立刻多一行提示与到期时刻；授权过期或用掉后自动消失，不留占位。',
      '交接文件按角色分离：全局写 _Control_Center/records/Global_Handover.md，项目写 _Project_Meta/<项目>/Handover.md，杂项写 _Misc/tasks/<任务>/Handover.md，互不串用。',
      '体系注册按任务独立：项目在 _Project_Meta/<项目>/System.md，杂项在 _Misc/tasks/<任务>/System.md，全局任务在 _Control_Center/tasks/<任务>/System.md；全局总注册 _Control_Center/records/systems.md 只列路径。',
      '身份在项目与杂项之间互转时，先按归档规范打整库快照，再移动；用户也可选择直接建，沿用同一模板体系。',
      '会话本身不迁移：跨机器、跨平台的连续性依托交接文档。',
      '全局前置提示词属于用户内容，不是插件约束；关闭或留空时不占用注入点位。',
      '插件本体为公开件，不含任何用户项目、会话或账号数据；用户数据与角色表都保存在本机。',
    ],
  };
}

/** 默认配置下的说明文本；设置页按实际配置调用 buildGuide。 */
const GUIDE = buildGuide();
