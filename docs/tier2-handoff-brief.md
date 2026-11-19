# Tier 2 Handoff Brief

Filled by `/tier2-handoff` before `/paseo-handoff` dispatches. Use only when the work can be done whole by an independent session, or needs parallel runs. Isolation alone (a worktree the main session enters itself) does not need a handoff. Risky operations (deploy, production write, running a migration, push) stay with the session that holds the context. Rule source: `~/.claude/CLAUDE.md`.

## Assignment
- **Workspace:** `<absolute path>`
- **Branch:** `<branch>`
- **Base SHA:** `<full commit SHA>`
- **Requirements:** `<R1..Rn in user's words> + files/scope`
- **Authorization:** `<quote user's words and scope for any stop point this work covers (merge, push, deploy, migration); "none" if it covers none>`. Commits on this non-default branch are pre-authorized and need no quote.
- **Pending decisions:** `<open choices, each with a default>`; dispatcher resolves any without a default before dispatch. A choice touching a risky operation, or changing auth or money semantics, needs the user's words, not a dispatcher default.
- **Slices:** serial list, no DAG. One line each: `S<n>: <R ids> | <files> | <old tests to change → new assertion> | <done evidence>`. One commit per slice.
- **Size estimate:** `<files, lines, minutes>`; tell the user this estimate at dispatch.
- **Risk:** `<class + path:line>` naming one of auth/authorization/security; cross-request/process concurrency or idempotency; persistence/schema code. Otherwise write `Risk: none`.
- **Contract:** `openspec/changes/<name>/`, two files written per [`tier2-contract.md`](tier2-contract.md) before the first source edit; `openspec validate <name> --strict` exits 0.

## Pre-dispatch check
- The brief has `Authorization:`, `Pending decisions`, `Slices`, `Risk:` and `Contract:`; missing any one, do not dispatch.
- Read every test the brief requires to pass. An assertion that locks in a defect being fixed is listed in its slice as "change to …", never left under "must pass".
- Questions while running: hard-risk questions (risky operation, auth or money semantics) go to the user verbatim; the dispatcher never answers them. Other questions: the delegate applies the default, records it in the report, and keeps going.

## Delivery
- No recursive handoff. Return blockers or incomplete work to dispatcher. Choose smallest option within scope. Report `COMPLETE | BLOCKED | INCOMPLETE`, base/tip SHA, changed files, full-suite command and pass/fail counts, known gaps and simulation limits. Evidence per R is the command actually run: `R<n>: <command> → exit <code>, <passed>/<total>`. A command not run is written `UNVERIFIED: <reason>`, never as a result.
- Evidence recheck, every Tier 2 delivery: the dispatcher reruns each evidence command (each `**Verify:**` line of the contract) at the tip SHA in the delegate's worktree and compares exit code and counts with the report. A mismatch, or a narrow command labelled as the full suite, sends the delivery back once as `INCOMPLETE (evidence mismatch)`; a second mismatch goes to the user. The recheck is the dispatcher's own step, not a review.
- Review only for risky code: a reviewer (`docs/tier2-reviewer-brief.md`) is dispatched only when `Risk:` names a class, or the recheck finds the diff touching one that `Risk: none` missed. With `Risk: none`, a passing recheck is the acceptance evidence; human owns merge approval.
- If fix needs cross-module change, persistence/schema change, new mechanism (lock, queue, worker, service), or >30% diff growth, stop: `BLOCKED (scope expansion)` for human decision.
- Commit each slice on the assigned branch before reporting (pre-authorized); review binds to tip SHA. Never merge, push, amend or rewrite history without the stop-point quote in `Authorization:`. Commit trailers: `Pipeline-Role: implementer`, `Pipeline-Author: <agent id>`, and `Co-Authored-By: Claude Code <noreply@anthropic.com>`.

## Progress and recovery
- Track progress in `$(git rev-parse --git-dir)/handoff-progress.md`; record done/next, files touched and conclusions. After compaction, read it first.
- One full context window with no write: stop and return `BLOCKED` with unresolved item.
- Reconcile Paseo agent status with Git; elapsed time is never completion. Progress is counted in finished slices, not minutes.
- Diff past the size estimate by >30%: stop and return `BLOCKED (scope expansion)`.
