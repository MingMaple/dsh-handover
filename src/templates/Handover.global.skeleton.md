# 全局 交接文档

> 本文件由 **dsh-handover 首次安装向导**生成。§7 里那行 session id 是**占位**——第一个全局会话接手时把它换成本机真实的 id。

## 0. 身份与寻址

| 项 | 值 |
|---|---|
| 会话类型 | 全局 |
| 本任 | 待第一个全局会话接手 |
| 链内代数 | 第 1 代（本机序号，接手时核对） |
| 接任 | 无（首任） |
| 上级、报告对象 | 用户 |
| 本文件 | _Control_Center/records/Global_Handover.md |
| 冲突以谁为准 | rules/Workspace_Charter.md |
| 修订 | 首次安装向导生成 |

## 1. 正在做的事

| 项 | 现状 |
|---|---|
| 初始化 | 工作区骨架已生成；等第一个标题含「全局」的会话接手 |

## 2. 下一步

| # | 动作 | 落点 | 完成判据 |
|---|---|---|---|
| 1 | 全局会话接手：核闸门、把 §0 身份信息填实 | 本文件 §0 | ho_gate 三项全绿 |
| 2 | 按需新建项目库 | Projects/ | 各库 RULES.md 24/24 ＋ 上下文水位自查 |

## 3. 待用户决定

（暂无）

## 4. 用户要求逐条落位

| # | 用户原话要点 | 状态 | 落在哪 |
|---|---|---|---|
| 1 | 安装插件并在指定目录建好全局根 | 已落地 | 本文件 |

## 5. 坑点与禁区

- 禁区：改 §8.1.1.4 那 24 行正文会让所有项目库对不上——要改就同步改全部库。

## 6. 关键路径

- 交接：_Control_Center/records/Global_Handover.md
- 规则：_Control_Center/rules/Workspace_Charter.md
- 台账：_Control_Center/records/Global_Changelog.md
- 提示词模板：_Control_Center/templates/Prompt_Templates.md

## 7. 会话 id 对照

| 角色 | session id | 状态 |
|---|---|---|
| 全局 | session-00000000-0000-0000-0000-000000000000 | 占位：接手时换成本机真实的全局会话 id |
