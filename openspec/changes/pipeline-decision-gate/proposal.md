# Proposal: pipeline-decision-gate

## Why

D10 交付（2026-11-19）的前两个 package 都通过了当时的所有门禁，问题却在很后面才暴露：

1. **硬决策没被拦住**。首个 package `3f295215` 带着 OD-1..OD-6 六个开放硬决策就通过了 staged 检查并进了 R0。当时代码里已有 `openDecisionFindings` 的判定逻辑，但 `--stage specs` 分支在它之前就 return 了，所以最早的检查点看不到最该看的东西。
2. **场景不可证**。每个 `#### Scenario:` 都要求一行 `**Verify:**`，模板和 schema 都写了，但没有任何脚本读过它：`spec-scan.mjs` 不提取 Verify，`acceptance-run.mjs` 只从 `acceptance.md` 读。于是 scenario 可以完全不可证而全部门禁通过。
3. **交接产物不可重放**。Tier 2 交接 brief 只要求一个实现提交，Red 证据无法在测试提交处复跑；调度心跳写成 `*/30` 这种步进 cron，会在下一个半点就误触发。

三条的共同点是：**规则写在文档里，却没有任何执行点**。门禁跑绿只证明“没检查的东西没报错”。

## What Changes

- **staged 检查拦住开放硬决策**：`freeze-check.mjs --stage specs` 与完整运行使用同一套判定；被 spec 文本或任务块引用的开放硬决策（money/auth/external-write）为阻断项，未引用的或 product 类只作建议。作者 brief 与 proposal 模板统一为一条规则：遇到开放硬决策提交当前状态并返回 `BLOCKED (decision)`。
- **scenario 必须带 Verify**：spec 模板与 schema 要求每个 scenario 一行 `**Verify:**`，staged 检查对缺失行报阻断；handoff 路由下已有 `acceptance.md` 标记为历史，由 Tier 2 证据重查取代。
- **交接证据可重放**：`docs/tier2-handoff-brief.md` 要求新增行为测试的 slice 先提交测试（仅测试文件、在基线上红），实现第二个提交；调度心跳用绝对一次性 cron（dispatch 时间 + 回退窗口），显式 `timezone` 与 `maxRuns: 1`，不用步进 cron。

**不改**：`freeze-check` 的角色识别、审查基线来源、`create_agent` 参数校验（属 `pipeline-early-gate` 变更）；Paseo 行为；既有 SCEN 编号。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `pipeline-delivery`: 契约阶段提前拦开放硬决策、scenario 可证性、交接证据可重放三条需求。

## Impact

`skills/paseo-pipeline/freeze-check.mjs`、`skills/paseo-pipeline/lib/spec-scan.mjs`、`skills/paseo-pipeline/openspec-schema/{templates/spec.md,schema.yaml,templates/proposal.md}`、`skills/paseo-pipeline/templates/author.md`、`docs/tier2-handoff-brief.md`、`skills/paseo-pipeline/SKILL.md` 及其测试。不新增表、队列、服务或外部写入。

## Baseline

- `skills/paseo-pipeline/freeze-check.mjs:91`: `UNDECIDED_HARD_DECISION` 的修复说明已存在，判定函数 `openDecisionFindings` 在 `:779`；staged 分支现在调用它（`:204`），而这次改动前该分支先返回，`3f295215` 因此带着六个开放硬决策通过。
- `skills/paseo-pipeline/freeze-check.mjs:1000`: route 只由 `maxWidth`、任务数与 `openHardDecisionBlock` 计算，所以开放硬决策一旦阻断，route 即为 `null`。
- `skills/paseo-pipeline/openspec-schema/templates/spec.md:15`: 模板已给出 `**Verify:**` 行，schema 在 `schema.yaml:22` 要求每个 scenario 一行；`skills/paseo-pipeline/lib/spec-scan.mjs` 此前不提取 Verify，`acceptance-run.mjs` 只从 `acceptance.md` 读，故缺行不可发现。
- `docs/tier2-handoff-brief.md:14` 与 `:26`: brief 现在要求行为测试 slice 用两个提交，且证据重查在测试提交处复跑 Red 命令。
- `skills/paseo-pipeline/SKILL.md:74`: 心跳要求绝对一次性 cron、显式 `timezone`、`maxRuns: 1`，明确不用 `*/30`。
