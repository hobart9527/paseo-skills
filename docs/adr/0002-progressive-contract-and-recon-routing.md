# ADR-0002: Recon-First Tier Routing & Progressive Unified OpenSpec Contract

- **Status:** Accepted (landed in `aba7238` / `e373d11`)
- **Date:** 2026-11-21
- **Scope:** `~/.claude/CLAUDE.md`, `skills/paseo-pipeline/lib/tier-gate.mjs`, `hooks/tier-*.mjs`, `docs/tier2-contract.md`, `skills/paseo-pipeline/freeze-check.mjs`, `skills/paseo-pipeline/tier2-verify.mjs`

## Context

Two recurring execution failures emerged in real sessions:
1. **Unknowable upfront scope & fragile `TIER-PLAN` parsing:** Requiring agents to declare exact file lists in chat text before reading code forced guesses, and parsing `transcript.jsonl` in `PreToolUse` suffered from JSONL flush races, compaction resets, and fenced-example false denials.
2. **Tier 2/3 contract mismatch & pseudo-Tier-3 padding:** Tier 2 previously used ad-hoc brief prose while Tier 3 used full OpenSpec (`proposal` + `specs` + `tasks` + `acceptance`), causing rewrite friction on escalation/de-escalation. Conversely, a 16-line change (`pipeline-json-audit`) padded with a doc-only 4th task entered Tier 3 and consumed ~90 minutes.

## Decision

1. **Recon-First Sizing, Deterministic Guardrails:**
   - Permanently retire `TIER-PLAN` transcript-JSONL parsing in `lib/tier-gate.mjs` and `hooks/tier-write-hook.mjs`.
   - Start with brief read-only Recon (`rg` or `chanpin` via `brief.mjs recon`). Enforce Tier 1 primary-checkout boundaries deterministically via actual touched source files and scopes (`PreToolUse` + `Stop`).
   - Treat **Risk as a checkpoint, never a tier**: risky code triggers `risk-scan` + 1+1 independent review without forcing worktree delegation or Tier 3.
2. **Progressive Unified OpenSpec Contract (Zero-Rewrite Scaling):**
   - Tier 2 observable-behavior changes author two native OpenSpec files (`specs/<cap>/spec.md` with `SCEN-*` + `- **Verify:**`, and serial `tasks.md`), validated by `openspec validate --strict` (which passes without `proposal.md` on `spec-driven` schema). Mechanical changes declare `Contract: none — <reason>` and supply `--verify` or `--auto-verify` to `tier2-verify`.
   - Scaling Tier 2 → Tier 3 keeps `specs/` and `tasks.md` unchanged and adds `proposal.md`, `Depends on:`, and `acceptance sync`. Scaling Tier 3 → Tier 2 (`freeze-check` `route: handoff`) reuses the contract directly under `tier2-verify`.
3. **Substantive Tier 3 Admission Gate:**
   - `freeze-check.mjs` excludes doc/change-artifact-only tasks (`openspec/`, `docs/`, `*.md`, `run-log.md`) when computing substantive concurrency; changes with fewer than 4 substantive code/test tasks or substantive `maxWidth < 2` route to Tier 2 (`ADVISORY_PSEUDO_TIER3_PADDING`).

## Rejected / Non-Goals

- **Rejected restoring chat-text `TIER-PLAN` declarations** or adding JSONL retry loops — text declarations are structurally unreliable compared to filesystem/git observations.
- **Rejected separate Tier 2 and Tier 3 contract formats** — maintaining two schemas guarantees drift and rewrite waste.

## Consequences & Verification

- Eliminates JSONL flush false denials while keeping hard primary-checkout blast-radius containment.
- Prevents small changes from burning 90-minute Tier 3 orchestration overhead.
- Verified by `test/tier-gate.test.mjs`, `test/tier-gate-friction.test.mjs`, and `test/convergence.test.mjs`.
