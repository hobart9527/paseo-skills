# Tasks: pipeline-native-closure

模式：中型 DAG，cap=3。所有路径相对仓库根；测试位于 `skills/paseo-pipeline/test/`。

## 1. 基础与机械脚本

- [x] 1.1 T-01 共享 tasks.md 解析、图校验与 Done 行解析库
  - Depends on: none
  - Write scope: skills/paseo-pipeline/lib/tasks.mjs, skills/paseo-pipeline/test/tasks.test.mjs
  - Risk-surface: [error-handling]
  - Review: strict
  - Verify with: node --test skills/paseo-pipeline/test/tasks.test.mjs
  - Scenarios: SCEN-REC-01, SCEN-REC-02
  - Done: source=4f1e39b review=pass(fc4f8926@4f1e39b/8043d33)

- [x] 1.2 T-02 reconcile 重写（角色识别、attempt/phase/disposition、DAG 释放、Done first-parent 验证、资源冲突、fail-closed）
  - Done: source=fe4240f review=pass(dfa79d7b@fe4240f/fe0a598)
  - Depends on: T-01
  - Write scope: skills/paseo-pipeline/reconcile.mjs, skills/paseo-pipeline/test/reconcile.test.mjs
  - Risk-surface: [error-handling, concurrency]
  - Review: strict
  - Verify with: node --test skills/paseo-pipeline/test/reconcile.test.mjs
  - Scenarios: SCEN-REC-03, SCEN-REC-04, SCEN-REC-05, SCEN-REC-06, SCEN-REC-07, SCEN-REC-08, SCEN-REC-09, SCEN-REC-10, SCEN-REC-11, SCEN-REC-12, SCEN-REC-13, SCEN-REC-14, SCEN-DAG-01, SCEN-DAG-02, SCEN-DAG-03, SCEN-DAG-04, SCEN-DAG-05, SCEN-DAG-06

- [x] 1.3 T-03 merge-task 安全合流（review-tag 漂移检查、trailers、Done source 表示）
  - Depends on: T-01
  - Write scope: skills/paseo-pipeline/merge-task.mjs, skills/paseo-pipeline/merge-task.sh, skills/paseo-pipeline/test/merge-task.test.mjs
  - Risk-surface: [error-handling, persistence]
  - Review: strict
  - Verify with: node --test skills/paseo-pipeline/test/merge-task.test.mjs
  - Scenarios: SCEN-MRG-01, SCEN-MRG-02, SCEN-MRG-03, SCEN-MRG-04, SCEN-MRG-05, SCEN-MRG-06, SCEN-MRG-07, SCEN-MRG-08, SCEN-MRG-09, SCEN-MRG-10
  - Done: source=6537e37 review=pass(8e64cf21@6537e37/c9c3568)

- [x] 1.4 T-04 dispatch.mjs / hotfix.sh legacy 化并保留 pi 与可选字段意图
  - Depends on: none
  - Write scope: skills/paseo-pipeline/dispatch.mjs, skills/paseo-pipeline/hotfix.sh, skills/paseo-pipeline/test/dispatch.test.mjs
  - Risk-surface: [error-handling]
  - Review: strict
  - Verify with: node --test skills/paseo-pipeline/test/dispatch.test.mjs
  - Scenarios: SCEN-DISP-02, SCEN-DISP-03
  - Done: source=9822b30 review=pass(469cf60d@9822b30/7823523)

- [x] 1.5 T-05 contract-check 措辞核对（静态引用≠行为覆盖），既有测试保持通过（Verify 的 contract-check.test.sh 为既存测试，只读消费，不在写范围）
  - Depends on: none
  - Write scope: skills/paseo-pipeline/contract-check.mjs
  - Risk-surface: [none]
  - Verify with: bash skills/paseo-pipeline/contract-check.test.sh
  - Scenarios: SCEN-VER-01
  - Done: source=595f9bf review=pass(5655b44a@595f9bf/7ff5bbb)

## 2. 文档与验证

- [x] 2.1 T-06 SKILL.md 与 LESSONS.md 一致性改写（原生派发、DAG、合流、事件驱动限制、信封/重复/过期/权限/重试/保留）
  - Done: source=98c3388 review=pass(fc4f8926@98c3388/528c691)
  - Depends on: T-02, T-03, T-04
  - Write scope: skills/paseo-pipeline/SKILL.md, skills/paseo-pipeline/LESSONS.md, skills/paseo-pipeline/test/docs.test.mjs
  - Risk-surface: [public-api]
  - Verify with: node --test skills/paseo-pipeline/test/docs.test.mjs
  - Scenarios: SCEN-DISP-01, SCEN-EVT-01, SCEN-EVT-02, SCEN-DOC-01, SCEN-DOC-02

- [x] 2.2 T-07 run-all 入口与证据结构化校验器（check-evidence.mjs）
  - Done: source=f666330 review=pass(fc4f8926@f666330/e0ddeef)
  - Depends on: T-01, T-02, T-03, T-04, T-05, T-06
  - Write scope: skills/paseo-pipeline/test/run-all.sh, skills/paseo-pipeline/test/check-evidence.mjs, skills/paseo-pipeline/test/check-evidence.test.mjs
  - Risk-surface: [none]
  - Verify with: bash skills/paseo-pipeline/test/run-all.sh
  - Scenarios: SCEN-VER-01, SCEN-VER-02, SCEN-VER-03

- [ ] 2.3 T-08 原生 MCP 回调冒烟（真实 create_agent+notifyOnFinish，含 grandchild→Lead→parent 显式接力案例，独立于 mock）
  - Depends on: T-06, T-07
  - Write scope: openspec/changes/pipeline-native-closure/evidence/native-smoke.md
  - Risk-surface: [none]
  - Verify with: node skills/paseo-pipeline/test/check-evidence.mjs openspec/changes/pipeline-native-closure/evidence/native-smoke.md
  - Scenarios: SCEN-VER-02

- [ ] 2.4 T-09 终审：Auditor 对 `main...integration/pipeline-native-closure` 整体 diff 审计并留证
  - Depends on: T-06, T-07, T-08
  - Write scope: openspec/changes/pipeline-native-closure/evidence/final-audit.md
  - Risk-surface: [none]
  - Verify with: node skills/paseo-pipeline/test/check-evidence.mjs --kind audit openspec/changes/pipeline-native-closure/evidence/final-audit.md
  - Scenarios: SCEN-VER-03
