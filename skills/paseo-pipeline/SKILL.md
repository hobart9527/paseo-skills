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

- `chanpin`: drafts Proposal/Spec/Codebase Digest as text; main session writes OpenSpec files.
- `gaogong`: design/DAG/acceptance, complex implementation, confirmed-blocker fixes.
- `hanlin`: independent package R0 and one-turn arbitration; not package author or task reviewer for same dispute.
- `ceshi`: behavior Red tests before implementation.
- `gongbu` / `jiangzuo`: default / UI implementation.
- `anchasi`: task and integrated reviews. Codex offers no read-only mode: reviewers run in a separate workspace, briefed read-only; tip binding voids any review whose branch moved.
- `shangshu`: sole Lead; schedules, reconciles, merges, reports.

## Entry and CP-1
1. Main session runs `openspec new change <name> --schema paseo-pipeline`. The schema resolves from the global OpenSpec schema link installed by `install.sh`; do not keep stale project-local copies that shadow it.
2. `chanpin` returns evidence-based Proposal/Spec/Digest. Main session writes drafts. `gaogong` drafts Design/Tasks/Acceptance with vertical slices, call-site/fixture impact, baseline known reds, and narrow Verify.
3. Run `node "$PIPELINE_HOME"/freeze-check.mjs openspec/changes/<name>` (also enforces `design.md` Impact Inventory, SCEN per task, no test-only tasks); inspect route, waves, width, critical path.
4. `hanlin` performs one read-only R0 on complete package after mechanical freeze-check. Authors may revise once.
5. Present final contract, R0 findings/responses, DAG/scopes/Verify/acceptance. Freeze only after human confirms CP-1.

## Runtime
- Create one Lead with `templates/lead.md`. Lead reconciles integration HEAD, Done lines, task branches, and Paseo agent state before dispatch.
- Ready frontier = dependencies Done + disjoint scopes. Writer cap 4; auditor cap 2; merge serially.
- Behavior task sequence: `ceshi` Red commit → verify Red on base → implementer in same task workspace/branch → narrow Verify green → independent task audit → `merge-task.mjs`. Mechanical exemption only when frozen task says `Review: mechanical`.
- Test author and implementer must be different agents and models. Reviewer model must differ from implementer and should differ from tester where available (`merge-task` warns on overlap; Lead picks another profile). If unavailable, block and report; do not claim heterogeneity.
- Every dispatch uses Paseo native workspaces, labels, finish notifications, plus a `paseo wait <id> --timeout` backstop so a lost notification cannot stall the Lead. A notification is not success: inspect status/result and branch tip. Lost notifications trigger reconciliation, not duplicate dispatch. Rework uses original agent/workspace when safe.
- Contract amendments after CP-1: main session updates tasks, human confirms delta, commit, then Lead reloads contract.

## Merge gate
```
node "$PIPELINE_HOME"/merge-task.mjs \
  task/<change>/<T> <T> 'pass(<reviewer>@<tip>/<base>)'
```
`merge-task` checks branch/task identity, dependency Done, frozen Write scope, commit trailers, test-author protection, agent/model independence, review binding, base drift, Verify, and clean worktree; then no-ff merges and records Done. After its own Verify it re-runs every already-Done task's narrow Verify on the merged tree (full-suite commands skipped). It also proves Red: the test-author commits alone must make the frozen Verify fail (exit 33 if it passes or cannot run). Exit codes: 2 usage; 10 conflict; 20 verify; 21 cross-task regression; 30 scope; 31 provenance; 32 review; 33 Red proof; 34 base/drift; 35 dependency. It is the sole Done writer.

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
- No tenant/database/port/account sharing without declared isolation.
