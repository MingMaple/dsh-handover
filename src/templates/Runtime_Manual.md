# dsh-handover 运行期手册

> 本文是按需取回的手册：系统提示只保留常驻段与指针，需要细节时用 `ho_charter(doc="runtime")` 取回全文，或用 `section` 参数按节取回。
>
> 内置即默认：本文、Charter 骨架、体系注册模板、行动计划模板、交接与台账骨架、提示词模板与规则文档均随插件发布（`dist/templates/`）。工作区同名文件是本地化覆盖，删除后自动回到内置版本，功能不降级。`ho_workspace(action="init")` 把默认口径写入磁盘以便修改，不是使用前提。
>
> 分工：两级任务流程、纯窗口线、水位判据、压缩与换任顺序只在会话提示段维护，本文不复述。本文只写插件用法、角色、工具、路径与各类文件的格式。口径冲突时以工作区的 `_Control_Center/rules/` 与 `_Control_Center/standards/` 为准。

## 1. 使用方式

- 按节取回：`ho_charter(doc="runtime", section="体系注册")`。不传 `section` 时只返回节标题清单，便于先看目录再取正文。
- 规则文件取回：`ho_charter(doc="handover_rules" | "migration_rules" | "misc_standard" | "delegation_rules" | "writing_rules")`；`doc="charter"` 取工作区 Charter。
- 内置兜底：工作区没有对应规则文件时，工具返回插件内置版本并注明来源，换到空白机器也不会得到空壳。
- 未接入工作区时（读不到 `_Control_Center`），插件本体仍可用；闸门、交接体检与会话水位三项无数据。
- 插件服务端是纯 Node，Windows、macOS 与 Linux 同一套代码；路径比较按平台折叠大小写，归档优先 7-Zip，没有时用内置 tar.gz。

## 2. 角色

| 角色 | 判定顺序 | 交接文件 | 可见工具 |
|---|---|---|---|
| 全局 | 角色表 → 标题含「全局」→ 已注册的工作区 | `_Control_Center/records/Global_Handover.md` | 14 个（全部） |
| 项目 | 角色表（带项目名）→ 会话目录在 `Projects/<名>/` → 首条提示含 `Projects/<名>/` | `_Project_Meta/<项目名>/Handover.md` | 11 个 |
| 杂项 | 角色表（带任务名）→ 会话目录在 `_Misc/tasks/<任务>/` | `_Misc/tasks/<任务名>/Handover.md` | 10 个 |
| 普通 | 子会话，或以上均不命中 | 无，不参与交接 | 0 个，不注入提示段 |

- 角色表位于 `~/.dsh/storages/dsh-handover.roles.json`，属本机状态，不进仓库、不进迁移包。
- 子会话默认普通；需要时由全局在角色表中指定。
- 设定入口：设置页「会话角色」；或由全局调用 `ho_sessions(action="role")`。
- 全局选项限制：本机已有全局在任时，设置页不提供「全局」选项，`ho_sessions(action="role")` 亦拒绝把其他会话设为全局；同一会话除外。
- 名称注册：会话首次用 `ho_office(action="register")` 注册自己的名字，之后不得自改；全局可沿用旧名；本机尚无全局时，才允许把当前会话设为全局。

## 3. 工具清单

共计 14 个入口，不新增工具；能力不足处复用已有入口的 `action` 参数。

### 3.1 只读

- `ho_status`：会话状态，`view` 分流——`phase`（缺省；水位、压缩次数、锁、建议动作、当前授权）、`brief`（起始简报：水位、闸门、会话清点、漂移、阶段建议）、`diag`（插件自检：服务、调度器、初始化错误、角色与工具集）、`drift`（交接漂移，Δ 为当前轮减交接轮）、`tokens`（token 体检，需会话列表）。
- `ho_gate`：通用约束条同步复核、交接文档体检、体系注册路径检查，并提示待迁移项。
- `ho_sessions`：会话清点，兼作角色设定、建会话、出提示词、归档与解归档入口。
- `ho_charter`：按节取规则正文，见 §1。
- `ho_office`：查在任，输入「全局」「全局3」「项目名」等，返回现任会话的名字与会话 id；空参数列出全部；`action="register"` 注册本会话名称。
- `ho_docmap`：本会话的体系注册，`action=read | write | check | plan`，见 §5。

### 3.2 写

- `ho_handover`：读写、新建、追加、归档本会话自己的交接；整篇重写用 `new`（先归档旧交接再新建空白写入），`write` 只用于首次创建，写后按角色体检。
- `ho_checkpoint`：写交接、体检、登记压缩、轮末自动压缩。`resume=continue`（缺省）压缩后续跑；`resume=wait` 表示任务已收尾，压缩后不唤醒。`at_risk=true` 表示关键步骤，只提醒不压缩。
- `ho_changelog`：按固定表格向台账追加一行。
- `ho_backup`：`action` 取 `snapshot`（缺省；库快照，逐字节复制、sha256 清单、来源说明）、`check`（打包前置闸门）、`pack`（打包）、`verify`（校验包是否仍为现版）、`restore`（缺省预演，覆盖前备份，从不删除目标文件）。`format=auto | 7z | tar`：本机有 7-Zip 时出 `.7z`，否则出 `.tar.gz`（内置归档器，功能等价）。
- `ho_workspace`：`action` 取 `init`（首次安装，在指定目录建立全局文件体系，可顺带注册工作区）、`scaffold`（在已部署的全局根上补齐缺失目录与说明文件，只新建、不覆盖）、`list`、`create`、`delete`（只删注册）、`migrate`（并入旧文档定位）、`move-probe | move | move-switch | move-cleanup`（搬迁全局根目录）。
- `ho_profile`：项目或杂项的骨架注册，由所属会话通读自己的库后写入并校验。
- `ho_succeed`：换任，用户授权后校验交接、按记录分配编号、建立接任会话、登记在任并投递启动提示词。

### 3.3 平级会话

- `peer`：`action` 取 `send`（投消息，`wait=true` 时同一轮等回复）、`wait`（等单个回复）、`collect`（列多个会话，先完成的先返回）、`status`（单会话详情）、`list`（一览）、`peek`（近期会话历史）、`rename`（只改标题）、`new`（新建）。`list`、`peek`、`rename` 仅全局可用；`send`、`wait`、`collect`、`status` 各角色可用；`new` 全局可用，杂项可建到杂项目录下。`wait` 与 `collect` 的 `timeout_ms` 由助手按任务预估设置，最低 120000。

### 3.4 ho_sessions 的动作

| action | 作用 | 关键参数 |
|---|---|---|
| `list`（缺省） | 会话清点 | `limit`、`warn`、`include_subagents` |
| `role` | 设定会话角色（写角色表、当场收窄工具、可选投派归位指令） | `session_id`、`role`、`project`、`task`、`notify`、`migrate` |
| `role`＋`migrate` | 身份互转方式：`auto`（缺省）先快照再移动；`direct` 不搬旧文件，按模板新建体系 | 同上 |
| `new` | 建立下一代会话并唤醒，自动投启动提示词 | `title`、`workspace`、`cwd`、`message`、`project`、`force` |
| `order` | 远程下指令：`order=handover` 令其写交接再换任；`order=compact` 为其安排压缩 | `session_id`、`order`、`resume`、`extra`、`force` |
| `prompt` | 按 `_Control_Center/templates/Prompt_Templates.md` 渲染可直接粘贴的启动提示词 | `kind`、`project`、`task`、`title`、`sessionId`、`globalSessionId` |
| `place` | 把已存在的会话移进工作区（会话目录须为该工作区根） | `session_id`、`workspace` |
| `archive` | 归档会话（相当于图形界面的删除） | `session_id`、`force` |
| `unarchive` | 解除归档 | `session_id` |

## 4. 交接路径与结构要求

### 4.1 路径

| 角色 | 交接文件 |
|---|---|
| 全局 | `_Control_Center/records/Global_Handover.md` |
| 项目 | `_Project_Meta/<项目名>/Handover.md` |
| 杂项 | `_Misc/tasks/<任务名>/Handover.md` |

各类交接不得串用：项目会话读到全局交接，等于把其他会话的状态当作自己的。

### 4.2 结构

- 全局交接应有八节：§0 身份与寻址（含七个字段）、§1 正在做的事、§2 下一步、§3 待用户决定、§4 用户要求逐条落位、§5 风险与禁区、§6 关键路径、§7 会话 id 对照。§7 至少一行带 session id，且不得残留「待回填」。
- 项目与杂项交接应含「正在做的事」（须有实质内容）与「下一步待办」（至少一条表格行或列表项）。
- 不得残留模板占位符。
- 交接类文档不设体积上限：不规定字节、行数、页数。体积由结构（只写在途与指针）、书面语与通篇归档重写控制；删减依据是「过期即删」，不是「太长就删」。
- 体检命令即工具：`ho_gate`（全部）、`ho_handover` 写后自动体检。结论取「通过」「缺节」「不合格」；「缺节」允许压缩，「不合格」须补完再压缩。

### 4.3 固定流程

交接一律重写，不在旧文件上续写。4 步按顺序执行：

1. 读上一份交接：`ho_handover(action="read")`。
2. 归档上一份交接：`ho_handover(action="archive")`。
3. 读模板：`_Control_Center/templates/Handover.md`。
4. 新建空白文件并写入：`ho_handover(action="new", text=…)`。

已有交接不得用 `action="write"` 改写，该动作只用于首次创建；`action="append"` 只用于会话中途补一行推进状态。模板写明总则、逐节写法与自检，见 `_Control_Center/templates/Handover.md`。

## 5. 体系注册

### 5.1 路径

| 类别 | 注册文件 |
|---|---|
| 全局总注册 | `_Control_Center/records/systems.md`，只列各任务体系文件的路径 |
| 全局任务 | `_Control_Center/tasks/<任务名>/System.md` |
| 项目 | `_Project_Meta/<项目名>/System.md` |
| 杂项 | `_Misc/tasks/<任务名>/System.md` |

每个任务一份体系注册，随任务库独立；全局总注册只列路径，不承载各任务正文。

### 5.2 任务级格式

一级标题写 `# 体系注册（项目「<名>」）`；下设三个二级节，标题依次为 `## 目录结构`、`## 规范文件`、`## 计划`。各节内容如下：

```text
| 路径 | 用途 |
|---|---|
| `Projects/<名>/` | 库根 |

| 路径 | 用途 | 何时读 |
|---|---|---|
| `_Project_Meta/<名>/Handover.md` | 交接 | 开轮前 |

- `PLAN.md`：当前行动计划；没有则不写本行。
```

骨架全文见 `_Control_Center/templates/System.skeleton.md`。杂项与全局任务同构，只替换标题中的类别、目录结构与规范文件路径；交接行按 §4.1 填写。

### 5.3 全局总注册格式

一级标题写 `# 体系注册（全局）`，下设一张三列表：任务、类别、体系文件。示例：

```text
| 任务 | 类别 | 体系文件 |
|---|---|---|
| Mingent | 项目 | `_Project_Meta/Mingent/System.md` |
```

### 5.4 写入与生效

- `read`：读本会话所属注册；全局读 `systems.md`。
- `write`：全文替换本注册，逐条校验路径存在；全局写总注册（条目为任务体系文件的路径）。写前留 `.bak`，写后重装本会话提示段。
- `check`：校验本会话注册（全局校验全部任务注册），返回失效路径与缺失注册。
- `plan`：`mode=read | write | archive`。`write` 写任务根 `PLAN.md`，旧计划先移到 `_archive/PLAN_<YYYYMMDD_HHMMSS>.md` 再写；`archive` 只归档；`read` 返回正文。计划写入后，确保注册文件「计划」行指向它。
- 权限：只有本类别在任会话可写；全局不代写项目与杂项的注册；全局总注册仅全局可写。
- 热更新：提示段装配时以注册文件的 `mtime+size` 为签名，签名变化即重装该会话提示段；写入后立即重装。
- 注入：全局注入 `systems.md` 内容；项目与杂项注入本注册全文。

## 6. 行动计划

- 位置：任务根 `PLAN.md`。项目为 `Projects/<名>/<名库>/PLAN.md`，杂项为 `_Misc/tasks/<任务>/PLAN.md`，全局任务为 `_Control_Center/tasks/<任务>/PLAN.md`。
- 模板：`src/templates/Plan.skeleton.md`，含目标、步骤、验收、风险、状态五节。
- 建新计划前把旧计划归档到任务根 `_archive/`，归档后不读旧计划。
- 收尾或换任时计划随任务归档；续跑提示写明「先读交接、再读计划、后执行」。
- 工具：`ho_docmap(action="plan", mode=…)`；也可用 `ho_sessions(action="prompt")` 生成带计划的启动提示词。

## 7. 暂任与协作

### 7.1 暂任提示词文件

- 位置：任务库根的 `Delegation_Prompt.md`（项目为 `Projects/<名>/<名库>/`，杂项为 `_Misc/tasks/<任务>/`，全局任务为 `_Control_Center/tasks/<任务>/`）。
- 旧提示词移入任务根 `_archive/`，此后不再读旧文件。
- 插件不检查该文件是否存在，也不检查是否已归档；文件由会话自己维护。

### 7.2 交出与归还

- 交出前先刷新交接。交出方仍是任务的在任者，暂任不改变交接归属。
- 交出方把暂任提示词写入 `Delegation_Prompt.md`，并在回复中给出可直接复制的文本，由用户转交暂任方。
- 归还时再次刷新交接，交接的身份字段填暂任者，回复中同样给出可复制文本。
- 暂任方只写本任务库，不得写 `_Control_Center`、其他项目与其他任务。

### 7.3 协作

- 两会话可直接用 `peer`（`action="send"`）协作，不必经全局转述。
- 多会话协作：协调者先用 `peer(action="collab", sessions=[…])` 注册协作，再逐个派任务，用 `collect` 列出要等的会话；谁先完成先返回，同时完成就一起返回。协作期间被交办方不能向交办者或同组成员发明文消息，工具端会拒绝；DSH 自带的 `send_message` 也由插件守卫拦住，普通对话不需要注册。`collect` 取回全部结果后限制自动解除。
- 多会话由全局统筹：全局按任务分配、查在任、协调时序；各会话默认沉默，不每轮回执。
- 协作提示词模板见 `_Control_Center/templates/Prompt_Templates.md` §8 与 §9。

## 8. 身份、名称与首轮

- 冻结名：会话自注册一次，此后不得自改；全局可沿用旧名；本机无全局时，才允许把当前会话设为全局。
- 名称注册：`ho_office(action="register")`，已有同类在任他人时拒绝；同名重复注册直接拒绝。
- 首轮：普通会话被设为项目或杂项后，插件投递一次性消息，要求先了解既有产出与任务、读体系模板、初拟体系，再二选一：全权建立并注册，或与用户讨论定稿后建立并注册。名称须用户认可，注册后不得自改。
- 身份互转：`ho_sessions(action="role", migrate=auto | direct)`。`auto` 先快照再移动；`direct` 不搬旧文件，按模板新建体系。
  - 快照：源库全库打包（无 7-Zip 时用 tar.gz），落 `_Archives/_Global/Backups/身份迁移_<YYYYMMDD_HHMMSS>/`。
  - 项目转杂项：`Projects/<名>/`（含子库）移入 `_Misc/tasks/<名>/`；交接、骨架档案、注册随之改位置。
  - 杂项转项目：`_Misc/tasks/<名>/` 移入 `Projects/<名>/<名库>/`；注册与交接改位置，`Registry.md` 增行。
  - `Office.json` 的类别键改为新类别，旧条目保留在历史中；写前备份 `Office.json`。
  - 互转首轮为二选一：迁移，或直接建立。

## 9. 迁移与恢复

1. `ho_backup({action:"check", items:[…]})` 先过前置闸门：会话静止、交接到位。
2. `ho_backup({action:"pack", kind:"project" | "task" | "global", name:"…"})` 出包，含 manifest、CHECKSUMS、MIGRATION.md 与绝对路径体检。
3. 换机：解压包、安装插件、`ho_backup({action:"verify", pack:"<包>"})` 核验包是否仍为现版。
4. `ho_backup({action:"restore", pack:"<包>", dry_run:true})` 预演，确认后传 `apply=true`。
5. 会话本身不迁移：跨机连续性只靠交接文档。
6. 旧版文档定位迁移：`ho_workspace(action="migrate")` 检测 `_Control_Center/records/docmap/`，把 `global.md`、`project-<名>.md`、`misc-<任务>.md` 的条目并入对应体系注册；旧目录全部移入 `_Archives/_Global/Backups/1.0-docmap_<YYYYMMDD_HHMMSS>/`，不删除。`ho_gate` 与 `ho_status` 在检测到旧目录时提示「待迁移」。

## 10. 设置页与搬迁

- 阈值文案为 35% 与 50%，不出现其他提醒线。
- 角色卡：修改角色需二次确认；已有全局在任时，下拉不出现「全局」。
- 不设文件体系卡，不显示计划与暂任状态；迁移卡不变。
- 使用说明与工具明细按 1.0 重写，保留 14 个工具。
- 设置页数据走宿主认证的 `/api` 载体（`/api/dsh-handover`），旧 HTTP 路由只作回退；页面内裸 `fetch` 在本机图形界面会被 403 挡回。
- 换盘四步：`ho_workspace(action="move-probe", to=…)` → `action="move"`（复制并逐文件 sha256 校验）→ `action="move-switch"`（派后台助手，退出 DSH 后自动完成改名与建链接；也可双击生成的 `dsh-handover.move.cmd`）→ `action="move-cleanup", confirm=true`。
- 切换后原路径成为指向新位置的链接（Windows 为 junction，Linux 与 macOS 为符号链接），注册表、profile 与会话目录均无需修改；回退方式为删除链接，并把 `.old-*` 改回原名。
- 切换须在 DSH 退出后执行：源目录在 DSH 运行期间被占用，目录改名与建立链接均会失败。

## 11. 首次安装与工作区

- 两个入口等价：设置页「首次安装」（粘贴已存在目录、建立全局文件体系、注册为工作区）；或在会话中执行 `ho_workspace(action="init", parent=…, register=true)`。
- 未接入工作区时，闸门、交接体检、会话水位三项无数据；插件本体仍可用。
- 注册工作区亦可单独执行 `ho_workspace(action="create", path=…, title=…)`；删除只删注册，目录与日志不动。
- 已部署的工作区在插件新增目录之后，用 `ho_workspace(action="scaffold")` 一次补齐：只建缺失项，已有文件不覆盖、内容不改。
- 首装铺开的目录为 `_Control_Center/{records,rules,standards,user,templates,tools}`、`Projects`、`_Project_Meta`、`_Misc/tasks`、`_Archives/_Global/Backups`、`_Temp`。
- 项目与杂项接入后，先读自己的库，再写 `project.profile.json` 或 `task.profile.json`，并用 `ho_profile(action="register")` 注册骨架。
- 会话标题规范见工作区 Charter；新建会话必须当场给标题。

## 12. 提示词预算与增删规则

### 12.1 分层（谁在每轮付费）

| 层 | 内容 | 何时进入上下文 | 实测参考（加权 token） |
|---|---|---|---|
| L0 常驻 | 角色段（全局段与项目、杂项段） | 每一轮 | 由冒烟打印实测值，不设上限 |
| L0 用户内容 | 全局前置提示词（用户开关，默认关闭） | 开启且非空时每轮 | 由用户自管，不计入插件预算 |
| L1 手册 | 本文件 | 按需取回，可按节取回 | 不设上限，不进每轮 |
| L2 规则与规范 | 工作区 `_Control_Center/rules/`、`_Control_Center/standards/` | 按需 | 由工作区自管 |

> 加权 token 算法：CJK 与全角标点每字符 1 token，其余每 4 字符 1 token。实测常量在 `lib/facts.mjs` 的 `TOKEN_BUDGET`；冒烟只打印实测值，不设上限，也不用于拒绝或截断。
>
> L0 是成本主体：按轮次乘算，只放每轮都要用到的判定。一个会话生命周期内只用几次的流程，一律以指针落到 L1。
>
> 同一内容只注入一份；流程规范全文进提示段，不设简版与详版。

### 12.2 布局

- 全局段六节：身份、权限、任务流程、上下文与压缩、交接与体系、按需取用。
- 项目与杂项段：写入范围、库根或任务目录、骨架、临时与归档、交接、固定流程、流程文本、体系注册内容、通用规范与写作规范指针、暂任与协作指针、会话间通信。具体行数以实际骨架为准，改动须落在既有行内。
- 普通会话：不注册任何提示段。
- 新增内容先在既有节内找位置；找不到位置，说明该内容属于 L1，不新增一节。
- 选填内容（授权提示、迁移提示行）按需追加，不占位。

### 12.3 准入四条

1. 每轮都要用到的判定才可进 L0；有明确触发时机的一次性流程，一律写指针。
2. 同一规则只写一处；由所在节表达作用域，不靠重复强调。
3. 进 L0 须指明所属节；无法归属则不进。
4. 每句都须回答：能否换成指针；不能替代的理由写入 `CHANGELOG`。

### 12.4 子智能体成本与续用

- 先核算成本：每个子智能体是一个独立会话，自带系统提示与任务提示，自身亦需十余步，结论还须回主会话审读。实测一次分模块作业派 5 个，各自占用 16% 至 20% 上下文，合计约等于另开一个会话。
- 派发须判断成本与可验收性；可脚本批量再抽检者先写脚本。派发前先报预算，以「拟派 N 个子智能体，每个不超过 M 步」的形式告知用户。
- 续用优先：工序延续不另行建立会话。子智能体完成后转入静止状态（inactive），其对话、已读文件与既定选择均保留，一次 `send_message` 即可继续。同一批文件的下一道工序须交回原作者，不得另行建立。检索既有子智能体用 `list_agents` 确认状态，并对照其上一轮交付的文件清单决定派发对象。
- 仅在三种情形下另行建立：原作者上下文将满；新工序与其产物无关；需要独立复核其结论（此时刻意改派他人，并声明属复核）。

### 12.5 增删流程

- 增：判定是否每轮需要 → 若否，写进 L1 并在「按需取用」加一行指针 → 若须进 L0，指明节次 → 跑 `blank-smoke`（体积与结构断言）→ 在 `CHANGELOG` 记录「加了什么、为什么不能是指针、体积变化」。
- 删：先查引用（冒烟断言、手册同项、其他角色段）→ 同步删除 L1 与 L0 的重复表述，避免常驻段删了而文档未补 → 再跑冒烟。
- 改：一次只改一件事；改完记录体积参考值，不设上限（提示词效果优先）。

### 12.6 检查清单

1. 体积：只记录实测参考值，不判上限。
2. 结构：全局段六节、项目与杂项各项各出现一次，顺序不变。
3. 一处一规则：会话间通信、压缩授权、交接线各只出现一次。
4. 禁止回灌：工作流细节（`ho_backup`、`move-probe`、具体命令步骤）不得出现在 L0。
5. 手册同步：凡 L0 指向的节须在本文中存在，且标题可匹配。

> 结构护栏由测试执行（节次齐全、只出现一次），不靠自觉；体积只测量，不判失败。

## 13. 授权提示与状态

- 授权由用户产生，写入 `~/.dsh/storages/dsh-handover.consent.json`，5 分钟有效、一次性、按会话计。
- 授权一到，目标会话的提示段即多一行：「用户已授权压缩，至 <时刻>（一次性，用后失效）」，或「用户已授权换任，至 <时刻>（一次性，用后失效）」；过期或用掉后消失，不占位。
- 两种授权可并存，各占一行。
- `ho_status(view="phase")` 与 `view="brief"` 都有一行「授权」，写明剩余分钟与到期时刻；向用户索要授权后先查该项，再等回话。
- 一次性后台提醒：为每个全局、项目、杂项会话注册一个提示段，装配系统提示时读取本会话水位并写状态。提醒只注入一次，不生成用户消息，不独立成轮。状态存 `~/.dsh/storages/dsh-handover.reminders.json`。

## 14. 通用规范与写作规范

- 位置 `_Control_Center/standards/`：一条规范一个子目录，目录名即规范名，正文入口为子目录内的 `README.md`；规范自带的脚本与附件放在同一子目录，不混入 `_Control_Center/tools/`。
- 作用域：任何角色的会话都可读；新增与改写由全局会话执行，项目与杂项只读。
- 写入范围：用户提到「把某某写成规范」时，未指明范围就写本会话所在的工作区；说「写入通用规范库」「写成通用规范」「写成共用规范」的，才写本目录。
- 查找范围：先看本库有无同名规范，再看本目录；两处都有时按本库那份执行，本目录那份作为通用版本。
- 写作规范固定存放于 `_Control_Center/standards/写作规范/README.md`（W-01 至 W-42），研究依据在同目录 `依据_论文.md`（只作追溯，不注入提示段）。提示段只放一行指针，不注入条款正文。
- 与相邻位置的分工：`_Control_Center/rules/` 是工作区自身的运行规则，`_Control_Center/user/` 存放用户内容与写作规则，本目录是可复用的做法，按名字被引用。
- 补齐：插件新增目录后，已部署的工作区执行 `ho_workspace(action="scaffold")`；该动作只建缺失项，已有文件不覆盖。
- 正文只写做法、判据与验收条件，不记某次作业的进度；进度归交接与台账。

## 15. 硬规定

- 对用户可见的一切一律中文，含工具 `description`、选项、清单、表格状态词。
- 时间一律带偏移书写：`2026-10-23 21:40 +0800`。
- 不虚构、不越权、不擅自删除；项目库内文件只由该项目会话自己修改。
- 界面动作写「点击」，不写其他同义单字。
- 不设发布动作：版本与发布由用户明确要求后另行处理。
