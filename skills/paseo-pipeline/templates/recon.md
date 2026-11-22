# Recon & Proposal Research Brief

Mode: `RECON` (read-only Stage 1 fact compiler). Goal: `<question / change-id>`.

Read-only: do NOT edit business code, write Proposal/Spec prose, invent architecture, or commit. Investigate using `rg`, targeted file reads, and `preflight.mjs` when needed, then return objective sizing & code facts (kept ≤ 15KB so `openspec/changes/<change>/baseline-facts.md` stays compact for clean-context authoring).

## Scope

1. **Affected files & scopes**: exact repo-relative source paths (`path:line`), real types/enums/storage constraints, and distinct package/directory scopes (`packages/*`, `skills/*`, or top-level).
2. **Entropy & parallelizability**: count distinct capabilities, rules (`R*`), affected business files, and whether work splits cleanly into `>=4` substantive non-overlapping `Write scope` tasks with `maxWidth >= 3` (or `maxWidth >= 2` with `weightedSpeedup >= 1.8`), or should split/stay Tier 2. Flag `SPLIT_RECOMMENDED` if `>2` capabilities, `>10` rules, `>12` business source files, or `>8` tasks.
3. **Real entry & existing tests**: real user-facing route/CLI/UI entry points (`Entry:`) and existing test files covering them (cite `path:line`), plus baseline failure notes if any.
4. **Risk surfaces & invariants**: flag any touch on `auth/security`, `concurrency/idempotency`, `persistence/schema`, `money/billing`, `external-write`, or changed test assertions, plus key business invariants guarding this path (`path:line`).
5. **Open decisions, gaps & `[ASSUMPTION]`s**: material product/hard-risk choices, missing gateway capabilities, or external/prod behaviors unseen in code (`[ASSUMPTION]` + how to verify) requiring human confirmation before authoring.

## Return

- **Recommended tier & entropy check**: `Tier 1` | `Tier 2` | `Tier 3` (or `SPLIT_RECOMMENDED` with proposed small vertical splits) + rationale
- **Verified Code Facts** (`path:line` evidence, real shapes, gaps)
- **Existing Invariants & Unverified `[ASSUMPTION]`s** (note verification method for each assumption)
- **Affected Existing Tests & Entries** (`Entry` + test paths)
- **Candidate slices / rough DAG** (if Tier 2+)
- **Risk surfaces & open decisions** (or `none`)
