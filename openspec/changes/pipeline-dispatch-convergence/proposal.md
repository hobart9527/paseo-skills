# Proposal: pipeline-dispatch-convergence

## Why

2026-10-31 D 试点 L1（`run-ledger-dispatch-attribution`）人工救援 3 次。复盘更正归因后（见 `docs/paseo-pipeline-review-2026-10-26.md` §5），缺口 1、2 的根因相同：**任务派发有三个入口，分支与基点靠各自推导，契约只写在 prose 里**。

| 入口 | 任务分支 | 产物落盘 | 审计 | 采集值 |
| --- | --- | --- | --- | --- |
| 手动 MCP（主会话） | 靠主会话自觉；本次把写手派进了集成 workspace | 靠主会话自觉；本次未提交 change 目录 | 真实 Auditor | 缺口 1、2 实际发生处，直到 `merge-task` 才报错 |
| `hotfix.sh` | 机械：`--new-branch task/<c>/<t>[-aN] --base <当前分支>` | 机械：要求 `tasks.md` 在 checkout 里、工作区干净 | 仅 mechanical | 11 条测试，规格有场景 |
| `task-runner.mjs`（`c3151d2` 合入，未走 OpenSpec） | `git worktree add`（违反 SKILL §3） | 读主 checkout，不核对是否已提交 | 非 mechanical 档**伪造** `audit_<hex>` 审计员并自登记 PASS | 7 条测试，无规格场景 |

`task-runner.mjs` 还固定设置 `PIPELINE_ALLOW_HOMOGENEOUS_REVIEW=1` 绕过异构审查门禁，`paseo wait` 非零即 `fatal`（本次实测 `paseo wait` 在 231s 返回 rc=1 `WAIT_FAILED`，该路径会直接中断），离线分支会编造 agent id。

缺口 3（`node --test <目录>`）是操作失误：`test/run-all.sh` 已存在，只是 SKILL 收尾没有指向它。

## What Changes

- **新增交接门禁 `handoff-check.mjs`**：CP-1 之后、建集成 workspace 之前执行；机械核对 `openspec/changes/<name>/` 已提交且 `tasks.md` 能从集成基点读到。缺口 2 从“文字规则”变为“门禁”。
- **`run-state.mjs record` 拒绝把写手意图登记到集成分支**：写手 agent 的 cwd 当前分支为 `integration/*` 时 exit 2。缺口 1 在手动 MCP 路径上的机械拦截点（此前只有 `merge-task` 事后报错）。
- **`task-runner.mjs` 成为唯一 CLI 派发入口**：吸收 `hotfix.sh` 已验证的行为（Paseo 管理的任务 workspace + `task/<c>/<t>[-aN]` 分支、五标签、fail-closed profile、意图 claim/record/fail），去掉 `git worktree add`、编造 agent id、伪造审计与同构豁免。
- **审计诚实**：非 mechanical 档写手交付并通过 Verify 后以 exit 50 停下，等真实 Auditor；合流通过 `--review-tag` 交给 `merge-task` 自己的 3b/3c 门禁校验。
- **`paseo wait` 失败可恢复**：解析 `--json` 的 `status`；`WAIT_FAILED`/rc≠0 时改为轮询 `paseo inspect` 状态，超时给独立退出码 51，不重派。
- **`hotfix.sh` 降为兼容包装**：保留原 CLI 形态（brief 文件 + test-cmd），内部委托 `task-runner.mjs`；原 11 条测试继续约束行为。
- **SKILL 文档**：交接序列补“提交冻结产物 → `handoff-check`”；声明 `task-runner.mjs` 为唯一 CLI 入口；收尾全量测试指向 `test/run-all.sh`。

**不改**：`merge-task` 的 exit 码语义与全部门禁；`reconcile.mjs`（含 `--speculative`）；`--speculative` 在 `task-runner` 中的现有语义（保留）；`paseo wait rc=1` 的根因归因（本 change 只让调用方容错，不声称已查明）；明文 token（用户已搁置）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `pipeline-delivery`: CLI 派发入口唯一化与交接门禁。

## Impact

- 代码：`skills/paseo-pipeline/handoff-check.mjs`（新）、`lib/handoff.mjs`（新）、`run-state.mjs`、`task-runner.mjs`、`hotfix.sh`。
- 文档：`skills/paseo-pipeline/SKILL.md`（§1 Legacy CLI 路径、§2.1-7、§2.3）。
- 测试：`test/handoff-check.test.mjs`（新）、`test/run-state.test.mjs`、`test/task-runner.test.mjs`、`test/hotfix.test.mjs`、`test/docs.test.mjs`、`test/run-all.sh`。
- 兼容性：`hotfix.sh <change> <task> <brief> <test-cmd>` 调用形态不变；`task-runner.mjs` 的离线 fallback 与 `--stub-commit` 被移除（测试改用 `paseo` 替身，与 `hotfix.test.mjs` 同法）。
- 证据边界：本 change 以 n=1 的 L1 试点为依据；L2 试点未执行，合入后须补跑 L2 验证单一入口在多任务 DAG 下的行为。
