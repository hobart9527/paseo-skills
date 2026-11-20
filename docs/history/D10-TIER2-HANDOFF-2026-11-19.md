# D10 Tier 2 Handoff Brief

Filled from `docs/tier2-handoff-brief.md`. Supersedes the four-task execution draft; source product obligations excluded from this benchmark remain FOLLOWUP.

## Assignment

- **Workspace:** `/Users/hobart/.paseo/worktrees/3j0rvshz/contract-bench-d10` (Paseo `wks_fde6f83db3287977`).
- **Branch:** `bench/contract-d10`.
- **Base SHA:** `fc8f79740d314291d638ddef42a7d92c90100efa` (product baseline `547c5bd8141e6ad930ff4f4da049ab62380a461b`; changes since it are contract-only).
- **Requirements:** R1 remove compliance dashboard, route-preview component/request and approval-estimate text; preserve actions/banners/alerts. R2 retain exact compliance computation and submit-disable gates; show each BLOCK rule summary as inline alert by submit button. R3 preserve existing submit validations, amount/tax payload, invoice lifecycle, loan allocation, payee behavior, persistence and external-write semantics; existing form regressions and whole web suite pass unmodified. Scope: existing T-05, `ExpenseBillForm.tsx` and new `expense-form-noise-removal.test.tsx` only.
- **Authorization:** none for stop-point operations. User selected `A` on 2026-11-19: narrowed benchmark preserving existing financial/security/external-write semantics, excluding undecided business changes, recomputing route without task padding. This is not an answer to OD-1..OD-6. No default-branch merge, push, deploy, migrations, production writes, amend, history rewrite or destructive cleanup. Commits on this linked non-default branch pre-authorized.
- **Pending decisions:** none within this narrowed slice. Ordinary UI presentation default: small plain inline blocking summaries adjacent to existing buttons, no new design system or component abstraction. Questions changing auth/money semantics or requiring risky operations go to user verbatim via dispatcher; do not choose an OD default.
- **Slices:** S1 / existing T-05: R1,R2,R3 | `packages/web/src/components/forms/ExpenseBillForm.tsx`, `packages/web/test/expense-form-noise-removal.test.tsx` | no existing test found asserting removed panels/copy; existing tests stay unchanged; new tests assert removed panels/request, empty and untyped rows blocked with inline reasons | done evidence: all three commands listed below exit 0; one implementation commit.
- **Size estimate:** 2 files; 250 changed lines total (additions + deletions); 20 minutes; one serial slice. At >325 changed lines, third product file, new mechanism or cross-module expansion: stop and report `BLOCKED (scope expansion)`. No modifying tests to hit counts or estimates.
- **Risk:** none — render-only change, not auth/authorization/security, cross-process concurrency/idempotency, or persistence/schema code. Existing compliance gates are preserved. Touching one of those classes requires reporting to dispatcher for test evidence and one reviewer; do not silently change classification.
- **Contract:** `openspec/changes/ticket-driven-expense-d10/`, executable Tier 2 files `specs/ticket-driven-expense/spec.md` and `tasks.md`; former Tier 3 records remain historical context only. Each scenario now has `**Verify:**`. `openspec validate ticket-driven-expense-d10 --strict` exit 0 at base. Author structural handoff at `5ac28e2673f7eb608aa40f93232a45c072cf0106`, independently reproduced tasks=1/maxWidth=1/exit 0. Main session added Verify commands in `fc8f7974`, no business changes.

## Pre-dispatch check

- All required fields above present, no material pending decision inside slice. Named contract validates strictly.
- Existing test suite inspected: nine test files in `packages/web/test/*.test.ts{,x}`. No assertion locks in compliance panel/route preview/copy; existing whole suite stays unchanged. Draft/submit tests exercise real component, invalid-offset blocking, positive-net payee requirement and successful mock submit.
- Source call sites inspected: `ExpenseBillForm.tsx:60,103-106,1045,1762,3192-3201,3214-3216,3227-3236`. Removing render-only imports/state must not remove `evaluatePreflightCompliance` or downstream validation/submit control. Inspect any other use before deleting imports (e.g. icons).
- Tests use local jsdom, Testing Library and mocked fetch; no real business writes. Existing lockfile dependencies installed. No global installer/settings/hooks changes needed.
- Read `proposal.md` removal map and verify affected current source windows before edit. Keep wrapper's draft banner, missing-archive alert, invalid-offset alert, FormFeedback and both buttons. Fixing input must still recompute compliance.

## Delivery and evidence

Run from assigned workspace root; inspect repository commands first. Before source edit declare Tier. First add real runtime tests and run them against unchanged form to reproduce R1/R2 defects; report exact failures, then implement. Source-text assertions alone are not evidence. Do not change contract or existing tests. Existing dependencies suffice; if missing, use root lockfile install without running uninspected scripts. Missing dependency is environment fault, not product red.

1. `node --import tsx --test packages/web/test/expense-form-noise-removal.test.tsx`
2. `node --import tsx --test packages/web/test/expense-form-draft.test.tsx`
3. `sh -c 'cd packages/web && node --import tsx --test test/*.test.ts test/*.test.tsx'`

Return COMPLETE/BLOCKED/INCOMPLETE, base/tip full SHA, changed files/line counts, exact red and green outputs/counts/exit codes, R1..R3 evidence, gaps/simulation limits. Command 3 is full WEB suite, not whole repository suite. Do not claim server/build checks unless run; not required because no server change. Do not fabricate benchmarks or first-merge evidence. Keep logs outside tracked product files. One implementation commit with `Pipeline-Role: implementer`, actual `Pipeline-Author: <agent id>`, ending `Co-Authored-By: Claude Code <noreply@anthropic.com>`.

Dispatcher reruns every evidence command at tip and compares counts/exits; discrepancies get one return. Reviewer only if diff actually touches named risky class. No default merge/push; human owns merge approval.

## Progress and recovery

Write progress to `$(git rev-parse --git-dir)/handoff-progress.md`, not product source scope. Record done/next, files and conclusions; read it after compaction. No recursive handoff. One full context window with no write returns BLOCKED. Progress means committed slice and verified Git tip, not elapsed time.
