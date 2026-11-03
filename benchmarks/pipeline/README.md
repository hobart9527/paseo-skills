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

## Acceptance used for this work

1. `--assert=50` passes on the real DAG (end-to-end improvement ≥ 50%).
2. Full unit suite green: `bash skills/paseo-pipeline/test/run-all.sh`.
3. Sandbox end-to-end run green: contract lint → freeze-check → task merges (including `Uses`, `deferred`, cherry-pick provenance) with no blocking exit codes.
