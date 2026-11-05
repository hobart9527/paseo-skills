---
name: paseo-pipeline
description: SDD concurrent delivery pipeline for changes with real DAG concurrency. OpenSpec owns contracts; Paseo owns agents/workspaces; git owns state. Scripts schedule; workers close tasks; two heterogeneous gates guard the ends.
user-invocable: true
---

# Paseo Pipeline

Use only when the frozen DAG has `maxWidth >= 2` and `tasks >= 4`; otherwise Tier 2 `/paseo-handoff`. Never split to qualify.
`maxWidth` is the largest dispatch-dependency wave, a routing heuristic, not exact graph concurrency. Waves do not constrain dispatch. Weighted estimates use planning weights, not observed durations.
An invalid task graph has no routing estimate: `freeze-check` emits `[ROUTE] invalid` and JSON `route: null`, not `pipeline` or `handoff`. Fix graph errors before routing. Other contract blocks still prevent freeze even when a graph route is shown.

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
Before `create_agent`, copy the matching `list_profiles` settings exactly; if none fits, verify the exact provider/model via `list_providers`/`list_models` or stop if not returned. Never copy model IDs from examples or memory. `create_agent` needs a non-empty `title` (`[Pipeline] <role> <T-id>[-aN]` for workers (include the attempt suffix from the branch), `[Pipeline] <role> <mode>` for authors/reviewers; keep titles within 60 characters and use the label, not the title, for change identity). Dispatch natively (set `pipeline.change=<change>` on every pipeline agent; the finish notification is delivery, not an idle-parent wake, so reconcile against Paseo and Git state); on timeout, inspect and re-arm. CLI `paseo run/send` registers no finish callback; a CLI dispatch MUST be paired with a background `paseo wait <id> --timeout 540`. Briefs: `templates/author.md`, `templates/worker.md`, `templates/reviewer.md`. Reuse the relevant template in dispatch; add only this change's inputs and risks rather than duplicating its checklist. Any generated brief that reads local tasks is convenience metadata, not evidence of the pinned commit; verify it against that commit before use.

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
3. Before R0, present open questions that require human choice and could materially change the contract. Record the decisions and update the package as needed, then commit the resulting contract with authorization and run the structural check. Ordinary assumptions need not block; surface later discoveries when necessary. This does not replace CP-1.
4. Run `node "$PIPELINE_HOME"/freeze-check.mjs openspec/changes/<name> --structural` (Impact Inventory, SCEN per task, no test-only tasks; skips the R0 check, which cannot exist yet). Read `ADVISE` lines; fix blocks and re-run. If fixes change the contract, commit the corrections with authorization and review the new SHA, not the previous commit. `[ROUTE] handoff` here: skip R0; run Tier 2 `/paseo-handoff` on the committed spec and tasks.
5. **Dispatch `hanlin`** (`templates/reviewer.md` Mode R0) after the structural check passes on a committed contract. Pin the full reviewed commit SHA for both contract and code; prefer a separate workspace at that commit. Specify the authority and exact version of each input, including the approved request/design and relevant ADRs. For committed inputs, use that commit, not another checkout. If authoritative input is not in that SHA, supply an accessible, fixed snapshot with its source, human approval where applicable, and content hash; verify the hash before and after review, record these with the R0 evidence, and give the same snapshot to the reviewer. If that cannot be done, stop and escalate rather than use a dirty or untracked copy silently; never commit user files without authorization. Reconcile disagreements between inputs before review. Read-only is a reviewer protocol unless OS permissions enforce it; workspace separation alone does not enforce it. The R0 SHA sign-off and `freeze-check` do not bind or check external snapshots: independently verify their identity and drift before CP-1, and re-review or escalate if authority or contents change. It returns findings, or `R0: pass(<agent-uuid>@<reviewed-sha>)`, recorded in `review.md`; accepted rulings go in `rulings.md`, one line per R0 finding: `R0-<round>-<n> <BLOCKER|NIT> <accepted|rejected|fixed> <one-line reason>`. This is a retrospective record of R0 findings, not a gate. **Bounded R0 (max two rounds):** revise the whole package, re-run `freeze-check --structural`, then re-dispatch. A second round passing frees CP-1; otherwise escalate the unclosed list, never a third round. A delta brief never states the expected verdict.
6. Re-run `freeze-check` without `--structural`; it rejects a missing sign-off and `STALE_R0_SIGNOFF`.
7. Present the final contract, R0 findings, DAG/scopes/Verify/acceptance. `ADVISORY_LOW_SPEEDUP` offers Tier 2; `-logical->` or `ADVISORY_READS_ONLY_EDGE` offers dropping the edge, not Tier 2. Freeze only after human confirmation. The CP-1 prompt names the executor ("确认冻结并交给主会话执行"), never just "确认冻结并启动实施".

## Start after CP-1

1. Commit the frozen contract (`openspec/changes/<change>/`) on the default branch.
2. Create the integration worktree from that commit: `create_workspace(isolation: "worktree", mode: "branch-off", branchName: "integration/<change>", baseBranch: "refs/heads/main", path: <主仓库路径>)`. Modes are exclusive: `branch-off` takes only `branchName` + `baseBranch` (optional `worktreeSlug`/`path`), never `branch`, `prNumber`, or `forge`; on conflict, drop extras and retry once. `origin/main` when pushed; `refs/heads/main` while the base stays local.
3. Create one task worktree + branch per currently-ready task from the integration tip: `task/<change>/<T-id>`. Replacement attempts take `<T-id>-aN`.
4. Install the author hook in every task worktree: `node "$PIPELINE_HOME"/pipeline-run.mjs install-hook <worktree> [...]`. Without it a worker cannot stamp its own `Pipeline-Author`, and the merge gate exits 31. `plan` warns about any `task/<change>/` or `integration/<change>` worktree that is missing it.
5. Bootstrap dependencies per lockfile in every workspace — **including the integration worktree**, where `merge-task` runs Verify — before any Verify. A worktree is a checkout, not a clone; an uninstalled package exits 36. Install once per workspace, not per task.
6. Run `node "$PIPELINE_HOME"/pipeline-run.mjs plan openspec/changes/<change>` and dispatch exactly the workers it lists. The main session is an event router: it edits no business code and schedules only from `plan`.

After compaction or resume, re-read Done lines from `integration/<change>` (`git show integration/<change>:openspec/changes/<change>/tasks.md`), `git log --first-parent integration/<change>`, and `paseo ls --global --background --label pipeline.change=<change> --json` before any dispatch; summaries are not state.

## Runtime
- **Task state is the integration branch.** `merge-task` writes Done lines to `integration/<change>`; the default branch keeps the frozen contract. `plan` and `status` read that `tasks.md` from the branch when it exists, so they are checkout-safe. Before CP-1 (no integration branch) they read the worktree copy. Local Done lines are evidence only if they are committed on integration.
- `pipeline-run.mjs plan <change-dir>` is the only scheduler: `DISPATCH`/`MERGE`/`WAIT`/`ATTENTION`, worker cap 8, critical path first. Execute its list; never recompute the frontier by hand.
- Dispatch a ready task to one worker (`templates/worker.md`) carrying its branch/workspace, frozen scope, SCENs, and Verify. The worker commits with `Pipeline-Role` and `Pipeline-Author` trailers.
- On a worker's finish notification, verify the branch tip and run `pipeline-run.mjs merge <change-dir> <T-id>` from the integration worktree. The gate records Done; then re-run `plan`.
- A worker failing Verify or exceeding scope retries on the same branch at most twice (initial plus two retries); then report to the human and do not silently spawn a second agent.
- Circuit breaker: at most 3 attempts per task (`-a2`, `-a3`); the third attempt may finish and merge, but creating a fourth requires human approval.
- A lost notification triggers `plan` reconciliation from Paseo and Git state, never a duplicate dispatch. After every dispatch, register a reconciliation point — agent id, branch, expected first artifact — and at that point compare Paseo state with the branch tip and Done lines before re-arming. An inactive worker with commits and no pending permission proceeds to the normal merge gate; without commits, `BLOCKED_WORKER_RESULT` requires inspecting and resuming the worker or explicitly creating an approved new attempt. Only state proving the attempt dead justifies a new dispatch.
- Contract amendments after CP-1: the author commits the amendment on integration; a human confirms before re-running `plan`. A new interface or security boundary needs `hanlin` R0, its `R0: pass(...)` line APPENDED to `review.md` (last line wins).

## Merge gate
```
node "$PIPELINE_HOME"/pipeline-run.mjs merge <change-dir> <task-id>
```
`pipeline-run` resolves the newest attempt branch and runs `merge-task.mjs`. The gate checks dependencies Done, Write scope, commit trailers ("Pipeline-Author"/"Pipeline-Role"), cherry-pick provenance, base drift, the frozen Verify, and regression of already-Done tasks, then no-ff merges and records Done. Hand merges into a primary checkout: `--no-ff`, or the Stop tier gate counts a fast-forward as this session's writes. It proves nothing about tests beyond the frozen Verify: test quality is the FINAL review's job. Exit codes: 2 usage; 10 conflict; 20 Verify; 21 regression; 30 scope; 31 provenance; 34 base/drift; 35 dependency; 36 unchecked-out dependencies; 37 attempt/rework breaker; `--allow-attempt-over`: human only.

The gate records pending/failed tips in shared Git refs; `plan` reports `BLOCKED_MERGE` until a new tip or explicit retry; a failed empty branch may dispatch only when no worker for that attempt exists; a pending marker always blocks. Inspect the failure, fix its cause, then rerun `pipeline-run.mjs merge`. After interruption, inspect `MERGE_HEAD` and the worktree before retry. Serialize merges: refs are not locks. Never delete a marker to bypass the gate.

Exit 36: the worktree cannot resolve a package or runner (`Cannot find package 'tsx'`, `command not found`). Install per lockfile and retry; never edit tests or Verify.
Exit 21: a replayed already-Done Verify failed. If the cause is a missing service, port, package or env var rather than a real regression, fix the environment and re-run merge; never edit the Verify command or the tests.

## Finish
1. Require all tasks Done, no blocked tasks, clean integration worktree.
2. Capture full integration HEAD SHA; run the full suite and `Required=yes` acceptance on that SHA. In parallel, `anchasi` reviews `main...<full-SHA>` (Mode FINAL). Record commands, results, reviewer, verdict, SHA and main base. Optional aid: `r0-hotspots.mjs <change-dir> [--final <full-SHA>]` summarizes declared task metadata for R0 or FINAL; it is not a verdict.
   The committed frozen `acceptance.md` remains the sole authority for requirements. Keep its Result/Evidence cells frozen; record results externally so the tested SHA is unchanged. Optional operator command: `node "$PIPELINE_HOME"/pipeline-run.mjs acceptance run openspec/changes/<name> --source <full-SHA> --evidence <new-external-file> --execute`. This executes repository-controlled shell code with operator privileges, unsandboxed; review every command and dependency first. Output may contain secrets. The external file must not exist or sit inside any worktree or Git directory. Each command times out after 120000 ms by default (`--timeout <ms>`, 1–3600000). It records the frozen matrix, SHA, timeout, rows, output and exit status; failures, timeouts, overflow, or drift invalidate it. The runner reports unsuccessful executions as `FAIL`, including missing dependencies; it does not infer `BLOCKED`. An operator may classify a failure as blocked separately without altering the execution record. Neither a failed nor a blocked row satisfies CP-2; fix the cause and rerun into a new file. It does not run the full suite or FINAL review.
   Before CP-2, `node "$PIPELINE_HOME"/pipeline-run.mjs acceptance check openspec/changes/<name> --evidence <file>` checks the record against current clean integration HEAD and frozen matrix without executing commands. This checks consistency, not authenticity or semantic correctness: records can be manipulated, Git cleanliness ignores ignored files and external dependencies, and transient changes may go undetected. Independently review output, full-suite and FINAL evidence, and current state. A record never authorizes CP-2 or replaces human confirmation.
3. For blockers, follow `templates/final-recovery.md`: amend the contract under human CP-1, then merge a new fix task through the normal gate. A repair task that overlaps a Done task's Write scope must declare `Depends on: <that task>`, or the structural check reports `SCOPE_CONFLICT`. Never reopen Done or merge an ad-hoc fix. Before calling a failure a regression, compare the base the reviewer used with current `main`: `git merge-base integration/<change> main` and `git rev-list --count <base>..main`. If main moved, rebase integration onto it, re-run the frozen Verify and the failing acceptance row, and only then decide whether the failure survives as a real regression. Record the two counts and the rebase SHA in `run-log.md`.
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
`plan` and `status` also exit 3 and report parser errors for invalid or empty `tasks.md`; repair the contract instead of treating that as an idle frontier.

## Approvals for destructive steps

Before any destructive or production step — deploy, `archive_workspace`, deleting branches or worktrees, cleaning `/tmp`, a production database read — emit an object list, not a summary sentence: workspace IDs, branch names, host paths, and the exact command per object. Then ask for confirmation and write the user's approval verbatim into `openspec/changes/<change>/run-log.md` (append `Approval: <timestamp> <the user's words>`). After compaction the file, not the conversation, is the authority: re-read it before executing, and re-ask when the recorded approval does not cover an object or differs from the command about to run. A broader approval never covers a new object. Shape and record fields: `templates/approvals.md`.

## Hard lines
- The main session never edits business code; `gongbu`/`gaogong` authors write contract files only; `hanlin` and `anchasi` write nothing.
- No manual Done/check boxes; no full-suite Verify on non-sink tasks.
- Never treat a missing dependency as a failed test or fix it by editing tests/Verify; install in the workspace and rerun.
- No tenant/database/port/account sharing without declared isolation.
