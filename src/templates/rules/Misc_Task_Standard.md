# 杂项任务规范（插件自带默认口径）

## 1. 什么算杂项

一次性或短期任务：不建项目库、不进 `_Project_Meta/Registry.md`。落点 `_Misc/tasks/<任务短名>/`。

## 2. 目录约定

| 路径 | 用途 |
|---|---|
| `_Misc/tasks/<任务>/` | 工作文件、`RULES.md`、`Handover.md` |
| `_Temp/_Misc/<任务>/Snapshots/` | 覆盖前快照 |
| `_Archives/_Misc/<任务>/` | 归档 |

## 3. 边界

- 只写上面三处；`_Control_Center`、`Projects`、其他任务目录都不得写入。
- 接任：杂项须用户授权（`/allow-succeed` 或设置页），再由本会话调用 `ho_succeed`，由插件按登记表建立接任会话；项目会话不得自行新建会话。
- 交接与水位协议同项目（32% 提醒 / 35% 交接线 / 85% 硬顶）。

## 4. 升级为项目

任务变成长期项目时：建 `Projects/<名>/<名>库/`，移入工作文件，写 `_Project_Meta/<名>/`，再由全局登记进 `Registry.md`。
