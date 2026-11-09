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
- Commit trailers: `Pipeline-Role: implementer` and `Pipeline-Author: <agent id>`; end commit message with `Co-Authored-By: Claude Code <noreply@anthropic.com>`.

## Missed wake-up recovery
Finish notification is delivery, not guaranteed parent wake. If parent is never woken, user resumes parent session and asks for recovery. Reconcile Paseo agent status against Git state, then dispatch review. If agent still works, follow up or re-arm and record which; never treat elapsed time as completion or review.
