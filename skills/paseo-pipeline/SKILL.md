---
name: paseo-pipeline
description: SDD concurrent delivery pipeline for changes with real DAG concurrency. OpenSpec owns contracts; Paseo owns agents/workspaces; git owns state.
user-invocable: true
---

# Paseo Pipeline

Use only when the frozen DAG has `maxWidth >= 2` and `tasks >= 4`; otherwise Tier 2 `/paseo-handoff`. Never split to qualify.

## Principles
1. **Vertical slices.** Behavior, wiring, affected fixtures, and tests belong together. No fixture-only/wiring-only tasks. Wave 0 only for a genuinely shared contract and actual consumers.
2. **Narrow Verify.** Every non-sink task names a scope-local test/spec command. Full suite runs only at the unique sink and final acceptance.
3. **Frontier scheduling.** Dispatch once dispatch deps (`Depends on` + `Uses` skeleton ancestors) are Done and scopes do not overlap; no wave barriers.
4. **TDD role separation.** `ceshi` authors Red tests before implementation; implementer cannot alter those tests. Mechanical tasks may skip TDD/review; `Review: deferred` joins the FINAL review.
5. **Git is state; Paseo is scheduler.** No secondary ledger, lease, lock, or custom agent runner.
6. **One review per artifact/stage.** R0 reviews contract package once; tasks get R1/R2 only as needed; integrated final review once plus one fix-diff recheck.
7. **Human gates.** CP-1 freezes approved contract. CP-2 confirms merge to main. No push/destructive cleanup without explicit approval.

## Roles and briefs
Before every `create_agent`, copy the matching `list_profiles` entry exactly (`provider/model`, `modeId`, `thinkingOptionId`, `featureValues`); if none fits, check `list_providers`/`list_models`, and if the exact pair is not returned, stop. Never copy model IDs from examples, memory, or prior runs. `create_agent` needs a non-empty `title` (`<role>-<change>`). Dispatch natively (labels, finish notification, `paseo wait` backstop), never a probe agent; a timed-out wait means inspect, then re-arm. Briefs: `templates/author.md` (SPEC/TASKS), `tester.md`, `writer.md`, `reviewer.md` (R0/TASK/FINAL/ARBITER), `lead.md`; `auditor.md` is an alias.

- `chanpin`: writes Proposal/Spec/Codebase Digest directly to OpenSpec files and commits; does not return text for main session to re-type.
- `gaogong`: writes Design/Tasks/Acceptance directly to OpenSpec files and commits; also handles complex implementation and confirmed-blocker fixes.
- `hanlin`: independent package R0 and one-turn arbitration; not package author or task reviewer for same dispute.
- `ceshi`: behavior Red tests before implementation.
- `gongbu` / `jiangzuo`: default / UI implementation.
- `anchasi`: task and integrated reviews. Reviewers run in a separate workspace, briefed read-only; tip binding voids a review if the branch moved.
- `shangshu`: sole Lead; schedules, reconciles, merges, reports.
- Profile notes describe a role's scope; the frozen task's `Review:` field decides process. `ceshi`'s strict-only note is stale: every non-mechanical task needs a Red test commit or `merge-task` exits 31.
- A behavior task costs three serial agents; use `Review: mechanical` only when no behavior needs proof.
- `auto-review` profiles can stall on permission prompts: if a child idles without a finish result, check pending permissions first; never widen a reviewer to `bypassPermissions`.

## Entry and CP-1

制宪阶段按序调度，每步 blocking，不得跳过或乱序：

0. **Preflight** (read-only): `node "$PIPELINE_HOME"/preflight.mjs <repo>` reports each package's test runner and whether a UI package can run DOM tests. Fix a missing DOM environment before authoring — the expensive late failure.
1. Run `openspec new change <name> --schema paseo-pipeline`. The schema resolves from the global OpenSpec schema link installed by `install.sh`; do not keep stale project-local copies that shadow it.
2. **Fast path (`gongbu`, TASKS only).** When the input is a human-approved design document (e.g. `docs/specs/<change>-design.md`) that declares SCEN ids, skip `chanpin`: dispatch `gongbu` with `templates/author.md` Mode TASKS. It cites the design section per task and writes `design.md`/`tasks.md`/`acceptance.md`, and commits; do not rewrite the spec or re-derive the DAG. If the design lacks SCEN ids, stop and ask.
3. **Full path otherwise.** Dispatch `chanpin` (Mode SPEC) to write `proposal.md`, `specs/<capability>/spec.md`, `digest.md` and commit; then `gaogong` (Mode TASKS) to write `design.md`, `tasks.md`, `acceptance.md` and commit. Main session does not re-type.
4. Run `node "$PIPELINE_HOME"/freeze-check.mjs openspec/changes/<name> --structural` (Impact Inventory, SCEN per task, no test-only tasks; skips the R0 check, which cannot exist yet). Read its `ADVISE` lines (`ADVISORY_LOW_SPEEDUP`: compare with Tier 2; `ADVISORY_BASELINE_ALIGNMENT`: the author fills it, R0 blocks on an empty one). If it blocks, the author fixes and you re-run. Do not proceed past a block. `[ROUTE] handoff` here: skip R0; run Tier 2 `/paseo-handoff` on the committed spec and tasks.
5. **Dispatch `hanlin` once** (`templates/reviewer.md` Mode R0) in a read-only workspace after the structural check passes on a committed contract. It writes nothing: it returns findings, or `R0: pass(<agent-uuid>@<reviewed-sha>)`, recorded first in `review.md` (`freeze-check` verifies signer and drift; `--skip-signer-check` offline). Accepted rulings go in `rulings.md`. **Bounded R0 (max three rounds):** a revision is a package-wide re-audit — fix each blocker plus every surface it implies, re-run `freeze-check --structural`, then re-dispatch. Round 3 passing frees CP-1; otherwise escalate the unclosed list, never a fourth round. Delta briefs never state the expected verdict.

6. Re-run `freeze-check` without `--structural`; it rejects a missing sign-off and `STALE_R0_SIGNOFF` (unknown sha, or any contract file changed after it).
7. Present final contract, R0 findings/responses, DAG/scopes/Verify/acceptance. Two CP-1 remedies, not interchangeable: `ADVISORY_LOW_SPEEDUP` offers "switch to Tier 2 /paseo-handoff"; a `-logical->` step in `CRITICAL` or `ADVISORY_READS_ONLY_EDGE` offers dropping that edge, never Tier 2. Freeze only after human confirms CP-1. The CP-1 prompt names the executor ("确认冻结并交给 shangshu 执行"), never just "确认冻结并启动实施".

## Handoff after CP-1

CP-1 approval starts handoff, not implementation. `merge-task.mjs` only runs on `integration/<change>` with a clean worktree and `tasks.md` present, so this sequence is mandatory for the main session:

1. Commit the frozen contract (`openspec/changes/<change>/`) on the default branch. This commit is the review `base`.
2. Create the integration branch from that commit in a separate worktree: `create_workspace(isolation, branchName: "integration/<change>")`. The Lead runs there.
3. Create one task branch per ready frontier task from the integration tip: `task/<change>/<T-id>`. Replacement attempts take `<T-id>-aN`.
4. Bootstrap dependencies per lockfile in every new workspace — **including the integration worktree**, where `merge-task` runs Verify — **before** any Verify. A worktree is a checkout, not a clone; an uninstalled package exits 36. Install once per workspace, not per task.
5. Draft the Lead brief from `templates/lead.md`, filling `<change>`, integration worktree path, integration branch, `base` SHA, and the frozen contract paths.
6. Create exactly one Lead (`shangshu`, see `list_profiles`). Main session then stops: no business-code edits, no further dispatch.
7. If the frozen DAG's `[ROUTE]` is `handoff`, create no Lead; run Tier 2 `/paseo-handoff` and say so at CP-1.

After compaction or resume, re-read `tasks.md` Done lines, `git log --first-parent integration/<change>`, and `paseo ls --label pipeline.change=<change> --json` before any dispatch; summaries are not state.

## Runtime
- One Lead (`templates/lead.md`) reconciles git and Paseo state before dispatch, then runs `next-actions.mjs <change-dir>` each round: `DISPATCH`/`WAIT`/`ATTENTION`, writer cap 6, reviewer cap 4, critical path first. Execute its list; never recompute the frontier by hand. `merge-queue.mjs <change-dir>` predicts merge order and conflicts read-only; `merge-task` merges serially. `Uses` is dispatch-only, `Reads` never joins scope conflicts.
- Behavior task: `ceshi` Red commit → verify Red on base → implementer in the same branch → narrow Verify green → independent audit → `merge-task.mjs`. Exemption only for `Review: mechanical`.
- Test author and implementer must differ in agent and model; reviewer model must differ from implementer and should differ from tester (`merge-task` warns on overlap). If unavailable, block; never claim heterogeneity.
- Agent identity: trailers and review tags use the full UUID (`$PASEO_AGENT_ID`); a `shortId` resolves only as a review-tag prefix, never in a trailer.
- Every dispatch uses native workspaces, labels, finish notifications, and a background `paseo wait` backstop (`lead.md`); a lost notification triggers reconciliation, never duplicate dispatch. Review fixes reuse the original agent.
- Circuit breaker (`lead.md`): at most 3 attempts per task, then stop and escalate.
- Contract amendments after CP-1: main session updates tasks, human confirms, commit, Lead reloads; update `design.md` and re-run `freeze-check --structural`. A new interface or security boundary needs `hanlin` R0, its `R0: pass(...)` line APPENDED to `review.md` (last line wins).

## Merge gate
```
node "$PIPELINE_HOME"/merge-task.mjs \
  task/<change>/<T> <T> 'pass(<reviewer-uuid>@<tip>/<base>)'
```
`merge-task` checks identity, dependencies Done, Write scope, trailers, test-author protection, agent/model independence, review binding, base drift, Verify and a clean worktree, then no-ff merges and records Done. It proves Red itself (test-author commits alone must fail Verify on an assertion, else 33) and re-runs already-Done tasks' narrow Verify on the merged tree (whole-suite legs skipped). Exit codes: 2 usage; 10 conflict; 20 verify; 21 regression; 30 scope; 31 provenance; 32 review; 33 Red proof; 34 base/drift; 35 dependency; 36 unchecked-out dependencies; 37 attempt breaker; `--allow-attempt-over`: human only. Sole Done writer.

Exit 36: worktree cannot resolve a package or runner (`Cannot find package 'tsx'`, `command not found`). A linked worktree does not inherit `node_modules`/`.venv`. Install per lockfile and retry; never edit tests or Verify.

## Recovery
```
git log --first-parent integration/<change>
grep -n 'Done:' openspec/changes/<change>/tasks.md
paseo ls --label pipeline.change=<change> --json
```

Use live Paseo state, branch tips and Done lines; never re-dispatch on a delayed notification. One Lead; if archived, resume that ID with `templates/lead-resume.md`; never archive `pipeline.change=<change>` agents before CP-2.

## Finish
1. Require all tasks Done, no blocked/failed tasks, clean integration worktree.
2. On same final SHA, run full suite and all `Required=yes` acceptance commands; record evidence/SHA. In parallel, run one integrated Spec+Standards review via explicit Paseo profiles.
3. Confirmed blockers only: `gaogong` fixes them, then rerun suite/acceptance and have the original reviewer recheck the fix diff once. Remaining blockers mean not delivered.
4. Report final SHA, test/acceptance result, findings/NITs, task SHAs. CP-2 stays human. If main moved, revalidate at the new SHA.
5. After CP-2, present the cleanup list; delete/archive only after human confirmation. Push needs separate confirmation.

## Hard lines
- Lead/main session never edits business code; `chanpin` and `gaogong` write contract files only, never business code; `hanlin` writes nothing.
- No self-review; use actual provider/model values, not profile-name assumptions.
- No manual Done/check boxes; no full-suite Verify on non-sink tasks.
- Never treat a missing dependency as a Red result or fix it by editing tests/Verify; install in the workspace and rerun.
- No tenant/database/port/account sharing without declared isolation.
