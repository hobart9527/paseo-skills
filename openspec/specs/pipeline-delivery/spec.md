# pipeline-delivery Specification

## Purpose

Deliver contract-driven changes through Paseo's native multi-agent workspaces and notifications, with Git as execution state. Pipeline applies only when frozen task graph has real concurrency (`maxWidth >= 2` and at least 4 tasks); other changes use Tier 2.

## Requirements

### Requirement: Contract first, independently checked once
The main session SHALL clarify the request and create the OpenSpec change. The product role SHALL write Proposal, Spec, and codebase evidence directly to the change directory and commit them. A planner SHALL draft Design, Tasks, and Acceptance as vertical behavior slices. A separate read-only reviewer SHALL review the complete package once before CP-1 and return an R0 sign-off bound to the reviewed commit, which the main session records in `review.md`, checking evidence, observable scenarios, impact, graph feasibility, scope, and Verify commands. Authors MAY revise once. CP-1 requires explicit human approval after `freeze-check` passes.

#### Scenario: Contract review catches unsupported claims
- **WHEN** the package contains unsupported code claims, unobservable scenarios, or infeasible task Verify commands
- **THEN** R0 reports evidence-backed corrections before CP-1 and authors revise the package once.

### Requirement: Tasks maximize real concurrency without semantic coupling
Tasks SHALL group behavior, wiring, affected fixtures, and tests into vertical slices. Fixture-only and wiring-only tasks are prohibited. A shared-contract task is allowed only for a genuinely shared contract with actual dependent consumers. Tasks SHALL declare dependencies, disjoint Write scopes, claimed scenarios, and scope-local narrow Verify. Full suite SHALL run only at the unique sink and final acceptance. Lead SHALL dispatch each ready non-conflicting frontier task immediately rather than wait for wave barriers.

#### Scenario: Independent tasks dispatch concurrently
- **WHEN** multiple tasks have completed dependencies, disjoint scopes, and available capacity
- **THEN** Lead dispatches them without waiting for unrelated tasks in the same wave.

#### Scenario: Overcoupled vertical slice rejected before freeze
- **WHEN** a task's connection changes make tests outside its Write scope fail and no owner task can restore the contract before dependent Verify
- **THEN** R0 requires the contract-impact and dependency/scope split to be corrected before CP-1.

### Requirement: Behavior tests are independently authored before implementation
For behavior tasks, a test role SHALL author tests from the frozen contract and base code before implementation, demonstrate expected behavior failure, and commit test paths only. The implementation role SHALL be a different agent and model, preserve tester-owned files, implement only frozen scope, and run narrow Verify. Mechanical tasks explicitly marked `Review: mechanical` MAY omit tester and task reviewer. Ambiguous or contradictory tests SHALL stop for one contract ruling rather than be silently changed by implementer.

#### Scenario: Red test precedes implementation
- **WHEN** a behavior task is dispatched
- **THEN** the test-author commit and expected behavior Red evidence exist before implementation begins.

#### Scenario: Implementation changes test-author file
- **WHEN** an implementation commit modifies a path previously committed by the test author
- **THEN** merge gate rejects the task.

### Requirement: Paseo owns orchestration; Git owns completed state
Lead SHALL use native Paseo agents, workspaces, labels, and finish notifications. Git integration commits and task `Done` lines are completed-state evidence; Paseo state describes active work. Notifications SHALL trigger reconciliation, not be treated as success. A delayed notification SHALL NOT cause duplicate dispatch without checking agent state, branch tip, and Done line. Only one active Lead and serial merge are allowed. Pipeline SHALL NOT add a second scheduler, ledger, lease, or watchdog.

#### Scenario: Delayed notification does not duplicate work
- **WHEN** a completion notification is delayed or missing
- **THEN** Lead checks Paseo state, task branch, and integration Done evidence before any replacement dispatch.

### Requirement: Merge gate enforces provenance and reviewed integration
`merge-task.mjs` SHALL remain the sole task merge and Done writer. It SHALL validate branch/task identity, dependency completion, Write scope, commit role/author trailers, tester/implementer separation and model difference, immutable tester paths, reviewer independence from implementer model, review binding to exact tip/base, integration drift, frozen Verify, and clean worktree. It SHALL abort failed merge/Verify without destructive reset. Required acceptance and final review SHALL bind to the same final SHA.

#### Scenario: Same-model tester and implementer refused
- **WHEN** tester and implementer use the same resolved Paseo model
- **THEN** merge gate refuses integration with a clear provenance error.

#### Scenario: Review is tied to submitted code
- **WHEN** review tip does not match task branch tip or an overlapping integration change invalidates its base
- **THEN** merge gate refuses integration until re-review.

### Requirement: Final review and repair close delivery loop
After all tasks are Done, full verification and Required acceptance SHALL run on one final SHA alongside one independent integrated Spec and Standards review. Confirmed blockers MAY be fixed only within approved scope; after repair, full verification and acceptance rerun, and original reviewer rechecks the fix diff once. Remaining blockers prevent delivery. CP-2 human approval is required before main merge. Worktree/branch cleanup and push require separate human approval; only clean merged work may be proposed for cleanup.

#### Scenario: Final review blocker receives bounded repair
- **WHEN** integrated review finds a confirmed blocker
- **THEN** only that blocker is fixed, final verification reruns, and original reviewer rechecks once; any remaining blocker prevents CP-2.

#### Scenario: Cleanup preserves unfinished work
- **WHEN** task work remains unmerged, dirty, or blocked
- **THEN** cleanup does not remove its workspace or branch.
