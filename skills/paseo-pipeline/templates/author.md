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
- **Concurrent tasks must have fully disjoint Write scopes, including test paths.** `freeze-check` rejects scope overlap between tasks that can run in parallel. Never list a shared parent directory (e.g. `test`) when two concurrent tasks each own a file under it — list the individual files or subdirectories instead (e.g. `test/add.test.mjs` and `test/mul.test.mjs`). A coarse `test` scope on two parallel tasks collapses concurrency to zero.
- **Contract-first edges.** When a cross-layer or cross-module consumer needs only a signature, DTO or schema, freeze it in `design.md` (or the Wave 0 task) and make the consumer depend on that contract, not on the producer's implementation task. Keep a `Depends on` only when the consumer needs the producer's behavior to pass its own Verify.
- **Split shared files, don't chain them.** Several tasks writing one file (e.g. a service) are forced serial by `SCOPE_CONFLICT`. Where the design allows, split that file by feature so each task owns its own; if it cannot be split, accept the chain and say so.
- Verify must execute the code under test. For `Review: standard|strict` tasks, a test that only reads production source (`fs.readFileSync` + regex/string match) proves nothing about behavior: load and run (or render) it. Source-text assertions are for `Review: mechanical` tasks only; `hanlin` R0 flags them as a contract defect.
- Do not pad DAG to qualify. If real `maxWidth < 2` or task count < 4, recommend Tier 2.
- Run baseline full suite in a clean worktree; record known reds. Run `freeze-check --structural` (R0 sign-off does not exist yet) and report its route, waves, max width, and critical path. Read its `CRITICAL` line: each `-logical->` edge is yours to justify or drop (contract-first); each `-scope->` edge is forced by a shared file.

## Return envelope
`mode`, draft paths/content, evidence, assumptions/unverified, task count, max width, route, baseline, freeze-check result, blockers.
