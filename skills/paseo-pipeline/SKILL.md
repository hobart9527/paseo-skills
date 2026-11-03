---
name: paseo-pipeline
description: SDD concurrent delivery pipeline for changes with real DAG concurrency. OpenSpec owns contracts; Paseo owns agents/workspaces; git owns state. Scripts schedule; workers close tasks; two heterogeneous gates guard the ends.
user-invocable: true
---

# Paseo Pipeline

Use only when the frozen DAG has `maxWidth >= 2` and `tasks >= 4`; otherwise Tier 2 `/paseo-handoff`. Never split to qualify.

## Principles
1. **Concurrency is the engine.** Every ready task runs at once in its own worktree. There is no Lead, no per-task reviewer, and no wave barrier.
2. **Deterministic scheduling, not an LLM.** `pipeline-run.mjs` computes the frontier, capacity, and merge order. The main session executes its list; it never recomputes the DAG by hand.
3. **One worker per task, closed loop.** A worker writes tests and implementation, runs the frozen narrow Verify, commits, and returns. Tests and implementation may be written in either order.
4. **Vertical slices.** Behavior, wiring, affected fixtures, and tests belong together. No fixture-only/wiring-only tasks. Wave 0 only for a genuinely shared contract and actual consumers.
5. **Narrow Verify.** Every non-sink task names a scope-local test/spec command. Full suite runs only at the unique sink and final acceptance.
6. **Heterogeneous gates at the ends.** R0 reviews the contract before CP-1; one independent FINAL review covers the integrated result. The middle is mechanical: Verify, scope, dependencies, drift.
7. **Git is state; Paseo is transport.** No ledger, lease, lock, or custom agent runner.
8. **Human gates.** CP-1 freezes the approved contract. CP-2 confirms merge to main. No push/destructive cleanup without explicit approval.

## Roles and briefs
Before every `create_agent`, copy the matching `list_profiles` entry exactly (`provider/model`, `modeId`, `thinkingOptionId`, `featureValues`); if none fits, check `list_providers`/`list_models`, and if the exact pair is not returned, stop. Never copy model IDs from examples, memory, or prior runs. `create_agent` needs a non-empty `title` (`<role>-<change>`). Dispatch natively (labels, finish notification, a background `paseo wait` backstop); a timed-out wait means inspect, then re-arm. Briefs: `templates/author.md`, `templates/worker.md`, `templates/reviewer.md`.

- `gongbu` (author): on the contract stage, writes the whole package in one pass. Its `notes` describe implementation; authoring is a separate job assignment, not a second role.
- `hanlin` (R0): independent package review before CP-1; writes nothing.
- `gongbu` / `jiangzuo` / `gaogong` (worker): implementation and tests for one task.
- `anchasi` (FINAL): the single integrated code review, after every task has merged.
- `gaogong` (fixer): narrow repair of a confirmed FINAL-review blocker.
- `ceshi` and `shangshu` are retired. A legacy branch may still carry a `ceshi` commit for merge compatibility; never dispatch either.
- Profile notes describe a role's scope; the frozen task's `Review:` field no longer selects a process. It stays as risk metadata for the contract stage.

## Entry and CP-1

The contract stage is sequential; every step blocks the next.

0. **Preflight** (read-only): `node "$PIPELINE_HOME"/preflight.mjs <repo>` reports each package's test runner and whether a UI package can run DOM tests. Fix a missing DOM environment before authoring — the expensive late failure.
1. Run `openspec new change <name> --schema paseo-pipeline`. The schema resolves from the global OpenSpec schema link installed by `install.sh`; do not keep stale project-local copies that shadow it.
2. **One author, one pass** (`gongbu`, `templates/author.md`). Dispatch one author to write the whole package — proposal, specs, digest, design, tasks, acceptance — directly to `openspec/changes/<name>/`, then commit. A human-approved design document (`docs/specs/<change>-design.md`) is the ideal input; without one the author derives behavior from the request and records assumptions explicitly. Do not split into two authors and do not re-derive the DAG in the main session.
3. Run `node "$PIPELINE_HOME"/freeze-check.mjs openspec/changes/<name> --structural` (Impact Inventory, SCEN per task, no test-only tasks; skips the R0 check, which cannot exist yet). Read its `ADVISE` lines (`ADVISORY_LOW_SPEEDUP`: compare with Tier 2; `ADVISORY_BASELINE_ALIGNMENT`: the author fills it, R0 blocks on an empty one). If it blocks, the author fixes and you re-run. Do not proceed past a block. `[ROUTE] handoff` here: skip R0; run Tier 2 `/paseo-handoff` on the committed spec and tasks.
4. **Dispatch `hanlin`** (`templates/reviewer.md` Mode R0) in a read-only workspace after the structural check passes on a committed contract. It returns findings, or `R0: pass(<agent-uuid>@<reviewed-sha>)`, recorded in `review.md`; accepted rulings go in `rulings.md`. **Bounded R0 (max two rounds):** revise the whole package, re-run `freeze-check --structural`, then re-dispatch. A second round passing frees CP-1; otherwise escalate the unclosed list, never a third round. A delta brief never states the expected verdict.
5. Re-run `freeze-check` without `--structural`; it rejects a missing sign-off and `STALE_R0_SIGNOFF`.
6. Present the final contract, R0 findings, DAG/scopes/Verify/acceptance. Two CP-1 remedies, not interchangeable: `ADVISORY_LOW_SPEEDUP` offers "switch to Tier 2 /paseo-handoff"; a `-logical->` step in `CRITICAL` or `ADVISORY_READS_ONLY_EDGE` offers dropping that edge, never Tier 2. Freeze only after human confirmation. The CP-1 prompt names the executor ("确认冻结并交给主会话执行"), never just "确认冻结并启动实施".

## Start after CP-1

1. Commit the frozen contract (`openspec/changes/<change>/`) on the default branch.
2. Create the integration worktree and branch from that commit: `create_workspace(isolation, branchName: "integration/<change>")`.
3. Create one task worktree + branch per currently-ready task from the integration tip: `task/<change>/<T-id>`. Replacement attempts take `<T-id>-aN`.
4. Install the author hook in every task worktree: `git config extensions.worktreeConfig true`, then `git config --worktree core.hooksPath "$PIPELINE_HOME/hooks/git"`. Without it a worker cannot stamp its own `Pipeline-Author`, and the merge gate exits 31.
5. Bootstrap dependencies per lockfile in every workspace — **including the integration worktree**, where `merge-task` runs Verify — before any Verify. A worktree is a checkout, not a clone; an uninstalled package exits 36. Install once per workspace, not per task.
6. Run `node "$PIPELINE_HOME"/pipeline-run.mjs plan openspec/changes/<change>` and dispatch exactly the workers it lists. The main session is an event router from here: it does not edit business code and does not schedule by reasoning.

After compaction or resume, re-read `tasks.md` Done lines, `git log --first-parent integration/<change>`, and `paseo ls --label pipeline.change=<change> --json` before any dispatch; summaries are not state.

## Runtime
- `pipeline-run.mjs plan <change-dir>` is the only scheduler: `DISPATCH`/`MERGE`/`WAIT`/`ATTENTION`, worker cap 8, critical path first. Execute its list; never recompute the frontier by hand.
- Dispatch a ready task to one worker (`templates/worker.md`) carrying its branch/workspace, frozen scope, SCENs, and Verify. The worker commits with `Pipeline-Role` and `Pipeline-Author` trailers.
- On a worker's finish notification, verify the branch tip and run `pipeline-run.mjs merge <change-dir> <T-id>` from the integration worktree. The gate records Done; then re-run `plan`.
- A worker that fails Verify or exceeds scope is retried on the same branch at most twice. After that, report to the human; do not silently spawn a second agent.
- Circuit breaker: at most 3 attempts per task (`-a2`, `-a3`), then stop and escalate.
- A lost notification triggers `plan` reconciliation of git + Paseo state, never a duplicate dispatch. Wake the existing worker instead of creating one.
- Contract amendments after CP-1: the main session updates tasks, a human confirms, commit, then re-run `plan`. A new interface or security boundary needs `hanlin` R0, its `R0: pass(...)` line APPENDED to `review.md` (last line wins).

## Merge gate
```
node "$PIPELINE_HOME"/pipeline-run.mjs merge <change-dir> <task-id>
```
`pipeline-run` resolves the newest attempt branch and runs `merge-task.mjs`. The gate checks dependencies Done, Write scope, commit trailers ("Pipeline-Author"/"Pipeline-Role"), cherry-pick provenance, base drift, the frozen Verify, and regression of already-Done tasks, then no-ff merges and records Done. It proves nothing about tests beyond the frozen Verify: test quality is the FINAL review's job. Exit codes: 2 usage; 10 conflict; 20 Verify; 21 regression; 30 scope; 31 provenance; 34 base/drift; 35 dependency; 36 unchecked-out dependencies; 37 attempt/rework breaker; `--allow-attempt-over`: human only.

Exit 36: the worktree cannot resolve a package or runner (`Cannot find package 'tsx'`, `command not found`). Install per lockfile and retry; never edit tests or Verify.

## Finish
1. Require all tasks Done, no blocked tasks, clean integration worktree.
2. On the same final SHA, run the full suite and all `Required=yes` acceptance commands; record evidence/SHA. In parallel, run the single integrated review (`anchasi`, `templates/reviewer.md` Mode FINAL) over `main...integration/<change>`.
3. Confirmed blockers only: `gaogong` fixes them in a narrow worktree, then rerun the affected Verify and have the original reviewer recheck the fix diff once. Remaining blockers mean not delivered.
4. Report final SHA, test/acceptance results, findings/NITs, task SHAs. CP-2 stays human. If main moved, revalidate at the new SHA.
5. After CP-2, present the cleanup list; delete/archive worktrees and branches only after human confirmation. Push needs separate confirmation.

## Recovery
```
node "$PIPELINE_HOME"/pipeline-run.mjs status <change-dir>
git log --first-parent integration/<change>
grep -n 'Done:' openspec/changes/<change>/tasks.md
paseo ls --label pipeline.change=<change> --json
```
Use live Paseo state, branch tips, and Done lines; never re-dispatch on a delayed notification. Never archive `pipeline.change=<change>` agents before CP-2.

## Hard lines
- The main session never edits business code; `gongbu`/`gaogong` authors write contract files only; `hanlin` and `anchasi` write nothing.
- No manual Done/check boxes; no full-suite Verify on non-sink tasks.
- Never treat a missing dependency as a failed test or fix it by editing tests/Verify; install in the workspace and rerun.
- No tenant/database/port/account sharing without declared isolation.
