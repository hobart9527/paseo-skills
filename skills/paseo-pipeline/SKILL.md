---
name: paseo-pipeline
description: SDD concurrent delivery pipeline for changes with real DAG concurrency. OpenSpec owns contracts; Paseo owns agents/workspaces; git owns state.
user-invocable: true
---

# Paseo Pipeline

Use only when the frozen DAG has `maxWidth >= 2` and `tasks >= 4`; otherwise use Tier 2 `/paseo-handoff`. Do not split artificially to qualify.

## Principles
1. **Vertical slices.** Behavior, wiring, affected fixtures, and tests belong together. No fixture-only/wiring-only tasks. Wave 0 only for a genuinely shared contract and actual consumers.
2. **Narrow Verify.** Every non-sink task names a scope-local test/spec command. Full suite runs only at the unique sink and final acceptance.
3. **Frontier scheduling.** Dispatch as soon as dependencies are Done and scopes do not overlap; do not wait for wave barriers.
4. **TDD role separation.** `ceshi` authors Red tests before implementation; implementer cannot alter those tests. Mechanical tasks may skip TDD/review.
5. **Git is state; Paseo is scheduler.** No secondary ledger, lease, lock, or custom agent runner.
6. **One review per artifact/stage.** R0 reviews contract package once; tasks get R1/R2 only as needed; integrated final review once plus one fix-diff recheck.
7. **Human gates.** CP-1 freezes approved contract. CP-2 confirms merge to main. No push/destructive cleanup without explicit approval.

## Roles and briefs
Read profile notes with `list_profiles`; use live agent provider/model for independence checks. Never hardcode model names in prompts. Briefs: `templates/author.md` (SPEC/TASKS), `tester.md`, `writer.md`, `reviewer.md` (R0/TASK/FINAL/ARBITER), `lead.md`. `auditor.md` is compatibility alias only.

- `chanpin`: writes Proposal/Spec/Codebase Digest directly to OpenSpec files and commits; does not return text for main session to re-type.
- `gaogong`: writes Design/Tasks/Acceptance directly to OpenSpec files and commits; also handles complex implementation and confirmed-blocker fixes.
- `hanlin`: independent package R0 and one-turn arbitration; not package author or task reviewer for same dispute.
- `ceshi`: behavior Red tests before implementation.
- `gongbu` / `jiangzuo`: default / UI implementation.
- `anchasi`: task and integrated reviews. Codex offers no read-only mode: reviewers run in a separate workspace, briefed read-only; tip binding voids any review whose branch moved.
- `shangshu`: sole Lead; schedules, reconciles, merges, reports.
- Profile notes describe a role's scope; the frozen task's `Review:` field decides this change's process. `ceshi`'s note mentions only `Review: strict` — that is stale: every non-mechanical task needs a Red test commit, because `merge-task` exits 31 without one.
- Cost: one behavior task is three agents in series (ceshi → implementer → reviewer). Budget that before choosing Tier 3; freeze `Review: mechanical` only for tasks with no behavior to prove.
- `auto-review` profiles (`ceshi`, `gaogong`, `anchasi`) can stop on a permission prompt and never finish. When a child goes idle without a finish result, check pending permission requests before concluding it is stalled; do not widen a read-only reviewer to `bypassPermissions` to avoid the prompt.

## Entry and CP-1

制宪阶段是一条有序的 agent 串联管道，每步 blocking。主会话按以下顺序调度，不得跳过或乱序：

1. Run `openspec new change <name> --schema paseo-pipeline`. The schema resolves from the global OpenSpec schema link installed by `install.sh`; do not keep stale project-local copies that shadow it.
2. **Dispatch `chanpin`** (use `templates/author.md` Mode SPEC brief). `chanpin` writes `proposal.md`, `spec.md`, `digest.md` directly into `openspec/changes/<name>/` and commits to the draft branch. Main session does not re-type its output.
3. **Dispatch `gaogong`** (use `templates/author.md` Mode TASKS brief) after `chanpin` commits. `gaogong` reads the committed spec files, writes `design.md`, `tasks.md`, `acceptance.md` directly, and commits. Main session does not re-type its output.
4. Run `node "$PIPELINE_HOME"/freeze-check.mjs openspec/changes/<name>` (enforces `design.md` Impact Inventory, SCEN per task, no test-only tasks, R0 sign-off). If it blocks, dispatch the relevant author (`chanpin` or `gaogong`) to fix, then re-run freeze-check. Do not proceed past a blocking freeze-check.
5. **Dispatch `hanlin`** (use `templates/reviewer.md` Mode R0 brief) in an independent read-only workspace after freeze-check passes structurally. `hanlin` reviews the complete contract package and **writes `review.md`** to `openspec/changes/<name>/` with the sign-off line `R0: pass(<uuid>@<sha>)`. If `hanlin` finds blockers, dispatch the relevant author to revise once, re-run freeze-check, then re-dispatch `hanlin`. A second R0 is final.
6. Re-run `freeze-check` after `hanlin` writes `review.md`. It now validates the R0 sign-off. This is the mechanical gate — no human can accidentally skip the independent review.
7. Present final contract, R0 findings/responses, DAG/scopes/Verify/acceptance. Freeze only after human confirms CP-1. The CP-1 prompt must name the executor ("确认冻结并交给 shangshu 执行"), never just "确认冻结并启动实施".

## Handoff after CP-1

CP-1 approval is not the start of implementation; it is the start of handoff. `merge-task.mjs` only runs on `integration/<change>` with a clean worktree and `tasks.md` already present there, so this sequence is mandatory and belongs to the main session:

1. Commit the frozen contract (`openspec/changes/<change>/`) on the default branch. This commit is the `base` every task branch reviews against.
2. Create the integration branch from that commit and a clean integration worktree:
   `git switch -c integration/<change>` in the main checkout, or `create_workspace(isolation, branchName: "integration/<change>")`. Record its absolute path; the Lead runs there.
3. Create one task branch per ready frontier task from the integration tip: `task/<change>/<T-id>`. Rework attempts use `<T-id>-aN`, never a reused branch.
4. Bootstrap dependencies in each new workspace — **including the integration worktree itself** — **before** any Verify runs. `merge-task` runs all Verify commands in the integration worktree, not in the task workspace. A worktree is a checkout, not a clone: `node_modules/`, `.venv/` and every other ignored path stay behind in the main checkout, so the first `Verify with` otherwise dies on `Cannot find package` — reported as exit 36. Install per lockfile (`npm ci`, `pnpm install --frozen-lockfile`, `python3 -m venv .venv`) or configure a Paseo workspace script so new worktrees self-bootstrap; do this once per workspace, not per task.
5. Draft the Lead brief from `templates/lead.md`, filling `<change>`, integration worktree path, integration branch, `base` SHA, and the frozen contract paths.
6. Create exactly one Lead (`shangshu`, see `list_profiles`). Main session then stops: no business-code edits, no further dispatch.
7. If the frozen DAG's `[ROUTE]` is `handoff` (no real concurrency), do not create a Lead — run Tier 2 `/paseo-handoff` instead and say so at CP-1.

After context compaction or a resumed session, the first action is to re-read `tasks.md` Done lines, `git log --first-parent integration/<change>`, and `paseo ls --label pipeline.change=<change> --json` before any dispatch. Summaries are not state.

## Runtime
- Create one Lead with `templates/lead.md`. Lead reconciles integration HEAD, Done lines, task branches, and Paseo agent state before dispatch.
- Ready frontier = dependencies Done + disjoint scopes. Writer cap 4; auditor cap 2; merge serially.
- Behavior task sequence: `ceshi` Red commit → verify Red on base → implementer in same task workspace/branch → narrow Verify green → independent task audit → `merge-task.mjs`. Mechanical exemption only when frozen task says `Review: mechanical`.
- Test author and implementer must be different agents and models. Reviewer model must differ from implementer and should differ from tester where available (`merge-task` warns on overlap; Lead picks another profile). If unavailable, block and report; do not claim heterogeneity.
- Agent identity: every trailer and review tag uses the agent's full UUID (`$PASEO_AGENT_ID` inside the agent). Paseo's 7-char `shortId` is accepted in a review tag and resolves by prefix; a bare 7-char author in a trailer is not — use the UUID.
- Every dispatch uses Paseo native workspaces, labels, finish notifications, plus a wait backstop so a lost notification cannot stall the Lead. The backstop is a background wait or a periodic `paseo ls` poll, never a foreground blocking `paseo wait` for the whole agent lifetime: Claude Code caps foreground commands at 600s, and blocking leaves other children's notifications unread. A returned or timed-out wait means "inspect now"; it is not success. Lost notifications trigger reconciliation, not duplicate dispatch. Rework uses original agent/workspace when safe.
- Contract amendments after CP-1: main session updates tasks, human confirms delta, commit, then Lead reloads contract.

## Merge gate
```
node "$PIPELINE_HOME"/merge-task.mjs \
  task/<change>/<T> <T> 'pass(<reviewer-uuid>@<tip>/<base>)'
```
`merge-task` checks branch/task identity, dependency Done, frozen Write scope, commit trailers, test-author protection, agent/model independence, review binding, base drift, Verify, and clean worktree; then no-ff merges and records Done. After its own Verify it re-runs every already-Done task's narrow Verify on the merged tree (whole-suite legs skipped; only tasks sharing a transitive dependency or overlapping scope are replayed). It also proves Red: the test-author commits alone must make the frozen Verify fail on an assertion, not on a load/import/collection error (exit 33 if it passes, cannot run, or fails non-behaviourally). Exit codes: 2 usage; 10 conflict; 20 verify; 21 cross-task regression; 30 scope; 31 provenance; 32 review; 33 Red proof; 34 base/drift; 35 dependency; 36 unchecked-out dependencies. It is the sole Done writer.

Exit 36 means the worktree cannot resolve a package or runner (`Cannot find package 'tsx'`, `command not found`). It is an environment fault, not a task failure: a linked worktree does not inherit `node_modules`/`.venv`. Install once in that worktree (`npm ci`/`pnpm install`/`venv`, per lockfile) and retry — never edit tests or Verify to work around it.

## Recovery
```
git log --first-parent integration/<change>
grep -n 'Done:' openspec/changes/<change>/tasks.md
paseo ls --label pipeline.change=<change> --json
```

Use live Paseo state plus branch tips and Done lines. Do not re-dispatch solely on a delayed notification. Only one active Lead; replacing it requires human confirmation and archiving old Lead first.

## Finish
1. Require all tasks Done, no blocked/failed tasks, clean integration worktree.
2. On same final SHA, run full suite and all `Required=yes` acceptance commands; record evidence/SHA. In parallel, run one integrated Spec+Standards review via explicit Paseo profiles.
3. Confirmed blockers only: `gaogong` fixes listed items; rerun full suite/acceptance; original reviewer rechecks fix diff once. Remaining blockers mean not delivered.
4. Report final SHA, test/acceptance result, review findings/NITs, task SHAs. CP-2 remains human confirmation. If main moved, revalidate at new SHA.
5. After CP-2, present cleanup list. Delete/archive only after human confirmation; push requires separate confirmation.

## Hard lines
- Lead/main session never edits business code; `chanpin` drafts contract as text only.
- No self-review; use actual provider/model values, not profile-name assumptions.
- No manual Done/check boxes; no full-suite Verify on non-sink tasks.
- Never treat a missing dependency as a Red result or fix it by editing tests/Verify; install in the workspace and rerun.
- No tenant/database/port/account sharing without declared isolation.
