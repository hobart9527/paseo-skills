# pipeline-dispatch-convergence 验收冒烟证据

<!--
  本 change 交付的是编排工具链本身，真实入口就是各脚本的命令行（见 acceptance.md 的 Entry 列）。
  这份证据记录两件事：
  1. 唤醒路径：本次收尾审计派发（T-06 R1，anchasi）→ 完成 → 主会话收到的实测时间线；
  2. 10 个冻结场景各自的真实执行结果（取自 acceptance-receipt.json，非转述）。
  采集不到的一律写「未采集」，不估算。
-->

parent_agent_id: 5e2d33f8-3949-49f5-8657-7b36c22baaf5
child_agent_id: 7bb8b5a0-a0ee-4262-ab5a-cc9d92091c5e
notification_message_id: 06b90e5f-2b1d-4b9b-b9b4-8e1bd40e960c
dispatched_at: 2026-10-31T12:18:22.664Z
notification_at: 2026-10-31T12:18:43.439Z
reviewed_sha: a7353049b5e693040b646623193fd8ef28dddd60
result: PASS
relay_case: confirmed
unverified:

scenario_results:
  - SCEN-HND-01: PASS
  - SCEN-HND-02: PASS
  - SCEN-HND-03: PASS
  - SCEN-HND-04: PASS
  - SCEN-HND-05: PASS
  - SCEN-HND-06: PASS
  - SCEN-HND-07: PASS
  - SCEN-HND-08: PASS
  - SCEN-HND-09: PASS
  - SCEN-DISP-04: PASS

## 采集口径

- `parent_agent_id`：本次编排的 Lead agent，取自 `~/.paseo/agents/Users-hobart-.paseo-worktrees-2z1ya4b0-pipeline-dispatch-convergence-integration/5e2d33f8-3949-49f5-8657-7b36c22baaf5.json` 的 `id`，其 `createdAt` 为 `2026-10-31T09:04:57.558Z`。
- `child_agent_id`：T-06 R1 审计员，取自 `~/.paseo/agents/Users-hobart-.paseo-worktrees-2z1ya4b0-pdc-audit-t-06-r1/7bb8b5a0-a0ee-4262-ab5a-cc9d92091c5e.json` 的 `id`，其 `createdAt` 为 `2026-10-31T12:18:22.664Z`。
- `dispatched_at`：该 agent 在 Paseo 持久记录里的真实 `createdAt`（`2026-10-31T12:18:22.664Z`），即派发真正落地的时刻。
  账本里同一意图的 `createdAt` 是 `2026-10-31T12:17:30.742Z`，那是 `claim` 登记意图的时刻——早于 agent 被创建，
  属于「先认领意图、再派发」的正常次序，不是派发时刻，故不采用。
- `notification_at`：`run-state.mjs` 账本中同一意图的 `resolvedAt`（收到 agent 回执的时刻）。
- `notification_message_id`：Paseo 投递给主会话的 `finished` 通知 `message-id`。
- 两者均晚于 `child_agent_id` 的真实 `createdAt`，时间线自洽。

## 场景证据来源

全部 10 条取自 `acceptance-run.mjs pipeline-dispatch-convergence --write` 的实测输出（退出码 0）：

```
[acceptance-run] pipeline-dispatch-convergence 矩阵 openspec/changes/pipeline-dispatch-convergence/acceptance.md
  —— 共 10 条已执行；收据 /Users/hobart/Codex/paseo-skills/.git/paseo-pipeline/pipeline-dispatch-convergence/acceptance-receipt.json
  PASS SCEN-HND-01 exit=0 1s  node --test skills/paseo-pipeline/test/handoff-check.test.mjs
  PASS SCEN-HND-02 exit=0 1s  node --test skills/paseo-pipeline/test/handoff-check.test.mjs
  PASS SCEN-HND-03 exit=0 12s  node --test skills/paseo-pipeline/test/run-state.test.mjs
  PASS SCEN-HND-04 exit=0 10s  node --test skills/paseo-pipeline/test/task-runner.test.mjs
  PASS SCEN-HND-05 exit=0 10s  node --test skills/paseo-pipeline/test/task-runner.test.mjs
  PASS SCEN-HND-06 exit=0 10s  node --test skills/paseo-pipeline/test/task-runner.test.mjs
  PASS SCEN-HND-07 exit=0 10s  node --test skills/paseo-pipeline/test/task-runner.test.mjs
  PASS SCEN-HND-08 exit=0 19s  node --test skills/paseo-pipeline/test/hotfix.test.mjs
  PASS SCEN-HND-09 exit=0 0s  node --test skills/paseo-pipeline/test/docs.test.mjs
  PASS SCEN-DISP-04 exit=0 0s  node --test skills/paseo-pipeline/test/docs.test.mjs
```

收据 `head` 字段为 `a7353049b5e693040b646623193fd8ef28dddd60`（= 本证据的 `reviewed_sha`）。

> **关于 `reviewed_sha` 与集成 HEAD 的差**：本证据提交之后集成 HEAD 会前移，因此 `--sha <当前 HEAD>` 会报 sha 不符。
> 正确用法是用**被测代码的 SHA** 校验：
> `node "$PIPELINE_HOME"/test/check-evidence.mjs --gate acceptance --sha a7353049b5e693040b646623193fd8ef28dddd60 --matrix <acceptance.md> <本文件>` → exit 0。
> 承载本证据的提交只含 `acceptance.md` 与 `evidence/smoke.md` 两个 OpenSpec 文档（`git diff --name-only a735304 <该提交>` 可证），未改动任何被测代码。

## 全量回归

`bash skills/paseo-pipeline/test/run-all.sh` → `RUN_ALL_EXIT=0`：

```
ℹ tests 619
ℹ pass 619
ℹ fail 0
E2E OK (5 步)
=== All regression test suites completed successfully ===
```
