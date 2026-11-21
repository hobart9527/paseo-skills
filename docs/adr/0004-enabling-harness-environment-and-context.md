# ADR-0004: Enabling Harness — Warm Worktrees, JIT Context & Self-Healing ACI

- **Status:** Accepted (core landed in `feat/enabling-harness`: `--workspace-dir`/`--hydrate`, JIT `brief.mjs`, O(1) `tool-guard`, worktree churn Stop)
- **Date:** 2026-11-21
- **Scope:** `skills/paseo-pipeline/pipeline-run.mjs`, `brief.mjs`, `preflight.mjs`, `hooks/tool-guard-hook.mjs`, `lib/tier-gate.mjs`

## Context

Even after gate convergence, E2E telemetry (`pipeline-json-audit`, `approval-hub`) showed ~85% of harness logic is still defensive (catching mistakes after tokens are spent). Major remaining efficiency drains:
- **Cold worktrees:** Git worktrees omit `node_modules`/`.venv`, forcing workers to hit exit-36 failures and reinstall dependencies per task;
- **Context archaeology:** `brief.mjs` passes file paths rather than compiled context packets, so workers/reviewers spend 5–15 turns running `Read`/`rg`/`git diff`;
- **Opaque error recovery & sync I/O:** Non-uniform CLI error formats force `--help` loops; `tool-guard-hook.mjs` synchronously parses up to 2 MB of `transcript.jsonl` on every unrewritten MCP call; worktree sessions lose Stop churn detection and repeatedly hit Claude Code's `cd <shared-repo>` isolation block;
- **Underused Paseo capabilities:** Native `create_workspace`, `workspace_scripts`, `steer`, `/paseo-advisor`, and structured `--output-schema` verdicts are rarely triggered automatically.

## Decision

Shift the harness from *post-hoc policing* to *proactive enablement*:
1. **Warm Worktree Hydration:** Extend `prepare-task` (and accept `--workspace-dir` for Paseo-managed `create_workspace` trees) to optionally hydrate dependencies per `preflight.mjs` / `paseo.json` `workspace_scripts` and confirm baseline health *before* waking the worker.
2. **JIT Context Compiler (`brief.mjs`):** Upgrade `brief.mjs` to inline token-budgeted, high-signal context directly into the role packet: exact claimed `#### Scenario: SCEN-*` text, upstream `Uses`/`Depends on` interface diffs, and reviewer diffstats + `risk-scan` hit lines (strict byte cap to prevent context bloat).
3. **Actionable & Self-Healing ACI:**
   - Standardize gate failure output to `{ ok, code, summary, evidence, nextCommand }` so every failure hands the agent its exact next recovery command.
   - Replace `tool-guard-hook.mjs`'s 2 MB synchronous transcript scan with an O(1) `< 2 KB` per-session state file; auto-fill unambiguous `pipeline.change` labels instead of denying; pre-warn on worktree `cd <shared-repo>` patterns.
   - Decouple `assessStop` so linked worktrees skip Tier 1 file-count caps while retaining 3-turn churn detection pointing to `steer` → `/paseo-advisor` → `/paseo-committee`.
4. **Structured Evaluator Verdicts:** Support machine-checked verdict envelopes (`record-review`) so `recon`, `r0`, and `final` sign-offs write cleanly to `review.md` without manual SHA transcription.

## Rejected / Non-Goals

- **Rejected unbounded context dumping:** Inlining whole files or repo trees degrades LLM attention; JIT packets stay strictly scoped and size-capped.
- **Rejected mandatory heavy service boot for pure unit repos:** Warm hydration runs only when lockfiles/`paseo.json` scripts are present.

## Consequences & Verification

- Cuts coordination rounds, cold-start dependency failures, hook latency on large transcripts, and blind same-model retry loops.
- Verified incrementally via unit/CLI benchmarks in `test/convergence.test.mjs`, `test/tool-guard-hook.test.mjs`, and real E2E trace comparisons.
