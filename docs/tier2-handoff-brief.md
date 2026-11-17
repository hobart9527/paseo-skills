# Tier 2 Handoff Brief

Filled by `/tier2-handoff` before `/paseo-handoff` dispatches. Use only when the work can be done whole by an independent session, or needs parallel runs. Isolation alone (a worktree the main session enters itself) does not need a handoff. Risky operations (deploy, production write, running a migration, push) stay with the session that holds the context. Rule source: `~/.claude/CLAUDE.md`.

## Assignment
- **Workspace:** `<absolute path>`
- **Branch:** `<branch>`
- **Base SHA:** `<full commit SHA>`
- **Requirements:** `<R1..Rn in user's words> + files/scope`
- **Authorization:** `<quote user's words and scope; if absent, no commit/merge/push>`.
- **Pending decisions:** `<open choices, each with a default>`; dispatcher resolves any without a default before dispatch. A choice touching a risky operation, or changing auth or money semantics, needs the user's words, not a dispatcher default.
- **Slices:** serial list, no DAG. One line each: `S<n>: <R ids> | <files> | <old tests to change → new assertion> | <done evidence>`. One commit per slice when commit is authorized; otherwise one progress entry per slice.
- **Size estimate:** `<files, lines, minutes>`; tell the user this estimate at dispatch.

## Pre-dispatch check
- The brief has `Authorization:`, `Pending decisions` and `Slices`; missing any one, do not dispatch.
- Read every test the brief requires to pass. An assertion that locks in a defect being fixed is listed in its slice as "change to …", never left under "must pass".
- Questions while running: hard-risk questions (risky operation, auth or money semantics) go to the user verbatim; the dispatcher never answers them. Other questions: the delegate applies the default, records it in the report, and keeps going.

## Delivery
- Review only for risky code: auth/authorization/security; cross-request/process concurrency or idempotency; persistence/schema code. Otherwise dispatcher accepts per-R evidence and test output; human owns merge approval.
- No recursive handoff. Return blockers or incomplete work to dispatcher. Choose smallest option within scope. Report `COMPLETE | BLOCKED | INCOMPLETE`, base/tip SHA, changed files, full-suite command and pass/fail counts, evidence per R, known gaps and simulation limits.
- If fix needs cross-module change, persistence/schema change, new mechanism (lock, queue, worker, service), or >30% diff growth, stop: `BLOCKED (scope expansion)` for human decision.
- Commit only when locally authorized; otherwise do not stage or commit. Authorized delivery commits before report, with review bound to tip SHA. Commit trailers: `Pipeline-Role: implementer`, `Pipeline-Author: <agent id>`, and `Co-Authored-By: Claude Code <noreply@anthropic.com>`.

## Progress and recovery
- Track progress in `$(git rev-parse --git-dir)/handoff-progress.md`; record done/next, files touched and conclusions. After compaction, read it first.
- One full context window with no write: stop and return `BLOCKED` with unresolved item.
- Reconcile Paseo agent status with Git; elapsed time is never completion. Progress is counted in finished slices, not minutes.
- Diff past the size estimate by >30%: stop and return `BLOCKED (scope expansion)`.
