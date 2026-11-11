# Tier 2 Reviewer Brief

Tier 2 only. Tier 3 governed by `skills/paseo-pipeline/SKILL.md` and reviewer template. Dispatcher fills fields and pastes this brief. Handoff: [`tier2-handoff-brief.md`](tier2-handoff-brief.md).

## Fill-in (dispatcher)
- **Requirement:** `<at most 5 acceptance points from user's own words or approved spec>`
- **Risk watchlist:** `<hardening beyond request; not acceptance>`
- **Target:** `<committed base + tip SHA | uncommitted plain git diff + untracked list>`
- **Review tier:** `light | heavy`
- **Delivery evidence:** `<base SHA; changed files; test command/output/version; lint/typecheck; known gaps>`
- **Entry points:** `<files / functions>`

## Review
Read-only behavior: do not edit files, commit, or change workspace state. Report any write; it never voids or converts verdict. Judge Requirement deviation (`DEVIATION`) and irreversible risk: external writes, migration, concurrency/idempotency, auth/security. Unverified items go in Limitations; do not redo supplied machine checks without concrete suspicion.

`light`: UI, local state, read-only, instrumentation, tests, docs, config; one pass, no recheck. `heavy`: external writes, persistence migration, cross-request/process concurrency or idempotency, auth/security; one pass and at most one recheck. Budget: about 30 minutes light / 60 minutes heavy. `INCOMPLETE` only if target unreadable or budget expires.

### Blocking standard
Block only when core Requirement fails on main path, wrong/lost remote write or data occurs, security/privacy breaks, or crash/dead end has no in-product recovery. Self-recovering edge cases and cosmetic degradation are `FOLLOWUP`. Each blocker cites `path:line`, trigger, wrong result, impact, and related user Requirement words.

### Routing
`DEVIATION`: violates Requirement or named standard; only this can be `BLOCKER`, at blocking severity. `REQUIREMENT_GAP`: realistic wrong outcome from undefined behavior; never code-fix loop. Human disposition only at blocking severity; otherwise `FOLLOWUP`. `ENHANCEMENT`: violates nothing stated; report as `NIT`.

### Caps
At most 1 reviewer; light 1 verdict; heavy initial verdict plus at most 1 recheck. Recheck covers earlier blockers and fix-diff regressions; new findings are `FOLLOWUP`. After cap, stop; residual items remain advisory `FOLLOWUP` under user's authorization.

## Output
First line: `PASS` | `BLOCKED` | `INCOMPLETE`.
Second line exactly: `Advisory evidence for the human's merge decision, not a merge gate.`
Findings: `BLOCKER`, `FOLLOWUP`, or `NIT`; include `path:line` and related user Requirement words. Include evidence inspected and Limitations.
