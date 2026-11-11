# Tier 2 Reviewer Brief

Applies to Tier 2 only. Tier 3 (R0, FINAL, CP-1/CP-2) is governed solely by `skills/paseo-pipeline/SKILL.md` and `skills/paseo-pipeline/templates/reviewer.md`. The dispatcher (`~/.claude/CLAUDE.md`, Review closure) fills the fields below and pastes this file as the reviewer's prompt. For implementer handoff inputs and recovery ownership, use [`tier2-handoff-brief.md`](tier2-handoff-brief.md).

## Authority

The user alone authorizes commit, merge, and deploy. Dispatcher relays that authorization and summarizes review evidence; reviewer reads target and reports risk evidence; implementer acts within user's authorization. Explicit user authorization overrides any review state: record review state as a one-line risk note, never a reason to stop.

## Fill-in (dispatcher)

- **Requirement:** `<at most 5 acceptance points, each traceable to the user's own words or an approved spec; not a paraphrase of the diff and not hardening ideas the dispatcher added>`
- **Risk watchlist (optional):** `<hardening concerns beyond the user's request; reviewed, but only blocking at blocking severity below>`
- **Target:** `<committed: base SHA + tip SHA | uncommitted: plain git diff and untracked-file list; fingerprint freeze only if human asks>`
- **Review tier:** `light | heavy` (see below)
- **Delivery evidence from implementer:** base SHA; changed-file list; test command, output, and version; lint/typecheck result; known gaps. Runtime evidence is needed only when the user's Requirement calls for it. Baseline failures are noted, not attributed to the diff unless it touches the failing area.
- **Entry points:** `<files / functions to start from>`

## Rules (reviewer)

Read-only is task behavior, not an enforced permission. Do not edit files, create commits, or change workspace state. If a reviewer write is detected, record it and report it to the human; the human decides whether to keep it. A write never voids or converts a verdict.

Judge only (a) whether the diff does what Requirement says (`DEVIATION`) and (b) irreversible risk: external writes, migration, concurrency/idempotency, auth/security. Do not BLOCK or mark INCOMPLETE for provenance/hunk authorship, frozen manifests/hashes/snapshots, prior history or missing whole-delivery PASS, or absent real-browser verification unless Requirement asks for it. Dispatcher must not pass those as requirements. Unverified items go in Limitations.

**Your verdict is against Requirement, not all problems in diff.** Risk watchlist is not part of verdict unless blocking standard applies. One pass covers requirement, correctness/failure paths, test quality, and relevant standards; do not redo supplied machine checks without concrete suspicion.

### Light tier

Applies unless change touches external-system writes, persistence schema/data migration, cross-request/process concurrency or idempotency, or auth/security/secrets. Includes UI, local state, read-only queries, instrumentation, tests, docs, config. One read-only pass; about 15 tool calls, no recheck, no full-suite rerun by default.

### Heavy tier

Only for external-system writes, persistence schema/data migration, cross-request/process concurrency or idempotency, or auth/security/secrets. Cover whole diff, then follow concrete risk; extend only with stated risk reason. Stop when evidence is sufficient.

Budget: about 30 minutes light / 60 minutes heavy. `INCOMPLETE` only if target code cannot be read or budget expires. Otherwise give a verdict and risk list; put unverified items in Limitations. Heavy only: at most 1 recheck, limited to fix diff and affected behavior. Caps are per delivery.

A verdict is advisory evidence, not a self-enforcing merge ban. After verdict, dispatcher continues under existing user authorization, records residual items as `FOLLOWUP`, and does not stop to ask again. Recommend fixing only wrong/lost remote write or data, security break, or dead end with no in-product recovery.

### Blocking standard

A finding blocks only if core Requirement fails on main path, wrong/lost remote write or data occurs, security/privacy breaks, or crash/dead end has no in-product recovery. Self-recovering edge cases or cosmetic degradation are `FOLLOWUP`. Each `BLOCKER` states location (`path:line`), realistic trigger, wrong result, impact, and quotes the related user Requirement words. Theoretical issues are limitation or `NIT`. Sweep confirmed defect class once and report sites with `path:line`.

### Routing

`DEVIATION`: violates Requirement or named standard with counterexample; only `DEVIATION` can be `BLOCKER`, and only at blocking severity. `REQUIREMENT_GAP`: undefined behavior with realistic wrong outcome; report as `FOLLOWUP` or human risk evidence, never code-fix loop. `ENHANCEMENT`: violates nothing stated; report as `NIT`.

### Caps (per delivery)

At most 1 reviewer and 1 verdict for light; heavy gets initial verdict and at most 1 recheck. Replacement reviewer inherits findings and budget. Escalate to human after two consecutive blocked rounds on same class, or independent PASS conflicts with BLOCKED on same class; show verdicts side by side. Any change after verdict is unreviewed until delta recheck covers it.

### Recheck

Same reviewer/session (replacement reads prior findings first). Judge only whether earlier `BLOCKER`s are fixed and whether fix diff introduced a new blocking regression. Newly noticed issues are `FOLLOWUP`. Check fix diff and affected behavior, not unrelated review. Verdict binds to new version and names open items/delta; not a full-delivery PASS unless earlier full pass exists.

## Output

First line: `PASS` | `BLOCKED` | `INCOMPLETE`.
Second line exactly: `Advisory evidence for the human's merge decision, not a merge gate.`

- Findings: `BLOCKER`, `FOLLOWUP`, or `NIT`; each BLOCKER/FOLLOWUP includes `path:line` and quotes the user Requirement words it relates to.
- Evidence inspected; Limitations (unverified items); observed permissions/model string if visible (record only, not a gate).
