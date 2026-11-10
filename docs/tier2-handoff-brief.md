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
- Runtime behavior (UI interaction, focus, layout, async ordering): before reporting `COMPLETE`, run the real app or browser against local or mock data, never production write paths, and report what passed and what could only be simulated. Do not leave this for the reviewer to infer from code.
- When a defect is reported, fix its whole class: grep every sibling site (entry points, dialog types, refresh paths, state writers) and add a test per site, not only the cited line.
- Commit the delivery before reporting; review binds to the tip SHA. Changes made after review (including acceptance-run fixes) go in a separate commit and are reported as unreviewed.
- Commit trailers: `Pipeline-Role: implementer` and `Pipeline-Author: <agent id>`; end commit message with `Co-Authored-By: Claude Code <noreply@anthropic.com>`.

## Missed wake-up recovery
Finish notification is delivery, not guaranteed parent wake. If parent is never woken, user resumes parent session and asks for recovery. Reconcile Paseo agent status against Git state, then dispatch review. If agent still works, follow up or re-arm and record which; never treat elapsed time as completion or review.
