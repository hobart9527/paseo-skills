# Paseo Pipeline Contract Authoring V2 Upgrade Plan

- **Date:** 2026-11-21
- **Trigger:** Forensic root-cause analysis of `approval-hub` change `unified-approval-picker` (`2538b320` → `hanlin` `73c29f91`: `>2h`, `97+` turns, `93.8%` thinking tokens, `169k` auto-compaction wipeout, zero `specs/` persisted).
- **Decisions Locked (Q1–Q12):** [ADR-0006](file:///Users/hobart/Codex/paseo-skills/docs/adr/0006-contract-authoring-isolation-and-single-source.md) and [ADR-0007](file:///Users/hobart/Codex/paseo-skills/docs/adr/0007-change-entropy-tier3-roi-and-anti-thrashing.md).

## Settled Design Decisions (Q1–Q12)

| ID | Topic | Decision |
|---|---|---|
| Q1 | Authoring Topology | 3-stage isolation: Stage 0 `prepare-author` (0-token) → Stage 1 `chanpin` (`baseline-facts.md` ≤15KB) → Stage 2 `hanlin` clean-context authoring |
| Q2/Q8 | Single Source of Truth | `specs/` pure observable behavior (no `--stage specs` `MISSING_SCEN_VERIFY`); `tasks.md` owns `Verify with:`, `Entry:`, `Required:`; `acceptance sync` compiles `acceptance.md`; `tier2-verify` resolves from `tasks.md` with legacy `specs/` fallback |
| Q3/Q9 | Entropy & Tier 3 ROI | Tier 3 route requires `substantiveTasks >= 4 && (substantiveMaxWidth >= 3 \|\| (substantiveMaxWidth >= 2 && weightedSpeedup >= 1.8))`; entropy budget (`>2` capabilities, `>10` rules, `>12` source scopes, `>8` tasks) pauses at Stage 1→2 for split confirmation |
| Q4 | Interface Medium | Cross-layer shared types default to Wave 0 `Kind: skeleton` typed stubs (`tsc`) instead of Markdown field transcription |
| Q5/Q10 | Compute & Anti-Thrashing | `hanlin` explicit `thinkingOptionId: "medium"`; O(1) `lib/author-guard.mjs` warnings (`15r/10m` write `specs/`, `25r/18m` `INCOMPLETE`), `compact` empty-`specs/` stop hook, one-shot `20–25m` pre-CP-1 heartbeat, restored timed milestones in `author.md` |
| Q6/Q12 | Role Assignment | Keep `chanpin` (`antigravity/gemini-4-hydrogen-high`) for Stage 1 objective fact compilation only; unify all independent reviews (R0 / Tier 2 / FINAL) onto `anchasi` (`codex/gpt`); retain legacy `neon` read-only signer compatibility |
| Q7 | Fact Artifact | `openspec/changes/<change>/baseline-facts.md` (≤15KB, committed, exempt from `STALE_R0_SIGNOFF`, JIT-inlined by `brief.mjs author`) |
| Q11 | Delivery Phasing | `ADR-0006` + `ADR-0007` + 2-Wave rollout inside isolated worktree |

## Execution Waves

### Wave 1 — Single-Source Verification, Stage 0 & Unified Role Architecture
- **ADRs & Roadmap:** `docs/adr/0006-*`, `docs/adr/0007-*`, `docs/adr/README.md`, `docs/adr/0002-*`, and this plan.
- **Tasks & Gates:** `lib/tasks.mjs` (`Entry:`, `Required:`, `entryForScenario`), `acceptance-sync.mjs` (compile full rows from `specs/` + `tasks.md`), `freeze-check.mjs` (remove `MISSING_SCEN_VERIFY`, exempt `baseline-facts.md`, ROI route + entropy advisory), `tier2-verify.mjs` (resolve `Verify` from `tasks.md` with legacy fallback).
- **Stage 0 & JIT:** `pipeline-run.mjs prepare-author`, `brief.mjs` (inline `baseline-facts.md` capped at 15KB).
- **Roles & Prompts:** `lib/roles.mjs` (`neon` legacy compat), `profiles-check.mjs`, `next-actions.mjs`, `SKILL.md`, `templates/{recon,author,reviewer}.md`, `openspec-schema/{schema.yaml,templates/*}`, `docs/tier2-contract.md`.

### Wave 2 — Runtime Anti-Thrashing Guard, Config Alignment & Verification
- **Guardrails & Telemetry:** `lib/author-guard.mjs`, `hooks/{tool-guard-hook,tier-write-hook,tier-session-hook}.mjs`, `lib/tier-gate.mjs` (`TIER_RULES`), `lib/telemetry.mjs`, `pipeline-run.mjs report`.
- **Global Profile & Routing Alignment:** `~/.paseo/config.json` (`hanlin` `thinkingOptionId: "medium"`, `anchasi`/`chanpin` notes), `~/.paseo/task-routing.md`, `~/.claude/CLAUDE.md`.
- **Tests & Gates:** Update impacted existing tests (`role-handoff-docs`, `docs`, `profiles-check`, `pipeline-friction-docs`, `freeze-check`, `e2e-simulation`, `tier-gate`) and add `test/contract-authoring-v2.test.mjs`.

## Verification Checklist
1. `bash skills/paseo-pipeline/test/run-all.sh` → exit `0`, zero failures.
2. `node skills/paseo-pipeline/profiles-check.mjs --skill skills/paseo-pipeline/SKILL.md --config ~/.paseo/config.json --root . --json` → `ok: true`, `findings: []`, `advisories: []`.
3. `node skills/paseo-pipeline/risk-scan.mjs main HEAD --cwd . --json` → inspected clean.
