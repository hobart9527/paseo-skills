# Acceptance Matrix

| Scenario | Entry | Tasks | Verify | Required | Result | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| SCEN-PJ-01 | `node skills/paseo-pipeline/profiles-check.mjs --json --skill <F> --config <F>` (clean profiles) | T-01 | `node --test skills/paseo-pipeline/test/profiles-check.test.mjs` | yes | PENDING | pending |
| SCEN-PJ-02 | `node skills/paseo-pipeline/profiles-check.mjs --json --skill <F> --config <F> --root <dir>` (missing profile + out-of-scope brief) | T-01 | `node --test skills/paseo-pipeline/test/profiles-check.test.mjs` | yes | PENDING | pending |
| SCEN-PJ-03 | `node skills/paseo-pipeline/profiles-check.mjs --json` with unreadable files or an unknown flag | T-01 | `node --test skills/paseo-pipeline/test/profiles-check.test.mjs` | yes | PENDING | pending |
| SCEN-PJ-04 | `node skills/paseo-pipeline/profiles-check.mjs --skill <F> --config <F>` (text mode, no `--json`) | T-01 | `node --test skills/paseo-pipeline/test/profiles-check.test.mjs` | yes | PENDING | pending |
| SCEN-PJ-05 | `node skills/paseo-pipeline/pipeline-run.mjs install-hook <worktree>` with `.husky` hooksPath and executable `pre-commit` | T-02 | `node --test skills/paseo-pipeline/test/pipeline-run.test.mjs` | yes | PENDING | pending |
| SCEN-PJ-06 | `node skills/paseo-pipeline/pipeline-run.mjs install-hook --replace-hooks <worktree>` on the same worktree | T-02 | `node --test skills/paseo-pipeline/test/pipeline-run.test.mjs` | yes | PENDING | pending |
| SCEN-PJ-07 | `node skills/paseo-pipeline/pipeline-run.mjs install-hook [--replace-hooks] <worktree>` with samples-only hooks dir | T-02 | `node --test skills/paseo-pipeline/test/pipeline-run.test.mjs` | yes | PENDING | pending |
| SCEN-PJ-08 | `skills/paseo-pipeline/SKILL.md` `## Tools` row for `profiles-check.mjs` | T-03 | `node --test skills/paseo-pipeline/test/profiles-check.test.mjs skills/paseo-pipeline/test/docs.test.mjs` | yes | PENDING | pending |
