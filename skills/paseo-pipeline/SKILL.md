---
name: paseo-pipeline
description: SDD 交付流水线：OpenSpec 管生命周期，Paseo profiles 管角色，Lead 只做阶段编排与并发调度。入口接受需求描述或已有 change 名。触发词：/paseo-pipeline、pipeline、并发交付。
user-invocable: true
---

# Paseo Pipeline

OpenSpec 管 SDD 生命周期（产物格式、阶段顺序、校验以 `openspec` CLI 为准），Paseo profiles 管角色，本 skill 只负责串联与并发调度。change 名是对账键，不是准入凭证。实践反例与踩坑历史见同目录 `LESSONS.md`。

**用户输入参数：** $ARGUMENTS

## 角色与派发

角色边界以 `list_profiles` 返回的 `notes` 为唯一真源，分发路由见 `~/.paseo/task-routing.md`。

| 阶段 / 职责 | profile | 说明 |
|---|---|---|
| 总控编排 | 主会话 / `agent_profile_shangshu` | **预计派发 ≥6 次或预计 >30 分钟时交 Shangshu 无人值守**，主会话只守确认点 1 与 2；微型 Pod 任务（通常 ≤3 次派发）主会话直接编排 |
| 需求转写 | `agent_profile_chanpin` | 输入已含可照抄验收条件时由 Lead 直接转写，不派 |
| 契约制宪 | `agent_profile_hanlin` | 仅大型任务使用；微型/中型由编排者（Lead）起草 |
| 契约评审 | `agent_profile_yushi` | 审查 tasks.md 正交性与反例；中型 1 轮，大型 ≤2 轮；微型 Pod 不派 |
| 现状调研 | `agent_profile_mige` | 仅修改已有代码且有非 `(new)` 锚点时派，提取 <100 行 Codebase Digest；全新模块不派 |
| 测试先行 | `agent_profile_ceshi` | 严格档（`Review: strict`）任务使用，先写 Red 测试；数学类任务写差分对拍或小定义域穷举 |
| 实现 | `agent_profile_gongbu` | 默认实现角色；复杂/打回升级 `agent_profile_gaogong`；单文件小活 `agent_profile_qingqibing` |
| 代码审计 | `agent_profile_anchasi` | 审 diff 与契约，只报 Blocker；Pod 级合并审查或按需单任务派发；深度按风险调节 |
| UI 走查 | `agent_profile_jiangzuo` | UI 任务走查体验与设计规范 |
| 僵持裁决 | `agent_profile_dalisi_gemini` / `agent_profile_dalisi` | 排除争议双方家族的中立仲裁 |
| 巡检值班 | `agent_profile_xunjian` | 进程与超时清理 |

**派发规范**：
1. **机械物化**：从 `list_profiles` 逐字段直接复制：`provider/model`、`modeId`、`thinkingOptionId`、`features`。profile 未声明的字段一律省略，严禁编造结构（如 `features: {"reason": "..."}`）。
2. **Title 防呆**：必填且限制 ≤60 字符（Paseo Schema 硬边界）。统一表达式：`title = `[Pipeline] ${role} ${action} ${change}`.slice(0, 60)`。
3. **核对与缓存**：派发后用 `get_agent_status` 读一次快照比对并采集启动时间戳。同 change 内已核对 profile 走配置指纹缓存跳过重复核对。核对一次即转入等待完成通知（`notifyOnFinish: true`），严禁轮询。

## Workspace 生命周期（全交 Paseo）

**禁止 `git worktree add/remove/prune` 与 `git branch -D`**；允许收尾使用 `git branch -d` 安全删除已合入主干的临时分支。工作树全交 Paseo 管理。

1. **分支命名**：严格使用 `integration/<name>`、`spec/<name>`、`pod/<name>`（微型 Pod 模式）、`task/<name>/<task>`（DAG 模式，重派追加 `-a<attempt>`）。
2. **创建与消除竞态**：`create_workspace` 统一带 `path: <主仓库路径>`，`background: false`。
   - **集成 workspace**：基点为主干，全 change 唯一，用于 Lead 合流与全量测试，收尾前永不归档。
   - **spec workspace**：基点为主干。**确认点 1 冻结时固定三步**：① 集成分支合入 `spec/<name>` 并跑测；② 立即 `archive_workspace` spec 工作区；③ 开始派发任务。
   - **任务/Pod workspace**：基点为 `integration/<name>`。合流成功并记账提交后方可归档。
3. **批量对账**：同轮完成通知共用一次 `list_workspaces(includeBackground: true)` 快照进行存活核对。

## 上下文协议

派发统一使用 brief 模板（Task / Context / Relevant files / Current state / What was tried / Decisions / Acceptance criteria / Constraints）：

1. **约束优先**：只给契约、不变式与 AST 锚点，不指定具体算法与实现细节。
2. **只读角色静音守则**：派发 Auditor、Critic、Arbiter、Scout 时，Constraints 固定声明：`Do not call memory/MCP knowledge tools; read only files under cwd; no network.`
3. **AST 符号锚点**：涉及已有代码改动优先标注 `文件路径#符号名`。已有符号派发前经 `codegraph_explore` 核对；新增符号标注 `(new)` 跳过核对。
4. **Scout 按需派发**：仅当任务改动已有代码且包含非 `(new)` 锚点时，由 `agent_profile_mige` 提取 Codebase Digest；全新绿地模块严禁派 Scout。

## 阶段 0：定位

无 `openspec/` 先 `openspec init --tools claude`；入参匹配已有 change 调 `openspec status --change <name> --json` 获取断点并恢复，否则视为需求描述进入阶段 1。

## 阶段 1：Spec

1. **尺寸三档分流（与风险正交）**：

| 档位 | 判据 | 产物集合 | 拓扑与执行 | 评审与门禁 |
|---|---|---|---|---|
| **微型** | 同能力域、单文件或彼此独立算子、无跨模块共享面 | 最小 delta spec + `proposal.md` + `tasks.md`（省略 `design.md`） | **Task Pod 模式**（单 workspace `pod/<name>`，按序接力，单次合流） | 不派 Critic；Auditor 单次审查 Pod 合并 diff |
| **中型** | 少数能力域、存在少量共享面或依赖链 | `proposal.md` + 每个能力域 1 份 `specs/<cap>/spec.md` + `tasks.md` | **DAG 并发模式**（单任务独立 workspace，背压 cap=3） | Critic 审 1 轮（只审 Blocker）；按需单任务派 Auditor |
| **大型** | 跨模块、深依赖、Schema 变更或核心并发 | 全套完整产物（proposal, specs, design, tasks） | **分阶段 DAG 模式**（背压 cap=3） | Critic 审 ≤2 轮；达上限未解升级人工裁决 |

**编排者分配约束**：预计派发 ≥6 次或预计 >30 分钟的 change，交 `agent_profile_shangshu` 无人值守执行，主会话只守两个人类确认点；日常微型 Pod 任务（派发通常 ≤3 次）由主会话直接编排。
**tasks.md 权属**：无论哪档，`tasks.md` 一律由编排者（Lead）直接编写或严格审核，确保 DAG 正交性、`Depends on`、`Write scope` 与 `Risk-surface` 精准。

2. **风险扫描与声明式标注**：
   - `proposal.md` 头部声明：`Risk-scan: checked [numerical, crypto/auth, concurrency, persistence, public-api, irreversible], hits: [...]`。
   - `proposal.md` 结构规范：必须包含 `## Why`、`## What Changes`（清晰标明 Added / Modified / Removed 范围）、`## Scope` 与 `## Acceptance Criteria`，杜绝归档告警。
   - `tasks.md` 每任务声明：`Risk-surface: [error-handling|numerical|...|none]`。
   - `Review: strict` 由此推导：`Risk-surface` 包含 `error-handling`（自写校验/抛错/核心边界判断）则为 strict（Tester 先写 Red 测试）；纯调用上游已校验函数或导出转写为默认档。

   - **输出值域自检（数值类 Requirement 必写）**：除输入校验外，每条数值契约须写明**输出值域**及越界行为（抛错或明确语义），并附一条"合法输入产生越界输出"的 Scenario。实测漏网：CRT 输入全为安全整数，解可超 `MAX_SAFE_INTEGER`，Spec 阶段全漏，靠 Auditor 才拦下（`SCEN-MOD-28`）。Lead 核对 tasks.md 时，凡 `Risk-surface` 含 `numerical` 的任务必须能指到这条 Scenario。

3. **Critic 评审门禁**：
   - **Blocker**：逻辑互斥精准引用两条条款与 Scenario；数值/逻辑矛盾自带 `.pipeline/repro/<critic-id>-<n>.js`（随 change 归档，以 exit 0 输出 `VERDICT: CONFIRMED` 或 `VERDICT: REFUTED`）。
   - **Advisory**：非阻断建议，不计入轮次，不阻塞流水线。

4. **机械契约对账（错误契约 + 场景双向闭环）**：
   - 调用命令：`node ~/.claude/skills/paseo-pipeline/contract-check.mjs <spec 目录> --tasks <tasks.md> [--task <id>] [--partial]`
   - 任务级带 `--task <id> --partial`：只判 `undeclared=0`，场景允许未全部覆盖。
   - 收尾全量必须双零闭环：错误契约 `undeclared=0 untested=0`，场景编号 `phantom_scens=0 untested_scens=0`。

5. **人类确认点 1：spec 冻结**：呈报概况、DAG 拓扑与 Critic 结论，经用户确认后冻结。

## 阶段 2–3：规模分流与并发调度

1. **拓扑分流执行**：
   - **Task Pod 模式**（微型同域算子，且 Write scope 不含共享文件）：
     创建单一 workspace（`branchName: "pod/<name>"`）。Tester 批量编写测试（如有） -> Runner 批量实现 -> Auditor 单次审查 Pod 合并 diff -> 一键脚本单次合流记账。
     共享入口改动（如 `index.js` 统一导出）排在 Pod 之后单步执行或置于 Pod 尾部。
   - **DAG 并发模式**（跨域或有真实依赖关系的并发任务）：
     在跑上限 cap = 3，完成通知驱动，不轮询。

2. **完成通知极简 6 步处理（<100ms 信封驱动）**：
   ① **读信封**（status/exit_code/blockers） -> ② **记意图** -> ③ **脚本合流**（单命令完成 merge、测试与 tasks.md 勾选） -> ④ **释放下游**（重算 Ready，就绪任务立即派发） -> ⑤ **留证据** -> ⑥ **异步归档**。
   逐任务流式处理，杜绝批量合并记账导致下游任务等待断流。

3. **审计不豁免，分级调深度**：
   - **Pod 级合并审查**：同域微型任务不逐任务起 Auditor，由 Auditor 在 Pod 交付后对合并 diff 审 1 轮。
   - **审查深度分级**：
     - `Review: strict` 或涉及共享文件/公共入口（如 `index.js`、`package.json`）：Auditor 使用 high thinking 深度核验边界与不变式。
     - 普通叶子任务 / Pod：Auditor 使用 low thinking 快速核对契约契合度。
   - **测试源头加固**：数学类/算法类任务，Tester 优先编写差分对拍（参考实现比对）或在小定义域内全量穷举，从测试源头杜绝缺陷漏网。

4. **Lead 上下文预算**：Lead 仅保留"任务清单 + 每任务一行状态 + workspace 表"，代码细节与大段日志不进 Lead 视野。

## 合流与自动化

Lead 在集成 workspace 内执行合流。**统一使用自动化脚本完成原子合流与记账**：

```bash
bash ~/.claude/skills/paseo-pipeline/merge-task.sh <branch> <task-id(s)> [review-tag] [test-cmd]
```

**脚本契约**：
1. 校验工作区干净，捕获 `PRE_HEAD`。
2. `git merge --no-ff --no-commit <branch>`。
3. 执行全量测试（≤60s 全量运行）；失败自动 `merge --abort` 并回滚至 `PRE_HEAD`。
4. 自动定位并更新 `tasks.md`，将 `<task-id(s)>` 标记为 `[x]` 并追加 `  - Done: merge=<task_sha> review=<review-tag>`。`review-tag` 写 `pass(<Auditor agent id 前 8 位>)`（无审计任务写 `mechanical`），可回溯到具体审查者；不写 provider/model。
5. 一次性原子提交：`feat/merge(<task-ids>): <commit-message>`。
6. 合流完成后，Lead 立即重算 Ready，释放并派发已就绪下游任务，随后归档刚合流的工作区。

**运行记录**：
每次 agent 结束当场追加实际采集值（有效 profile、起止时间、耗时、返工数、原始测试输出）。未采集字段如实写"未采集"，严禁估算填充。

## 失败处置与恢复

1. **打回**：Auditor 报 Blocker 或测试失败，打回 Runner（attempt+1，≤2 轮）；仍不过升级 Senior；再不过标 Blocked 并归档。
2. **恢复对账**（上下文压缩、重开会话、停手后续跑，一律先走这步再动作）：
   - 读 `git log --first-parent integration/<name>` 与 tasks.md Done 行，二者为唯一账本，不另建 receipts/锁文件。
   - 集成分支上有合流提交、tasks.md 无对应 Done 行：核对该提交 message 的任务号与 `Verify with`，匹配则**认领补记**，不当作外部篡改，不回滚。
   - Done 行有、提交无：以提交为准，取消勾选并上报。
   - 工作区脏或 HEAD 与最后一次已知合流 sha 不符：先 `git diff` 查来源，查清前不 merge。
   - 无第二写者/脚本被改的实证时，不以"并发写入""脚本热改"为由停手；停手须引用具体 sha 或 mtime 证据。
3. **停手报告必带续跑断点**：最后一次合流 sha、已完成/在跑/Ready 任务清单、下一条待执行动作；缺断点视为报告不合格。
4. **压缩摘要必含**：change 名、`integration/<name>` 最后合流 sha、在跑 agent id 与 workspace 三要素、下一步动作。
5. **spec 修订**：暂停派发，呈报语义差异重新经过确认点 1；作废改动任务及其传递下游。

## 收尾

1. 集成分支跑全量测试。
2. **收尾全量核对**：
   - 存在跨任务共享面或跳过独立 Auditor 的任务：派 Auditor 审查 `main...integration/<name>` 完整 diff。
   - 其余情况：直接验证 `contract-check` 全量双零通过。
3. **集成归档**：集成 workspace 内运行 `openspec archive <name> --yes` 提交。
4. **人类确认点 2：合入主干**：呈报 diff 摘要、验证日志与运行记录，同时调 `PushNotification` 发出一行摘要。确认后 fast-forward 或合入主干。
5. 归档集成 workspace，使用 `git branch -d` 安全清理已合入主干的临时分支。

## 冒烟验证清单

| 观测项 | 通过标准 | 采集方式 |
|---|---|---|
| Lead 派发延迟 | ≤ 60s / 次 | 完成通知时间戳 − 下一个 agent 的 `createdAt` |
| 上下文压缩 | 0 次 | 会话内压缩事件计数 |
| 阶段耗时 | spec 阶段 ≤ 实现阶段 | 时间戳区间差 |
| 收尾核对 | 一条 `contract-check` 全量双零通过 | 实际收尾日志 |

## 适用边界（不过度设计）

本 skill 是敏捷编排层，**不重造 Loom 内核已有能力**：确定性事件账本、物理收据与重放、密封沙箱、墙钟硬约束属于 Loom 管辖交付（见 `loom-policy.md`），核心资产、资金、无人值守合入走 Loom。Paseo 只在实测暴露缺陷时加门禁，每项加固须指向一次实测反例。

## 授权与真源

- **免审**：子 agent 创建/打回/归档；workspace 与临时分支生命周期；集成分支合流。
- **必审**：确认点 1（spec 冻结）、确认点 2（合入主干）。
- **真源**：契约与进度在 `openspec/changes/<name>/`；运行态在 Paseo labels。不设第二账本。
