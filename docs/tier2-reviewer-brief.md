# Tier 2 Reviewer Brief

Tier 2 delivery gate (applies to both delegated `/tier2-handoff` and main-session-in-worktree Tier 2 work). The caller fills the fields and pastes this brief. See [`tier2-handoff-brief.md`](tier2-handoff-brief.md).

## Fill-in (caller)
- **Requirements:** `<R1..R5, user's own words; at most 5>`
- **Target:** `<base + tip SHA, or plain diff + untracked list>`
- **Delivery evidence:** `<evidence per R; risk-scan output; test command/output; known gaps>`
- **Entry points:** `<files / functions>`
- **Risk class:** `<Risk: class + path:line, or risk-scan hits / test-oracle mutation>`; if both `Risk: none` and `risk-scan` is clean, no reviewer is needed.
- **Independence:** `<actual target contributors + reviewer profile ids / declared families>`; 审查（按察司）must not review its own contribution, and the main session must not self-review its own worktree edits. Resolve live profiles; aliases alone do not prove family diversity. Reconcile HEAD, tracked diff and untracked files before/after when writes are not prevented.
- **Testing:** `<owner tests | independent Red packet>`; inspect whether claimed Verify/tests exercise real entry points (not source-text regex or mocked-out core logic) and whether existing assertions were weakened.

## Review
Read-only: do not edit files, commit, or change workspace state. Report any write; it never voids verdict.
**Strict 1+1 budget per delivery:** One reviewer; 1 initial verdict + at most 1 delta recheck (limited strictly to earlier blockers and regressions in the fix diff). Never swap reviewers to reset the budget. Do not redo supplied machine checks without concrete suspicion.
Target uncommitted changes by absolute worktree path (`git -C <path> diff`); never use `isolation: worktree`, which sees a different tree. If the actual patch cannot be read, answer `INCOMPLETE`; that is a followup for the caller, never a blocker.

## Output
First line: `PASS` | `BLOCKED` | `INCOMPLETE`.
Second line exactly: `Advisory evidence for the human's merge decision, not an autonomous loop; an unresolved BLOCKED verdict requires explicit human acceptance or fix before merge.`
Requirement matrix (primary): one row per R: `MET` | `NOT_MET` | `UNVERIFIABLE` + `path:line` evidence.
Oracle fidelity: confirm real entry exercised and no silent assertion weakening (`OK` | `NOT_MET` + `path:line`).
Baseline (fixed 4 rows — with Oracle fidelity above, forms the same 5 fixed standards as `templates/reviewer.md`; do not extend):
1. Data loss / wrong external write / money semantics error
2. Security / auth / privacy bypass
3. Main-path crash or dead end without recovery
4. Concurrency / idempotency race

Verdict rule: `PASS` = all R `MET`, Oracle fidelity `OK`, and all 4 baseline rows `OK`; else `BLOCKED`. `INCOMPLETE` only if target unreadable.
Spec questions: undefined behavior for human; never affect verdict or trigger a code-fix loop.
Limitations (only if target unreadable or unverified).
**Out of scope:** Do not emit `Followups`, `ENHANCEMENT` lists, style nits, or speculative edge-case hunting outside Requirements, Oracle fidelity, and the 4 baseline rows.

Recheck checks earlier blockers and fix-diff regressions only. If still `BLOCKED` after the single allowed recheck, stop immediately and return the matrix verbatim for human decision; never start a third review.
