## Context

`report` 的计数都从账本推导。`dispatches` 用的是「有 `agentId`」判据，`auditDispatches` 用的是「phase 属于 audit/arbitrate」，两处各写一遍。见 proposal.md — Why。

相关事实：

- 意图有两个终态：`record`（带回执，`resolvedAt` + `agentId`）与 `fail`（`failedAt`，语义是「这次派发确认没有发生」）。两者互斥，`fail` 不能作废已有回执的意图。
- `voidedIntents` 已用 `isFailed(intent)` 单独计数。
- `auditDispatches` 在仓库内没有外部消费者。

## Goals / Non-Goals

**Goals:**
- 报告里所有「派发次数」用同一判据，新增计数时无法再各写一遍。

**Non-Goals:**
- 不改账本结构、不改写入路径、不改字段名（`auditDispatches` 名字保留：它指的是「派出去的审计」，语义本就正确，错的是判据）。
- 不把「审计意图被作废」升级成告警或门禁。审计创建失败已经在 `voidedIntents` 里可见，本次只保证它不冒充成功。

## Decisions

**决定：把回执判据抽成一个局部谓词，两处计数共用。**

```js
const dispatched = (intent) => typeof intent.agentId === 'string' && intent.agentId !== '';
const dispatches = state.intents.filter(dispatched);
const auditDispatches = dispatches.filter((intent) => ['audit', 'arbitrate'].includes(normalizePhase(intent.phase)));
```

审计计数改为**在已派发集合里筛**，而不是在全部意图里筛。这样「未回执」与「已作废」两种未发生的派发被结构性地排除，不依赖调用方记得再补一个条件。

备选方案：保留两处独立实现，只在 audit 分支补 `!isFailed(intent) && intent.resolvedAt` 条件。否决理由——这正是缺陷的成因（第二次写判据时漏了一半），补一次条件不会阻止第三次漏。

备选方案：把审计计数改名成 `auditIntents` 再新增一个 `auditDispatches`。否决理由——两个近义字段并存会让读者继续猜哪个是「真的派发了」，而现有字段没有外部消费者，直接修正判据的迁移成本为零。

## Risks / Trade-offs

- **报告数字会变小**：历史账本里若存在作废的审计意图，重跑 `report` 得到的 `auditDispatches` 会比以前小。这是修正而非回归——旧值是错的。相关账本只用于复盘，`report` 是只读命令，不写回账本，因此没有迁移动作。
- **`arbitrate` 仍计入审计**：仲裁也是独立审查派发（异族 agent），口径不变；本次只改「未回执算不算」，不改「哪些 phase 算审查」。
