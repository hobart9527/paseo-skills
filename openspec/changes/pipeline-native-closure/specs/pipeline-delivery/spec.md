## Purpose

Pipeline delivery defines how Paseo Lead-orchestrated multi-agent work is dispatched, reconciled, integrated and recovered using native Paseo MCP delegation, OpenSpec lifecycle artifacts and Git facts, without a second scheduler or ledger and without claiming guarantees that no wake source supports.

## ADDED Requirements

### Requirement: Native delegation is the default dispatch path
Pipeline SHALL delegate through agent-scoped Paseo MCP (`create_agent`/`send_agent_prompt`) using provider, modeId, thinkingOptionId and features copied verbatim from live `list_profiles` (`featureValues` → `settings.features`; undeclared fields omitted), with `notifyOnFinish` enabled and labels `pipeline.change/task/attempt/phase/role`. CLI scripts SHALL be documented as legacy and announce that completion callback is not verified for that path; the statement SHALL be scoped to the observed CLI path/version and SHALL NOT be generalized. CLI success or a parent label SHALL NOT be treated as proof of callback delivery.

#### Scenario: SCEN-DISP-01 dispatch instructions use live profile values
- **WHEN** SKILL.md dispatch section is read
- **THEN** it names `list_profiles` notes/settings (including featureValues→settings.features) as source, requires `notifyOnFinish`, and contains no hardcoded model names.

#### Scenario: SCEN-DISP-02 legacy CLI announces unverified callback
- **WHEN** `dispatch.mjs` runs with `--dry-run`
- **THEN** output states LEGACY/callback-not-verified and includes `pipeline.task` and `pipeline.attempt` labels when supplied.

#### Scenario: SCEN-DISP-03 optional profile fields are not invented
- **WHEN** dispatching a pi profile with `modeId` and no `thinkingOptionId`, or a non-pi profile lacking `modeId`
- **THEN** argv omits `--mode` for pi and omits every undeclared field, with no default substituted; `hotfix.sh` behaves identically.

### Requirement: Reconciliation validates the task graph, runtime and agent identity
`reconcile.mjs` SHALL parse `tasks.md` via a single shared parser and classify every task into exactly one state, evaluated in order: INVALID (including ledger mismatch), DONE, ACTIVE, UNRESOLVED, MERGE_CANDIDATE, BLOCKED_DEP, BLOCKED_RESOURCE, READY. It SHALL exit non-zero on malformed task lines, duplicate IDs, unknown dependency references, cycles, or when HEAD is not `integration/<change>`. If runtime state is unavailable or unparsable, `canDispatchNow` SHALL be empty. Agents SHALL be classified by `pipeline.role` as control-plane (Lead, Watcher, spec Critic, Arbiter, Scout; no task label required, hold no write scope), task-plane read-only (Auditor) or task-plane writer (Runner, Senior, Light, Tester); a running agent with a missing/unknown role, a task-plane role lacking task/attempt/phase, or a task absent from tasks.md SHALL be UNMAPPED and SHALL empty `canDispatchNow`.

#### Scenario: SCEN-REC-01 unknown dependency rejected
- **WHEN** T-02 declares `Depends on: T-99` and T-99 does not exist
- **THEN** reconcile exits non-zero reporting INVALID unknown dependency.

#### Scenario: SCEN-REC-02 cycle rejected
- **WHEN** T-01 depends on T-02 and T-02 depends on T-01
- **THEN** reconcile exits non-zero reporting a cycle and no task is READY.

#### Scenario: SCEN-REC-03 wrong integration branch rejected
- **WHEN** HEAD is `main` or any branch other than `integration/<change>`
- **THEN** reconcile exits non-zero naming the expected branch.

#### Scenario: SCEN-REC-04 runtime unavailable fails closed
- **WHEN** `paseo ls` exits non-zero or returns unparsable output
- **THEN** output has `runtime: unavailable`, `canDispatchNow` is empty, and git/tasks-derived classification still prints.

#### Scenario: SCEN-REC-05 active or unresolved attempt is not dispatchable
- **WHEN** the latest agent for T-01 is running, or is in error / awaiting permission
- **THEN** T-01 is ACTIVE or UNRESOLVED respectively and absent from `canDispatchNow`.

#### Scenario: SCEN-REC-06 divergence is not acceptance
- **WHEN** branch `task/<c>/T-01` is ahead of integration and T-01 is unchecked
- **THEN** T-01 is MERGE_CANDIDATE, not DONE, and its dependents stay BLOCKED_DEP.

#### Scenario: SCEN-REC-07 unmapped executor fails closed
- **WHEN** a running writer-role agent labeled `pipeline.change=<c>` lacks `pipeline.task`, or names a task absent from tasks.md, or has no `pipeline.role`
- **THEN** output lists it as UNMAPPED and `canDispatchNow` is empty.

#### Scenario: SCEN-REC-08 control-plane agents do not block dispatch
- **WHEN** running agents labeled `pipeline.role=shangshu`, `yushi` or `xunjian` without `pipeline.task` coexist with READY tasks
- **THEN** no UNMAPPED is reported and READY tasks remain dispatchable within cap.

#### Scenario: SCEN-REC-09 historical idle agents are not permanently unresolved
- **WHEN** T-01 has an idle test-phase agent superseded by a later impl-phase agent, or a lower-attempt agent superseded by a higher attempt, or an idle agent labeled `pipeline.disposition=handed-off`
- **THEN** those agents are ignored; only the latest (attempt, phase) agent without disposition can make T-01 UNRESOLVED, and any still initializing/running writer remains ACTIVE regardless of age.

#### Scenario: SCEN-REC-11 disposition clears an errored latest agent
- **WHEN** the latest agent of T-01 is in error and the Lead labels it `pipeline.disposition=rejected`
- **THEN** T-01 is no longer UNRESOLVED and a new attempt may be dispatched.

#### Scenario: SCEN-REC-12 still-running older attempt blocks redispatch
- **WHEN** attempt 1 of T-01 is still running while attempt 2 is idle with disposition `abandoned`
- **THEN** T-01 is ACTIVE, holds its write scope and cap slot, and is not READY.

#### Scenario: SCEN-REC-10 latest idle agent without disposition is unresolved
- **WHEN** the latest-phase agent of an undone task is idle with no disposition label and no later-phase agent
- **THEN** the task is UNRESOLVED and not dispatchable until the Lead records a disposition.

### Requirement: DAG readiness, Done verification and resource policy
A task SHALL release dependents only when DONE, where DONE requires a checked box and a Done line `source=<tip7>` that maps to a first-parent merge commit M on the integration branch whose second parent equals that source tip and whose `Pipeline-Task` trailer includes the task; a source tip merely being an ancestor of HEAD SHALL NOT suffice. Tasks with non-overlapping Write scopes in isolated worktrees MAY run concurrently; tasks with overlapping Write scope and no dependency path SHALL be serialized by reconcile (first in file order eligible; later BLOCKED_RESOURCE naming the conflict). The held-scope set SHALL be ACTIVE ∪ UNRESOLVED ∪ MERGE_CANDIDATE. Integration SHALL always be serial. This version detects path-prefix overlap only and SHALL NOT claim semantic-conflict detection or general concurrency sufficiency. Dispatch count SHALL NOT exceed `cap` minus ACTIVE.

#### Scenario: SCEN-DAG-01 per-task release
- **WHEN** T-01 is integrated, T-02 (independent) is not, and T-03 depends only on T-01
- **THEN** T-03 is READY while T-02 is unaffected.

#### Scenario: SCEN-DAG-02 resource conflict serialized
- **WHEN** T-04 and T-05 have overlapping Write scope and no dependency
- **THEN** only T-04 is in `canDispatchNow` and T-05 is BLOCKED_RESOURCE naming T-04.

#### Scenario: SCEN-DAG-03 ancestor-only Done does not prove acceptance
- **WHEN** T-01 is checked with `source=<tip7>` that is an ancestor of HEAD but has no first-parent merge commit with that second parent and matching trailer (e.g. cherry-pick or side path)
- **THEN** T-01 is INVALID (not DONE) and dependents are not READY.

#### Scenario: SCEN-DAG-04 cap respected
- **WHEN** cap=2 with one ACTIVE and three READY non-conflicting tasks
- **THEN** `canDispatchNow` contains exactly one task.

#### Scenario: SCEN-DAG-05 paused task still holds its scope
- **WHEN** T-A is UNRESOLVED (permission-paused) and T-B has overlapping Write scope
- **THEN** T-B is BLOCKED_RESOURCE naming T-A and is not in `canDispatchNow`.

#### Scenario: SCEN-DAG-06 non-overlapping tasks run concurrently
- **WHEN** T-X and T-Y have disjoint Write scopes and no dependency, cap allows both
- **THEN** both are in `canDispatchNow`.

### Requirement: Merge is safe, exact, revision-bound and drift-aware
`merge-task.mjs` SHALL require branch, task IDs, review tag and test command (no defaults), and run only on `integration/<change>` with a clean tree. It SHALL match task IDs exactly against `tasks.md` and the branch name and reject already-Done tasks. The review tag `pass(<reviewer-id8>@<tip7>/<base7>)` SHALL have `tip7` equal to the branch tip; if `base7` differs from current HEAD and files changed in `base7..HEAD` intersect files changed by the branch, the merge SHALL be rejected for re-review, otherwise it proceeds with tests on the merged tree and drift recorded in run-log; no rebase is required. The script SHALL document that it cannot prove a review occurred, and the Lead SHALL confirm Auditor verdict PASS and reviewed SHA before invoking. The merge commit SHALL carry trailers `Pipeline-Task` and `Pipeline-Source` (full tip), and contain code merge, `tasks.md` `[x]` + `Done: source=<tip7> review=<tag>`, and run-log append in one commit. On conflict or test failure it SHALL `git merge --abort` and exit non-zero, SHALL NOT use `git reset --hard`, and SHALL NOT swallow errors.

#### Scenario: SCEN-MRG-01 success single commit with trailers
- **WHEN** a valid branch, passing tests and matching review tag are supplied
- **THEN** exactly one new first-parent commit contains code, `[x]` + Done line and run-log append, with `Pipeline-Task`/`Pipeline-Source` trailers and second parent equal to the branch tip.

#### Scenario: SCEN-MRG-02 missing test command rejected
- **WHEN** only three arguments are supplied
- **THEN** exit 1 and HEAD is unchanged.

#### Scenario: SCEN-MRG-03 stale review rejected
- **WHEN** review `tip7` differs from the branch tip
- **THEN** exit non-zero, HEAD unchanged, tree clean.

#### Scenario: SCEN-MRG-04 task id prefix not confused
- **WHEN** tasks T-1 and T-10 exist and the branch for T-1 is merged
- **THEN** only T-1 is marked and T-10 is untouched.

#### Scenario: SCEN-MRG-05 wrong branch refused
- **WHEN** HEAD is `main`
- **THEN** exit non-zero before any merge.

#### Scenario: SCEN-MRG-06 test failure aborts without reset
- **WHEN** the test command fails
- **THEN** merge is aborted, HEAD equals pre-merge, tree clean, exit 20, and merge-task source contains no `reset --hard`.

#### Scenario: SCEN-MRG-07 conflict aborts cleanly
- **WHEN** the branch conflicts with HEAD
- **THEN** exit 10, HEAD unchanged, tree clean.

#### Scenario: SCEN-MRG-08 duplicate merge rejected
- **WHEN** the task is already Done
- **THEN** exit non-zero and no new commit.

#### Scenario: SCEN-MRG-09 baseline drift with overlapping files rejected
- **WHEN** integration advanced since `base7` and the advance touched a file the branch also changed
- **THEN** exit non-zero requesting re-review and HEAD is unchanged.

#### Scenario: SCEN-MRG-10 baseline drift without overlap proceeds without rebase
- **WHEN** integration advanced since `base7` on disjoint files and tests pass
- **THEN** merge succeeds, drift is recorded in run-log, and no rebase occurred.

### Requirement: Event-driven operation, relay and permission discipline
Ordinary runs SHALL create no recurring heartbeat or schedule. Documentation SHALL state that without a verified timer or external event source a silently lost callback cannot wake an idle Lead and reconciliation runs at the next real invocation; it SHALL NOT claim a ten-minute watchdog, fixed latency, zero compaction, universal success, or exact test counts without collected evidence. Envelopes SHALL be ≤20 lines with `kind=turn-idle|phase-complete|blocked`; a Lead whose turn ends while awaiting a grandchild worker SHALL later send the final envelope to its parent via explicit `send_agent_prompt`. Notification dedupe SHALL key on agent id plus message/event id plus task, attempt, phase and revision, ignoring duplicates and stale ones. The Lead SHALL NOT call `respond_to_permission`; permission requests are reported to the human. Retry budgets SHALL be finite and workspaces of failed/Blocked tasks SHALL be retained.

#### Scenario: SCEN-EVT-01 limitation documented
- **WHEN** SKILL.md is read
- **THEN** it contains the no-spontaneous-wakeup limitation and lazy-reconcile rule and no default watchdog/heartbeat.

#### Scenario: SCEN-EVT-02 removed claims absent
- **WHEN** SKILL.md and LESSONS.md are scanned
- **THEN** none present "<100ms" as a guarantee, a "0 次" compaction pass criterion, mandatory rebase, `reset --hard` fallback, or implicit `mechanical` approval.

#### Scenario: SCEN-DOC-01 discipline sections present
- **WHEN** SKILL.md is read
- **THEN** it contains envelope format with kind, task/attempt/phase mapping, dedupe key, stale/duplicate handling, permission-pause handling, retry budget, OpenSpec CLI main-session exclusivity, workspace retention, and the grandchild→Lead→parent relay rule, each stated once without conflicting duplicates.

#### Scenario: SCEN-DOC-02 permission self-approval forbidden
- **WHEN** SKILL.md permission section is read
- **THEN** it forbids the Lead calling `respond_to_permission` and routes requests to the human.

### Requirement: Truthful verification
Regression tests SHALL be dependency-free, runnable by `skills/paseo-pipeline/test/run-all.sh`, and cover success, failure, duplicate/unresolved execution, resource conflicts and safe merge, plus the existing `contract-check.test.sh`. A passing test run SHALL be reported only as the printed pass/fail counts, never as coverage. Contract-check output SHALL describe counts as static references. Live native callback smoke evidence SHALL be recorded separately from mock-based tests and validated structurally by `test/check-evidence.mjs`; unrun scenarios SHALL be listed as UNVERIFIED.

#### Scenario: SCEN-VER-01 run-all reports real counts
- **WHEN** `bash skills/paseo-pipeline/test/run-all.sh` runs
- **THEN** it exits 0 on success and prints counts taken from runner output.

#### Scenario: SCEN-VER-02 smoke evidence structurally validated
- **WHEN** `check-evidence.mjs` runs on `evidence/native-smoke.md`
- **THEN** it passes only if parent and child agent UUIDs, notification message id, ISO timestamps, result, relay case result and an `unverified:` list are present, and fails if any is missing.

#### Scenario: SCEN-VER-03 audit evidence structurally validated
- **WHEN** `check-evidence.mjs --kind audit` runs on `evidence/final-audit.md`
- **THEN** it passes only if `verdict:` and `reviewed_sha:` fields are present.
