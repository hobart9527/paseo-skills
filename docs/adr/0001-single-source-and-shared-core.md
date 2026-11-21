# ADR-0001: Single Source of Truth, Shared Execution Core & Unified CLI Facade

- **Status:** Accepted (core consolidated in `feat/enabling-harness` atop `aba7238` / `e373d11`)
- **Date:** 2026-11-21
- **Scope:** `skills/paseo-pipeline/lib/*`, `skills/paseo-pipeline/*.mjs`, `hooks/*`, `~/.claude/CLAUDE.md`, `~/.paseo/config.json`

## Context

Iterative hardening accumulated 15 standalone CLIs, 20 `lib/` files, and 6 hooks (8,597 lines total). Audits surfaced repeated drift when the same primitive was implemented in multiple places:
- Three incompatible test-path matchers (`lib/tasks.mjs` vs `lib/risk-scan.mjs` vs `lib/tier-gate.mjs`), letting snapshot/Python test edits bypass `risk-scan` oracle detection;
- Five separate Paseo CLI/profile readers (`paseo-agents.mjs`, `paseo-state.mjs`, `cleanup.mjs`, `profiles-check.mjs`, `tool-guard-hook.mjs`);
- Five hand-rolled `git worktree list --porcelain` parsers (only `cleanup.mjs` using newline-safe `-z`);
- Hardcoded writer roles in `hooks/git/commit-msg` and outdated R0 stage titles in `schema.yaml` / `config.json`;
- A 1,381-line `freeze-check.mjs` monolith whose F-1..F-7 Verify command safety prover was unavailable to `tier2-verify.mjs`.

## Decision

1. **Single Authoritative Sources:**
   - Runtime policy lives in `~/.claude/CLAUDE.md` and `skills/paseo-pipeline/SKILL.md` only; other docs summarize or link.
   - Role metadata, profile IDs, stage titles, and default routing live exclusively in `lib/roles.mjs` (cross-checked against `hooks/git/commit-msg` and `~/.paseo/config.json` by automated tests/lints).
2. **Consolidated Shared Execution Core:**
   - Unify duplicated primitives into focused modules: `lib/paths.mjs` (test/doc/exempt/scope classification), `lib/git.mjs` (`runGit` + `-z` `listWorktrees`), `lib/paseo.mjs` (single daemon & profile adapter), `lib/contract.mjs` (`tasks` + `spec-scan` + `acceptance` table parsing), `lib/verify-policy.mjs` (F-1..F-7 command provability shared by Tier 2 and Tier 3), `lib/verify-runner.mjs` (`set -o pipefail` + dirty-tree execution), and `lib/risk-scan.mjs`.
3. **Single Operator/Agent CLI Facade:**
   - Expose all day-to-day commands under `pipeline-run.mjs <subcommand>` (`plan`, `prepare-task`, `worker-check`, `merge`, `cp2-merge`, `tier2-verify`, `risk-scan`, `acceptance`, `brief`, `cleanup`, `freeze`, `profiles`, `preflight`, `inspect`) so agents remember one entry point while existing standalone scripts remain thin backwards-compatible wrappers.

## Rejected / Non-Goals

- **No persistent daemon or bespoke orchestration database:** Git refs remain the durable state store; Paseo remains the agent transport layer.
- **No breaking directory reorganization:** Existing script paths and benchmark re-exports stay intact to preserve regression compatibility.

## Consequences & Verification

- Eliminates rule/matcher drift across Tier 1, Tier 2, and Tier 3 gates (notably closing snapshot/fixture/Python test-oracle blind spots and Tier 2 Verify command spoofing).
- Reduces agent lookup friction (`--help` / `rg SKILL.md` turns) and shrinks duplicated boilerplate across scripts.
- Verified via `bash skills/paseo-pipeline/test/run-all.sh`, `install.sh --check`, and `profiles-check.mjs --root .` after every consolidation wave.
