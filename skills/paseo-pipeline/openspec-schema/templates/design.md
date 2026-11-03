## Context

<!-- Current state and constraints that shape the approach. See proposal.md for motivation - don't restate it -->

## Goals / Non-Goals

**Goals:**
<!-- What this design aims to achieve -->

**Non-Goals:**
<!-- What is explicitly out of scope -->

## Decisions

<!-- Key design decisions with rationale and alternatives considered -->

## Risks / Trade-offs

<!-- Known risks and trade-offs -->

## Baseline Alignment

<!-- 与存量契约的对账表。每条新规则都要先查它会撞上的 capability spec、枚举/CHECK/迁移和存量测试；
     冲突必须在这里给出处置（reuse / delta / additive）和 path:line 证据。
| Rule / symbol | Baseline surface (spec / CHECK / enum / test) | Verdict (reuse / delta / additive) | Evidence |
| --- | --- | --- | --- | -->

## Impact Inventory

<!-- freeze-check 要求本节存在。每个被改的导出符号/函数：列出调用点、会因此变红的夹具与测试，以及负责它们的任务 ID。
     没有被改的共享符号时写「无共享符号变更」。同一行为影响到的夹具必须与该行为在同一个任务里。
| Symbol / behavior | Call sites | Affected fixtures/tests | Owning task |
| --- | --- | --- | --- | -->
