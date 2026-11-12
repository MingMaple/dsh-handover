# 搬迁全局根目录

适用场景：把全局根目录换到另一块盘，例如从 D: 换到 E:。全程由 `ho_workspace` 的迁移动作完成，插件不改写文件内容。

## 前提

- 先跑一次完整备份或 `ho_backup(action="snapshot", project="<项目名>")`。
- 目标父目录可以不存在，插件会自动创建；目标不得在源内部，也不得等于源。
- 切换必须在 DSH 完全退出后执行：源目录在运行期间被占用，目录改名与建链接都会失败。

## 1. 预检

设置页「移动全局根目录」卡片，或：

```text
ho_workspace(action="move-probe", to="<目标父目录>")
```

核对源总大小、文件数、目标盘可用空间、目标是否为空、是否在源内部。`to` 是父目录，`_Workspace` 会整个搬进去。

## 2. 复制并校验

```text
ho_workspace(action="move")
```

复制到新位置，两边各算一遍逐文件 sha256 清单并比对。不一致时不生成切换脚本，报告差异文件。

## 3. 切换

```text
ho_workspace(action="move-switch")
```

生成并派出后台助手，等你完全退出 DSH 后自动完成：旧目录改名为 `<旧>.old-<时间戳>`，再在原位置建 junction 指向新位置，并校验指向。日志写在 `~/.dsh/storages/dsh-handover.move.log`。

也可以双击生成的 `dsh-handover.move.cmd`。切换后原路径成为链接，工作区登记、profile 与会话工作目录都无需修改。

## 4. 改登记（仅在需要时）

切换助手完成后，若 DSH 的 `workspace.json` 或聊天集成登记仍写着旧路径，页面会提示。执行：

```text
ho_workspace(action="move-retarget")
```

只替换 JSON 文本里的路径字符串，结构不动，每份先备份 `.bak-<时间>`。

## 5. 清理旧副本

确认新位置可正常工作、并已重启 DSH 后，在设置页「移动全局根目录」卡片里输入「删除」确认，再执行：

```text
ho_workspace(action="move-cleanup", confirm=true)
```

只删匹配 `<旧>.old-` 前缀、且既不是源也不是目标的目录。此操作不可撤销。

## 回退

删除链接，把 `.old-*` 改回原名。若登记已改写，再执行一次改登记指回原路径。
