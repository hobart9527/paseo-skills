# ADR-0005: Lightweight Local Telemetry & 30-Day Self-Pruning Governance

- **Status:** Accepted (landed in `feat/enabling-harness`: `lib/telemetry.mjs`, `pipeline-run.mjs report`)
- **Date:** 2026-11-21
- **Scope:** `skills/paseo-pipeline/lib/telemetry.mjs` (planned), `pipeline-run.mjs report`, `hooks/*.mjs`

## Context

Today `run-log.md` records only `merge-task` durations. Discovering that an E2E run executed 501 `Bash` calls, recreated 6 heartbeats, tripped 8 worktree `cd` errors, or failed `tier2-verify` on `Contract: none` required writing ad-hoc forensic scripts over 27 MB session transcripts. Without low-overhead observability, harnesses accumulate rules monotonically ("append-only bureaucracy") and keep high-friction hooks alive past their usefulness.

## Decision

1. **Zero-Dependency Local Telemetry (`~/.paseo/harness-metrics.jsonl`):**
   - Hooks and delivery gates append one sanitized, secret-free JSON line (< 200 bytes) per decision: `{ ts, repo, tier, gate, verdict, code, durationMs }` (best-effort; telemetry failures never block or fail a command).
2. **Read-Only Health Dashboard (`pipeline-run.mjs report [--days 7|30]`):**
   - Aggregates four north-star metrics directly from the local JSONL log:
     1. **First-Pass Merge / Delivery Rate** (`-a1` merges and Round-1 Tier 2 passes);
     2. **Friction Index** (top hook denials/asks/blocks and `tool-guard` auto-rewrites);
     3. **Review Signal Rate** (real blockers caught per heterogeneous review vs clean passes);
     4. **Tier Routing Fit** (Tier 1 overflow triggers and pseudo-Tier-3 `handoff` reroutes).
3. **Self-Pruning Rule (Anti-Bloat Governance):**
   - Any hook, gate rule, or prompt prohibition with **zero true-positive hits over 30 active days** or a **false-positive/override rate > 20%** enters mandatory pruning review (simplify, convert to silent auto-fix, or delete).

## Rejected / Non-Goals

- **Rejected external telemetry services, databases, or npm dependencies:** The pipeline remains pure Node.js standard library with strictly local disk state.
- **Rejected storing code snippets, prompts, or credentials in metrics:** Only structural event codes, verdicts, and timings are recorded.

## Consequences & Verification

- Turns harness iteration from intuition-driven patching into evidence-driven pruning and optimization.
- Verified via unit tests ensuring fail-open logging, zero secret leakage, bounded line size, and deterministic `report` aggregation.
