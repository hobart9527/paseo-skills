---
name: paseo-pipeline
description: SDD concurrent delivery pipeline for changes with real DAG concurrency. OpenSpec owns contracts; Paseo owns agents/workspaces; git owns state.
user-invocable: true
---

# Paseo Pipeline

Use only when the frozen DAG has `maxWidth >= 2` and `tasks >= 4`; otherwise use Tier 2 `/paseo-handoff`, even for schema/concurrency/persistence work with no real concurrency. Otherwise use Tier 2 `/paseo-handoff`.

## Principles
1. **Vertical slices.** Behavior + call sites + affected fixtures + tests in one task. Fixture-only or wiring-only tasks are forbidden.
2. **Wave 0 contract first.** A shared exported signature/type/error/fixture factory may be one small Wave 0 task; only tasks that actually consume or conflict with it depend on it. It is the only permitted horizontal task.
3. **Narrow Verify.** Every non-sink task names a test/spec path inside its Write scope. Full suite only on one sink task and once at final acceptance.
4. **Frontier scheduling, not wave barriers.** A task dispatches immediately when dependencies are Done and its scope is disjoint.
5. **Git is state.** No lease/intent ledger. Done = `tasks.md` Done line + integration commit. Running agents = Paseo labels.
6. **Paseo is scheduler.** Lead uses native `create_agent`, `send_agent_prompt`, `notifyOnFinish`, labels, workspaces. Do not rebuild these.
7. **Budget.** Per task max R1 + R2 + one final arbitration. Audit cannot demand out-of-scope refactor. Rework reuses original workspace/branch.

## Roles
Read profile notes via Paseo `list_profiles`; never hardcode models.
- Product/spec research: product profile
- Contract/design + final arbiter: architect profile
- Implementation: core or specialist profile
- Independent audit: heterogeneous auditor profile

## Entry
1. Main session only: `openspec new change <name> --schema paseo-pipeline`.
2. Draft proposal/spec/tasks/acceptance.
3. Slice rules above. For every changed exported symbol run `rg -n '<symbol>'`; conflicting behavior/fixtures go in same task or Wave 0.
4. Run baseline full suite in clean worktree; record known red tests in `design.md`.
5. `node "$PIPELINE_HOME"/freeze-check.mjs openspec/changes/<name>`.
   It prints waves, max width, critical path, and `[ROUTE] pipeline|handoff`.
6. **CP-1:** present route, waves, scopes, narrow Verify, acceptance. Freeze only after human confirms.

## Runtime
Create Lead as a Paseo agent using `templates/lead.md`. Main session only guards CP-1/CP-2 and OpenSpec lifecycle commands.

Lead loop:
- ready frontier = dependencies Done + scope disjoint;
- dispatch frontier up to writer cap 4; auditor cap 2, separate;
- consume native finish notifications (completion/error/permission); never treat a notification itself as success—read agent status/result first;
- choose an auditor whose provider/model differs from the writer; if unavailable, report degraded review before proceeding;
- merge serially with `merge-task.mjs`;
- on blocked writer, suspend only that task; main session amends `tasks.md`, human confirms delta, Lead reloads contract and continues.

Branch/worktree:
- integration: `integration/<change>`;
- task: `task/<change>/<T>`;
- worktree base = current integration HEAD;
- rework continues on same branch/workspace.

Writer/auditor contracts: `templates/writer.md`, `templates/auditor.md`.

## Merge gate
```
node "$PIPELINE_HOME"/merge-task.mjs \
  task/<change>/<T> <T> 'pass(<reviewer>@<tip>/<base>)'
```
Checks task branch identity, frozen review binding, dependency Done, Write scope, every commit writer trailers, reviewer != author, baseline drift, frozen narrow Verify, clean worktree after test; then `--no-ff` merges and records Done. Exit codes: 2 usage; 10 conflict; 20 verify; 30 scope; 31 provenance; 32 review; 34 base/drift; 35 dependency.

Only one Lead, therefore only one merger; no merge lock.

## Recovery
```
git log --first-parent integration/<change>
grep -n 'Done:' openspec/changes/<change>/tasks.md
paseo ls --label pipeline.change=<change> --json
```
Lead startup/recovery:
- establish exactly one active Lead before dispatch: reconcile integration HEAD, Done lines, branches, and `paseo ls --all --json`; do not create a second Lead while another can act;
- verify current branch is `integration/<change>` and worktree clean;
- on completion notification, inspect output and task branch before audit;
- on permission notification, answer/escalate that agent only;
- on error notification, recover the same agent if active; otherwise dispatch one replacement in the same task workspace/branch when safe, else report blocked;
- if a notification is missing/delayed, use Paseo's native agent status/logs or a low-frequency heartbeat to reconcile; never re-dispatch solely because receipt was lost;
- deduplicate stale/delayed notifications against Done lines and branch tips before merge;
- to replace Lead, human confirms, archive old Lead first, then create/reuse exactly one new Lead; never interrupt Lead while `merge-task.mjs` is running.


Contract change after freeze: main session edits `tasks.md`, human confirms once, commit, notify Lead. No CP-1 restart and no state migration.

## Finish
1. Preconditions: every required task Done; no failed/blocked task; integration branch clean and checked out at final HEAD.
2. Lead runs sole-sink/full suite at final integration HEAD (or declares no natural sink at freeze and runs the frozen full-suite command here).
3. Lead runs every Required=yes command in `acceptance.md` at that same SHA, records output/evidence/SHA, and updates only Result/Evidence.
4. CP-2 is impossible unless every Required=yes row is PASS on the final SHA. Failed/blocked means report blocked, not delivered.
5. Report Done/NITs + SHAs, then **CP-2:** human confirms merge to main. If main moved, recreate final integration state and rerun full suite/required acceptance on the new SHA before CP-2.

## Hard lines
- Main session/Lead never edits business code.
- No self-review; auditor must be heterogeneous and independent.
- No manual `[x]` or `Done:`; merge-task is sole writer.
- No full-suite Verify on non-sink tasks.
- No tenant/database/port/account sharing without declared isolation.
- Push, history rewrite, destructive cleanup, and CP-1/CP-2 require human confirmation.
