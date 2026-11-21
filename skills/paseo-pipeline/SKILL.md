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
- `pipeline-run.mjs plan` computes frontier, capacity and merge order; `prepare-task` creates branch/worktree, installs hooks and renders the `brief.mjs` prompt.
- One worker owns each vertical task slice: tests, implementation, frozen narrow Verify, `worker-check` and commit. Full suite runs at sink and FINAL.
- R0 checks frozen boundaries before CP-1; independent FINAL checks integrated conformance. Middle gates are mechanical.
- Git refs hold state; Paseo transports agents. Human owns CP-1, CP-2, push and destructive approval. Commits on non-default branches in worktrees are pre-authorized; proceed without asking.

## Roles

Resolve provider/model/modeId/thinking via `list_profiles` at dispatch (`lib/roles.mjs` is sole role registry).

| Profile | Scope |
|---|---|
| 调研（中书） `chanpin` | Read-only Recon (`templates/recon.md`) and Proposal facts, no product/contract writes. |
| 架构（翰林） `hanlin` | Architecture, contract author (writes only `openspec/changes/<change>/`) and arbiter; not its own R0. |
| 测试 `ceshi` | Independent Red only for `Review: strict`; task-scoped tests; immutable to downstream worker. |
| 开发（工部） `gongbu` | Default owner of tests and implementation within Write scope. |
| 攻坚（高工） `gaogong` | Complex implementation (`Est: L` / `Risk-surface`) and bounded rework, not replanning. |
| 界面（将作） `jiangzuo` | UI specialization plus UI skill; selected when scope is UI-focused. |
| 审查（按察司） `anchasi` | Independent code audit (`FINAL` / Tier 2); review intent is not a read-only permission guarantee. |
| 契约审查（Neon） `neon` | Independent read-only R0 (cannot review if same-family `chanpin` drafted Proposal). |
| 协调（尚书） `shangshu` | Optional thin Tier 3 dispatch and reconciliation; main session is default. |

`Review: strict` selects independent Red tests; risk alone adds no tester. Render briefs with `brief.mjs <role>` (`templates/{author,tester,worker,reviewer}.md` + `templates/recon.md`).

## Tools

All under `$PIPELINE_HOME` (set by `install.sh`). Each prints usage on bad arguments.

| Script | When |
|---|---|
| `profiles-check.mjs [--skill F] [--config F] [--json]` | Read-only lint: role mapping, notes fields, family pairs, antigravity `diff-check`; not independence/sandbox proof. `--json`: one object (`roles`, `findings`, `advisories`, `ok`). |
| `preflight.mjs <repo>` | Before authoring: read-only capability probe (test env, lockfiles). |
| `namespace.mjs <change-dir>` | Author, before specs: SCEN prefixes and requirement headings in use. |
| `brief.mjs <role> --change <name> --repo <path>` | Render exact role prompt from frozen contract. |
| `freeze-check.mjs <change-dir> --structural` | Structural gate and substantive route; without `--structural` checks R0 sign-off. |
| `pipeline-run.mjs acceptance sync\|run\|check <change-dir>` | Derive `acceptance.md`; FINAL execution/audit (see `templates/approvals.md`). |
| `pipeline-run.mjs plan\|status <change-dir>` | After CP-1: next dispatches/merges; current state. |
| `pipeline-run.mjs prepare-task <change-dir> <T-id>` | Create worktree/branch, run `install-hook`, render role brief in one step. |
| `pipeline-run.mjs worker-check <change-dir> <T-id>` | Worker before reporting: scope, trailers, `ceshi` Red immutability, Verify. |
| `pipeline-run.mjs merge <change-dir> <T-id>` | From integration worktree after worker passes `worker-check`. |
| `pipeline-run.mjs cp2-merge <change-dir>` | After CP-2: clean drift sync + `--ff-only` merge onto default branch. |
| `pipeline-run.mjs tier2-verify <base>` | Unified Tier 2 delivery gate (OpenSpec + Verify rerun + `risk-scan`). |
| `pipeline-run.mjs install-hook <worktree>...` | Install author hook (or run via `prepare-task`). |
| `pipeline-run.mjs risk-scan <base> [<head>]` | Diff scan for 5 risk classes, test-oracle mutations, and doc caveat removals. |
| `pipeline-run.mjs cleanup <change-dir>` | After CP-2: lists worktrees/branches and commands; executes nothing. |
| `pipeline-run.mjs freeze\|profiles\|preflight\|inspect\|report` | Unified facade entries (`inspect`: namespace + scenarios + r0-hotspots; `report`: local metrics). |

## Entry and CP-1

Contract work is serial.

1. Run `preflight.mjs` and create an OpenSpec change with schema `paseo-pipeline`. Dispatch `hanlin` (`brief.mjs author`) with author workspace, baseline SHA, `PIPELINE_HOME`, preflight/structural commands, constants, confirmed decisions and rough DAG.
2. Author writes `proposal.md` + `specs/` and runs `freeze-check --structural --stage specs` first, then projects `acceptance.md` via `acceptance sync` and returns a pinned structural result. Stop exhausted authors cleanly on step/budget stall and reconcile author branch `git log` once instead of polling.
3. Route `handoff` qualifies only with author `COMPLETE`, structural exit 0 with no blocks, and matching checked/reported SHA; run `/tier2-handoff` and `/paseo-handoff`.
4. Resolve material human choices. Dispatch independent `neon` (`brief.mjs r0`, never the author or Proposal contributor) for read-only R0 in a separate workspace (`[Pipeline] neon R0` or `hanlin R0`); reconcile HEAD, tracked diff and untracked files. Maximum two package rounds (full then delta); unresolved blockers go to human risk acceptance or termination — no third R0 round.
5. Present contract, findings, DAG/scopes/Verify/acceptance and route. Human confirms CP-1 for the exact contract commit; freeze only after that. CP-1 approves the contract and its commit to the default branch, nothing later. R0 sign-off is `R0: pass(<reviewer-uuid>@<sha>)` or recorded `R0: human-accept(@<sha>)`.

## Start and execute after CP-1

1. Commit frozen contract on default branch. Create integration worktree from it; run `prepare-task` (includes `install-hook`) per ready task. Non-pipeline `core.hooksPath` or executable non-`.sample` hooks refuse until `--replace-hooks` is approved.
2. Run `plan`; dispatch printed stages (`ceshi` via `brief.mjs tester` for `dispatch-tester`; inspect Red SHA/failure before same-branch worker via `brief.mjs worker`). `BLOCKED_TESTER_RESULT`: inspect/resume tester, never duplicate/skip. Workers run `worker-check` before reporting; `merge-task` rejects edits to `ceshi` Red files without `--allow-test-infra`.
3. On completion, run `merge` from integration, then rerun `plan`. Failed worker may retry twice; fourth branch needs human approval; steer or `/paseo-advisor` before burning retries.
4. Keep at most one fixed-cadence `*/15 * * * *` backstop `create_heartbeat` per in-flight `pipeline.change` (never per wave, never per child agent, never `*/30`); delete it once `plan` shows no running/open work. On resume, reread integration Done lines and `plan`; never duplicate dispatch.
5. Contract amendments after CP-1 need confirmation/pre-authorization; new interface or security boundary needs delta R0.

Gate failures, exit codes and interrupted merges: `templates/approvals.md` § Operator reference.

## FINAL and CP-2

1. Require all tasks Done, nothing blocked and a clean integration worktree. Capture full SHA; run full suite, `Required=yes` acceptance rows, and `risk-scan.mjs main <full-SHA>` at that SHA. Dispatch `anchasi` (`brief.mjs final`) for independent FINAL on `main...<full-SHA>`. For suspected regression, compare main movement with `git rev-list --count $(git merge-base integration/<change> main)..main`; rebase and rerun if needed.
2. Record conformance in `review.md`. `DEVIATION` alone enters one repair wave; contract gaps need human disposition before CP-2. Do not emit `ENHANCEMENT` or style nits.
3. Maximum two FINAL rounds: full then delta. After unresolved `NOT_MET`/`UNVERIFIABLE`, human picks `Accept` or `Terminate` from `templates/approvals.md` § FINAL after round 2 — no reopen loop.
4. Before CP-2, confirm evidence is pinned to reviewed SHA, no unaccepted row remains, and human reviewed final diff/evidence. CP-2 authorizes merge only.
5. Execute merge with `cp2-merge` (syncs `main` drift if needed + reruns Verify if synced, without touching dirty other sessions). After CP-2, list objects with `cleanup`, get per-object approval (`templates/approvals.md`), archive spec deltas on merged main. Push is its own approval.

## Hard lines

- Main session edits no business code; workers stay within Write scope and preserve `ceshi` Red paths; `hanlin` writes only the change directory; `chanpin`, `neon` and `anchasi` write nothing.
- In isolated worktrees, never `cd` to shared checkouts or run complex multi-directory `git` shells (`git -C <abs-path>` only).
- Missing dependencies are environment faults: install per lockfile; Verify and tests stay frozen. Destructive cleanup, push and merge go through their gates and approvals, never around them.
