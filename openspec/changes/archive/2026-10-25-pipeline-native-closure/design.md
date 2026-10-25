# Design: Pipeline Native Closure

边界：只改 `skills/paseo-pipeline/**` 与本 change 产物。运行时=Paseo，生命周期=OpenSpec，集成事实=Git；不新增调度器、事件库、收据库、daemon 配置。

## Decisions

**D1 原生 MCP 派发为默认路径。** SKILL.md 规定派发用 agent 作用域 `create_agent`/`send_agent_prompt`，`provider`、`settings.modeId`、`settings.thinkingOptionId`、`settings.features`（来自 profile 的 `featureValues`，有则逐字复制）均取自当次 `list_profiles`，缺省字段省略、不造默认值；`notifyOnFinish` 保持默认 true；labels 带 `pipeline.change/task/attempt/phase/role`。
 `dispatch.mjs`/`hotfix.sh` 降级为 legacy 兜底：运行时打印 "LEGACY: completion callback not verified for this path"。该表述仅限 **本次实测的 CLI 路径与版本**（`paseo run --no-wait` 创建的 agent 未绑定父 agent 通知；证据见 `evidence/native-smoke.md` 中 CLI 对照项，未采集则写 UNVERIFIED），不泛化为所有版本/路径。CLI 成功退出与父 label 均不构成回调送达证据。
 保留源检出脏改意图：pi provider 不传 `--mode`；mode/thinking 缺省不发明默认值。

**D2 单一 tasks.md 解析器 (`lib/tasks.mjs`)。** reconcile 与 merge-task 共用，消除正则漂移。校验：任务 ID 唯一、`Depends on` 引用存在、拒绝自依赖与环（Kahn）、`Write scope` 必填。同时解析 Done 行：`Done: source=<tip7> review=<tag>`（见 D4）。违规返回 INVALID，不降级为 READY。

**D3 reconcile：只读、单一策略属主。** 判定顺序（互斥）：`INVALID`（图/行非法，或已勾选但 Done 无法按 D4 验证——账本失配）→ `DONE`（已勾选且 Done 验证通过）→ `ACTIVE` → `UNRESOLVED` → `MERGE_CANDIDATE` → `BLOCKED_DEP` → `BLOCKED_RESOURCE` → `READY`。

*2026-10-25 人类批准的 scope 校验澄清（T-02 attempt 5 限定范围）。* `Write scope` 必须为仓库根内相对路径；沿用 a4 的路径规范化规则，不新增 DEL/C1 禁令。非法 scope 在所有任务状态分类前判 INVALID，包括原本可判 DONE、ACTIVE、UNRESOLVED、MERGE_CANDIDATE 或 BLOCKED_DEP 的任务。任务分类与实际运行占用分开：非法任务的 initializing/running 写入者仍计入 cap，未知写范围保守占位，并清空 `canDispatchNow`；不得因 INVALID 提前返回而丢失运行事实。DEL/C1 原 Blocker 经原 Auditor 澄清为 Advisory，不作为本次修复目标。再次审计有 Blocker 则停止，不自动追加重试。

*运行态角色识别（控制面 vs 执行面）。* 同 `pipeline.change=<c>` 的 agent 按 `pipeline.role` 分类：
- 控制面（不持写范围、不要求 task 标签）：`shangshu`(Lead)、`xunjian`(Watcher)、`yushi`(spec 阶段 Critic，phase=spec-review)、`dalisi*`(Arbiter)、`mige`(Scout)。
- 任务面只读（要求 task/attempt/phase，不持写范围）：`anchasi`(Auditor)。
- 任务面写入（要求 task/attempt/phase，持写范围）：`gongbu`、`gaogong`、`qingqibing`、`ceshi`。
- UNMAPPED：处于 initializing/running 的 agent 缺 `pipeline.role`、role 未知、或任务面角色缺 task/attempt/phase、或 task 不在 tasks.md。出现 UNMAPPED → `canDispatchNow` 清空（fail closed）并输出 agent id。合法控制面 agent 不触发 UNMAPPED。

*attempt/phase 与已处置表示。* phase 顺序 `test < impl < audit < merge`。同一 task 的 agent 历史按 (attempt, phase) 排序，仅 **最新 attempt 的最新 phase** agent 参与 UNRESOLVED 判定；较旧 attempt 或已被取代的 agent 在**确认终止后**为历史（见下方终止性前置）。已处置的可信表示：Lead 用 `update_agent` 给该 agent 打 label `pipeline.disposition=<handed-off|merged|rejected|abandoned>`（运行态在 Paseo labels，无新账本，无需提交，不弄脏工作树）。
 **终止性前置（先于 attempt/phase 排序）：** 凡 status ∈ {initializing, running} 的任务面写入者 agent，无论 attempt/phase 新旧，均视为 ACTIVE 并持有写范围、计入 cap；只有确认终止（status ∉ {initializing, running}）后才可成为历史。因此旧 attempt 仍在跑时，任务不会 READY，也不会漏算资源。
 UNRESOLVED 当且仅当：task 未 Done、无 ACTIVE agent，且其最新 (attempt, phase) agent 未带 `pipeline.disposition` label，并满足 ① status=error，或 ② 等待权限，或 ③ idle/closed 且尚无更后 phase 的 agent。disposition label 对 error/idle/closed 一视同仁地解除 UNRESOLVED（`rejected`/`abandoned` 后可派发新 attempt；等待权限状态不得被 disposition 掩盖，须先由人类处置使其离开该状态）。Task 一旦 Done，全部 agent 为历史（仍 running 的除外，作为 UNMAPPED/ACTIVE 阻断并上报）。ACTIVE = 任一任务面 agent 处于 initializing/running。

*其他规则。* 依赖释放：仅当依赖任务 DONE（含 D4 验证）；与同波其他任务无关。分支领先只产生 `MERGE_CANDIDATE`，不等价于验收。`paseo ls` 失败/不可解析 → `runtime: unavailable`，`canDispatchNow` 恒空，仍输出 git/tasks 派生分类。当前分支必须 `integration/<change>`。`behindMain` 仅信息项，不触发 rebase。

*资源策略（本版声明）。* 写范围路径前缀不相交且各自隔离 worktree 的任务可并发；相交者按 tasks.md 顺序串行，后者 BLOCKED_RESOURCE 并给出冲突方。占用集合 = ACTIVE ∪ UNRESOLVED ∪ MERGE_CANDIDATE（权限暂停/待合流的任务继续占位）。**集成永远串行**（merge-task 单进程、干净树）。本版只检测路径前缀重叠，不声称检出语义冲突（如共享 lockfile、生成物、同一导出面）；此类须在 `Write scope` 显式声明共享文件，否则属已知局限，写入 SKILL.md。`cap - ACTIVE` 限制派发数。

**D4 merge-task 安全合流与 Done 账本。** 接口：`merge-task.mjs <branch> <task-ids> <review-tag> <test-cmd>`，四参必填。
- 前置：当前分支 `integration/<change>`；工作区干净；change 由 branch (`task/<c>/<id>[-aN]`、`pod/<c>`) 推出且须有 tasks.md；task-ids 精确匹配（词边界，`T-1`≠`T-10`），与分支段一致；已 Done 拒绝。
- review-tag：`pass(<reviewer-id8>@<tip7>/<base7>)`。`tip7` 必须等于待合流分支当前 tip；`base7` 为审查时集成 HEAD。若 `base7`≠当前 HEAD：计算 `base7..HEAD` 与分支改动文件交集，非空则拒绝（需重审），为空则放行但仍在合并树上跑测试并把漂移写入 run-log；**不要求 rebase**。`pass(mechanical@...)` 仅当任务声明 `Review: mechanical`。
- 局限（如实写入文档）：脚本只能校验 tag 与 SHA 的一致，**无法证明审查真实发生**。Lead 在调用前必须读取 Auditor 终态信封，确认 verdict=PASS 且其 reviewed SHA == tip；strict 任务不得以 hotfix 绕过 Auditor。
- Done 表示：自引用不可行（Done 行在被提交内容里），故 Done 行记录 `source=<tip7>`，合流提交消息携带 trailers：`Pipeline-Task: <ids>`、`Pipeline-Source: <完整 tip sha>`。验证（D3 的 DONE 条件）：集成分支 first-parent 链上存在合流提交 M，满足 `M^2`（第二父）== Done.source 展开的 tip，且 M 的 `Pipeline-Task` trailer 含该 task。仅"tip 是 HEAD 祖先"不算 accepted（可经非 first-parent 路径或 cherry-pick 进入）。无此映射 → INVALID。
- 失败：冲突/测试失败 → `git merge --abort`；abort 失败退 40 并打印现场，**不 `reset --hard`**，无吞异常。码：冲突 10、测试失败 20、abort 失败 40、参数/前置 1。
- 原子：一次提交含代码合并 + tasks.md `[x]`/Done + run-log 追加。

**D5 事件驱动 + 惰性对账；无虚构唤醒。** 常规运行不建 heartbeat/schedule。无已验证计时器或外部事件源时，回调静默丢失无法唤醒空闲 Lead：SKILL.md 写明该限制，对账在下一次真实调用（用户消息、其他 agent 通知、会话恢复）时执行。不宣传十分钟 watchdog。

**D6 通知与信封纪律。**
- 信封 ≤20 行：`kind=turn-idle|phase-complete|blocked`、phase/task/attempt/result/paths/blockers/next_action。`turn-idle`（Lead 等孙 worker 时本 turn 结束）≠ 阶段完成。
- 父-Lead-孙接力（本次真实案例）：Lead 派孙 agent 后自身 idle，其 `finished` 通知只表示 turn 结束；`create_agent` 的 notifyOnFinish 对孙 worker 终态是一次性观察，被 Lead 消费后不会再通知上一级。孙完成且 Lead 完成修订/复核后，Lead **必须显式** `send_agent_prompt`（steer）把 `phase-complete`/`blocked` 信封发给父会话。此场景写入 SKILL.md 并由冒烟 T-08 实测。
- 去重键：`(agent_id, message-id/event-id, task, attempt, phase, revision=tip7)`，不是单 agentId（同 agent 连续多 turn 各有 message-id）。同键已处置、或 attempt 低于当前、或 task 已 Done、或 revision≠当前 tip → 记一行忽略，不触发派发。
- 权限暂停：任务→UNRESOLVED；Lead 只可经 `list_pending_permissions` 读取并上报人类。**Lead/AI 严禁调用 `respond_to_permission` 代批**，不以任何"授权范围"泛化用户授权；人类决策后才续跑。
- 重试预算：每任务 ≤2 次打回 + 1 次升级，用尽标 Blocked。无固定延迟承诺。

**D7 OpenSpec CLI 主会话独占；workspace 保留。** 子 agent 只读产物。失败/Blocked 任务 workspace 不自动归档；合流成功后才归档。无强制 rebase、无"零压缩"承诺；冒烟表改为"记录实测，未采集写未采集"。静态测试通过只表示该断言通过，不称 coverage；contract-check 输出措辞标注"静态引用"。

**D8 测试与证据。** 零依赖：`node:test` + 临时 git 仓库 + PATH 注入假 `paseo`。入口 `test/run-all.sh`。假 `paseo` 仅单测，不得作回调证据。`evidence/native-smoke.md` 由 `test/check-evidence.mjs` 结构化核验：必须含键 `parent_agent_id`、`child_agent_id`（UUID）、`notification_message_id`、`notification_at`/`dispatched_at`（ISO）、`result`（PASS|FAIL）、`relay_case`（grandchild→Lead→parent 的 send_agent_prompt 结果）、`unverified:` 列表；缺项失败。`final-audit.md` 同样核验 `verdict:` 与 `reviewed_sha:`。`test -s` 不再作验证。

## 兼容性评估
| 组件 | 影响 | 处理 |
|---|---|---|
| dispatch.mjs | CLI 无回调（本次实测路径） | legacy 警告；保留 pi/可选字段修复；labels 增加 task/attempt/phase；featureValues 复制 |
| hotfix.sh | `paseo wait` 阻塞+默认 mechanical | 保留 pi 兼容；test-cmd 必填；仅 `Review: mechanical` 任务，tag 为 `pass(mechanical@<tip7>/<base7>)`；strict 任务拒绝 hotfix |
| reconcile.mjs | 输出分类增多 | `--json` 旧键保留（READY/MERGE/RUNNING/DONE/BLOCKED），新增 INVALID/UNRESOLVED/BLOCKED_RESOURCE/UNMAPPED/runtime |
| merge-task.mjs/.sh | 参数与 Done 格式收紧（破坏性） | 同步 SKILL.md/LESSONS.md；旧 `merge=` Done 行视为账本失配 INVALID |
| contract-check | 逻辑不变 | 仅措辞；既有测试保持通过 |

## 风险
- 源检出脏改不含于本 workspace：T-04 重做同等意图，不覆盖源检出，由父会话决定合入。
- 参数/Done 收紧使旧调用失败（fail closed，有意）。
- 路径前缀并发判定不覆盖语义冲突（已知局限，已声明）。
