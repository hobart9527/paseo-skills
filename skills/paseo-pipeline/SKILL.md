---
name: paseo-pipeline
description: SDD 交付流水线：OpenSpec 管生命周期，Paseo profiles 管角色，Lead 只做阶段编排与并发调度。入口接受需求描述或已有 change 名。触发词：/paseo-pipeline、pipeline、并发交付。
user-invocable: true
---

# Paseo Pipeline

OpenSpec 管 SDD 生命周期（产物格式、阶段顺序、校验以 `openspec` CLI 为准），Paseo profiles 管角色，本 skill 负责串联与并发调度。change 名是对账键，不是准入凭证。实测反例与历史踩坑见同目录 `LESSONS.md`（证据与历史，不是规程；冲突时以本文件为准）。

**OpenSpec CLI 主会话独占**：所有 `openspec` CLI 命令（`init`、`new`、`validate`、`archive`）由主会话独占执行。派出的子 Agent 与 Lead 只能只读读取 `openspec/changes/<name>/` 下的产物文件，禁止执行 `openspec` 命令，防止多进程破坏状态。Lead 遇到需要生命周期命令的时刻，按下文「OpenSpec 交回点」发起唯一待办请求，不得自行代跑。

**用户输入参数：** $ARGUMENTS

## 0. 完成定义（先读这一节）

流水线上有四种「完成」，**不得混称，不得以一种替代另一种**：

| 名称 | 含义 | 判据 |
|---|---|---|
| 阶段信封完成 | 某个 Agent 跑完了它那一轮 | Agent 提交 `phase-complete` 信封 |
| 任务合流 | 任务产物已进入集成历史并记账 | `merge-task.mjs` 成功，`tasks.md` 出现 Done 行 |
| 集成业务验收 | 功能在集成环境按真实入口端到端可用 | 冻结的业务验收矩阵逐项通过（见第 3 节） |
| 主干合入 | 集成历史进入主干 | **人类确认点 2**，未经确认禁止 |

**收尾不是「跑一遍全量单测 + 跑一遍证据格式检查」。** 单测通过只证明模块级行为；`check-evidence` 的**结构闸门**对 FAIL 也返回 exit 0（FAIL 调查报告是合法留档）。真正的验收判据是第 3 节的验收闸门与业务验收矩阵。**证据格式合法 ≠ 能力验收通过。**

## 1. 角色与派发

角色边界以 `list_profiles` 返回的 `notes` 为唯一真源，分发路由见 `~/.paseo/task-routing.md`。派发时不硬编码任何模型名称。

| 阶段 / 职责 | profile | 说明 |
|---|---|---|
| 总控编排 | 主会话 / `agent_profile_shangshu` | 预计派发 ≥6 次或预计 >30 分钟时交 Shangshu 无人值守，主会话只守确认点 1 与 2；微型 Pod 任务（通常 ≤3 次派发）主会话直接编排 |
| 需求调研 | `agent_profile_chanpin` | 产品需求规划与现状调研（吸收原 Scout 侦察兵职能，提取 Codebase Digest） |
| 契约制宪 | `agent_profile_hanlin` | 架构与契约设计；微型/中型由编排者起草；兼任架构争议裁决（吸收原 Arbiter 仲裁官职能） |
| 测试先行 | `agent_profile_ceshi` | 严格档（`Review: strict`）任务使用，先写 Red 测试；数学类任务写差分对拍或小定义域穷举 |
| 代码实现 | `agent_profile_gongbu` | 默认实现角色；兼顾极速轻量执行（吸收原 Pi-Runner 轻骑兵职能） |
| 复杂攻坚 | `agent_profile_gaogong` | 复杂任务（跨模块、并发、状态机）实现与打回升级重做 |
| 代码审计 | `agent_profile_anchasi` | 审 diff、spec 场景与 tasks.md 正交性，只报 Blocker；吸收原 Critic 挑刺官职能 |
| UI/原型 | `agent_profile_jiangzuo` | UI/UX 方案原型构建与多视口截图走查（吸收原 Builder 营造师职能） |

**原生 MCP 派发（默认路径）**：派发通过 agent 作用域原生 MCP `create_agent`/`send_agent_prompt` 执行。

**派发 brief 用模板，不要临时拼**：`templates/` 下四份（`writer` / `tester` / `auditor` / `lead`），固定字段为「目标与不变式、base SHA、Write scope、Verify 命令、必填 trailers、信封格式」。模板只保证**字段齐备**，行数按字段需要写，不做行数上限——2026-10-26 冒烟里跑通的那份 Lead brief 是 100 行。省略字段的后果是实测过的：brief 漏写 `pipeline.disposition` 生产者契约，Lead 只能从源码反推，T-1 被 `UNRESOLVED` 锁死一轮。

- 参数源头：`provider`、`settings.modeId`、`settings.thinkingOptionId`、`settings.features` 均取自当前活态 `list_profiles`（其中的 `featureValues→settings.features` 逐字复制）。缺省字段直接省略，禁止编造默认值。
- 通知约束：`notifyOnFinish: true`（默认启用，不可关闭），通知到达驱动后续流转。
- 标签体系：必须打齐 `pipeline.change`、`pipeline.task`、`pipeline.attempt`、`pipeline.phase`、`pipeline.role`。这五个标签是 `reconcile` 做归属、cap 计数与 phase 排序的唯一依据，缺一即该 agent 被判 `UNMAPPED`。
- 标题约束：`title` ≤60 字符，格式为 `[Pipeline] ${role} ${task} ${change}`。归属匹配是**单向**的：标题尾 token 是 change 的截断前缀才成立归属；反向（token 比 change 长，如 `foo` 撞 `foo-bar`）不成立——长 token 是另一个 change 的完整 slug，互绑会让两个 change 互占 cap。
- **派发前先认领意图**：每次派发前先 `run-state.mjs claim`（见第 4 节），拿到 agent 后立刻 `record`。这堵住「创建请求已发出、回执尚未返回」窗口里的重复派发。
- **阶段完成后由编排者打处置标签**：子 agent 走到终态后，编排者核对产出（改了哪些文件、`Verify with` 是否跑通），再 `update_agent` 写 `pipeline.disposition`：
  | 取值 | 语义（`lib/roles.mjs` 的 `DISPOSITION_EFFECT`） | 何时用 |
  |---|---|---|
  | `handed-off` | `continue` | 阶段正常交接，产出已核对、准备合流或已合流 |
  | `superseded` | `continue` | 被更新的 attempt 取代 |
  | `merged` | `verify` | agent 自称已合流，**仍需 first-parent 账本证明**，自报不算验收 |
  | `rejected` / `abandoned` | `retry` | 本轮产出未被接受，消耗打回预算 |
  **不打这个标签，`reconcile` 会把该任务的终态 agent 判为 `UNRESOLVED` 并压住它的推进**（fail-closed，不是缺陷）。生产者是编排者，不是子 agent 自报。

**Legacy CLI 路径（`hotfix.sh`）**：该脚本用 `paseo run --no-wait` 派发，**拿不到父子 Agent 完成通知**（该通路的回调从未被验证过）。因此它的正确用法只有一种：调用方**同步 `paseo wait`** 阻塞等结果，绝不把它当成「派完就走、靠通知回来」的异步路径。`dispatch.mjs` 已在 2026-10-26 删除——它是同一路径的另一个入口，从来没有使用者，保留只会让「legacy 兜底」被当成一条可选主路径。

- `hotfix.sh`：**L1 小修正式入口**（单任务、`Review: mechanical`、`Risk-surface: none`）。它自己 `paseo wait`，所以不依赖那条未验证的回调。脚本在派发前机械校验 mechanical/Risk-surface，不合立即拒绝；合流 review 标签用真实 tip/base 生成。意图记账同样强制：派发前 `run-state.mjs claim`、拿到 agent 后 `record`、`paseo run` 失败时 `fail` 作废意图——claim 被拒（重复意图、账本被占用或存在有效编排租约）即中止，**存在有效租约时 hotfix 不带 `--owner` 必然被拒**，这是预期：编排进行中不得走旁路快轨，须等租约到期或由 owner 执行。这几点都是脚本行为，不靠提示词自觉。

## 2. 执行主路径

四段式：定位/恢复 → 冻结前准备 → 执行循环 → 验收与交回。参考协议（信封、去重、权限、重试预算、合流门禁、证据闸门）在后续按需查阅，主路径不重复。

### 2.0 定位与恢复

1. 无 `openspec/` 先 `openspec init --tools claude`（主会话执行）。
2. 入参匹配已有 change：由**主会话**跑 `openspec status --change <name> --json` 取断点，再把结论交给 Lead。Lead 自己只读 `openspec/changes/<name>/` 下的产物文件，不执行 `openspec` 命令（见开篇「OpenSpec CLI 主会话独占」）；它需要生命周期信息时走「OpenSpec 交回点」发请求，不得自行代跑。
3. **任何断链、接手或不确定时刻**，先跑一次只读对账拿真实态：
   ```bash
   node skills/paseo-pipeline/reconcile.mjs <change>
   ```
   它只读 `tasks.md` + git first-parent 账本 + Paseo 运行态 + 运行账本，输出任务分类、hold 原因与有序 `NEXT`/`ALSO` 动作。**以 `NEXT` 为准推进，不要凭记忆或聊天内容推断。**
   - `NEXT <kind>: <reason>` 是当前主行动；`ALSO <kind>: <reason>` 是同一轮里可并行的其余动作（例如「先仲裁 T-01 的孤儿意图，同时把已就绪的 T-02 派出去」）。**`ALSO` 不是提示，是同一决策里的可执行动作，不要再跑一次对账去拿它。**
   - 只有全局性阻断（`runtime` 非 `ok`、`UNMAPPED` 非空、无依赖的 `BLOCKED`）才会压住全部动作并给出单一 hold。单个任务的 `INVALID`/`UNRESOLVED`/预算耗尽**只压住被点名的任务**，不得冻结无关任务的派发。
   - 若 `runtime` 非 `ok`（`degraded`/`unavailable`），状态观测不可信，一律 hold，不派发不合流。

### 2.1 冻结前准备（含人类确认点 1）

1. **尺寸三档分流**：
   - 微型：同域无跨模块共享面，Task Pod 模式（单 workspace `pod/<name>`，按序接力，单次合流，Auditor 单次审查 diff）。
   - 中型：少数能力域，DAG 并发模式（单任务独立 workspace，背压 cap=3，Auditor 审 1 轮）。
   - 大型：跨模块、深依赖、Schema 变更，分阶段 DAG（背压 cap=3，Auditor 审 ≤2 轮）。
2. **风险扫描与 Review 等级**（`tasks.md` 每任务标注，取值只有三档）：
   - `Risk-surface: [error-handling|numerical|concurrency|crypto/auth|irreversible|persistence|public-api|none]`。
   - 三档语义（解析器只接受这三个字面量，其余一律 `UNKNOWN_REVIEW` 报错）：
     - `strict`：先写 Red 测试再实现，独立 Auditor 审完整 diff。任一非 `none` 风险面自动推导为 `strict`。
     - `standard`：不强制 Tester 先行，但**必须**独立 Auditor 审查后才能合流（合流门禁与 `strict` 相同，只省掉 Red 测试阶段）。
     - `mechanical`：可客观完整验证且无风险面，允许 `pass(mechanical@tip/base)` 机械审查标签。
   - 声明 `Review: mechanical` 却带风险面会被解析器判 `REVIEW_RISK_CONFLICT` 直接报错。未知风险词同样报错，不得静默按低风险处理。
   - 历史产物里出现过 `Review: required` / `Review: default`，二者不是合法取值，会被判 `UNKNOWN_REVIEW`；迁移时改写为上述三档之一。
   - `Verify with:` 必须是可执行命令；自然语言描述不算命令（`run`/`use`/`see`/`check`/`verify`/`ensure`/`manually` 等英文高频动词开头的一律按自然语言处理，不放行为命令）。冻结时校验，合流时**逐条先跑**——它是任务契约的一部分，不是注释。
     判定口径：已知命令名 / 明确的路径或变量调用（`/abs/node`、`./run.sh`、`$NODE`）/ 小写 ASCII 命令名形状（排除上述高频动词）；描述通常以中文或大写字母开头。跨模块命令请写全调用（`PYTHONPATH=runtime python3 -m pytest …`）。
   - `Scenarios:` 列出本任务覆盖的 spec 场景编号（`SCEN-*`），收尾静态对账用。
3. **业务验收矩阵**（L4-01，冻结的一部分，不可省）：为每条业务旅程/异常场景冻结一行，含
   **旅程或异常场景 → 真实入口/装配点 → 承载任务 → 验证方法 → 环境与数据 → 通过判据 → 责任角色 → 必要外部依赖**。
   覆盖实现装配与路由可达性，不只验孤立模块。外部必需依赖缺失的项，冻结时就标 `BLOCKED/未验证`，不得用 mock 通过冒充业务验收。
4. **冻结前机械预检**：跑一次任务解析，确认无 `MISSING_SCOPE`、`UNKNOWN_REVIEW`、`UNKNOWN_RISK`、`REVIEW_RISK_CONFLICT`、`BAD_DONE_LINE`，依赖 ID 存在且无环，scope 为仓库根内合法相对路径。**scope 与老测试迁移的冲突在此解决**，不要留到执行期。
5. **spec 撰写规则（冻结审查逐条核，不靠脚本）**：下面五条来自 2026-10-26 `hardening-governance-contracts` 的冻结后返工，每条都对应一次真实的执行期损失。它们**不写成门禁脚本**——语义判据机械化的收益低于维护成本，由 Auditor 在冻结审查时逐条核对。
   - **环境独立**：`Verify with` 必须在**干净工作树**里可执行。命令或 `Write scope` 引用了被 `.gitignore` 的文件（如 `.env.example`）就是冻结缺陷——那会让任务在合并时才发现验证不了。冻结前对新拉出的 worktree 实跑一次。
   - **scope 闭环**：任务的 `Write scope` 必须涵盖它的 `Verify with` **读到**的每个文件，以及它名下每个 `SCEN-*` 的**实现文件**。场景挂给一个 scope 排除实现文件的任务，等于让写手二选一：越权或被判失败。
   - **一场景一承载**：每条 `SCEN-*` 必须能指到一个测试文件，或者是静态检查（此时必须在 spec 里写明检查命令，且该命令不需要新增测试文件）。没有承载的场景在验收时必然变成 `untested_scens` 噪声，或者被写成幻影声明。
   - **delta 先对基线**：新增/修改场景前，对照 `openspec/specs/<cap>/spec.md` 的**同一输入**看既有结论。同一输入两个不同结论（如空快照是 `INVALID_BOS_UUID` 还是 `ORG_MAPPING_NOT_FOUND`）必须在冻结前裁决，不能留给两个任务各写一半。
   - **矩阵计数由命令生成**：业务验收矩阵的行数、场景数、测试数一律贴**命令输出**，不抄、不数、不凭印象。编排者口述的数字（"18 行"）不是真源，`wc -l` 与测试运行器的输出才是。
   - 任务行格式 `- [ ] 1.1 T-01 标题` 与 `- [ ] 1.1 T-01: 标题` 都合法（后者是早期产物的历史写法，`parseTasks` 与 `merge-task.mjs` 的 Done 定位都兼容）；`T-01:标题` 这种冒号紧贴 ID 的写法不合法，会被判 `MALFORMED_LINE`，因为它会让 ID 解析错位。
6. **人类确认点 1：spec 冻结**：呈报概况、DAG 拓扑、业务验收矩阵与 Auditor 结论，经用户确认后冻结。冻结即固定本轮 spec revision。

### 2.2 执行循环

**DAG 就绪与资源并发**
- 依赖释放：仅当前置任务处于 `DONE`（first-parent 合流 + trailer 验证）时才释放下游。**需要依赖合流的下游必须等 Done，不得提前放行。**
- 资源冲突串行化：`Write scope` 前缀重叠的任务保守串行；互不重叠且工作区隔离的任务在 `cap` 限制内并发派发。cap 是容量上限，不是要达到的目标。
- 共享资源不只文件：同仓多 change 的同文件、公开领域契约、端口、DB 文件、缓存、队列、外部租户与测试账号都要显式声明顺序或隔离，worktree 不隔离这些副作用。
- **运行态保护（fail-closed）**：以下任一成立时 `canDispatchNow` 清空，不派发任何新任务——`runtime` 非 `ok`、存在 `UNMAPPED` 运行中 agent、有未回执派发意图、cap 已满。

**单任务标准状态机**（严禁总控跳步代写）
1. **`READY`**：依赖全部 `DONE` 且 `Write scope` 无冲突 → 先 `claim` 意图，再派发。
2. **`TEST_FIRST`**（若 `Review: strict`）：派 `agent_profile_ceshi` 进独立工作区。
   - **爆炸半径扫雷（Blast Radius Sweep）**：写新 Red 测试前，强制 `rg` 全局扫描变更枚举/契约在老测试中的断言引用；发现破坏性断言就在信封输出 `conflicting_tests`，报备 Lead 扩大 `Write scope` 涵盖旧测试同步迁移。
3. **`IMPLEMENTING`**：派 `agent_profile_gongbu`（普通）或 `agent_profile_gaogong`（复杂）进 `task/<name>/<task>` 工作区。
   - 提交必须附 `Pipeline-Role: gongbu`（或相应写入角色）与 `Pipeline-Author: <agentId>` trailers；trailer 块必须是最后一个非空段落（块后空行再跟任何一行即整块作废；消息尾部空行本身无害，2026-10-26 探针实测），提交后必跑 `git log -1 --format='%(trailers:key=Pipeline-Author,valueonly)'` 自验非空（模板 `templates/writer.md` 同此要求）。
   - **契约互斥中断协议（Deadlock Protocol）**：确认新 Spec 与既有 Test 存在不可调和冲突时，严禁用底层 hack 欺骗测试；最多尝试 3 次，必须立即抛 `kind: "blocked", reason: "BLOCKED_ON_CONFLICT"` 信封挂起等待裁决，严禁在死胡同内空转。
4. **`AUDITING`**：派 `agent_profile_anchasi` 独立审计。
   - **第 1 轮全量审计（R1）**：检视完整 diff。**4 类 Blocker 准入**：`SPEC_VIOLATION`、`CORRECTNESS_BUG`、`SECURITY_DEFECT`、`SCOPE_VIOLATION`；非 4 类问题（命名、注释、偏好）标 `NIT:` 并签发 `PASS_WITH_NITS`。
   - **第 2 轮增量审计（R2）**：R1 有 Blocker 时，写手针对性修复后 Auditor 复核。**R2 优先复核 R1 Blocker 是否闭环与修复影响面**；修复引入或暴露的**新的**正确性、安全、规范问题，照常作为 Blocker 阻断，并记录新增原因。不得因为「发生在原 diff 之外」而放过。
   - **硬轮次熔断**：单任务最多 2 轮审查。R2 仍未通过即熔断，进仲裁。**熔断是「暂停并裁决」，不是降低通过条件。**
5. **`ARBITRATION`**（熔断后）：派 `agent_profile_hanlin`（Arbiter）单回合裁决。
   - `OVERRULE`：驳回无依据的 Blocker，须给出理由与收据，签发 `pass(...)`；
   - `PATCH`：委派写手修复后**重新跑测试并重新独立复核**，再由 Arbiter 签发 `pass(...)`。**不按行数放行**；
   - `ESCALATE_HUMAN`：确属规范语义分歧 → 标记 `BLOCKED`，保留工作区，回冻结确认（规范变化由人类决策，不是仲裁员越权改需求）。
6. **`MERGING`**：调用 `merge-task.mjs`（第 5 节门禁）。
7. **`DONE`**：释放下游依赖。

**规约演进与停滞信号**
- **规约演进协议（Schema Evolution Protocol）**：涉及底层状态机或公开契约升级时（如 `INTENT` 演进为 `SUBMITTING`），必须在 tasks 编制阶段扫清老测试影响面，把需迁移的老单测纳入 `Write scope:`，禁止把写手逼入「改测试算越权、不改算失败」的不可能三角。
- **停滞信号（非自动熔断）**：连续 ≥5 次在同一断言失败、或单文件编辑 >15 分钟无推进，是**预警信号**，由 Lead 核实后处置（追问、换角色、升级）。**不自动判定死循环，也不因为一个阈值就中断有价值的工作。**

### 2.3 验收与交回（含人类确认点 2）

1. **集成环境真实运行**：用集成分支精确 SHA + 启动配置 + 隔离测试数据，从**真实 API/UI 入口**跑冻结的业务验收矩阵。核验服务装配、持久化、授权、异常补偿、重试/幂等与适用的重启恢复，不只调用内部函数。
2. **有 UI 时**做实际交互与适用视口走查。截图存在不代表业务成功。
3. **证据双闸门**（第 6 节）：`--gate structure` 留档，`--gate acceptance` 才判定通过。验收闸门只接受约定通过结论、无未验证项、且绑定本次验收 revision。
4. **OpenSpec 交回点**：需要 `validate`/`archive` 时，Lead 在最终信封里列成**唯一待办请求**并在运行账本标等待；主会话执行后回执，Lead 才继续。文档改动不等于获得 CLI 或发布授权。
5. **归档集成 change**：`openspec archive <name> --yes`（主会话）。
6. **人类确认点 2：合入主干**：呈报 diff 摘要、验收 SHA、测试与业务验收记录，经用户确认后方可合入主干。未经确认绝对禁止合入 main、推送远端或发布外部服务。
7. 归档工作区，`git branch -d` 清理已合入主干的分支。

**主会话不是 Paseo agent**：主会话（Claude Code）不在 agent 图里，`send_agent_prompt` 发不到它。主会话等 Lead 的正确方式是**阻塞在 `paseo wait <lead-id>`**（后台 Bash / Monitor 均可，由 harness 通知），返回后读 Lead 的最终信封（`paseo logs` 或 `get_agent_activity`），再执行它列出的待办请求。不要设计「Lead 主动 push 给主会话」的路径——那条路在结构上不通。

## 3. Workspace 与分支生命周期（全交 Paseo）

**禁止 `git worktree add/remove/prune` 与 `git branch -D`**；允许收尾用 `git branch -d` 安全删除已合入主干的临时分支。工作树全交 Paseo 管理。

1. **分支命名**：严格 `integration/<name>`、`spec/<name>`、`pod/<name>`（微型 Pod）、`task/<name>/<task>`（DAG，重派追加 `-a<attempt>`）。
2. **创建与隔离**：`create_workspace` 统一带 `path: <主仓库路径>`，`background: false`。
   - **集成 workspace**：基点为主干，全 change 唯一，用于合流与全量测试，收尾前永不归档。
   - **spec workspace**：基点为主干。冻结时固定三步：① 集成分支合入 `spec/<name>` 并跑测；② 立即 `archive_workspace` spec 工作区；③ 再派首个任务。
   - **任务/Pod workspace**：基点为 `integration/<name>`。合流成功并记账后方可归档。
3. **工作区保留**：失败、被打回或 `Blocked` 的任务，其 workspace **保留现场**供人类排查，不自动归档。取消/超时/重启也不自动抹去未完成 workspace。
4. **批量对账**：同轮完成通知共用一次 `list_workspaces(includeBackground: true)` 快照核对存活。

## 4. 运行账本与编排租约（轻量执行闭环）

运行账本补「**正在进行的动作**」这一层事实。它**不是第二套任务真源**：任务契约在 `tasks.md`，已合流事实在 git first-parent 账本，Agent 事实在 Paseo，运行账本只记 action intent、派发结果与租约。

```bash
# 开工：领取/续期编排租约（同 run 唯一 owner + 代际 generation）
node skills/paseo-pipeline/run-state.mjs begin  <change> --owner <owner-id>
# 派发前：认领意图（幂等键 [run,task,attempt,phase,role,action]）
node skills/paseo-pipeline/run-state.mjs claim  <change> --task T-01 --attempt 1 --phase impl --role gongbu
# 派发后：登记真实 agent/workspace
node skills/paseo-pipeline/run-state.mjs record <change> --key <key> --agent <agent-id> [--workspace <id>]
# 创建确认失败：显式作废意图，才允许重派
node skills/paseo-pipeline/run-state.mjs fail   <change> --key <key> --reason <text>
# 查看：租约、未回执意图
node skills/paseo-pipeline/run-state.mjs status <change> [--json]
```

- **动作意图幂等**：同一幂等键已有未回执意图时，`claim` 以 exit 2 拒绝重复派发。**先记意图，再派发，再记回执。** 创建成功但回执丢失时，按唯一标签对账，未排除重复前不盲重派。
- **单 owner 租约**：同 run 只有一个有效 owner。租约过期后旧 owner 的全部 `claim`/`record`/`fail` 一律 exit 2，必须显式 `begin` 领取新代际——防止旧 Lead 复活后继续提交动作。**租约仍有效且属于他人时不得抢占**，等其 renew 或超时。
- **孤儿意图（`ORPHAN_INTENT`）**：意图超过 10 分钟仍无对应 agent（创建失败或回执丢失）。`reconcile` 把它列为最高优先级 `NEXT arbitrate`，**自动化不得自行重派**，须核对后显式 `fail` 或 `record`。
- **无 heartbeat 子命令**：注册入口已删（2026-10-26）。常规运行不建周期性 heartbeat，且 `hardening-governance-contracts` 账本里 `heartbeats` 为 0——没有使用者的写入路径不留。旧账本里的 `heartbeats` 数组仍是只读兼容字段，`status` 照常打印。
- 存放位置：git common dir 下 `paseo-pipeline/<change>/run-state.json`（不放 `openspec/`，否则弄脏工作树阻塞合流）。`PIPELINE_RUN_STATE_DIR` 可覆盖。

**唤醒模型（与 spec 一致）**：常规运行**不创建**周期性 heartbeat 或 schedule；没有经过验证的计时器或外部事件源时，静默丢失的回调无法唤醒空闲 Lead——对账只能在**下一次真实调用**时发生。这是事实，不是可以通过多写几条规则消除的缺陷。

1. **主轨（事件驱动）**：子 Agent 完成经 `notifyOnFinish: true` 唤醒父 Agent 处理合流与下游派发。回调到达即推进，这是正常路径。
2. **主动等待（不依赖事件）**：派发后在**前台阻塞** `paseo wait <agent-id> --timeout 540 --json`，返回即读产出一轮。回合不 idle 就不依赖 `notifyOnFinish` 去唤醒一个空闲父级，这是 2026-10-25 停摆事故的直接对策。
   - **`paseo wait` 的退出码恒为 0**（实测 `idle`、`timeout`、`Agent not found` 三种终局均 `rc=0`）。必须解析 `--json` 的 `status`：`idle` 才是子 agent 停了，`timeout` 要继续等同一 id（不得重派），`error` 按失败处置。`paseo wait ... && 推进` 这类写法会把超时当成完成。
   - 等待期间的真实耗时与起止时间戳要采集，它们是判断「空等」还是「有效长任务」的唯一依据。
3. **外部唤醒（可选，需确证来源）**：只有当主会话 harness 或人类确实提供了会定期唤醒 Lead 的机制时，才把它写进当次信封并如实记录来源 id 与到期时间。**没有可证伪的来源就不写进规则**——运行账本已无 heartbeat 注册入口，这条只能靠当次记录兑现，不得写成默认行为。
4. **惰性对账**：任何一次真实唤醒（事件、外部唤醒、人类追问、接手）都先跑 `reconcile.mjs <change>`。**通知只是唤醒；终态以可核验产物为准。** 空闲时只做轻量增量核对，避免每次全量长日志。
5. **停摆的处置**：不再依赖「等它自己醒」。超时未推进即在运行账本标 `BLOCKED_ON_WAKE` 并上报人类，说明最后一次可核验产物是什么、缺哪一环——不要用「进程还 running」冒充有进展。

**主会话不是 Paseo agent**：主会话（Claude Code）不在 agent 图里，`send_agent_prompt` 发不到它。主会话等 Lead 的正确方式是后台 `paseo wait <lead-id>`（Bash `run_in_background` 或 Monitor，由 harness 通知），返回后读 Lead 的信封。不要设计「Lead 主动 push 给主会话」的路径。

**事件去重与过期**：复合键 `(agent_id, message-id/event-id, task, attempt, phase, revision)`。相同复合键已处理、attempt 低于当前记录、或 revision 与分支 tip 不符 → 忽略并记一行日志。

**权限纪律**：Agent 请求敏感权限时状态转 `UNRESOLVED`（权限暂停）。**Lead / AI 严禁调用 `respond_to_permission` 代批**，任何情况下不得越权代人类审批。权限请求必须经信封上报人类，等人类在客户端批准或拒绝后方可续跑。

**重试与返工预算**：每任务最多打回 2 轮 + 升级高工 1 次；超出即标 `Blocked`，保留现场报人类裁决，禁止无限自旋。

### 信封规范（≤20 行）

统一字段：`task`、`attempt`、`phase`、`result`、`reviewed_sha`、`blockers`、`next_action`。
- `kind`: `turn-idle`（等下游时当前回合结束，非阶段完成）、`phase-complete`（当前阶段顺利完成）、`blocked`（阻断打回或失败）。
- 短摘要与完整证据分开；字段适用性明确。执行器须验证信封与真实产物一致。

### 孙 → Lead 的接力：用主动等待，不用通知接力

`notifyOnFinish` 是单级消费机制，孙 Agent 终态通知到达 Lead 后被消费即结束。依赖这级回调把结果送回父级，在 `pipeline-native-closure` 的原生冒烟里实测 FAIL（`native-smoke.md`：孙 agent 06:06:15Z 完成，Lead 到 06:13:24Z 才被人工催动）。

**正确做法**：Lead 在等孙 Agent 时，回合**不结束**，前台阻塞在 `paseo wait <sun-id> --timeout 540 --json`，返回后跑 `reconcile.mjs` 并推进。回合不 idle，就不需要任何回调把它唤醒。

**不要设计「Lead 用 `send_agent_prompt` 把信封推给父会话」的路径**：主会话（Claude Code）不在 Paseo agent 图里，收不到这条消息。主会话自己在后台 `paseo wait <lead-id>` 等 Lead 结束，再从 Lead 的最后一条回复里读信封。

## 5. 安全原子合流门禁（`merge-task.mjs`）

在集成 workspace 内执行：

```bash
node skills/paseo-pipeline/merge-task.mjs <branch> <task-id> <review-tag> <test-cmd> [--allow-legacy-author]
```

1. 校验当前分支为 `integration/<change>` 且工作区干净。
2. **依赖门禁**：任务依赖必须已在集成 HEAD 上被 first-parent 合流证明为 `DONE`（exit 35）。直接调用本脚本不能绕开调度顺序。
3. **冻结验证命令**：本任务及本次合流涉及的每个任务，其 `Verify with` 若不可解析为可执行命令，直接 exit 36 拒绝；可解析的**先逐条执行**，位置参数 `<test-cmd>` 只作为追加（与冻结命令完全相同时不重复执行）。失败时打印 `Verify source: tasks.md (...)`，便于区分是哪个契约没过。
4. **因子 1 写范围封闭**：`git diff` 的修改文件必须 100% 落在任务 `Write scope:` 前缀内（exit 30）。
5. **因子 2 作者血统与控制面隔离**：**逐个 commit** 校验必须带 `Pipeline-Role`（属于 `gongbu`/`gaogong`/`ceshi`/`jiangzuo`/`qingqibing`）与 `Pipeline-Author`；缺失或属控制面（`shangshu`/`lead`/`anchasi`/`hanlin`）以 exit 31 硬阻断。逐个 commit 判定，防止一个合法提交掩盖另一个无 trailer 的提交。
6. **因子 3 独立非自审**：`review-tag` 必须为 `pass(<reviewer-id8>@<tip7>/<base7>)`；`reviewer` 与任一 `Pipeline-Author` 相同即 exit 32（完整 UUID 与唯一可解析前缀都比对，歧义 fail closed）。`Review: strict`/`standard` 严禁用 `mechanical`。
6a. **因子 3b 审查员与派发记录交叉核对**（仅当该 change 的运行账本存在时生效）：只比对 commit 作者不够——历史 T-02 事故里写手提交没有 `Pipeline-Author` trailer，自审检查完全落空。有账本时，`reviewer` 不得等于本次合入任务中任一**写手意图**（`role` 属写入角色）的 `agentId`（exit 32），且必须命中其中至少一条已回执的 `anchasi` 审计意图（Pod 是一次审查覆盖整组，不要求逐任务各派一次）；账本不可解析同样 exit 32，不得按「没记录」豁免。
    - 账本不存在时沿用 trailer 检查，但**跳过必须留痕**：run-log 记 `review-attestation=SKIPPED(no-run-state)`。有账本记 `run-state`，mechanical 审查记 `mechanical-review`。门禁静默消失与门禁通过必须可区分——2026-10-26 的 5 任务冒烟就是这样全程 `present=false` 跑完，自审交叉核对一次未执行而账本无痕。
6b. **Pod 成员集合**：`pod/<change>` 分支必须附带冻结的 `openspec/changes/<change>/pod-members.json`，且 `<task-ids>` 必须**恰好等于**该成员集合（多报、少报、缺文件均 exit 31）。分支名不携带任务身份，成员真源只有这一份冻结记录。
6c. **legacy 豁免需二次确认**：`--allow-legacy-author` 会整体关闭作者血统门禁，必须同时设置 `PIPELINE_ALLOW_LEGACY_AUTHOR=1`，否则 exit 31；放行时 run-log 记 `author-provenance=BYPASSED(legacy)`。控制面角色检查不受豁免影响。
7. **基线锚定**：`base7` 必须同时是集成 HEAD 的祖先、以及被合入 tip 的祖先（任一不满足即 exit 34）——集成在任务分支拉出后前进一步时，那个新 HEAD 仍是集成历史祖先，但 `base..tip` 已把本任务没写过的提交算进审查范围。与当前集成 HEAD 漂移且改动文件重叠时拒绝合流要求重审，不重叠则记录漂移放行。
8. **合流固定 tip**：用审查收据绑定的那个 commit（而非可变分支名）合流，避免「审查过的内容」与「实际合入的内容」漂移。
9. **显式测试命令 + 截止时间 + 整树清理**：执行冻结命令与 `test-cmd`，默认超时 30 分钟（`MERGE_TEST_TIMEOUT_MS` 可调）。超时按**进程组**终止（SIGTERM，2 秒后 SIGKILL），不是只杀外层 shell——否则测试拉起的孙进程会继续写工作区。失败、超时、或**测试改写了工作树**（前后 `git status --porcelain=v1 --untracked-files=all` 指纹不一致）一律拒绝提交测试副作用；先撤掉对已跟踪文件的改写，再 `git merge --abort` 恢复现场，**严禁 `reset --hard` 回滚**。abort 失败、或 `MERGE_HEAD` 消失而 HEAD 已被推进（测试命令自己执行了 `git commit`）时保留现场并打印人工指引（exit 40）。
10. **原子记账与血统透传**：自动勾 `tasks.md`、追加 `Done: source=<tip7> review=<review-tag>`，原子提交附 `Pipeline-Task`、`Pipeline-Source`、`Pipeline-Author`、`Pipeline-Role`、`Pipeline-Reviewer` trailers。
11. **回执丢失的处置**：任务已 Done 一律 exit 非零且不产生新提交。错误文案区分两种情形——Done 行绑定的 source 就是本次 tip 时报「已从该 tip 合过，这是回执丢失后的重试，合流其实已成功，不要重派任务」；source 是别的 revision 时报「不同 revision 不能用同一任务合流」。**收到前一种报错时禁止重派写手**，去核对 `git log --first-parent` 即可。

退出码：30 写范围 / 31 作者血统或 Pod 成员不符 / 32 非自审（含审查员与运行账本派发记录不符）/ 34 base 非集成 HEAD 或非 tip 祖先 / 35 依赖未验收 / **36 不允许的 `Verify with`** / **37 并发合流被锁拒绝** / 10 冲突 / 20 测试失败或改树 / 40 abort 失败。

## 6. 证据双闸门（`test/check-evidence.mjs`）

```bash
node skills/paseo-pipeline/test/check-evidence.mjs --gate structure  <file>   # 留档：FAIL 也 exit 0
node skills/paseo-pipeline/test/check-evidence.mjs --gate acceptance --sha <acceptance-sha> <file>
node skills/paseo-pipeline/test/check-evidence.mjs --gate all --sha <acceptance-sha> <file>
```

- **结构闸门（默认）**：只校验字段齐备、UUID/时间戳合法。**FAIL 报告的合法留档也 exit 0**——失败调查可以完成。
- **占位值不是采集值**：`PLACEHOLDER`/`TODO`/`FIXME`/`TBD` 等占位专用词按子串匹配；`LOST`/`UNKNOWN`/`TEST`/`NOT_COLLECTED` 这类通用词按词边界匹配（边界为空白/下划线/字符串边缘），因此真实标识里的子串（如 ULID 片段 `01JAXLOSTFOUND`、路径 `a.test.mjs`）不误伤，而编造收据的分隔形态（`msg_01JAX_LOST_NOTIFICATION`）仍拒绝。全同字符的退化 SHA 同样拒绝。以上与「字段缺失」同等对待，结构闸门即拒绝。采集不到就写「未采集」并说明原因，不要编一个看起来像收据的值。
- **验收闸门**：只接受约定通过结论，且要求
  - 必须先过结构闸门；**smoke 与 audit 都必须给 `--sha`**——没有 revision 绑定的证据无法证明「当前这份代码」被验证过，smoke 已带 `reviewed_sha` 时还要与之一致；
  - smoke `result: PASS`、`unverified:` 为空、`notification_at >= dispatched_at`；
  - audit `verdict` 属约定通过集合、`reviewed_sha` 与 `--sha` 一致（7 位前缀与完整 sha 可互比）；
  - `--require-scenario <SCEN-ID>` 指定的场景不只要「被提到」：必须在 `scenario_results:` 段落里有 `<ID>: PASS` 的结论，且不得同时挂在 `unverified` 列表（自相矛盾直接拒绝）。**正文提及、注释、TODO 都不算验证**；记为 `FAIL`/`BLOCKED`/`SKIPPED` 同样阻断。
- **FAIL、BLOCKED、SKIPPED、未验证、非 pass verdict、过期 revision 一律不能折算 PASS。** 调查任务完成 ≠ 被调查能力完成。

## 7. 失败处置与恢复

1. 读 `git log --first-parent integration/<name>` 与 `tasks.md` Done 行，二者是**已合流事实**的唯一账本。
2. 任何时候断链：`reconcile.mjs <change>` 拿真实任务图与 `NEXT` 动作，按其推进。
3. 运行态未知（`UNMAPPED`/`degraded`/`unavailable`/孤儿意图）→ 先归类或仲裁，不盲目重派，不盲目合流。
4. 无法自动恢复时**明确挂起**并报告人类：保留 workspace 与运行账本现场，说明卡点、已知事实与需要的决策。

## 8. 硬底线与硬红线

**硬底线**：不抓凭据/直连 API/冒用身份；push、`rm -rf`、`--amend` 先问；两个人类确认点。

**总控硬红线（Negative Constraints）**：
- 总控（主会话 / Shangshu）**严禁**直接对业务代码调用 `Write`/`Edit` 编码，必须委派 `gongbu` 或 `gaogong` 独立完成；
- 总控**严禁**在任务分支或集成分支上手写业务 `git commit`（代码由写手提交，合流由 `merge-task.mjs` 独占提交）；
- 总控**严禁**手工勾选 `tasks.md` 的 `[x]` 或追加 `Done:` 行（`merge-task.mjs` 原子记账）；
- 总控**严禁**自产自审；必须由独立 Auditor（`anchasi`）或机械验证生成合流 review 标签。

**这些是协作契约与自报元数据，不是工具级身份隔离或可信来源证明。** 真实防线是 `merge-task.mjs` 的机械门禁（写范围、作者血统、非自审、依赖、基线），加上独立的业务验收。不得声称提示词能物理封死总控代写。

**只读角色约束**：Auditor、Arbiter、Scout 等只读角色要求最小权限，brief 显式声明**禁调 memory 工具与不必要的网络访问**——但**允许完成审查所需的授权本地查询**（如读仓库、跑 `rg`、用 codegraph），不要一刀切禁 MCP 后又要求同一角色使用 codegraph。
