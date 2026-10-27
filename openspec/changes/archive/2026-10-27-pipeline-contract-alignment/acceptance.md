# Acceptance Matrix

<!--
  冻结时整表冻结：Result 一律 PENDING，Evidence 一律 pending。
  收尾由
  `node skills/paseo-pipeline/test/check-evidence.mjs --gate acceptance --sha <集成HEAD> --matrix openspec/changes/pipeline-contract-alignment/acceptance.md <smoke 证据>`
  机械核对。Entry 一律是可照抄执行的命令：本 change 改的是编排工具链本身，
  真实入口就是这些脚本命令行，不是内部函数。

  收尾采集依据（2026-10-27）：`bash skills/paseo-pipeline/test/run-all.sh` @ 集成 HEAD 78ea95b → tests 455 / pass 455 / fail 0。
  逐条证据见 evidence/smoke.md：每个场景的真实入口命令与观测输出都在那里。
-->

| Scenario | Entry | Tasks | Verify | Required | Result | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| SCEN-CON-01 | `node skills/paseo-pipeline/merge-task.mjs <branch> T-01 <tag> <cmd>`（另一个任务缺 Write scope 时） | T-01 | `node --test skills/paseo-pipeline/test/merge-task.test.mjs` | yes | PASS | evidence/smoke.md |
| SCEN-CON-02 | `node -e "import('./skills/paseo-pipeline/lib/tasks.mjs').then(m=>console.log(m.parseTasks('- [x] 1.1 T-01 x\n  - Write scope: a\n  - Done: source=abcdef0 review=main-session').errors))"` | T-01 | `node --test skills/paseo-pipeline/test/tasks.test.mjs` | yes | PASS | evidence/smoke.md |
| SCEN-CON-03 | 同上解析器入口，输入含拼错字段与注释块 | T-01 | `node --test skills/paseo-pipeline/test/tasks.test.mjs` | yes | PASS | evidence/smoke.md |
| SCEN-CON-04 | `node skills/paseo-pipeline/freeze-check.mjs openspec/changes/pipeline-contract-alignment` | T-02 | 对缺任务 id / 未认领场景的夹具各跑一次，期望 exit 1；本 change 自身期望 exit 0 | yes | PASS | evidence/smoke.md |
| SCEN-CON-05 | 临时仓库 `openspec new change <n> --schema paseo-pipeline` 后 `openspec instructions tasks` | T-03 | `node --test skills/paseo-pipeline/test/freeze-check.test.mjs` | yes | PASS | evidence/smoke.md |
| SCEN-CON-06 | `node --test skills/paseo-pipeline/test/docs.test.mjs`（SCEN-DOC-21/22） | T-04, T-05 | 模板字段集与契约必需集双向相等 | yes | PASS | evidence/smoke.md |
| SCEN-CON-07 | `node skills/paseo-pipeline/test/check-evidence.mjs --gate structure <含 notes 人话的证据>` | T-04 | `node --test skills/paseo-pipeline/test/check-evidence.test.mjs`（SCEN-EVD-03） | yes | PASS | evidence/smoke.md |
| SCEN-CON-08 | `node skills/paseo-pipeline/test/check-evidence.mjs --gate acceptance --sha <sha> --matrix openspec/changes/pipeline-contract-alignment/acceptance.md <smoke 证据>` | T-04 | 矩阵 Required 行未 PASS 时须 exit 1 | yes | PASS | evidence/smoke.md |
| SCEN-CON-09 | `node skills/paseo-pipeline/run-state.mjs fail <change> --key <已回执键> --owner <id>` | T-06 | 期望 exit 2，且新 attempt 键可 claim | yes | PASS | evidence/smoke.md |
| SCEN-CON-10 | `node skills/paseo-pipeline/run-state.mjs report <change> --json` | T-06 | 有账本与无账本各一次，后者须报告 absent | yes | PASS | evidence/smoke.md |
| SCEN-CON-11 | `node skills/paseo-pipeline/run-state.mjs status <change>` | T-06 | HEAD 不同的账本须告警不失败；无 `skill` 字段须打印「未采集」 | yes | PASS | evidence/smoke.md |
| SCEN-CON-12 | 照抄 SKILL §4 的命令块执行 | T-07 | `node --test skills/paseo-pipeline/test/docs.test.mjs`（SCEN-DOC-23） | yes | PASS | evidence/smoke.md |
| SCEN-CON-13 | `bash skills/paseo-pipeline/hotfix.sh <fixture 无 gongbu profile>` | T-07 | `node --test skills/paseo-pipeline/test/hotfix.test.mjs` | yes | PASS | evidence/smoke.md |
| SCEN-CON-14 | `node skills/paseo-pipeline/merge-task.mjs pod/<change> T-01,T-02 pass(<rev>@<tip>/<base>) <cmd>`（成员间有依赖） | T-08 | `node --test skills/paseo-pipeline/test/merge-task.test.mjs skills/paseo-pipeline/test/freeze-check.test.mjs` | yes | PASS | evidence/smoke.md |
