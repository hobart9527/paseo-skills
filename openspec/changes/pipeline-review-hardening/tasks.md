# Tasks

<!--
  本 change 的编写顺序即执行顺序：T-01 改的是另外三个任务的判据来源（parser），
  所以它必须先合流；T-02/T-03 各自独立；T-04 只动运行账本与文档。
-->

## 1. 解析器：注释与 shell 结构

- [ ] 1.1 T-01 行内 HTML 注释只剥区间，`Verify with` 只剥引号包裹
  - Depends on: none
  - Write scope: skills/paseo-pipeline/lib/tasks.mjs, skills/paseo-pipeline/test/tasks.test.mjs
  - Risk-surface: [error-handling]
  - Review: standard
  - Verify with: `node --test skills/paseo-pipeline/test/tasks.test.mjs`
  - Scenarios: SCEN-CON-01, SCEN-CON-02, SCEN-CON-03, SCEN-CON-15, SCEN-CON-16

## 2. 收尾对账与冻结诊断

- [ ] 2.1 T-02 `contract-check` 支持基线并入与 phantom 预算，场景通道认 shell 用例
  - Depends on: T-01
  - Write scope: skills/paseo-pipeline/contract-check.mjs, skills/paseo-pipeline/contract-check.test.sh
  - Risk-surface: [error-handling]
  - Review: standard
  - Verify with: `bash skills/paseo-pipeline/contract-check.test.sh`
  - Scenarios: SCEN-CON-19, SCEN-CON-20, SCEN-CON-21, SCEN-CON-24

- [ ] 2.2 T-03 归档 change 只出只读诊断，冻结预检认基线继承场景
  - Depends on: T-01
  - Write scope: skills/paseo-pipeline/freeze-check.mjs, skills/paseo-pipeline/test/freeze-check.test.mjs
  - Risk-surface: [none]
  - Review: standard
  - Verify with: `node --test skills/paseo-pipeline/test/freeze-check.test.mjs`
  - Scenarios: SCEN-CON-04, SCEN-CON-05, SCEN-CON-17, SCEN-CON-25

## 3. 运行账本与文档守护

- [ ] 3.1 T-04 报告不输出恒定占位字段，Skill 版本采集失败可见，schema 双副本漂移有守护
  - Depends on: none
  - Write scope: skills/paseo-pipeline/run-state.mjs, skills/paseo-pipeline/lib/evidence-contract.mjs, skills/paseo-pipeline/test/run-state.test.mjs, skills/paseo-pipeline/test/docs.test.mjs, skills/paseo-pipeline/SKILL.md
  - Risk-surface: [public-api]
  - Review: standard
  - Verify with: `node --test skills/paseo-pipeline/test/run-state.test.mjs skills/paseo-pipeline/test/docs.test.mjs`
  - Scenarios: SCEN-CON-11, SCEN-CON-18, SCEN-CON-22, SCEN-CON-23
