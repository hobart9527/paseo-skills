# Tasks

<!--
  顺序即依赖：T-01/T-02 互相独立；T-03 → T-04 → T-05 → T-06 依次改同一族文件，串行。
  T-05 的验收是原 hotfix.test.mjs 全量通过——它证明 task-runner 吸收了 hotfix 的全部已验证行为。
-->

## 1. 机械门禁

- [x] 1.1 T-01 交接门禁：`handoff-check.mjs` 与共享判据 `lib/handoff.mjs`
  - Done: source=fc5df03 review=pass(94d49a23@fc5df03/51d53dc)
  - Depends on: none
  - Write scope: skills/paseo-pipeline/handoff-check.mjs, skills/paseo-pipeline/lib/handoff.mjs, skills/paseo-pipeline/test/handoff-check.test.mjs
  - Risk-surface: [error-handling]
  - Review: standard
  - Verify with: `node --test skills/paseo-pipeline/test/handoff-check.test.mjs`
  - Scenarios: SCEN-HND-01, SCEN-HND-02

- [x] 1.2 T-02 `run-state record` 拒绝把写手意图登记到集成分支
  - Done: source=6c31fb5 review=pass(2eb9abdf@6c31fb5/51d53dc)
  - Depends on: none
  - Write scope: skills/paseo-pipeline/run-state.mjs, skills/paseo-pipeline/test/run-state.test.mjs
  - Risk-surface: [error-handling]
  - Review: standard
  - Verify with: `node --test skills/paseo-pipeline/test/run-state.test.mjs`
  - Scenarios: SCEN-HND-03

## 2. 单一派发入口

- [x] 2.1 T-03 `task-runner` 经 Paseo 任务 workspace 派发：分支、基点、五标签、profile fail-closed、意图记账，移除 `git worktree add` 与离线编造
  - Done: source=f88d0da review=pass(e9eaa1f6@f88d0da/3abf66a)
  - Depends on: T-01
  - Write scope: skills/paseo-pipeline/task-runner.mjs, skills/paseo-pipeline/test/task-runner.test.mjs
  - Risk-surface: [error-handling]
  - Review: standard
  - Verify with: `node --test skills/paseo-pipeline/test/task-runner.test.mjs`
  - Scenarios: SCEN-HND-04, SCEN-HND-05

- [x] 2.2 T-04 `task-runner` 审计诚实与等待容错：非 mechanical 档 exit 50、`--review-tag` 重入、去掉同构豁免、wait 失败降级轮询与 exit 51
  - Done: source=c0ed92a review=pass(4b51ea5b@c0ed92a/5fea39e)
  - Depends on: T-03
  - Write scope: skills/paseo-pipeline/task-runner.mjs, skills/paseo-pipeline/test/task-runner.test.mjs
  - Risk-surface: [error-handling]
  - Review: standard
  - Verify with: `node --test skills/paseo-pipeline/test/task-runner.test.mjs`
  - Scenarios: SCEN-HND-06, SCEN-HND-07

- [x] 2.3 T-05 `hotfix.sh` 降为 `task-runner` 的兼容包装，原 hotfix 测试全量通过
  - Done: source=56c926e review=pass(0c730777@56c926e/d0291a3)
  - Depends on: T-04
  - Write scope: skills/paseo-pipeline/hotfix.sh, skills/paseo-pipeline/test/hotfix.test.mjs
  - Risk-surface: [error-handling]
  - Review: standard
  - Verify with: `node --test skills/paseo-pipeline/test/hotfix.test.mjs`
  - Scenarios: SCEN-HND-08

## 3. 文档

- [ ] 3.1 T-06 SKILL 声明单一入口、交接序列补提交与 handoff-check、收尾指向 `test/run-all.sh`
  - Depends on: T-05
  - Write scope: skills/paseo-pipeline/SKILL.md, skills/paseo-pipeline/test/docs.test.mjs, skills/paseo-pipeline/test/run-all.sh
  - Risk-surface: [none]
  - Review: standard
  - Verify with: `node --test skills/paseo-pipeline/test/docs.test.mjs`
  - Scenarios: SCEN-HND-09, SCEN-DISP-04
