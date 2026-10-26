# Tasks

## 1. 证据闸门：命令字段整值判据

- [ ] 1.1 T-011 `test/check-evidence.mjs` 新增 `BARE_PLACEHOLDER_RE` 与 `COMMAND_FIELD_RE`，命令型字段只拒整值占位
  - Depends on: none
  - Write scope: skills/paseo-pipeline/test/check-evidence.mjs
  - Risk-surface: [none]
  - Review: mechanical
  - Verify with: `node --test skills/paseo-pipeline/test/check-evidence.test.mjs`
  - Scenarios: SCEN-VER-04

- [ ] 1.2 T-012 新增 `SCEN-EVD-03` 回归：5 条真实命令放行、4 种整值占位仍拦、非命令字段子串判据不变
  - Depends on: T-011
  - Write scope: skills/paseo-pipeline/test/check-evidence.test.mjs
  - Risk-surface: [none]
  - Review: mechanical
  - Verify with: `node --test skills/paseo-pipeline/test/check-evidence.test.mjs`
  - Scenarios: SCEN-VER-04

## 2. 契约闸门：三条收窄

- [ ] 2.1 T-021 `contract-check.mjs` 新增 `isPredicateSpec` / `messageWindows`，谓词窗口不进消息通道
  - Depends on: none
  - Write scope: skills/paseo-pipeline/contract-check.mjs
  - Risk-surface: [error-handling]
  - Review: standard
  - Verify with: `bash skills/paseo-pipeline/contract-check.test.sh`
  - Scenarios: SCEN-VER-06

- [ ] 2.2 T-022 删除全局 `message:` 与全局 `new XError(STR)` 提取，断言窗口内同类形态仍覆盖
  - Depends on: T-021
  - Write scope: skills/paseo-pipeline/contract-check.mjs
  - Risk-surface: [error-handling]
  - Review: standard
  - Verify with: `bash skills/paseo-pipeline/contract-check.test.sh`
  - Scenarios: SCEN-VER-07

- [ ] 2.3 T-023 方言不匹配（spec 谈错误但无 `Error("…")`）时消息通道报 N/A 并放行，场景通道仍双向对账；N/A 时不打印逐条「测试断言但 spec 未声明」
  - Depends on: T-022
  - Write scope: skills/paseo-pipeline/contract-check.mjs
  - Risk-surface: [error-handling]
  - Review: standard
  - Verify with: `bash skills/paseo-pipeline/contract-check.test.sh`
  - Scenarios: SCEN-VER-05

- [ ] 2.4 T-024 补 `R20`–`R23` 回归用例，并把 `R7` 期望改为 0（N/A 语义）。采集：`通过 23 / 失败 0`
  - Depends on: T-023
  - Write scope: skills/paseo-pipeline/contract-check.test.sh
  - Risk-surface: [none]
  - Review: mechanical
  - Verify with: `bash skills/paseo-pipeline/contract-check.test.sh`
  - Scenarios: SCEN-VER-05, SCEN-VER-06, SCEN-VER-07

- [ ] 2.5 T-025 负向对照：旧 `contract-check.mjs` 对本轮 4 条新用例全部转红（`通过 19 / 失败 4`），确认用例依赖改动
  - Depends on: T-024
  - Write scope: skills/paseo-pipeline/contract-check.mjs
  - Risk-surface: [none]
  - Review: mechanical
  - Verify with: `bash skills/paseo-pipeline/contract-check.test.sh`
  - Scenarios: SCEN-VER-05, SCEN-VER-06

## 3. 删除零使用残留物

- [ ] 3.1 T-031 从 `test/dispatch.test.mjs` 抽出 `hotfix.sh` 用例到 `test/hotfix.test.mjs`（17 条），验证全绿后再删旧文件
  - Depends on: none
  - Write scope: skills/paseo-pipeline/test/hotfix.test.mjs, skills/paseo-pipeline/test/dispatch.test.mjs
  - Risk-surface: [none]
  - Review: mechanical
  - Verify with: `node --test skills/paseo-pipeline/test/hotfix.test.mjs`
  - Scenarios: SCEN-DISP-02, SCEN-DISP-03

- [ ] 3.2 T-032 删除 `skills/paseo-pipeline/dispatch.mjs` 与 `test/dispatch.test.mjs`，`test/run-all.sh` 改指向 `hotfix.test.mjs`
  - Depends on: T-031
  - Write scope: skills/paseo-pipeline/dispatch.mjs, skills/paseo-pipeline/test/dispatch.test.mjs, skills/paseo-pipeline/test/run-all.sh
  - Risk-surface: [irreversible]
  - Review: standard
  - Verify with: `bash skills/paseo-pipeline/test/run-all.sh`
  - Scenarios: SCEN-DISP-04

- [ ] 3.3 T-033 删除 `run-state.mjs heartbeat` 子命令与 `lib/run-state.mjs` 的 `heartbeatStatus`；`heartbeats` 字段保留只读兼容
  - Depends on: none
  - Write scope: skills/paseo-pipeline/run-state.mjs, skills/paseo-pipeline/lib/run-state.mjs
  - Risk-surface: [irreversible]
  - Review: standard
  - Verify with: `node --test skills/paseo-pipeline/test/run-state.test.mjs`
  - Scenarios: SCEN-EVT-04

- [ ] 3.4 T-034 `test/run-state.test.mjs` 把 heartbeat 生命周期用例改为「子命令已删除」断言
  - Depends on: T-033
  - Write scope: skills/paseo-pipeline/test/run-state.test.mjs
  - Risk-surface: [none]
  - Review: mechanical
  - Verify with: `node --test skills/paseo-pipeline/test/run-state.test.mjs`
  - Scenarios: SCEN-EVT-04

## 4. 文档与冻结点规则

- [ ] 4.1 T-041 `SKILL.md` 删除 `dispatch.mjs` 段落、账本 heartbeat 命令与生命周期说明，补「无 heartbeat 子命令」与删除理由
  - Depends on: T-032, T-033
  - Write scope: skills/paseo-pipeline/SKILL.md
  - Risk-surface: [none]
  - Review: standard
  - Verify with: `node --test skills/paseo-pipeline/test/docs.test.mjs`
  - Scenarios: SCEN-DISP-04, SCEN-EVT-04

- [ ] 4.2 T-042 `SKILL.md` §2.1 新增第 5 条「spec 撰写规则」五条，并写明由 Auditor 核、不写成脚本
  - Depends on: T-041
  - Write scope: skills/paseo-pipeline/SKILL.md
  - Risk-surface: [none]
  - Review: standard
  - Verify with: `node --test skills/paseo-pipeline/test/docs.test.mjs`
  - Scenarios: SCEN-VER-08

- [ ] 4.3 T-043 `templates/lead.md` 补两条派发纪律（`respond_to_permission` 代批不可行且越权、brief 事实由命令输出生成）与「冻结/确认点 2 分叉核对」段
  - Depends on: none
  - Write scope: skills/paseo-pipeline/templates/lead.md
  - Risk-surface: [none]
  - Review: standard
  - Verify with: `node --test skills/paseo-pipeline/test/docs.test.mjs`
  - Scenarios: SCEN-EVT-05, SCEN-VER-08

- [ ] 4.4 T-044 `LESSONS.md` 新增 §12「门禁分级」含采集值与三条可复用判据；§11 的第 3 条标注 `dispatch.mjs` 已删除
  - Depends on: T-032
  - Write scope: skills/paseo-pipeline/LESSONS.md
  - Risk-surface: [none]
  - Review: mechanical
  - Verify with: `node --test skills/paseo-pipeline/test/docs.test.mjs`
  - Scenarios: SCEN-VER-08

- [ ] 4.5 T-045 `test/docs.test.mjs` 新增 `SCEN-DOC-19`（五条撰写规则齐备）与 `SCEN-DOC-20`（Lead 模板分叉核对与 brief 事实约束）；`SCEN-DOC-05` 改为断言 heartbeat 入口已删
  - Depends on: T-041, T-042, T-043
  - Write scope: skills/paseo-pipeline/test/docs.test.mjs
  - Risk-surface: [none]
  - Review: mechanical
  - Verify with: `node --test skills/paseo-pipeline/test/docs.test.mjs`
  - Scenarios: SCEN-VER-08, SCEN-EVT-05, SCEN-EVT-04

## 5. 验证

- [ ] 5.1 T-051 全量回归 `bash skills/paseo-pipeline/test/run-all.sh`。采集：Node `tests 411 / pass 411 / fail 0 / duration_ms 129788.450708`；`contract-check.test.sh` `通过 23 / 失败 0`
  - Depends on: T-045
  - Write scope: skills/paseo-pipeline/test/run-all.sh
  - Risk-surface: [none]
  - Review: mechanical
  - Verify with: `bash skills/paseo-pipeline/test/run-all.sh`
  - Scenarios: SCEN-VER-01

- [ ] 5.2 T-052 真实账本复验（approval-hub `hardening-governance-contracts`）：`check-evidence --gate acceptance --kind audit --sha 7cf3471…` rc=1 → **rc=0**；`contract-check <specs> --tasks tasks.md` undeclared 11 → 1，消息通道打印 N/A
  - Depends on: T-051
  - Write scope: skills/paseo-pipeline/contract-check.mjs
  - Risk-surface: [none]
  - Review: mechanical
  - Verify with: `bash skills/paseo-pipeline/contract-check.test.sh`
  - Scenarios: SCEN-VER-05, SCEN-VER-07

- [ ] 5.3 T-053 `openspec validate pipeline-gate-slimming --strict` 通过
  - Depends on: T-052
  - Write scope: openspec/changes/pipeline-gate-slimming/
  - Risk-surface: [none]
  - Review: mechanical
  - Verify with: `openspec validate pipeline-gate-slimming --strict`
  - Scenarios: SCEN-VER-08
