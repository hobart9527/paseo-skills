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
  - Review：strict / standard / mechanical / deferred，缺省 standard；这些标签不选择逐任务
    审查流程。每个任务由一个 worker 完成，独立 FINAL 集成审查覆盖所有任务。兼容规则禁止汇点
    或声明 persistence/security Risk-surface 的任务使用 deferred。建议将实际存在的持久化或
    安全风险标为 strict；freeze-check 不强制所有此类任务为 strict，也不验证风险标签是否完整。
    mechanical 不代表安全，也不免除语义审查。
  - Verify with：非汇点必须点名本任务 Write scope 或 Reads 内的测试/spec 路径；
    全量套件只允许一个汇点任务运行。需要环境变量就写全调用：
    PYTHONPATH=runtime python3 -m pytest tests/x_test.py
    带路径即为窄跑（`pytest tests/x_test.py`、`pnpm test src/a.test.ts`、`go test ./pkg/a`）；
    不带路径的 `pytest`、`npm test`、`go test ./...` 判为全量，只能出现在汇点。
    freeze-check 对非汇点的 mechanical 任务也要求窄 Verify；mechanical 汇点可以使用非测试检查，
    但其他命令规则仍适用。脚本检查只证明其实际覆盖的属性，不能代替行为证据。
  - Scenarios：本任务承载的 spec 场景编号（SCEN-*）。编号必须在本 change 的 spec 里声明过，
    且每个声明的编号至少被一个任务认领 —— 由 freeze-check 双向核对。mechanical 任务可不认领
    场景，也可只写测试路径；这些结构豁免不证明任务没有行为风险。
  - 可选调度字段（全部参与 freeze-check，写错分别报 BAD_READS / BAD_EST / BAD_INTERFACE / BAD_KIND / BAD_IMPLEMENTS）：
    - `Uses: T-03, T-05` — 消费边。派发等待目标及其依赖链中的 skeleton，不等目标实现合流；
      merge 仍要求目标 Done。目标必须声明 `Interface:`，且若两者 Write scope 重叠则还必须有 `Depends on`。
      Interface 的 skeleton owner 必须是消费者实际派发依赖；scope 只表示所有权，不证明文件或内容已提交。
    - `Reads: path/a, path/b` — 只读锚点：Verify 可以跑这些路径，但它们不算 Write scope，
      不参与 scope 冲突，也不授权改源码。
      worker 完成自身任务后必须能在自己的分支跑通 Verify；首次 Verify 允许 red。若最终 Verify 确需其他任务未来的文件或行为，使用 `Depends on`；merge 重跑不能代替 worker Verify。已有 baseline 文件、自建文件或仅用于回归的 Reads 不应自动加依赖。静态检查不证明文件存在、内容正确、权限可用或已提交。
    - `Est: S|M|L` — 工期权重，缺省 M。
    - `Kind: skeleton` — 接口桩任务，必须有 `Review: mechanical`，其 Write scope 必须覆盖
      所有 `Interface:` 路径。
    - `Interface: path/to/file.ts#symbol` — 本任务向 `Uses` 消费者提供的路径/符号；可逗号分隔或重复多行。
    - `Implements: D-01, D-02` — 本任务落实的 design.md 决策编号。**仅在存在 design.md 时填写**：
      design.md 是可选的，没有 design.md 就没有决策标题，写了 Implements 会被判 UNKNOWN_DECISION。
      design.md 只写决策（`- **D-01 <标题>**`）与影响模块，不写任务 ID；任务在这里反指决策，
      每个编号必须在 design.md 有对应决策标题（freeze-check 核对 DESIGN_NAMES_TASK / UNKNOWN_DECISION）。
  - 可选元数据（`Reads`、`Est`、`Kind`、`Interface`、`Risk-surface`）：仅在影响 Verify、调度、共享接口或风险时填写。
  - Done 行由 merge gate 写入 `- Done: source=<tip7> review=worker`；worker 标记执行，不是审查结论。
    历史 `pass(<reviewer>@<tip>/<base>)` 标签仍可读取，不必改写已冻结内容。
-->

## 2. <任务组名>

- [ ] 2.1 T-02 <一句话目标>
  - Depends on: T-01
  - Write scope: path/to/a.mjs, path/to/a.test.mjs
  - Review: standard
  - Verify with: node --test path/to/a.test.mjs
  - Scenarios: SCEN-CAP-02
