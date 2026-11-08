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
2. **Deterministic scheduling, not an LLM.** `pipeline-run.mjs` computes frontier, capacity and merge order; execute its plan.
3. **One worker per task, closed loop.** A worker writes tests and implementation, runs the frozen narrow Verify, commits, and returns. Either order is allowed.
4. **Vertical slices.** Behavior, wiring, affected fixtures, and tests belong together. No fixture-only/wiring-only tasks. Wave 0 only for a genuinely shared contract and actual consumers.
5. **Narrow Verify.** Every non-sink task names a scope-local test/spec command. Full suite runs only at the unique sink and final acceptance.
6. **Heterogeneous gates at the ends.** R0 reviews the contract before CP-1; one independent FINAL conformance verdict judges the integrated result against the frozen contract. The middle is mechanical: Verify, scope, dependencies, drift.
7. **Git is state; Paseo is transport.** Shared Git refs record interrupted or failed merge tips. No coordination service, lease, lock, or custom agent runner.
8. **Human gates.** CP-1 freezes the approved contract. CP-2 confirms merge to main. No push/destructive cleanup without explicit approval.

## Roles and briefs
Before `create_agent`, copy matching `list_profiles` settings exactly; if none fits, verify provider/model via `list_providers`/`list_models` or stop if not returned. Never copy model IDs from examples or memory. Titles: `[Pipeline] <role> <T-id>[-aN]` for workers (include attempt suffix), `[Pipeline] <role> <mode>` for authors/reviewers; stage suffixes are display only. Keep titles within 60 characters; identify changes by label. Dispatch natively with `pipeline.change=<change>` on each agent. Finish notification is delivery, not parent wake; reconcile Paseo/Git. On timeout inspect and re-arm. CLI `paseo run/send` has no callback; pair with background `paseo wait <id> --timeout 540`. Reuse `templates/author.md`, `templates/worker.md`, `templates/reviewer.md`; add only change inputs and risks. Generated local-task briefs are convenience metadata; verify against pinned commit.

- `gongbu` (author): on the contract stage, writes the whole package in one pass. Its `notes` describe implementation; authoring is a separate job assignment, not a second role.
- `hanlin` (R0): independent package review before CP-1 (incl. oracle).
- `gongbu` / `jiangzuo` / `gaogong` (worker): implementation and tests for one task.
- `anchasi` (FINAL): the single integrated conformance verdict.
- `gaogong` (fixer): narrow repair of a confirmed FINAL-review blocker.
- `ceshi` and `shangshu` are retired. A legacy branch may still carry a `ceshi` commit for merge compatibility; never dispatch either.
- Profile notes describe a role's scope; the frozen task's `Review:` field no longer selects a process. It stays as risk metadata for the contract stage.

## Entry and CP-1

Contract steps are serial.

0. **Preflight** (read-only): `node "$PIPELINE_HOME"/preflight.mjs <repo>` reports each package's test runner and whether a UI package can run DOM tests. Fix a missing DOM environment before authoring — the expensive late failure.
1. Run `openspec new change <name> --schema paseo-pipeline`. The schema resolves from the global OpenSpec schema link installed by `install.sh`; do not keep stale project-local copies that shadow it.
2. **One author, one pass** (`gongbu`, `templates/author.md`). Brief gives workspace, baseline SHA, `PIPELINE_HOME`, exact preflight and structural commands, confirmed decisions and references; main session also supplies project constants and at most 5 pending decisions with defaults. Preflight is read-only; success does not authorize later commands. Any required-command denial means `BLOCKED`: report command, cwd, denial and next action; never retry elsewhere. Read schema templates; write and commit OpenSpec package in assigned workspace. Run the structural check as soon as package exists; report structural command/outcome/exit separately from route. No digest/survey; cite evidence `path:line`; depth follows risk. Record assumptions; do not split authors or pad DAG. Assess baseline drift.
3. Return `COMPLETE`/`BLOCKED`/`INCOMPLETE`, workspace, SHAs, check/result/exit, blockers and next action. `COMPLETE` requires structural success on committed content. Reconcile Git/evidence before R0; run structural `freeze-check.mjs`, resolve `ADVISE`, preserve scope/DAG. Reproduce suspected bugs; never invent ownership or dependencies. Handoff route is valid only with author `COMPLETE`, structural exit 0/no blocks and matching checked/reported commit SHA. Route alone clears no BLOCK, later failure, or Git/evidence mismatch; route/check success is not R0/CP-1. Then skip R0 and use Tier 2 `/paseo-handoff`.
4. **Resolve human choices before R0.** Return open questions that require human choice, with options and consequences; Ordinary assumptions need not block. If a decision would materially change the contract, get authorization, commit the corrections with authorization and review the new SHA. This does not replace CP-1. **Dispatch `hanlin`** (`templates/reviewer.md`, Mode R0) read-only. Pin full reviewed commit SHA for both contract and code. Give confirmed decisions and authoritative input sources/versions. External inputs need an approved fixed snapshot, source and content hash; verify the hash before and after review; stop and escalate rather than use a dirty or untracked copy silently. `freeze-check` do not bind or check external snapshots. Read-only is reviewer protocol unless OS permissions enforce it. Pass: `R0: pass(<agent-uuid>@<reviewed-sha>)` in `review.md`; rulings: `R0-<round>-<n> <BLOCKER|NIT> <accepted|rejected|fixed> <one-line reason>`. **Bounded R0:** max two rounds — at most two whole-package rounds; round 1 reports all blockers, round 2 checks fixes, not fresh survey, and never regenerate the package by default. Recorded NITs are not fixed before CP-1 unless behavior, persistence/security or Verify trust changes. Never pre-state verdict.
5. **Close R0 before CP-1.** Pass frees CP-1. After round 2 blockers, human may accept risk (`R0: human-accept(@<sha>)` in `review.md`; open item and reason in `rulings.md`; record `Approval: R0 residual risk accepted for <sha> — <reason>` in `run-log.md`) or direct a fix; the same `hanlin` verifies the fix diff only. No round 3; real defects block. The human exception is never written as a reviewer pass; its approval in `run-log.md` is what `freeze-check` accepts. `freeze-check` rejects missing/stale/unsupported sign-off. Output is not execution authorization: dispatch only after human CP-1 for that exact contract commit is in `run-log.md`.
6. Present final contract, R0 findings, DAG/scopes/Verify/acceptance. `ADVISORY_LOW_SPEEDUP` offers Tier 2; `-logical->` or `ADVISORY_READS_ONLY_EDGE` offers dropping the edge. Freeze only after human confirmation. CP-1 prompt names executor ("确认冻结并交给主会话执行"), never just "确认冻结并启动实施".

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
- `pipeline-run.mjs plan <change-dir>` is the only scheduler: `DISPATCH`/`MERGE`/`WAIT`/`ATTENTION`, worker cap 8, critical path first. Execute its list; never recompute the frontier by hand. Without an `integration/<change>` branch it prints `PLANNING PREVIEW` and `frozen: false`: the DAG is plannable but nothing may be dispatched until freeze and CP-1.
- Dispatch a ready task to one worker (`templates/worker.md`) carrying its branch/workspace, frozen scope, SCENs, Verify and the upstream interfaces it consumes. The worker reads its packet, not the whole contract history. The worker commits with `Pipeline-Role` and `Pipeline-Author` trailers.
- On a worker's finish notification, verify the branch tip and run `pipeline-run.mjs merge <change-dir> <T-id>` from the integration worktree. The gate records Done; then re-run `plan`.
- A worker failing Verify or exceeding scope may retry on the same branch twice after the initial try; then report to the human. Circuit breaker is task attempts, not commits: at most 3 branches (`-a2`, `-a3`); a fourth needs human approval.
- A lost notification triggers `plan` reconciliation from Paseo and Git state, never a duplicate dispatch. After every dispatch, register a reconciliation point — agent id, branch, expected first artifact — and at that point compare Paseo state with the branch tip and Done lines before re-arming. An inactive worker with commits and no pending permission proceeds to the normal merge gate; without commits, `BLOCKED_WORKER_RESULT` requires inspecting and resuming the worker or explicitly creating an approved new attempt. Only state proving the attempt dead justifies a new dispatch.
- Contract amendments after CP-1: the author commits the amendment on integration; a human confirms, or a recorded pre-authorization covers it (`final-recovery.md`), before `plan`. A new interface or security boundary needs `hanlin` R0 (delta-only), its `R0: pass(...)` line APPENDED to `review.md` (last line wins).

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
   Before CP-2, `node "$PIPELINE_HOME"/pipeline-run.mjs acceptance check openspec/changes/<name> --evidence <file>` checks the record against current clean integration HEAD and frozen matrix without executing commands; run at the reviewed SHA, before record commits. This checks consistency, not authenticity or semantic correctness: records can be manipulated, Git cleanliness ignores ignored files and external dependencies, and transients may go undetected. Independently review output, full-suite and FINAL evidence. A record never authorizes CP-2 or replaces human confirmation.
3. FINAL is a conformance matrix (per SCEN, acceptance row, named standard); a blocker needs a row and counterexample. Ledger in `review.md`; per `final-recovery.md`: DEVIATION → one batched repair wave (amend under CP-1 or recorded pre-authorization; a repair overlapping a Done task declares `Depends on: <that task>`, or `SCOPE_CONFLICT`); CONTRACT_GAP → human; ENHANCEMENT → backlog. Before calling a failure a regression, count `git rev-list --count $(git merge-base integration/<change> main)..main`; if main moved, rebase, re-run the failing row, log count and SHA in `run-log.md`.
4. **Bounded FINAL:** max two rounds — full, then delta only — same `anchasi` (replacement inherits both). After round 2 with any NOT_MET/UNVERIFIABLE the human chooses: accept risk (`FINAL: human-accept(@<sha>)` in `review.md`, reason in `rulings.md`, `Approval: FINAL residual risk accepted for <sha> — <reason>` in `run-log.md`), reopen once at contract level (delta R0 + CP-1, one wave, one reopen delta round), or terminate. Later commits touch only `review.md`, `rulings.md`, `run-log.md`.
5. After CP-2, **archive the change into the main specs** so the next change has a baseline: `openspec archive <change>` applies the spec deltas to `openspec/specs/`. Run it on the merged main, review the applied result, record it in `run-log.md`; `--skip-specs` only for changes with no specs. This keeps specs and code from drifting apart now that changes no longer hand-maintain main specs.
6. After CP-2, present the cleanup list; delete/archive worktrees and branches only after human confirmation. Push needs separate confirmation.

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
