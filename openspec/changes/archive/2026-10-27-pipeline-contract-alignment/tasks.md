# Tasks

<!--
  格式由 lib/tasks.mjs 定义。本 change 的实现在工作树里已完成、尚未合流，
  因此任务保持未勾选：Done 行只能由 merge-task.mjs 生成，手写等于伪造合流收据。
  冻结前跑 `node skills/paseo-pipeline/freeze-check.mjs openspec/changes/pipeline-contract-alignment`。
-->

## 1. 任务契约的单一属主

- [x] 1.1 T-01 `lib/tasks.mjs` 定义 `ERROR_SCOPE`（graph/task）、`IDENTITY_CODES` 与 `REVIEW_TAG`，解析器跳过 HTML 注释、报 `UNKNOWN_FIELD`、校验 Done 行 review 值；`merge-task.mjs` / `reconcile.mjs` / `contract-check.mjs` 改为消费这些导出，不再各自维护集合与正则
  - Done: source=7c99eec review=pass(b6aeb7ec@7c99eec/0ce4389)
  - Depends on: none
  - Write scope: skills/paseo-pipeline/lib/tasks.mjs, skills/paseo-pipeline/merge-task.mjs, skills/paseo-pipeline/reconcile.mjs, skills/paseo-pipeline/contract-check.mjs, skills/paseo-pipeline/test/tasks.test.mjs, skills/paseo-pipeline/test/merge-task.test.mjs, skills/paseo-pipeline/contract-check.test.sh
  - Risk-surface: [error-handling]
  - Review: standard
  - Verify with: `node --test skills/paseo-pipeline/test/tasks.test.mjs skills/paseo-pipeline/test/merge-task.test.mjs`
  - Scenarios: SCEN-CON-01, SCEN-CON-02, SCEN-CON-03

## 2. 冻结：一条命令与项目内 schema

- [x] 2.1 T-02 新增 `freeze-check.mjs`，复用 `lib/tasks.mjs` 解析器，核任务行/ID/依赖/scope、场景编号双向闭环、验收矩阵列与引用、Pod 成员；跨 change 写范围重叠只出 HINT
  - Done: source=7c99eec review=pass(b6aeb7ec@7c99eec/0ce4389)
  - Depends on: T-01
  - Write scope: skills/paseo-pipeline/freeze-check.mjs, skills/paseo-pipeline/test/freeze-check.test.mjs, skills/paseo-pipeline/test/run-all.sh
  - Risk-surface: [error-handling]
  - Review: standard
  - Verify with: `node --test skills/paseo-pipeline/test/freeze-check.test.mjs`
  - Scenarios: SCEN-CON-04

- [x] 2.2 T-03 新增 OpenSpec 1.8.0 项目内 schema（`openspec-schema/`，含 `acceptance` 产物）并安装到仓库 `openspec/schemas/paseo-pipeline/`；SKILL 侧的安装步骤说明归 T-07（同一文件只归一个任务，避免写范围重叠）
  - Done: source=7c99eec review=pass(b6aeb7ec@7c99eec/0ce4389)
  - Depends on: T-01
  - Write scope: skills/paseo-pipeline/openspec-schema/, openspec/schemas/paseo-pipeline/
  - Risk-surface: [none]
  - Review: standard
  - Verify with: `openspec schemas`
  - Scenarios: SCEN-CON-05

## 3. 证据：契约、模板与矩阵

- [x] 3.1 T-04 新增 `lib/evidence-contract.mjs` 作为字段清单唯一定义点；`check-evidence.mjs` 改为按清单校验并抛错暴露漂移，占位值判据收窄到闸门拥有的字段，新增 `--matrix` 从冻结矩阵取 `Required: yes` 场景，新增 `child_agent_id` 真实记录与时间线核对、「未采集」不得作为验收收据
  - Done: source=7c99eec review=pass(b6aeb7ec@7c99eec/0ce4389)
  - Depends on: T-01
  - Write scope: skills/paseo-pipeline/lib/evidence-contract.mjs, skills/paseo-pipeline/test/check-evidence.mjs, skills/paseo-pipeline/test/check-evidence.test.mjs, skills/paseo-pipeline/lib/paseo-state.mjs
  - Risk-surface: [error-handling]
  - Review: standard
  - Verify with: `node --test skills/paseo-pipeline/test/check-evidence.test.mjs`
  - Scenarios: SCEN-CON-06, SCEN-CON-07, SCEN-CON-08

- [x] 3.2 T-05 新增 `templates/evidence-smoke.md` 与 `templates/evidence-audit.md`，字段集与契约一致；模板自身形状由 SCEN-DOC-21/22 断言（承载在 T-07 的 docs 测试里）
  - Done: source=7c99eec review=pass(b6aeb7ec@7c99eec/0ce4389)
  - Depends on: T-04
  - Write scope: skills/paseo-pipeline/templates/evidence-smoke.md, skills/paseo-pipeline/templates/evidence-audit.md
  - Risk-surface: [none]
  - Review: mechanical
  - Verify with: `node -e "process.exit(['evidence-smoke','evidence-audit'].every(n=>require('fs').existsSync('skills/paseo-pipeline/templates/'+n+'.md'))?0:1)"`
  - Scenarios: SCEN-CON-06

## 4. 运行账本的终态语义

- [x] 4.1 T-06 `run-state.mjs` 的 `fail` 拒绝已有真实回执的意图（exit 2）；新增 `report` 只从账本已记事实推导度量、采不到写「未采集」；`begin` 记录 Skill git HEAD 与 dirty，`status` 漂移只警告不拦；`lib/run-state.mjs` 增 `skill` 字段的读写与校验
  - Done: source=7c99eec review=pass(b6aeb7ec@7c99eec/0ce4389)
  - Depends on: T-01
  - Write scope: skills/paseo-pipeline/run-state.mjs, skills/paseo-pipeline/lib/run-state.mjs, skills/paseo-pipeline/test/run-state.test.mjs
  - Risk-surface: [error-handling, persistence]
  - Review: standard
  - Verify with: `node --test skills/paseo-pipeline/test/run-state.test.mjs`
  - Scenarios: SCEN-CON-09, SCEN-CON-10, SCEN-CON-11

## 5. 文档与热修路径对齐

- [x] 5.1 T-07 SKILL 的运行账本命令块改为可照抄执行（claim/record/fail 均带 `--owner`）并写明省略后果；`hotfix.sh` 的 profile 解析改为对 `agent_profile_gongbu` fail-closed，`qingqibing` 退出派发路径与文档（`lib/roles.mjs` 仅保留历史标签识别）；`templates/arbiter.md` 补齐；`test/docs.test.mjs` 断言命令块可执行与模板齐备
  - Done: source=7c99eec review=pass(b6aeb7ec@7c99eec/0ce4389)
  - Depends on: T-03, T-05, T-06
  - Write scope: skills/paseo-pipeline/SKILL.md, skills/paseo-pipeline/LESSONS.md, skills/paseo-pipeline/hotfix.sh, skills/paseo-pipeline/lib/roles.mjs, skills/paseo-pipeline/templates/arbiter.md, skills/paseo-pipeline/test/docs.test.mjs, skills/paseo-pipeline/test/hotfix.test.mjs
  - Risk-surface: [none]
  - Review: standard
  - Verify with: `node --test skills/paseo-pipeline/test/docs.test.mjs skills/paseo-pipeline/test/hotfix.test.mjs`
  - Scenarios: SCEN-CON-12, SCEN-CON-13

## 6. Pod 单次合流与依赖门禁

- [x] 6.1 T-08 `lib/ledger.mjs` 新增 `batchDependencyClosure`（同批依赖闭包）；`merge-task.mjs` 依赖门禁只对「本批之外」的未验收依赖 exit 35；`freeze-check.mjs` 冻结时说明 Pod 成员集的依赖闭包是否落在集内
  - Done: source=7c99eec review=pass(b6aeb7ec@7c99eec/0ce4389)
  - Depends on: T-02
  - Write scope: skills/paseo-pipeline/lib/ledger.mjs, skills/paseo-pipeline/merge-task.mjs, skills/paseo-pipeline/freeze-check.mjs, skills/paseo-pipeline/test/merge-task.test.mjs, skills/paseo-pipeline/test/freeze-check.test.mjs
  - Risk-surface: [error-handling]
  - Review: standard
  - Verify with: `node --test skills/paseo-pipeline/test/merge-task.test.mjs skills/paseo-pipeline/test/freeze-check.test.mjs`
  - Scenarios: SCEN-CON-14
