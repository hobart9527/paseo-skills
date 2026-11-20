# Minimal execution contract — design

Date: 2026-11-05. Branch: `fix/contract-phase-efficiency`.

## Intent and why

Measured on `unified-file-and-parser-infrastructure` (baseline 2026-11-05, replay same day):
author leg 69.1 → 129.7 min, R0 r1 31.1 min (vs 32.7) still finding 9 real blockers. The
heavy pre-implementation package (proposal + per-capability delta specs + mandatory digest +
full design with Baseline Alignment and Impact Inventory) did not buy reliable boundaries:
all 9 blockers were cross-task semantics failures (attachment identity, Excel wiring,
`ocrChain` carrier, rollback compensation), which the package never froze. Author time went
into survey ceremony, not into the surfaces that failed review. Goal: cut the contract stage
to what actually prevents integration defects.

## Baseline decision (user-settled)

**OpenSpec itself is the baseline — no invented formats.** The artifact chain is the upstream
`spec-driven` set (proposal → specs → design → tasks) plus the pipeline's execution additions
(tasks parseable format, acceptance, review). An earlier draft of this design replaced all of
it with a custom `contract.md`; rejected mid-implementation on user direction: it re-invented
what OpenSpec already provides and fought its tooling.

What is deleted is what we added on top of upstream, which is where the survey burden lived:

- `digest.md` (custom codebase-panorama artifact) — deleted from schema, template, briefs.
- Impact Inventory (custom, freeze-checked) — deleted; fixtures follow behaviors into tasks
  by the vertical-slice rule, not by a table.
- Baseline Alignment row-per-rule tables (custom) — deleted. Reading what a rule collides
  with stays as bounded author guidance; conclusions sit beside the rule as `path:line`.
- FULL mode's implicit "always write design.md" — reverted to upstream's own rule:
  design.md is created only when its criteria apply (cross-cutting, new dependency/data
  model, security/performance/migration complexity, real ambiguity).

## Goals

- Upstream-native package: `proposal.md` + `specs/<cap>/spec.md` deltas (SCEN-numbered
  scenarios — this IS the BDD behavior contract) + `tasks.md` + `acceptance.md`; `design.md`
  on demand.
- Depth scales by a 5-axis risk checklist (migration/persistence, security/audit, cross-task
  identity/idempotency, external protocol, rollback), never by Tier 3 entry.
- Shared semantics live in scenario THENs; technical trade-offs only in design.md Decisions.
- Workers stay self-sufficient: cross-task surfaces frozen (scenario + skeleton/`Interface:`
  + `Uses:`), consumer `Reads:` cover their Verify anchors; a worker needing to survey the
  repo is a contract defect.
- CP-2 keeps the frozen SHA-bound acceptance matrix (mechanism unchanged).

## Non-goals / anti-goals

- No promised percentage. Authoring time AND integration rework are both measured after.
- No new scripts. Checkers only shrink. `r0-hotspots.mjs` is untouched.
- No weakening: DAG validity, write-scope conflicts, SCEN reconciliation, narrow Verify,
  acceptance freezing, R0 SHA binding all stay.

## Gap closures (from the review of the first reduction plan)

1. **Worker cost-shift** → author brief requires packet-complete tasks (`Reads:` anchors,
   frozen shared interfaces); worker brief turns "gap" into `blocked:`, not re-survey.
2. **Tool-chain sync** → schema v2, freeze-check, author/reviewer/worker briefs, docs and
   3 test files change together; `openspec` CLI smoke test re-run after the swap.
3. **Spec drift** → solved by upstream, not custom: CP-2 closes with `openspec archive`,
   which applies ADDED/MODIFIED/REMOVED deltas into `openspec/specs/` natively.
4. **CP-2 governance** → acceptance matrix unchanged; still the sole frozen authority.
5. **Honest expectations** → single replay measurement after implementation (author leg +
   R0 r1, same change, fresh clone); no percentage promised.

## Implementation inventory

schema.yaml v2 (digest removed, design on-demand, tasks requires specs not design);
templates/{author,reviewer,worker}.md; design.md template (survey sections removed);
freeze-check.mjs (Impact Inventory + Baseline Alignment blocks deleted — scenario walk over
`specs/` unchanged); SKILL.md (entry step 2, structural-check wording, archive step);
tests docs/freeze-check/freeze-check-friction updated; sdd architecture doc artifact list.
