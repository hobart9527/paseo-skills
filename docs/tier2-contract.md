# Tier 2 Contract

Progressive native OpenSpec, two files, written before the first source edit. Read by `/tier2-handoff` and by the main session working alone in its linked worktree. Uses the same `SCEN-*` and task format as Tier 3 so scaling up to `/paseo-pipeline` or down to Tier 2 requires **zero rewrite**.

Write it only when the change adds or alters behaviour a user or caller can observe. Mechanical work (rename, move, refactor under existing tests, config, docs) writes `Contract: none — <reason>` instead; the slices' done evidence is then the oracle.

```text
openspec/changes/<name>/
  specs/<capability>/spec.md
  tasks.md
```

`proposal.md` and `acceptance.md` are omitted in Tier 2: the user's words live in the handoff/task `Requirements:`, and `tier2-verify` executes every scenario's `**Verify:**` directly.

## spec.md
- `## Purpose` for a new capability (50+ chars); `## ADDED | MODIFIED | REMOVED Requirements` for the delta.
- Each `### Requirement:` states SHALL behaviour a user or caller can observe.
- Each scenario uses `#### Scenario: SCEN-<CAP>-NN <title>`, `WHEN`/`THEN`, and one line `- **Verify:** <single command that runs the real entry>`.
- Facts the rule rests on: `path:line` beside the rule.

## tasks.md
- Standard task blocks (`- [ ] 1.1 T-01 <goal>`, `Write scope:`, `Verify with:`, `Scenarios: SCEN-...`), serial by default (omit `Depends on:`).

## Check & Delivery
1. `openspec validate <name> --strict` must exit 0 before coding.
2. Before merge (whether delegated or main-session-in-worktree), run `node "$PIPELINE_HOME"/tier2-verify.mjs <base> --change-dir openspec/changes/<name>`, which validates every `**Verify:**`, reruns them at tip SHA, and runs `risk-scan.mjs`.

Work grows into concurrent DAG (`tasks >= 4` and `maxWidth >= 2`): keep the exact same `specs/` and `tasks.md`, add `Depends on:` + `proposal.md`, and run `pipeline-run.mjs acceptance sync` + `/paseo-pipeline`.
