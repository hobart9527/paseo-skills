# Pipeline scheduling benchmark

Compares two scheduling policies on the same frozen contract:

- **baseline** — `baseline-tasks.md`: the real `submit-hub-offset-and-draft-box` DAG (10 tasks) as it was frozen, with merge-based dependency edges and per-task review.
- **converged** — `converged-tasks.md`: the same tasks with `Uses` / `Reads` / `Kind: skeleton` / `Review: deferred`, i.e. the redesigned model.

Run:

```
node benchmarks/pipeline/benchmark.mjs
node benchmarks/pipeline/benchmark.mjs --json
node benchmarks/pipeline/derive.mjs            # verify the fixture is still the derivation
node benchmarks/pipeline/derive.mjs --write    # regenerate it after a real design change
node benchmarks/pipeline/contract-check.mjs benchmarks/pipeline/converged-tasks.md
```

Makespan comes from `skills/paseo-pipeline/lib/schedule.mjs`, the same cost model `freeze-check` uses for its route advisory. Task durations are not simulated from nothing: `baseline-metrics.mjs` reconstructs the measured phases from the real repository history, and `calibrate.mjs` can re-derive the model from any repository.

`converged-tasks.md` is **generated**, not authored. `derive.mjs` renders it from
`baseline-tasks.md` using `freeze-check`'s own edge rule (a target that declares
`Interface:` may be reached with `Uses`; every other edge is `Depends on`). The only
authored input is the design decision: which files the skeleton freezes, which
read-only fixtures a task executes, which standard tasks defer review.
`test/benchmark-contract.test.mjs` fails if the file drifts from the derivation and
runs both fixtures through the real `freeze-check --structural`.

## What is measured, and what is not

- **Measured (real run):** contract phase 263 minutes (first spec commit → R0 pass), execution start 11:12, last merge 12:43, per-task Red/implementation/merge timestamps.
- **Modeled:** makespan under each policy, using the same per-phase durations for both. Only scheduling semantics differ (readiness edges, caps, review placement).
- **Not modeled:** LLM variance, review quality, merge conflicts, human latency. The model is an upper bound on the value of scheduling changes, not a prediction of a specific run.

## Fairness corrections to the cost model

An earlier run reported 48.7% end-to-end. Four asymmetries in the model, not the
measured data, caused the gap. All four are now fixed in both directions:

1. **Est parity.** The baseline fixture omitted `Est:`, so the model charged those
   tasks M (25 min) while the converged fixture declared L (45 min) for the same
   tasks. The baseline fixture now declares the same `Est` values as the converged
   fixture. This *raises* the baseline cost, which is the honest reading of the
   original tasks.
2. **Rework symmetry.** `simulate` charged expected rework only in the legacy
   policy. Both policies now charge `reworkRate` after review, so the converged
   policy no longer gets free rework.
3. **Mechanical tasks skip Red.** A `Review: mechanical` task has no Red commit, in
   either policy. `simulate` previously charged a Red phase to every task under the
   legacy policy; it now starts mechanical tasks at implementation.
4. **Regression replay in both merges.** `merge-task` re-runs every already-Done
   task whose Verify scope overlaps the merging task, and that code has no policy
   branch — it is already present at the pre-optimization commit `3564da4`. The
   model charged `regressionMinPerTask` only to converged merges, which understated
   the legacy makespan.

After the corrections: **execution 23.7%, end-to-end 42%** at the measured
263-minute contract (358 → 273 min execution; 721 → 418 min end-to-end). Do not
adjust `263` or `POST` to raise the number.

### The mechanism-derived lever: drop the reads-only edge

`freeze-check` reports `ADVISORY_READS_ONLY_EDGE T-04 -> T-05`: the pair shares only
`scripts/specs/payee-company-scope.mjs` in `Reads` and their Write scopes do not
overlap. `merge-task` replays either side when the other changes
(`regressionReplays`), so the edge buys dispatch order, not regression safety.

`benchmark.mjs` takes exactly the edges `readsOnlyEdges()` reports, drops them in
memory, re-runs `checkContract`, and prints the result only when the variant still
freezes. On this contract that is **194 min execution, 339 min end-to-end:
45.8% / 53.0%**. The fixture on disk is not edited. The number is a CP-1 decision
input for the contract author, and it appears only when the pipeline would still
freeze the resulting contract.

### The critical chain, as frozen

The execution-only gain stays at 23.7% for the contract **as frozen**, and the
critical path says why: the converged chain `T-00 -> T-05 -> T-04 -> T-13`
(244 min) dominates the 273-minute makespan. The chain is now reported with `via`
tags (`uses | logical | reads | scope`), so the edge that carries the chain is
visible: `T-04 -> T-05` is a `reads` edge, the same one the advisory names. Drop it
and the shared model reports a 194-minute critical path, i.e. 45.8%. No scheduler
change moves either number.

The earlier 45.8% / 53.0% figure that this README used to reject was measured on a
different, invalid fixture: two `Depends on:` edges had been hand-rewritten as
`Uses:` without an `Interface:`, and `freeze-check --structural` rejects that shape
with `USES_WITHOUT_INTERFACE`. The current 45.8% / 53.0% comes from a variant the
gate still accepts, and it is computed by `benchmark.mjs`, not authored.

The 29 minutes above the critical path are the marginal cost of the serial merge
gate (see below), not scheduling slack.

## Sandbox end-to-end

`test/sandbox-e2e.test.mjs` builds a throwaway repository, freezes a small DAG with
a skeleton, a `Uses` consumer, a deferred task and a cherry-picked commit, then runs
`freeze-check` and `merge-task` against it. It asserts both the happy path and the
blocking codes (35 for an unfinished `Uses` producer, 32 for a deferred tag on a
task the contract did not defer, 31 for a hand-recreated commit).

## Merge queue, and why there is no merge train

`merge-task` is the only Done writer and merges serially. That is a deliberate
correctness choice, and its measured cost is bounded:

- On the real DAG, zeroing `mergeMin` and `regressionMinPerTask` changes the
  converged makespan from 273 to 244 min: the serial merge gate's **marginal cost is
  29 min, 10.6%**.
- Across the ten sandbox shapes it is **304 min, 18.7%** of converged execution.
  That is an upper bound on what any faster merge mechanism could recover.
- Raising `writerCap`/`reviewerCap` to 10/8 leaves the 273-minute makespan unchanged.
  The bottleneck is contract edges, not concurrency slots.

A merge train (batching task merges into one integration push) would need bisection
and partial rollback when one commit in the batch fails, plus a second path that can
mark Done. That is more machinery than the 10–19% it could address, and it gives up
the single auditable writer that makes `merge-task` trustworthy. Decision: keep one
serial writer; optimize the DAG (drop advisory edges) instead of the merge
mechanism.

`skills/paseo-pipeline/merge-queue.mjs` remains the read-only pre-merge probe:
`merge-queue.mjs <change-dir>` chains `git merge-tree` over the pending task
branches in dependency order and reports clean merges, conflicting files, and
waiting dependencies. It never touches a ref or the integration worktree;
`merge-task` remains the only writer. `test/merge-queue.test.mjs` covers an
independent queue, a conflict introduced by an earlier queued branch, a missing
dependency branch, and newest-attempt selection.

## Red-ahead: measured, not implemented

Running `ceshi` for a task whose dispatch deps are not Done yet (speculative Red)
is *not* implemented. The model cannot price its main risk: a Red test written
against an interface another task is still implementing often fails for the wrong
reason and is rewritten, and that rework is invisible to the scheduling model. The
benchmark reports scheduling levers only; it does not invent speculative work to
move the headline. Re-open this only with measured rework data showing Red authoring
is on the critical path.

## Ten-scenario sandbox

`sandbox-matrix.mjs` runs ten complex change shapes through the real scripts in a throwaway
repository — `freeze-check`, `next-actions` frontier, `sync-check`, `merge-queue`,
`merge-task`, and the FINAL reviewer brief — once under the legacy policy and once
under the converged one. Each scenario is a 9–10 task decomposition, sized like the
measured submit-hub change, with a skeleton, interface-declaring producers, `Uses`
consumers, and one mechanical sink. The scenarios cover UI skeletons, public-API rate
limiting, persistence imports, security refresh, concurrency leases, search performance,
mechanical i18n wiring, a design-token fan-out, a long CLI chain, and profiler fan-out.

What it proves: every shape freezes, dispatches, syncs, merges, and closes with all
tasks Done and no blocking exit code, across 94 tasks per policy. What it does *not*
prove: model quality or wall-clock gains. Agent work is replaced by tiny commits, so
the timed orchestration numbers are overhead only (≈10% difference) and are not a
delivery-speed measure.

The efficiency comparison is the shared cost model, reported two ways:

- **execution only** — `simulate()` makespan under each policy.
- **end-to-end** — execution plus the measured contract phase (263 → 45 min, from
  the real submit-hub history) plus a shared 100 min post phase, exactly as
  `benchmark.mjs` does.

The sandbox figures are deliberately not tuned to clear an efficiency target. On
these ten shapes the modelled execution gain is **37.7%** aggregate and the modelled
end-to-end gain is **50.7%** aggregate. Per scenario, execution ranges 26.8–49.1%
and end-to-end 45.0–55.8%; six of ten clear 50% end-to-end. The real
`submit-hub-offset-and-draft-box` DAG reaches 23.7% execution / 42% end-to-end as
frozen; its converged critical chain is 244 of 273 minutes, and the benchmark's
mechanism-derived lever (dropping the advisory reads-only `T-04 -> T-05` edge) is
45.8% / 53.0%. A smaller/shallower DAG gains less, and the ten-scenario suite is
built to show that spread rather than to maximise the headline.

**Why execution-only cannot reach 50% on these shapes.** A schedule cannot beat its
own critical path. On the converged DAGs the weighted critical path sums to 1,209
minutes against a legacy makespan of 2,614, so the best any scheduler could do is
**53.7%** execution — and three shapes (`ui-form-validation` 49.6%,
`search-index` 46.7%, `perf-profiler` 49.3%) have a critical-path ceiling below 50%.
The remaining 419 minutes above that floor split into 304 minutes of serial merge
marginal cost (18.7% of converged execution) and roughly 115 minutes of writer-cap
contention plus the FINAL review tail. The merge share is the price of one auditable
Done writer; the no-merge-train section above explains why batching it is the wrong
trade. End-to-end is the number the contract-phase reduction moves.

The orchestration wall time is the only directly measured number in the sandbox,
and it is a script-overhead measure, not delivery speed: ~10%. Everything else in
the comparison comes from the shared cost model. That model was corrected in both
directions before the figures above (see "Fairness corrections"); it is an upper
bound on what scheduling alone can buy, not a prediction of a specific run.

The sandbox also exposed a real scheduling defect, now fixed: `next-actions` proposed
a merge for a `Uses` consumer as soon as its own implementation existed, before the
producer was Done, and `merge-task` refused with exit 35. The frontier now reports
such a task under `mergeWaiting` and withholds the merge until every `depends`/`uses`
edge is Done; a regression test covers it.

## Acceptance used for this work

1. Both fixtures pass the pipeline's own `freeze-check --structural`, and
   `converged-tasks.md` is byte-for-byte the output of `derive.mjs`
   (`test/benchmark-contract.test.mjs`). A fixture the pipeline would refuse to
   freeze cannot contribute a number.
2. Full unit suite green: `bash skills/paseo-pipeline/test/run-all.sh` (263 tests).
3. Sandbox end-to-end run green: contract lint → freeze-check → task merges (including `Uses`, `deferred`, cherry-pick provenance) with no blocking exit codes.
4. Ten-scenario matrix green for all ten shapes under both policies, 94 tasks each;
   aggregate modelled gain 37.7% execution / 50.7% end-to-end.
5. The real DAG is reported as it measures. As frozen: 23.7% execution / 42%
   end-to-end, because its converged critical chain is 244 of 273 minutes. The
   mechanism-derived lever — dropping the `readsOnlyEdges()` advisory and re-running
   `checkContract` — is 45.8% / 53.0%, printed by `benchmark.mjs` and never authored.
   The earlier `--assert=50` line was removed because the only way to pass it was a
   fixture `freeze-check` rejects. Raising the fixture to clear a threshold is the
   failure mode this benchmark exists to prevent.
