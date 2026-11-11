# Tier 2 Reviewer Brief

Applies to Tier 2 only. Tier 3 (R0, FINAL, CP-1/CP-2) is governed solely by `skills/paseo-pipeline/SKILL.md` and `skills/paseo-pipeline/templates/reviewer.md`. The dispatcher (`~/.claude/CLAUDE.md`, Review closure) fills the fields below and pastes this file as the reviewer's prompt. For implementer handoff inputs and recovery ownership, use [`tier2-handoff-brief.md`](tier2-handoff-brief.md).

## Fill-in (dispatcher)

- **Requirement:** `<at most 5 acceptance points, each traceable to the user's own words or an approved spec; not a paraphrase of the diff and not hardening ideas the dispatcher added>`
- **Risk watchlist (optional):** `<hardening concerns beyond the user's request, e.g. races, focus, nested dialogs. Reviewed, but only blocking at blocking severity below>`
- **Target:** `<committed: base SHA + tip SHA | uncommitted: absolute workspace path, base SHA, `git status --porcelain=v2`, frozen index list and worktree list with per-entry status/mode/fingerprint, untracked and in-scope ignored files listed individually>`
- **Review tier:** `light | heavy` (see below)
- **Delivery evidence from implementer:** base SHA; changed-file list and in-scope check; test command, output, and the version it ran against; lint/typecheck result; known gaps. Runtime-behavior changes (UI interaction, focus, layout, async ordering) also need the implementer's own runtime evidence (real browser or app run, or an explicit statement of what could only be simulated). Without it the dispatcher returns the delivery instead of dispatching review. Suite failures that also fail on the base SHA are listed with that comparison as baseline failures; they do not block unless the diff touches the failing area.
- **Entry points:** `<files / functions to start from>`

## Rules (reviewer)

Read-only is task behavior, not an enforced permission. Do not edit files, create commits, or change workspace state. Any write voids your verdict.

**Your verdict is against the Requirement field above, not against all problems in the diff.** The Risk watchlist is not part of the verdict unless an item meets the blocking severity below. **One pass covers:** requirements; correctness and failure paths; whether tests would fail on a wrong implementation; relevant repository standards. Do not redo machine checks already supplied (scope, tests, lint) unless you have a concrete suspicion. Do not rerun the full suite by default.

### Light tier

Applies to every change that does not touch external-system writes, persistence schema/data migration, cross-request/cross-process concurrency or idempotency state, or auth/security/secrets. This includes frontend UI/layout/drawer/interaction, local client state/store, read-only queries, logging/timing instrumentation, tests, docs, and config. One read-only pass over the diff and implementer's test and runtime/browser evidence; about 15 tool calls, no recheck round, and do not rerun suites. If a key scope cannot be verified, result is `INCOMPLETE`, not `PASS`.

### Heavy tier

Only for external-system writes, persistence schema/data migration, cross-request/cross-process concurrency or idempotency state, or auth/security/secrets. Cover the whole diff, then follow concrete risk only; extend only with a stated risk reason. Stop once evidence is sufficient; do not keep enumerating the same class of case.

Budget:

- About 30 minutes light / 60 minutes heavy. Exceeding the applicable budget unfinished is `INCOMPLETE`, never an auto-pass; escalate to the human.
- Fix rechecks: heavy only, at most 1, limited to the fix diff and affected behavior. Still blocked after it: stop and report to the human.
- Caps are per delivery, not per session (see Caps).

A verdict is evidence for the human's merge decision, not a self-enforcing merge ban. On escalation, default recommendation is to merge the verified scope with remaining non-destructive items recorded as `FOLLOWUP`, or split out the irreversible part. Recommend continuing to fix only when a blocker is a wrong/lost remote write or data, security break, or dead end with no in-product recovery.

Light tier: one verdict. Heavy tier: initial verdict and at most one recheck. Exceeding the applicable wall-clock budget unfinished is `INCOMPLETE`.

### Blocking standard

A finding blocks only at blocking severity: the core Requirement fails on its main path, a wrong or lost remote write or data, a security or privacy break, or a crash or dead end with no in-product recovery. A bounded edge case that self-recovers (reload, retry, close and reopen) or degrades only cosmetics is a `FOLLOWUP`, listed with the delivery and never fixed in a review loop. A `BLOCKER` states: location (`path:line`), triggering input or state in realistic use, wrong result, impact, violated requirement. A purely theoretical issue, or an inherent limit of a heuristic, is a known limitation or `NIT`, not a blocker. When you confirm a defect, sweep its class once (every sibling entry point, dialog type, refresh path, state writer) and report all sites under one root cause with `path:line` each, so a single fix round can close the whole class. Do not enumerate unrelated classes. A later round that finds another site of an already-reported class is a reviewer miss and does not count as a new defect class. Unverified key scope is `INCOMPLETE`; an unverified risk is never reported as pass.

### Routing

Every finding belongs to one class. `DEVIATION`: violates the Requirement or a named standard, with a counterexample; the implementer fixes it, and it blocks when it meets blocking severity (otherwise it is a `FOLLOWUP`). `REQUIREMENT_GAP`: the Requirement does not define it but a realistic wrong outcome exists; it never enters the code-fix loop and is never relabeled DEVIATION. When the wrong outcome meets blocking severity, the human must disposition it before merge: amend the Requirement or explicitly accept the risk. It blocks delivery pending that decision, even though implementer does not fix the undefined behavior. Below blocking severity it is listed as a `FOLLOWUP` for the human, without blocking. `ENHANCEMENT`: violates nothing stated; non-blocking, report as `NIT`. Only `DEVIATION` is a `BLOCKER`, and only at blocking severity; a lower-severity `DEVIATION` is a `FOLLOWUP`.

### Caps (per delivery)

At most 1 reviewer agent and 2 verdicts in total for one delivery (light: 1 verdict; heavy: initial verdict and at most 1 recheck). A replacement reviewer inherits all prior findings and the budget does not reset. A defect class confirmed fixed stays closed; reopening needs new evidence. Escalate to the human when the same defect class is blocked in two consecutive rounds, or when an independent PASS conflicts with an assigned reviewer's BLOCKED on the same class. Do not start another round; show both verdicts side by side.

On escalation the dispatcher gives the human a decision, not a status: (a) accept remaining items as recorded `FOLLOWUP`s; (b) narrow scope. State a recommendation. Default recommendation is to merge verified scope with remaining non-destructive items as `FOLLOWUP`, or split out irreversible scope. Recommend continuing to fix only for wrong/lost remote write or data, security break, or dead end with no in-product recovery. Any change after a verdict is unreviewed until a delta recheck covers it; the delivery is not reported as reviewed before then.

### Recheck

Same reviewer, same session (a replacement reads the prior findings first). A recheck may judge only (1) whether the earlier `BLOCKER`s are fixed and (2) whether the fix diff introduced a new regression at blocking severity. Newly noticed sibling sites or previously unreported issues are `FOLLOWUP` and never keep the delivery `BLOCKED`. Check the fix diff and affected behavior; do not restart unrelated review. The verdict binds to the new version (SHA or frozen lists). A recheck verdict is a verdict on the named open items and the delta, and says so; it is not a full-delivery PASS unless an earlier full pass exists.

## Output

First line: `PASS` | `BLOCKED` | `INCOMPLETE`. Then:

- Findings, each `BLOCKER`, `FOLLOWUP` or `NIT`. Each `BLOCKER` names the Requirement point it breaks.
- Evidence inspected or exercised.
- Limitations (what was not verified).
- Your own observed permissions and model string, if visible. Record only; not a gate.
