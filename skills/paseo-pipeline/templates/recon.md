# Recon & Proposal Research Brief

Mode: `RECON` (read-only). Goal: `<question / change-id>`.

Read-only: do NOT edit business code, create contracts, or commit. Investigate using `rg`, targeted file reads, and `preflight.mjs` when needed, then return objective sizing facts for Tier 1 / Tier 2 / Tier 3 routing.

## Scope

1. **Affected files & scopes**: exact repo-relative source paths and distinct package/directory scopes (`packages/*`, `skills/*`, or top-level).
2. **Parallelizability**: can the work split cleanly into `>=4` non-overlapping `Write scope` tasks with `maxWidth >= 2`, or is it serial?
3. **Real entry & existing tests**: real user-facing route/CLI/UI entry points and existing test files covering them (cite `path:line`).
4. **Risk surfaces**: flag any touch on `auth/security`, `concurrency/idempotency`, `persistence/schema`, `money/billing`, `external-write`, or tests whose assertions change.
5. **Open decisions**: material product/hard-risk choices requiring human pick before authoring.

## Return

- **Recommended tier**: `Tier 1` (≤3 files, 1 scope) | `Tier 2` (serial/worktree) | `Tier 3` (concurrent DAG) + rationale
- **Affected paths & scopes** (with `path:line` evidence)
- **Candidate slices / rough DAG** (if Tier 2+)
- **Risk surfaces & open decisions** (or `none`)
