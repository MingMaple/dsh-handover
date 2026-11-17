# 杂项任务规范（插件自带默认口径）

## 1 什么算杂项

一次性或短期任务：不建项目库，不进 `_Project_Meta/Registry.md`。存放位置为 `_Misc/tasks/<任务短名>/`。

## 2 目录约定

| 路径 | 用途 |
|---|---|
| `_Misc/tasks/<任务>/` | 工作文件、`RULES.md`、`Handover.md`、`PLAN.md`、`System.md`、`Delegation_Prompt.md` |
| `_Temp/_Misc/<任务>/Snapshots/` | 覆盖前快照 |
| `_Archives/_Misc/<任务>/` | 归档 |
| `_Misc/tasks/<任务>/_archive/` | 旧计划、旧暂任提示词等任务内归档 |

## 3 边界

- 只写上述 4 处；`_Control_Center`、`Projects`、其他任务目录都不得写入。
- 接任：杂项任务须当前用户授权（`/allow-reset` 或设置页），再由本会话调用 `ho_sessions(action="succeed")`，由插件按登记表建立接任会话。不得自行新建会话。
- 交接与压缩：分档按 token，整理线 soft、建议线 advise、强制线 hard。各档按窗口纯比例计算：整理线 35%、建议线 50%、强制线 65%。各档均为可用窗口比例，不设绝对上限。可用窗口 = 窗口 − 预留输出 13K。200K 窗实得 65K/94K/122K，1M 窗约 345K/494K/642K。窗口读不到时退回绝对预算 80K/120K/180K。前两档只提示。助手在子任务闭环或阶段切换时先写胶囊，再调用 `ho_handover(action="compact", capsule=…)`。强制线由插件兜底压缩。宿主 80% 兜底，插件不改宿主阈值。

## 4 体系注册、计划与暂任

- 体系注册写 `_Misc/tasks/<任务>/System.md`，格式见 `_Control_Center/templates/System.skeleton.md`；全局总注册 `_Control_Center/records/systems.md` 只列该文件路径，由全局会话写入。
- 行动计划写任务根 `PLAN.md`，固定流程：先读模板 `_Control_Center/templates/Plan.skeleton.md` → 旧计划移入 `_archive/` → 新建空白文件 → 按 5 节写入。归档后不读旧计划，也不在旧计划上改写。任务收尾时归档当前计划，并删除注册中的「计划」一行。
- 暂任提示词写任务根 `Delegation_Prompt.md`，旧文件移入 `_archive/`；插件不检查该文件是否存在，也不检查是否已归档。暂任方只写本任务库。

## 5 升级为项目

任务转为长期项目时通过身份互转完成。先执行 `ho_sessions(action="role", migrate="auto")`，对源库做快照。再把 `_Misc/tasks/<名>/` 的内容移入 `Projects/<名>/<名库>/`。注册与交接随之改位置，`_Project_Meta/Registry.md` 增行。反向（项目转杂项）把库内容移入 `_Misc/tasks/<名>/` 本身，不保留 `<名库>` 包装层，来回转换不会层层嵌套。选择 `migrate="direct"` 时不移动旧文件，按模板新建体系。2 种方式均须将 `Office.json` 的类别键改为新类别，写前备份该文件。
