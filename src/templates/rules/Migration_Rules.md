# 迁移规范（插件自带默认口径）

> 迁移靠 `ho_backup` 四件套：`check` → `pack` → `verify` → `restore`。

## 1. 前置检查 `action="check"`

- 在役会话必须**静止**（默认 90 分钟无活动、且不在跑）。
- 交接必须存在且体检通过。
- 不通过就等，不要「先打包再说」。

## 2. 打包 `action="pack"`

- 目标：`kind=global|project|task` ＋ `name`。
- 产物含 `manifest.json`（逐文件 sha256）、`CHECKSUMS.sha256`、`MIGRATION.md`。
- 打包格式：本机有 7-Zip 时出 `.7z`；没有时自动出 `.tar.gz`（插件自带归档器，二者功能等价）。
- 包内**只报告绝对路径、不改写文件内容**——迁移后由人或项目会话按新机器改。

## 3. 校验 `action="verify"`

- 逐文件比对 sha256：一致 / 漂移 / 缺失。
- 漂移≠0 ⇒ 包已作废，必须重打。

## 4. 恢复 `action="restore"`

- **默认预演**：只报「新增 N / 覆盖 M」，不动任何文件。
- `apply=true` 才写；被覆盖的旧文件先备份到 `_Temp/_Global/Snapshots/restore-<时间>/`。
- **从不删除**目标处原有文件。
- 包内路径若是绝对路径或带 `..`，直接拒绝（防越界写盘）。

## 5. 会话不迁移

连续性只靠交接文档；新机器上由 `ho_sessions(action="new")` 建新会话，读交接后继续作业。
