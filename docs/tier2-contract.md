# Tier 2 Contract

Progressive native OpenSpec (`paseo-tier2`: `specs/` + `tasks.md`), written before first source edit. Uses the same `SCEN-*` and `tasks.md` format as Tier 3 so scaling needs **zero rewrite**.

Write it only when the change alters behaviour a caller/user can observe. **Tier 2-Light** (single-session worktree change without handoff slices) or mechanical work writes `Contract: none — <reason>` instead and closes with `tier2-verify.mjs <base> --auto-verify`; **Tier 2-Heavy** (slice relay or `gongbu` handoff) scaffolds `paseo-tier2`.

```text
openspec/changes/<name>/
  .openspec.yaml          # schema: paseo-tier2
  baseline-facts.md       # optional Stage 0/1 facts (<=15KB; JIT-inlined by brief.mjs tier2)
  specs/<capability>/spec.md
  tasks.md
```

**Fast Path:** Stay on this doc (skip Tier 3 `SKILL.md` unless scaling to DAG); omit `proposal.md`/`acceptance.md`. In linked worktree, run `prepare-author <dir> --schema paseo-tier2 --scaffold --hydrate` and batch `specs/` + `tasks.md` writes. If context compacted or >100k tokens, finish contract and relay slices (`brief.mjs tier2 --task T-01` + `handoff-progress.md`). Heavy work adds `chanpin` (`brief.mjs recon`) → `baseline-facts.md` and commits every 1–2 tasks.

## spec.md & tasks.md
- `spec.md`: `## Purpose` (50+ chars, new only) + `## ADDED | MODIFIED | REMOVED Requirements`; `### Requirement:` (SHALL) + `#### Scenario: SCEN-<CAP>-NN <title>` (`WHEN`/`THEN`, `path:line`).
- `tasks.md`: `- [ ] 1.1 T-01 <goal>`, `Write scope:`, `Entry:`, `Verify with:`, `Scenarios: SCEN-...`, serial. Legacy `- **Verify:**` in `specs/` works too.

## Check, Delivery & Archive
1. `openspec validate <name> --strict` exits 0 before coding.
2. Mark finished tasks `[x]` and run `node "$PIPELINE_HOME"/tier2-verify.mjs <base> --change-dir openspec/changes/<name>` (Verify, drift, `risk-scan.mjs`). If `REVIEW_REQUIRED`, run 1+1 reviewer and `pipeline-run.mjs record-review --mode tier2`.
3. After `/ship` merges to `<default>`, run `openspec archive <name> -y` on `<default>`.

Grows into concurrent DAG (`tasks >= 4` and `maxWidth >= 3`, or `maxWidth >= 2`, `weightedSpeedup >= 1.8`): switch `.openspec.yaml` to `schema: paseo-pipeline`, add `Depends on:` + `proposal.md`, run `acceptance sync` + `/paseo-pipeline`.
