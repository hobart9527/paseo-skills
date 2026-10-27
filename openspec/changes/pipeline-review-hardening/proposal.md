# Proposal: pipeline-review-hardening

## Why

2026-10-27 合入 `pipeline-contract-alignment` 后做的复核走查，实测出四类问题：解析器在「行内 HTML 注释」上静默吞掉整条任务（任务消失 + 写范围错位，零报错）；收尾门禁 `contract-check --final` 在全仓恒为 rc=1（phantom 84 条），使 SKILL 里「收尾必跑」的规定成为一条永远无法满足的要求；归档 change 的只读诊断全部判「不得冻结」（14/30/31/1 项），其中多数是「写的时候规则还不存在」的追溯执法；以及若干零引用的死导出与占位字段。这些都不是新能力缺口，是已交付门禁的可信度缺口——门禁红得没有意义，人就不再读它。

## What Changes

- **解析器：行内注释不再吞任务**。`lib/tasks.mjs` 现在只剥注释区间，保留同行其余内容；跨行注释保留开闭之间的删除语义。
- **解析器：只剥 Markdown 包裹，不改写 shell 结构**。`stripWrappingQuote` 收窄到反引号与单/双引号；`(` `[` `{` 原样保留（旧实现把 `(cd sub && make)` 改写成 `cd sub && make`，破坏子 shell 语义）。
- **收尾对账：新增 `--baseline` 与 `--max-phantom`**。change delta 只声明增量场景，测试语料是 skill 级的；不并基线会把历史场景全判 phantom（2026-10-27 实测：只传 delta 38 条 vs 并入基线 31 条）。`--baseline` 同时把基线场景从 untested 判定里排除——delta 为满足 MODIFIED 的整块替换必须抄回基线场景，抄回来不等于本 change 新增了它们（实测整树口径 51 条 untested vs delta+baseline 0 条）。`--max-phantom` 把存量债记成显式预算：新增一条越界失败，但不让门禁恒定红着。
- **消息通道：`typeof x.message` 的类型名不再算错误契约**。实测 `assert.equal(typeof error.message, 'string')` 被判成 `undeclared: string`。
- **归档 change：只读诊断不再做可冻结判定**。历史记录照实列出为 HINT，退出码 0。
- **死导出与占位字段清理**：`SMOKE_TIMELINE_FIELDS` / `requiredFields` / `CONTRACT_FIELDS` 不再导出；`run-state report` 不再输出两个恒为「未采集」的字段，改为报告末尾一句「本报告不覆盖什么」。
- **Skill 版本采集失败可见**：`begin` 时读不到 git HEAD 会打印一行 WARN，不再静默写入 `skill: null`。
- **schema 双副本漂移守护**：新增测试断言 `openspec-schema/` 与 `openspec/schemas/paseo-pipeline/` 逐字节一致（此前无任何守护）。

**不改**：`merge-task` 的 exit 码语义、Pod 依赖闭包、Done 行语法、审计/冒烟闸门的字段集、角色路由表。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `pipeline-delivery`: 解析容错（行内注释、shell 结构保持）、收尾对账口径（基线并入与存量预算）、归档读取语义、运行账本报告字段集、schema 副本一致性。

## Impact

- 代码：`skills/paseo-pipeline/lib/tasks.mjs`、`contract-check.mjs`、`lib/evidence-contract.mjs`、`freeze-check.mjs`、`run-state.mjs`。
- 文档：`skills/paseo-pipeline/SKILL.md`（§收尾对账、§运行账本）。
- 测试：`test/tasks.test.mjs`、`test/freeze-check.test.mjs`、`test/run-state.test.mjs`、`test/docs.test.mjs`、`contract-check.test.sh`。
- 兼容性：`--max-phantom` 默认 0，未传该参数的既有调用者行为不变（除 phantom 判定现在接受 `--baseline` 并入）；归档 change 的退出码从 1 变为 0——这是有意的，只影响只读诊断。
- 行为变化：`Verify with` 里的 `*.test.sh` 现在被识别为测试文件（此前 `verify.tests` 恒为空，下游退回 Write scope 猜测试）；`contract-check` 的场景通道现在也读 shell 用例表的 `# SCEN-…` 注释行（heredoc 夹具除外）。这两条会让此前"看不见"的场景开始参与对账。
- 不含：phantom 存量债的清偿（31 条测试标题引用了 spec 从未写过的编号）。那是独立的清理工作，本 change 只给它一个可执行的门禁口径。
