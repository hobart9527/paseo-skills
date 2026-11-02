# Independent Reviewer Brief

Mode: `R0 | TASK | FINAL | ARBITER`. Change/task: `<id>`. Evidence: `<paths / base / tip>`.

Read-only: do not edit files, create commits, or change workspace state. You run in a separate workspace; the provider cannot enforce read-only, so this rule is yours to keep. Any write voids your verdict. Use only stated contract and evidence. Findings must include path/line or reproducible reasoning. No broad refactor requests.

## R0 — frozen-change review
Review Proposal, Spec, Design, Tasks, Acceptance as one package. Check factual claims against source (`path:line`), assumptions, SCEN observability, scenario/task coverage, call-site and fixture impact, vertical slicing, scope conflicts, real frontier concurrency, and Verify feasibility. Check `design.md` Impact Inventory line by line against source: every changed symbol, call site, and affected fixture has an owning task, and fixtures broken by a behavior sit in that behavior's task (no fixture-only or wiring-only task). For `Review: standard|strict` tasks, a Verify/SCEN whose tests only read production source text (`fs.readFileSync` + regex/string match) cannot prove behavior: flag it as a contract defect (tests must load and execute, or render, the code under test); allowed only for `Review: mechanical`. Return `PASS` or prioritized findings with evidence and required contract correction. One review; authors may revise once before CP-1.

**On PASS, return as the first line of your reply, exactly:**
```
R0: pass(<your-full-agent-uuid>@<reviewed-HEAD-sha-7-chars>)
```
followed by your findings summary (or "Findings: none."). Do not write `review.md` yourself: the main session records your line, so your read-only rule stays absolute. `<reviewed-HEAD-sha>` is the commit named in your brief; `freeze-check` voids the sign-off if the contract changes after it.

## TASK — task audit
Compare `git diff <base>..<tip>` with frozen task contract. Block only `SPEC_VIOLATION`, `CORRECTNESS_BUG`, `SECURITY_DEFECT`, `SCOPE_VIOLATION`; classify other issues as NIT. For `Review: standard|strict`, tests that assert on production source text (`fs.readFileSync` + regex/string match) instead of loading and executing (or rendering) the code under test leave behavior unproven: block as `SPEC_VIOLATION`; this is acceptable only for `Review: mechanical`. R2 checks prior blockers and rework delta; may block only on an actual correctness/security/spec/scope defect. Return verdict, blockers, NITs, and `pass(<reviewer-id>@<tip>/<base>)`.

## FINAL — integrated code review
Review `main...integration/<change>` against approved Spec and repository standards, including cross-task interactions and tests. Separate Spec findings from Standards findings. Only the four blocker classes above block delivery; other findings are NIT. Return evidence, severity, and concise verdict.

## ARBITER — one-turn dispute resolution
Read frozen contract and R1/R2 findings. Return `OVERRULE` with reason or `ESCALATE_HUMAN` with exact unresolved question. An `OVERRULE` reasoned as "owned by downstream task T-k" is valid only if it cites the exact line in the frozen `tasks.md`/`spec.md` where T-k already carries that requirement; if no such line exists it is a contract gap: return `ESCALATE_HUMAN` (CP-1 delta), never a verbal `OVERRULE`. No new audit loop.
