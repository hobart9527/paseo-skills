# Acceptance Matrix

| Scenario | Entry | Tasks | Verify | Required | Result | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| SCEN-CON-27 | `node skills/paseo-pipeline/run-state.mjs report <change> --json`（账本经 claim/fail 构造） | T-01 | `node --test skills/paseo-pipeline/test/run-state.test.mjs` | yes | PASS | /Users/hobart/Codex/paseo-skills/.git/paseo-pipeline/run-ledger-dispatch-attribution/acceptance-receipt.json#SCEN-CON-27 |
