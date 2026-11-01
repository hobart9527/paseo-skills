# Acceptance Matrix

| Scenario | Entry | Tasks | Verify | Required | Result | Evidence |
|---|---|---|---|---|---|---|
| SCEN-HND-02 | handoff-check on integration branch | T-01 | `node --test skills/paseo-pipeline/test/handoff-check.test.mjs` | yes | PENDING | pending |
| SCEN-HND-09 | SKILL.md handoff sequence as written | T-01 | `node --test skills/paseo-pipeline/test/docs.test.mjs` | yes | PENDING | pending |
| SCEN-HND-10 | handoff-check before branch exists | T-01 | `node --test skills/paseo-pipeline/test/handoff-check.test.mjs` | yes | PENDING | pending |
| SCEN-LED-01 | corrupt ledger refuse-to-write | T-02 | `node --test skills/paseo-pipeline/test/run-state.test.mjs` | yes | PENDING | pending |
| SCEN-LED-02 | reconcile surfaces corruption | T-02, T-03 | `node --test skills/paseo-pipeline/test/run-state.test.mjs skills/paseo-pipeline/test/reconcile.test.mjs` | yes | PENDING | pending |
| SCEN-LED-03 | scope guard corruption visible | T-02 | `node --test skills/paseo-pipeline/test/run-state.test.mjs` | yes | PENDING | pending |
| SCEN-LED-04 | stale lock release path | T-10 | `node --test skills/paseo-pipeline/test/lock.test.mjs` | yes | PENDING | pending |
| SCEN-REC-15 | open intent holds named task only | T-03 | `node --test skills/paseo-pipeline/test/reconcile.test.mjs` | yes | PENDING | pending |
| SCEN-REC-16 | orphan intent no global freeze | T-03 | `node --test skills/paseo-pipeline/test/reconcile.test.mjs` | yes | PENDING | pending |
| SCEN-DOC-03 | envelope fields single source | T-04 | `node --test skills/paseo-pipeline/test/docs.test.mjs` | yes | PENDING | pending |
| SCEN-HND-11 | review-tag lease enforcement | T-05 | `node --test skills/paseo-pipeline/test/task-runner.test.mjs` | yes | PENDING | pending |
| SCEN-HND-12 | no Verify means refuse | T-06 | `node --test skills/paseo-pipeline/test/task-runner.test.mjs` | yes | PENDING | pending |
| SCEN-MRG-11 | undecided tier fails closed | T-07 | `node --test skills/paseo-pipeline/test/merge-task.test.mjs` | yes | PENDING | pending |
| SCEN-DOC-04 | tier gate documented + doctor | T-08 | `node --test skills/paseo-pipeline/test/pipeline-doctor.test.mjs skills/paseo-pipeline/test/docs.test.mjs` | yes | PENDING | pending |
| SCEN-HND-07 | failed wait polls, never redispatches | T-09 | `node --test skills/paseo-pipeline/test/task-runner.test.mjs` | yes | PENDING | pending |
| SCEN-HND-13 | deadline exit actionable | T-09 | `node --test skills/paseo-pipeline/test/task-runner.test.mjs` | yes | PENDING | pending |
| SCEN-HND-14 | error state terminal | T-09 | `node --test skills/paseo-pipeline/test/task-runner.test.mjs` | yes | PENDING | pending |
| SCEN-DOC-05 | stale narrative marked | T-11 | `node --test skills/paseo-pipeline/test/docs.test.mjs` | yes | PENDING | pending |
