# Acceptance Matrix

| Scenario | Entry | Tasks | Verify | Required | Result | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| SCEN-ROLE-01 | `node skills/paseo-pipeline/next-actions.mjs`，标题为 `[Pipeline] shangshu FULL` 的 agent | T-01 | `node --test skills/paseo-pipeline/test/next-actions.test.mjs` | yes | PENDING | pending |
| SCEN-ROLE-02 | `node --test skills/paseo-pipeline/test/next-actions.test.mjs` | T-01 | `node --test skills/paseo-pipeline/test/next-actions.test.mjs` | yes | PENDING | pending |
| SCEN-RBASE-01 | `skills/paseo-pipeline/templates/reviewer.md` 与 `templates/author.md` 的基线段落 | T-02 | `node --test skills/paseo-pipeline/test/pipeline-friction-docs.test.mjs` | yes | PENDING | pending |
| SCEN-DISP-04 | `mcp__paseo__create_agent`，provider/model 与 profile 完全一致 | T-03 | `node --test skills/paseo-pipeline/test/tool-guard-hook.test.mjs` | yes | PENDING | pending |
| SCEN-DISP-05 | `mcp__paseo__create_agent`，`settings.modeId` 与 profile 不同 | T-03 | `node --test skills/paseo-pipeline/test/tool-guard-hook.test.mjs` | yes | PENDING | pending |
| SCEN-DISP-06 | `mcp__paseo__create_agent`，provider 为 `antigravity/*` 且省略 `settings.modeId` | T-03 | `node --test skills/paseo-pipeline/test/tool-guard-hook.test.mjs` | yes | PENDING | pending |
