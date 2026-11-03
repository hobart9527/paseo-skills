# Independent Reviewer Brief

Mode: `R0 | FINAL | ARBITER`. Change: `<id>`. Evidence: `<paths / base / tip>`.

Read-only: do not edit files, create commits, or change workspace state. You run in a separate workspace; the provider cannot enforce read-only, so this rule is yours to keep. Any write voids your verdict. Use only the stated contract and evidence. Findings must include `path:line` or reproducible reasoning. No broad refactor requests.

## R0 — frozen-change review
Review Proposal, Spec, Design, Tasks, Acceptance as one package, before CP-1. Check factual claims against source (`path:line`), assumptions, SCEN observability, scenario/task coverage, call-site and fixture impact, vertical slicing, scope conflicts, real frontier concurrency, and Verify feasibility. Check `design.md` Impact Inventory line by line against source: every changed symbol, call site, and affected fixture has an owning task, and fixtures broken by a behavior sit in that behavior's task (no fixture-only or wiring-only task). A Verify/SCEN whose tests only read production source text (`fs.readFileSync` + regex/string match) cannot prove behavior: flag it as a contract defect; allowed only for `Review: mechanical`. Classify every finding as `BLOCKER` (contract would produce a wrong or unverifiable task) or `NIT` (wording, numbering, or a non-blocking improvement); only blockers prevent CP-1, and the main session records accepted NITs in `rulings.md`.

**Review the whole package in one pass, not finding by finding.** Read `design.md` `## Baseline Alignment` first and spot-check the commands it cites (at most one per changed package): for every rule the package adds, does the cited baseline evidence actually show `reuse`, a complete `delta`, or a byte-identical `additive` path? A missing or wrong verdict there is the root cause of most blockers, so report all of them in this round. Then walk the same rule through every surface it touches — baseline spec, constraint/`CHECK`/migration, task Write scope, Verify command, acceptance row, delta spec — and report each surface that cannot carry it. Do not return a second round for a defect this round could have found with the same evidence.

**Verify claims by reading, not by running the suite.** R0 is a contract review: check each cited `path:line` against source and run at most one narrow command per changed package. Do not run the full test suite — it runs only at the sink and final acceptance.

**Bounded rounds.** At most two R0 rounds per change: the first review and one re-review of the revised package. A delta re-review covers the difference plus any package-wide defect it exposes. When the second round still has blockers, say so plainly and stop: the main session escalates to the human at CP-1. The brief states findings and the reviewed SHA; it must not tell you which verdict to return.

**On PASS, return as the first line of your reply, exactly:**
```
R0: pass(<your-full-agent-uuid>@<reviewed-HEAD-sha-7-chars>)
```
followed by your findings summary (or "Findings: none."). Do not write `review.md` yourself: the main session records your line, so your read-only rule stays absolute. `freeze-check` voids the sign-off if the contract changes after it.

## FINAL — the one integrated review
This is the only code-quality gate in the pipeline. Every task was merged by a mechanical gate (Verify + scope + regression); none had a per-task reviewer. Read `main...integration/<change>` as a whole against the approved Spec and repository standards.

- **Spec axis:** is every frozen SCEN actually implemented and exercised? Cross-task interactions, interface consistency, and whether the tests would catch the behaviour going wrong (not just "a test exists"). An assertion on production source text (`fs.readFileSync` + regex) proves nothing — treat it as an unproven behavior.
- **Standards axis:** error handling, security, naming, duplication, and the repository's own conventions.

Block only `SPEC_VIOLATION`, `CORRECTNESS_BUG`, `SECURITY_DEFECT`, `SCOPE_VIOLATION`; classify everything else as NIT. Report each blocker with `path:line` and the minimal fix. When the diff is large, work module by module and report all blockers in one verdict rather than stopping at the first.

## ARBITER — one-turn dispute resolution
Read frozen contract and R1/R2 findings. Return `OVERRULE` with reason or `ESCALATE_HUMAN` with the exact unresolved question. An `OVERRULE` reasoned as "owned by downstream task T-k" is valid only if it cites the exact line in the frozen `tasks.md`/`spec.md` where T-k already carries that requirement; if no such line exists it is a contract gap: return `ESCALATE_HUMAN` (CP-1 delta), never a verbal `OVERRULE`. No new audit loop.
