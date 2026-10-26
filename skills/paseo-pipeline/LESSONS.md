# Paseo Pipeline 实践与踩坑记录 (LESSONS.md)

本文件是**证据与历史复盘**，不是操作规程。规程、门禁与判据以 `SKILL.md` 为准；两者冲突时以 `SKILL.md` 为准。

每条记录标注日期、适用版本与限制。**早期条目里的因果结论若已被后续实测推翻，就地更正并标注，不保留并列的旧说法。** 未采集到的事实写「未采集」，不估算。

---

## 1. 角色与派发

- **角色边界只认活态 profiles**：角色职责以 `list_profiles` 的 `notes` 为唯一真源。历史上曾把 Tester 误写成「只写单测」，而 notes 里其实支持 E2E 与跨模块集成测试。禁止在 skill 中硬编码或自创角色边界。
- **编排者不留在主会话**（2026-10-23 `vector-ops`、2026-10-24 `number-theory-factors` 两次实测）：主会话亲自编排均遭遇上下文压缩。判据：预计派发 ≥6 次或预计 >30 分钟的任务交 `agent_profile_shangshu` 无人值守；微型 Pod 任务（通常 ≤3 次派发）主会话直接编排。
- **只读角色静音**（2026-10-23 `vector-ops`）：Auditor 因调用 memory MCP 工具被安全策略拦截，停在等待权限状态，整条完成通知链挂起数分钟。只读角色 brief 须显式声明禁调 memory 与不必要网络工具——**但允许完成审查所需的授权本地查询**（读仓库、`rg`、codegraph）。一刀切禁 MCP 会让同一角色无法使用 codegraph。
- **create_agent 参数防御**（2026-10-24 `integer-sequence-ops`）：漏传 `title` 触发 `MCP error -32602`。`title` 为 Schema 必填且 ≤60 字符，统一格式 `[Pipeline] ${role} ${task} ${change}` 截断。
- **tasks.md 标题序号漂移**：任务标题若在 DAG 设计中调整过层级序号（`1.4` → `2.1`），按带序号长字符串查找替换会报 `String to replace not found`。Done 行定位必须基于任务 ID 锚点（`T-NN:`）。
- **空行/注释不破坏 Done 解析**（2026-10-25 实测更正）：此前记录担心「Done 行插在任务行后会被空行/注释错行」。内存探测显示解析器允许这些间隔，能正确读取 Done。**该缺陷不成立，已撤回。**
- **历史 loader 失效（2026-10-25，Skill 仓库旧版）**：旧 loader 用正则逐个匹配 `- [ ] N.M T-xx ...`，遇到标题序号被重排就会静默返回空列表，导致 reconcile 误报「全任务 READY」。**已由 `lib/tasks.mjs` 的锚点解析 + 显式 `errors[]` 取代**；新解析器对未知 Review、未知风险词、机械档与风险面冲突均直接报错，不再静默降级。

## 2. Workspace 与分支生命周期

- **分支命名一致性**：历史上出现过 change 叫 `vector-ops`、分支建为 `integration/vector-ops-concurrency`，导致对账完全失效。一律 `integration/<name>`、`spec/<name>`、`pod/<name>`、`task/<name>/<task>[-aN]`。
- **Base branch not found 竞态**：以刚创建的分支作 baseBranch 时，daemon 本地引用可能未就绪，首建报 `Base branch not found`（实测延迟达 48 秒）。规避：spec workspace 基点用主干；任务 workspace 创建时一律带 `path: <主仓库路径>`。
- **Spec workspace 归档时机**：08:24 spec 冻结后曾漏归档 spec workspace，滞留至 08:43:56 收尾，晚了约 19 分钟。冻结确认点 1 的三步固定为：合流 → 立即归档 spec workspace → 再派首个任务。
- **故障工作区保留现场**：打回或失败的任务若被自动归档，日志与现场丢失，无法定位根因。故障工作区保留，由人工介入。

## 3. 调度与空等损耗

- **完成通知处理反例**：同一轮连续三次空等——scale 的 Runner 08:27:42 完成、Auditor 08:32:57 才派出（空等 5m15s）；dot 的 Tester 完成后空等 4m09s；norm 的 Runner 完成后空等 3m06s。空等期间仅在整理长上下文，上下文压缩多发生在此间隙。**注意：这组数字来自 2026-10-23/24 的具体会话，不是普遍基线；**后续任何「并发度/空等损耗」统计都必须在修复状态观测之后重新采集（见第 10 节）。
- **极简信封驱动**：收到通知后快速完成「验状态 → 记意图 → 派下游」，**不在派发前深入推理解读长篇日志**。但「先派发」只适用于**不依赖本任务 Done** 的下游：需要本任务合流才能释放的下游，必须先合流再派（与第 30 条一致）。合流被推迟到「等待空档」不是规则，是把依赖链拉长的常见原因。
- **禁止跨任务批量合流记账**（2026-10-24 `integer-sequence-ops`）：T-01/02/03 并发完成后被批处理成一个 commit，导致仅依赖 T-01 的 T-04 从 11:04 等到 11:06，约 2 分钟无谓排队。单任务合流记账提交后立即重算 Ready 并派发就绪下游，消除批量屏障。
- **通知静默丢失与惰性对账**（2026-10-25 `pipeline-native-closure`）：**已确认的现象**是子 Agent 终态后父 Lead 未被唤醒、出现停摆，需人工催进或手工触发 `reconcile.mjs`。**尚未定位**是送达、回合启动还是处理链哪一环失败；不能把 `idle` 快照直接解释成通知丢包根因。Heartbeat 是恢复机会，不是交付保证。

## 4. Spec 设计与尺寸分档

- **避免单函数单独立项**（2026-10-24 `number-theory-factors`）：4 个小函数 + 1 个导出被拆成 5 份 spec，产物 369 行，为实现代码（87 行）的 4.2 倍。同域能力聚合到一份 spec（单能力挂多 Requirement/Scenario）。
- **公共入口契约归属**：`index.js` 等公共入口导出契约归属唯一目录、合并为一条 Requirement，避免归档后主 spec 臃肿。
- **数值契约自检**：次正规区间（`|x| < 2 ** -1022`）网格间距恒为 `Number.MIN_VALUE`，相对误差界恒不成立——出现相对误差条款必须加 `Math.max(E, 2 ** -1022)` 下限。另：加入「所有 literal 均为正确舍入值」元条款时曾与 `norm([3e200, 4e200]) === 5e200` 冲突（真值 `4.9999999999999995e200`），误杀合规实现。
- **Write scope 与老测试迁移冲突须在冻结前解决**（2026-10-25）：把 scope 机械定为单一业务文件、又要求「老单测 100% 通过」，会让写手陷入「改测试算越权、不改算回归失败」的不可能三角。规约演进类变更必须在 tasks 编制阶段扫清老测试影响面，把需迁移的老单测纳入 `Write scope:`。

## 5. contract-check 演进历史

- **历史测试污染**：向门禁传入整个 `test/` 目录时，增量仓库既有历史断言会被全部判 `undeclared`（实测一次报 `undeclared=48`）。门禁测试侧只传本 change 声明的测试。
- **级别语义区别**：单任务测试只覆盖局部，按全量跑必然 `untested > 0`（实测 T-02 单任务跑全量报 `untested=11`）。任务级用 `--partial`（只验 `undeclared=0`），收尾才要求全量双零。
- **断言字段与被测回调过滤**：旧版把 `assert.throws(..., { name: "RangeError" })` 的 `name` 误判为消息，把 `assert.throws(() => toBase("10", 1))` 的参数 `"10"` 误判为断言消息。已改为严格过滤判别字段、只扫描回调函数后的实参。
- **常量解引用与按文件隔离**：`const M = "..."; assert.throws(f, { message: M })` 旧版未解引用导致 `tested=0 undeclared=0` 假通过。跨文件同名常量（如 `TYPE_MESSAGE`）合并建表会互相覆盖，已实现单文件独立常量作用域。
- **covered = tested 原则**：不能以「文件里出现过错误字面量」判断覆盖，必须以真实断言引用为准，防止删除断言后残留字面量假通过。
- **fail-closed 判定时序**：测试侧有 throws 却提取不到有效消息时，必须在 spec 判空之前报错退出，避免动态拼接消息被误判 SKIPPED。
- **zsh 分词与 --tasks 自动解析**：zsh 中 `$T` 不自动 word-split，多个测试路径被当成单个参数传递，触发假 SKIPPED。改用 `--tasks <tasks.md> [--task <id>]`，由脚本从 `Verify with:` 与 `Write scope:` 解析路径。
- **Scenario 编号双向静态对账 (SCEN-*)**：`contract-check.mjs` 比对 spec 声明的 `#### Scenario: SCEN-*` 与测试侧引用（`phantom_scens=0 untested_scens=0`）。
- **静态对账不等于运行覆盖限制**（保留的局限）：静态检查无法证明场景真的跑过。**「把 SCEN ID 写进注释」不能当作覆盖证据**；运行报告才证明实际执行。静态对账降为引用完整性检查。

## 6. 采集与度量规范

- **执行时长采集**：使用「完成通知时间戳 − 派发时快照 `createdAt`」。不能用 `updatedAt − createdAt`——agent 归档后 `updatedAt` 会被覆盖为归档时刻。
- **数据真实性**：快照无 token 用量字段时写「未采集」，禁止用 `list_models` 目录估算；模型名一律照抄快照别名，不脑补版本号。
- **冒烟题目设计**：≥5 任务（超过 cap=3 才能观察真实背压）、≥1 条依赖链（验证依赖释放）、≥1 对共享文件（验证全量审查分支），并保留可同时运行的独立任务。
- **测调度机制不用浮点题**：冒烟题用整数运算契约。浮点误差界测的是 spec 写作能力，不是调度能力。

## 7. 2026-10-24 integer-set-partition-ops 复盘与流水线精简

- **微型算子过度施压与 Task Pod**：69 行核心实现消耗 14 个 agent、7 个 worktree、10 次集成分支提交。同域微型任务改用 Task Pod（`pod/<name>`）：单 workspace、Tester/Runner 批量接力、Auditor 单次复核合并 diff、单次合流。
- **合流记账原子化**：旧流程把 merge 与更新 `tasks.md` 拆成两步提交，靠人记执行全量测试与退出码捕获，实测多次漏跑全量测试。现由 `merge-task.mjs` 自动化：工作区干净检查 → 合流测试 → 更新 `tasks.md` → 原子提交；失败或冲突自动 abort 恢复。**（2026-10-25 补强：固定审查过的 tip、测试超时、测试前后状态指纹、先恢复再 abort。）**
- **审计分级而非豁免**：静态门禁不能替代独立审计。Pod 级合并审计批次，按风险调整深度（strict 或改共享入口用高 thinking，其余用低 thinking）。数学/算法类由 Tester 补差分对拍与小定义域穷举。
- **编排权属判据**：`agent_profile_shangshu` 承接判据为「预计派发 ≥6 次或预计 >30 分钟」；微型 Pod（通常 2–3 次派发）主会话直接编排。
- **派发参数严格机械化**：从 `list_profiles` 逐字段复制，未声明字段直接省略。派发后一次快照核对并采集时间戳。
- **分支清理与模板闭环**：禁止 `git branch -D`，允许 `git branch -d` 安全清理已合入主干的分支；`proposal.md` 必须含 `## What Changes`；归档命令统一 `--yes` 杜绝终端交互阻塞。

## 8. 2026-10-23~25 session-lifecycle-hardening 复盘：赋能优先

实测反例（保留为历史）：
- 派发手拼 MCP JSON，参数出错后曾试图抓凭据直连 API。
- 通知断链：`notifyOnFinish` 丢失或父 Agent 未唤醒；改用无状态对账。
- spec 未充分评审导致后续决策频繁漂移。
- 弱模型陷入死循环（现象记录）。**处置口径已按 SKILL §「规约演进与停滞信号」更正**：连续 ≥5 次同一断言失败或单文件 >15 分钟无推进只是**预警信号**，由 Lead 核实后处置，不自动判定死循环、不自动中断——按次数硬停会误杀有价值的长排查。
- 合流无独立审计；门禁报错被搁置。
- run-log 存在估算数据。

对应赋能工具：
- 原生 MCP `create_agent`/`send_agent_prompt`：profile 字段机械复制、title 自动 ≤60。
- `merge-task.mjs`：合流后自动追加 sha/测试命令/test_duration 到 run-log。
- `reconcile.mjs <change>`：tasks.md + git + Paseo 运行态 + 运行账本对账，输出任务分类、hold 原因与唯一 `NEXT` 动作；Lead 失联后重跑即可接力。
- `hotfix.sh`：合规小修走 qingqibing worktree → merge-task。**前置机械校验 `Review: mechanical` 且 `Risk-surface: [none]`；review 标签用真实 tip/base 生成。**
- `contract-check.mjs`：`undeclared>0` 时直接给出可粘贴的 spec 声明行。

硬底线：不抓凭据/直连 API/冒用身份；push、`rm -rf`、`--amend` 先问；两个人类确认点。

## 9. 2026-10-25 状态机演进死锁、角色越界与假活跃复盘

### 1. 规约演进与 Write Scope 机械锁死冲突（核心死锁源）
- **现象**：`tasks.md` 把 Write Scope 机械定为单一业务文件，下发时附带「不得修改单测、老单测必须 100% 通过」。
- **根因**：本次变更系底层状态机升级（`INTENT` 演进为 `SUBMITTING`），旧单测硬断言反向失败。写手陷入「改老测试算越权、不改算回归失败、不走新规算违约」的不可能三角，被迫引入 SQLite WAL 锁欺骗老单测。
- **治理**：规约演进协议（Schema Evolution Protocol）——凡涉及底层契约重构，在 tasks 编制阶段必须扫清老测试影响面，同步把需要迁移的老单测纳入 `Write scope:`。

### 2. 契约互斥中断协议（Deadlock Protocol）
- **现象**：Agent 存在单兵解题强迫症，在逻辑互斥的断言中空转尝试 30 分钟，缺少举手求助出口。
- **治理**：一旦确认新 Spec 与既有 Test 存在不可调和冲突，严禁底层 hack 绕过；最多尝试 3 次，立即抛 `kind: "blocked", reason: "BLOCKED_ON_CONFLICT"` 挂起等待 Lead/Arbiter 裁决。

### 3. Tester（测试先行）角色职责真空
- **现象**：Tester 只顾写新 Spec 的 Red 测试，对老测试反向破坏毫不知情。
- **治理**：Tester 写 Red 测试前强制执行 `Blast Radius Sweep`（`rg` 扫描变更枚举/接口在老测试中的断言），发现冲突在信封输出 `conflicting_tests` 并提早报备扩大 scope。

### 4. 心跳与对账「假活跃」（Semantic Thrashing）
- **现象**：心跳脚本只看 Agent 进程是 running 还是 idle。Agent 不断打 shell 命令空转，心跳误判为正常。
- **治理**：停滞启发式检测——连续 5 次在同一断言失败、或单文件编辑 >15 分钟无推进，标记 `THRASHING_DETECTED` 主动唤醒 Lead 审查。**限制：该信号当前不可完全自动采集**（`reconcile.mjs` 不读逐条断言/编辑轨迹），只作预警，由 Lead 核实后处置，**不自动判定死循环、不自动中断工作。**

### 5. 总控特权越界与作者血统漏洞（Provenance Hole）
- **现象**：主会话在 task workspace 亲自写代码并提交，`merge-task.mjs` 当时仅验审计标签，作者血统与写范围完全没验，制度防线失守。
- **治理**：`merge-task.mjs` 引入三因子机械门禁：
  1. 写范围封闭（越界 exit 30）；
  2. 作者血统与控制面隔离（**逐个 commit** 必须含 `Pipeline-Role: gongbu/gaogong/ceshi/jiangzuo/qingqibing` 与 `Pipeline-Author`，控制面角色 exit 31 硬阻断）；
  3. 非自审隔离（完整 UUID / 唯一可解析前缀比对，歧义 fail closed，exit 32）；
  4. **依赖门禁**（依赖未 first-parent 验收即 exit 35）与**基线锚定**（base 非集成 HEAD 祖先即 exit 34）。
- **限制（必须承认）**：提示词与 trailers 是**协作契约与自报元数据**，不是工具级身份隔离或可信来源证明。真实防线是上述机械门禁 + 独立业务验收。**不得声称提示词能物理封死总控代写。**

### 6. 审查轮次与熔断（2026-10-25 更正）
- **旧说法（已撤回）**：曾写「R2 严禁查 diff 外问题；≤5 行可补丁放行」。**行数不代表风险**，修复影响面不能禁止检查。
- **现行规则**：单任务最多 2 轮审查。R2 优先复核 R1 Blocker 是否闭环与修复影响面；**修复引入或暴露的新的正确性、安全、规范问题照常作为 Blocker 阻断**。超预算转仲裁或挂起。**熔断是「暂停并裁决」，不是降低通过条件。**

## 10. 2026-10-25 状态观测断裂（最高优先级事故，已修复）

- **现象**：`reconcile.mjs` 通过 `paseo ls --json --label ...` 取运行态，但现役 Paseo CLI `0.12.0` 的 `ls --json` 每条记录只有 8 个字段（`created, cwd, id, name, provider, shortId, status, thinking`），**没有 `labels`**；`--all`、`-o yaml`、`inspect --json` 同样没有。labels 真实存在且写入正确，在 `~/.paseo/agents/<cwd-slug>/<id>.json` 与原生 MCP `list_agents` 中。
- **后果**：`if (labels["pipeline.change"] !== change) continue;` 跳过了**全部** agent，于是 `ACTIVE`/`UNMAPPED`/`UNRESOLVED` 恒空、`liveWriterCount` 恒 0、cap 背压与 fail-closed 全部失效、`runtime: "ok"` 是假绿灯、正在运行的任务被判 READY 重复派发。
- **真实复现**（集成工作区 `integration/eas-substitute-phase3-phase4`）：`reconcile.mjs` 输出 `runtime=ok, ACTIVE=[], RUNNING=[], UNMAPPED=[], canDispatchNow=['T-05 …']`，而同期真值为 1 条 `status: running` 的 T-05 agent。**正在跑的任务被判为可派发。**
- **为何此前没发现**：`test/reconcile.test.mjs` 的测试替身 `agent()` 人为构造了 `labels` 字段，再用假 `paseo` 脚本回放该 fixture。**替身形状与真实 CLI 输出不同 —— 测试全绿但生产不可用。**
- **治理**：抽出单一状态适配器 `lib/paseo-state.mjs`（持久 JSON 为主、原生 MCP `list_agents` 为备，字段存在性断言，`runtime` 三态 `ok`/`degraded`/`unavailable`）；`reconcile.mjs` 只消费其规范化结果，业务逻辑里禁止再读 `a.labels`；非 `ok` 一律清空 `canDispatchNow`；测试替身必须源自真实录制样本。
- **方法论教训（本轮最大收获）**：**任何测试替身都必须源自真实输出，否则全绿等于没测。** 依赖断裂观测平面推出的任何指标（并发度、空等损耗、一次成功率）都是空集推导的结果，全部不可信，须修复观测平面后重新采集。

## 11. 2026-10-26 合流门禁 exit 31 排查与九项加固（实测证据）

- **git trailer 探针（6 组，`git log -1 --format='%(trailers:key=Pipeline-Author,valueonly)'`）**：
  - 正常块（与正文隔一个空行）→ 解析正常；
  - 消息**尾部空行** → 无害，解析正常（旧文档暗示有害是错的，已纠正）；
  - trailer 块后空行 + `Co-Authored-By:` → `Pipeline-Author` 解析为空（整块前面的 trailer 作废）；
  - trailer 块后空行 + 任意正文行 → 同样作废（exit 31 的真实触发形态）；
  - 块内空行 → 只有最后一段被解析，前面的 trailer 丢失。
- **治理（F1-F9，全部有回归测试锁住）**：
  1. writer 模板写入侧自验：提交后必跑 `%(trailers:key=Pipeline-Author,valueonly)` 自验非空；
  2. 中文角色词/自由格式标题的尾 token 失配不再冻死派发：任一 slug 形态中段 token（含 `-`/`.`/数字，排除标题动词）且与本 change 无前缀关系，即可证明属于另一个 change；
  3. `dispatch.mjs` 对 `paseo run` 输出末位做 agentId 形态校验（UUID 或 `agent_*`），不匹配即带原始输出 exit 2，不再静默错绑。（该脚本已于 2026-10-26 删除，见 §12；这条校验逻辑随文件一并下架。）
  4. `slugMatches` 改单向：token 比 change 长不成立归属（`foo` 与 `foo-bar` 不再互绑互占 cap）；
  5. `hotfix.sh` 接入意图账本（claim/record/fail），有有效编排租约时不带 `--owner` 必被拒；
  6. 陈旧锁删除前重读 mtime 比对，换锁即放弃删除；
  7. 证据占位检测的通用词（`LOST`/`UNKNOWN`/`TEST`/`NOT_COLLECTED`）加词边界（空白/下划线/边缘），`.` 与 `/` 不算边界（否则 `a.test.mjs`、`bash test/run-all.sh` 误伤）；
  8. `Verify with` 第三档排除英文高频动词（run/use/see/check/verify/ensure/manually）；
  9. `reconcile.mjs` 分支领先判定区分「git 失败」与「不领先」：失败按领先未知进 UNMAPPED 诊断，不静默当 0。

## 12. 2026-10-26 门禁分级：文本启发式不得与合流门禁同级（`hardening-governance-contracts` 实测）

**结论：把"对抗 LLM 文本"的启发式与"保护 git 历史"的门禁放在同一个 exit 码上，会反向激励执行者为过闸门而写 spec。** 本 change 12 任务、942 测试、一次验收通过（39/39 场景、19/19 矩阵），但两个静态闸门在验收时都是红的，且都是误报。

- **采集值**：`contract-check` → `tested=11 declared=0 undeclared=11`，对照基线 `e6298b1` 的 undeclared 集合与数量**逐字相同**（两侧各 11 条，diff 为空）；`check-evidence` → 唯一失败项是 `acceptance_command: npm --prefix packages/server test` 的行尾 `test` 被占位词判定命中。
- **误报逐条归因（插桩实测，非推测）**：11 条里 6 条来自谓词回调（`(err) => err.code === 'X'`、`hasErrorCode('X')`），1 条是桩的返回值（`message: 'ok'`），1 条是被断言的输入（`new XError('CODE', …)`）；旧提取器**没有 `.code` 通道**，所以按错误码写 spec 的仓库永远对不上。
- **收窄后的采集值**：`undeclared` 11 → 1，剩 1 条是测试故意注入的桩错误探针（`模拟推送失败`）；真实验收账本 `check-evidence --kind audit --gate acceptance --sha 7cf3471…` 由 rc=1 转 **rc=0**。
- **否决的方案：新增 CODE 通道做双向对账。** 实测 spec 侧有 27 个大写反引号 token，被测试按 `.code` 断言的只有 6 个，其余是状态值（`SAVED`/`INTENT`）、环境变量（`KINGDEE_APP_ID`/`MOCK_MODE`）和样例 ID。按"反引号即声明"对账会立刻冒出约 21 条新误报，只能再加白名单——误报换个方向而已。

**三条可复用判据**：

1. **按"拦的是什么"分级，不按"能不能写成代码"分级。** 保护 git 历史/合流正确性的（写范围、依赖 DONE、固定 tip、非自审、写锁）→ 阻断（exit≠0）。判断文本语义的（消息抽取、占位词、方言）→ 提示，交 Auditor 判。误报不再卡流程，执行者也就没有动机去适配脚本。
2. **一进一出。** 每加一条门禁，同时删或降一条，并在本文件写明它对应的事故。没有事故证据的规则不加——`Verify with` 引用被 `.gitignore` 的文件（T-09）只发生过 1 次，所以只写进 SKILL 撰写规则，没上脚本。
3. **方言不匹配要报"不适用"，不报失败。** 仓库用错误码 + 场景编号承载契约时，消息通道两侧本就不在同一坐标系；fail-closed 只会逼人编字面量。

**两处零使用残留物同轮删除**（`wc -l` 与账本采集，非估计）：

- `dispatch.mjs`（117 行）+ `test/dispatch.test.mjs`（434 行）：SKILL 自述"不参与正常流水线"。**注意：该测试文件同时承载 `hotfix.sh` 的 12 条用例**，直接删会连带丢失 hotfix 保护——已拆出 `test/hotfix.test.mjs`（17 条，全绿）后再删。
- `run-state.mjs heartbeat` 子命令 + `lib/run-state.mjs` 的 `heartbeatStatus`：`hardening-governance-contracts` 账本 `heartbeats` 为 **0**。`heartbeats` 字段保留为只读兼容（旧文件仍可读、`status` 仍打印），但不留写入路径。
