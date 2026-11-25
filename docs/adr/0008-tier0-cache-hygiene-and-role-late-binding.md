# ADR-0008: Tier 0 Zero-Friction Isolation, Cache Hygiene & Role Late Binding

- **Status:** Accepted (amends [ADR-0007](0007-change-entropy-tier3-roi-and-anti-thrashing.md) thinking-cap and read-stall scope; extends [ADR-0001](0001-single-source-and-shared-core.md) & [ADR-0004](0004-enabling-harness-environment-and-context.md))
- **Date:** 2026-11-24
- **Scope:** `skills/paseo-pipeline/{hooks/{tier-reminder-hook,tier-write-hook,tool-guard-hook}.mjs,profiles-check.mjs,test/*}`, `~/.claude/{CLAUDE.md,settings.json}`, `~/.paseo/{config.json,task-routing.md}`

## Context

Production trace forensic analysis (`approval-hub` sessions `0e598619`, `50362924`, `001bce98`) exposed four self-inflicted harness bottlenecks:
1. **Tier 0 cognitive tax:** Read-only Q&A, research, and diagnostics sessions received `[分级提醒]` on every non-slash user prompt, driving unnecessary tier-matching inside model thinking.
2. **Mid-turn cache busting:** `PreToolUse` `recon_stall` injected `additionalContext` mid-turn on read-only `Bash`/`Read`, invalidating ~14k prefix-cache tokens (33.4s latency spike) without stopping serial exploration.
3. **Dispatch friction & brittle profile metadata:** `create_agent` denied calls on `settings_mismatch` instead of auto-aligning; `mcp__paseo__*` fell outside `permissions.allow` (tripping `auto_mode` classifier delays); `profiles-check.mjs` enforced a 6-field `notes` template that drifted whenever users swapped models in `~/.paseo/config.json`.
4. **Stale `hanlin` thinking cap:** With Stage 0/1/2 isolation and entropy gates active, forcing `hanlin` down to `medium` traded contract quality unnecessarily.

## Decision

1. **Tier 0 Zero-Friction Isolation (`tier-reminder-hook.mjs`, `~/.claude/CLAUDE.md`):**
   - Formally establish Tier 0 (pure read-only Q&A, research, diagnostics): skip `UserPromptSubmit` tier reminders on read-only/question prompts and emit at most once per active session segment, while keeping silent `Stop` snapshots intact.
2. **Prompt Cache Hygiene, Auto-Align Over Deny & Subtraction Pass (`tool-guard-hook.mjs`, `tier-gate.mjs`, `settings.json`):**
   - Remove `recon_stall` and `worktree_read_stall` mid-turn injections from `tool-guard-hook.mjs`; later retire `author-guard.mjs`, legacy `declared` (`TIER-PLAN`), and disabled `zeroWriteTurns` while consolidating per-session hook state into `<sid>.json` (`__meta`) and enforcing heavy-worktree (`>=2` compactions) write & `workspaceId` guards.
   - Auto-align `create_agent` `settings` (`modeId`, `thinkingOptionId`, `features`) to matching profiles instead of denying; deny only when conflicting profiles share `<provider>/<model>` without disambiguation and an invalid override matches none.
   - Allowlist read/dispatch `mcp__paseo__*` tools in `~/.claude/settings.json` to remove `auto_mode` classifier latency on parallel fan-out.
3. **Role-Name Late Binding & Slim Profiles (`tool-guard-hook.mjs`, `profiles-check.mjs`):**
   - `create_agent` accepts a role token, Chinese alias, or profile ID (`chanpin`/`中书`, `gongbu`, `anchasi`, `hanlin`) as `provider` and materializes live `provider/model` + launch settings from `~/.paseo/config.json`.
   - Drop mandatory 6-field `notes` boilerplate and `diff-check` prose checks in `profiles-check.mjs`; infer `family` from `provider/model` (with optional `family:` override) and report family overlap as non-blocking `ADVISORY_FAMILY_CLASH`.
4. **Lift Hard Thinking Cap (`ADR-0007` Amendment):**
   - Keep user-configured `thinkingOptionId` (including `high`) freely hot-swappable in `~/.paseo/config.json`; bound cost and latency via Stage 0/1/2 isolation, parallel subagent fan-out, cache stability, and single-script batched remote diagnostics.

## Rejected / Non-Goals

- **Rejected weakening Tier 1 write/Stop/risk-scan/R0/FINAL gates:** Delivery invariants remain deterministically enforced at write, verify, and merge boundaries.

## Consequences & Verification

- Eliminates rule-matching tax on Tier 0 tasks, mid-turn cache invalidation, and config-swap friction while preserving SDD correctness gates.
- Verified via `bash skills/paseo-pipeline/test/run-all.sh`, `install.sh --check`, and `profiles-check.mjs --root . --json`.
