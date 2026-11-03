# Pipeline scheduling benchmark

Compares two scheduling policies on the same frozen contract:

- **baseline** — `baseline-tasks.md`: the real `submit-hub-offset-and-draft-box` DAG (10 tasks) as it was frozen, with merge-based dependency edges and per-task review.
- **converged** — `converged-tasks.md`: the same tasks with `Uses` / `Reads` / `Kind: skeleton` / `Review: deferred`, i.e. the redesigned model.

Run:

```
node benchmarks/pipeline/benchmark.mjs
node benchmarks/pipeline/benchmark.mjs --json
node benchmarks/pipeline/benchmark.mjs --assert=50
```

Makespan comes from `skills/paseo-pipeline/lib/schedule.mjs`, the same cost model `freeze-check` uses for its route advisory. Task durations are not simulated from nothing: `baseline-metrics.mjs` reconstructs the measured phases from the real repository history, and `calibrate.mjs` can re-derive the model from any repository.

## What is measured, and what is not

- **Measured (real run):** contract phase 263 minutes (first spec commit → R0 pass), execution start 11:12, last merge 12:43, per-task Red/implementation/merge timestamps.
- **Modeled:** makespan under each policy, using the same per-phase durations for both. Only scheduling semantics differ (readiness edges, caps, review placement).
- **Not modeled:** LLM variance, review quality, merge conflicts, human latency. The model is an upper bound on the value of scheduling changes, not a prediction of a specific run.

## Fairness corrections to the cost model

An earlier run reported 48.7% end-to-end. Three asymmetries in the model, not the
measured data, caused the gap. All three are now fixed in both directions:

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

After the corrections: **execution 45.5%, end-to-end 52.9%** at the measured
263-minute contract, and 49.4% end-to-end if the contract phase were 70 minutes
instead — the result is sensitive to the contract-phase assumption, and the
execution-only gain stays below the 50% line. Do not adjust `263` or `POST` to
raise the number.

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

## Acceptance used for this work

1. `--assert=50` passes on the real DAG (end-to-end improvement ≥ 50%).
2. Full unit suite green: `bash skills/paseo-pipeline/test/run-all.sh`.
3. Sandbox end-to-end run green: contract lint → freeze-check → task merges (including `Uses`, `deferred`, cherry-pick provenance) with no blocking exit codes.
