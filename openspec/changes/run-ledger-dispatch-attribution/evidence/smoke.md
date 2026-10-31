# run-ledger-dispatch-attribution 验收冒烟证据

<!--
  本 change 改的是编排工具链本身：真实入口是 `run-state.mjs report` 的命令行
  （见 acceptance.md 的 Entry 列），不是业务 API。
  因此本文件记录两件事：
  1. 派发 → 完成 → 通知送达的时间线（下方结构化字段，全部取自 Paseo 持久记录与通知原文）。
  2. 冻结场景 SCEN-CON-27 的真实执行结果（由 acceptance-run.mjs 实跑回填）。
-->

parent_agent_id: f9dde14f-160f-4e23-89f3-472c757ecf86
child_agent_id: 0dc99e7a-f5e0-491e-913d-0b0afd288385
notification_message_id: 80f0923d-6db7-49ab-a65e-29cc53912ef9
dispatched_at: 2026-10-31T06:20:56.070Z
notification_at: 2026-10-31T06:26:01.612Z
reviewed_sha: 9c84f8b8c3bb14600aa6e6796c9d098f0c954bbb
result: PASS
relay_case: confirmed
unverified:

scenario_results:
  - SCEN-CON-27: PASS

---

## 1. 时间线（采集值，来源逐条注明）

| 事件 | 时间 | 采集来源 |
| --- | --- | --- |
| 派发意图创建（claim） | 2026-10-31T06:19:52.311Z | 运行账本 `intents[0].createdAt` |
| 派发回执（record，带真实 agentId） | 2026-10-31T06:20:56.070Z | 运行账本 `intents[0].resolvedAt` |
| 写手 agent 真实创建 | 2026-10-31T06:20:44.156Z | `~/.paseo/agents/*/0dc99e7a-….json` 的 `createdAt` |
| 写手判定 finished | 2026-10-31T06:26:01.612Z | 同一记录的 `attentionTimestamp`（`attentionReason: finished`） |
| 完成通知送达主会话 | 2026-10-31T06:26:03.628Z | transcript attachment `queued_command` 的 `message-id=80f0923d-…` 记录时刻 |

说明：`dispatched_at` 取账本 `resolvedAt` 而非 `createdAt`——`createdAt` 是意图认领时刻，
早于 agent 真实创建（06:20:44），把它当派发时刻会让「派发早于创建」的荒谬时间线通过闸门。

## 2. 合流与验收执行

```
[merge-task] Success: tasks=T-01 branch=task/run-ledger-dispatch-attribution/T-01
             source=899ac35f9422c6363650d0d88047662d565f1df9
             merge=9c84f8b8c3bb14600aa6e6796c9d098f0c954bbb test_duration=10850ms

[acceptance-run] 共 1 条已执行；收据 <run-state>/run-ledger-dispatch-attribution/acceptance-receipt.json
  PASS SCEN-CON-27 exit=0 10s  node --test skills/paseo-pipeline/test/run-state.test.mjs
```

`node --test skills/paseo-pipeline/test/run-state.test.mjs` 在集成分支上实测
`tests 43 / pass 43 / fail 0 / duration_ms 10678`（合流门禁跑一次、主会话复核跑一次，
两次结果一致）。

## 3. SCEN-CON-27 的判定依据

冻结 spec 的判据是「未回执的审计意图不得计入审查派发」。修复前实测量为
`dispatches=1 auditDispatches=1 voidedIntents=1`（作废的审计意图被算作一次审计派发），
修复后为 `dispatches=1 auditDispatches=0 voidedIntents=1`。

实现上 `hasReceipt` 是一个局部谓词，被 `dispatches` 与 `auditRounds` 两处共用；
audit/arbitrate 的 phase 选择未改，另有一条回归测试锁定「有回执的 audit/arbitrate 仍计数」，
防止本次收紧误伤 phase 判定。

## 4. 未验证项

无。本 change 只改 `report` 的计数判据，无 UI、无外部服务、无持久化格式变更。
