---
name: paseo-pipeline
description: Tier 3 concurrent delivery — after read-only Recon, rough DAG has ≥4 substantive tasks and maxWidth >= 3 (or maxWidth >= 2 with weightedSpeedup >= 1.8). 3-stage authoring, worktree workers, scripted gates, human CP-1/CP-2.
user-invocable: true
---

# Paseo Pipeline

Enter after read-only Recon (`rg` or `chanpin` via `brief.mjs recon`) confirms `tasks >= 4` and high-ROI concurrency (`maxWidth >= 3` or `maxWidth >= 2` with `weightedSpeedup >= 1.8`; never split to qualify; see `~/.claude/CLAUDE.md`). `hanlin` refines the DAG; `freeze-check` owns routing (`handoff` → Tier 2 without rewriting specs/tasks; `pipeline` continues).

Structural check, R0, FINAL, acceptance and approval are **pinned** to exact commits; a new SHA needs a fresh check or delta review.

## Principles

- Ready tasks run in separate worktrees; no Lead, per-task reviewer, or wave barrier.
- `pipeline-run.mjs plan` computes frontier, capacity and merge order; `prepare-task` creates branch/worktree, installs hooks and renders the `brief.mjs` prompt.
- One worker owns each vertical slice: tests, implementation, frozen narrow Verify, `worker-check` and commit. Full suite runs at sink and FINAL.
- For shared cross-layer types across concurrent tasks, prefer a Wave 0 `Kind: skeleton` typed stub checked by the compiler rather than hand-copying interfaces into Markdown.
- R0 checks frozen boundaries before CP-1; independent FINAL checks integrated conformance. Middle gates are mechanical.
- Git refs hold state; Paseo transports agents. Human owns CP-1, CP-2, push and destructive approval. Commits on non-default branches in worktrees are pre-authorized; proceed without asking.

## Roles

Resolve provider/model/modeId/thinking via `list_profiles` at dispatch (`lib/roles.mjs` is sole registry).

| Profile | Scope |
|---|---|
| 调研（中书） `chanpin` | Read-only Stage 1 objective code facts (`baseline-facts.md` ≤15KB via `templates/recon.md`); never drafts specs or product code. |
| 架构（翰林） `hanlin` | Architecture, contract author (writes only `openspec/changes/<change>/`) and arbiter; not its own R0. |
| 测试 `ceshi` | Independent Red only for `Review: strict`; task-scoped tests; immutable to downstream worker. |
| 开发（工部） `gongbu` | Default owner of tests and implementation within Write scope. |
| 攻坚（高工） `gaogong` | Complex implementation (`Est: L` / `Risk-surface`) and bounded rework, not replanning. |
| 界面（将作） `jiangzuo` | UI specialization plus UI skill; selected when scope is UI-focused. |
| 审查（按察司） `anchasi` | Sole independent reviewer (`R0` contract review, `FINAL` audit, Tier 2 review); read-only intent is not a permission guarantee. |
| 协调（尚书） `shangshu` | Optional thin Tier 3 dispatch and reconciliation; main session is default. |

`Review: strict` selects independent Red tests; risk alone adds no tester. Render briefs with `brief.mjs <role>` (`templates/{author,tester,worker,reviewer}.md` + `templates/recon.md`).

## Tools

All under `$PIPELINE_HOME` (set by `install.sh`). Each prints usage on bad args.

| Script | When |
|---|---|
| `profiles-check.mjs [--skill F] [--config F] [--json]` | Read-only lint: role mapping, notes fields, family pairs, antigravity `diff-check`. `--json`: `{ roles, findings, advisories, ok }`. |
| `preflight.mjs <repo>` | Before authoring: read-only capability probe (test env, lockfiles). |
| `namespace.mjs <change-dir>` | Author, before specs: SCEN prefixes and requirement headings in use. |
| `pipeline-run.mjs prepare-author <change-dir>` | Stage 0 deterministic preflight, `--hydrate`, `namespace`, drift check, `baseline-facts.md` scaffold. |
| `brief.mjs <role> --change <name> --repo <path>` | Render role prompt from frozen contract (JIT-inlines `baseline-facts.md` for `author`). |
| `freeze-check.mjs <change-dir> --structural` | Structural gate and ROI route; without `--structural` checks R0 sign-off. |
| `pipeline-run.mjs acceptance sync\|run\|check <change-dir>` | Compile `acceptance.md` from `specs/` + `tasks.md`; FINAL execution/audit (`templates/approvals.md`). |
| `pipeline-run.mjs plan\|status <change-dir>` | After CP-1: next dispatches/merges and current state. |
| `pipeline-run.mjs prepare-task <change-dir> <T-id>` | Create worktree/branch, `install-hook`, and render brief in one step. |
| `pipeline-run.mjs worker-check <change-dir> <T-id>` | Worker before reporting: scope, trailers, `ceshi` Red immutability, Verify. |
| `pipeline-run.mjs merge <change-dir> <T-id>` | From integration worktree after worker passes `worker-check`. |
| `pipeline-run.mjs cp2-merge <change-dir>` | After CP-2: drift sync + `--ff-only` merge onto default branch. |
| `pipeline-run.mjs tier2-verify <base>` | Unified Tier 2 delivery gate (OpenSpec + Verify rerun + `risk-scan`). |
| `pipeline-run.mjs install-hook <worktree>...` | Install author hook (or run via `prepare-task`). |
| `pipeline-run.mjs risk-scan <base> [<head>]` | Diff scan for 5 risk classes, test-oracle mutations, and doc caveat removals. |
| `pipeline-run.mjs cleanup <change-dir>` | After CP-2: lists worktrees/branches and commands; executes nothing. |
| `pipeline-run.mjs freeze\|profiles\|preflight\|inspect\|report` | Unified facade entries (`inspect`: namespace + scenarios + hotspots; `report`: local metrics). |

## Entry and CP-1

Use 3 isolated stages (Stage 0 script → Stage 1 read-only facts → Stage 2 clean-context author).

1. Run `pipeline-run.mjs prepare-author openspec/changes/<change>` (if using a separate `author/<change>` worktree, sync/clear main's untracked seed before CP-1 merge). Dispatch read-only `chanpin` (`brief.mjs recon`) for `baseline-facts.md` (≤15KB); on entropy overflow (`>2` capabilities, `>10` rules, `>12` scopes, `>8` tasks), confirm split before Stage 2.
2. Dispatch `hanlin` (`brief.mjs author`) with workspace, baseline SHA, `PIPELINE_HOME`, structural commands, constants, confirmed decisions, rough DAG, and a one-shot 20–25m `create_heartbeat` backstop (delete on return). Author commits `proposal.md` rule-list first, pure-behavior `specs/` + `--stage specs` (no full suite pre-spec), then `tasks.md` (`Verify with:`, `Entry:`, `Required:`) + `acceptance sync` + full `--structural`. Stop exhausted authors cleanly on stall and reconcile author branch `git log` once instead of polling.
3. Route `handoff` qualifies with author `COMPLETE`, structural exit 0, and matching SHA; run `/tier2-handoff` and `/paseo-handoff`.
4. Resolve material human choices. Dispatch independent `anchasi` (`brief.mjs r0`, never the author or Proposal contributor) for read-only R0 (`[Pipeline] anchasi R0`; legacy `neon R0`/`hanlin R0` signers remain valid); reconcile HEAD, tracked diff and untracked files. Maximum two package rounds (full then delta); unresolved blockers go to human risk acceptance or termination.
5. Present contract, findings, DAG/scopes/Verify/acceptance and route. Human confirms CP-1 for exact contract commit; freeze only after that. R0 sign-off is `R0: pass(<reviewer-uuid>@<sha>)` or recorded `R0: human-accept(@<sha>)`.

## Start and execute after CP-1

1. Commit frozen contract on default branch. Create integration worktree; run `prepare-task` (runs `install-hook`) per ready task. Foreign `core.hooksPath` or executable hooks refuse until `--replace-hooks` is approved.
2. Run `plan`; dispatch `ceshi` (`brief.mjs tester`) or worker (`brief.mjs worker`). If sandbox blocks `ceshi` commit, commit its staged Red files via `PASEO_AGENT_ID=<ceshi-uuid>`. Workers run `worker-check`; `merge-task` blocks `ceshi` Red edits without `--allow-test-infra`.
3. Run `merge` from integration, then rerun `plan`. Worker retries twice; fourth branch needs human approval; steer or `/paseo-advisor` early.
4. Keep at most one fixed `*/15 * * * *` `create_heartbeat` per active `pipeline.change` (never `*/30`, never per wave or child agent); delete once `plan` shows no open work. On resume, reread integration Done lines and `plan`; never duplicate dispatch.
5. Post-CP-1 amendments need confirmation; new interface or security boundary needs delta R0.

Gate failures, exit codes and interrupted merges: `templates/approvals.md` § Operator reference.

## FINAL and CP-2

1. Require all tasks Done, nothing blocked and clean integration worktree. Capture full SHA; run full suite, `Required=yes` acceptance rows, and `risk-scan.mjs main <full-SHA>` at that SHA. Dispatch `anchasi` (`brief.mjs final`) for independent FINAL on `main...<full-SHA>`. For suspected regression, compare main movement with `git rev-list --count $(git merge-base integration/<change> main)..main`; rebase and rerun if needed.
2. Record conformance in `review.md`. `DEVIATION` enters one repair wave; contract gaps need human disposition before CP-2. Never emit `ENHANCEMENT` or style nits.
3. Maximum two FINAL rounds: full then delta. Unresolved `NOT_MET`/`UNVERIFIABLE`: human picks `Accept` or `Terminate` per `templates/approvals.md` § FINAL after round 2.
4. Before CP-2, confirm pinned evidence, no unaccepted row, and human diff review. CP-2 authorizes merge only.
5. Merge via `cp2-merge` (syncs drift + reruns Verify if synced). After CP-2, run `cleanup`, get per-object approval (`templates/approvals.md`), archive spec deltas on merged main. Push is its own approval.

## Hard lines

- Main session edits no business code; workers stay in Write scope and keep `ceshi` Red paths; `hanlin` writes only `openspec/changes/<change>/`; `chanpin` and `anchasi` write nothing (main session or scoped Stage 1 records `baseline-facts.md`).
- Never `cd` across isolated checkouts (`git -C <abs-path>` only).
- Missing deps are environment faults: install per lockfile; Verify and tests stay frozen. Destructive cleanup, push and merge follow their gates.
