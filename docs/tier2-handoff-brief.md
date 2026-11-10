# Tier 2 Handoff Brief

## Assignment
- **Workspace:** `<absolute path>`
- **Branch:** `<branch>`
- **Base SHA:** `<full commit SHA>`
- **Scope and acceptance:** `<files / behavior / tests>`

## Ownership and delivery
- Implementer delivers commits and report only; never self-declares reviewed or merged.
- Dispatching session owns review dispatch. Human owns merge approval.
- No recursive handoff. Return blockers or incomplete work to dispatching session.
- Process choices (commit granularity, order of items, test placement) are yours: take the smallest option inside the assigned scope and proceed. Return `BLOCKED` only when scope turns out larger than assigned or required information is missing.
- Report with: `COMPLETE | BLOCKED | INCOMPLETE`; base SHA as assigned and tip SHA; changed-file list; full-suite command with pass and fail counts at the tip; red-then-green evidence per item; known gaps and what you could only simulate. A failing test is reported as failing, never as a fixture problem unless you show why.
- Commit trailers: `Pipeline-Role: implementer` and `Pipeline-Author: <agent id>`; end commit message with `Co-Authored-By: Claude Code <noreply@anthropic.com>`.

## Missed wake-up recovery
Finish notification is delivery, not guaranteed parent wake. If parent is never woken, user resumes parent session and asks for recovery. Reconcile Paseo agent status against Git state, then dispatch review. If agent still works, follow up or re-arm and record which; never treat elapsed time as completion or review.
