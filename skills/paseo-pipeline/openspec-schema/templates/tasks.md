# Tasks

<!--
  格式由 lib/tasks.mjs 定义，不是风格选择：不合格式的任务行会被判 MALFORMED_LINE，
  整份 tasks.md 对编排器（freeze-check / merge-task）不可见。
  冻结前跑 `node "$PIPELINE_HOME"/freeze-check.mjs openspec/changes/<name>`，零错误才冻结。

  每任务三部分：任务行 → 元数据子字段 → 完成时的 Done 行。
  下面的 1.1 是一份可通过 freeze-check 的最小样例，照它的形状写，删掉即可。
-->

## 1. <任务组名>

- [ ] 1.1 T-01 <一句话目标：改什么、改完什么行为可用>
  - Depends on: none
  - Write scope: path/to/file.mjs, path/to/file.test.mjs
  - Review: strict
  - Verify with: node --test path/to/file.test.mjs
  - Scenarios: SCEN-CAP-01

<!--
  字段规则（解析器强制执行，写错就是 MALFORMED_LINE / MISSING_SCOPE / UNKNOWN_* 报错）：

  - 任务行：`- [ ] <序号> <ID> <标题>`。ID 形如 `<字母>-<数字>`（T-01、TASK-3）。
    `- [ ] 1.1 标题` 没有 ID 会被判 MALFORMED_LINE；`T-01:标题` 冒号紧贴 ID 同样不合法。
  - Write scope：必填非空，仓库根内相对路径，逗号分隔；不许绝对路径、不许 `..` 逃出根。
  - Depends on：必须引用本文件里存在的任务 ID；不许自依赖、不许成环。无依赖写 none。
  - Reads（可选）：本任务测试/Verify 会碰到、但在 Write scope 之外的路径（如兄弟任务的模块）。
    合流时只有「被依赖的任务」或「Write scope+Reads 与本任务改动重叠的已完成任务」才会重放 Verify；
    只共享祖先不再触发。漏声明的跨 scope 耦合只能由汇点全量测试兜底。仓库内相对路径，不许 `..`。
  - Review：strict / standard / mechanical；机械任务可标记 mechanical，其余行为任务默认由 ceshi 先写 Red 测试，再由不同 Agent 实现。
  - Verify with：非汇点必须点名本任务 Write scope 内的测试/spec 路径；
    全量套件只允许一个汇点任务运行。需要环境变量就写全调用：
    PYTHONPATH=runtime python3 -m pytest tests/x_test.py
    带路径即为窄跑（`pytest tests/x_test.py`、`pnpm test src/a.test.ts`、`go test ./pkg/a`）；
    不带路径的 `pytest`、`npm test`、`go test ./...` 判为全量，只能出现在唯一汇点。
  - Scenarios：本任务承载的 spec 场景编号（SCEN-*）。编号必须在本 change 的 spec 里声明过，
    且每个声明的编号至少被一个任务认领 —— 由 freeze-check 双向核对。
  - Done 行：任务完成后在元数据下加一行 `- Done: source=<7 位 hex> review=<tag>`。
    tag 为 `pass(<reviewer>@<tip7>/<base7>)` 或 `pass(mechanical@<tip7>/<base7>)`。
-->

## 2. <任务组名>

- [ ] 2.1 T-02 <一句话目标>
  - Depends on: T-01
  - Write scope: path/to/a.mjs, path/to/a.test.mjs
  - Review: standard
  - Verify with: node --test path/to/a.test.mjs
  - Scenarios: SCEN-CAP-02
