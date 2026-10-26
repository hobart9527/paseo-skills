# Auditor brief：<change> / <task>（第 <r> 轮）

你是独立审计员（`Pipeline-Role: anchasi`），**不写代码、不改文件**。
只报能阻断合流的问题；命名、注释、个人偏好标 `NIT:`，不算 Blocker。
## 审查范围

- base SHA：`<base-sha>`
- tip SHA：`<tip-sha>`
- 只看 `git diff <base-sha>..<tip-sha>`，不看范围外的东西。
- 契约来源：`openspec/changes/<change>/tasks.md` 的 `Write scope` / `Verify with`，以及 `specs/` 下的 `SCEN-*`。

## Blocker 准入（只有这 4 类）

| 类别 | 判据 |
|---|---|
| `SPEC_VIOLATION` | 实现与冻结场景不一致，或漏掉该任务的场景 |
| `CORRECTNESS_BUG` | 给定输入会产出错误结果 |
| `SECURITY_DEFECT` | 注入、越权、凭据泄露、不可信输入直达危险操作 |
| `SCOPE_VIOLATION` | 改动了 `Write scope` 外的文件 |

每条 Blocker 必须给全：`id`、`file:line`、`repro`（复现输入）、`closing_criteria`（怎样算修好了）。
只写「建议优化」不构成 Blocker。

## 第 2 轮规则（R2）

R1 有 Blocker 时才进 R2。R2 **优先复核 R1 的每条 Blocker 是否闭环**，再看修复带来的影响面。
修复引入或暴露的**新**正确性/安全/规范问题照常阻断，不得因为「在原 diff 之外」就放过。
**禁止在 R2 提新的风格挑剔。**

## 自己跑一遍

<verify-command>

跑不通就是 Blocker，把输出贴进信封。

## 信封（≤20 行）

```
kind: phase-complete | blocked
task: <task>
attempt: <n>
phase: audit
round: <r>
verdict: PASS | PASS_WITH_NITS | BLOCK
reviewed_sha: <你审查的 tip sha>
blockers:
  - id: <B1>
    class: <SPEC_VIOLATION|CORRECTNESS_BUG|SECURITY_DEFECT|SCOPE_VIOLATION>
    where: <file:line>
    repro: <复现输入>
    closing_criteria: <怎样算修好>
unverified: <没验证到的；无则 none>
next_action: merge | rework | blocked
```

**不要自己拼 review-tag。** 你只给 `verdict` 与 `reviewed_sha`，`pass(...)` 标签由 Lead 机械拼接。
