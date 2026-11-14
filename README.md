# dsh-handover

DeepSeek Harness（DSH）插件，用于长会话的上下文水位管理、交接文档、行动计划与体系注册。插件只使用宿主公开的扩展点，不改动 DSH 本体。

当前版本 1.0.0。支持 DSH 0.2.1-rc.2 至 0.3.0，不含 0.3.0 及其候选版；准确范围见 `package.json` 的 `engines.dsh`。

## 为什么需要

单个会话的上下文越用越多，出错概率随之上升。此时压缩上下文，或写好交接换一个会话，又会丢失已经积累的信息。

本插件一定能很好地帮助你。来试试吧；不满意，随时关闭插件并删除即可。

## 核心机制

### 任务流程

层级一为轻量任务：单文件修改、局部改名、语法修复、格式化与内容读取。此类任务直接执行，不写计划，不做查证。

用户说「讨论一下」，或助手已就流程询问过用户时，执行前须再确认。用户明确说「直接做」的除外。

层级二为繁重任务：新增功能、多文件联动、重构、架构或接口变更。按以下顺序执行。

1. 先判断纯窗口是否可能超过 40%，当前占用不计入。超过时，计划改为引入子智能体，助手只做统筹与收尾。
2. 在任务根写 `PLAN.md`，随后回看上下文核对。
3. 发现缺口时给出方案询问用户；优劣不明时并列全部方案。
4. 用户确认后执行。

子智能体提示词由助手放入规范文件地址与体系说明；插件不向其上下文注入内容。

余量不足时先刷新交接，再请求压缩或换任。恢复后按「先读交接、再读计划、后执行」继续。

### 水位与压缩

水位 35% 与 50% 时，插件各注入 1 次后台提醒。提醒只进入系统提示，不生成用户消息，也不独立成轮。

35% 档的判断标准：完成剩余流程后，上下文占用不超过 45%；50% 档为不超过 55%。

35% 后可压缩；85% 为硬上限。同一会话最多压缩 3 次，第 4 次须换任；额度用尽的判定先于水位。

压缩须用户在设置页点击「授权压缩」，单次授权 5 分钟内有效。压缩在回合结束后执行，去向取 `resume`：`continue` 续跑，`wait` 不唤醒。

压缩前刷新交接；压缩或换任后按「先读交接、再读计划、后执行」恢复。

### 交接与续跑

交接按角色分开：全局为 `_Control_Center/records/Global_Handover.md`，项目为 `_Project_Meta/<项目名>/Handover.md`，杂项为 `_Misc/tasks/<任务名>/Handover.md`。

全局任务的交接在 `_Control_Center/tasks/<任务名>/Handover.md`，由全局会话以 `ho_handover` 的 `task` 参数读写。

写交接按固定流程，4 步不可跳：`ho_handover(action="read")` 读上一份 → `action="archive"` 归档 → 读模板 `_Control_Center/templates/Handover.md` → `action="new"` 新建空白文件写入。`action="write"` 只用于首次创建，文件已存在时直接报错；`action="append"` 只用于中途补一行推进状态。归档文件名为 `<原文件名>_<YYYYMMDD_HHMMSS>.md`，同一秒重复时追加 `-2`。交接不设体积上限：体积由结构控制，只写在途与指针。已完成经过、验证记录与需求全文不进交接，分别写台账、计划或归档。

换任由在任会话办理：用户发送 `/allow-succeed` 或点击「授权换任」后，会话调用 `ho_succeed`。插件校验授权与交接结构，建立接任会话并登记在任；任一项不通过则不做任何改动。

### 行动计划

每个任务根有一份 `PLAN.md`，模板为 `_Control_Center/templates/Plan.skeleton.md`，含目标、步骤、验收、风险与状态 5 节。新建计划前，旧计划移入任务根 `_archive/`，之后不再读取；计划随任务归档。

### 体系注册

每个任务一份体系注册：项目写 `_Project_Meta/<项目名>/System.md`，杂项写 `_Misc/tasks/<任务名>/System.md`，全局任务写 `_Control_Center/tasks/<任务名>/System.md`。

全局总注册 `_Control_Center/records/systems.md` 只列各任务体系文件的路径，不承载正文。全局提示段只注入路径清单，项目与杂项提示段注入本任务注册全文。注册写入后立即重装本会话提示段。

`ho_docmap` 提供 read、write、check 与 plan 4 个动作。read 读本会话注册，write 整份替换并逐条校验路径。check 校验路径与缺失注册；plan 读写 `PLAN.md` 并归档旧计划。

只有本类别在任会话可以写入；全局不代写项目与杂项的注册。全局的 write 按磁盘任务重建总注册。

### 全局任务库

全局会话可用 `ho_sessions` 的 task-init 动作，在 `_Control_Center/tasks/<任务名>/` 建立任务库。任务库含交接、体系注册、规则与模板副本，并自动登记进全局总注册。

任务库可独立为项目或杂项会话：用 new 动作并传 `from_task`。插件先做整库快照，再一并移入并沿用现有体系，不重建、不重新注册；该动作须用户确认后执行。

### 身份互转与名称注册

项目与杂项可以互转，用 `ho_sessions` 的 role 动作并传 `migrate`。

缺省 auto：先做整库快照，再移动体系与登记。快照落在 `_Archives/_Global/Backups/身份迁移_<YYYYMMDD_HHMMSS>/`。direct：旧体系移入备份目录，新位置按模板新建体系。

项目目标为 `Projects/<项目名>/<项目名>库/`。会话首次用 `ho_office` 的 register 动作注册名称，注册后不得自行修改。名称不超过 40 个字符，不含路径分隔符；已有在任者或同名重复时拒绝注册。改名须由全局处理。

### 暂任与协作

暂任规则在任务库 `rules/Delegation_Rules.md`，协作模板在 `_Control_Center/templates/Prompt_Templates.md`。

交出前刷新交接，提示词写入任务库 `Delegation_Prompt.md`，旧文件移入 `_archive/` 且不再读取；归还时刷新交接并写明暂任者。插件不检查提示词文件是否存在，也不检查是否归档。

### 旧体系迁移

0.9.x 的文档定位在 `_Control_Center/records/docmap/`。升级后执行 `ho_workspace` 的 migrate 动作：项目与杂项的条目并入各自体系注册，全局旧内容保留为 `_Control_Center/records/global-docs.md`。

旧目录一并移入 `_Archives/_Global/Backups/1.0-docmap_<YYYYMMDD_HHMMSS>/`，不删除。

## 安装

### 从 GitHub 安装

桌面版：在侧栏「插件」中点击「添加插件」，粘贴仓库地址 `https://github.com/MingMaple/dsh-handover`。Web 界面或命令行：

```bash
dsh plugin --profile web add github:MingMaple/dsh-handover
```

### 从 npm 安装

包名为 `@mingmaple/dsh-handover`，版本与仓库同步：

```bash
dsh plugin --profile web add @mingmaple/dsh-handover
```

从本地源码安装：执行 `node scripts/build.mjs`，产物在 `dist/`；用插件管理器安装该目录并重启 DSH。

### 首次使用

1. 打开设置页中的 dsh-handover，在「首次安装」卡片粘贴一个长期目录的绝对路径。
2. 点击「一键部署」。插件在该目录建立 `_Workspace` 与全套结构，注册为全局工作区，并新建全局会话。
3. 在左侧全局工作区打开该会话。只需先铺文件时，点击「仅建立文件体系」，之后再点击「注册为工作区」。
4. 已有工作区但还没有全局会话时，设置页单独出现「全局会话」卡片，可随时补建。

命令行等价操作：`ho_workspace(action="init", parent="<全局根上级目录>", register=true)`，再新建一个标题含「全局」的会话。

## 使用

安装后直接用中文说明要做的事，不必记命令。

| 想做什么 | 可以这样说 |
|---|---|
| 看总体状态 | 先出一份起始简报 |
| 查规则 | 取出 Charter 第 7.2.3 节 |
| 交接并压缩 | 写好交接后压缩并继续 |
| 换任 | 写好交接，由本会话自行换任 |
| 查在任 | 现在全局是谁在任 |
| 设置角色 | 把 Demo1 设为项目角色 |
| 体系与计划 | 把体系注册写进提示段并建立行动计划 |
| 暂任交出 | 把本任务交给另一个会话 |
| 自检 | 检查插件当前状态 |

### 会话角色

| 角色 | 提示段 | 工具数 | 说明 |
|---|---|---|---|
| 全局 | 有 | 14 | 协调会话、维护登记与交接 |
| 项目 | 有 | 11 | 管理单个项目库 |
| 杂项 | 有 | 10 | 管理单个杂项任务 |
| 普通 | 无 | 0 | 不注入提示，不加载工具 |

代理子会话不装配插件工具与 `peer`；子会话在工具表解析阶段即被排除。

### 工具入口

1.0.0 沿用 14 个工具入口，未新增工具。状态与规则入口为 `ho_status`、`ho_gate`、`ho_charter`、`ho_sessions`、`ho_office`、`ho_docmap`。

写入与备份入口为 `ho_handover`、`ho_checkpoint`、`ho_changelog`、`ho_backup`、`ho_workspace`、`ho_profile`、`ho_succeed`；会话通信用 `peer`。

旧工具名不再注册，调用会得到未知工具提示。

### 设置页

设置页为单页卡片式，常用区展开，低频与长文段折叠。卡片含授权、移动全局根目录、会话角色、全局前置提示词与会话水位。另有通用约束条闸门、交接文档体检与插件信息。末尾有默认折叠的「工具明细」与「使用说明」；删除旧备份须先输入「删除」确认。

## 升级与故障处理

升级与搬动全局根目录见 [从 0.9.x 升级到 1.0.0](docs/migrate.md)；常见症状与处置见 [常见故障处理](docs/troubleshoot.md)。

## 写作规范与门禁

全部产出按 `_Control_Center/standards/写作规范/README.md` 的 W-01 至 W-42 执行；提示段只放一行指针，不注入规范正文。

仓库门禁含文档校验与语体门禁：`npm run test:docs`、`npm run test:style`；阻断项为 0 方可提交。

## 边界与限制

- 压缩依赖 DSH 的 `ctx.compaction` 服务；未挂载时压缩相关工具报错。
- `ptc` 呈现模式下，插件工具只能经程序调用。
- 会话水位依赖宿主保存的会话状态文件布局；字段变化时用 `ho_status(view="diag")` 排查。
- 项目名不超过 24 个字符，任务名不超过 40 个字符。名字不含路径分隔符与控制字符，不以点或空格结尾，不使用设备保留名。
- 插件重载后，已存在的会话沿用旧提示段文本；需要新文本时重启 DSH 或新建会话。
- 卸载后残留仅 `~/.dsh/storages/dsh-handover.*` 与日志目录，删除即可清零。
- 插件本体不含用户项目、会话或账号数据；用户数据与角色表保存在本机。

## 开发与测试

```bash
npm test               # 开发自测：逐个工具跑只读用例
npm run test:blank     # 空白环境验收
npm run test:smoke     # 工具装配与界面冒烟
npm run test:migrate   # 迁移与恢复端到端
npm run test:docs      # 文档校验
npm run test:style     # 语体门禁
npm run test:behavior  # 行为测试
```

源码在 `src/`；`dist/` 为构建产物，不入版本库。服务端代码替换 `dist/` 后，在插件列表停用再启用即生效。客户端构建产物不热更新，改设置页须重建并重启 DSH。

## 许可

MIT，见 [许可证](LICENSE)。
