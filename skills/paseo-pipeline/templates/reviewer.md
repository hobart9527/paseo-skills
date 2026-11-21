# Independent Reviewer Brief

Mode: `R0 | FINAL`. Change: `<id>`. Evidence: `<paths / base / tip>`.

Read-only: no edits, commits or state changes. Report writes; reconcile snapshot before using verdict without another review loop. Cite `path:line` or reproducible reasoning from supplied evidence; no broad refactors. Record target SHA, contributor/reviewer profiles and declared families via `list_profiles`; no self-review. Aliases/notes prove neither family diversity nor permissions. Before/after HEAD, tracked diff and untracked checks detect changes, not a sandbox.

## Requirement conformance first

Build bidirectional traceability: every confirmed requirement has a SCEN, and every SCEN traces to a requirement or decision. R0 checks shared boundaries and whether Verify detects wrong implementation; strict needs available real interfaces, test paths and Verify. FINAL checks Red assertion evidence, oracle fidelity (no source-text-only or weakened assertions), and `risk-scan` hits, not just `ceshi` trailers; use one matrix row per SCEN, acceptance row and fixed standard. Raise blockers only for covered behavior or fixed standards with a concrete counterexample; never emit `ENHANCEMENT` or style-nit lists.

## R0 — frozen contract

Review Proposal, Specs, Design (when present), Tasks and Acceptance as one package before CP-1 on three checks, nothing else; a blocker names its check. Structural validity and scope conflicts are `freeze-check --structural`'s output — do not re-verify them.

1. **Reach**: each SCEN's Entry is owned by a task and its Verify runs that real entry, not a fixture or isolated module; state how wrong/unwired behavior fails. Missing sibling file needs a dependency.
2. **Shape**: each claimed field, route, enum and payload is cited from baseline with its real shape and agrees with confirmed decisions supplied to the author. Shared concurrent surfaces have one reachable frozen contract.
3. **Removal**: a removal dropping a gate (submit blocking, validation, lease, ledger) names where that gate goes.

Review pinned commit and approved external snapshots only; stop on missing or changed inputs. Do not run the full suite: at most one narrow command per package. Baseline exit codes come from the author's `## Baseline`; the reviewer reads that record and does not rerun it. Source-text assertions prove text, not behavior.

Round 1 reports all supported blockers; delta checks fixes only. Round limits and unresolved-blocker disposition: `SKILL.md` § Entry and CP-1. Findings are `BLOCKER` or `NIT` (pure anchor-drift with same symbol is non-blocking NIT); proofread every `path:line`.

Scope budget: inspect only the contract artifacts, cited baseline `path:line` anchors, and direct boundary callers; deliver the conclusion immediately once checked (never survey unrelated code; an incomplete check returns partial findings + unchecked items, never a pass).

Return `R0: pass(<reviewer-uuid>@<sha>)` and reviewed SHA as text; main session records it in `review.md`.

## FINAL — integrated conformance

Judge `main...<reviewed-full-SHA>` against finite approved inputs: frozen SCENs, `acceptance.md`, `risk-scan` report, and the 5 fixed standards (Oracle fidelity / no weakened assertions + 4 fixed baseline rows: data loss / wrong external write / money semantics; security / auth / privacy; main-path crash / deadlock; concurrency / idempotency race — same baseline as `docs/tier2-reviewer-brief.md`). Return full SHA and verdict bound only to that SHA; a new SHA gets delta review with ledger carried across reviewers.

Output matrix: one row per SCEN, acceptance row and fixed standard (`MET | NOT_MET | UNVERIFIABLE` + evidence/counterexample). `UNVERIFIABLE` reports `INCOMPLETE`. Findings outside matrix are `CONTRACT_GAP` only when a realistic wrong outcome on a fixed standard lacks a frozen requirement; never emit `ENHANCEMENT`, `Followups`, or style nits. Human disposition for a contract gap is required before CP-2.

A blocker attaches to a matrix row with trigger, wrong result, `path:line`, and minimal fix. Do not hunt beyond matrix and the 5 fixed standards. Record ledger in `review.md`:

```text
F-<n> <matrix row> <DEVIATION|CONTRACT_GAP> <open|fixed@<sha>|closed|accepted|rejected> <reason>
```

`DEVIATION` cites SCEN/acceptance/fixed-standard and counterexample. Closed defect classes stay closed absent new evidence. Replacement reviewer inherits ledger and round budget. A pass starts exactly:

```text
FINAL: pass(<reviewer-uuid>@<full-sha>)
```

## Review depth

Depth follows matrix and `risk-scan` coverage, never expands scope:

- Specs: frozen SCENs implemented and exercised; cross-task interactions and Verify falsifiability.
- Oracle fidelity: lint/typecheck do not replace review; verify real entries run and assertions were not weakened.
- UI, backend, persistence, concurrency, money, external-write, security: trace failure paths only where a SCEN, acceptance row, `risk-scan` hit, or fixed standard covers them; otherwise out of scope.

## Bounded rounds and disposition

Delta review checks fix diff, affected behavior and open ledger items only. Round limits: `SKILL.md` § FINAL and CP-2. Unresolved disposition: `templates/approvals.md` § FINAL after round 2.
