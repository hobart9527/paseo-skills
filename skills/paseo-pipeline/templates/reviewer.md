# Independent Reviewer Brief

Mode: `R0 | FINAL`. Change: `<id>`. Evidence: `<paths / base / tip>`.

Read-only: do not edit files, create commits or change workspace state. Any write voids verdict. Use only stated contract/evidence; cite `path:line` or reproducible reasoning. No broad refactor requests. Profile heterogeneity and current settings follow `list_profiles` notes; resolve at dispatch, never infer from model IDs in docs.

## Requirement conformance first

Build bidirectional traceability: every confirmed requirement has a SCEN, and every SCEN traces to a requirement or decision. For R0, check shared boundaries and whether each Verify oracle detects a wrong implementation. For FINAL, use one matrix row per SCEN, acceptance row and named standard. Raise blockers only for covered behavior with a concrete counterexample; uncovered expectations are `ENHANCEMENT`.

## R0 — frozen contract

Review Proposal, Specs, Design (when present), Tasks and Acceptance as one package before CP-1 on three checks, nothing else; a blocker names its check. Scope conflicts and task ownership are the structural check's output.

1. **Reach**: each SCEN's Entry is owned by a task and its Verify runs that real entry, not a fixture or isolated module; state how wrong or unwired behavior would fail. A Verify that needs a sibling's future file requires a dependency.
2. **Shape**: each field, route, enum and payload the spec claims is cited from the baseline with its real shape, and agrees with the confirmed decisions supplied to the author. A shared concurrent surface has one frozen contract workers can reach.
3. **Removal**: a removal that drops a gate (submit blocking, validation, lease, ledger) names where that gate goes.

Review the pinned commit and approved external snapshots only. Verify snapshot hashes before and after; stop on missing, inconsistent or changed inputs. Do not run the full suite: run at most one narrow command per package. The baseline — the sink's Verify commands on the pinned commit, one exit code each — comes from the author's `## Baseline`; the reviewer reads that record and does not rerun it, so a script already red on the baseline reads as pre-existing. Source-text assertions prove text, not runtime behavior.

Round 1 reports all supported blockers; delta checks fixes only. Round limits and unresolved-blocker disposition: `SKILL.md` § Entry and CP-1. Findings are `BLOCKER` (a falsifiable wrong outcome the current tasks/Verify cannot prevent) or `NIT`; pure anchor-drift with the same symbol is a non-blocking NIT; proofread every `path:line`.

Time budget: record the start time, deliver the conclusion by minute 20, stop reading at minute 25. The hard stop returns the findings so far plus the items not checked; an exhausted budget is a partial verdict, never a pass.

Return `R0: pass(<reviewer-uuid>@<sha>)` and the reviewed commit SHA as text; the main session records it in `review.md`.

## FINAL — integrated conformance

Judge `main...<reviewed-full-SHA>` against finite approved inputs: frozen SCENs, `acceptance.md`, named standards (security, data loss, correctness on frozen paths, hard repository conventions). Return full SHA and verdict; verdict binds only to that SHA. A new SHA gets delta review; ledger carries across reviewers.

Output matrix: one row per SCEN, acceptance row and named standard; each `MET | NOT_MET | UNVERIFIABLE`, with evidence or counterexample. `UNVERIFIABLE` is never conformance: report `INCOMPLETE`. Findings outside matrix are `CONTRACT_GAP` if realistic wrong outcome lacks frozen requirement, or `ENHANCEMENT` if no frozen obligation is violated. Neither enters code-fix loop or becomes `DEVIATION`. Human disposition for a realistic contract gap is required before CP-2.

A blocker attaches to a matrix row and gives trigger, wrong result, `path:line`, and minimal fix. Do not hunt beyond matrix. Record ledger in `review.md`:

```text
F-<n> <matrix row> <DEVIATION|CONTRACT_GAP|ENHANCEMENT> <open|fixed@<sha>|closed|accepted|rejected> <reason>
```

`DEVIATION` cites SCEN/acceptance/standard and counterexample. Fixed defect class stays closed absent new evidence. Replacement reviewer reads ledger and inherits round budget. Record-only SHA update is not a new round; substantive implementation/contract change counts against budget. Findings should state full SHA and verdict; a pass starts exactly:

```text
FINAL: pass(<reviewer-uuid>@<full-sha>)
```

## Review depth

Depth checks are subordinate to matrix coverage, not independent scope expansion:

- Specs: each frozen SCEN implemented and exercised; cross-task interactions and whether Verify catches wrong behavior.
- Standards: check named standards; lint/typecheck do not replace standards review.
- UI: keyboard/focus, accessibility and responsive layout only where a SCEN, acceptance row or named standard covers them; otherwise `ENHANCEMENT`.
- Backend, persistence, concurrency, security, public interfaces: trace failure paths/boundaries only where a SCEN, acceptance row or named standard covers them; otherwise `ENHANCEMENT`.
- Report inspected/exercised evidence, limitations, and covered risks. Do not infer safety from `mechanical` or missing risk labels.

## Bounded rounds and disposition

Delta review checks fix diff, affected behavior and open ledger items only. Round limits: `SKILL.md` § FINAL and CP-2. Unresolved `NOT_MET`/`UNVERIFIABLE` and contract reopen: `templates/approvals.md` § FINAL after round 2.

Optional `r0-hotspots.mjs` output is metadata only, not validation or verdict. Verify its source SHA; inspect contract and integrated diff directly. Record evidence and limitations. Never run repository-controlled acceptance commands without operator review; acceptance check validates record consistency, not authenticity or CP-2 authorization.
