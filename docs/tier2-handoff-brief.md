# Tier 2 Handoff Brief

Use only when the work can be done whole by an independent session, or needs parallel runs. Isolation alone (a worktree the main session enters itself) does not need a handoff. Hard-risk operations (deploy, external write, migration) stay with the session that holds the context.

## Assignment
- **Workspace:** `<absolute path>`
- **Branch:** `<branch>`
- **Base SHA:** `<full commit SHA>`
- **Requirements:** `<R1..Rn in user's words> + files/scope`
- **Authorization:** `<quote user's words and scope; if absent, no commit/merge/push>`.
- **Pending decisions:** `<open choices, each with a default>`; dispatcher resolves any without a default.

## Delivery
- Review only for hard risks: persistence/schema migration; production external write or deploy; auth/authorization/security; cross-request/process concurrency or idempotency. Otherwise dispatcher accepts per-R evidence and test output; human owns merge approval.
- No recursive handoff. Return blockers or incomplete work to dispatcher. Choose smallest option within scope. Report `COMPLETE | BLOCKED | INCOMPLETE`, base/tip SHA, changed files, full-suite command and pass/fail counts, evidence per R, known gaps and simulation limits.
- If fix needs cross-module change, persistence/schema change, new mechanism (lock, queue, worker, service), or >30% diff growth, stop: `BLOCKED (scope expansion)` for human decision.
- Commit only when locally authorized; otherwise do not stage or commit. Authorized delivery commits before report, with review bound to tip SHA. Commit trailers: `Pipeline-Role: implementer`, `Pipeline-Author: <agent id>`, and `Co-Authored-By: Claude Code <noreply@anthropic.com>`.

## Progress and recovery
- Track progress in `$(git rev-parse --git-dir)/handoff-progress.md`; record done/next, files touched and conclusions. After compaction, read it first.
- One full context window with no write: stop and return `BLOCKED` with unresolved item.
- Reconcile Paseo agent status with Git; elapsed time is never completion.
