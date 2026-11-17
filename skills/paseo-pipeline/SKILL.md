---
name: paseo-pipeline
description: Tier 3 concurrent delivery — main session's rough DAG has ≥4 tasks and maxWidth≥2. OpenSpec contract, worktree-isolated workers, scripted merge gates, human CP-1/CP-2.
user-invocable: true
---

# Paseo Pipeline

Enter from the main session's rough DAG (task IDs, dependencies, one-line goal) with `tasks >= 4` and `maxWidth >= 2` (thresholds: `~/.claude/CLAUDE.md`); never split a graph to qualify. `maxWidth` is the largest dispatch-dependency wave, a routing heuristic. The `hanlin` author refines that DAG; after authoring, `freeze-check` is authoritative: route `handoff` goes to Tier 2, route `pipeline` continues here, an invalid DAG has no route until its graph errors are fixed.

Every SHA-bound record (structural check, R0, FINAL, acceptance evidence, approval) is **pinned**: it holds for that exact commit only, and a new SHA needs a fresh check or a delta review.

## Principles

- Ready tasks run in separate worktrees; no Lead, per-task reviewer, or wave barrier.
- `pipeline-run.mjs plan` computes frontier, capacity and merge order; dispatch exactly what it lists.
- One worker owns each vertical task slice: tests, implementation, frozen narrow Verify and commit. Non-sink Verify is scope-local; the full suite runs at the sink and at FINAL.
- R0 reviews the contract before CP-1; independent FINAL checks integrated conformance. Middle gates are mechanical.
- Git refs hold state; Paseo transports agents. Human owns CP-1, CP-2, push and destructive approval. Author, test and worker commits on non-default branches in worktrees are pre-authorized (`~/.claude/CLAUDE.md` Stop points); proceed without asking.

## Roles

Resolve provider/model/modeId/thinking with `list_profiles` at dispatch; model IDs live only there.

| Profile | Scope |
|---|---|
| 中书 `chanpin` | Read-only research and Proposal. |
| 翰林 `hanlin` | Contract author (whole package, writes only `openspec/changes/<change>/`); R0 reviewer and arbiter in a separate read-only session. |
| 测试 `ceshi` | Red tests first on hard-risk or `Review: strict` tasks; writes test files inside the task's Write scope only. |
| 工部 `gongbu` | Core implementation within assigned Write scope. |
| 高工 `gaogong` | Complex, cross-module, concurrency, or rework after reviewer pushback. |
| 将作 `jiangzuo` | UI/UX. |
| 按察司 `anchasi` | Independent read-only audit; heterogeneity per profile notes. |
| 尚书 `shangshu` | Tier 3 orchestration and reconciliation, read-only; main session may orchestrate instead. |

`Review:` is risk metadata; it selects `ceshi` for strict tasks and nothing else. Stage rules: `templates/author.md`, `templates/worker.md`, `templates/reviewer.md`.

## Tools

All under `$PIPELINE_HOME` (set by `install.sh`). Each prints usage on bad arguments.

| Script | When |
|---|---|
| `preflight.mjs <repo>` | Before authoring: read-only capability probe (test env, lockfiles). |
| `namespace.mjs <change-dir>` | Author, before specs: SCEN prefixes and requirement headings already in use. |
| `freeze-check.mjs <change-dir> --structural` | Author and main session: structural gate and route; without `--structural` also checks R0 sign-off. |
| `pipeline-run.mjs plan\|status <change-dir>` | After CP-1: next dispatches and merges; current state. |
| `pipeline-run.mjs merge <change-dir> <T-id>` | From the integration worktree after a worker reports. |
| `pipeline-run.mjs install-hook <worktree>...` | Start step 2. |
| `pipeline-run.mjs scenarios <change-dir>` | When SCEN claims and acceptance rows may disagree (read-only). |
| `pipeline-run.mjs acceptance run\|check <change-dir> --evidence <file>` | FINAL step 1; operator rules in `templates/approvals.md`. |
| `pipeline-run.mjs cleanup <change-dir>` | After CP-2: lists objects and commands; executes nothing. |
| `r0-hotspots.mjs <change-dir>` | Optional reviewer metadata; never a verdict. |

## Entry and CP-1

Contract work is serial.

1. Run `preflight.mjs` and create an OpenSpec change with schema `paseo-pipeline`. Dispatch one `hanlin` author with one author workspace, baseline SHA, `PIPELINE_HOME`, preflight/structural commands, project constants, confirmed decisions and the rough DAG.
2. Author follows `templates/author.md` and returns a pinned structural result. The author stops at minute 25; if no report arrives by minute 30, reconcile Paseo status with the author branch `git log` once instead of polling.
3. Route `handoff` qualifies only with author `COMPLETE`, structural exit 0 with no blocks, and matching checked/reported SHA; then `/tier2-handoff` (tasks become `Slices` unchanged) and `/paseo-handoff`. A route is never R0 or CP-1.
4. Resolve material human choices, then dispatch `hanlin` read-only R0 using `templates/reviewer.md` on the whole package. Maximum two package rounds (second is delta). After unresolved blockers, human accepts recorded risk or directs one fix with a delta check.
5. Present contract, findings, DAG/scopes/Verify/acceptance and route. Human confirms CP-1 for the exact contract commit; freeze only after that. CP-1 approves the contract and its commit to the default branch (Start step 1), nothing later. R0 sign-off is `R0: pass(<reviewer-uuid>@<sha>)` or recorded `R0: human-accept(@<sha>)`; human-accept is never a reviewer pass.

## Start and execute after CP-1

1. Commit the frozen contract on the default branch. Create the integration worktree from it and one task worktree/branch per ready task.
2. In every worktree, including integration, install lockfile dependencies and the author hook (`pipeline-run.mjs install-hook <worktree>...`) before Verify. The hook stamps `Pipeline-Author` from `PASEO_AGENT_ID`. Installation enables `extensions.worktreeConfig` in shared repository config and points the worktree's `core.hooksPath` at the skill hooks, replacing the whole hooks directory: first inspect the effective `core.hooksPath` and existing hooks (default directory included); if any would be displaced, ask the human.
3. Run `plan` and dispatch exactly the listed workers, one per task, with branch, workspace, frozen Write scope, SCENs, Verify and upstream interfaces. For a hard-risk or `Review: strict` task, dispatch `ceshi` first on the same branch as `[Pipeline] ceshi <T-id> <change>`: it commits Red tests inside the task's Write scope, holds the task while it runs, and the next `plan` lists the worker. Worker follows `templates/worker.md`, commits required trailers and reports branch tip.
4. On completion, verify the tip, run `merge` from integration, then rerun `plan`. The gate checks dependencies, scope, provenance, drift, Verify and regression, then records Done. A failed worker may retry twice; a fourth branch needs human approval.
5. At each dispatch, register a reconciliation point (agent id, branch, expected first artifact). On lost notification or resume, reread integration Done lines, first-parent log and labeled Paseo agents, and reconcile Paseo state, Git tip and Done lines before re-arming; never duplicate dispatch.
6. Contract amendments after CP-1 need human confirmation or an applicable recorded pre-authorization before planning; a new interface or security boundary needs delta R0.

Gate failures, exit codes and interrupted merges: `templates/approvals.md` § Operator reference.

## FINAL and CP-2

1. Require all tasks Done, nothing blocked and a clean integration worktree. Capture the full SHA; run the full suite and every `Required=yes` acceptance row at that SHA. Dispatch `anchasi` for independent FINAL on `main...<full-SHA>` using `templates/reviewer.md`. For a suspected regression, compare main movement with `git rev-list --count $(git merge-base integration/<change> main)..main`; rebase and rerun the failing row if needed.
2. FINAL is requirement conformance recorded in `review.md`. `DEVIATION` alone may enter one batched repair wave; a repair overlapping Done scope declares `Depends on`, or freeze-check reports `SCOPE_CONFLICT`. Contract/requirement gaps need human disposition before CP-2; `ENHANCEMENT` is backlog.
3. Maximum two FINAL rounds: full then delta. After unresolved `NOT_MET`/`UNVERIFIABLE`, the human picks from `templates/approvals.md` § FINAL after round 2.
4. Before CP-2, confirm evidence is pinned to the reviewed SHA, no unaccepted row remains, and the human has reviewed final diff/evidence. CP-2 authorizes merge only.
5. After CP-2, list objects with `cleanup`, get per-object approval (`templates/approvals.md` § Destructive or production action), archive approved spec deltas on merged main. Push is its own approval.

## Hard lines

- Main session does not edit business code; workers stay within Write scope; the `hanlin` author writes only the change directory; R0 `hanlin` and `anchasi` write nothing.
- Missing dependencies are environment faults: install per lockfile; Verify and tests stay as frozen.
- Destructive cleanup, push and merge go through their gates and approvals, never around them.
