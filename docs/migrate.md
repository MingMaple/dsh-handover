# 从 0.9.x 升级到 1.0.0

本文说明由 0.9.x 升级到 1.0.0 的步骤。1.0.0 重建了任务流程、体系注册与迁移路径，工具入口仍为 14 个。

升级顺序为：先备份，再安装 1.0.0，补齐文件体系，迁移旧文档定位，最后重载插件并验证。

## 备份

1. 完整备份全局根目录，或对每个项目执行 `ho_backup(action="snapshot", project="<项目名>")`。
2. 记录当前版本与在任会话：`ho_status(view="diag")`。
3. 确认没有未完成的目录迁移：`ho_workspace(action="move-status")`。
4. 让正在写文件的作业会话先收束到可暂停位置。

## 安装 1.0.0

1. 用插件管理器安装 1.0.0，或替换 `dist/` 后在插件列表停用再启用。
2. 重启 DeepSeek Harness（DSH）。
3. 设置页应显示 1.0.0，水位阈值为 35% 与 50%。

## 补齐文件体系

1. 已接入工作区的，执行 `ho_workspace(action="scaffold")`。
2. 尚未部署工作区的，在设置页「首次安装」卡片点击「一键部署」或「仅建立文件体系」。
3. 该动作只新建缺失的目录与文件，不覆盖既有内容。
4. 新增项包括 `_Control_Center/tasks`、`_Control_Center/records/systems.md`、`Plan.skeleton.md`、`System.skeleton.md` 与 `Delegation_Rules.md`。

## 迁移旧文档定位

1. 检测：`ho_gate` 或 `ho_status` 提示「旧文档定位待迁移」，或 `_Control_Center/records/docmap/` 仍存在。
2. 执行：`ho_workspace(action="migrate")`。
3. 结果：`project-<项目名>.md` 与 `misc-<任务名>.md` 的条目并入各自 `System.md`，已有 `System.md` 时保留原文件；`global.md` 保留为 `_Control_Center/records/global-docs.md`，不注入提示段。
4. 旧目录一并移入 `_Archives/_Global/Backups/1.0-docmap_<YYYYMMDD_HHMMSS>/docmap`，不删除。
5. 没有旧目录时，动作报告「无需迁移」。

## 重载插件与提示段

1. 服务端代码替换后在插件列表停用再启用即生效，不必重启 DSH。
2. 客户端构建产物不热更新；改设置页后须重建并重启 DSH。
3. 提示段文本不随插件重载替换；已存在的会话须重启 DSH 或新建会话后才换新。
4. 需要保留历史的会话，先写交接，再新建会话。

## 验证

1. `ho_status(view="diag")` 应报版本 1.0.0、14/14 工具与调度器就绪。
2. `ho_docmap(action="check")` 应报路径全部存在；失效项按输出修正。
3. `ho_gate` 应无「旧文档定位待迁移」提示。
4. 设置页水位阈值为 35% 与 50%，不再出现 32%。
5. 发送一条消息后，提示段应包含两级任务流程与体系注册。

## 行为变化

- 提醒线由 32% 的单线改为 35% 与 50% 共 2 条一次性提醒，投递方式为在会话的工具结果末尾追加。
- 文档定位改为体系注册：项目与杂项各一份 `System.md`，全局只列路径。
- 行动计划固定在任务根 `PLAN.md`；压缩或换任后按先交接、再计划、后执行恢复。
- 项目与杂项互转默认整库快照后移动，也可选择直接建。

## 搬动全局根目录

1. 预检：`ho_workspace(action="move-probe", to="<目标父目录>")`。
2. 复制并校验：`ho_workspace(action="move", to="<目标父目录>")`。
3. 切换：完全退出 DSH 后执行 `ho_workspace(action="move-switch")`；后台助手完成改名并建链接。
4. 改登记：需要时执行 `ho_workspace(action="move-retarget")`。
5. 清理旧备份：重启 DSH 并确认新位置可用后执行 `ho_workspace(action="move-cleanup", confirm=true)`；该操作不可撤销。
6. 链接丢失时执行 `ho_workspace(action="move-repair")`。
7. 回退：删除链接，把 `.old-<时间戳>` 目录改回原名；登记已改写时再执行一次改登记。

## 注意事项

- 迁移不删除旧文件；旧目录与新位置的备份都保留。
- 体系注册写入前留 `.bak`；交接写入前自动备份。
- 角色表与提醒状态保存在 `~/.dsh/storages/`，不随工作区迁移改变。
- 升级不改变项目与杂项的角色；身份互转须另行执行 `ho_sessions` 的 `role` 动作。
