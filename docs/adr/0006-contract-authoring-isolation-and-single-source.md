# ADR-0006: Contract Authoring Isolation, Single-Source Verification & Unified Review

- **Status:** Accepted (extends [ADR-0001](0001-single-source-and-shared-core.md), [ADR-0002](0002-progressive-contract-and-recon-routing.md), [ADR-0004](0004-enabling-harness-environment-and-context.md))
- **Date:** 2026-11-21
- **Scope:** `skills/paseo-pipeline/{SKILL.md,pipeline-run.mjs,brief.mjs,acceptance-sync.mjs,freeze-check.mjs,tier2-verify.mjs,lib/tasks.mjs,lib/roles.mjs,profiles-check.mjs,templates/*,openspec-schema/*}`, `docs/tier2-contract.md`

## Context

Forensic trace of `approval-hub` change `unified-approval-picker` (`2538b320` → `hanlin` `73c29f91`) revealed why monolithic contract authoring fails under complex changes:
1. **Conflated workloads in one context window:** Running codebase archaeology, baseline test suites, schema modeling, and task slicing inside a single `hanlin FULL` context drove context past `153k`, pushed `thinking_tokens` to `93.8%` (`315k+`), triggered `169k` auto-compaction with zero `specs/` persisted, and forced 11+ redundant re-reads of the same files over `2+` hours with zero `specs/` produced.
2. **Circular coupling in `--stage specs`:** `freeze-check.mjs` rejected `--stage specs` on `MISSING_SCEN_VERIFY`, forcing authors to invent test paths and task boundaries before finishing behavioral specs, while duplicating `Verify`/`Entry` across `specs/`, `tasks.md`, and `acceptance.md`.
3. **Prose-serialized interfaces & overlapping review roles:** Authors burnt thinking tokens transcribing TypeScript interfaces into Markdown instead of typed code stubs, while R0 (`neon`) shared a model family with `chanpin` (`google`), leaving an unnecessary `ADVISORY_FAMILY_PAIR`.

## Decision

1. **Three-Stage Physical Authoring Isolation:**
   - **Stage 0 (`pipeline-run.mjs prepare-author`):** Deterministic 0-token setup capturing `preflight`, optional `--hydrate`, `namespace`, `main` drift, and rule/capability counts into `openspec/changes/<change>/baseline-facts.md` (capped ≤15KB, exempt from R0 `STALE_R0_SIGNOFF` drift, auto-JIT-inlined by `brief.mjs author`).
   - **Stage 1 (`chanpin` via `brief.mjs recon`):** Strictly read-only objective code-fact compilation (`path:line`, real shapes, affected tests, capability gaps) appended to `baseline-facts.md`. Must never draft Proposal/Spec prose or invent architecture.
   - **Stage 2 (`hanlin` via `brief.mjs author`):** Starts in a clean context consuming `proposal.md` + inlined `baseline-facts.md`, authoring pure behavioral `specs/` → `freeze-check --stage specs` → `tasks.md` → `acceptance sync` → full `--structural`. Full suites never run before `specs/` is committed.
2. **Single Source of Truth for Verification:**
   - `specs/` defines pure observable behavior (`SCEN-*`, `WHEN`/`THEN`); `--stage specs` no longer requires `- **Verify:**`.
   - `tasks.md` is the sole authority for `Verify with:`, `Entry:` (task-level or `SCEN-ID=<entry>` map), and `Required: yes|no` (default `yes`).
   - `acceptance sync` deterministically compiles zero-placeholder `acceptance.md` directly from `specs/` + `tasks.md`.
   - `tier2-verify.mjs` resolves scenario verification commands from `tasks.md` (preserving fallback to legacy `- **Verify:**` in `specs/`).
3. **Code-as-Contract & Unified Reviewer:**
   - Cross-layer concurrent interfaces default to a Wave 0 `Kind: skeleton` typed stub locked by compiler checks instead of Markdown field copies.
   - All independent reviews (R0, Tier 2, FINAL) route to `anchasi` (`codex/gpt`), preserving heterogeneous family isolation against `chanpin` (`google`), `hanlin` (`anthropic`), and workers (`deepseek`/`zhipu`/`moonshot`). `lib/roles.mjs` and `freeze-check.mjs` retain read-only recognition for historical `neon`/`hanlin R0` sign-offs.

## Rejected / Non-Goals

- **Rejected splitting Stage 2 into separate `hanlin-spec` and `hanlin-dag` agents by default:** Stage 0/1 removal already cuts context below the compaction cliff without extra coordination latency.
- **Rejected deleting `acceptance.md` or breaking legacy specs:** Deterministic generation + fallback retains CP-1/CP-2 matrix auditing and zero-rewrite Tier 2 compatibility.

## Consequences & Verification

- Eliminates pre-spec `Verify` deadlocks, manual matrix synchronization, and `chanpin`/`neon` family overlap while bounding `hanlin` context size.
- Verified via `test/contract-authoring-v2.test.mjs`, `test/convergence.test.mjs`, `test/freeze-check.test.mjs`, and `profiles-check.mjs --json`.
