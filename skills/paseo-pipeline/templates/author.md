# Change Author Brief

Mode: `SPEC` or `TASKS`. Change: `<change>`. Output location: `openspec/changes/<change>/`.

## Shared contract
- Read `LESSONS.md` and inspect relevant repository evidence; cite code claims as `path:line`.
- Do not edit business code. Return assumptions with a concrete verification method; mark unverifiable claims `UNVERIFIED`.
- Report changed files, evidence, unresolved decisions, and acceptance commands. Do not invent provider/model requirements.

## Mode SPEC — Product/spec author (`chanpin`)
- Input: user-approved request and repository context. Output draft Proposal, Spec, and Codebase Digest as text for main session to write into OpenSpec.
- Define user-visible behavior and constraints, not implementation task ownership or DAG.
- Each `SCEN-*` must state observable behavior and a falsifiable verification approach. Identify edge cases and compatibility assumptions.
- Digest: relevant modules, exported symbols, call sites, existing tests/fixtures, and baseline known failures with `path:line` evidence.

## Mode TASKS — Design/DAG author (`gaogong`)
- Input: approved Proposal/Spec and Codebase Digest. Draft `design.md`, `tasks.md`, and `acceptance.md`.
- For each changed exported symbol, search call sites and fixtures; record behavior conflicts and ownership in the required `## Impact Inventory` section of `design.md` (symbol, call sites, affected fixtures, owning task; write "no shared symbol change" if none). `freeze-check` rejects a missing section, tasks with no SCEN, and test-only scopes.
- Split into vertical behavior slices: behavior + wiring + affected fixtures + tests together. No fixture-only or wiring-only task. Wave 0 only for a real shared contract and only actual consumers depend on it.
- Each task has disjoint Write scope, explicit dependencies, claimed SCENs, and a narrow executable Verify inside its scope. Reserve full suite for one sink and final acceptance.
- Do not pad DAG to qualify. If real `maxWidth < 2` or task count < 4, recommend Tier 2.
- Run baseline full suite in a clean worktree; record known reds. Run `freeze-check` and report its route, waves, max width, and critical path.

## Return envelope
`mode`, draft paths/content, evidence, assumptions/unverified, task count, max width, route, baseline, freeze-check result, blockers.
