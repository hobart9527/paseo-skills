# ADR-0003: Bounded SDD Review (1+1 Budget), Oracle Fidelity & Caveat Guard

- **Status:** Accepted (landed in `aba7238` / `e373d11` + `feat/enabling-harness` Tier 1 Stop risk sentinel & F-1..F-7 `tier2-verify` provability)
- **Date:** 2026-11-21
- **Scope:** `~/.claude/CLAUDE.md`, `docs/tier2-reviewer-brief.md`, `skills/paseo-pipeline/templates/{reviewer,approvals,worker}.md`, `skills/paseo-pipeline/lib/risk-scan.mjs`, `worker-check.mjs`, `merge-task.mjs`, `acceptance-run.mjs`

## Context

Audit of prior deliveries exposed two opposite failure modes:
1. **Review Escape:** Tier 2 deliveries (especially self-worked in worktrees) could declare `Risk: none` subjectively and skip verification or independent review, delete security-bearing files undetected, weaken existing tests, or drop safety caveats from docs (`T-03` deleting `not independence/sandbox proof` while green on `docs.test.mjs`).
2. **Review Loops & Scope Creep:** Reviewers without strict scope/round ceilings emitted speculative `ENHANCEMENT` lists, style nits, or reopened R0/FINAL loops indefinitely, wasting more tokens reviewing than implementing.

## Decision

1. **Deterministic Review Trigger (`risk-scan` + `tier2-verify`):**
   - Subjective `Risk: none` never bypasses automated diff scanning. `lib/risk-scan.mjs` deterministically scans added, modified, and deleted hunks for 5 risk classes (`auth`, `concurrency`, `persistence`, `money`, `external-write`), test-oracle mutations (`ORACLE`), and doc/prompt safety-qualifier removals (`CAVEAT`).
   - Tier 2 deliveries (both main-session-in-worktree and `/tier2-handoff`) must pass `tier2-verify` at tip SHA (`set -o pipefail`, clean worktree, real Verify execution, mandatory `openspec --strict` when `--change-dir` is present).
   - Phase 1 extends lightweight `risk-scan` detection into Tier 1 `Stop` hook so 1–3 file primary-checkout edits touching security/tests cannot silently escape review.
2. **Closed SDD Review Scope & Strict 1+1 Budget:**
   - Reviews evaluate **only**: Requirements/SCEN matrix conformance + Oracle fidelity (real entry exercised, no weakened assertions) + 4 fixed baseline risks (data loss/external-write/money, security/auth/privacy, main-path crash/deadlock, concurrency/idempotency). `ENHANCEMENT`, `Followups`, and style nits are forbidden.
   - Strict **1+1 budget** (1 initial full verdict + at most 1 delta recheck on the **same** heterogeneous reviewer; never swap reviewers to reset budget; max 2 rounds for R0 and FINAL). Review is advisory; unresolved `BLOCKED` goes verbatim to the human (`Accept` or `Terminate`), never an autonomous fix loop.
3. **Mechanical Oracle & Evidence Integrity:**
   - `worker-check.mjs` and `merge-task.mjs` share `lib/verify-runner.mjs` (`bash -o pipefail`) and reject non-`ceshi` edits to `ceshi`-authored Red files (exit 38 unless `--allow-test-infra`).
   - `acceptance-run.mjs check` verifies persisted `evidence/` records across sign-off commits (`review.md`/`run-log.md`) and post-CP-2 `main` ancestor merges without temporary clones.

## Rejected / Non-Goals

- **Rejected autonomous "review-fix until PASS" loops** and per-task Tier 3 code reviewers — quality is enforced by mechanical middle gates + bounded heterogeneous FINAL review.
- **Rejected prompt-only two-commit Red mandates** where unverified mechanically (reserved solely for explicit `ceshi` Red handoffs).

## Consequences & Verification

- Demonstrated in live `anchasi` (`codex/gpt`) dogfooding: Round 1 surfaced 3 real gate defects (`B1`–`B3`) with zero style nits; Round 2 delta recheck converged cleanly to `PASS` within the 1+1 budget.
- Verified by `test/risk-scan.test.mjs`, `test/acceptance-run.test.mjs`, and `test/convergence.test.mjs`.
