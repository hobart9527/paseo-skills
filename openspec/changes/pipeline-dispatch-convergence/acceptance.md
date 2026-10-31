# Acceptance Matrix

<!--
  本 change 交付的是门禁与派发入口，入口即 CLI 命令本身。冻结时一律 PENDING / pending。
  Verify 为单条可重跑命令；收尾由 acceptance-run 逐条真跑。
-->

| Scenario | Entry | Tasks | Verify | Required | Result | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| SCEN-HND-01 | `node skills/paseo-pipeline/handoff-check.mjs <change>` | T-01 | `node --test skills/paseo-pipeline/test/handoff-check.test.mjs` | yes | PENDING | pending |
| SCEN-HND-02 | `node skills/paseo-pipeline/handoff-check.mjs <change>`（集成分支 / 非集成分支） | T-01 | `node --test skills/paseo-pipeline/test/handoff-check.test.mjs` | yes | PENDING | pending |
| SCEN-HND-03 | `node skills/paseo-pipeline/run-state.mjs record <change> --key <k> --agent <id>` | T-02 | `node --test skills/paseo-pipeline/test/run-state.test.mjs` | yes | PENDING | pending |
| SCEN-HND-04 | `node skills/paseo-pipeline/task-runner.mjs <change> <task>` | T-03 | `node --test skills/paseo-pipeline/test/task-runner.test.mjs` | yes | PENDING | pending |
| SCEN-HND-05 | `node skills/paseo-pipeline/task-runner.mjs <change> <task>`（重派） | T-03 | `node --test skills/paseo-pipeline/test/task-runner.test.mjs` | yes | PENDING | pending |
| SCEN-HND-06 | `node skills/paseo-pipeline/task-runner.mjs <change> <task> [--review-tag <tag>]` | T-04 | `node --test skills/paseo-pipeline/test/task-runner.test.mjs` | yes | PENDING | pending |
| SCEN-HND-07 | `node skills/paseo-pipeline/task-runner.mjs <change> <task>`（`paseo wait` 失败） | T-04 | `node --test skills/paseo-pipeline/test/task-runner.test.mjs` | yes | PENDING | pending |
| SCEN-HND-08 | `bash skills/paseo-pipeline/hotfix.sh <change> <task> <brief> <test-cmd>` | T-05 | `node --test skills/paseo-pipeline/test/hotfix.test.mjs` | yes | PENDING | pending |
| SCEN-HND-09 | `skills/paseo-pipeline/SKILL.md` | T-06 | `node --test skills/paseo-pipeline/test/docs.test.mjs` | yes | PENDING | pending |
| SCEN-DISP-04 | `skills/paseo-pipeline/SKILL.md` 与 `hotfix.sh` | T-06 | `node --test skills/paseo-pipeline/test/docs.test.mjs` | yes | PENDING | pending |
