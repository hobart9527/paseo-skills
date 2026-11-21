# Tasks

<!--
  格式由 lib/tasks.mjs 定义：不合格式的任务行判 MALFORMED_LINE，整份 tasks.md 对编排器不可见。
  本文件是 Verify with / Entry / Required / Scenarios 的唯一真源；写完后运行 `pipeline-run.mjs acceptance sync <change-dir>` 编译 acceptance.md，再用 `freeze-check.mjs` 验零错。
-->

## 1. <任务组名>

- [ ] 1.1 T-01 <一句话目标：改什么、改完什么行为可用>
  - Depends on: none
  - Write scope: path/to/file.mjs, path/to/file.test.mjs
  - Entry: CLI `node path/to/file.mjs`
  - Est: M
  - Review: standard
  - Verify with: node --test path/to/file.test.mjs
  - Scenarios: SCEN-CAP-01

<!--
  必填四项：
  - 任务行：`- [ ] <序号> <ID> <标题>`，ID 形如 `T-01`；缺 ID 或 `T-01:标题` 判 MALFORMED_LINE。
  - Depends on：引用本文件内存在的任务 ID，不自依赖、不成环；无依赖写 none。
  - Write scope：非空，仓库内相对路径，逗号分隔；并行任务的 scope 互不重叠。
  - Verify with：非汇点点名 Write scope 内测试路径；不带路径的 `npm test` 只允许汇点。
  - Scenarios：本任务承载的 SCEN-*；与 acceptance sync 对账。

  Entry 与可选字段：
  `Entry`（真实入口，多场景可用 `SCEN-A=<entry>; SCEN-B=<entry>`）、Required: (`yes|no`，默认 `yes`)、
  `Review` (`strict|standard|mechanical|deferred`)、`Est` (`S|M|L`)、`Reads`、`Uses`、`Interface`、`Kind: skeleton`、`Implements`、`Risk-surface`。
  `Review` 只选 ceshi 是否先写 Red 测试；共享跨层类型优先用 Wave 0 `Kind: skeleton`。Done 行仅由 merge gate 写入。
-->

## 2. <任务组名>

- [ ] 2.1 T-02 <一句话目标>
  - Depends on: T-01
  - Write scope: path/to/a.mjs, path/to/a.test.mjs
  - Entry: CLI `node path/to/a.mjs`
  - Review: standard
  - Verify with: node --test path/to/a.test.mjs
  - Scenarios: SCEN-CAP-02
