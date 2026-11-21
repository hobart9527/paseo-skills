# Acceptance Matrix

| Scenario | Entry | Tasks | Verify | Required | Result | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| SCEN-DEC-01 | `node skills/paseo-pipeline/freeze-check.mjs <change> --structural --json`，proposal 含 `OD-1 Class: money Status: open` 且被 scenario 引用 | T-01 | `node --test skills/paseo-pipeline/test/freeze-check.test.mjs` | yes | PENDING | pending |
| SCEN-DEC-02 | 同上，`OD-2` 无 Class/Status，被 requirement 正文引用 | T-01 | `node --test skills/paseo-pipeline/test/freeze-check.test.mjs` | yes | PENDING | pending |
| SCEN-DEC-03 | 同上，条目带 `Decided:` 或无人引用或 `Class: product` | T-01 | `node --test skills/paseo-pipeline/test/freeze-check.test.mjs` | yes | PENDING | pending |
| SCEN-DEC-04 | `templates/author.md`、`openspec-schema/templates/proposal.md`、`schema.yaml` 的硬决策段落 | T-03 | `node --test skills/paseo-pipeline/test/pipeline-friction-docs.test.mjs` | yes | PENDING | pending |
| SCEN-DEC-05 | `openspec-schema/templates/spec.md`、`schema.yaml` 与 `templates/author.md` 的 Verify/历史 acceptance 段落；`spec-scan.mjs` 提取 Verify | T-02, T-03 | `node --test skills/paseo-pipeline/test/pipeline-friction-docs.test.mjs` | yes | PENDING | pending |
| SCEN-DEC-06 | `docs/tier2-handoff-brief.md` 的 Slices 与 Evidence recheck 段落；`SKILL.md` 的心跳段落 | T-04 | `node --test skills/paseo-pipeline/test/pipeline-friction-docs.test.mjs` | yes | PENDING | pending |
| SCEN-DEC-07 | `node --test`（仓库根，全量套件） | T-03 | `node --test` | yes | PENDING | pending |
