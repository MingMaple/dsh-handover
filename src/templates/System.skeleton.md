# 体系注册（项目「<名>」）

> 本文件是任务的体系注册，随任务库独立。建立方式：按本骨架填入实值，用 `ho_docmap(action="write", entries=…)` 或对应入口写入，逐条校验路径存在。全局总注册只列本文件路径，不承载正文。
>
> 类别与路径：项目标题写「项目「<名>」」、路径取 `_Project_Meta/<名>/System.md`；杂项标题写「杂项「<任务名>」」、路径取 `_Misc/tasks/<任务>/System.md`；全局任务标题写「全局任务「<任务名>」」、路径取 `_Control_Center/tasks/<任务>/System.md`。目录结构与规范文件按各自实际填写。
>
> 「计划」一行指向任务根 `PLAN.md`；计划归档后删除本行。路径一律写工作区相对路径，须真实存在；写入时逐条校验，任一项失效即拒绝写入。

## 目录结构

| 路径 | 用途 |
|---|---|
| `Projects/<名>/` | 库根 |
| `Projects/<名>/<名库>/` | 代码与文档主体 |
| `_Temp/<名>/Snapshots/` | 覆盖前快照 |
| `_Archives/<名>/` | 归档 |

## 规范文件

| 路径 | 用途 | 何时读 |
|---|---|---|
| `_Project_Meta/<名>/Handover.md` | 交接 | 开轮前 |
| `_Project_Meta/<名>/System.md` | 本注册 | 开轮前 |
| `Projects/<名>/<名库>/RULES.md` | 库内规则 | 作业前 |
| `_Control_Center/rules/Handover_Rules.md` | 交接规范 | 写交接前 |
| `_Control_Center/standards/写作规范/README.md` | 写作规范 | 写文档前 |
| `_Control_Center/templates/Prompt_Templates.md` | 会话提示词模板 | 建会话或暂任前 |

## 计划

- `PLAN.md`：当前行动计划；没有则不写本行。
