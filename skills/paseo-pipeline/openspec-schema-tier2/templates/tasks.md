# Serial Tier 2 Tasks

<!--
  格式由 lib/tasks.mjs 定义：每项必须含 ID（如 T-01）、Write scope、Entry、Verify with 与 Scenarios。
  Tier 2 保持串行（Depends on: none 或单链）；若膨胀到高并发 DAG，补充 proposal.md 并升级 /paseo-pipeline。
-->

## 1. <任务组名>

- [ ] 1.1 T-01 <一句话目标：改什么、改完什么行为可用>
  - Depends on: none
  - Write scope: path/to/file.mjs, path/to/file.test.mjs
  - Entry: CLI `node path/to/file.mjs`
  - Verify with: node --test path/to/file.test.mjs
  - Scenarios: SCEN-CAP-01

## 2. <任务组名>

- [ ] 2.1 T-02 <一句话目标>
  - Depends on: T-01
  - Write scope: path/to/next.mjs, path/to/next.test.mjs
  - Entry: CLI `node path/to/next.mjs`
  - Verify with: node --test path/to/next.test.mjs
  - Scenarios: SCEN-CAP-02
