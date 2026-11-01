# Tasks

<!--
  编写顺序即执行顺序：P0 先行（T-01..T-04 互相独立可并发），P1 依赖各自判据源，
  T-09..T-11 是文档与机械清理，T-12 收尾全量验证。
  scope 冲突注意：T-01/T-05/T-06/T-07/T-08 都动 task-runner.mjs —— Write scope 重叠，
  由编排串行（前缀重叠保守串行），T-02/T-03/T-04 可与它们并行。
-->

## 1. P0：死锁与承诺-实现相反

- [x] 1.1 T-01 交接序列与门禁判据统一：handoff-check 在集成分支存在后执行，分支判据分语境
  - Done: source=1dc5d75 review=pass(5b49c368@1dc5d75/29ce2ec)
  - Depends on: none
  - Write scope: skills/paseo-pipeline/lib/handoff.mjs, skills/paseo-pipeline/handoff-check.mjs, skills/paseo-pipeline/SKILL.md, skills/paseo-pipeline/test/handoff-check.test.mjs, skills/paseo-pipeline/test/docs.test.mjs
  - Risk-surface: [error-handling]
  - Review: standard
  - Verify with: `node --test skills/paseo-pipeline/test/handoff-check.test.mjs skills/paseo-pipeline/test/docs.test.mjs`
  - Scenarios: SCEN-HND-02, SCEN-HND-09, SCEN-HND-10

- [x] 1.2 T-02 账本损坏 refuse-to-write：解析失败保留现场，updateRunState 拒绝覆盖
  - Done: source=a249b46 review=pass(a111f4e8@a249b46/29ce2ec)
  - Depends on: none
  - Write scope: skills/paseo-pipeline/lib/run-state.mjs, skills/paseo-pipeline/test/run-state.test.mjs
  - Risk-surface: [persistence]
  - Review: standard
  - Verify with: `node --test skills/paseo-pipeline/test/run-state.test.mjs`
  - Scenarios: SCEN-LED-01, SCEN-LED-02, SCEN-LED-03

- [x] 1.3 T-03 reconcile 冻结范围化：open intent 只压住点名任务，孤儿意图保持全局仲裁
  - Done: source=e24e170 review=pass(08dee51e@e24e170/29ce2ec)
  - Depends on: none
  - Write scope: skills/paseo-pipeline/reconcile.mjs, skills/paseo-pipeline/test/reconcile.test.mjs
  - Risk-surface: [error-handling]
  - Review: standard
  - Verify with: `node --test skills/paseo-pipeline/test/reconcile.test.mjs`
  - Scenarios: SCEN-REC-15, SCEN-REC-16

- [x] 1.4 T-04 信封字段文档订正：7→8（含 kind），测试断言与 ENVELOPE_REQUIRED_FIELDS 单源绑定
  - Done: source=bd7a63d review=pass(mechanical@bd7a63d/0a396c8)
  - Depends on: none
  - Write scope: skills/paseo-pipeline/SKILL.md, skills/paseo-pipeline/test/docs.test.mjs
  - Risk-surface: [none]
  - Review: mechanical
  - Verify with: `node --test skills/paseo-pipeline/test/docs.test.mjs`
  - Scenarios: SCEN-DOC-03

## 2. P1：断裂与阻塞

- [x] 2.1 T-05 --review-tag 重入补租约校验：与 claim 同判据，非 owner 拒绝合流
  - Done: source=9328c1c review=pass(c77e1263@9328c1c/e7105f1)
  - Depends on: none
  - Write scope: skills/paseo-pipeline/task-runner.mjs, skills/paseo-pipeline/test/task-runner.test.mjs
  - Risk-surface: [error-handling]
  - Review: standard
  - Verify with: `node --test skills/paseo-pipeline/test/task-runner.test.mjs`
  - Scenarios: SCEN-HND-11

- [ ] 2.2 T-06 无 Verify 任务硬失败：task-runner 删 npm test 兜底，对齐 exit 36 语义
  - Depends on: none
  - Write scope: skills/paseo-pipeline/task-runner.mjs, skills/paseo-pipeline/test/task-runner.test.mjs
  - Risk-surface: [error-handling]
  - Review: standard
  - Verify with: `node --test skills/paseo-pipeline/test/task-runner.test.mjs`
  - Scenarios: SCEN-HND-12

- [x] 2.3 T-07 缺省档位合流 fail closed：merge-task 读 requiredReview，未定即拒
  - Done: source=39e5d36 review=pass(8b370984@39e5d36/0a396c8)
  - Depends on: none
  - Write scope: skills/paseo-pipeline/merge-task.mjs, skills/paseo-pipeline/lib/tasks.mjs, skills/paseo-pipeline/test/merge-task.test.mjs
  - Risk-surface: [error-handling]
  - Review: standard
  - Verify with: `node --test skills/paseo-pipeline/test/merge-task.test.mjs`
  - Scenarios: SCEN-MRG-11

- [ ] 2.4 T-08 tier-gate 文档化与 doctor 校验：SKILL §8 补判据与开关，doctor 查两 hook
  - Depends on: none
  - Write scope: skills/paseo-pipeline/SKILL.md, skills/paseo-pipeline/pipeline-doctor.mjs, skills/paseo-pipeline/test/pipeline-doctor.test.mjs, skills/paseo-pipeline/test/docs.test.mjs
  - Risk-surface: [none]
  - Review: standard
  - Verify with: `node --test skills/paseo-pipeline/test/pipeline-doctor.test.mjs skills/paseo-pipeline/test/docs.test.mjs`
  - Scenarios: SCEN-DOC-04

- [ ] 2.5 T-09 wait 终态与重入口径：error 入终态集，exit 51 文案给续等指引
  - Depends on: none
  - Write scope: skills/paseo-pipeline/task-runner.mjs, skills/paseo-pipeline/test/task-runner.test.mjs
  - Risk-surface: [error-handling]
  - Review: standard
  - Verify with: `node --test skills/paseo-pipeline/test/task-runner.test.mjs`
  - Scenarios: SCEN-HND-07, SCEN-HND-13, SCEN-HND-14

## 3. P2：摩擦与文档债

- [ ] 3.1 T-10 锁恢复入口手册化：--break-lock 写进 SKILL 与 usage，stale 判定并入 pid
  - Depends on: none
  - Write scope: skills/paseo-pipeline/lib/lock.mjs, skills/paseo-pipeline/run-state.mjs, skills/paseo-pipeline/SKILL.md, skills/paseo-pipeline/test/lock.test.mjs
  - Risk-surface: [concurrency]
  - Review: standard
  - Verify with: `node --test skills/paseo-pipeline/test/lock.test.mjs`
  - Scenarios: SCEN-LED-04

- [ ] 3.2 T-11 陈旧引用与文档收敛：spec.md 删已删变量表述，sdd 文档加降级头注，SKILL 去重瘦身
  - Depends on: T-01, T-04, T-08, T-10
  - Write scope: docs/sdd-multi-agent-architecture.md, openspec/specs/pipeline-delivery/spec.md, skills/paseo-pipeline/SKILL.md, skills/paseo-pipeline/LESSONS.md, skills/paseo-pipeline/test/docs.test.mjs
  - Risk-surface: [none]
  - Review: standard
  - Verify with: `node --test skills/paseo-pipeline/test/docs.test.mjs`
  - Scenarios: SCEN-DOC-05

## 4. 收尾

- [x] 4.1 T-13 corrupt 信号消费端接线：scope-guard 拒绝降级，reconcile 输出 corruption 行
  - Done: source=9323999 review=pass(c2d7aabc@9323999/6551b72)
  - Depends on: T-02
  - Write scope: skills/paseo-pipeline/lib/scope-guard.mjs, skills/paseo-pipeline/reconcile.mjs, skills/paseo-pipeline/hooks/scope-guard-hook.mjs, skills/paseo-pipeline/test/guard-scope.test.mjs, skills/paseo-pipeline/test/reconcile.test.mjs
  - Risk-surface: [error-handling]
  - Review: standard
  - Verify with: `node --test skills/paseo-pipeline/test/guard-scope.test.mjs skills/paseo-pipeline/test/reconcile.test.mjs`
  - Scenarios: SCEN-LED-02, SCEN-LED-03

- [ ] 4.2 T-12 全量验证与验收回填
  - Depends on: T-01, T-02, T-03, T-04, T-05, T-06, T-07, T-08, T-09, T-10, T-11, T-13
  - Write scope: skills/paseo-pipeline/test/run-all.sh, openspec/changes/pipeline-self-audit-remediation/acceptance.md
  - Risk-surface: [none]
  - Review: mechanical
  - Verify with: `bash skills/paseo-pipeline/test/run-all.sh`
  - Scenarios: SCEN-VER-01
