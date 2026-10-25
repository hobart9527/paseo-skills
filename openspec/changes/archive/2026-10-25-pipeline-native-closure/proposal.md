# Pipeline Native Closure

Risk-scan: checked [numerical, crypto/auth, concurrency, persistence, public-api, irreversible], hits: [concurrency, persistence, public-api, error-handling]

## Why

Pipeline currently conflates agent completion, accepted task delivery and Git integration; its CLI dispatcher, optimistic reconciliation and permissive merge defaults can leave unattended work stalled or duplicated. The user explicitly requested implementation of the reviewed Pipeline optimizations, retaining size-based Lead routing and event-driven operation with lazy reconciliation.

## What Changes

- Modified: native agent-scoped MCP delegation as default, profiles from live list_profiles, stable parent ownership, bounded final envelopes, explicit task/attempt/phase identity and permission escalation.
- Modified: dynamic DAG readiness, separate resource-conflict policy, sequential role handoff and integration, evidence-bound audit, safe merge and fail-closed recovery.
- Modified: mechanical scripts and regression tests, legacy CLI/hotfix migration guidance, consistent docs and truthful measurements.
- Removed: false guarantees of spontaneous timeout wakeup without a wake source, mandatory rebase, zero compaction, static scenario references as behavioral coverage, unconditional automatic reset and implicit mechanical approval.

## Capabilities

### New Capabilities
- `pipeline-delivery`: Native multi-agent delivery, dependency scheduling, safe integration and recoverable outcomes.

### Modified Capabilities

None; this repository had no OpenSpec directory before this change.

## Scope

Only skills/paseo-pipeline and this change's OpenSpec artifacts in the isolated integration workspace. Existing uncommitted dispatch.mjs/hotfix.sh fixes in the source checkout must be preserved as baseline intent (optional mode/thinking and pi compatibility). Do not touch paseo-ui, daemon configuration, profile notes or approval-hub business files. No dependencies, schema changes, deletes, daemon restart, remote push, main commits or merge to main.

## Acceptance Criteria

1. Native dispatch instructions use live profile notes/settings and notifyOnFinish; CLI-only success and parent labels cannot prove callback delivery.
2. Reconciliation rejects malformed/unknown/cyclic dependencies, wrong integration branch and unavailable/unmapped runtime; active or unresolved attempts cannot become dispatchable; branch divergence alone never means accepted delivery.
3. DAG dependencies release after verified integration, not whole-wave completion; resource conflicts are separate and explicitly handled.
4. Merge requires exact tasks, explicit verification and revision-bound review; remains on integration branches; no hard-reset fallback or swallowed failure; code and Done updates share the integration commit.
5. Ordinary event-driven runs create no recurring heartbeat. Without a verified timer or external event source, silent callback loss cannot automatically wake an idle Lead; lazy reconciliation runs at next real invocation. Do not advertise an unimplemented ten-minute watchdog.
6. Bounded envelopes, task/attempt/phase mapping, duplicate/stale notification handling, permission pauses, finite retry budgets, OpenSpec main-session CLI ownership and safe workspace retention are documented consistently.
7. Runnable dependency-free regressions cover success, failure, duplicate/unresolved execution, resource conflicts and safe merge; existing contract-check tests run. Live native callback smoke evidence is collected separately from mocks; unrun scenarios explicitly remain unverified.
8. No claim of universal success, zero compaction, fixed latency, exact test count or complete behavioral coverage without collected evidence.

## Impact

SKILL.md, LESSONS.md, dispatch.mjs, reconcile.mjs, merge-task.mjs, merge-task.sh, hotfix.sh, contract-check tools if needed for truthful verification, and focused tests/templates under skills/paseo-pipeline. Runtime remains Paseo, lifecycle remains OpenSpec, integration facts remain Git; no second scheduler or durable receipt database.
