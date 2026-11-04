---
name: paseo-pipeline
description: SDD concurrent delivery pipeline for changes with real DAG concurrency. OpenSpec owns contracts; Paseo owns agents/workspaces; git owns state. Scripts schedule; workers close tasks; two heterogeneous gates guard the ends.
user-invocable: true
---

# Paseo Pipeline

Use only when the frozen DAG has `maxWidth >= 2` and `tasks >= 4`; otherwise Tier 2 `/paseo-handoff`. Never split to qualify.

## Principles
1. **Concurrency is the engine.** Ready tasks run in separate worktrees. There is no Lead, no per-task reviewer, and no wave barrier.
2. **Deterministic scheduling, not an LLM.** `pipeline-run.mjs` computes the frontier, capacity, and merge order. The main session executes its list; it never recomputes the DAG by hand.
3. **One worker per task, closed loop.** A worker writes tests and implementation, runs the frozen narrow Verify, commits, and returns. Either order is allowed.
4. **Vertical slices.** Behavior, wiring, affected fixtures, and tests belong together. No fixture-only/wiring-only tasks. Wave 0 only for a genuinely shared contract and actual consumers.
5. **Narrow Verify.** Every non-sink task names a scope-local test/spec command. Full suite runs only at the unique sink and final acceptance.
6. **Heterogeneous gates at the ends.** R0 reviews the contract before CP-1; one independent FINAL review covers the integrated result. The middle is mechanical: Verify, scope, dependencies, drift.
7. **Git is state; Paseo is transport.** Shared Git refs record interrupted or failed merge tips. No coordination service, lease, lock, or custom agent runner.
8. **Human gates.** CP-1 freezes the approved contract. CP-2 confirms merge to main. No push/destructive cleanup without explicit approval.

## Roles and briefs
Before `create_agent`, copy the matching `list_profiles` settings exactly; if none fits, verify the exact provider/model via `list_providers`/`list_models` or stop if not returned. Never copy model IDs from examples or memory. `create_agent` needs a non-empty `title` (`[Pipeline] <role> <T-id>[-aN]` for workers (include the attempt suffix from the branch), `[Pipeline] <role> <mode>` for authors/reviewers; keep titles within 60 characters and use the label, not the title, for change identity). Dispatch natively (set `pipeline.change=<change>` on every pipeline agent, finish notification, a background `paseo wait` backstop); on timeout, inspect and re-arm. Briefs: `templates/author.md`, `templates/worker.md`, `templates/reviewer.md`.

- `gongbu` (author): on the contract stage, writes the whole package in one pass. Its `notes` describe implementation; authoring is a separate job assignment, not a second role.
- `hanlin` (R0): independent package review before CP-1; writes nothing.
- `gongbu` / `jiangzuo` / `gaogong` (worker): implementation and tests for one task.
- `anchasi` (FINAL): the single integrated code review, after every task has merged.
- `gaogong` (fixer): narrow repair of a confirmed FINAL-review blocker.
- `ceshi` and `shangshu` are retired. A legacy branch may still carry a `ceshi` commit for merge compatibility; never dispatch either.
- Profile notes describe a role's scope; the frozen task's `Review:` field no longer selects a process. It stays as risk metadata for the contract stage.

## Entry and CP-1

Contract steps are serial.

0. **Preflight** (read-only): `node "$PIPELINE_HOME"/preflight.mjs <repo>` reports each package's test runner and whether a UI package can run DOM tests. Fix a missing DOM environment before authoring — the expensive late failure.
1. Run `openspec new change <name> --schema paseo-pipeline`. The schema resolves from the global OpenSpec schema link installed by `install.sh`; do not keep stale project-local copies that shadow it.
2. **One author, one pass** (`gongbu`, `templates/author.md`). Dispatch one author to write the whole package — proposal, specs, digest, design, tasks, acceptance — directly to `openspec/changes/<name>/`, then commit. Without an approved design, the author records assumptions. Do not split authors or re-derive the DAG.
3. Run `node "$PIPELINE_HOME"/freeze-check.mjs openspec/changes/<name> --structural` (Impact Inventory, SCEN per task, no test-only tasks; skips the R0 check, which cannot exist yet). Read `ADVISE` lines; fix blocks and re-run. `[ROUTE] handoff` here: skip R0; run Tier 2 `/paseo-handoff` on the committed spec and tasks.
4. **Dispatch `hanlin`** (`templates/reviewer.md` Mode R0) in a read-only workspace after the structural check passes on a committed contract. It returns findings, or `R0: pass(<agent-uuid>@<reviewed-sha>)`, recorded in `review.md`; accepted rulings go in `rulings.md`. **Bounded R0 (max two rounds):** revise the whole package, re-run `freeze-check --structural`, then re-dispatch. A second round passing frees CP-1; otherwise escalate the unclosed list, never a third round. A delta brief never states the expected verdict.
5. Re-run `freeze-check` without `--structural`; it rejects a missing sign-off and `STALE_R0_SIGNOFF`.
6. Present the final contract, R0 findings, DAG/scopes/Verify/acceptance. `ADVISORY_LOW_SPEEDUP` offers Tier 2; `-logical->` or `ADVISORY_READS_ONLY_EDGE` offers dropping the edge, not Tier 2. Freeze only after human confirmation. The CP-1 prompt names the executor ("确认冻结并交给主会话执行"), never just "确认冻结并启动实施".

## Start after CP-1

1. Commit the frozen contract (`openspec/changes/<change>/`) on the default branch.
2. Create the integration worktree and branch from that commit: `create_workspace(isolation, branchName: "integration/<change>")`.
3. Create one task worktree + branch per currently-ready task from the integration tip: `task/<change>/<T-id>`. Replacement attempts take `<T-id>-aN`.
4. Install the author hook in every task worktree: `node "$PIPELINE_HOME"/pipeline-run.mjs install-hook <worktree> [...]`. Without it a worker cannot stamp its own `Pipeline-Author`, and the merge gate exits 31. `plan` warns about any `task/<change>/` or `integration/<change>` worktree that is missing it.
5. Bootstrap dependencies per lockfile in every workspace — **including the integration worktree**, where `merge-task` runs Verify — before any Verify. A worktree is a checkout, not a clone; an uninstalled package exits 36. Install once per workspace, not per task.
6. Run `node "$PIPELINE_HOME"/pipeline-run.mjs plan openspec/changes/<change>` and dispatch exactly the workers it lists. The main session is an event router from here: it does not edit business code and does not schedule by reasoning.

After compaction or resume, re-read Done lines from `integration/<change>` (`git show integration/<change>:openspec/changes/<change>/tasks.md`), `git log --first-parent integration/<change>`, and `paseo ls --global --background --label pipeline.change=<change> --json` before any dispatch; summaries are not state.

## Runtime
- **Task state is the integration branch.** `merge-task` writes Done lines to `integration/<change>`; the default branch keeps the frozen contract. `plan` and `status` read `openspec/changes/<change>/tasks.md` from that branch whenever it exists, so they are safe to run from any checkout. Before CP-1 (no integration branch) they read the worktree copy. Local Done lines are evidence only if they are committed on integration.
- `pipeline-run.mjs plan <change-dir>` is the only scheduler: `DISPATCH`/`MERGE`/`WAIT`/`ATTENTION`, worker cap 8, critical path first. Execute its list; never recompute the frontier by hand.
- Dispatch a ready task to one worker (`templates/worker.md`) carrying its branch/workspace, frozen scope, SCENs, and Verify. The worker commits with `Pipeline-Role` and `Pipeline-Author` trailers.
- On a worker's finish notification, verify the branch tip and run `pipeline-run.mjs merge <change-dir> <T-id>` from the integration worktree. The gate records Done; then re-run `plan`.
- A worker that fails Verify or exceeds scope is retried on the same branch at most twice (initial commit plus two retries). After that, report to the human; do not silently spawn a second agent.
- Circuit breaker: at most 3 attempts per task (`-a2`, `-a3`); the third attempt may finish and merge, but creating a fourth requires human approval.
- A lost notification triggers `plan` reconciliation, never a duplicate dispatch. An inactive worker with commits and no pending permission proceeds to the normal merge gate; without commits, `BLOCKED_WORKER_RESULT` requires inspecting and resuming the worker or explicitly creating an approved new attempt.
- Contract amendments after CP-1: the author commits the amendment on integration; a human confirms before re-running `plan`. A new interface or security boundary needs `hanlin` R0, its `R0: pass(...)` line APPENDED to `review.md` (last line wins).

## Merge gate
```
node "$PIPELINE_HOME"/pipeline-run.mjs merge <change-dir> <task-id>
```
`pipeline-run` resolves the newest attempt branch and runs `merge-task.mjs`. The gate checks dependencies Done, Write scope, commit trailers ("Pipeline-Author"/"Pipeline-Role"), cherry-pick provenance, base drift, the frozen Verify, and regression of already-Done tasks, then no-ff merges and records Done. It proves nothing about tests beyond the frozen Verify: test quality is the FINAL review's job. Exit codes: 2 usage; 10 conflict; 20 Verify; 21 regression; 30 scope; 31 provenance; 34 base/drift; 35 dependency; 36 unchecked-out dependencies; 37 attempt/rework breaker; `--allow-attempt-over`: human only.

The gate records pending/failed tips in shared Git refs; `plan` reports `BLOCKED_MERGE` until a new tip or explicit retry; a failed empty branch may dispatch only when no worker for that attempt exists; a pending marker always blocks. Inspect the failure, fix its cause, then rerun `pipeline-run.mjs merge`. After interruption, inspect `MERGE_HEAD` and the worktree before retry. Serialize merges: refs are not locks. Never delete a marker to bypass the gate.

Exit 36: the worktree cannot resolve a package or runner (`Cannot find package 'tsx'`, `command not found`). Install per lockfile and retry; never edit tests or Verify.
Exit 21: a replayed already-Done Verify failed. If the cause is a missing service, port, package or env var rather than a real regression, fix the environment and re-run merge; never edit the Verify command or the tests.

## Finish
1. Require all tasks Done, no blocked tasks, clean integration worktree.
2. Capture full integration HEAD SHA; run the full suite and `Required=yes` acceptance on that SHA. In parallel, `anchasi` reviews `main...<full-SHA>` (Mode FINAL). Record commands, results, reviewer, verdict, SHA and main base.
3. For blockers, follow `templates/final-recovery.md`: amend the contract under human CP-1, then merge a new fix task through the normal gate. A repair task that overlaps a Done task's Write scope must declare `Depends on: <that task>`, or the structural check reports `SCOPE_CONFLICT`. Never reopen Done or merge an ad-hoc fix.
4. Rerun full suite, acceptance and FINAL review at the new final SHA. Prefer the original FINAL reviewer; if unavailable, a new `anchasi` with the same profile may take over under the same rules, recording its agent id. Verify the SHA, clean tree and reviewed main base before human CP-2. Any change invalidates that evidence.
5. After CP-2, present the cleanup list; delete/archive worktrees and branches only after human confirmation. Push needs separate confirmation.

## Recovery
```
node "$PIPELINE_HOME"/pipeline-run.mjs status <change-dir>
git log --first-parent integration/<change>
git show integration/<change>:openspec/changes/<change>/tasks.md | grep -n 'Done:'
paseo ls --global --background --label pipeline.change=<change> --json
```
Before dispatch, `plan` also checks the global agent list. Active legacy `[Pipeline]` agents without a verifiable change identity/label stop scheduling; inspect and label or close them explicitly before resuming. Unknown repository or change identity stops scheduling. Other repositories are excluded by Git common directory. Other change labels are checked via integration branches and agent worktree change directories. If absent, use `plan <change-dir> --other-change <id>` (repeatable); the label is verified, not trusted. `plan` exit 3 means unreadable or ambiguous state, not idle. Use live Paseo state, branch tips, and Done lines from `integration/<change>`. Never archive `pipeline.change=<change>` agents before CP-2.

## Hard lines
- The main session never edits business code; `gongbu`/`gaogong` authors write contract files only; `hanlin` and `anchasi` write nothing.
- No manual Done/check boxes; no full-suite Verify on non-sink tasks.
- Never treat a missing dependency as a failed test or fix it by editing tests/Verify; install in the workspace and rerun.
- No tenant/database/port/account sharing without declared isolation.
