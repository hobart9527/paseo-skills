# Proposal: run-ledger-dispatch-attribution

## Why

`run-state.mjs report` 同时打印两个派发计数，但两者口径不一致，而且其中一个是错的。`dispatches` 只数带真实 `agentId` 的回执（「派发确实发生过」），`auditDispatches` 却把**所有 phase 为 audit/arbitrate 的意图**都算进去，包括创建失败、已被 `fail` 显式作废的意图。

实测复现（2026-10-31，临时账本）：

```
claim T-01 ... --phase audit --role anchasi   # 审计意图建立
fail  T-01 ... (reason: create_agent failed)  # 创建失败，显式作废
report --json → dispatches=1 auditDispatches=1 voidedIntents=1
```

这次审计从未派出去，却被报告成「审查派发 1 次」。后果不是显示难看：`auditDispatches` 是复盘判断「审计覆盖够不够、派发成本高不高」的唯一数据来源，虚高的审计派发数会把一次失败的创建算成已完成的工作量，也会让「作废意图」这个本该显眼的信号被同一张报告里的另一个数字抵消。

根因是同一条语义在两个地方各写了一遍，新增计数时用了「意图存在」而不是「回执存在」。

## What Changes

- **`auditDispatches` 改为只数有真实回执的审计意图**，与 `dispatches` 共用同一个回执判据，不再各自实现一遍。
- **报告文案随之准确**：`审查派发 N 次` 中的 N 与 `派发 N 次` 口径一致，都只指「确实派出去并拿到 agent」。
- 已作废意图仍由既有的 `voidedIntents` 单独计数，不作为派发计入。

**不改**：`report` 的 JSON 字段集合与字段名、`dispatches` / `voidedIntents` 的现有语义、首次通过率与 READY 等待的算法、任何账本写入路径。

## Capabilities

**New Capabilities**：无。

**Modified Capabilities**：
- `pipeline-delivery` —— 「Run ledger refuses to erase receipts and reports only collected facts」这条要求目前只说「每个数字都来自账本已记录的事实」，没有排除「意图存在即算派发」这种把未发生的事记成事实的读法。本次把审计派发计数的口径写进该要求。

## Impact

- 代码：`skills/paseo-pipeline/run-state.mjs`（`report` 分支的计数与文案）
- 测试：`skills/paseo-pipeline/test/run-state.test.mjs`
- 无外部消费者：`auditDispatches` 在整个仓库只被 `run-state.mjs` 自身与该测试引用（`grep -rn auditDispatches skills/paseo-pipeline/`），不存在跨模块契约依赖。
