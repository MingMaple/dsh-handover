# 配置参考

本文给需要配置本插件的使用者。内容覆盖 dsh-handover 1.1.0 的宿主配置建议、插件配置项、提示段纪律与验证命令。数值为建议值，实际以本机安装版本为准。机制正文见 [机制说明](mechanics.md)，各流程的操作见 [使用说明](usage.md)。

## 1 机制速览

分层、胶囊、锚点与快照的完整说明见 [机制说明](mechanics.md)；本节只列层级、触发与产物，便于对照配置。

| 层 | 谁执行 | 触发 | 产物 |
|---|---|---|---|
| 压力画像 | 本插件 | 本会话每轮轮首 | 末尾追加一行水位、余量与 3 档线；全量经 `ho_status(view="pressure")` 取 |
| 整理线与建议线 | 本插件注入提示，助手执行 | 水位到 soft 或 advise | 提示先写胶囊再压缩；助手调用 `ho_handover(action="compact", capsule=…)` |
| 强制线 | 本插件 | 水位到 hard 且计数未达硬上限 | 轮内同步调用 `compactRegion`；这是插件侧唯一的强制压缩路径 |
| 会话锚点 | 助手传入，插件落盘 | 每次 compact | `<会话目录>/dsh-handover/anchor.md`，默认参考上限 1500 token，超限只报告 |
| 压缩后胶囊 | 本插件 | 压缩完成 | 助手胶囊原样注入；机制胶囊只放锚点与最近 6 轮关键词摘录；渲染后 4600 字仅报告 |
| 微观快照 | 本插件 | 压缩前一次（助手入口与强制线各一次） | 6 项快照，存会话目录内 `<sid>\dsh-handover\` |
| 换任 | 在任助手 | 助手计数达 4 次或任务收尾；用户授权 | `ho_handover(action="rotate")` 一步重写交接；`ho_sessions(action="succeed")` 换任 |

原文只保留在会话日志。段索引与快照均为派生结果，删除后可从日志重建。

## 2 宿主压缩配置

DeepSeek Harness（DSH）的压缩引擎按 agent preset 挂载。本插件按 token 分档提示，只在强制线强制压缩。强制线以下由助手按 rubric 调用同一引擎的 `compactRegion`。宿主只需保持引擎默认：`thresholdRatio 0.8`、`retainRatio 0.16`，作为最后的保障。宿主阈值只读观测，插件不改宿主配置，也不要为日常压缩把阈值覆盖到 25%：

```yaml
# 保持默认即可，无需 insert 覆盖；如曾覆盖，删掉 config 两行并重启 DSH。
- id: compaction-basic
  config: {}
```

字段名以本机安装的压缩引擎为准；若 profile 中的服务 id 不同，只改 `id`。修改后重启 DSH，再新建会话验证。

### 2.1 工具输出裁剪

工具结果写入时就限制可见长度，可减少后续每一步的重读成本。该限制由宿主的长输出修剪组件负责。配置写在**所用 preset 的 cordis 配置**里，不写在本插件配置中。本插件不改用户预设，也不接管其他工具的输出。

```yaml
- id: tool-result-pruner
  name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
  config:
    thresholdChars: 8192
    headChars: 4096
    tailChars: 1024
```

| 字段 | 建议值 | 适用 |
|---|---:|---|
| `thresholdChars` | 8192 字符 | 超过该长度才修剪 |
| `headChars` | 4096 字符 | 保留开头 |
| `tailChars` | 1024 字符 | 保留结尾 |

验证：重启 DSH 后新建会话，执行一条长输出命令，观察工具结果是否只留头尾。裁剪只作用于可见投影，全文仍可从原始日志回读。宿主的组件 id 与字段名以本机安装版本为准。

### 2.2 精简 schema 清单

以下 preset 的工具 schema 可精简，只保留常用动作，减少每步固定开销：

- `ralph`
- `codex`
- `claude-code`
- `workflow`

精简原则：同一工具的动作合并到一个入口。低频动作按需加载。不保留与当前会话角色无关的工具。

## 3 插件配置项

```yaml
- insert:
    - id: dsh-handover
      name: '@mingmaple/dsh-handover'
      config:
        maxCompactionsPerSession: 4    # 助手压缩次数上限
        maxCompactionsHardCap: 6       # 强制线兜底上限
        hostSummaryRatio: 0.80         # 宿主兜底线，只读观测
        reservedOutput: 13000          # 仅用于余量展示，不参与分档
        softRatio: 0.35                # 当前窗口 × 35%
        adviseRatio: 0.50              # 当前窗口 × 50%
        hardRatioCap: 0.65             # 当前窗口 × 65%
        shadowTarget: 0.55             # auto 模式的遮蔽比
        keepMinMessages: 20            # 强制线保留尾部至少覆盖的最近消息数
        minKeepTokens: 8000            # 强制线保留尾部 token 下限
        fullCompact: true              # 助手线全量压缩；false 退回保留尾部策略
        roiFloor: 0.30                 # 压缩收益下限
        anchorMaxTokens: 1500          # 锚点总长参考上限（超限只报告，不裁剪）
        capsuleMaxChars: 4600          # 压缩后渲染参考上限（仅报告，不裁剪）
        constraintMax: 8               # 会话约束条数上限
        bypassModel: false             # 旁路语义摘要，默认关闭
        sessionScanHours: 12
```

| 键 | 作用 | 何时改 |
|---|---|---|
| `reservedOutput` | 余量展示用，不参与分档 | 展示口径变化时 |
| `softRatio` / `adviseRatio` / `hardRatioCap` | 3 档＝当前窗口 × 35%/50%/65%；不扣预留输出，窗口读不到时不判定 | 需要按窗口比例收紧时 |
| `maxCompactionsPerSession` | 助手入口与到线提示的次数上限 | 需要更早或更晚换任时 |
| `maxCompactionsHardCap` | 强制线兜底的总次数上限 | 需要放宽强制兜底时 |
| `shadowTarget` | `auto` 模式的目标遮蔽比；仅回退尾部策略时生效 | 需要一次遮蔽更多历史时 |
| `keepMinMessages` / `minKeepTokens` | 强制线保留尾部的消息条数与 token 下限 | 需要保留更多近期上下文时调大 |
| `fullCompact` | 助手线全量压缩；置 `false` 退回保留尾部策略 | 需要回滚或保留近期原文时 |
| `roiFloor` | 缩减比下限；低于此值标记 low-roi | 收益判断偏严或偏松时 |
| `anchorMaxTokens` | 锚点总长参考上限；超限只报告，不裁剪 | 需要更完整的锚点时调大 |
| `capsuleMaxChars` | 压缩后渲染参考上限；超限只报告，不裁剪 | 需要更长的胶囊正文时调大 |
| `constraintMax` | 会话约束保留条数上限 | 约束较多的任务可调大 |
| `hostSummaryRatio` | 宿主兜底线展示；不写宿主配置 | 宿主阈值变动时同步 |
| `bypassModel` | 是否启用旁路语义摘要 | 仅在确认模型可用与费用后开启 |

## 4 判据

- 分档按 token：整理线 soft、建议线 advise、强制线 hard。3 档＝当前窗口 × 35%/50%/65%，不扣预留输出、不设绝对 token。200K 窗即 70K/100K/130K，1M 窗即 350K/500K/650K。窗口读不到时不判定，不注入档位提示。
- 提示去重：同一会话同一档位只注入一次；压缩成功后重置。
- 助手执行入口：`ho_handover(action="compact", capsule=…)`。`capsule` 正文必填，trim 后上限 4000 字，超过即拒绝且不截断；渲染后 4600 字为参考上限，仅报告。前置校验为角色存在、未达助手计数上限、锚点可写、压缩锁 clean、无进行中的压缩。未闭合工具调用只在强制线校验：超过 1 个即跳过本轮并留痕。
- 压缩 rubric 给 2 组条件。可压条件为：子任务完成、阶段切换、工具结果已消费完、余量低于下一阶段增量，满足任一即可压。工具结果已消费完指噪声不低于 30%，或单条不小于 8K。缓压条件为：多步推导未落盘、有错在追、上条结果未消费、距上次压缩不足 3 轮。
- 范围与收益：助手线取全量范围，压到当前步之前；`fullCompact=false` 时退回尾部策略。强制线保留尾部至少 20 条消息与 8000 token，auto 遮蔽比 0.55、aggressive 0.70、minimal 0.40。缩减比低于 0.30 标记 low-roi。连续 2 次低收益或累计遮蔽达到 2 倍窗口时建议换任。
- 计数：助手触发与强制压缩都计。助手入口与提示在 `maxCompactionsPerSession`（默认 4）后关闭，强制线兜底至 `maxCompactionsHardCap`（默认 6），此后只办理更替会话。
- 宏观重置的 4 条只作追加提示理由。前三条为：累计遮蔽不少于 2 倍窗口；压缩增量比低于 0.5；同错或同文件重复不少于 2 次。第四条为里程碑或用户要求。
- 约束回注：锚点中的约束按原文保留；机制兜底压缩后，探针检索不到的条目由机制胶囊逐条回注。助手胶囊不追加约束段，约束与历史由助手正文、DSH 摘要与按需召回互补。

## 5 提示段纪律

以下条款并入项目、杂项与全局提示段，不另行注入。

### 5.1 压缩与交接（5 条）

1. 到 soft 或 advise 时，插件只注入提示。提示要求先做到合适断点，再进行上下文压缩流程。到建议线后先写胶囊，再按胶囊标准写。助手胶囊按 6 项写：目标、已定方案、下一步、易错点、必须遵守的约束原文、需要保留的原文位置。写好后调用 `ho_handover(action="compact", capsule=…)`。强制线由插件机制兜底压缩，插件将立即执行压缩。
2. 到 hard 时插件机制兜底压缩，助手不重复调用压缩；宿主 80% 阈值只读观测，插件不改宿主阈值。
3. 换任一步到位：`ho_handover(action="rotate", text=…)` 完成归档、写入与体检；承接项由工具返回，需自行并入新正文。随后由当前用户授权，再调用 `ho_sessions(action="succeed")`。
4. 压缩后按胶囊继续，不读旧交接全文。助手胶囊与 DSH 摘要互补。机制兜底胶囊只放目标、约束逐条原文与状态，另附最近 6 轮关键词摘录。
5. 只读判据与索引，不写会话事件；插件不制造第二事实源。

### 5.2 行为纪律（4 条）

1. 交接只写在途与指针，篇幅以结构控制为主，不规定字节与页数。写作目标 500 行以内；单次读取超过 600 行即截断。超限先删过期内容，不删在途信息。不粘贴大段代码、日志与命令输出。
2. 整篇重写交接用 `action="rotate"`，不手工编辑交接文件；微快照只在压缩前写入，助手线与强制线各一次。
3. 压缩后按胶囊继续，不复述摘要、不重做已完成事项；需要历史原文时用 `ho_status(view="recall")`。
4. 按 rubric 与当前用户要求决定何时压缩；工具返回被截断时按尾部提示缩小范围续读。

## 6 回读用法

| 场景 | 调用 |
|---|---|
| 关键词 | `ho_status(view="recall", query="部署脚本")` |
| 整句或正则 | `ho_status(view="recall", query="写入失败.*权限", mode="regex")` |
| 分词排序 | `ho_status(view="recall", query="回滚 分支", mode="bm25")` |
| 结构过滤 | `ho_status(view="recall", query="", mode="structural", filter="type:tool/result, error:true")` |
| 跨会话 | `ho_status(view="recall", query="…", session_id="session-…")`，仅全局可用 |
| 邻近事件 | `ho_status(view="recall", around=<seq>)`，展开前后各 3 条 |
| 相关度顺序 | `ho_status(view="recall", query="部署", order="relevance")` |

查询语法可组合使用：`|` 表示或，`-词` 排除，`+词` 必含，引号内为短语。
示例：`query="回滚|部署"`、`query="+回滚 -测试"`、`query='"部署 脚本"'`。
语法解析失败时按普通关键词处理，可与 `filter` 同时使用。

默认按时间顺序返回，`order="relevance"` 改按分数降序。头部给出全量命中数、合并组数与返回组数。每组给出代表 `seq`、`seq` 范围、出现次数、类型与工具、分数、段号与摘录。同类型同工具且正文相同或近似的命中合并为一组。`seqs` 为组内全部序号，输出最多展示 20 个。`offset` 为起始 `seq`，按时间顺序分页。

命中超过本次返回组数时给出截断提示。空结果返回候选段与建议关键词，并提示改用结构过滤或去掉排除词。单条返回超过 4K 字符时按头 2K 与总长分页，可用 `offset` 续读。

## 7 验证命令

```bash
node scripts/build.mjs
node src/selftest.mjs --tool all
node scripts/behavior.mjs
node scripts/blank-dsh.mjs
node scripts/blank-smoke.mjs
node scripts/e2e-migration.mjs
node scripts/check-docs.mjs
node scripts/style-gate.mjs
node scripts/portability.mjs
node scripts/recall-bench.mjs --corpus <语料目录>
```

检索验收门槛：前 3 条命中率不低于 90%，指针回读一致率 100%，空结果带建议 100%。语料只在本机使用，验收后删除，不进入发布包。

## 8 与官方预设的关系

DSH 的 agent preset（标准、PTC 模式等）决定该会话的系统提示结构与工具表。该预设可在设置里由用户自选或自改。本插件**不读取预设名、不按预设分支**，只经官方扩缝注入：

| 通道 | 插件做什么 | 预设变化时的影响 |
|---|---|---|
| 工具 | `ctx.tools.register(tool, { when })` 按角色可见性逐步装配 | 预设换了工具表也不改变本插件工具的装配判定；该预设未加载本插件时工具自然不存在 |
| 提示 | `systemPrompt.section({ name: 'dsh-handover:manual', order })` 追加本插件命名段落 | 只追加自己的段落，不改官方提示词正文 |
| 会话事件与压缩 | 只读 `session/event`；在 `agent/pre-step` 读本会话水位，轮首追加水位行，到线追加提示，强制线在轮内调用 `compactRegion`；助手入口同样在轮内调用 | 与预设无关 |

因此换预设不会改变插件的判据、快照与交接流程。插件不自带预设，也不写用户的预设文件。官方工具如何呈现（原生调用，或 PTC 折进 `run_code`）由官方决定。插件不感知这一点，也不依赖它。宿主压缩阈值属预设配置，插件只读取水位作参照，不代为修改（配置建议见 §2）。

## 9 中止语义

宿主的中止是**协作式**的：每次工具调用由调度层把调用方（本轮）的中止信号放进 `exec.signal`。工具主体必须自己观测它。宿主不会抢占正在执行的工具；不观测则一直等到主体自己结束，取消只能把结果改写成 `ABORTED`。
本插件不新造开关，只是让已有的阻塞型调用认这个官方信号，包括：

- `peer` 的 wait、collect、send 等待
- `ho_sessions(new)`
- `ho_workspace(move)` 的复制
- `ho_handover(compact)` 与强制线的轮内调用

用户点击「终止」后：

- 等待分段发现中止即返回，通常在 2 秒内，文案以「已中止：」开头。
- 已发出的消息不撤回，已建成的会话不回滚，已写入的交接与快照保留。
- 复制中断时，已复制的文件留在目标目录；不校验、不落标记、不生成切换脚本。

没有中止信号时（命令行或老宿主），等待行为与之前一致。

## 10 角色可核验与自触发留痕

建会话流程包括 `ho_sessions(action="new")`、设置页部署与补建全局会话。
创建后必须核对 `roles.json` 里已有该 `sid` 的条目。
先写一次、再读回核对；读取失败时补写一次。
仍失败即显式报错并带上会话 id，不回收已建会话。

角色为 `project`、`misc` 时先校验 `project`、`task`。
缺名直接拒绝建会话，避免建成后才在登记时失败。

自触发的每个早退分支都在运行日志留一条 `自触发跳过 sid=<sid> reason=<原因> ratio=<百分比>`：`no-sid`、`subagent`、`no-role`、`plain`、`inline-inflight`、`no-pressure`、`not-triggered`、`open-tool-calls`、`compaction-limit`。同一 `sid` 与原因 5 分钟内只写一条。

会话级产物（微快照、提示状态、段索引缓存）统一存会话目录内 `<sid>\dsh-handover\`，与会话日志同目录。会话目录被删除时随之消失；插件未加载、未运行也成立。会话目录未就绪时暂存到 `~/.dsh/storages/dsh-handover.staging/<sid>/`，会话目录出现后迁入。微快照保留最近 8 份。插件绝不写宿主的 `session.vN.jsonl[.zstd]`。
