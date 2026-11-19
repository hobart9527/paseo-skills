# Tasks

<!--
  格式由 lib/tasks.mjs 定义：不合格式的任务行判 MALFORMED_LINE，整份 tasks.md 对编排器不可见。
  冻结前跑 `node "$PIPELINE_HOME"/freeze-check.mjs openspec/changes/<name>`，零错误才冻结。
  下面的 1.1 是可通过 freeze-check 的最小样例，照它的形状写，删掉即可。
-->

## 1. <任务组名>

- [ ] 1.1 T-01 <一句话目标：改什么、改完什么行为可用>
  - Depends on: none
  - Write scope: path/to/file.mjs, path/to/file.test.mjs
  - Est: M
  - Review: strict
  - Verify with: node --test path/to/file.test.mjs
  - Scenarios: SCEN-CAP-01

<!--
  必填四项：
  - 任务行：`- [ ] <序号> <ID> <标题>`，ID 形如 `T-01`；缺 ID 或 `T-01:标题` 判 MALFORMED_LINE。
  - Depends on：引用本文件内存在的任务 ID，不自依赖、不成环；无依赖写 none。
  - Write scope：非空，仓库内相对路径，逗号分隔；并行任务的 scope 互不重叠。
  - Verify with：非汇点点名本任务 Write scope 内的测试路径（带路径即窄跑，如 `pytest tests/x_test.py`）；
    不带路径的 `npm test`、`go test ./...` 只允许汇点。环境变量写全调用。脚本检查只证明其实际覆盖的属性。
  - Scenarios：本任务承载的 SCEN-*；每个声明的编号至少被一个任务认领，由 freeze-check 双向核对。

  可选字段，只在影响 Verify、调度、共享接口或风险时写；格式与报错码见 lib/tasks.mjs：
  `Review` (strict|standard|mechanical|deferred)、`Est` (S|M|L)、`Reads`、`Uses`、`Interface`、`Kind: skeleton`、
  `Implements`（仅有 design.md 时）、`Risk-surface`。`Review` 只选 ceshi 是否先写 Red 测试，不选审查流程。

  Done 行由 merge gate 写入；worker 标记执行，不是审查结论。
-->

## 2. <任务组名>

- [ ] 2.1 T-02 <一句话目标>
  - Depends on: T-01
  - Write scope: path/to/a.mjs, path/to/a.test.mjs
  - Review: standard
  - Verify with: node --test path/to/a.test.mjs
  - Scenarios: SCEN-CAP-02
