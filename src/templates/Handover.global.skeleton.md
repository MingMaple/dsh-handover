# 全局 交接文档

> 本文件由 dsh-handover 首次安装向导生成。§7 里那行 session id 是占位，第一个全局会话接手时把它换成本机真实的 id。

## 0. 身份与寻址

| 项 | 值 |
|---|---|
| 会话类型 | 全局 |
| 本任 | 待第一个全局会话接手 |
| 链内代数 | 第 1 代（本机序号，接手时核对） |
| 接任 | 无（首任） |
| 上级、报告对象 | 用户 |
| 本文件 | _Control_Center/records/Global_Handover.md |
| 冲突以谁为准 | _Control_Center/rules/Workspace_Charter.md |
| 修订 | 首次安装向导生成 |

## 1. 正在做的事

| 项 | 现状 |
|---|---|
| 初始化 | 工作区骨架已生成；等第一个标题含「全局」的会话接手 |
| 体系注册 | 全局总注册已将路径清单铺好，尚无任务入口；任务建立后由全局增行 |

## 2. 下一步

| # | 动作 | 落点 | 完成判据 |
|---|---|---|---|
| 1 | 全局会话接手：核闸门、把 §0 身份信息填实 | 本文件 §0 | ho_gate 三项全绿 |
| 2 | 按需新建项目库 | Projects/ | 各库 RULES.md 24/24 且含上下文水位自查 |
| 3 | 建立任务体系注册并登记全局总注册 | `_Control_Center/records/systems.md` | ho_docmap 检查路径全部有效 |

## 3. 待用户决定

（暂无）

## 4. 用户要求逐条落位

| # | 用户原话要点 | 状态 | 落在哪 |
|---|---|---|---|
| 1 | 安装插件并在指定目录建好全局根 | 已落地 | 本文件 |

## 5. 风险与禁区

- 禁区：改动 §8.1.1.4 的 24 行正文后，各项目库的 `RULES.md` 会与之一致性不符；确需改动须同步全部库。
- 风险：项目库内文件由该项目会话自行修改；全局代写会使交接与库内事实分离。

## 6. 关键路径

- 交接：`_Control_Center/records/Global_Handover.md`
- 规则：`_Control_Center/rules/Workspace_Charter.md`
- 体系注册：`_Control_Center/records/systems.md`（全局总注册）、`_Control_Center/tasks/` 下各全局任务的 `System.md`
- 计划：各全局任务根 `PLAN.md`
- 暂任规则：`_Control_Center/rules/Delegation_Rules.md`
- 写作规范：`_Control_Center/standards/写作规范/README.md`
- 台账：`_Control_Center/records/Global_Changelog.md`
- 提示词模板：`_Control_Center/templates/Prompt_Templates.md`

## 7. 会话 id 对照

| 角色 | session id | 状态 |
|---|---|---|
| 全局 | session-00000000-0000-0000-0000-000000000000 | 占位：接手时换成本机真实的全局会话 id |
