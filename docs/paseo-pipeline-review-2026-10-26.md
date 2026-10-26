# paseo-pipeline 复核与优化方案 v2（基于本地最新实现）

- 日期：2026-10-26
- 输入：R1《paseo-pipeline-review-2026-10-25.md》（基线公开提交 `ae0ca49`）
- 本次基线：本地工作区 = HEAD `ae0ca49` + 未提交改动（`git status --porcelain` 23 行；`git diff --stat` 15 文件 +2561/−458；未跟踪文件含 `lib/paseo-state.mjs`、`lib/roles.mjs`、`lib/run-state.mjs`、`lib/ledger.mjs`、`lib/lock.mjs`、`run-state.mjs`）
- 本机：`paseo 0.12.0`；`paseo ls --json --all` 1604 行，字段 `id,shortId,name,provider,thinking,status,cwd,created`（无 labels）
- 回归实测（2026-10-26 本轮收口，在仓库根目录执行 `bash skills/paseo-pipeline/test/run-all.sh`）：Node `tests 405 / pass 405 / fail 0`，`duration_ms 112832.790959`；contract-check（`bash skills/paseo-pipeline/test/contract-check.test.sh`）`通过 19 / 失败 0`。R1 的 244、本文初版的 349、上一轮的 378/390/391/392/397 都是历史计数。
- 原生 Paseo 冒烟（包 0）：**已执行**，5 任务全流程一次跑通，采集值与覆盖缺口见 §8。真实业务试点**未执行**。
- 行号对应 2026-10-26 00:21 的工作区（`reconcile.mjs` 在走查期间仍被改动过一次，结论已按最新文件重核）。

---

## 0. 本轮实施状态（按包）

| 包 | 状态 | 说明 |
|---|---|---|
| A 观测与对账 | **已实施** | `lib/paseo-state.mjs` 单一适配器 + runtime 三态；活态改为「任一源报 live 即 live」；attempt 数值绑定；`rejected` 分支不再进 MERGE；解析级 INVALID 写手与同仓外部写手均计入 cap（SCEN-REC-17 ×2） |
| B 合流门禁 | **已实施** | 冻结 `Verify with` 强制先跑（exit 36）；`-z --no-renames`；单写者锁（exit 37）；Pod 冻结成员校验；legacy 豁免需环境变量二次确认并记 run-log；测试内 commit 检测（exit 40）；进程组 kill；已合流重试的分项诊断（SCEN-MRG-25/26/27）；base 须同时是集成 HEAD 与 tip 的祖先（exit 34）；审查员与运行账本派发记录交叉核对（exit 32，复刻 T-02 自审） |
| C 契约收敛 | **部分实施** | 角色/phase 单点定义（`lib/roles.mjs`）；`Review` 三档语义写入 SKILL；run-state 读改写加锁 + 候选校验入锁；证据闸门的场景 PASS、占位值与 smoke `--sha` 已补（SCEN-EVD-01/02）；§3-P1-11 的 SKILL/LESSONS 内部矛盾已逐条消除（心跳、Lead 阈值、hotfix 定位、OpenSpec 交回、审查轮数、停滞信号均已复核一致）；派发 brief 四份模板已落地并锁定必填字段（SCEN-DOC-13..16）；非 `T-` 前缀任务 ID 的 dispatch 标识已修（SCEN-REC-20）。**仅剩** `~/.paseo/task-routing.md` 与 shangshu notes 中的活态表述未改（需另行授权） |
| D 试点 | **未执行** | 无真实业务验收，不得宣布产品验收成功 |
| 0 唤醒冒烟 | **已执行（判断：通过）** | 5 任务串行全流程一次跑通，0 失败、0 人工催促；顺带查出「账本缺失导致因子 3b 静默消失」并已修。采集值与覆盖缺口见 §8 |

**下文 §2/§3 的行号与结论保留为当时的复核记录；已闭合项在 §2 表格中标为「已修复」，未闭合项在 §3 末尾的「仍未闭合」清单集中列出。**

---

## 1. 结论先行

1. **最大损耗是唤醒链断裂，不是脚本正确性。** 归档 change `2026-10-25-pipeline-native-closure` 的原生冒烟 `result: FAIL`：Lead `62ce24cf` 派出的 T-02 a5（`dfa79d7b`）于 05:54:33Z 派发、06:13:24Z 才有通知，同类停摆复发于 `52479f24`、`e73389e6`。9 个任务从首次合流 04:43:47Z 到末次 06:41:44Z，T-02 共 5 次 attempt、2 次人工预算例外。
2. **门禁可被调用者放宽。** 冻结的 `Verify with` 从不被 merge-task 读取，调用方传 `true` 即可；`--allow-legacy-author` 任何人可加；run-state 不带 `--owner` 即跳过租约校验。历史上已发生一次自审被放行（T-02，见 §3-P0-3）。
3. **规则多源、互相矛盾。** 心跳、Lead 阈值、hotfix 定位、审查轮数、角色归类各有 2–3 套说法，执行 agent 无法同时遵守。
4. **修法克制：** 用 Paseo 已有的 `paseo wait` 把唤醒从“等通知”改为“主动等待”；调用者参数只能收紧不能放宽；规则收敛到一处。不新增层级，不做调度平台。

---

## 2. R1 逐条复核

| R1 结论 | 本地状态 | 证据 |
|---|---|---|
| 依赖未满足仍可合流 | **已修复** | `merge-task.mjs` 依赖门禁 `verifyDone`（L184），exit 35 |
| contract-check T-1/T-10 前缀串扰 | **已修复** | `contract-check.mjs` 精确匹配（L79） |
| hotfix review 标签写死 | **已修复** | `hotfix.sh:93` `pass(mechanical@${TIP7}/${BASE7})` |
| 空提交 no-op 可合流 | **部分** | 默认路径 exit 31；`--allow-legacy-author` 现需 `PIPELINE_ALLOW_LEGACY_AUTHOR=1` 二次确认并写入 run-log（`author-provenance=BYPASSED(legacy)`），但仍是可用的放宽口（见 §3 仍未闭合） |
| 同阶段多记录顺序依赖 | **已修复** | 确定性排序 attempt→phase→id |
| CLI 缺 labels | **已改路线** | 主源改为持久 JSON `~/.paseo/agents/*/*.json`，CLI 只交叉校验（`lib/paseo-state.mjs`） |
| 意图跨 change 误配 | **已修复** | 限定在本 change members 内 |
| INVALID 任务不占 cap | **已修复** | 解析级 INVALID（含 `MISSING_SCOPE`）上的活体写手现在计入 cap 与持有 scope（SCEN-REC-17） |
| 权限暂停被新记录遮蔽 | **已修复** | 改为「任一成员有待批权限即 UNRESOLVED」，不再只看 latest |
| 测试污染工作区 | **已修复** | 前后 `git status --porcelain=v1 --untracked-files=all` 指纹比对拦改写；测试内 `git commit` 使 `MERGE_HEAD` 消失且 HEAD 已变时 exit 40 并打印现场、不 reset（SCEN-MRG-25） |
| Pod 成员不可验证 | **已修复** | `merge-task.mjs` 现读 `pod-members.json`，taskIds 必须等于冻结成员集（多报/少报/缺文件均 exit 31），SCEN-MRG-24 双向覆盖 |
| `lastStatus` 不能当活态 | **已修复** | 改为「任一源报 live 即 live」：CLI 报 `running` 而持久文件已 `closed` 时按 live 保守占位（SCEN-PS-LIVE-CLI 负向对照已验） |
| 冻结 Verify 可替换 | **已修复** | 冻结命令先逐条执行，位置参数只追加；不可解析 exit 36 |
| attempt 分支误选 | **已修复** | 分支按数值绑定 latest attempt；旧 attempt 进 `staleBranches`，不再进 MERGE；`-a10` / `-a2` 有专门用例 |
| rejected 但分支领先直接 MERGE | **已修复（语义变更）** | 旧断言被替换：旧 attempt 的领先分支报 `STALE_BRANCH`，任务按预算处置（耗尽则 BLOCKED） |
| 并发合流无锁 | **已修复** | `lib/lock.mjs`（`O_CREAT\|O_EXCL`，落在 git common dir），持锁后重读 HEAD，占用时 exit 37 |
| 改名旧路径漏检 | **已修复** | `git diff --name-only -z --no-renames`；中文路径与改名各有回归 + 负向对照 |
| review base 未校验为 tip 祖先 | **已修复（本次补齐）** | `merge-task.mjs` 增 `merge-base --is-ancestor <base> <tip>`，exit 34；负向对照撤掉即 `SCEN-MRG-18` 红 |
| R1“本机无 CLI” | **不适用** | 本机 `paseo 0.12.0` 可用，含 `wait/inspect/permit ls` |

---

## 3. R1 未覆盖的新发现

### P0：会导致重复派发、错误合流或假通过

> 本节保留走查当时的事实描述。已闭合项在条目末尾标注状态，未闭合项汇总在 §3「仍未闭合」。

1. **权限源 fail-open。** `paseo permit ls` 失败只写证据（`paseo-state.mjs:165`），runtime 仍可为 `ok`，所有 agent 的 `pendingPermission` 视为 false，暂停中的 agent 可能被当成可推进。
2. **`archivedAt` 读取但不参与判定**（`paseo-state.mjs:197`）；归档但 `lastStatus` 仍为 running 的记录会占 cap 或被视为 ACTIVE。
3. **自审已发生且被放行。** `archive/.../tasks.md:17` 为 `review=pass(dfa79d7b@fe4240f/fe0a598)`，`native-smoke.md:23` 记录 `dfa79d7b` 就是 T-02 a5 的写手。提交 `fe4240f` 只有 Co-Authored-By，无 `Pipeline-Author`/`Pipeline-Role`；合流提交 `528c691` 只有 `Pipeline-Task/Source`。根因：作者 trailer 可缺失，reviewer 身份不与派发记录交叉核对。**已闭合（本轮）**：`merge-task.mjs` 在运行账本存在时交叉核对 reviewer 与本任务的写手/审计意图，exit 32；SCEN-MRG-16 三条（写手本人、无审计派发、审计派发匹配）覆盖，撤掉检查后两条变红。
4. **run-state 租约可绕过。** `requireActiveOwner` 仅在 `owner !== null` 时比对（`run-state.mjs:58`），而 SKILL 的 claim 示例本身不带 `--owner`；读改写只有 tmp+rename，无锁，并发 claim 可双双成功。
5. **证据闸门仍偏弱。** acceptance 闸门不跑结构检查（`check-evidence.mjs:170-176`，仅 `all` 才两者都跑）；smoke 的 sha 绑定可选（L144）；场景检查是不区分大小写的子串匹配（L150，`SCEN-1` 命中 `SCEN-10`），且只要求“被提到”，不要求该场景通过。归档 change 的 T-08 冒烟 FAIL 仍以 Done 合流，正是因为当时走的 structure 闸门。**已闭合**：结构前置、smoke 与 audit 均须 `--sha`、token 边界匹配且要求 `<ID>: PASS`、非 PASS 结论阻断，四条各有负向对照。
6. **占位证据值。** `native-smoke.md` 的 `notification_message_id: msg_01JAX_LOST_NOTIFICATION` 不是采集值，违反“只写采集值”。

### P1：推进摩擦、协同断裂

7. **`nextAction` 单一 kind、严格优先级**（`reconcile.mjs:506-559`）。任一 INVALID/UNRESOLVED/预算耗尽都会输出 `arbitrate`，与之无关的任务的 merge/dispatch 也被压住；有 MERGE 时不同时给 dispatch，每次唤醒只推进一类动作。另外 `canDispatchNow` 不看 INVALID/UNRESOLVED，可能与 `nextAction` 结论不一致。
8. **意图生命周期不闭合。** `fail` 后同一键无法再 claim（与 SKILL:150 “fail 后可重派”矛盾）；`record` 会清 `failedAt` 让已作废意图复活；不带 `--agent` 也能关闭意图；非超期的 INTENT_PENDING 若未命中 L554 分支会落到兜底“状态无法解释”。`run` 字段无代码写入，恒为 `local`。
9. **`claimsMerged` 报错指向 `terminal[0]`**（L407），不是 latest。
10. **角色多源。** `dispatch.mjs:25-29` 自带角色表，`yushi`/`mige` 归类与 `lib/roles.mjs` 冲突；已删除 profile `qingqibing` 仍在 `roles.mjs` 与 `dispatch.mjs` 中；`Review: standard` 出现在 SKILL 但未定义；任务 ID 两套规则：`lib/tasks.mjs` 接受 `[A-Za-z]+-\d+`，`reconcile.mjs:95` 只认 `T-\d+`。**部分闭合（2026-10-26）**：`reconcile.mjs` 的解析入口早已改用 `isTaskId`，只剩 `nextAction` 组装 dispatch 动作时仍用 `/\bT-\d+\b/` 从 label 里抠 ID——`TASK-01` 这类合法 ID 抠不出来，整条 `"TASK-01 Task TASK-01"` 会被当成任务标识塞进 `pipeline.task` 标签。已改为回查 `READY` 取 `id`，`SCEN-REC-20` 覆盖（撤掉修复即红）。`yushi`/`mige` 的「冲突」经复核**不成立**：两处都归控制面/只读，是同一结论的两种写法；`dispatch.mjs` 的 `ALIAS` 表是历史角色名到现行 profile 的映射，不是第二套分类。
11. **规则冲突。**
    - 心跳：`openspec/specs/pipeline-delivery/spec.md:153` “Ordinary runs SHALL create no recurring heartbeat or schedule” 对比 `SKILL.md:164` 要求 Lead 开工 `create_heartbeat`（3 分钟），shangshu profile notes 与 `~/.paseo/task-routing.md` 同样要求。
    - Lead 阈值：CLAUDE.md 与 `SKILL.md:34` 写“预计派发 ≥6 或 >30 分钟”，task-routing 与 shangshu notes 写“任务数 ≥4”。
    - hotfix：`SKILL.md:51` 定为 Legacy 兜底，`SKILL.md:53` 又作推荐小修入口。
    - OpenSpec：L11 禁止 Lead 跑 `openspec`，L62 恢复流程要用 `openspec status`。
    - 交回：要求 Lead 用 `send_agent_prompt` 向主会话交回，但主会话（Claude Code）不是 Paseo agent，收不到；`SKILL.md:178-180` 的孙→Lead→父接力在冒烟中实测 FAIL。
    - 审查轮数：task-routing“中型 1 轮、大型 ≤2 轮、微型免审”，SKILL 写 Pod 需审一次，另有“打回 2 次 + 升级 1 次”。
    - LESSONS 与 SKILL：LESSONS:74“Read ≥5 次就停”对比 SKILL:114“不自动中断”；LESSONS:29/30 合流与派发顺序自相矛盾。
12. **无派发 brief 模板与 Auditor 输出契约。** 没有 Writer/Tester/Auditor/Lead 模板；Auditor 的 verdict 集合、`reviewed_sha`、review-tag 由谁拼接均未定义。下游无法机械消费上游产出，是“协同断裂”的直接来源。
13. **message-id 去重只有文字没有实现**（spec.md:153 要求，代码无对应逻辑）。

### P2：边角

14. 中文路径：`git diff --name-only` 默认对非 ASCII 加引号，scope 判定误报越界，需 `-z`。
15. `hotfix.sh:71-74` profile 查不到时以空 `--provider` 继续派发；`--short=7` 遇歧义输出更长 SHA，与 7 位 tag 正则不符。
16. 测试超时 SIGTERM 只杀 shell，孙进程可能继续写工作区。
17. 嵌套 pod 分支被静默忽略；FOREIGN 写手不计 cap。
18. 过度承诺措辞：SKILL“双轨自愈 / 瞬时响应”，task-routing“毫秒级唤醒、至多 3 分钟消除永久停摆”，CLAUDE.md“毫秒级”——均无实测。

### 仍未闭合（截至 2026-10-26 本轮实施后）

以下各项经本轮复核仍成立，**没有**在本次改动中处理，也不得在报告中记为已修复：

1. `--allow-legacy-author` 仍能整体关闭作者血统门禁。已加两道约束（`PIPELINE_ALLOW_LEGACY_AUTHOR=1` 二次确认 + run-log 记 `BYPASSED(legacy)`），未移除该路径。
2. 通知去重（spec 要求的 message-id 复合键）只有文字描述，无实现。
3. `Review: required` / `Review: default` 在历史 `tasks.md` 里真实出现过（11 + 1 处，均在 archive），现被 `UNKNOWN_REVIEW` 拒绝；SKILL 已注明需迁移，但未提供迁移脚本。
4. ~~`paseo wait` 主动等待方案（§4.1）未验证~~ → **原语层与单 change 串行全流程均已验证**（见 §4.1 实测表与 §8）：阻塞语义、子 agent 完成后唤醒、退出码恒 0、5 任务一次成功率 5/5 均已采集。**仍未采集**：并行 DAG（cap>1）下的唤醒、单次 wait 540s 上限被真正触及时的行为、Lead 长回合的上下文增长。
5. 真实业务验收、原生多 Agent 冒烟、一次成功率与耗时采集全部**未执行**。

**本轮新闭合（原 2/3/4/5/7 项，均带负向对照）**

| 原项 | 修复 | 负向对照 |
|---|---|---|
| 2 `abortMerge` 在测试内 commit 时静默返回 | 记住 `expectedPreMergeHead`，`MERGE_HEAD` 消失且 HEAD 已变即 exit 40 并打印现场，不 reset | 撤掉检测 → `SCEN-MRG-25` 红 |
| 3 超时只杀外层 shell | `spawn` + `detached:true`，`process.kill(-pid)` 打整棵进程树，SIGTERM→2s→SIGKILL，并轮询进程组消失 | 去掉 `detached` → `SCEN-MRG-26` 红（孙进程 3 秒后落盘） |
| 4 hotfix 空 provider / 7 位标签 | profile 解析 fail-closed（缺文件/缺 profile/缺 provider-model 一律 exit 1）；标签用完整 SHA 截前 7 位 | 恢复旧写法 → `SCEN-DISP-05/06` 3 条红 |
| 5 外部写手不计 cap | `foreignLiveWriters` 计入 `room`；解析级 INVALID（`MISSING_SCOPE`）上正跑的写手也占 cap 与 scope；`nextAction` 与门禁同口径 | `SCEN-REC-17` ×2 红 |
| 7 场景只要出现、占位值放行 | 要求 `scenario_results` 段 `<ID>: PASS` + 不得同时在 unverified；占位/退化值判为未采集 | `SCEN-EVD-02` ×3 分别红 |
| 6 嵌套 Pod 分支静默忽略 | `for-each-ref refs/heads/pod/<change>` 是路径段前置匹配，`pod/<change>/<x>` 也会被列出；判据改成「映射不到任何任务即 UNMAPPED」，不再只认第三段为 `undefined` | `SCEN-REC-17 nested pod branch` 红 |
| 8 LESSONS:29/30 派发与合流顺序自相矛盾 | 改为「先派发」只适用于**不依赖本任务 Done** 的下游；依赖本任务合流的下游必须先合流再派，合流被推到「等待空档」不是规则 | 文档条款，`SCEN-DOC-*` 无对应断言；以人工核对为准（未做负向对照，如实记录） |

**2026-10-26 P0 收口（本轮）**

| 原项 | 修复 | 负向对照 |
|---|---|---|
| §3-P0-3 自审（T-02） | `merge-task.mjs` 新增因子 3b：运行账本存在时，reviewer 不得是本任务任一写手意图的 agentId，且必须是本任务一条已回执 `anchasi` 意图的 agentId；账本不可解析 exit 32 | 撤掉 3b 整段 → `SCEN-MRG-16` 两条红（写手本人、无审计派发） |
| §3-P0-5 smoke 无 sha 绑定 | `acceptanceErrors()` 把 `--sha` 要求移出 audit 分支，smoke 同样强制 | 撤掉该要求 → `SCEN-EVD-01 revision binding for smoke` 红 |
| `base7` 未校验为 tip 祖先 | `merge-task.mjs` 增加 `merge-base --is-ancestor <base> <tip>`，exit 34 | 把该检查替换为恒通过 → `SCEN-MRG-18` 红 |
| 必需场景非 PASS 结论 | 已有实现，本轮补锁定用例：`BLOCKED`/`SKIPPED`/`UNVERIFIED` 三种结论逐项拒绝 | 撤掉非 PASS 拒绝 → `SCEN-EVD-02 BLOCKED or SKIPPED` 与 `merely mentioned` 两条红 |

回归实测（本轮改动后，仓库根目录 `bash skills/paseo-pipeline/test/run-all.sh`）：Node `tests 397 / pass 397 / fail 0`，`duration_ms 109471.265083`；contract-check `通过 19 / 失败 0`。

---

## 4. 优化方案（克制版）

### 4.1 唤醒链：从“等通知”改为“主动等待”（收益最大，先冒烟）

#### 原语层实测（2026-10-26 本轮采集）

`paseo wait` 的三条行为已用真实 agent 采到，不再是假设：

| 观察项 | 采集值 | 来源 |
|---|---|---|
| 阻塞语义可用 | 对 running agent `--timeout 8` 实耗 `elapsed=8.41s` 后返回 `status: timeout` | `paseo wait dd078ab4 --timeout 8 --json` |
| 子 agent 完成后唤醒 | 探针 `5c6992f5` 跑 `sleep_done_ms=45000`（`04:33:37Z`→`04:34:22Z`）；Lead `57fccc23` 前台 wait 于 `04:33:45.3NZ` 起等到 `04:34:26.3NZ` 返回，`status: idle`，`EXIT=0` | 两个 agent 的自报信封 |
| 空闲 agent 立即返回 | `elapsed=0.61s`，`status: idle` | `paseo wait 74558a2 --timeout 20 --json` |

**关键缺陷：`paseo wait` 的退出码恒为 0。** `idle`、`timeout`、`error`（如 `Agent not found`）三种终局全部 `rc=0`（分别为 `rc=0` / `rc=0` / `rc=0`）。任何 `paseo wait ... && 继续推进` 的写法都会把「超时没等到」当成「子 agent 完成了」。调用方必须解析 `--json` 的 `status` 字段。

- **Lead**：派发后不结束回合，前台循环 `paseo wait <id> --timeout 540`；返回即跑 `reconcile.mjs` 并执行动作，超时则轻量对账后继续等。回合不 idle，就不依赖 `notifyOnFinish` 唤醒 idle 父级。
  - **注意：`paseo wait` 一次只接受一个 id。** `paseo wait --help` 为 `Usage: paseo wait [options] <id>` / `Arguments: id  Agent ID (or prefix)`，不是可变参数。并行 DAG 下同时有多个子 agent 在跑时，只能（a）串行逐个 wait——先等的那个 idle 返回后其余仍在跑，会造成空转窗口；或（b）`run_in_background` 并发起多个 `paseo wait`，以先返回者为准。两种策略尚未实测，见 §8.5。
- **主会话**（Claude Code，非 Paseo agent）：对 Lead 用后台 `paseo wait <lead-id>`（Bash `run_in_background` 或 Monitor），由 harness 通知；Lead 最终信封通过 `paseo logs` / `get_agent_activity` 读取。
- 删除孙→Lead→父的 `send_agent_prompt` 接力要求与未实现的 message-id 去重。
- Heartbeat 降为可选兜底（仅 Lead 回合意外结束时），与 spec.md:153 统一；`run-state heartbeat` 只保留 register/delete 记账。
- 风险：`paseo wait` 长时间阻塞对 Lead 上下文与超时的影响**未采集**；包 0 冒烟不过则回退现状并如实记录。

**包 0 冒烟结果（2026-10-26，见 §8）：串行路径通过。** 5 任务 5 次派发 5 次合流、0 失败、0 人工催促，5 次 wait 全部 `status: idle`（40–82s，未触及 540s 上限）。§4.1 在串行 DAG 上从假设变为已验证；并行 DAG 与超时分支仍未采集。

### 4.2 reconcile：一次唤醒推进所有可做动作

- `nextAction` 改为有序动作列表：阻塞按任务局部生效，影响面外的 merge 与 dispatch 同轮给出（合流在前，不互斥）。全局 hold 只保留 runtime 非 ok 与 UNMAPPED。**已实施**（SKILL §2.0 与 `ALSO` 输出已同步）。
- 活态：labels 取持久 JSON，状态取 CLI `status`；两者不一致按 live 保守计；`permit ls` 失败 → `degraded`；`archivedAt` 非空且 CLI 无此 id → 非 live。**已实施**（「任一源报 live 即 live」，SCEN-PS-LIVE-CLI 覆盖）。
- 所有解析级 INVALID 的 live 写手计入 cap；scope 未知时视为全局占用。**已实施**（`invalidByParse` 与 `BAD_SCOPE_PATH` 两条路径均累加 `liveWriterCount` 并保守占位，SCEN-REC-17 覆盖）。
- 任一成员有待批权限 → UNRESOLVED（不只看 latest）。**已实施**。
- 分支精确绑定 latest attempt（`-a<N>` 数值匹配）；旧 attempt 分支报 STALE，不进 MERGE。**已实施**（`staleBranches` + `STALE_BRANCH` 输出行）。
- rejected/abandoned 的 latest 进 REWORK（回 READY，受预算约束），不进 MERGE；同步修改 SCEN-REC-16 断言。**已实施（取「不进 MERGE」这一半）**：旧 attempt 的领先分支报 STALE 并按预算处置；未新增独立 REWORK 状态，复用的是既有 READY/BLOCKED 路径。
- 任务 ID 规则改用 `lib/tasks.mjs` 的同一正则。**已实施**。

### 4.3 merge-task：调用者只能收紧，不能放宽

- 必跑冻结 `Verify with`；位置参数 `<test-cmd>` 只作追加。任务无 `Verify with` 时才允许单独传入，并写入 run-log。**已实施（exit 36）。**
- `git diff --name-only -z --no-renames base..tip`，同时校验 base 是集成 HEAD 的祖先**且**是被合入 tip 的祖先（两者任一不满足 exit 34）。**已实施**：前者原已有，后者本轮补齐（只查集成 HEAD 会放过「分支拉出后集成又前进、再拿新 HEAD 当 base」的标签，此时 `base..tip` 会把本任务没写过的提交算进审查范围）。
- 测试前后比较 porcelain 指纹。**已实施。** 原计划的 `git write-tree` 未加（porcelain 已覆盖工作树与未跟踪文件）。
- 集成写锁：git common dir 下 `O_EXCL` 锁文件，持锁后重读 HEAD。**已实施（exit 37）。**
- 非自审：`Pipeline-Author` 必填；`--allow-legacy-author` 需显式环境变量并写入 run-log。**已实施（二次确认 + `BYPASSED(legacy)` 记录）。** reviewer 与 run-state 派发记录交叉核对：**本轮已实施**——账本存在时，`reviewer` 不得等于本任务任一写手意图的 `agentId`，且必须是本任务一条已回执 `anchasi` 意图的 `agentId`；账本不可解析同样 exit 32。账本不存在时保持原 trailer 检查（该 change 未走流水线记账）。
- Pod：读 `pod-members.json`，taskIds 必须等于成员集合。**已实施（exit 31）。**
- 幂等：**本条建议已裁决为不采纳。** `openspec/specs/pipeline-delivery/spec.md:140` 的 SCEN-MRG-08 明文规定「已 Done → exit 非零且不产生新提交」，改 exit 0 属于门禁语义变更，需 OpenSpec delta 与确认点 1；规范优先于走查建议。**实际实施的是诊断精度**：同一 tip 的重试报 `task T is already merged from <tip7> ... retry after a lost merge receipt`，换了 tip 的旧成果仍报 `different revision cannot be merged under the same task`，两者都不产生提交、不改账本（SCEN-MRG-27 × 2 覆盖，负向对照：抹掉 source 比较后该用例变红）。
- 超时用进程组 kill。**已实施**：`spawn(..., {detached:true})` + `process.kill(-pid)`，SIGTERM 后 2s SIGKILL，并轮询进程组消失（SCEN-MRG-26 用 3 秒后落盘的孙进程验证；负向对照去掉 `detached` 即变红）。

### 4.4 run-state

- 存在租约时 `--owner` 必填；读改写与 merge-task 共用 `O_EXCL` 锁。**已实施**（`lib/lock.mjs`，锁内校验，`ELOCKED` → exit 2；SCEN-RS-LOCK×2 覆盖并发 claim 与陈旧锁回收）。
- `fail` 后允许同键重新 claim（记 `retryOf`）；`record` 必须带 `--agent`，且不得复活已 fail 意图。**已实施**。
- 不做自动接管、代际扩展等新机制。

### 4.5 单一来源与契约

- 角色：`dispatch.mjs`、`hotfix.sh` 改用 `lib/roles.mjs`；删除 `qingqibing`；`Review` 只留 `strict|mechanical`（或正式定义 `standard`），二选一。**部分实施**：`lib/roles.mjs` 已是单点定义；`Review` 选定「正式定义 `standard`」（见 SKILL §2.1 三档语义），`required`/`default` 判为未知；`dispatch.mjs`/`hotfix.sh` 的引用未改，`qingqibing` 仍在 `WRITER_ROLES`（真实历史数据里出现过 1 条，删除会让既有记录被判 UNMAPPED）。
- Lead 阈值：只在 CLAUDE.md 定义一次（建议沿用“预计派发 ≥6 或 >30 分钟”），SKILL、task-routing、shangshu notes 只引用。
- 心跳：**已按「撤销 SKILL 中的强制要求」收敛**（不需要改 spec）。SKILL 现在写明常规运行不创建周期性 heartbeat/schedule、无外部计时器源时对账只在下次真实调用发生；`run-state.mjs heartbeat` 降为「确证来源才登记」，并给出停摆处置 `BLOCKED_ON_WAKE`。`~/.paseo/task-routing.md` 与 shangshu notes 中的强制表述**未改**（属活态配置，需另行授权）。
- hotfix：**已收敛为两种明确用途**——`hotfix.sh` 是 L1 小修正式入口（自带 `paseo wait`，不依赖未验证回调），`dispatch.mjs` 是纯调试用的 Legacy 兜底；两者共用同一套合流门禁，不再有互相矛盾的两句话。
- OpenSpec：**已按「主会话独占、Lead 只读产物」收敛**——`openspec status` 由主会话执行后把结论交给 Lead，Lead 只读 `openspec/changes/<name>/` 下的文件，需要时走交回点。
- 新增 `templates/`，4 份 brief：writer / tester / auditor / lead。固定字段：目标与不变式、base SHA、Write scope、Verify 命令、必填 trailers、信封格式（≤20 行，`kind=phase-complete|blocked`，含 `conflicting_tests`、`BLOCKED_ON_CONFLICT`）。Auditor 输出 `verdict ∈ {PASS, PASS_WITH_NITS, BLOCK}` + `reviewed_sha` + blocker ID 列表；review-tag 由 Lead 机械拼接，不由 Auditor 手写。**已实施**（2026-10-26）：`skills/paseo-pipeline/templates/{writer,tester,auditor,lead}.md` 共 255 行。原计划的「每份 ≤30 行」**未实现也不打算实现**——四份实测分别为 49/50/57/99 行，冒烟里跑通的 Lead brief 本身是 100 行；砍行数就要砍字段，而缺字段正是冒烟暴露的头号摩擦点。以字段完备为准，行数不是判据。
- SKILL 与 LESSONS 去重：LESSONS 只留事故与教训，规则只在 SKILL 出现一次；删除 §3-P2-18 所列过度承诺。

### 4.6 分流（降低流程税）

| 档 | 判据 | 编排 | 审查 |
|---|---|---|---|
| L0 直做 | 单文件、问答 | 主会话 | 无 |
| L1 单写手 | 1 任务、有可靠验证命令 | 主会话 + merge-task（hotfix） | mechanical 或 1 次 Auditor |
| L2 小 DAG | 2–5 任务 | 主会话前台 `paseo wait` 编排 | 按风险面 |
| L3 无人值守 | 预计派发 ≥6 或 >30 分钟 | Lead + `paseo wait` | 按风险面，≤2 轮后仲裁 |

DAG 与 cap：滚动释放（依赖满足且 scope 不冲突即派），Wave 只作展示；cap 统计写手与 Tester，Auditor 另设轻量上限（如 2）；Tester 只在 `strict` 任务派；首批任务优先打通最小业务链，尽早暴露集成问题。

### 4.7 证据闸门

acceptance 先跑 structure；smoke 与 audit 都必须 `--sha`；场景按 token 边界精确匹配，并要求该场景结果为 PASS；占位值（如 `msg_01JAX_…`）判为未采集。

**状态：** 五项**已全部实施**。acceptance 先跑 structure；**smoke 与 audit 都必须 `--sha`**（本轮补齐：此前只有 audit 强制，冒烟证据可完全脱离 revision 通过验收）；场景按 token 边界匹配；必需场景必须在 `scenario_results` 段有 `<ID>: PASS`（只在正文被提到、结论非 PASS、或同时挂在 unverified 都拒绝）；占位值（`PLACEHOLDER`/`LOST`/`NOT_COLLECTED`、全同字符退化值）与字段缺失同等对待。负向对照逐项撤掉修复均变红：撤 structure 前置、撤 smoke `--sha`、撤非 PASS 结论拒绝，三条分别使对应用例变红。

---

## 5. 实施分包

每个包 = 代码 + SKILL/模板 + 测试同步，负向用例先红后绿。

| 包 | 内容 | 出口判据 | 状态 |
|---|---|---|---|
| 0 唤醒冒烟（先做） | 5 任务、4 条依赖边、1 对共享文件（`src/catalog.mjs`，整数运算契约）；Lead 前台 `paseo wait`，主会话后台 wait Lead | 无人工催促完成派发→合流→最终信封；各段真实耗时入证据；失败记 FAIL，保留现状 | **已执行**，判据全满足，采集值见 §8 |
| A 观测与对账 | §4.2 + 角色单源 | 新增用例：permit 失败降级、archivedAt、MISSING_SCOPE 占 cap、旧 attempt 权限、`-a10`/`-a2`、rejected 不进 MERGE、局部阻塞不压独立任务 | **已实施**（`MISSING_SCOPE` 占 cap 与「同仓外部写手计 cap」本次补齐，SCEN-REC-17 ×2） |
| B 合流门禁 | §4.3 + §4.7 | 新增用例：Verify 替换、改名越界、中文路径、改写 staged、测试内 commit、并发 merge、legacy no-op、自审复刻 T-02、重复合流幂等 | **已实施**；「重复合流幂等」按 spec 裁决落为**诊断精度**（仍 exit 非零），见 §4.3 |
| C 契约收敛 | §4.4 + §4.5 | run-state 并发与 owner 用例；docs.test 检查规则只在一处定义；SKILL 内部矛盾清单（§3-P1-11）逐条消除 | **部分**：run-state 并发与 owner 已覆盖；SKILL 矛盾清单已逐条消除并复核；brief 模板已落地（SCEN-DOC-13..16）；仍缺「规则只在一处定义」的自动化断言（docs.test 目前只锁模板字段与既有条款，没有跨文件重复性检查），以及 `~/.paseo/task-routing.md`/shangshu notes 的活态表述（需授权） |
| D 试点 | 1 个日常小修（L1）+ 1 个跨模块任务（L2/L3） | 如实记录首次业务验收结果、人工救援次数、READY 等待时长与原因 | **未执行** |

前置：当前未提交改动需由用户确认是否作为基线提交（未经确认不提交、不推送）。建议用一个 OpenSpec change（如 `pipeline-hardening-v2`）承载 A–C，任务数 ≤8，主会话按 L2 编排。

---

## 6. 度量

首次业务验收通过率、人工救援次数、READY 等待原因与时长、返工分类（spec 不清 / 实现错误 / 集成冲突 / 环境）、每 change 派发次数。`createdAt → 通知` 与执行时长分列统计。采集不到写“未采集”。

---

## 7. 需要用户决定

1. 心跳：撤销 SKILL/notes 强制要求（推荐），还是修订 spec 允许心跳。
2. Lead 阈值口径：“预计派发 ≥6 或 >30 分钟”（推荐）还是“任务数 ≥4”。
3. hotfix 定位：L1 正式入口（推荐）还是 Legacy。
4. 当前未提交改动是否先作为基线提交。
5. 是否授权按 §5 从包 0 开始实施。

---

## 8. 包 0 唤醒冒烟：执行记录（2026-10-26）

冒烟目的不是交付功能，是验证 §4.1「Lead 前台阻塞 `paseo wait`」这条唤醒链在真实多任务流程里是否成立。产物在独立仓库 `/Users/hobart/Codex/pipeline-smoke-wait`（不属于本仓库交付物）。

### 8.1 冒烟契约

整数精确运算，纯本地、无外部依赖、无浮点（浮点误差界会变成考察 spec 写作能力，而不是调度能力）。

| 任务 | 依赖 | Write scope | Review |
|---|---|---|---|
| T-1 整数核心工具 | none | `src/core.mjs`, `test/core.test.mjs` | mechanical |
| T-2 整数序列 | T-1 | `src/seq.mjs`, `test/seq.test.mjs`, **`src/catalog.mjs`** | mechanical |
| T-3 整数数论 | T-1 | `src/numbertheory.mjs`, `test/numbertheory.test.mjs`, **`src/catalog.mjs`** | mechanical |
| T-4 组合入口 | T-2, T-3 | `src/ops.mjs`, `test/ops.test.mjs` | mechanical |
| T-5 整数报表 | T-4 | `src/report.mjs`, `test/report.test.mjs`, `README.md` | mechanical |

判据自检：5 任务 ≥5 ✓；依赖边 4 条（T-1→T-2/T-3，T-2/T-3→T-4，T-4→T-5）✓；共享文件 1 对（T-2/T-3 同写 `src/catalog.mjs`，实测两次合流都落到了该文件）✓。

### 8.2 采集值

Lead（`51915b72-3011-40ad-a7df-e5961fe1b30a`）最终信封：

| 字段 | 采集值 |
|---|---|
| `tasks_done` | 5/5 |
| `dispatch_count` / `merge_count` / `merge_failures` | 5 / 5 / 0 |
| `first_dispatch_at` → `last_merge_at` | `2026-10-26T04:36:07Z` → `2026-10-26T04:49:57Z`（830s） |
| `wait_calls` / `wait_timeouts` | 5 / 0 |
| 单次 wait 阻塞时长 | 75s / 82s / 40s / 79s / 58s，合计 334s |
| `blockers` | none |

合流账本（`git log --first-parent integration/integer-ops-smoke`，提交时间换算为 UTC）：

```
b4ffb77  04:49:57Z  merge(T-5)
fd999c1  04:47:54Z  merge(T-4)
fafc6eb  04:45:34Z  merge(T-3)
bdd9949  04:43:27Z  merge(T-2)
98c9be3  04:40:30Z  merge(T-1)
f42764b  04:32:15Z  docs(spec): freeze integer-ops-smoke spec and task DAG
1219219  04:30:58Z  chore: init smoke repo
```

集成 tip `b4ffb77` 复核：`node --test` → `tests 37 / pass 37 / fail 0`；`git status --porcelain=v1` → 0 行。

### 8.3 结论

1. **唤醒链成立。** 5 次 wait 全部以 `status: idle` 返回、0 次 timeout，单次 40–82s 即子 agent 真实停下即返回，离 540s 上限很远。全程没有一次人工催促 Lead，也没有一次靠 `notifyOnFinish` 把结果送回来——Lead 回合不 idle，就不需要回调唤醒。§4.1 从假设升为已验证（串行路径）。
2. **空等没有消失，但可度量了。** 334s 阻塞 / 830s 墙钟 = 40%。这是子 agent 真实工作时间，不是空等；真正的空等需要并行 DAG 才能测出来（本次串行，未采集）。
3. **退出码恒 0 的坑没踩到**，因为 Lead 按 brief 解析了 JSON `status`。但这是纪律而不是机制——只要有人写一次 `paseo wait ... && 推进` 就会把超时当完成。
4. **门禁静默消失被查出。** 全程 `<git-common-dir>/paseo-pipeline/` 下只有 `locks/`，没有 `run-state.json`，即 `readRunState` 的 `present=false`：因子 3b（审查员与派发记录交叉核对）一次都没执行，而 run-log 里没有任何痕迹。**「门禁跳过」与「门禁通过」在账本上长得一模一样。** 已修：`merge-task.mjs` 在 run-log 追加 `review-attestation=run-state|mechanical-review|SKIPPED(no-run-state)`，账本不可解析则直接 exit 32（不再静默跳过）。SCEN-MRG-28 ×3 覆盖三种取值。
   - 该字段是在本轮运行中途加入的（`merge-task.mjs` 落盘 `04:46:21Z`，落在 T-3 合流 `04:45:34Z` 与 T-4 合流 `04:47:54Z` 之间），所以**同一次冒烟的 T-1/T-2/T-3 三行没有该字段、T-4/T-5 两行有**（均为 `mechanical-review`）。这是采集事实，不是遗漏。

### 8.4 摩擦点

1. **`pipeline.disposition` 的生产者契约没写进 brief。** Lead 首轮跑 `reconcile` 时 T-1 被判 `UNRESOLVED` 并锁死，只能从 `lib/roles.mjs` 反推「编排者核对产出后 `update_agent` 打 `handed-off`」。已写入 SKILL §1 的处置表；派发 brief 必须带这一条。
2. **zsh 的 `date +%3N` 不展开**，Lead 自报时间戳精度实为秒。要毫秒必须在 bash 下取或改用 Node。
3. **Paseo 会自动给已存在的分支名加后缀**（`integration/<name>` → `integration/<name>-1`）。创建 workspace 后必须 `git branch --show-current` 核对，否则合流门禁会以「当前分支不是 `integration/<name>`」拒绝。

### 8.5 本次冒烟未能覆盖的

- **并行 DAG（cap>1）**：全程串行派发，cap 并发与 scope 冲突串行化都没有被真实压测。
- **540s 上限被真正触及**：最长单次 82s，超时分支（`status: timeout` 后继续等同一 id）只在中途的原语探针里验过，没在真实任务上验过。
- **Lead 长回合的上下文增长**：Lead 只跑 13 分 50 秒，远未到压缩边界。
- **打回路径**：0 次打回、0 次仲裁、0 次预算消耗。
