/**
 * 设置页「使用说明」与「工具明细」的内容：面向人，不面向模型。
 * 数据放宿主侧，客户端只负责渲染——改文案不用动客户端 bundle。
 * 行文用标准书面语：示例一律写成可以直接提出的要求。
 * 水位与工具数由 facts.mjs、names.mjs 推导，不在这里重复写死。
 */
import { compactSummaryText } from './facts.mjs';
import { ALL_TOOL_NAMES } from './names.mjs';

/** 首次安装、尚未接入工作区时的下一步（设置页与工具输出共用同一份）。 */
export const SETUP_STEPS = [
  '准备一个长期保留的目录，作为全局根的上级目录；不得选用临时目录或下载目录。',
  '在本页下方的输入框中填写该目录的绝对路径，再点击「一键部署」。插件将在其中建立 _Workspace 与整套结构，注册为「全局」工作区，并新建一个「全局」会话。',
  '在左侧「全局」工作区中打开新会话，即可开始。若只需先建立文件体系，可点击「仅建立文件体系」，之后再注册工作区。',
  '工作区已接入但尚无全局会话时，本页会单独显示「全局会话」卡片，可随时补建。',
  '新建项目或杂项会话时，应指明目标工作区。找不到工作区时，插件会列出已注册的工作区，不会静默落到其他位置。',
];

export function buildGuide(cfg) {
  const max = Number(cfg && cfg.maxCompactionsPerSession) || 4;
  const compact = compactSummaryText(cfg);
  const toolCount = ALL_TOOL_NAMES.length;
  return {
    intro: [
      '插件功能主要在会话中调用：用中文说明要做的事，全局会话会选择相应工具执行，不必记命令。设置页另提供授权、迁移与会话角色等操作入口。',
      '工具与提示按会话角色载入。全局会话可见全部 ' + toolCount + ' 个工具；项目与杂项会话仅载入所需的部分工具；普通会话不载入插件工具，也不注入提示段。角色在下方「会话角色」中指定。',
      '本页除首次安装、全局前置提示词与会话角色外均为只读。需要最新读数时，点击右上角的「刷新」。',
    ],
    situations: [
      { when: '首次安装', say: '部署全局文件体系', what: '本页「一键部署」一次完成 3 步：建立文件体系、注册「全局」工作区、建立「全局」会话' },
      { when: '作业开始与结束', say: '先出一份起始简报', what: '汇总上下文水位、通用约束条闸门、会话清点、交接漂移与阶段建议（ho_status view=brief）' },
      { when: '查阅规则', say: '取出 Charter 第 7.2.3 节', what: '按节返回规则正文，避免整篇读取；插件用法请传 doc="runtime"（ho_docmap action=rules-read）' },
      { when: '交接与压缩续跑', say: '写好交接文档后压缩并继续', what: 'ho_handover action=rotate 一步完成归档旧交接、写入新正文与结构体检。承接项由返回给出。过整理线后助手择机调用 ho_handover action=compact 执行压缩。可用动作：read、rotate、archive、compact（ho_handover）' },
      { when: '上下文到线', say: '查询本会话的上下文水位与判据', what: '按 token 分档：整理线 soft、建议线 advise、强制线 hard。前两档只注入提示。强制线由插件兜底压缩，宿主 80% 只读观测（ho_status view=pressure）' },
      { when: '压缩后回读原文', say: '把第 3 段里关于部署的那几行找出来', what: '三路召回并按倒数排名融合，命中时给出 seq 指针与前后三行。空结果给出候选段与建议关键词；按 seq 展开邻近事件用 around（ho_status view=recall）' },
      { when: '换任', say: '让在任会话自己完成换任', what: '先由当前用户授权：聊天框发送 /allow-reset，或在设置页「授权」卡点击「授权重置」。在任会话随后校验交接、建立接任会话并登记在任（ho_sessions action=succeed）' },
      { when: '会话角色', say: '把 Demo1 设为项目角色', what: '写角色表，当场收窄该会话的工具与提示，并投递首轮指令以建立体系。项目与杂项互转默认先快照再移动，也可选择直接建（ho_sessions action=role）' },
      { when: '通知会话', say: '通知 Demo 更新交接文档', what: '投递一条消息，会话之间可直接通信，不必经全局转述。该动作会消耗目标会话一整轮 token，应尽量少用（peer action=send）' },
      { when: '多会话协作', say: '把这 3 件事分给 3 个会话并收结果', what: '先逐个 send 派发任务，再用 collect 列出要等待的会话。先完成者先返回，同时完成者一并返回。被派方完成即结束回合，不发送确认或进度消息（peer action=collect）' },
      { when: '全局前置提示词', say: '将这段设为全局前置提示词', what: '在本页保存到本机。仅在开启且内容非空时注入全部会话；关闭或留空时不注册提示段' },
      { when: '项目骨架', say: '注册 Demo 的骨架', what: '读取、注册与校验项目或杂项的骨架档案。档案文件由该项目会话自行写入（ho_docmap action=profile-read、profile-register）' },
      { when: '体系注册', say: '把本项目的体系注册写进提示段', what: '每个任务一份体系注册，写入目录结构、规范文件与计划。全局总注册只列各任务体系文件的路径；写入后热更新（ho_docmap action=registry-write）' },
      { when: '行动计划', say: '为这个任务建立行动计划', what: '写任务根 PLAN.md：先读模板，旧计划先归档且归档后不再读取，再新建空白文件写入。收尾时归档当前计划。压缩后按胶囊继续。换任后按先交接、再计划、后执行阅读（ho_docmap action=plan-write）' },
      { when: '暂任交出与归还', say: '把本任务交给另一个会话', what: '暂任不是换任。先刷新交接，把提示词写入任务库 Delegation_Prompt.md，回复中的代码块只给一行索引。归还时刷新交接并写明暂任者（ho_handover）' },
      { when: '查看会话', say: '列出当前会话', what: '水位、运行状态、活跃或沉默、角色与最后活动，并给出本轮通知名单（ho_sessions）' },
      { when: '打包迁移', say: '把 Demo 打包成迁移包', what: '收集文件并逐文件计算 sha256、7z 打包（无 7-Zip 时用内置 tar.gz）。随后自检并体检绝对路径（ho_workspace action=backup-pack）' },
      { when: '在新机器恢复', say: '预演这次恢复', what: '校验、列出覆盖清单、备份后写入；默认仅预演（ho_workspace action=backup-restore）' },
      { when: '归档会话', say: '把这个会话归档', what: 'DeepSeek Harness（DSH）只提供归档；再次唤醒须先解归档（ho_sessions action=archive、unarchive）' },
      { when: '建立工作区', say: '把这个目录注册为工作区', what: 'init 在指定目录下建立整套全局文件体系。list、create 与 delete 管理注册，删除只删注册（ho_workspace）' },
      { when: '自检', say: '检查插件当前状态', what: '服务可用性、压缩调度器与压缩计数、本会话角色与工具集、水位与迁移状态（ho_status view=diag）' },
      { when: '查在任', say: '现在 Demo1 由谁在任', what: '按全局、项目、杂项查询在任会话的名称与会话 id（ho_sessions action=office-read）。也可用命令行 node scripts/office.mjs 查询' },
      { when: '写作规范', say: '按写作规范检查这份文档', what: '执行 _Control_Center/standards/写作规范/README.md 所列的 W 条款；插件自带的语体门禁扫描 README、docs、templates 与 src' },
    ],
    groups: [
      {
        title: '查询与文档入口',
        tools: [
          ['ho_status', '会话状态、闸门与原文召回。view=phase 水位（默认）。pressure 压力、brief 简报、diag 自检、drift 漂移。tokens 体检、gate 闸门、recall 召回（含 around）'],
          ['ho_docmap', '体系注册、计划、骨架、台账与规则正文：action=registry-*、plan-*、profile-*、changelog-append、rules-read'],
          ['ho_sessions', '会话清点与调度：list 清点、role 设角色、new 建会话、office-read 查在任、succeed 换任、archive 归档'],
        ],
      },
      {
        title: '写入与迁移入口（改动文件时带备份或预演）',
        tools: [
          ['ho_handover', '读写、换任重写与归档本会话交接。action=rotate 归档旧交接并写入新正文，action=compact 轮内压缩。3 项前置校验通过才执行'],
          ['ho_workspace', '工作区生命周期：init、scaffold、list、create、delete、move-*；action=backup-* 管快照与迁移包'],
        ],
      },
      {
        title: '平级会话工具',
        tools: [
          ['peer', 'action：list 会话一览、status 单会话详情、send 投递消息。wait=true 时同轮等待回复。wait 等待单个回复、collect 收取先完成的最终回复。peek 读近期会话历史、rename 修改标题、new 新建'],
        ],
      },
    ],
    rules: [
      '插件按 token 分档提示：整理线 soft、建议线 advise、强制线 hard。分档按窗口纯比例：整理线 35%、建议线 50%、强制线 65%。上述均为可用窗口比例，不设绝对上限。可用窗口 = 窗口 − 预留输出 13K。200K 窗实得 65K/94K/122K，1M 窗约 345K/494K/642K。窗口读不到时退回绝对预算 80K/120K/180K。前两档只注入提示，由助手先写胶囊。再调用 ho_handover(action="compact", capsule=…)。强制线由插件兜底压缩，宿主 80% 只读观测。助手入口与提示在 ' + max + ' 次后关闭，强制线兜底至 6 次，此后只办理换任。宏观重置保留 4 条追加提示理由。其一为累计遮蔽不少于 2 倍窗口；其二为压缩增量比低于 0.5。其三为同错或同文件重复不少于 2 次；其四为里程碑或当前用户要求。',
      '压缩不可逆：历史会被摘要替换。压缩前写会话锚点，约束逐条原文保留；交接只在更替会话时使用。',
      '压缩后以胶囊为准，不读旧交接全文。换任后按「先读交接、再读计划、后执行」恢复；没有计划则跳过第二步。',
      '会话之间可直接用 peer（action=send）通信，不必经全局转述。默认沉默仍适用：仅在到交接线、需当前用户决定、发现全局口径有误时发送一条。',
      '当前用户授权（上下文重置）写入后，目标会话的提示段即增加一行提示与到期时刻。授权过期或使用后自动消失，不留占位。',
      '交接文件按角色分离：全局写 _Control_Center/records/Global_Handover.md；项目写 _Project_Meta/<项目>/Handover.md；杂项写 _Misc/tasks/<任务>/Handover.md。各类交接互不串用。',
      '体系注册按任务独立：项目在 _Project_Meta/<项目>/System.md，杂项在 _Misc/tasks/<任务>/System.md，全局任务在 _Control_Center/tasks/<任务>/System.md。全局总注册 _Control_Center/records/systems.md 只列各任务体系文件的路径。',
      '身份在项目与杂项之间互转时，先按归档规范生成整库快照，再移动。也可选择直接建，沿用同一模板体系。',
      '会话本身不迁移：跨机器、跨平台的连续性依托交接文档。',
      '全局前置提示词属于用户内容，不是插件约束。关闭或留空时不占用注入点位。',
      '插件本体为公开件，不含任何用户项目、会话或账号数据。用户数据与角色表均保存在本机。',
    ],
  };
}

/** 默认配置下的说明文本；设置页按实际配置调用 buildGuide。 */
const GUIDE = buildGuide();
