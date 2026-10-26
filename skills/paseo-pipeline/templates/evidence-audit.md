# Audit Evidence

<!--
  Auditor 的审查收据。字段集合由 test/check-evidence.mjs 决定。
  结构闸门：`node skills/paseo-pipeline/test/check-evidence.mjs --kind audit <本文件>`
  验收闸门：加 `--gate acceptance --sha <集成 HEAD>`

  verdict 只接受约定的通过结论（PASS / PASS_WITH_NITS）。FAIL、BLOCKED、
  未定义的自造结论（如 PASS_SCRIPT_FAIL_NATIVE_RELAY）都不能折算为通过：
  那是「审查过程完成了」，不是「被审的能力通过了」。调查任务的完成定义 ≠ 被调查能力的完成定义。

  reviewed_sha 必须是被审的那个 commit，不是分支名、不是 HEAD~1。
  分支在审查后移动过，这份收据就作废——必须重新审。
-->

verdict: <PASS | PASS_WITH_NITS | BLOCK>
reviewed_sha: <被审 commit 的 sha（7-40 位）>
reviewer_agent_id: <审查 agent 的完整 UUID，必须与写手不同>
base_sha: <审查基线 sha，即 diff 的起点>

## Blockers

<!--
  每条 Blocker 必须有可复现的判据与关闭条件，否则下游无法机械消费「修好了没有」。
  R2 复核优先核对下列 R1 blocker 是否闭环，再看修复影响面；新发现的严重正确性问题
  照常阻断，不得以「发生在原 diff 之外」为由放过。
-->

- id: <BLK-1>
  file: <path:line>
  severity: <SPEC_VIOLATION | CORRECTNESS_BUG | SECURITY_DEFECT | SCOPE_VIOLATION>
  repro: <能复现的具体输入或命令>
  closing_criteria: <什么样的结果算修好>

## Nits

<!-- 命名、注释、风格偏好一律放这里，不阻断合流。 -->

- <NIT: ...>

## Scenario coverage

<!-- 与 spec delta 的 SCEN-* 一一对应；未覆盖的如实写未覆盖，不写 PASS。 -->

- SCEN-XXX-01: <PASS | FAIL | 未覆盖 + 原因>
