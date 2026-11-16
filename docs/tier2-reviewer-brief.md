# Tier 2 Reviewer Brief

Tier 2 only. Dispatcher fills fields and pastes this brief. See [`tier2-handoff-brief.md`](tier2-handoff-brief.md).

## Fill-in (dispatcher)
- **Requirements:** `<R1..R5, user's own words; at most 5>`
- **Target:** `<base + tip SHA, or plain diff + untracked list>`
- **Delivery evidence:** `<evidence per R; test command/output; known gaps>`
- **Entry points:** `<files / functions>`

## Review
Read-only: do not edit files, commit, or change workspace state. Report any write; it never voids verdict. One reviewer; one verdict and at most one recheck, limited to earlier blockers and regressions in fix diff. Do not redo supplied machine checks without concrete suspicion. Rechecks count per reviewer across all increments; a new increment does not reset the one allowed recheck.
Target uncommitted changes by absolute worktree path (`git -C <path> diff`); never use `isolation: worktree`, which sees a different tree. If the actual patch cannot be read, answer `INCOMPLETE`; that is a followup for the dispatcher, never a blocker.

## Output
First line: `PASS` | `BLOCKED` | `INCOMPLETE`.
Second line exactly: `Advisory evidence for the human's merge decision, not a merge gate.`
Requirement matrix (primary): one row per R: `MET` | `NOT_MET` | `UNVERIFIABLE` + `path:line` evidence.
Baseline (fixed 4 rows, do not extend): data loss / wrong external write | security/privacy | main-path crash or dead end without recovery | claimed tests exist and pass.
Verdict rule: `PASS` = all R `MET` and all baseline OK; else `BLOCKED` (advice only). `INCOMPLETE` only if target unreadable.
Followups: ≤5, never affect verdict.
Spec questions: undefined behavior for human; never affect verdict or trigger code-fix loop.
Limitations.

Tier 3 remains governed by `skills/paseo-pipeline/SKILL.md` and reviewer template. Review only when change touches hard risk: persistence/schema migration; production external write or deploy; auth/authorization/security; cross-request/process concurrency or idempotency. Otherwise dispatcher accepts per-R evidence and test output.

Recheck checks earlier blockers and fix-diff regressions only. Requirements and fixed baseline define review scope; no edge-case hunting or added criteria.
