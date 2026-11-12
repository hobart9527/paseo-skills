---
name: paseo-pipeline
description: SDD concurrent delivery pipeline for changes with real DAG concurrency. OpenSpec owns contracts; Paseo owns agents/workspaces; git owns state. Scripts schedule; workers close tasks; two heterogeneous gates guard the ends.
user-invocable: true
---

# Paseo Pipeline

Enter from a drafted or frozen DAG with `maxWidth >= 2` and `tasks >= 4`; never split a graph to qualify. `maxWidth` is largest dispatch-dependency wave, a routing heuristic, not exact concurrency. `freeze-check` is authoritative after authoring; `handoff` routes to Tier 2 `/paseo-handoff`. Invalid DAGs have no route; fix graph errors first.

## Principles

- Ready tasks run in separate worktrees; no Lead, per-task reviewer, or wave barrier.
- `pipeline-run.mjs` computes frontier, capacity and merge order. Follow its plan; do not schedule manually.
- One worker owns each vertical task slice: tests, implementation, frozen narrow Verify and commit.
- Every non-sink task has scope-local Verify; full suite runs at sink/final acceptance.
- R0 reviews contract before CP-1; independent FINAL checks integrated conformance. Middle gates are mechanical.
- Git refs hold state; Paseo transports agents. Human owns CP-1, CP-2, push and destructive approval.

## Roles

Resolve current provider/model/modeId/thinking settings with `list_profiles` at dispatch. Never put model IDs in docs or copy from examples/memory.

| Profile | Scope |
|---|---|
| 中书 `chanpin` | Read-only research and Proposal. |
| 翰林 `hanlin` | Spec, SCEN contracts, R0 and arbiter. |
| 测试 `ceshi` | Red tests first; hard-risk tasks or `Review: strict` only; writes under `test/` only. |
| 工部 `gongbu` | Core implementation within assigned Write scope. |
| 高工 `gaogong` | Complex, cross-module, concurrency, or rework after reviewer pushback. |
| 将作 `jiangzuo` | UI/UX. |
| 按察司 `anchasi` | Independent read-only audit; heterogeneity per profile notes. |
| 尚书 `shangshu` | Tier 3 orchestration and reconciliation, read-only; main session may orchestrate instead. |

`WRITER_ROLES` compatibility remains in `merge-task.mjs` and `next-actions.mjs`. `Review:` is risk metadata; it does not select a process. Use `templates/author.md`, `templates/worker.md`, and `templates/reviewer.md` for stage rules.

## Entry and CP-1

Contract work is serial.

1. Run read-only preflight and create an OpenSpec change with schema `paseo-pipeline`. Provide one author workspace, baseline SHA, preflight/structural commands, project constants and confirmed decisions.
2. Author follows `templates/author.md`: draft DAG first, then artifacts for selected route. Run structural `freeze-check` as soon as package exists. `COMPLETE` requires structural success on committed content; reconcile SHA and Git evidence.
3. If route is `handoff`, only author `COMPLETE`, structural exit 0/no blocks, and matching checked/reported SHA qualify; use Tier 2 `/paseo-handoff`. Route success is not R0 or CP-1. `pipeline` route alone clears no other block.
4. Resolve material human choices, then dispatch `hanlin` read-only R0 using `templates/reviewer.md`. R0 checks proposal/spec/design/tasks/acceptance as one package and records reviewed SHA. Maximum two package rounds; second is delta. After unresolved blockers, human accepts recorded risk or directs one fix-diff check; no third package round.
5. Present contract, findings, DAG/scopes/Verify/acceptance and route. Human confirms CP-1 for exact contract commit. Freeze only after confirmation. CP-1 approves the contract, not arbitrary later commands.

## Start and execute after CP-1

1. Commit frozen contract on default branch. Create integration worktree from it and one task worktree/branch per ready task.
2. Install pipeline hook and lockfile dependencies in every worktree, including integration, before Verify.
3. Run `pipeline-run.mjs plan <change-dir>` and dispatch exactly listed workers, one per task, with branch, workspace, frozen Write scope, SCENs, Verify and upstream interfaces. Worker follows `templates/worker.md`, commits required trailers and reports branch tip.
4. On completion, verify tip and run `pipeline-run.mjs merge <change-dir> <T-id>` from integration; then rerun `plan`. Gate checks dependencies, scope, provenance, drift, Verify and regression, then records Done.
5. On lost notification, reconcile Paseo state, Git tip and Done lines before re-arming; never duplicate dispatch. A failed worker may retry twice after initial attempt; fourth branch needs human approval. No manual Done edits or gate bypass.
6. After resume, reread integration Done lines, first-parent log and labeled Paseo agents before dispatch. Contract amendments after CP-1 need human confirmation or an applicable recorded pre-authorization before planning; new interface/security boundary needs delta R0.

## FINAL and CP-2

1. Require all tasks Done, no blocked tasks and clean integration. Capture full SHA; run full suite and every `Required=yes` acceptance at that SHA. Dispatch `anchasi` for independent FINAL on `main...<full-SHA>` using `templates/reviewer.md`.
2. FINAL is requirement conformance: one matrix row per SCEN, acceptance row and named standard. Record evidence and findings in `review.md`. `DEVIATION` alone may enter one batched repair wave; a repair overlapping Done scope declares `Depends on`, or freeze-check reports `SCOPE_CONFLICT`. Contract/requirement gaps require human disposition before CP-2; `ENHANCEMENT` is backlog. See `templates/approvals.md` for bounded recovery.
3. Maximum two FINAL rounds: full then delta. After unresolved `NOT_MET`/`UNVERIFIABLE`, human chooses accept, reopen at contract level (one delta R0, CP-1, one repair wave and one reopen delta review), or terminate. Record-only SHA changes do not consume a round; substantive changes do. CP-2 remains human.
4. Before CP-2, ensure evidence matches reviewed SHA, no unaccepted row remains, and human has reviewed final diff/evidence. CP-2 authorizes merge; it does not authorize push or cleanup.
5. After CP-2, separately review archive/cleanup commands and obtain per-object approval. Archive approved spec deltas on merged main. Push separately.

## Appendix: operator recovery and acceptance

`pipeline-run.mjs status <change-dir>` and `plan` report current state. Exit 3 indicates unreadable/ambiguous state or invalid tasks, not idle; repair input or provide verified `--other-change <id>`. After interrupted merge, inspect `MERGE_HEAD`, worktree and refs; never delete pending markers to bypass a gate. Serialize merges.

Merge exit codes: 1 ordinary refusal; 2 usage; 3 post-merge record/cleanup failure (check Done before retry); 10 conflict; 20 Verify; 21 regression; 30 scope; 31 provenance; 34 base/drift; 35 dependency; 36 dependencies not installed; 37 retry cap; 38 test-infrastructure changes without approval.

Acceptance `run` executes repository-controlled commands unsandboxed; inspect commands/dependencies first. It writes external evidence and may expose secrets. `check` validates record consistency without executing commands; neither proves authenticity nor authorizes CP-2. Failed/blocked rows require a fix and fresh evidence. See `templates/approvals.md` for exact approval recording.

## Hard lines

- Main session does not edit business code; workers stay within Write scope; `hanlin` and `anchasi` write nothing.
- Never treat missing dependencies as test failures or edit Verify to bypass environment setup.
- Never force destructive cleanup, push, or merge around gates.
