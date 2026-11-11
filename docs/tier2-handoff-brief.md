# Tier 2 Handoff Brief

## Assignment
- **Workspace:** `<absolute path>`
- **Branch:** `<branch>`
- **Base SHA:** `<full commit SHA>`
- **Scope and acceptance:** `<files / behavior / tests>`
- **Authorization:** `<quote user's words and scope, e.g. "user 2026-11-12: commit and merge this worktree, no push"; if user said nothing: "No commit/merge/push without user instruction">`. User alone authorizes commit/merge/deploy. A relayed “Lead says” authorization quoting user is valid; do not demand user restate it directly. When user later authorizes, dispatcher re-sends updated Authorization to running implementers; never forward old prohibition. Follow present Authorization even if prior review was BLOCKED/INCOMPLETE. Do not carry prior review status (“not fully reviewed”, “do not claim PASS”, etc.) into new handoffs.
- **Pending decisions:** `<open product/design choices, each with a default>`. An open decision with no default is resolved by dispatcher before dispatch, not by implementer.

## Ownership and delivery
- Implementer acts within user's Authorization. Dispatcher relays authorization and summarizes review evidence; reviewer reads target and reports risk evidence only. Explicit user instruction to commit/merge/deploy overrides review state; treat state as a one-line risk note, never a reason to stop.
- Dispatching session owns review dispatch. Human owns merge approval.
- No recursive handoff. Return blockers or incomplete work to dispatching session.
- Process choices (commit granularity, order of items, test placement) are yours: take smallest option inside assigned scope and proceed. Return `BLOCKED` only when scope exceeds assignment or required information is missing.
- Report with: `COMPLETE | BLOCKED | INCOMPLETE`; base and tip SHA; changed-file list; full-suite command with pass/fail counts at tip; red-then-green evidence per item; known gaps and simulated behavior. A failing test is reported as failing, never as fixture problem unless proven.
- Runtime behavior (UI interaction, focus, layout, async ordering): before `COMPLETE`, run app/browser against local or mock data, never production write paths, when required by user's scope; report results and simulation limits.
- When defect reported, fix whole class within same file/component. If fix needs cross-module change, persistence/schema change, new mechanism (lock, queue, async worker, new service), or exceeds about 30% of original diff, stop and return `BLOCKED (scope expansion)` for human decision.
- With local commit authorized: commit delivery before reporting; review binds to tip SHA. Existing uncommitted changes committed first as separate baseline. Post-review changes go in separate commit and are reported unreviewed.
- Without commit authorization: do not commit or stage. Report uncommitted state; dispatcher supplies plain `git diff` plus untracked list for review. Fingerprint freeze only if human asks.
- Commit trailers: `Pipeline-Role: implementer` and `Pipeline-Author: <agent id>`; end commit message with `Co-Authored-By: Claude Code <noreply@anthropic.com>`.

## Context budget
Context compaction discards file contents you read; re-reading them refills the window and loops. Write first, read narrowly.
- Read narrowly: locate with `rg -n`, then read at most 150 lines per call. No whole-file `cat`, no `sed -n` range over 150 lines.
- Item cycle: at most 5 files read before first write for an item; then failing test, minimal fix, green. Do not re-read a file already read unless changed.
- Progress file: at start create `$(git rev-parse --git-dir)/handoff-progress.md` (untracked, outside diff). Record per item: done / next, files touched, one-line conclusions. After compaction, read it first; do not re-explore.
- Frozen baseline: assigned Base SHA is baseline. Do not build hash lists unless human asks.
- No-write stop: if one full context window passes with no file write, stop and return `BLOCKED` with what read and unresolved item. Do not resume on own.
- Sizing (dispatcher): one handoff carries at most 2 items and must fit profile context window; split rest into later handoffs.

## Missed wake-up recovery
Finish notification is delivery, not guaranteed parent wake. If parent is never woken, user resumes parent session and asks for recovery. Reconcile Paseo agent status against Git state, then dispatch review. If agent still works, follow up or re-arm and record which; never treat elapsed time as completion or review.
