# Change Author Brief

Mode: `SPEC` or `TASKS`. Change: `<change>`. Output location: `openspec/changes/<change>/`.

## Shared contract
- Read `SKILL.md` (the normative rules) and inspect relevant repository evidence; cite code claims as `path:line`. `LESSONS.md` is a 35KB historical evidence log, not a spec: consult a specific section only when a claim depends on past incidents, and never treat it as current procedure.
- Do not edit business code. Return assumptions with a concrete verification method; mark unverifiable claims `UNVERIFIED`.
- Report changed files, evidence, unresolved decisions, and acceptance commands. Do not invent provider/model requirements.

## Mode SPEC — Product/spec author (`chanpin`)
- Input: user-approved request and repository context. **Write output directly to OpenSpec files** (`openspec/changes/<change>/proposal.md`, `specs/<capability>/spec.md`, `digest.md`) — do not return text for the main session to re-type. Commit to the draft branch when done.
- Define user-visible behavior and constraints, not implementation task ownership or DAG.
- Each `SCEN-*` must state observable behavior and a falsifiable verification approach. Identify edge cases and compatibility assumptions.
- Digest: relevant modules, exported symbols, call sites, existing tests/fixtures, and baseline known failures with `path:line` evidence.

## Mode TASKS — Design/DAG author (`gaogong`)
- Input: approved Proposal/Spec and Codebase Digest. **Write output directly to OpenSpec files** (`design.md`, `tasks.md`, `acceptance.md`) — do not return text for the main session to re-type. Commit to the draft branch when done.
- For each changed exported symbol, search call sites and fixtures; record behavior conflicts and ownership in the required `## Impact Inventory` section of `design.md` (symbol, call sites, affected fixtures, owning task; write "no shared symbol change" if none). `freeze-check` rejects a missing section, tasks with no SCEN, and test-only scopes.
- Split into vertical behavior slices: behavior + wiring + affected fixtures + tests together. No fixture-only or wiring-only task. Wave 0 only for a real shared contract and only actual consumers depend on it.
- Each task has disjoint Write scope, explicit dependencies, claimed SCENs, and a narrow executable Verify inside its scope. Reserve full suite for one sink and final acceptance. Name Verify so it can run in a fresh worktree: prefer a command whose runner is a repo dependency or lockfile-pinned, since a global-only runner (`tsx`, `vitest` installed elsewhere) fails there.
- If a task's tests or Verify touch files outside its Write scope (a sibling's module, a shared fixture), declare them as `Reads: <paths>`. Without it, `merge-task` will not re-verify this task when that sibling merges; only the sink's full suite catches the break.
- **Concurrent tasks must have fully disjoint Write scopes, including test paths.** `freeze-check` rejects scope overlap between tasks that can run in parallel. Never list a shared parent directory (e.g. `test`) when two concurrent tasks each own a file under it — list the individual files or subdirectories instead (e.g. `test/add.test.mjs` and `test/mul.test.mjs`). A coarse `test` scope on two parallel tasks collapses concurrency to zero.
- Do not pad DAG to qualify. If real `maxWidth < 2` or task count < 4, recommend Tier 2.
- Run baseline full suite in a clean worktree; record known reds. Run `freeze-check --structural` (R0 sign-off does not exist yet) and report its route, waves, max width, and critical path.

## Return envelope
`mode`, draft paths/content, evidence, assumptions/unverified, task count, max width, route, baseline, freeze-check result, blockers.
