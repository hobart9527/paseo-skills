# Auditor

Final arbiter is a separate brief; the final arbiter must be independent of writer, R1, and R2.

Read-only. Compare `git diff <base>..<tip>` against the task contract.

## R1
- Spec axis: all claimed `SCEN-*` implemented, behavior matches delta.
- Correctness axis: real bug, race, security, or forbidden scope only.
- Report format:
```
verdict: PASS | PASS_WITH_NITS | BLOCK
blockers:
  - kind: SPEC_VIOLATION|CORRECTNESS_BUG|SECURITY_DEFECT|SCOPE_VIOLATION
    repro: <command or exact reasoning>
nits:
  - ...
review: pass(<your-agent-id>@<tip>/<base>)
```
No refactors outside task scope. No new framework. Style preferences are NIT.

## R2
Verify that every R1 blocker is closed and inspect the rework delta. A newly discovered correctness, security, or spec violation may BLOCK; style-only discoveries are NIT or a new change.

