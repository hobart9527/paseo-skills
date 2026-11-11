# Tier 2 Handoff Brief

## Assignment
- **Workspace:** `<absolute path>`
- **Branch:** `<branch>`
- **Base SHA:** `<full commit SHA>`
- **Scope and acceptance:** `<files / behavior / tests>`
- **Local commits:** `authorized by <user, date> | not authorized`. Dispatcher requests authorization as the standard default at handoff so review binds to a SHA; `not authorized` remains available. Authorization covers local commits on this branch in this isolated workspace only; never push, merge, amend, reset, or delete.
- **Pending decisions:** `<open product/design choices, each with a default>`. An open decision with no default is resolved by the dispatcher before dispatch, not by the implementer.

## Ownership and delivery
- Implementer delivers commits and report only; never self-declares reviewed or merged.
- Dispatching session owns review dispatch. Human owns merge approval.
- No recursive handoff. Return blockers or incomplete work to dispatching session.
- Process choices (commit granularity, order of items, test placement) are yours: take the smallest option inside the assigned scope and proceed. Return `BLOCKED` only when scope turns out larger than assigned or required information is missing.
- Report with: `COMPLETE | BLOCKED | INCOMPLETE`; base SHA as assigned and tip SHA; changed-file list; full-suite command with pass and fail counts at the tip; red-then-green evidence per item; known gaps and what you could only simulate. A failing test is reported as failing, never as a fixture problem unless you show why.
- Runtime behavior (UI interaction, focus, layout, async ordering): before reporting `COMPLETE`, run the real app or browser against local or mock data, never production write paths, and report what passed and what could only be simulated. Do not leave this for the reviewer to infer from code.
- When a defect is reported, fix its whole class within the same file or component: sweep sibling sites (entry points, dialog types, refresh paths, state writers) and add a test per site, not only the cited line. If the fix needs a cross-module change, persistence/schema change, or new mechanism (lock, queue, async worker, new service), or the fix diff would exceed about 30% of the original delivery diff, stop and return `BLOCKED (scope expansion)` to the dispatcher for a human decision.
- With `Local commits: authorized`: commit after each finished item (so work survives context compaction), and commit the delivery before reporting; review binds to the tip SHA, so no per-file hash lists are needed. Existing uncommitted changes in the workspace are committed first as a separate baseline commit (the new Base SHA) so they are not mixed with your work. Changes made after review (including acceptance-run fixes) go in a separate commit and are reported as unreviewed.
- With `Local commits: not authorized`: do not commit or stage. Report uncommitted state; the dispatcher freezes the target per review closure. The implementer does not build hash lists unless the brief asks for one script-generated file.
- Commit trailers: `Pipeline-Role: implementer` and `Pipeline-Author: <agent id>`; end commit message with `Co-Authored-By: Claude Code <noreply@anthropic.com>`.

## Context budget
Context compaction discards file contents you read; re-reading them refills the window and loops. Write first, read narrowly.
- Read narrowly: locate with `rg -n`, then read at most 150 lines per call. No whole-file `cat`, no `sed -n` range over 150 lines.
- Item cycle: at most 5 files read before the first write for an item; then failing test, minimal fix, green. Do not re-read a file already read unless you changed it.
- Progress file: at start create `$(git rev-parse --git-dir)/handoff-progress.md` (untracked, outside the diff). Record per item: done / next, files touched, one-line conclusions. After any compaction, read it first; do not re-explore.
- Frozen baseline: the assigned Base SHA is the baseline. Per-file hashes or mode lists are produced once by a script into a file, then read from it; never rebuilt by hand or carried in summaries.
- No-write stop: if one full context window passes with no file write, stop and return `BLOCKED` with what you read and what is unresolved. Do not resume on your own.
- Sizing (dispatcher): one handoff carries at most 2 items and must fit the profile's context window; split the rest into later handoffs.

## Missed wake-up recovery
Finish notification is delivery, not guaranteed parent wake. If parent is never woken, user resumes parent session and asks for recovery. Reconcile Paseo agent status against Git state, then dispatch review. If agent still works, follow up or re-arm and record which; never treat elapsed time as completion or review.
