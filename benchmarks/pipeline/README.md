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

### The earlier 45.8% / 53.0% figure was measured on an invalid contract

A previous revision of `converged-tasks.md` was hand-edited: two `Depends on:` edges
were rewritten as `Uses:` (T-04 → T-05 and T-08 → T-11) without the target declaring
an `Interface:`. That made the converged DAG look two minutes shallower on the
critical path, and it produced 45.8% / 53.0%. `freeze-check --structural` rejects
exactly that shape with `USES_WITHOUT_INTERFACE`, so the pipeline would never have
frozen that contract; the benchmark was scoring a change it could not run. Both
edges are implementation dependencies — T-04's own Note says it is serialised
against T-05 to avoid scope conflict, and T-08 imports an existing component from
T-11 — so `Depends on` is the correct label. The fixture is now rendered by
`derive.mjs`, and the honest number is 23.7% / 42%.

The execution-only gain stays well below 50% here, and the critical-path ceiling
says why: the converged chain T-00 → T-05 → T-04 → T-13 is 244 of the 273 minutes.
No scheduler can beat it, so the most this DAG could ever show is
(358 − 244) / 358 = 31.8% execution. The 27 minutes above the ceiling are the serial
merge queue and the FINAL review tail.

## Sandbox end-to-end

`test/sandbox-e2e.test.mjs` builds a throwaway repository, freezes a small DAG with
a skeleton, a `Uses` consumer, a deferred task and a cherry-picked commit, then runs
`freeze-check` and `merge-task` against it. It asserts both the happy path and the
blocking codes (35 for an unfinished `Uses` producer, 32 for a deferred tag on a
task the contract did not defer, 31 for a hand-recreated commit).

## Merge queue

`skills/paseo-pipeline/merge-queue.mjs` is the P2 pre-merge probe:
`merge-queue.mjs <change-dir>` chains `git merge-tree` over the pending task
branches in dependency order and reports clean merges, conflicting files, and
waiting dependencies. It never touches a ref or the integration worktree;
`merge-task` remains the only writer. `test/merge-queue.test.mjs` covers an
independent queue, a conflict introduced by an earlier queued branch, a missing
dependency branch, and newest-attempt selection.

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
`submit-hub-offset-and-draft-box` DAG reaches 23.7% execution / 42% end-to-end:
its converged critical chain is 244 of 273 minutes, a ceiling of 31.8%. A
smaller/shallower DAG gains less, and the ten-scenario suite is built to show that
spread rather than to maximise the headline.

**Why execution-only cannot reach 50% on these shapes.** A schedule cannot beat its
own critical path. On the converged DAGs the weighted critical path sums to 1,209
minutes against a legacy makespan of 2,614, so the best any scheduler could do is
**53.7%** execution — and three shapes (`ui-form-validation` 49.6%,
`search-index` 46.7%, `perf-profiler` 49.3%) have a critical-path ceiling below 50%.
The remaining 419 minutes from the floor to the simulated 1,628 is the serial merge
queue (`merge-task` is the sole Done writer, by design) plus the FINAL review tail.
That is architecture, not slack: removing it would be the over-design this work was
told to avoid. End-to-end is the number the contract-phase reduction moves.

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
2. Full unit suite green: `bash skills/paseo-pipeline/test/run-all.sh` (256 tests).
3. Sandbox end-to-end run green: contract lint → freeze-check → task merges (including `Uses`, `deferred`, cherry-pick provenance) with no blocking exit codes.
4. Ten-scenario matrix green for all ten shapes under both policies, 94 tasks each;
   aggregate modelled gain 37.7% execution / 50.7% end-to-end.
5. The real DAG is reported as it measures: 23.7% execution / 42% end-to-end. It is
   **not** required to clear 50%; its converged critical chain caps execution at
   31.8%. The earlier `--assert=50` line was removed because the only contract that
   passed it was one `freeze-check` rejects. Raising the fixture to clear a threshold
   is the failure mode this benchmark exists to prevent.
