---
name: paseo-pipeline
description: Tier 3 concurrent delivery — after read-only Recon, rough DAG has ≥4 tasks and maxWidth≥2. Progressive OpenSpec contract, worktree-isolated workers, scripted gates, human CP-1/CP-2.
user-invocable: true
---

# Paseo Pipeline

Enter after read-only Recon (`rg` or `chanpin` via `brief.mjs recon`) confirms `tasks >= 4`, `maxWidth >= 2` (`~/.claude/CLAUDE.md`); never split to qualify. `hanlin` refines the DAG; `freeze-check` owns routing (`handoff` → Tier 2 without rewriting specs/tasks; `pipeline` continues).

Structural check, R0, FINAL, acceptance and approval are **pinned** to exact commits; a new SHA needs a fresh check or delta review.

## Principles

- Ready tasks run in separate worktrees; no Lead, per-task reviewer, or wave barrier.
- `pipeline-run.mjs plan` computes frontier, capacity and merge order; dispatch via `brief.mjs` using its role/branch/title/label.
- One worker owns each vertical task slice: tests, implementation, frozen narrow Verify, `worker-check` and commit. Full suite runs at sink and FINAL.
- R0 checks frozen boundaries before CP-1; independent FINAL checks integrated conformance. Middle gates are mechanical.
- Git refs hold state; Paseo transports agents. Human owns CP-1, CP-2, push and destructive approval. Commits on non-default branches in worktrees are pre-authorized; proceed without asking.

## Roles

Resolve provider/model/modeId/thinking via `list_profiles` at dispatch (`lib/roles.mjs` is sole role registry).

| Profile | Scope |
|---|---|
| 调研（中书） `chanpin` | Read-only Recon (`templates/recon.md`) and Proposal facts, no product/contract writes. |
| 架构（翰林） `hanlin` | Architecture, requirements, contract author (writes only `openspec/changes/<change>/`) and arbiter; not its own R0. |
| 测试 `ceshi` | Independent Red only for explicit `Review: strict`; task-scoped test paths; files immutable to downstream worker. |
| 开发（工部） `gongbu` | Default owner of tests and implementation within assigned Write scope. |
| 攻坚（高工） `gaogong` | Complex implementation (`Est: L` / `Risk-surface`) and bounded rework, not architecture replanning. |
| 界面（将作） `jiangzuo` | UI specialization plus UI skill; selected when task scope is UI-focused. |
| 审查（按察司） `anchasi` | Independent code audit (`FINAL` / Tier 2); review intent is not a read-only permission guarantee. |
| 契约审查（Neon） `neon` | Independent read-only R0 (cannot review if same-family `chanpin` drafted Proposal). |
| 协调（尚书） `shangshu` | Optional thin Tier 3 dispatch and reconciliation; main session is default. |

`Review: strict` selects independent Red tests; risk alone adds no tester. Render briefs with `brief.mjs <recon|author|revise|r0|tester|worker|final|tier2|tier2-review>` (backed by `templates/{author,tester,worker,reviewer}.md` and `templates/recon.md`).

## Tools

All under `$PIPELINE_HOME` (set by `install.sh`). Each prints usage on bad arguments.

| Script | When |
|---|---|
| `profiles-check.mjs [--skill F] [--config F]` | Read-only lint: role mapping, notes fields, family pairs, antigravity `diff-check`. |
| `preflight.mjs <repo>` | Before authoring: read-only capability probe (test env, lockfiles). |
| `namespace.mjs <change-dir>` | Author, before specs: SCEN prefixes and requirement headings already in use. |
| `brief.mjs <role> --change <name> --repo <path>` | Before every agent dispatch: renders exact role prompt from frozen contract. |
| `freeze-check.mjs <change-dir> --structural` | Structural gate and route; without `--structural` also checks R0 sign-off. |
| `pipeline-run.mjs acceptance sync <change-dir>` | Derive/update `acceptance.md` from `specs/` + `tasks.md`. |
| `pipeline-run.mjs plan\|status <change-dir>` | After CP-1: next dispatches and merges; current state. |
| `pipeline-run.mjs worker-check <change-dir> <T-id>` | Worker before reporting: scope, trailers, `ceshi` Red immutability, Verify. |
| `pipeline-run.mjs merge <change-dir> <T-id>` | From integration worktree after worker passes `worker-check`. |
| `pipeline-run.mjs tier2-verify <base>` | Unified Tier 2 delivery gate (OpenSpec + Verify rerun + `risk-scan`). |
| `pipeline-run.mjs install-hook <worktree>...` | Start step 2. |
| `pipeline-run.mjs acceptance run\|check <change-dir> --evidence <file>` | FINAL step 1; operator rules in `templates/approvals.md`. |
| `pipeline-run.mjs risk-scan <base> [<head>]` | Diff scan for 5 risk classes + weakened test assertions. |
| `pipeline-run.mjs cleanup <change-dir>` | After CP-2: lists objects and commands; executes nothing. |

## Entry and CP-1

Contract work is serial.

1. Run `preflight.mjs` and create an OpenSpec change with schema `paseo-pipeline`. Dispatch `hanlin` (`brief.mjs author`) with author workspace, baseline SHA, `PIPELINE_HOME`, preflight/structural commands, constants, confirmed decisions and rough DAG.
2. Author writes `proposal.md` + `specs/` and runs `freeze-check --structural --stage specs` first to catch open hard decisions early, then projects `acceptance.md` via `acceptance sync` and returns a pinned structural result. Stop exhausted authors cleanly on step/budget stall and reconcile author branch `git log` once instead of polling.
3. Route `handoff` qualifies only with author `COMPLETE`, structural exit 0 with no blocks, and matching checked/reported SHA; run `/tier2-handoff` (existing `SCEN`/`**Verify:**` and tasks stay valid) and `/paseo-handoff`.
4. Resolve material human choices. Dispatch independent `neon` (`brief.mjs r0`, never the author or Proposal contributor) for read-only R0 in a separate workspace. Keep stage title `[Pipeline] neon R0` or `[Pipeline] hanlin R0`; reconcile before/after HEAD, tracked diff and untracked files. Maximum two package rounds (full then delta); unresolved blockers go to human risk acceptance or termination — no third R0 round.
5. Present contract, findings, DAG/scopes/Verify/acceptance and route. Human confirms CP-1 for the exact contract commit; freeze only after that. CP-1 approves the contract and its commit to the default branch (Start step 1), nothing later. R0 sign-off is `R0: pass(<reviewer-uuid>@<sha>)` or recorded `R0: human-accept(@<sha>)`.

## Start and execute after CP-1

1. Commit frozen contract on default branch. Create integration worktree from it and one task worktree/branch per ready task.
2. In every worktree, install lockfile dependencies and author hook (`pipeline-run.mjs install-hook <worktree>...`) before Verify. Non-pipeline `core.hooksPath` or executable non-`.sample` hooks refuse until `--replace-hooks` is approved.
3. Run `plan`; dispatch its stages using branch, role, title and `pipeline.change` label printed, rendering the prompt with `brief.mjs`. `dispatch-tester` uses `ceshi` (`brief.mjs tester`); check Red SHA, command and assertion failure, then hand to a same-branch worker (`brief.mjs worker`). `BLOCKED_TESTER_RESULT`: inspect/resume tester, never duplicate/skip. Workers run `worker-check` before reporting; `merge-task` rejects edits to `ceshi` Red files without `--allow-test-infra`.
4. On completion, verify tip, run `merge` from integration, then rerun `plan`. Failed worker may retry twice; fourth branch needs human approval; use `send_agent_prompt(..., { activeTurnBehavior: "steer" })` or `/paseo-advisor` before burning retries.
5. Keep at most one active backstop `create_heartbeat` per in-flight `pipeline.change` (never per child agent and never `*/30`), deleting it once `plan` shows no running/open work. On lost notification or resume, reread integration Done lines, first-parent log and `plan` before re-arming; never duplicate dispatch.
6. Contract amendments after CP-1 need human confirmation or pre-authorization before planning; a new interface or security boundary needs delta R0.

Gate failures, exit codes and interrupted merges: `templates/approvals.md` § Operator reference.

## FINAL and CP-2

1. Require all tasks Done, nothing blocked and a clean integration worktree. Capture full SHA; run full suite, every `Required=yes` acceptance row, and `risk-scan.mjs main <full-SHA>` at that SHA. Dispatch `anchasi` (`brief.mjs final`) for independent FINAL on `main...<full-SHA>`. For a suspected regression, compare main movement with `git rev-list --count $(git merge-base integration/<change> main)..main`; rebase and rerun if needed.
2. FINAL is requirement conformance recorded in `review.md`. `DEVIATION` alone enters one batched repair wave; overlapping Done scope declares `Depends on`. Contract gaps need human disposition before CP-2; do not emit `ENHANCEMENT` or style-nit lists.
3. Maximum two FINAL rounds: full then delta. After unresolved `NOT_MET`/`UNVERIFIABLE`, human picks `Accept` or `Terminate` from `templates/approvals.md` § FINAL after round 2 — no reopen loop.
4. Before CP-2, confirm evidence is pinned to reviewed SHA, no unaccepted row remains, and human reviewed final diff/evidence. CP-2 authorizes merge only.
5. After CP-2, list objects with `cleanup`, get per-object approval (`templates/approvals.md`), archive approved spec deltas on merged main. Push is its own approval.

## Hard lines

- Main session does not edit business code; workers stay within Write scope and preserve `ceshi` Red paths; `hanlin` writes only the change directory; `chanpin`, `neon` and `anchasi` write nothing.
- Missing dependencies are environment faults: install per lockfile; Verify and tests stay frozen.
- Destructive cleanup, push and merge go through their gates and approvals, never around them.
