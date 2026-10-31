---
name: paseo-pipeline
description: SDD 交付流水线：OpenSpec 管生命周期，Paseo profiles 管角色，Lead 只做阶段编排与并发调度。入口接受需求描述或已有 change 名。触发词：/paseo-pipeline、pipeline、并发交付。
user-invocable: true
---

# Paseo Pipeline

OpenSpec 管 SDD 生命周期（产物格式、阶段顺序、校验以 `openspec` CLI 为准），Paseo profiles 管角色，本 skill 负责串联与并发调度。change 名是对账键，不是准入凭证。实测反例与历史踩坑见同目录 `LESSONS.md`（证据与历史，不是规程；冲突时以本文件为准）。

**脚本路径约定**：本文所有命令写作 `"$PIPELINE_HOME"/<脚本>`。`PIPELINE_HOME` 指向本 skill 目录（安装后的 `~/Codex/paseo-skills/skills/paseo-pipeline`），在 `~/.zshrc` 里导出一次；目标仓库里没有 `skills/paseo-pipeline/`，照抄相对路径只会在目标仓库报 `Cannot find module`。开工前跑 `node "$PIPELINE_HOME"/pipeline-doctor.mjs`，它会核对这个变量与其余前置条件。

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
| 总控编排 | 主会话 / `agent_profile_shangshu` | `[ROUTE]` 判 `lead`（预计派发 ≥6 次）时交 Shangshu 无人值守，主会话只守确认点 1 与 2；微型 Pod 任务（通常 ≤3 次派发）主会话直接编排 |
| 需求调研 | `agent_profile_chanpin` | 产品需求规划与现状调研（吸收原 Scout 侦察兵职能，提取 Codebase Digest） |
| 契约制宪 | `agent_profile_hanlin` | 架构与契约设计；微型/中型由编排者起草；兼任架构争议裁决（吸收原 Arbiter 仲裁官职能） |
| 测试先行 | `agent_profile_ceshi` | 严格档（`Review: strict`）任务使用，先写 Red 测试；数学类任务写差分对拍或小定义域穷举 |
| 代码实现 | `agent_profile_gongbu` | 默认实现角色；兼顾极速轻量执行（吸收原 Pi-Runner 轻骑兵职能） |
| 复杂攻坚 | `agent_profile_gaogong` | 复杂任务（跨模块、并发、状态机）实现与打回升级重做 |
| 代码审计 | `agent_profile_anchasi` | 审 diff、spec 场景与 tasks.md 正交性，只报 Blocker；吸收原 Critic 挑刺官职能 |
| UI/原型 | `agent_profile_jiangzuo` | UI/UX 方案原型构建与多视口截图走查（吸收原 Builder 营造师职能） |

**原生 MCP 派发（默认路径）**：派发通过 agent 作用域原生 MCP `create_agent`/`send_agent_prompt` 执行。

**派发 brief 用模板，不要临时拼**：`templates/` 下五份（`writer` / `tester` / `auditor` / `arbiter` / `lead`），固定字段为「目标与不变式、base SHA、Write scope、Verify 命令、必填 trailers、信封格式」。`arbiter` 只在熔断后使用：它拿 R1/R2 的信封做单回合裁决，产出 `OVERRULE`/`PATCH`/`ESCALATE_HUMAN`。模板只保证**字段齐备**，行数按字段需要写，不做行数上限——2026-10-26 冒烟里跑通的那份 Lead brief 是 100 行。省略字段的后果是实测过的：brief 漏写 `pipeline.disposition` 生产者契约，Lead 只能从源码反推，T-1 被 `UNRESOLVED` 锁死一轮。

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
2. **安装项目内 schema**（每个目标仓库一次，主会话执行）。仓库自带的 `openspec/config.yaml` `rules` 只在 instructions 末尾追加一段文字，而上游 `spec-driven` 的 tasks 模板示范的是 `- [ ] 1.1 描述`——两个来源同时出现，写的人照模板写就写不出 pipeline 能解析的任务。因此让**模板本身**是对的：

   ```bash
   mkdir -p openspec/schemas/paseo-pipeline
   cp -R "$PIPELINE_HOME"/openspec-schema/. openspec/schemas/paseo-pipeline/
   openspec schemas    # 确认列出 paseo-pipeline (project)
   ```

   之后**每个新 change 都必须**用 `openspec new change <name> --schema paseo-pipeline` 创建。已存在的 change 在 `.openspec.yaml` 里固定了 schema，改 config 不会影响它们——它们不会拿到新模板，需要迁移时手工按模板改 `tasks.md`。

   这份 schema 是 OpenSpec 1.8.0 的副本，只改了 tasks/specs 的指令并新增 `acceptance` 产物。升级 OpenSpec 后重跑一次探测：临时仓库 `new change --schema paseo-pipeline` → `openspec instructions tasks` 里出现 `T-01` 与 `Write scope` → `validate --strict` → `archive`。
3. 入参匹配已有 change：由**主会话**跑 `openspec status --change <name> --json` 取断点，再把结论交给 Lead。Lead 自己只读 `openspec/changes/<name>/` 下的产物文件，不执行 `openspec` 命令（见开篇「OpenSpec CLI 主会话独占」）；它需要生命周期信息时走「OpenSpec 交回点」发请求，不得自行代跑。
4. **任何断链、接手或不确定时刻**，先跑一次只读对账拿真实态：
   ```bash
   node "$PIPELINE_HOME"/reconcile.mjs <change>
   ```
   它只读 `tasks.md` + git first-parent 账本 + Paseo 运行态 + 运行账本，输出任务分类、hold 原因与有序 `NEXT`/`ALSO` 动作。**以 `NEXT` 为准推进，不要凭记忆或聊天内容推断。**
   - `NEXT <kind>: <reason>` 是当前主行动；`ALSO <kind>: <reason>` 是同一轮里可并行的其余动作（例如「先仲裁 T-01 的孤儿意图，同时把已就绪的 T-02 派出去」）。**`ALSO` 不是提示，是同一决策里的可执行动作，不要再跑一次对账去拿它。**
   - 只有全局性阻断（`runtime` 非 `ok`、`UNMAPPED` 非空、无依赖的 `BLOCKED`）才会压住全部动作并给出单一 hold。单个任务的 `INVALID`/`UNRESOLVED`/预算耗尽**只压住被点名的任务**，不得冻结无关任务的派发。
   - 若 `runtime` 非 `ok`（`degraded`/`unavailable`），状态观测不可信，一律 hold，不派发不合流。
   - **上下文压缩或会话恢复后的第一动作也是这条**。压缩摘要会保留「该推进 Phase N」，抹掉「总控禁写业务代码」这类禁令的权重；对账输出是重放状态，摘要不是。先拿到 `NEXT` 再动。2026-10-27 `eas-filing-and-local-ocr` 就是在压缩后跳过对账、直接进 `Write` 的。

### 2.1 冻结前准备（含人类确认点 1）

1. **尺寸三档分流**：
   - 微型：同域无跨模块共享面，Task Pod 模式（单 workspace `pod/<name>`，按序接力，单次合流，Auditor 单次审查 diff）。
   - 中型：少数能力域，DAG 并发模式（单任务独立 workspace，背压 cap=3，Auditor 审 1 轮）。
   - 大型：跨模块、深依赖、Schema 变更，分阶段 DAG（背压 cap=3，Auditor 审 ≤2 轮）。
2. **风险扫描与 Review 等级**（`tasks.md` 每任务标注，取值只有三档）：
   - `Risk-surface: [error-handling|numerical|concurrency|crypto/auth|irreversible|persistence|public-api|none]`。
   - 三档语义（解析器只接受这三个字面量，其余一律 `UNKNOWN_REVIEW` 报错）：
     - `strict`：先写 Red 测试再实现，独立 Auditor 审完整 diff。**显式声明的 `Review` 优先**；缺省时才按风险面推导——有非 `none` 风险面推导为 `strict`，无风险面则保持未定，合流时 fail closed。如实说明的是**调度档位**：`strict` 与 `standard` 在合流门禁上完全相同，区别只在是否先派 Tester 写测试。先写测试是流程选择而非可机械判定的事实，因此不设对应门禁（已有可靠失败复现时不必再派 Tester 造 Red）。
     - `standard`：不强制 Tester 先行，但**必须**独立 Auditor 审查后才能合流（合流门禁与 `strict` 相同，只省掉 Red 测试阶段）。
     - `mechanical`：可客观完整验证且无风险面，允许 `pass(mechanical@tip/base)` 机械审查标签。
   - 声明 `Review: mechanical` 却带风险面会被解析器判 `REVIEW_RISK_CONFLICT` 直接报错。未知风险词同样报错，不得静默按低风险处理。
   - 历史产物里出现过 `Review: required` / `Review: default`，二者不是合法取值，会被判 `UNKNOWN_REVIEW`；迁移时改写为上述三档之一。
   - `Verify with:` 必须是可执行命令；自然语言描述不算命令（`run`/`use`/`see`/`check`/`verify`/`ensure`/`manually` 等英文高频动词开头的一律按自然语言处理，不放行为命令）。冻结时校验，合流时**逐条先跑**——它是任务契约的一部分，不是注释。
     判定口径：已知命令名 / 明确的路径或变量调用（`/abs/node`、`./run.sh`、`$NODE`）/ 小写 ASCII 命令名形状（排除上述高频动词）；描述通常以中文或大写字母开头。跨模块命令请写全调用（`PYTHONPATH=runtime python3 -m pytest …`）。
   - `Scenarios:` 列出本任务覆盖的 spec 场景编号（`SCEN-*`）。它不只是收尾标签：`freeze-check.mjs` 用它做**双向核对**（任务引用的编号必须存在，每个声明的编号必须至少被一个任务认领），`contract-check.mjs` 用它做静态对账。场景名不带 `SCEN-` 编号会被 `freeze-check` 拦下——那种场景在静态对账时被静默跳过，change 看起来验过了，实际什么都没检。
3. **业务验收矩阵**：`acceptance.md` 是 schema 的独立产物（不是散文段落，也不在 tasks.md 里）。冻结时填 `Result: PENDING` / `Evidence: pending`，**不填 PASS**。列固定为 `Scenario | Entry | Tasks | Verify | Required | Result | Evidence`，每列含义与示例见 `openspec-schema/templates/acceptance.md`。
   这张表是「算不算交付」的唯一定义：任务合流、单测全绿都不回答它，因为功能可能从真实入口根本走不通。`Entry` 要写真实入口或装配点（HTTP 路由、UI 路径、CLI 命令），不是内部函数；`Required: yes` 阻断交付。冻结时外部必需依赖接不通的，标 `BLOCKED/UNVERIFIED` 并写原因，不得用 mock 通过冒充业务验收。
   收尾时 `check-evidence --gate acceptance --matrix openspec/changes/<name>/acceptance.md` 从这个文件读必需场景（`--require-scenario` 只能追加），所以漏传不再等于漏验。
4. **冻结前机械预检**（一条命令，不是靠人核对）：

   ```bash
   node "$PIPELINE_HOME"/freeze-check.mjs openspec/changes/<name> --baseline openspec/specs
   ```

   零阻断项才可进入确认点 1。它复用编排器同一个解析器（`lib/tasks.mjs`），因此**不存在「冻结时通过、执行时解析不出来」**：任务行/ID/依赖图/scope 合法性、场景编号双向闭环、验收矩阵的列与引用、Pod 成员全部在这一步核。输出直接贴进冻结报告（计数由命令生成）。`scope 与老测试迁移的冲突在此解决`——那是语义判断，仍由 Auditor 逐条核。跨 change 写范围重叠只出 `HINT`：两个 change 改同一文件是真实情况，先后顺序是人类在确认点 1 的决定，脚本不替人拦。

   **`[ROUTE]` 行是编排归属的唯一真源，不要自己估。** 它按任务审查档位机械累加预计派发数（每任务 1 次写手；非 `mechanical` 档另加 1 次独立审计；`strict` 档再加 1 次 Tester 先行），≥6 判 `lead`。它只提示、不改退出码，但**呈报时必须照抄**。

   **`--baseline` 不是可选项**：`MODIFIED` 替换整个 Requirement 块，所以 delta 必须把基线原有场景原样抄回（抄漏会被 `openspec validate` 拒绝）。抄回来之后，双向核对若仍要求「每个声明场景必须被任务认领」，就会把这些继承来的历史场景当成缺陷——本 change 实测 5 条被判「没有任务认领」，任何含 MODIFIED 的 change 都冻结不了。`--baseline` 只把它们从**认领义务**里排除；引用了哪儿都没声明的编号仍照常阻断。
5. **spec 撰写规则（冻结审查逐条核，不靠脚本）**：下面五条来自 2026-10-26 `hardening-governance-contracts` 的冻结后返工，每条都对应一次真实的执行期损失。它们**不写成门禁脚本**——语义判据机械化的收益低于维护成本，由 Auditor 在冻结审查时逐条核对。
   - **环境独立**：`Verify with` 必须在**干净工作树**里可执行。命令或 `Write scope` 引用了被 `.gitignore` 的文件（如 `.env.example`）就是冻结缺陷——那会让任务在合并时才发现验证不了。冻结前对新拉出的 worktree 实跑一次。
   - **scope 闭环**：任务的 `Write scope` 必须涵盖它的 `Verify with` **读到**的每个文件，以及它名下每个 `SCEN-*` 的**实现文件**。场景挂给一个 scope 排除实现文件的任务，等于让写手二选一：越权或被判失败。
   - **一场景一承载**：每条 `SCEN-*` 必须能指到一个测试文件，或者是静态检查（此时必须在 spec 里写明检查命令，且该命令不需要新增测试文件）。没有承载的场景在验收时必然变成 `untested_scens` 噪声，或者被写成幻影声明。
   - **delta 先对基线**：新增/修改场景前，对照 `openspec/specs/<cap>/spec.md` 的**同一输入**看既有结论。同一输入两个不同结论（如空快照是 `INVALID_BOS_UUID` 还是 `ORG_MAPPING_NOT_FOUND`）必须在冻结前裁决，不能留给两个任务各写一半。
   - **矩阵计数由命令生成**：业务验收矩阵的行数、场景数、测试数一律贴**命令输出**，不抄、不数、不凭印象。编排者口述的数字（"18 行"）不是真源，`wc -l` 与测试运行器的输出才是。
   - **任务切片与工程架构准则（冻结前设计审查）**：这几条在**起草 tasks.md 时**落实，冻结后 DAG 与 scope 不再改（改即规范变更，回确认点 1）。
     - **垂直切片（Vertical Slice Architecture）**：按功能端到端切，每个任务带自己的测试与 `Verify with`；不按技术层（Model/Service/API）切出彼此空转的薄任务。**唯一允许的横切**是规约演进协议（§2.2）里的共享契约先行任务，其余任务对它写显式 `Depends on`。
     - **符号级爆炸半径**：`Write scope` 只认路径，`reconcile` 只按路径前缀判冲突。起草时对每个要改的导出符号跑 `rg -n '<符号>'`（可用时用 codegraph）；两个任务 scope 不重叠但改同一导出符号或共用测试夹具时，**在 `Depends on` 里写依赖边**。不要发明符号级 scope 字段——`lib/tasks.mjs` 会以 `UNKNOWN_FIELD` 拒绝。执行期 Lead 只能少派，不能补边（见 `templates/lead.md`）。
     - **深模块设计（Deep Modules）**：小接口 + 大实现；参数收敛，复杂性内聚在实现内部；外部依赖经 Seam 隔离；spec 没要求的抽象/参数不加（Speculative Generality）。它指导写手与审计员的 Nit，不扩大 4 类 Blocker 准入。
     - **双轴审计（Two-Axis Review）**：同一个 Auditor 按 Spec 轴（场景是否都实现、行为是否一致）与 Standards 轴（坏味道、模块深度）各过一遍，信封分 `spec_axis` / `standards_axis` 写。Blocker 只来自 4 类准入；Standards 轴默认只产出 Nit。
     - **返工先复现（Red Before Fix）**：带上一轮 Blockers 的返工，写手先把每条 `repro` 写成失败断言再改实现，信封贴 `red_evidence`；R2 以此判定闭环。复现测试文件必须在 `Write scope` 内——所以起草时每个任务的 scope 都要含它的测试文件（与「scope 闭环」同一条要求）。
   - 任务行格式 `- [ ] 1.1 T-01 标题` 与 `- [ ] 1.1 T-01: 标题` 都合法（后者是早期产物的历史写法，`parseTasks` 与 `merge-task.mjs` 的 Done 定位都兼容）；`T-01:标题` 这种冒号紧贴 ID 的写法不合法，会被判 `MALFORMED_LINE`，因为它会让 ID 解析错位。
6. **人类确认点 1：spec 冻结**：呈报概况、DAG 拓扑、业务验收矩阵、`freeze-check` 的 `[ROUTE]` 行与 Auditor 结论，经用户确认后冻结。冻结即固定本轮 spec revision，并在同一回合 `run-state.mjs confirm --checkpoint cp1` 记下确认时间（§4）。

   **确认选项必须写明下一步动作的执行者**，不能只写「确认冻结并启动实施」——那六个字把「谁编排」留给了模型的自由发挥。按 `[ROUTE]` 二选一：

   - `lead`：「确认冻结，派 `agent_profile_shangshu` 接管无人值守编排，主会话进入 `paseo wait`」
   - `pod`：「确认冻结，主会话以编排者身份派发 `agent_profile_gongbu`」
7. **交接序列（确认点 1 之后、动任何业务文件之前）**：这是 CP-1 与执行循环之间唯一合法的过渡。**顺序固定，不可跳过、不可合并**：

   1. 预载派发工具：`ToolSearch` 取 `mcp__paseo__create_agent` / `create_workspace` / `list_profiles`。它们是 deferred 工具，不预载则每次派发都要多一个回合，而 `Write`/`Edit` 本来就在手——捷径偏置就是这么产生的。
   2. 建集成 workspace：`integration/<name>`（基点为主干），见 2.1 的 workspace 约定；`create_workspace` / `create_agent` 的字段形状与分支改名见 `templates/dispatch-shapes.md`。
   3. 按 `[ROUTE]` 分派：
      - `lead`：按 `templates/lead.md` 组装 brief，派 `agent_profile_shangshu`，然后**本回合阻塞在 `paseo wait <lead-id>`**。
      - `pod`：按 §2.2 直接派 `agent_profile_gongbu`。
   4. 主会话从这一刻起只做三件事：确认点 2、OpenSpec CLI 交回、失联后跑 `reconcile`。

   **本步严禁 `Write`/`Edit` 任何业务源码，也不读业务源码「先了解一下」**——读后写只差一次工具调用。总控代写由 `merge-task.mjs` 的 exit 31 事后拦截，但那只在合流时生效；原地写完不提交就根本走不到合流，2026-10-27 的 `eas-filing-and-local-ocr` 就是这样越过全部门禁的。

### 2.2 执行循环

**DAG 就绪与资源并发**
- 依赖释放：仅当前置任务处于 `DONE`（first-parent 合流 + trailer 验证）时才释放下游。**需要依赖合流的下游必须等 Done，不得提前放行。**
  - **投机流水线（Speculative Pipelining）**：`reconcile.mjs --speculative`（或 `PIPELINE_SPECULATIVE=1`）允许在前置任务已产出领先分支并处于 `MERGE` 待合流状态时，下游任务先以该分支为基线提前派发实施（`SPECULATIVE_READY`），消除线性依赖的等待空转；合流门禁仍严格守住依赖已 Done 的硬前置条件。
- **确定性任务执行器（`task-runner.mjs`）**：将单任务微生命周期（claim → worktree → dispatch → wait → verify → audit → merge）收敛为本地确定性执行器，免除总控 LLM 往返与空等：
  ```bash
  node "$PIPELINE_HOME"/task-runner.mjs <change> <task-id> [--fast] [--speculative] [--dry-run]
  ```
- 资源冲突串行化：`Write scope` 前缀重叠的任务保守串行；互不重叠且工作区隔离的任务在 `cap` 限制内并发派发。cap 是容量上限，不是要达到的目标。
- 共享资源不只文件：同仓多 change 的同文件、公开领域契约、端口、DB 文件、缓存、队列、外部租户与测试账号都要显式声明顺序或隔离，worktree 不隔离这些副作用。
- **运行态保护（fail-closed）**：以下任一成立时 `canDispatchNow` 清空，不派发任何新任务——`runtime` 非 `ok`、存在 `UNMAPPED` 运行中 agent、有未回执派发意图、cap 已满。

**单任务标准状态机**（严禁总控跳步代写）
1. **`READY`**：依赖全部 `DONE` 且 `Write scope` 无冲突 → 先 `claim` 意图，再派发。
2. **`TEST_FIRST`**（若 `Review: strict`）：派 `agent_profile_ceshi` 进该任务的 `task/<name>/<task>` 工作区（与 Writer 同一个，Writer 随后在其 Red 提交上续写；工作区与集成分支隔离）。Writer 不改 Tester 提交的断言，认为断言错就抛 `blocked`。
   - **爆炸半径扫雷（Blast Radius Sweep）**：写新 Red 测试前，强制 `rg` 全局扫描变更枚举/契约在老测试中的断言引用；发现破坏性断言就在信封输出 `conflicting_tests`，报备 Lead 扩大 `Write scope` 涵盖旧测试同步迁移。
3. **`IMPLEMENTING`**：派 `agent_profile_gongbu`（普通）或 `agent_profile_gaogong`（复杂）进 `task/<name>/<task>` 工作区。
   - 提交必须附 `Pipeline-Role: gongbu`（或相应写入角色）与 `Pipeline-Author: <agentId>` trailers；trailer 块必须是最后一个非空段落（块后空行再跟任何一行即整块作废；消息尾部空行本身无害，2026-10-26 探针实测），提交后必跑 `git log -1 --format='%(trailers:key=Pipeline-Author,valueonly)'` 自验非空（模板 `templates/writer.md` 同此要求）。
   - **契约互斥中断协议（Deadlock Protocol）**：确认新 Spec 与既有 Test 存在不可调和冲突时，严禁用底层 hack 欺骗测试；最多尝试 3 次，必须立即抛 `kind: "blocked", reason: "BLOCKED_ON_CONFLICT"` 信封挂起等待裁决，严禁在死胡同内空转。
4. **`AUDITING`**：派 `agent_profile_anchasi` 独立审计。
   - **第 1 轮全量审计（R1）**：检视完整 diff。**4 类 Blocker 准入**：`SPEC_VIOLATION`、`CORRECTNESS_BUG`、`SECURITY_DEFECT`、`SCOPE_VIOLATION`；非 4 类问题（命名、注释、偏好）标 `NIT:` 并签发 `PASS_WITH_NITS`。
   - **第 2 轮增量审计（R2）**：R1 有 Blocker 时，写手针对性修复后 Auditor 复核。**R2 优先复核 R1 Blocker 是否闭环与修复影响面**；修复引入或暴露的**新的**正确性、安全、规范问题，照常作为 Blocker 阻断，并记录新增原因。不得因为「发生在原 diff 之外」而放过。
   - **硬轮次熔断**：单任务最多 2 轮审查。R2 仍未通过即熔断，进仲裁。**熔断是「暂停并裁决」，不是降低通过条件。**
5. **`ARBITRATION`**（熔断后）：派 `agent_profile_hanlin`（Arbiter）单回合裁决，标签 `pipeline.phase=arbitrate`、`pipeline.role=hanlin`、attempt 与 R2 相同，`claim --phase arbitrate --role hanlin`。仲裁员不写代码。
   - `OVERRULE`：驳回无依据的 Blocker，须给出理由与收据，签发 `pass(...)`；
   - `PATCH`：Lead 把写手标 `rejected`，`reconcile` 给出升级重派（`gaogong`），写手按仲裁指定的范围与 `closing_criteria` 修复；修完再派一个 `hanlin` 实例**重新跑测试并独立复核**后签发 `pass(...)`。**不按行数放行**；
   - `ESCALATE_HUMAN`：确属规范语义分歧 → 写手与仲裁员都**不打** disposition，`reconcile` 以 `UNRESOLVED` 压住该任务；保留工作区，回冻结确认（规范变化由人类决策，不是仲裁员越权改需求）。
   - 审计/仲裁结论到 `pipeline.disposition` 的完整映射、返工 workspace 的基点（上一 attempt 的分支）见 `templates/lead.md`「单任务阶段推进」。`reconcile` 只判产出与预算，**阶段顺序由编排者按 `Review` 档推进**：分支领先即报 `MERGE`，不代表已审。
6. **`MERGING`**：调用 `merge-task.mjs`（第 5 节门禁）。
7. **`DONE`**：释放下游依赖。

**规约演进与停滞信号**
- **规约演进协议（Schema Evolution Protocol）**：涉及底层状态机或公开契约升级时（如 `INTENT` 演进为 `SUBMITTING`），必须在 tasks 编制阶段扫清老测试影响面，把需迁移的老单测纳入 `Write scope:`，禁止把写手逼入「改测试算越权、不改算失败」的不可能三角。
- **停滞信号（非自动熔断）**：连续 ≥5 次在同一断言失败、或单文件编辑 >15 分钟无推进，是**预警信号**，由 Lead 核实后处置（追问、换角色、升级）。**不自动判定死循环，也不因为一个阈值就中断有价值的工作。**

### 2.3 验收与交回（含人类确认点 2）

1. **集成环境真实运行**：用集成分支精确 SHA + 启动配置 + 隔离测试数据，从**真实 API/UI 入口**跑冻结的业务验收矩阵。核验服务装配、持久化、授权、异常补偿、重试/幂等与适用的重启恢复，不只调用内部函数。
2. **有 UI 时**做实际交互与适用视口走查。截图存在不代表业务成功。
3. **证据双闸门**（第 6 节）：`--gate structure` 留档，`--gate acceptance` 才判定通过。验收闸门只接受约定通过结论、无未验证项、且绑定本次验收 revision。收尾固定跑这两条，缺任何一条都不算验收完成：

   ```bash
   node "$PIPELINE_HOME"/test/check-evidence.mjs --gate acceptance --sha <集成HEAD> --matrix openspec/changes/<name>/acceptance.md <smoke 证据>
   node "$PIPELINE_HOME"/contract-check.mjs openspec/changes/<name>/specs --tasks openspec/changes/<name>/tasks.md --baseline openspec/specs --final --max-phantom <预算>
   ```

   `--matrix` 从冻结的验收矩阵读必需场景（调用者只能追加，不能减少）；`--final` 让「测试路径一条都没产出」从 SKIPPED 变成 exit 1——收尾报告里写着「跑过 contract-check」却是空跑，是这条开关唯一的理由。

   **`--final` 不改变场景对账口径**，它只管「有没有产出」。所以收尾命令还有三个部分，缺了就会得到一份恒红的报告：
   - **spec 传 change 的 `specs/` delta，并加 `--baseline openspec/specs`**。测试语料是整个 skill 级的，而 delta 只声明本 change 涉及的场景；不并基线，历史场景全部变成 phantom（本仓 2026-10-27 实测：只传 delta 38 条 phantom，并入基线后 31 条）。
   - **反过来只传整树也不行**：那时基线里那些「本仓库确实没有测试引用」的场景会被算成 untested，把本 change 的收尾拖红（实测整树口径 51 条 untested）。`--baseline` 的分工是**只把基线场景从 untested 判定里排除**——本 change 没有义务给继承来的场景补测试（它们由基线负责），但仍要为自己的新增场景负责。本仓实测：delta+baseline 口径 0 条 untested。
   - **`--max-phantom <n>` 把存量债记成预算**。本仓 2026-10-27 实测 31 条（整树 + 全测试目录口径为 83 条，多出的部分含测试夹具里临时编的编号）。这些是历史债，不是本轮交付的判断对象。**收尾时贴当轮实测数**，新增一条就越界失败——既不假装清零，也不让门禁永远红着没人看。预算不是豁免：写下的数字必须是**实测过、且该条在此前 change 里已存在**的。
   - 场景编号写在测试注释行里也算引用：JS 的 `// SCEN-…` 与 shell 用例表的 `# SCEN-…` 都会被读到。shell 的 heredoc 夹具不算（那是被构造的输入）。
4. **OpenSpec 交回点**：需要 `validate`/`archive` 时，Lead 在最终信封里列成**唯一待办请求**并在运行账本标等待；主会话执行后回执，Lead 才继续。文档改动不等于获得 CLI 或发布授权。
5. **归档集成 change**：`openspec archive <name> --yes`（主会话）。
6. **人类确认点 2：合入主干**：呈报 diff 摘要、验收 SHA、测试与业务验收记录，经用户确认后方可合入主干。未经确认绝对禁止合入 main、推送远端或发布外部服务。确认后同一回合 `run-state.mjs confirm --checkpoint cp2` 登记时间。
7. 归档工作区，`git branch -d` 清理已合入主干的分支。

**主会话不是 Paseo agent**：主会话（Claude Code）不在 agent 图里，`send_agent_prompt` 发不到它。主会话等 Lead 的正确方式是**阻塞在 `paseo wait <lead-id>`**（后台 Bash / Monitor 均可，由 harness 通知），返回后读 Lead 的最终信封（`paseo logs` 或 `get_agent_activity`），再执行它列出的待办请求。不要设计「Lead 主动 push 给主会话」的路径——那条路在结构上不通。

**矩阵的 `Verify` 列必须先被执行**：`check-evidence --matrix` 只读 `Required`/`Result` 两列，`Result` 是自报值。回填 `PASS` 之前先跑执行器（退出码 0/1/2/3/4 见第 6 节）：

```bash
node "$PIPELINE_HOME"/acceptance-run.mjs <name> [--only SCEN-1,SCEN-2] [--write]
```

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
node "$PIPELINE_HOME"/run-state.mjs begin  <change> --owner <owner-id>
# 派发前：认领意图（幂等键 [run,task,attempt,phase,role,action]）
node "$PIPELINE_HOME"/run-state.mjs claim  <change> --task T-01 --attempt 1 --phase impl --role gongbu --owner <owner-id>
# 派发后：登记真实 agent/workspace；--envelope 顺带交给机器校验阶段信封
node "$PIPELINE_HOME"/run-state.mjs record <change> --key <key> --agent <agent-id> --owner <owner-id> [--workspace <id>] [--envelope <file>] [--role <role>]
# 创建确认失败：显式作废意图，才允许重派
node "$PIPELINE_HOME"/run-state.mjs fail   <change> --key <key> --reason <text> --owner <owner-id>
# 审计结论：登记到账本才能算首次通过率（由 Lead 在收到审计信封后写入）
node "$PIPELINE_HOME"/run-state.mjs review <change> --task T-01 --round 1 --verdict PASS --agent <auditor-agent-id> --owner <owner-id>
# 合流事实：由 merge-task.mjs 提交成功后自动写入，不手敲
node "$PIPELINE_HOME"/run-state.mjs merge  <change> --task T-01 --sha <merge-sha> [--attempt 1] [--review-tag <tag>]
# 人类确认点：确认发生的那一刻登记（cp1=spec 冻结，cp2=合入主干），不要事后补记
node "$PIPELINE_HOME"/run-state.mjs confirm <change> --checkpoint cp1|cp2 [--note <text>] [--owner <owner-id>]
# 查看：租约、未回执意图
node "$PIPELINE_HOME"/run-state.mjs status <change> [--json]
# 度量：派发次数、首次通过率、READY 等待、确认点跨度（只写账本能算出的数，采不到的项打印「未采集」）
node "$PIPELINE_HOME"/run-state.mjs report <change> [--json]
```

- **有租约时 `--owner` 必填**：`claim`/`record`/`fail` 三个动作在租约生效期间一律要求 `--owner` 且等于当前 owner，否则 exit 2。照抄不带 `--owner` 的写法在 `begin` 之后必然被拒——这是租约在生效，不是命令写错了。租约未启用的单机场景才允许省略。

- **意图键必须完整**：`claim` 要求 `--task --attempt --phase --role` 全部给出（`--attempt` 为正整数），缺一项直接 exit 1。半截键写进账本后，`reconcile` 既归不了因也排不进 `NEXT`，等于制造一条看不见的意图。
- **`record` 校验派发标签**：登记真实 agent 后回读该 agent 的 Paseo 记录，缺 `pipeline.change/task/attempt/phase/role` 任一标签时在 stderr 打 `WARN`（提及会造成 `UNMAPPED` 与 write-guard 失豁免），**只告警不拒绝**——标签是归属依据，`record` 不该因为标签写错而把已经在跑的回执丢掉。读不到记录（`PIPELINE_PASEO_HOME` 无此项等）时不发声。
- **动作意图幂等**：同一幂等键已有未回执意图时，`claim` 以 exit 2 拒绝重复派发。**先记意图，再派发，再记回执。** 创建成功但回执丢失时，按唯一标签对账，未排除重复前不盲重派。
- **`fail` 只作废「还没回执」的意图**：已有真实 `agent` 回执的意图不得 `fail`（exit 2）。作废的语义是「这次派发确认没有发生」，而回执证明它发生过并指向一个具体 agent——agent 中途失联是 `reconcile` 的 rework，用**新的 attempt 键**重派，不要抹掉这次派发的痕迹。
- **单 owner 租约**：同 run 只有一个有效 owner。租约过期后旧 owner 的全部 `claim`/`record`/`fail` 一律 exit 2，必须显式 `begin` 领取新代际——防止旧 Lead 复活后继续提交动作。**租约仍有效且属于他人时不得抢占**，等其 renew 或超时。
- **信封进机器校验（`record --envelope`）**：`record` 可带 `--envelope <file>`，把子 Agent 的信封交给 `lib/envelope.mjs` 校验：7 个统一字段（`task`/`attempt`/`phase`/`result`/`reviewed_sha`/`blockers`/`next_action`）齐全、枚举合法、`result` 与 `next_action` 不自相矛盾、无重复字段、行数不超限（写手 20 行，`anchasi`/`hanlin` 审计信封 25 行；行数上限由 `--role` 决定，不给就按写手算）。不合格即**拒绝回执**（exit 2）——回执是「这次派发产出了什么」的唯一入口，放行一封结构不合格的信封等于把下游判断推回自由心证。字段快照写进意图的 `envelope`，不留原文（账本是状态，不是日志）。
- **`review` 与 `merge` 是度量的事实来源，不是可选装饰**：`review` 登记审计结论（`task`/`attempt`/`round`/`verdict`/`agent`/`sha`），同一 `(task, attempt, round)` 幂等覆盖；`merge` 由 `merge-task.mjs` 写入合流事实（任务列表 + 合流 sha + review-tag）。`report` 的首次通过率只数 `reviews[]` 里每个任务**首轮**（round 最小）的 verdict：分母是「有审计结论的任务数」，不是派发数；没有 review 记录就是「未采集」，不是「100%」。
- **确认点时间只在确认当下登记**：`confirm --checkpoint cp1|cp2` 由收到人类确认的那一方在同一回合写入。同一 checkpoint 重复登记是幂等的——保留首次时间、只累加 `repeated` 与 `lastAt`，因为「再次确认」通常意味着冻结被推翻，覆盖时间会让等待跨度永远看起来很短。`report` 的 `confirmations` 只回显账本里的时间；两项不齐就打印「未采集」，不推算「本该多早」。
- **READY 等待的口径写死在数据里**：`claim` 在新意图建立时，若同任务存在更早、已了结（`resolvedAt`/`failedAt`）的意图，就记一条 `readyObs`（`waitMs` + `basis: 'prev-end→claim'`），同一对相邻动作不重复计时。`report` 打印中位数/最大值并回显口径——依赖解除的时刻账本不一定知道（依赖可能在别处合流），所以这是「排队时长」，不是 end-to-end 的 READY 时间。
- **change 名必须是位置参数形态**：命令后的第一个位置参数（change）若以 `--` 开头或含非法字符，一律 exit 1 并给出正确写法。历史上把 `--change foo` 照抄进 `status` 会静默新建一份游离账本（实测 `approval-hub` 里已留下 `--change/`、`--key/` 两份 `run-state.json`，前者还持有租约）。
- **孤儿意图（`ORPHAN_INTENT`）**：意图超过 10 分钟仍无对应 agent（创建失败或回执丢失）。`reconcile` 把它列为最高优先级 `NEXT arbitrate`，**自动化不得自行重派**，须核对后显式 `fail` 或 `record`。
- **无 heartbeat 子命令**：注册入口已删（2026-10-26）。常规运行不建周期性 heartbeat，且 `hardening-governance-contracts` 账本里 `heartbeats` 为 0——没有使用者的写入路径不留。旧账本里的 `heartbeats` 数组仍是只读兼容字段，`status` 照常打印。
- 存放位置：git common dir 下 `paseo-pipeline/<change>/run-state.json`（不放 `openspec/`，否则弄脏工作树阻塞合流）。`PIPELINE_RUN_STATE_DIR` 可覆盖。
- **Skill 版本留痕**：`begin` 领取租约时把当前 Skill 的 git HEAD 与是否 dirty 写进账本（`skill` 字段）。`status` 发现与当前 HEAD 不同**只警告不拦**——读旧账本、跨机器诊断都不该因为版本不同而失败。但复盘要判断「某条规则当时是否存在」只能靠这个字段，所以不许省掉；旧账本没有这个字段时如实输出「SKILL 未采集」。

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
node "$PIPELINE_HOME"/merge-task.mjs <branch> <task-id> <review-tag> [<test-cmd> | --fast] [--allow-legacy-author]
```

1. 校验当前分支为 `integration/<change>` 且工作区干净。
2. **依赖门禁**：任务依赖必须已在集成 HEAD 上被 first-parent 合流证明为 `DONE`（exit 35）。直接调用本脚本不能绕开调度顺序。
3. **冻结验证命令与快速通道（Fast Path）**：本任务及本次合流涉及的每个任务，其 `Verify with` 若不可解析为可执行命令，直接 exit 36 拒绝；可解析的**先逐条执行**。传入 `--fast`（或位置参数 `fast`/`auto`/`none`）时启用任务级快速合流通道，仅执行冻结的 `Verify with` 命令，不追加全量测试套件，在 `run-log.md` 记 `verify_source="tasks.md fast-path (...)"`；未启用快速通道时位置参数 `<test-cmd>` 追加执行。失败时打印 `Verify source: tasks.md (...)`，便于区分是哪个契约没过。
4. **因子 1 写范围封闭**：`git diff` 的修改文件必须 100% 落在任务 `Write scope:` 前缀内（exit 30）。
5. **因子 2 作者血统与控制面隔离**：**逐个 commit** 校验必须带 `Pipeline-Role`（属于 `gongbu`/`gaogong`/`ceshi`/`jiangzuo`）与 `Pipeline-Author`；缺失或属控制面（`shangshu`/`lead`/`anchasi`/`hanlin`）以 exit 31 硬阻断。逐个 commit 判定，防止一个合法提交掩盖另一个无 trailer 的提交。`qingqibing` 仍被 `lib/roles.mjs` 识别为写手角色，但只为读取历史标签——新派发不得再用它。
6. **因子 3 独立非自审**：`review-tag` 必须为 `pass(<reviewer-id8>@<tip7>/<base7>)`；`reviewer` 与任一 `Pipeline-Author` 相同即 exit 32（完整 UUID 与唯一可解析前缀都比对，歧义 fail closed）。`Review: strict`/`standard` 严禁用 `mechanical`。
6a. **因子 3b 审查员与派发记录交叉核对**（仅当该 change 的运行账本存在时生效）：只比对 commit 作者不够——历史 T-02 事故里写手提交没有 `Pipeline-Author` trailer，自审检查完全落空。有账本时，`reviewer` 不得等于本次合入任务中任一**写手意图**（`role` 属写入角色）的 `agentId`（exit 32），且必须命中其中至少一条已回执的 `anchasi`（审计员）或 `hanlin`（仲裁员）审查意图（Pod 是一次审查覆盖整组，不要求逐任务各派一次）；账本不可解析同样 exit 32，不得按「没记录」豁免。
    - 账本不存在时沿用 trailer 检查，但**跳过必须留痕**：run-log 记 `review-attestation=SKIPPED(no-run-state)`。有账本记 `run-state`，mechanical 审查记 `mechanical-review`。门禁静默消失与门禁通过必须可区分——2026-10-26 的 5 任务冒烟就是这样全程 `present=false` 跑完，自审交叉核对一次未执行而账本无痕。
6b. **Pod 成员集合**：`pod/<change>` 分支必须附带冻结的 `openspec/changes/<change>/pod-members.json`，且 `<task-ids>` 必须**恰好等于**该成员集合（多报、少报、缺文件均 exit 31）。分支名不携带任务身份，成员真源只有这一份冻结记录。
6c. **legacy 豁免需二次确认**：`--allow-legacy-author` 会整体关闭作者血统门禁，必须同时设置 `PIPELINE_ALLOW_LEGACY_AUTHOR=1`，否则 exit 31；放行时 run-log 记 `author-provenance=BYPASSED(legacy)`。控制面角色检查不受豁免影响。
6d. **因子 3c 异构审查**（有账本时生效，紧跟 3b）：3b 只证明「审查者不是写手本人」（agent id 不同），没证明两者不是同一个模型跑出来的。实测角色分布里 `gaogong` 与 `anchasi` 同在 codex 家族——一条 codex 写的任务被另一个 codex agent 审，账本上「独立审查」齐全，实际是同源自证；换 profile 名或 model alias 都不改 provider。因此从 Paseo 持久记录取 `reviewer` 与各写手意图的**真实 provider** 比对：相同即 exit 38。`lib/heterogeneity.mjs` 只比 `provider`，不比 model（同 provider 下的 model alias 在会话间会漂移，拿来判「不同模型」会假阳性）。
    - 显式豁免：`PIPELINE_ALLOW_HOMOGENEOUS_REVIEW=1` 时放行并在 run-log 记 `heterogeneity=BYPASSED(homogeneous; …)`——豁免是给人看的，不是给门禁消失用的。
    - provider 读不到记 `heterogeneity=unresolved(...)`，**不阻断**（拿不到的记录不能既当证据又当免责），但那行必须落进 run-log；mechanical 审查记 `not-applicable`；无账本记 `heterogeneity=NOT-CHECKED(no-run-state)`。
7. **基线锚定**：`base7` 必须同时是集成 HEAD 的祖先、以及被合入 tip 的祖先（任一不满足即 exit 34）——集成在任务分支拉出后前进一步时，那个新 HEAD 仍是集成历史祖先，但 `base..tip` 已把本任务没写过的提交算进审查范围。与当前集成 HEAD 漂移且改动文件重叠时拒绝合流要求重审，不重叠则记录漂移放行。
8. **合流固定 tip**：用审查收据绑定的那个 commit（而非可变分支名）合流，避免「审查过的内容」与「实际合入的内容」漂移。
9. **显式测试命令 + 截止时间 + 整树清理**：执行冻结命令与 `test-cmd`，默认超时 30 分钟（`MERGE_TEST_TIMEOUT_MS` 可调）。超时按**进程组**终止（SIGTERM，2 秒后 SIGKILL），不是只杀外层 shell——否则测试拉起的孙进程会继续写工作区。失败、超时、或**测试改写了工作树**（前后 `git status --porcelain=v1 --untracked-files=all` 指纹不一致）一律拒绝提交测试副作用；先撤掉对已跟踪文件的改写，再 `git merge --abort` 恢复现场，**严禁 `reset --hard` 回滚**。abort 失败、或 `MERGE_HEAD` 消失而 HEAD 已被推进（测试命令自己执行了 `git commit`）时保留现场并打印人工指引（exit 40）。
10. **原子记账与血统透传**：自动勾 `tasks.md`、追加 `Done: source=<tip7> review=<review-tag>`，原子提交附 `Pipeline-Task`、`Pipeline-Source`、`Pipeline-Author`、`Pipeline-Role`、`Pipeline-Reviewer` trailers。
11. **回执丢失的处置**：任务已 Done 一律 exit 非零且不产生新提交。错误文案区分两种情形——Done 行绑定的 source 就是本次 tip 时报「已从该 tip 合过，这是回执丢失后的重试，合流其实已成功，不要重派任务」；source 是别的 revision 时报「不同 revision 不能用同一任务合流」。**收到前一种报错时禁止重派写手**，去核对 `git log --first-parent` 即可。

退出码：30 写范围 / 31 作者血统或 Pod 成员不符 / 32 非自审（含审查员与运行账本派发记录不符）/ 34 base 非集成 HEAD 或非 tip 祖先 / 35 依赖未验收 / **36 不允许的 `Verify with`** / **37 并发合流被锁拒绝** / **38 审查者与写手同 provider（同源自证）** / 10 冲突 / 20 测试失败或改树 / 40 abort 失败。

## 6. 证据双闸门（`test/check-evidence.mjs`）

```bash
node "$PIPELINE_HOME"/test/check-evidence.mjs --gate structure  <file>   # 留档：FAIL 也 exit 0
node "$PIPELINE_HOME"/test/check-evidence.mjs --gate acceptance --sha <acceptance-sha> <file>
node "$PIPELINE_HOME"/test/check-evidence.mjs --gate all --sha <acceptance-sha> <file>
```

- **结构闸门（默认）**：只校验字段齐备、UUID/时间戳合法。**FAIL 报告的合法留档也 exit 0**——失败调查可以完成。字段清单的唯一定义在 `lib/evidence-contract.mjs`，写证据照 `templates/evidence-smoke.md` / `templates/evidence-audit.md` 抄：三处指向同一份定义，改一处不会静默漂移。
- **占位值不是采集值**：`PLACEHOLDER`/`TODO`/`FIXME`/`TBD` 等占位专用词按子串匹配；`LOST`/`UNKNOWN`/`TEST`/`NOT_COLLECTED` 这类通用词按词边界匹配（边界为空白/下划线/字符串边缘），因此真实标识里的子串（如 ULID 片段 `01JAXLOSTFOUND`、路径 `a.test.mjs`）不误伤，而编造收据的分隔形态（`msg_01JAX_LOST_NOTIFICATION`）仍拒绝。全同字符的退化 SHA 同样拒绝。以上与「字段缺失」同等对待，结构闸门即拒绝。采集不到就写「未采集」并说明原因，不要编一个看起来像收据的值。
  - **判据的作用范围是「闸门读的字段」**：契约字段（`lib/evidence-contract.mjs` 里列的那些）与 `*_command` 形态的命令字段。`notes: the TEST harness was restored, for example …` 这类人话不参与判定——闸门不读它，它的措辞就不该决定收据存亡。命令字段另走整值判据：`npm --prefix packages/server test` 是命令，`TODO` 才是占位。
  - **「未采集」是合法的留档值，不是可验收值**：验收闸门会拒掉写「未采集」的必填字段。这两条不矛盾——留档要如实，验收要真值。
- **验收闸门**：只接受约定通过结论，且要求
  - 必须先过结构闸门；**smoke 与 audit 都必须给 `--sha`**——没有 revision 绑定的证据无法证明「当前这份代码」被验证过，smoke 已带 `reviewed_sha` 时还要与之一致；
  - smoke `result: PASS`、`unverified:` 为空、`notification_at >= dispatched_at`；
  - audit `verdict` 属约定通过集合、`reviewed_sha` 与 `--sha` 一致（7 位前缀与完整 sha 可互比）；
  - `--require-scenario <SCEN-ID>` 指定的场景不只要「被提到」：必须在 `scenario_results:` 段落里有 `<ID>: PASS` 的结论，且不得同时挂在 `unverified` 列表（自相矛盾直接拒绝）。**正文提及、注释、TODO 都不算验证**；记为 `FAIL`/`BLOCKED`/`SKIPPED` 同样阻断。
  - `--matrix openspec/changes/<name>/acceptance.md` 从冻结的验收矩阵取必需场景（`Required: yes` 的行），矩阵里没通过的行同样阻断验收。调用者只能 **追加**（`--require-scenario`），不能减少——与 merge-task 对冻结 `Verify with` 的口径一致。
  - **矩阵的 `Verify` 列由 `acceptance-run.mjs` 真正执行**：`--matrix` 只是把矩阵当「必需清单」读，矩阵行里的 `Result` 仍是自报值。收尾回填前必须先跑执行器，把 `Required: yes` 行 `Verify` 列的命令逐条执行（与 `tasks.md` 共用同一套「是否可执行命令」判据，见 `lib/acceptance-matrix.mjs` + `lib/tasks.mjs` 的 `parseVerify`）：

```bash
node "$PIPELINE_HOME"/acceptance-run.mjs <change> [--only SCEN-1,SCEN-2] [--timeout <ms>] [--dry-run] [--write] [--json]
# 0 全通过 / 1 有失败或超时 / 2 用法错误或 Verify 不是可执行命令 / 3 仍有必需行未被本次执行覆盖 / 4 仍有 BLOCKED 行
```

    - **自然语言 `Verify` 是硬失败（exit 2），不是「跳过未验证」**：跳过等于让那行永远不需要证据。
    - `--only` 是**局部重跑**，不能当全量验收：有必需行未被覆盖即 exit 3。窄跑不得冒充全通过。
    - `--write` 只回填本次真正执行过的行的 `Result`/`Evidence`（按行改写，保留列宽与人工标的 `BLOCKED`）；收据固定落在 `<run-state>/<change>/acceptance-receipt.json`，`head` 采不到就写 `null`，不伪造 SHA。
  - `child_agent_id` 必须在 Paseo 持久记录里**真实存在**，且 `dispatched_at`/`notification_at` 不得早于该 agent 的真实 `createdAt`。Paseo 目录不在本机时用 `PIPELINE_SKIP_PASEO_LOOKUP=1` 显式豁免——豁免本身即报错，只能当结构留档。
- **FAIL、BLOCKED、SKIPPED、未验证、非 pass verdict、过期 revision 一律不能折算 PASS。** 调查任务完成 ≠ 被调查能力完成。

## 7. 失败处置与恢复

1. 读 `git log --first-parent integration/<name>` 与 `tasks.md` Done 行，二者是**已合流事实**的唯一账本。
2. 任何时候断链：`reconcile.mjs <change>` 拿真实任务图与 `NEXT` 动作，按其推进。
3. 运行态未知（`UNMAPPED`/`degraded`/`unavailable`/孤儿意图）→ 先归类或仲裁，不盲目重派，不盲目合流。
4. **脏树先归因再推进**：`reconcile` 的 `DIRTY` 行逐条标 `UNEXPLAINED` / `OUTSIDE_SCOPE` / `covered(...)`。`UNEXPLAINED`（落在某任务 Write scope 内、账本却没有该任务的在途写手意图）是就地代写的强信号，进 `HOLD` 且不清空派发以外的动作——先核对来源（是某写手误在集成树里改的，还是总控代写），再决定保留或丢弃。作废（`fail`）的意图不构成覆盖。
5. 无法自动恢复时**明确挂起**并报告人类：保留 workspace 与运行账本现场，说明卡点、已知事实与需要的决策。

## 8. 硬底线与硬红线

**硬底线**：不抓凭据/直连 API/冒用身份；push、`rm -rf`、`--amend` 先问；两个人类确认点。

**总控硬红线（Negative Constraints）**：
- 总控（主会话 / Shangshu）**严禁**直接对业务代码调用 `Write`/`Edit` 编码，必须委派 `gongbu` 或 `gaogong` 独立完成；
- 总控**严禁**在任务分支或集成分支上手写业务 `git commit`（代码由写手提交，合流由 `merge-task.mjs` 独占提交）；
- 总控**严禁**手工勾选 `tasks.md` 的 `[x]` 或追加 `Done:` 行（`merge-task.mjs` 原子记账）；
- 总控**严禁**自产自审；必须由独立 Auditor（`anchasi`）或机械验证生成合流 review 标签。

**这些是协作契约与自报元数据，不是工具级身份隔离或可信来源证明。** 真实防线是 `merge-task.mjs` 的机械门禁（写范围、作者血统、非自审、异构 provider、依赖、基线），加上独立的业务验收。不得声称提示词能物理封死总控代写。

**写范围守卫（减速带，不是沙箱）**：有编排租约期间，命中某任务 `Write scope` 的 `Write`/`Edit` 必须能对上一个在途写手意图，否则拒绝。**位置优先于意图**：主 checkout（`git rev-parse --git-dir` 与 `--git-common-dir` 指向同一处）里的任务 scope 写入一律拒绝，即使账本里有该任务的写手意图——意图只证明「这个任务派过写手」，不证明此刻的写入者就是那个写手，而写手一律在自己的 linked worktree 里。判据只有一份（`lib/scope-guard.mjs`），两个入口：

```bash
# 诊断 / 事后复核（单 change 或扫描全部活跃租约）
node "$PIPELINE_HOME"/guard-scope.mjs [<change>] --path <file> [--json]
# PreToolUse hook 的安装片段（需人工加进 ~/.claude/settings.json）
node "$PIPELINE_HOME"/hooks/scope-guard-hook.mjs --install-help
```

刻意保守：无有效租约放行（门禁只在一次 run 内成立）、`openspec/` 放行、路径不在任何 scope 内放行（越界提交由 `merge-task` exit 30 兜底）、读不到 `tasks.md` 放行（fail-open）。**Bash 的 `sed -i`、`>` 重定向、`git apply` 拦不住**，也**拦不住 Codex 写手**——它们不跑 Claude 的 PreToolUse hook，所以写手的 linked worktree 判定只对 Claude 侧生效。这是减速带，不能拿它宣称物理隔离。关闭方式：`PIPELINE_GUARD_SCOPE=off`（排障用）。

账本位置由**目标路径**反推仓库，不是由调用方 cwd 决定：hook 由 Claude Code 在 session 的 cwd 下启动，而 session cwd 与写入目标所在仓库可以不同（往另一个 checkout 写绝对路径很常见）。曾把账本锚在 `process.cwd()`，从别的仓库调用时扫不到目标仓库的租约，守卫输出为空、deny 静默退化成 allow。目标落在 cwd 所在仓库内时仍按 cwd 判定，相对路径语义不变。

**只读角色约束**：Auditor、Arbiter、Scout 等只读角色要求最小权限，brief 显式声明**禁调 memory 工具与不必要的网络访问**——但**允许完成审查所需的授权本地查询**（如读仓库、跑 `rg`、用 codegraph），不要一刀切禁 MCP 后又要求同一角色使用 codegraph。
