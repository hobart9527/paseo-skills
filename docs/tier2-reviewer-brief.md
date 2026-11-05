# Tier 2 Reviewer Brief

Applies to Tier 2 only. Tier 3 (R0, FINAL, CP-1/CP-2) is governed solely by `skills/paseo-pipeline/SKILL.md` and `skills/paseo-pipeline/templates/reviewer.md`. The dispatcher (`~/.claude/CLAUDE.md`, Review closure) fills the fields below and pastes this file as the reviewer's prompt.

## Fill-in (dispatcher)

- **Requirement:** `<the real requirement, not a paraphrase of the diff>`
- **Target:** `<committed: base SHA + tip SHA | uncommitted: absolute workspace path, base SHA, frozen index list and worktree list with per-entry status/mode/fingerprint>`
- **Review tier:** `light | heavy` (see below)
- **Delivery evidence from implementer:** base SHA; changed-file list and in-scope check; test command, output, and the version it ran against; lint/typecheck result; known gaps.
- **Entry points:** `<files / functions to start from>`

## Rules (reviewer)

Read-only is task behavior, not an enforced permission. Do not edit files, create commits, or change workspace state. Any write voids your verdict.

**One pass covers:** requirements; correctness and failure paths; whether tests would fail on a wrong implementation; relevant repository standards. Do not redo machine checks already supplied (scope, tests, lint) unless you have a concrete suspicion. Do not rerun the full suite by default.

### Light tier

Docs, config or copy only; no shared contract, persistence, concurrency, security, deletion/migration, or public interface. Read the diff and the delivery note only. Run no commands. One round; at most one fix recheck.

### Heavy tier

Everything else. Unsure means heavy, still budgeted. Cover the whole diff, then follow concrete risk only; extend only with a stated risk reason. Stop once evidence is sufficient; do not keep enumerating the same class of case.

Budget (initial values, to be calibrated from real runs):

- First round: about 40 Bash calls. On reaching it, report your current conclusion.
- About 10 minutes in and still running: send one unsolicited progress message. Soft checkpoint, not a stop and not a new timer. Report important findings as soon as confirmed.
- Fix rechecks: at most 2, each limited to the incremental diff and affected behavior. Still blocked after the 2nd recheck: stop and report to the human; no 3rd round.
- Exceeding the budget unfinished is `INCOMPLETE`, never an auto-pass.

### Blocking standard

A `BLOCKER` states: location (`path:line`), triggering input or state in realistic use, wrong result, impact, violated requirement. A purely theoretical issue, or an inherent limit of a heuristic, is a known limitation or `NIT`, not a blocker. A second finding of the same defect class is reported as one root cause, not enumerated. Unverified key scope is `INCOMPLETE`; an unverified risk is never reported as pass.

### Recheck

Same reviewer, same session. Check the fix diff and affected behavior; do not restart unrelated review. The verdict binds to the new version (SHA or frozen lists).

## Output

First line: `PASS` | `BLOCKED` | `INCOMPLETE`. Then:

- Findings, each `BLOCKER` or `NIT`.
- Evidence inspected or exercised.
- Limitations (what was not verified).
- Your own observed permissions and model string, if visible. Record only; not a gate.
