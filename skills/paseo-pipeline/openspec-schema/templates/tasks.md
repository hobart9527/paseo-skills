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
  - Est: M
  - Review: strict
  - Verify with: node --test path/to/file.test.mjs
  - Scenarios: SCEN-CAP-01

<!--
  字段规则（解析器强制执行，写错就是 MALFORMED_LINE / MISSING_SCOPE / UNKNOWN_* 报错）：

  - 任务行：`- [ ] <序号> <ID> <标题>`。ID 形如 `<字母>-<数字>`（T-01、TASK-3）。
    `- [ ] 1.1 标题` 没有 ID 会被判 MALFORMED_LINE；`T-01:标题` 冒号紧贴 ID 同样不合法。
  - Write scope：必填非空，仓库根内相对路径，逗号分隔；不许绝对路径、不许 `..` 逃出根。
  - Depends on：必须引用本文件里存在的任务 ID；不许自依赖、不许成环。无依赖写 none。
  - Review：strict / standard / mechanical / deferred。`mechanical` 可跳过测试与任务审查；
    `deferred` 只允许非汇点的标准任务，表示审查并入最后一次 FINAL 集成审查（不逐任务审）。
  - Verify with：非汇点必须点名本任务 Write scope 或 Reads 内的测试/spec 路径；
    全量套件只允许一个汇点任务运行。需要环境变量就写全调用：
    PYTHONPATH=runtime python3 -m pytest tests/x_test.py
    带路径即为窄跑（`pytest tests/x_test.py`、`pnpm test src/a.test.ts`、`go test ./pkg/a`）；
    不带路径的 `pytest`、`npm test`、`go test ./...` 判为全量，只能出现在唯一汇点。
  - Scenarios：本任务承载的 spec 场景编号（SCEN-*）。编号必须在本 change 的 spec 里声明过，
    且每个声明的编号至少被一个任务认领 —— 由 freeze-check 双向核对。
  - 可选调度字段（全部参与 freeze-check，写错分别报 BAD_READS / BAD_EST / BAD_INTERFACE / BAD_KIND）：
    - `Uses: T-03, T-05` — 消费边。派发只等目标的接口（含其 skeleton 祖先），不等实现合流；
      merge 仍要求目标 Done。目标必须声明 `Interface:`，且若两者 Write scope 重叠则还必须有 `Depends on`。
    - `Reads: path/a, path/b` — 只读锚点：Verify 可以跑这些路径，但它们不算 Write scope，
      不参与 scope 冲突，也不授权改源码。
    - `Est: S|M|L` — 工期权重，缺省 M。
    - `Kind: skeleton` — 接口桩任务，必须有 `Review: mechanical`，其 Write scope 必须覆盖
      所有 `Interface:` 路径。
    - `Interface: path/to/file.ts#symbol` — 本任务向 `Uses` 消费者提供的路径/符号；可逗号分隔或重复多行。
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
