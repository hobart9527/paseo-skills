# ADR-0007: Change Entropy Budget, Tier 3 ROI Routing & Anti-Thrashing Controls

- **Status:** Accepted (refines [ADR-0002](0002-progressive-contract-and-recon-routing.md) and [ADR-0005](0005-harness-telemetry-and-self-pruning.md))
- **Date:** 2026-11-21
- **Scope:** `skills/paseo-pipeline/{freeze-check.mjs,lib/author-guard.mjs,lib/tier-gate.mjs,lib/telemetry.mjs,hooks/{tool-guard-hook,tier-write-hook,tier-session-hook}.mjs,templates/author.md,SKILL.md}`, `~/.paseo/config.json`, `~/.claude/CLAUDE.md`

## Context

Three control-plane gaps turned oversized or narrow contracts into unbounded token sinks (`73c29f91` on `unified-approval-picker`):
1. **Unbounded single-package scope & negative-ROI Tier 3 routing:** Stuffing 15 cross-layer rules (`14–20` files) into one change exceeded single-session working memory, while `maxWidth >= 2` admitted `1.33x`-speedup narrow diamonds into heavy Tier 3 orchestration despite coordination overhead exceeding concurrency gains.
2. **Runaway thinking budget & missing pre-CP-1 backstop:** Uncapped `hanlin` profile thinking defaulted to `effort: high`, and `SKILL.md` only mandated a `create_heartbeat` backstop after CP-1 while `author.md` dropped explicit timed milestones in `aba7238`.
3. **Invisible all-`exit-0` read thrashing:** `tool-guard-hook.mjs` caught repeated failing MCP calls, leaving silent `Read`/read-only `Bash` loops unmonitored until context compaction discarded unpersisted work.

## Decision

1. **Tier 3 ROI Route Gate (`freeze-check.mjs`):**
   - Route `'pipeline'` requires `substantiveTasks >= 4` AND (`substantiveMaxWidth >= 3` OR (`substantiveMaxWidth >= 2 && weightedSpeedup >= 1.8`, per `lib/schedule.mjs` `minSpeedup`)). Narrow `maxWidth = 2` graphs below `1.8x` route to `'handoff'` with `ADVISORY_LOW_ROI_HANDOFF` so they execute as 1–2 serial Tier 2 slices.
2. **Bounded Change Entropy Budget & Stage 1→2 Split Gate:**
   - Single-package targets exceeding `>2` capabilities, `>10` rules (`R*`), `>12` business source files/scopes, or `>8` tasks emit `ADVISORY_ENTROPY_SPLIT` (in `prepare-author` and `freeze-check`) and stop at Stage 1→2 for human split confirmation unless explicitly overridden.
3. **Closed-Loop Anti-Thrashing & Compute Controls:**
   - **Profile thinking cap:** `agent_profile_hanlin` sets `thinkingOptionId: "medium"` for drafting/synthesis; R0/FINAL use `anchasi` (`codex/gpt`).
   - **Pre-CP-1 heartbeat & milestones:** `SKILL.md` requires a one-shot `20–25m` `create_heartbeat` when dispatching `hanlin`, and `author.md` restores explicit stage time targets and self-stop `INCOMPLETE` checkpoints.
   - **O(1) runtime author guard (`lib/author-guard.mjs`):** Tracks consecutive read-only `Bash` calls and elapsed time per session on active pre-`tasks.md` changes: injects `warn_write` at threshold (`15` reads / `10m`) and `warn_incomplete` at (`25` reads / `18m`), resets when writing inside `openspec/changes/`, injects a mandatory `INCOMPLETE` stop directive in `tier-session-hook` if `compact` fires while `specs/` is empty (even inside linked worktrees), and logs `author_guard` events to `ADR-0005` telemetry.

## Rejected / Non-Goals

- **Rejected hard-blocking all `maxWidth = 2` DAGs unconditionally:** High-speedup (`>= 1.8x`) two-stream DAGs still benefit from parallel workers.
- **Rejected unconditionally `deny`-ing read-only `Bash` on first threshold:** Follows `ADR-0004` "Enable Before Deny"; warns first and relies on telemetry to prune or tighten.

## Consequences & Verification

- Prevents narrow negative-ROI Tier 3 runs, surfaces oversized changes before authoring, and breaks silent read-only thinking loops before compaction.
- Verified by `test/contract-authoring-v2.test.mjs`, `test/freeze-check.test.mjs`, `test/tier-gate.test.mjs`, and `test/tool-guard-hook.test.mjs`.
