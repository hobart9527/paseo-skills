---
name: tier2-handoff
description: Fill the Tier 2 delegation brief (Authorization, Pending decisions, Slices, size estimate) and run the pre-dispatch check, then dispatch through /paseo-handoff. Use whenever Tier 2 work is delegated to another agent.
user-invocable: true
---

# Tier 2 Handoff

`/paseo-handoff` is bundled with Paseo and synced by the app, so it is not edited. This skill wraps it: fill and check the brief here, then paste into `/paseo-handoff`.

1. For heavy/serial work (post-`/brainstorming`, compacted, `>=800`-line files, or `>=5` test files), share Stage 0/1 first: `node "$PIPELINE_HOME"/pipeline-run.mjs prepare-author openspec/changes/<name> --schema paseo-tier2 --hydrate` + read-only `chanpin` (`brief.mjs recon`) → `baseline-facts.md` (`<=15KB`) before specs/code.
2. Read `docs/tier2-handoff-brief.md` from the skills checkout. It is the only template; do not restate it.
3. Fill every Assignment field. `Slices` is serial, one line per slice, no DAG. A `handoff` route from `freeze-check` keeps its tasks as `Slices` unchanged.
4. Run `Pre-dispatch check`; do not dispatch while any item fails:
   - Missing `Delegate:`, `Testing:`, `Authorization:`, `Pending decisions`, `Slices`, `Risk:`, or `Contract:` (`none — <reason>` counts), or named contract fails `openspec validate <name> --strict`.
   - Requested independent Red lacks test paths, real interface, Verify, or `templates/tester.md`. Default owner testing adds no dispatch; verify Red evidence before handing the same branch to Delegate (never pick models by display name).
   - Move any must-pass defect-locking test into its slice as "change to …".
   - Unanswered risky operation / auth / money decision: ask user once with exact reply sentence and end turn.
5. Tell user the size estimate (files, lines, minutes) and slice count.
6. Invoke `/paseo-handoff`. When `tasks.md` exists, render whole or per-slice JIT prompts with `node "$PIPELINE_HOME"/brief.mjs tier2 --change <name> --repo <path> [--task T-01]` (relays `handoff-progress.md` cleanly across heavy slices); else paste the filled brief.
7. Track progress by finished slices and Git tips, not elapsed time; forward hard-risk questions verbatim.
8. On delivery, run Evidence recheck via `node "$PIPELINE_HOME"/pipeline-run.mjs tier2-verify <base> [--change-dir openspec/changes/<name>]` (runs `risk-scan.mjs`) at tip SHA. If `Risk:` is non-none or `tier2-verify` returns `REVIEW_REQUIRED`, run 1+1 reviewer (`brief.mjs tier2-review`), record via `pipeline-run.mjs record-review --mode tier2`, and present unresolved `BLOCKED` verbatim before merge.
