# 杂项任务规范（插件自带默认口径）

## 1 什么算杂项

一次性或短期任务：不建项目库，不进 `_Project_Meta/Registry.md`。落点 `_Misc/tasks/<任务短名>/`。

## 2 目录约定

| 路径 | 用途 |
|---|---|
| `_Misc/tasks/<任务>/` | 工作文件、`RULES.md`、`Handover.md`、`PLAN.md`、`System.md`、`Delegation_Prompt.md` |
| `_Temp/_Misc/<任务>/Snapshots/` | 覆盖前快照 |
| `_Archives/_Misc/<任务>/` | 归档 |
| `_Misc/tasks/<任务>/_archive/` | 旧计划、旧暂任提示词等任务内归档 |

## 3 边界

- 只写上述四处；`_Control_Center`、`Projects`、其他任务目录都不得写入。
- 接任：杂项须用户授权（`/allow-succeed` 或设置页），再由本会话调用 `ho_succeed`，由插件按登记表建立接任会话；不得自行新建会话。
- 交接与水位协议同项目：水位 35% 先写毕交接，水位 50% 不再新开任务，水位 85% 为硬顶；压缩至多 3 次，第 4 次换任。判断标准：35% 档要求完成剩余流程后不超过 45%，50% 档不超过 55%。

## 4 体系注册、计划与暂任

- 体系注册写 `_Misc/tasks/<任务>/System.md`，格式见 `_Control_Center/templates/System.skeleton.md`；全局总注册 `_Control_Center/records/systems.md` 只列该文件路径，由全局写。
- 行动计划写任务根 `PLAN.md`，格式见 `_Control_Center/templates/Plan.skeleton.md`；建新计划前把旧计划移入 `_archive/`，归档后不读旧计划。
- 暂任提示词写任务根 `Delegation_Prompt.md`，旧文件移入 `_archive/`；插件不检查该文件是否存在，也不检查是否已归档。暂任方只写本任务库。

## 5 升级为项目

任务转为长期项目时走身份互转：`ho_sessions(action="role", migrate="auto")` 先对源库做快照，再把 `_Misc/tasks/<名>/` 移入 `Projects/<名>/<名库>/`；注册与交接随之改位置，`_Project_Meta/Registry.md` 增行。选择 `migrate="direct"` 时不搬旧文件，按模板新建体系。两种方式均须把 `Office.json` 的类别键改为新类别，写前备份该文件。
