## Why

2026-10-26 的复核结论是：pipeline 的损耗不在脚本算错，而在**契约的写、检、读三处各说一套**。实测证据有四条：

- `pipeline-gate-slimming` 的 19 条 Done 行全写 `review=main-session`，而解析器只检查「非空」——账本看起来条条经审查，实际没有一条经过合流门禁。
- 证据的 8 个 smoke 必填字段里 4 个在 SKILL.md 中命中 0 次，且没有任何模板；写证据的人只能靠猜，猜错要等到收尾才发现收据不合格。
- 同一个 tasks.md 有四种错误判法（reconcile 只认 5 个码、contract-check 只认 2 个、merge-task 全拒、hotfix 单独放过 `MISSING_SCOPE`），方向两头都错：无关任务的漏写 scope 会挡住整批合流，hotfix 的放行没有任何记录在案的理由。
- OpenSpec 上游的 tasks 模板示范 `- [ ] 1.1 描述`，pipeline 的解析器要求 `T-xx` + 元数据子字段：照模板写能过 `validate --strict`，却让编排器解析出 0 个任务。

这些缺陷的共同形态是**三环缺一环**：生产端没有模板、冻结时没有机械检查、运行时没有读取方。缺任何一环，缺陷都顺流到下游才暴露，代价是整轮返工而不是一次报错。

## What Changes

- **任务契约的单一属主**（`lib/tasks.mjs`）：新增 `ERROR_SCOPE` 按破坏范围定义错误严重度（graph / task），新增 `IDENTITY_CODES` 正交窄轴；`REVIEW_TAG` 从 `merge-task.mjs` 上移，Done 行的 review 值必须匹配它；解析器跳过 HTML 注释，未知字段报 `UNKNOWN_FIELD` 而不是静默忽略。
- **调用者只能收紧不能放宽**：`merge-task.mjs` 只拒 graph 级错误 + 被合流任务（及其依赖）的 task 级错误；`check-evidence.mjs` 新增 `--matrix`，从冻结的验收矩阵读 `Required: yes` 行，`--require-scenario` 只能追加。
- **证据契约的唯一定义点**（`lib/evidence-contract.mjs`）：字段清单从 `check-evidence.mjs` 的校验函数里抽出，模板、闸门、文档测试三处引用同一份。占位值判据收窄到「闸门拥有的字段」，`notes:` 这类人话不再决定收据存亡。
- **冻结成为一条命令**（`freeze-check.mjs`）：复用生产解析器，一次核完任务行/ID/依赖图/scope、场景编号双向闭环、验收矩阵的列与引用、Pod 成员；跨 change 写范围重叠只出 `HINT`。
- **项目内 OpenSpec schema**（`openspec-schema/`）：OpenSpec 1.8.0 `spec-driven` 的整份副本，只改 tasks/specs 指令并新增 `acceptance` 产物——让模板本身对，而不是靠 config 追加一段文字纠正模板。
- **运行账本补三处语义**（`run-state.mjs`）：`fail` 不得作废已有真实回执的意图（否则同一幂等键可以重派一个活着的 agent）；新增 `report` 只从账本已记下的事实推导度量，采不到的项写「未采集」；`begin` 记录 Skill 的 git HEAD，`status` 发现漂移只警告不拦。
- **文档与代码逐项对齐**：`qingqibing` 退出派发路径与文档（`lib/roles.mjs` 仅保留它识别历史标签）；`hotfix.sh` 的 profile 解析改为对 `agent_profile_gongbu` fail-closed；`templates/` 增至五份，新增 `arbiter` 与两份证据模板；SKILL §2.3 与 §4 给出可照抄执行的命令块。

**范围说明**：本 change 的实现已经在工作树里、尚未提交。产物在这里锁的是**契约与验收口径**，合流走确认点 2，不由本 change 自行宣布完成。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `pipeline-delivery`：任务契约增加单一属主的错误严重度与 review 标签语法；冻结阶段新增一条机械预检命令与项目内 schema；证据闸门新增矩阵驱动的必需场景与真实 agent 核对；运行账本新增「作废不得抹掉回执」、只报采集值的 `report` 与 Skill 版本留痕。

## Impact

- 代码：`lib/tasks.mjs`、`lib/evidence-contract.mjs`（新）、`lib/run-state.mjs`、`lib/roles.mjs`、`lib/paseo-state.mjs`、`freeze-check.mjs`（新）、`merge-task.mjs`、`reconcile.mjs`、`contract-check.mjs`、`run-state.mjs`、`hotfix.sh`、`test/check-evidence.mjs`。
- 模板与 schema：`templates/arbiter.md`、`templates/evidence-{smoke,audit}.md`（新）、`openspec-schema/`（新）、`openspec/schemas/paseo-pipeline/`（安装产物）。
- 文档：`SKILL.md`、`LESSONS.md`。
- 测试：`test/{tasks,check-evidence,run-state,docs,freeze-check,merge-task,hotfix}.test.mjs`、`contract-check.test.sh`。全量 `bash skills/paseo-pipeline/test/run-all.sh` 实测 433 通过 / 0 失败。
- 兼容性：`run-state.json` 旧文件仍可读（`skill` 字段缺失时 `status` 输出「未采集」）；存量 tasks.md 的 `review=main-session` 会被判 `BAD_DONE_LINE`，这是有意的——它们从未经过合流门禁。
