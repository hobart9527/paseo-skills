# Proposal: pipeline-self-audit-remediation

## Why

2026-11-01 对本 skill 做了一次全面自审（4 个并行评审 + 人工逐条复核代码），671 条测试全绿、E2E 5 步通过的状态下，仍确认了 14 项负向问题：4 项 P0（合法路径死锁或文档承诺与代码相反）、6 项 P1（断裂/阻塞）、4 项 P2（摩擦/文档债）。共性根因不是门禁太少，而是**文档承诺密度超过代码实现密度**——承诺写在 SKILL.md，实现落在别处或根本没落，模型照契约执行会撞死锁。

| # | 级 | 问题 | 证据 |
|---|---|---|---|
| 1 | P0 | 交接顺序死锁：SKILL §2.1-7 要求先跑 `handoff-check`（第 3 步）再建集成 workspace（第 4 步），但 `lib/handoff.mjs:109` 要求当前分支已是 `integration/<change>`——照文档顺序必然 WRONG_BRANCH exit 1，而同一节写「顺序固定，不可跳过、不可合并」 | SCEN-HND-02 + SKILL.md:146-157 |
| 2 | P0 | 账本损坏被静默清空：`readRunState` 解析失败返回空 state，`updateRunState` 把空 state 整体写回，3 条 intents + review 实测变 1 条 + 0；三处消费口径不一（merge-task 拒、reconcile 不看、scope-guard 当无租约放行） | lib/run-state.mjs:139-178 |
| 3 | P0 | 一条未回执意图冻结全部派发：`reconcile.mjs:705-716` 把 `openIntentCount>0` 记入全局 holdReasons，与 SKILL §2.0「单个任务的 INVALID/UNRESOLVED 只压住被点名的任务」相反；孤儿意图挂已 DONE 任务时冻死整个 change | reconcile.mjs:644,705 |
| 4 | P0 | 信封「7 个统一字段」实为 8 个：`ENVELOPE_REQUIRED_FIELDS` 含 `kind`，SKILL.md:279 照抄正文写 7 字段信封会被 `record --envelope` 拒收 | lib/envelope.mjs:16 vs SKILL.md:279 |
| 5 | P1 | `--review-tag` 重入路径跳过租约：直接 resolveAttempt→mergeIntoIntegration，无 owner 校验；租约过期的旧会话仍能合流 | task-runner.mjs:508-518 |
| 6 | P1 | 无 `Verify with` 任务兜底 `npm test`：非 Node 仓库拿无关命令当交付证据，应硬失败不猜 | task-runner.mjs:387 |
| 7 | P1 | 「缺省档位合流时 fail closed」未实现：parser 返 null、task-runner 缺省记 `standard`、merge-task 从不读 `requiredReview`，实际静默放行；三处默认口径不一 | SKILL.md:105 vs task-runner.mjs:472 |
| 8 | P1 | tier-gate 全局默认开但零文档：`PIPELINE_TIER_GATE`/`PIPELINE_TIER_GATE_LIMIT` 只写在代码注释，SKILL 与 doctor 均不提及，用户不可发现 | lib/tier-gate.mjs:16 |
| 9 | P1 | exit 51 后无重入：超时即放生仍在跑的写手；且 `status=error` 不在终态集，写手已崩仍白轮询到超时再收误导文案 | task-runner.mjs:57,257-290 |
| 10 | P1 | doctor/install 对 `$HOME/...` 写法判定相反：install 不展开导致重复注册第二条 hook；doctor 不校验 tier-reminder hook | install.sh + pipeline-doctor.mjs |
| 11 | P2 | `run-state.lock` 残留锁死 2h 无清除入口：崩溃后 claim 一律 exit 2，错误文案不提 `--break-lock`（已存在但零文档）；stale 判定只用 mtime 不用 pid | lib/lock.mjs:19,96 |
| 12 | P2 | 陈旧文档：`spec.md:380` 仍写已删除的 `PIPELINE_ALLOW_HOMOGENEOUS_REVIEW`；`docs/sdd-multi-agent-architecture.md` 628 行描述已删角色（Scout/Critic/Arbiter/Scout-only verify）无头注降级 | openspec/specs + docs/ |
| 13 | P2 | `.zshrc:17` 与 `.zshenv:2` 双重导出 `PIPELINE_HOME` 且写法不同（`$HOME/...` vs 绝对路径），doctor 非交互读 `.zshenv`、交互会话读 `.zshrc`，漂移时行为不一致 | ~/.zshrc, ~/.zshenv |
| 14 | P2 | SKILL.md 过重（~414 行）：wait 口径三副本、「主会话不是 agent」两份、事故叙事内嵌规程，指令密度稀释执行注意力；第二入口仍写 `--change` 形态 | SKILL.md |

## What Changes

按 P0→P1→P2 分四组任务：

- **P0 组（T-01..T-04）**：交接顺序与门禁判据统一（改 SKILL 顺序描述：handoff-check 在集成分支存在后、首个派发前跑，`lib/handoff.mjs` 增加「基点已建语境」下的分支判据与明确报错指引，同步 SCEN-HND-09 测试）；账本损坏 refuse-to-write（`updateRunState` 在 `error` 非空时抛出，保留现场，加 `--break-lock` 之外的显式恢复路径说明）；reconcile 冻结范围化（open intent 只压住 `intent.task` 点名任务 + 孤儿意图仍全局 NEXT arbitrate，holdReasons 改 hold per task）；信封 7→8 字段订正（SKILL.md:279 补 `kind`，docs.test 断言字段清单与 `ENVELOPE_REQUIRED_FIELDS` 单一真源绑定）。
- **P1 组（T-05..T-08）**：`--review-tag` 重入补 owner/租约校验（与 claim 同一判据）；无 Verify 任务硬失败（exit 36 对齐 merge-task，删除 `npm test` 兜底）；缺省档位 fail-closed 真实现（merge-task 读 `requiredReview`/parser 未定态，未定即拒）；tier-gate 写进 SKILL（§8 新小节：判据、`PIPELINE_TIER_GATE=off`、LIMIT、覆盖缺口）+ doctor 校验 hook 注册与 `off` 状态可解释；exit 51 文案补「重跑同 task-id 即续等同一 attempt」+ `error` 加入 TERMINAL_AGENT_STATUSES + wait 重入口径与 SKILL §wait 一致。
- **P2 组（T-09..T-11）**：lock 手册化（`--break-lock` 写进 SKILL §4 与 run-state usage，stale 判定并入 pid 存活检测）；陈旧引用清理（spec.md:380 删 `PIPELINE_ALLOW_HOMOGENEOUS_REVIEW` 表述、sdd 架构文档加头注「历史设计记录，现行契约以 SKILL/spec 为准」）；SKILL 去重瘦身（wait 口径收敛为一处 + 指针、重复段删除，事故叙事迁 LESSONS.md，目标 ~300 行；§4 命令块修正为位置参数形态）。
- **T-12（收尾）**：全量测试 + contract-check delta+baseline 口径 + 验收矩阵回填 + 证据闸门。

**不改**：merge-task exit 码语义（新增 36 复用既有语义）；Pod 模式；角色路由；openspec-schema 结构；`pipeline-review-hardening` change（另一批已实现未归档修复，独立处理）。

**本仓自举说明**：修 skill 自身时 `$PIPELINE_HOME` 指向 main 工作树的当前实现，修复在集成分支验证后、合入 main 前后均以集成分支上实跑为准。交接门禁修复（T-01）落地前，本 change 按「先建集成分支再跑 handoff-check」执行——这正是 T-01 要合法化的顺序。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `pipeline-delivery`: 交接门禁分支判据、账本损坏处置、reconcile 冻结范围、信封字段文档、CLI 重入租约、Verify 缺失处置、缺省档位 fail-closed、tier-gate 文档化、wait 终态口径、锁恢复入口、文档收敛。

## Impact

- 代码：`skills/paseo-pipeline/lib/handoff.mjs`、`lib/run-state.mjs`、`lib/lock.mjs`、`reconcile.mjs`、`task-runner.mjs`、`run-state.mjs`、`pipeline-doctor.mjs`、`install.sh`。
- 文档：`skills/paseo-pipeline/SKILL.md`、`docs/sdd-multi-agent-architecture.md`、`openspec/specs/pipeline-delivery/spec.md`（归档时 delta 并入）、`LESSONS.md`。
- 测试：`test/docs.test.mjs`、`test/handoff-check.test.mjs`、`test/run-state.test.mjs`、`test/reconcile.test.mjs`、`test/task-runner.test.mjs`、`test/pipeline-doctor.test.mjs`、`test/install.test.mjs`、`test/lock.test.mjs`、`test/run-all.sh`（如新增文件）。
- 环境文件：`~/.zshrc`（删重复导出行，属用户环境改动，收尾时单独提请确认）。
- 兼容性：无 Verify 任务的 `--fast` 合流从「跑 npm test」变为拒绝——这是有意的（旧行为拿无关命令当证据）；`open intent` 不再全局冻结——单任务阻断语义与 SKILL §2.0 原文对齐。
