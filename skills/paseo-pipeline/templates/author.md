# Change Author Brief

Mode: `SPEC` or `TASKS`. Change: `<change>`. Output location: `openspec/changes/<change>/`.

## Shared contract
- Read `SKILL.md` (the normative rules) and inspect relevant repository evidence; cite code claims as `path:line`. `LESSONS.md` is a 35KB historical evidence log, not a spec: consult a specific section only when a claim depends on past incidents, and never treat it as current procedure.
- Do not edit business code. Return assumptions with a concrete verification method; mark unverifiable claims `UNVERIFIED`.
- Report changed files, evidence, unresolved decisions, and acceptance commands. Do not invent provider/model requirements.
- `TASKS` fast path (`gongbu`): when a human-approved design document already exists, skip `chanpin` and write `design.md`, `tasks.md`, `acceptance.md` directly from it. Cite the design section per task instead of re-deriving the DAG; no proposal/spec rewrite. If the design lacks SCEN ids, stop and request them — `freeze-check` reconciles scenarios against the spec.

## Baseline alignment (both modes; R0 checks it first)
- The request and the design document are inputs, not evidence. Before writing a rule they imply, read what the rule collides with: the capability specs it touches (`openspec/specs/<cap>/spec.md`), the enum/`CHECK`/migration it would store into, and the existing tests and fixtures for every file in scope. `rg` the identifiers the rule names (statuses, error codes, fields). A rule that contradicts a `CHECK` constraint, an existing scenario, or a passing test is a contract defect the author must fix now — review is for defects the author could not see.
- `SPEC` records the baseline evidence in `digest.md` (`## Baseline Alignment`); `TASKS` turns it into one verdict row per rule in `design.md` (`## Baseline Alignment`) and picks exactly one resolution:
  - `reuse` — the existing state/enum/behaviour already covers it; cite the line that proves it.
  - `delta` — behaviour changes: add `specs/<capability>/spec.md` in the change with a `## MODIFIED Requirements` section naming the baseline Requirement **verbatim**, plus every baseline test whose assertions change and the task that owns it. Only the owning task edits that test later; this authoring commit records the change, it does not perform it.
  - `additive` — a new sibling symbol/path; the existing symbol, its callers and its tests stay byte-identical. Add a delta spec for the new requirement and say so.
- Walk the baseline, not only your new rules: for each touched capability spec list every Requirement the change keeps, changes or drops. A dropped control, view or field needs a `delta` naming that Requirement verbatim — `additive` only when the baseline path stays byte-identical. When a rule generalises an existing predicate, name every existing test assertion that flips, including empty and zero inputs.
- Every verdict row carries `path:line` evidence. The digest names the baseline specs and tests read and the `rg` command used, or `none` with that command. An empty or assertion-free section is not alignment; `freeze-check` warns on it and R0 blocks on it.
- One rule has one wording. If the same rule appears in an ADR, `GLOSSARY.md`, proposal, spec, design or tasks, quote it identically; when it changes, `rg` the phrase and update every copy in the same commit.
- If you cannot verify a claim, mark it `UNVERIFIED` and name the command that would settle it. Never present a guessed enum value or status as existing.

## Mode SPEC — Product/spec author (`chanpin`)
- Input: user-approved request and repository context. **Write output directly to OpenSpec files** (`openspec/changes/<change>/proposal.md`, `specs/<capability>/spec.md`, `digest.md`) — do not return text for the main session to re-type. Commit to the draft branch when done.
- Define user-visible behavior and constraints, not implementation task ownership or DAG.
- Each `SCEN-*` must state observable behavior and a falsifiable verification approach. Identify edge cases and compatibility assumptions.
- Digest: the baseline surfaces the rules touch — capability specs, `CHECK`/enums, cited test files — with `path:line` evidence and the commands used. Do not inventory unrelated modules, do not run the suite or probe runners (the TASKS author records baseline reds), and do not mine other changes for format: the schema templates are the format.

## Mode TASKS — Design/DAG author (`gaogong`)
- Input: approved Proposal/Spec and Codebase Digest. **Write output directly to OpenSpec files** (`design.md`, `tasks.md`, `acceptance.md`) — do not return text for the main session to re-type. Commit to the draft branch when done.
- For each changed exported symbol, search call sites and fixtures; record behavior conflicts and ownership in the required `## Impact Inventory` section of `design.md` (symbol, call sites, affected fixtures, owning task; write "no shared symbol change" if none). `freeze-check` rejects a missing section, tasks with no SCEN, and test-only scopes.
- Split into vertical behavior slices: behavior + wiring + affected fixtures + tests together. No fixture-only or wiring-only task. Wave 0 only for a real shared contract and only actual consumers depend on it.
- Each task has disjoint Write scope, explicit dependencies, claimed SCENs, and a narrow executable Verify inside its scope. Reserve full suite for one sink and final acceptance. Name Verify so it can run in a fresh worktree: prefer a command whose runner is a repo dependency or lockfile-pinned, since a global-only runner (`tsx`, `vitest` installed elsewhere) fails there.
- **Concurrent tasks must have fully disjoint Write scopes, including test paths.** `freeze-check` rejects scope overlap between tasks that can run in parallel. Never list a shared parent directory (e.g. `test`) when two concurrent tasks each own a file under it — list the individual files or subdirectories instead (e.g. `test/add.test.mjs` and `test/mul.test.mjs`). A coarse `test` scope on two parallel tasks collapses concurrency to zero.
- **Contract-first edges.** When a cross-layer or cross-module consumer needs only a signature, DTO or schema, freeze it in `design.md` (or the Wave 0 skeleton task) and make the consumer depend on that contract, not on the producer's implementation task. Keep a `Depends on` only when the consumer needs the producer's behavior to pass its own Verify.
- **Uses / skeleton instead of a serial chain.** Give the interface owner `Kind: skeleton` + `Review: mechanical` and list what it freezes in `Interface: <path>#<symbol>`. A consumer that only needs the signature writes `Uses: <skeleton-id>` (dispatch waits for the skeleton, merge waits for the producer) instead of `Depends on`. `Uses` targets must declare `Interface:`; overlapping Write scopes still need a real `Depends on`. `Reads:` lists paths a Verify leg may execute against without writing them — it never authorises edits.
- **Scheduling weight and deferred review.** `Est: S|M|L` (default M) feeds the weighted critical-path model. `Review: deferred` moves a standard task's review into the one FINAL integrated review; it is illegal on the sink and on `persistence`/`security` surfaces (those stay `strict`).
- **Split shared files, don't chain them.** Several tasks writing one file (e.g. a service) are forced serial by `SCOPE_CONFLICT`. Where the design allows, split that file by feature so each task owns its own; if it cannot be split, accept the chain and say so.
- Verify must execute the code under test. For `Review: standard|strict` tasks, a test that only reads production source (`fs.readFileSync` + regex/string match) proves nothing about behavior: load and run (or render) it. Source-text assertions are for `Review: mechanical` tasks only; `hanlin` R0 flags them as a contract defect.
- Do not pad DAG to qualify. If real `maxWidth < 2` or task count < 4, recommend Tier 2.
- Run baseline full suite in a clean worktree; record known reds. Run `freeze-check --structural` (R0 sign-off does not exist yet) and report its route, waves, max width, and critical path. Read its `CRITICAL` line: each `-logical->` edge is yours to justify or drop (contract-first); each `-scope->` edge is forced by a shared file.

## Return envelope
`mode`, draft paths/content, evidence, assumptions/unverified, task count, max width, route, baseline, freeze-check result, blockers.
