# pipeline-delivery Specification

## Purpose
Pipeline delivery defines how Paseo Lead-orchestrated multi-agent work is dispatched, reconciled, integrated and recovered using native Paseo MCP delegation, OpenSpec lifecycle artifacts and Git facts, without a second scheduler or ledger and without claiming guarantees that no wake source supports.
## Requirements
### Requirement: Native delegation is the default dispatch path
Pipeline SHALL delegate through agent-scoped Paseo MCP (`create_agent`/`send_agent_prompt`) using provider, modeId, thinkingOptionId and features copied verbatim from live `list_profiles` (`featureValues` → `settings.features`; undeclared fields omitted), with `notifyOnFinish` enabled and labels `pipeline.change/task/attempt/phase/role`. The only CLI dispatch entry SHALL be `hotfix.sh`, and it SHALL be documented as legacy and announce that completion callback is not verified for that path; the statement SHALL be scoped to the observed CLI path/version and SHALL NOT be generalized. CLI success or a parent label SHALL NOT be treated as proof of callback delivery.

#### Scenario: SCEN-DISP-01 dispatch instructions use live profile values
- **WHEN** SKILL.md dispatch section is read
- **THEN** it names `list_profiles` notes/settings (including featureValues→settings.features) as source, requires `notifyOnFinish`, and contains no hardcoded model names.

#### Scenario: SCEN-DISP-02 legacy CLI announces unverified callback
- **WHEN** `hotfix.sh` runs against a fixture profile
- **THEN** its combined output states LEGACY/callback-not-verified, and its `paseo run` argv carries all five `pipeline.*` labels.

#### Scenario: SCEN-DISP-03 optional profile fields are not invented
- **WHEN** dispatching a pi profile with `modeId` and no `thinkingOptionId`, or a non-pi profile lacking `modeId`
- **THEN** argv omits `--mode` for pi and omits every undeclared field, with no default substituted.

#### Scenario: SCEN-DISP-04 no second CLI dispatch entry exists
- **WHEN** the skill directory and SKILL.md are inspected
- **THEN** no `dispatch.mjs` exists, the documentation names `hotfix.sh` as the only legacy CLI entry, and states why the unused second entry was removed.

### Requirement: Reconciliation validates the task graph, runtime and agent identity
`reconcile.mjs` SHALL parse `tasks.md` via a single shared parser and classify every task into exactly one state, evaluated in order: INVALID (including ledger mismatch), DONE, ACTIVE, UNRESOLVED, MERGE_CANDIDATE, BLOCKED_DEP, BLOCKED_RESOURCE, READY. It SHALL exit non-zero on malformed task lines, duplicate IDs, unknown dependency references, cycles, or when HEAD is not `integration/<change>`. If runtime state is unavailable or unparsable, `canDispatchNow` SHALL be empty. Agents SHALL be classified by `pipeline.role` as control-plane (Lead, Watcher, spec Critic, Arbiter, Scout; no task label required, hold no write scope), task-plane read-only (Auditor) or task-plane writer (Runner, Senior, Light, Tester); a running agent with a missing/unknown role, a task-plane role lacking task/attempt/phase, or a task absent from tasks.md SHALL be UNMAPPED and SHALL empty `canDispatchNow`.

`Write scope` SHALL be a repository-root-relative path that does not escape the root after normalization. Invalid scopes SHALL classify the task INVALID before every other task state. Runtime occupancy SHALL be accounted independently of classification: initializing/running writers on INVALID tasks SHALL still consume cap slots and conservatively hold unknown scope, and SHALL empty `canDispatchNow`. This clarification retains the existing a4 normalization rules and adds no DEL/C1 prohibition.

#### Scenario: SCEN-REC-13 scope validation precedes task state classification
- **WHEN** a task has `Write scope: ../outside`, regardless of whether it has Done evidence, a live writer, an unresolved terminal agent, an ahead branch or unmet dependencies
- **THEN** it is INVALID rather than DONE, ACTIVE, UNRESOLVED, MERGE_CANDIDATE or BLOCKED_DEP, and cannot release dependents.

#### Scenario: SCEN-REC-14 invalid task retains live writer occupancy
- **WHEN** an INVALID-scope task has an initializing/running writer and another unrelated task is otherwise READY
- **THEN** that writer still consumes a cap slot, its unknown scope is conservatively held, and `canDispatchNow` is empty.

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

Ordinary runs SHALL create no recurring heartbeat or schedule, and the run-ledger SHALL NOT expose a heartbeat registration command. Documentation SHALL state that without a verified timer or external event source a silently lost callback cannot wake an idle Lead and reconciliation runs at the next real invocation; it SHALL NOT claim a ten-minute watchdog, fixed latency, zero compaction, universal success, or exact test counts without collected evidence. Envelopes SHALL be ≤20 lines with `kind=turn-idle|phase-complete|blocked`.

A Lead awaiting a grandchild worker SHALL NOT let its turn end: it SHALL block in `paseo wait <id> --timeout <seconds>` and act on the returned `status`, because `notifyOnFinish` is consumed single-level and the observed failure mode is an idle Lead that a completed child cannot wake. The parent session SHALL NOT be the target of a `send_agent_prompt` relay: the main session is not a Paseo agent, so that path is structurally undeliverable. The main session SHALL instead read the Lead's final envelope after its own blocking `paseo wait` on the Lead's id. Documentation SHALL forbid designing the relay path and SHALL state why.

Notification dedupe SHALL key on agent id plus message/event id plus task, attempt, phase and revision, ignoring duplicates and stale ones. The Lead SHALL NOT call `respond_to_permission`; permission requests are reported to the human.

Retry budgets SHALL be finite and workspaces of failed/Blocked tasks SHALL be retained. The budget SHALL be countable and its escalation target machine-readable: the first `MAX_REJECTIONS` retry-consuming dispositions (rejected/abandoned) SHALL re-dispatch the task under its normal role, the next one SHALL re-dispatch it escalated to the escalation role, and any further retry-consuming disposition SHALL block the task for human arbitration. Reconciliation SHALL expose the escalation target on the task it is about to dispatch, so that a documented escalation is executable rather than advisory.

The Lead brief SHALL require the divergence facts (fast-forward possibility, ahead/behind counts, conflict prediction) at spec freeze and again before the human merge confirmation, so that a diverged integration branch is discovered before the last step rather than at it.

#### Scenario: SCEN-EVT-01 limitation documented
- **WHEN** SKILL.md is read
- **THEN** it contains the no-spontaneous-wakeup limitation and lazy-reconcile rule and no default watchdog/heartbeat.

#### Scenario: SCEN-EVT-02 removed claims absent
- **WHEN** SKILL.md and LESSONS.md are scanned
- **THEN** none present "<100ms" as a guarantee, a "0 次" compaction pass criterion, mandatory rebase, `reset --hard` fallback, or implicit `mechanical` approval.

#### Scenario: SCEN-DOC-01 discipline sections present
- **WHEN** SKILL.md is read
- **THEN** it contains envelope format with kind, task/attempt/phase mapping, dedupe key, stale/duplicate handling, permission-pause handling, retry budget, OpenSpec CLI main-session exclusivity and workspace retention, each stated once without conflicting duplicates, and it does not require a grandchild→Lead→parent `send_agent_prompt` relay.

#### Scenario: SCEN-DOC-02 permission self-approval forbidden
- **WHEN** SKILL.md permission section is read
- **THEN** it forbids the Lead calling `respond_to_permission` and routes requests to the human.

#### Scenario: SCEN-EVT-03 wake path is blocking wait, not a relay
- **WHEN** SKILL.md and `templates/lead.md` are read
- **THEN** they instruct the Lead to block in `paseo wait` for the child id, state that the main session waits on the Lead rather than the Lead pushing to the main session, and name the main session as not being a Paseo agent.

#### Scenario: SCEN-BUD-01 escalation target is machine-readable
- **WHEN** a task has accumulated exactly `MAX_REJECTIONS` rejection-consuming dispositions and is inside `canDispatchNow`
- **THEN** its entry in the reconciliation output carries the escalation flag and target role, the dispatch action names it in a separate escalation list, and the machine-readable task list keeps its existing shape.

#### Scenario: SCEN-BUD-02 below threshold carries no escalation
- **WHEN** a task has fewer than `MAX_REJECTIONS` rejection-consuming dispositions
- **THEN** its reconciliation entry carries no escalation fields and the dispatch action carries no escalation list.

#### Scenario: SCEN-BUD-03 exhausted budget blocks for the human
- **WHEN** a task accumulates more than `MAX_REJECTIONS` plus one escalation attempt of rejection-consuming dispositions
- **THEN** the task is BLOCKED with a budget-exhausted reason and is absent from `canDispatchNow`.

#### Scenario: SCEN-EVT-04 no heartbeat registration entry
- **WHEN** the run-ledger CLI is invoked with a `heartbeat` command, or SKILL.md's ledger section is read
- **THEN** the command is rejected as an unknown command and the documentation states that the registration entry was removed and that legacy `heartbeats` arrays remain readable but unwritable.

#### Scenario: SCEN-EVT-05 divergence checked before the merge confirmation
- **WHEN** `templates/lead.md` is read
- **THEN** it requires the fast-forward check, the left-right ahead/behind counts and a merge-tree conflict prediction both at spec freeze and before the human merge confirmation.

### Requirement: Truthful verification
Regression tests SHALL be dependency-free, runnable by `skills/paseo-pipeline/test/run-all.sh`, and cover success, failure, duplicate/unresolved execution, resource conflicts and safe merge, plus the existing `contract-check.test.sh`. A passing test run SHALL be reported only as the printed pass/fail counts, never as coverage.

Checks SHALL be tiered by what they protect rather than by whether they can be coded. Checks that protect git history and merge correctness — write scope, dependency completion, fixed tip, independent review, merge lock — SHALL exit non-zero. Checks that judge text semantics — error-message extraction, placeholder words, dialect shape — SHALL report findings and SHALL NOT fail the run on a heuristic hit. Contract-check SHALL report its message channel as not applicable, not as failure, when the spec declares no `Error("…")` literal while tests assert error codes or fields; its scenario channel SHALL keep reconciling in both directions. Live native callback smoke evidence SHALL be recorded separately from mock-based tests and validated structurally by `test/check-evidence.mjs`; unrun scenarios SHALL be listed as UNVERIFIED.

Spec authoring SHALL obey five rules checked by the auditor at freeze, not by a script: verification commands SHALL run in a clean worktree without depending on ignored files; each task's write scope SHALL cover every file its verification reads and every file implementing its scenarios; each scenario SHALL map to a test file or to a written static check; delta scenarios SHALL be compared against the baseline for the same input before freezing; and matrix/scenario/test counts SHALL be quoted from command output.

#### Scenario: SCEN-VER-01 run-all reports real counts
- **WHEN** `bash skills/paseo-pipeline/test/run-all.sh` runs
- **THEN** it exits 0 on success and prints counts taken from runner output.

#### Scenario: SCEN-VER-02 smoke evidence structurally validated
- **WHEN** `check-evidence.mjs` runs on `evidence/native-smoke.md`
- **THEN** it passes only if parent and child agent UUIDs, notification message id, ISO timestamps, result, relay case result and an `unverified:` list are present, and fails if any is missing.

#### Scenario: SCEN-VER-03 audit evidence structurally validated
- **WHEN** `check-evidence.mjs --kind audit` runs on `evidence/final-audit.md`
- **THEN** it passes only if `verdict:` and `reviewed_sha:` fields are present.

#### Scenario: SCEN-VER-04 command fields are judged whole-value
- **WHEN** an evidence field whose name ends in `command` holds a real shell command containing `test`, `sample`, `example` or `todo` as part of a command name or path
- **THEN** the placeholder check does not reject it, while a command field whose whole value is a placeholder token is still rejected.

#### Scenario: SCEN-VER-05 dialect mismatch is not a contract failure
- **WHEN** the spec mentions errors but declares no `Error("…")` literal, and the tests assert error codes or discriminants
- **THEN** contract-check prints that the message channel is not applicable, exits zero when the scenario channel passes, and does not print per-item "declared by test but not in spec" lines.

#### Scenario: SCEN-VER-06 predicate assertions stay out of the message channel
- **WHEN** `assert.throws`/`assert.rejects` receives a predicate callback or a helper call as its second argument
- **THEN** the string literals inside that window are not counted as asserted error messages, while object, string, regex and constructor spec forms keep counting.

#### Scenario: SCEN-VER-07 stub values and constructor inputs are not contracts
- **WHEN** a test file returns a stub object carrying a `message:` field, or constructs an error whose first argument is the asserted input
- **THEN** neither value is counted as an asserted error message outside an assertion window.

#### Scenario: SCEN-VER-08 spec authoring rules are documented and assigned
- **WHEN** SKILL.md's freeze section is read
- **THEN** it states the five spec authoring rules, states that they are checked by the auditor rather than a script, and `templates/lead.md` requires brief facts to come from command output.

### Requirement: Task contract errors have one severity owner
The task parser SHALL own the severity classification of every parse error, so that each consumer derives severity from one definition instead of keeping its own set. Errors that make the whole task graph untrustworthy (malformed line, duplicate ID, unknown dependency, self dependency, cycle) SHALL be graph-severity and SHALL make the entire `tasks.md` unusable. Errors that affect only the named task (missing Write scope, malformed Done line, unknown Review value, unknown risk token, review/risk conflict, unknown metadata field) SHALL be task-severity and SHALL NOT block work on other tasks. An error code with no declared severity SHALL be treated as graph-severity.

The merge entry point SHALL reject a merge only for graph-severity errors plus task-severity errors belonging to the requested tasks and their direct dependencies. The reconciliation entry point SHALL fail on graph-severity errors only.

A Done line's `review` value SHALL match the merge tag grammar (`pass(<mechanical|reviewer>@<tip7>/<base7>)`), validated by the same definition the merge entry point uses to validate the tag it writes. A Done line whose review value is any other non-empty string SHALL be a task-severity error, because such a line cannot have been produced by the merge entry point. An unrecognised metadata field name SHALL be a task-severity error rather than being silently ignored. Content inside HTML comments SHALL NOT be parsed as task metadata.

#### Scenario: SCEN-CON-01 an unrelated task error does not block a merge
- **WHEN** task T-02 is missing `Write scope` and T-01 (unrelated, no dependency on T-02) is merged
- **THEN** the merge proceeds for T-01, while a merge of T-02 itself is rejected naming the `MISSING_SCOPE` error.

#### Scenario: SCEN-CON-02 a hand-written Done line is rejected
- **WHEN** a task is checked with `Done: source=abcdef0 review=main-session`
- **THEN** parsing reports `BAD_DONE_LINE` for that task, and the same regex accepts `pass(mechanical@abcdef0/1234567)`.

#### Scenario: SCEN-CON-03 unknown fields and commented text do not change the contract
- **WHEN** a task block contains a misspelled field `Verfy with:` and a template-style HTML comment containing `- Foo: bar`
- **THEN** the misspelling is reported as `UNKNOWN_FIELD` for that task and the commented line produces no field.

### Requirement: Freezing is one mechanical command backed by a project-local schema
The skill SHALL ship an OpenSpec schema whose task template is directly parseable by the production parser, and a freeze check that reuses that same parser. Installing the schema SHALL be a documented copy step that yields `paseo-pipeline` as a project schema, and each new change SHALL declare that schema so its templates are generated from it.

The freeze check SHALL block on: task lines the parser rejects, zero parsed tasks, illegal write scopes, scenario ids that are referenced but not declared, declared scenario ids no task claims, scenarios without an id, a missing or unparseable acceptance matrix, missing matrix columns, matrix rows referencing unknown scenarios or tasks, a missing Entry or Verify cell, a `Required` value other than yes/no, a matrix with no `Required: yes` row, and a `Result` other than `PENDING`/`BLOCKED`/`UNVERIFIED` at freeze time. It SHALL only advise on write-scope overlap with another change.

#### Scenario: SCEN-CON-04 the freeze check blocks each defect class
- **WHEN** the freeze check runs against a change missing a task id, declaring an unclaimed scenario, or holding any other blocking defect
- **THEN** it exits non-zero naming that defect, and a clean change exits zero.

#### Scenario: SCEN-CON-05 the schema's own templates parse under the production parser
- **WHEN** the shipped `tasks.md` template is parsed by `lib/tasks.mjs`
- **THEN** the sample task parses with no errors and the acceptance template's header carries exactly the columns the freeze check and evidence gate read.

### Requirement: Evidence has one field contract, one template set and matrix-driven acceptance
The required evidence field set SHALL be exported by a single module that the structure gate, the evidence templates and the documentation tests all consume, so that a field cannot be required by the gate while absent from the templates.

Placeholder and not-collected judgements SHALL apply only to fields the gate owns: the contract fields and command-shaped fields (names ending in `command`/`cmd`, judged whole-value). Free text in fields the gate does not read SHALL NOT determine whether a receipt is rejected. The literal value `未采集` SHALL remain legal for structural archiving but SHALL NOT satisfy the acceptance gate for any field the gate treats as captured.

The acceptance gate SHALL accept required scenario ids from a frozen acceptance matrix (`--matrix`), taking every row whose `Required` is `yes`, and SHALL reject when any such row's result is not `PASS`. Caller-supplied `--require-scenario` ids SHALL only add to that set. Acceptance SHALL additionally require that the receipt's child agent id resolves to a real persisted agent record and that `dispatched_at`/`notification_at` are not earlier than that agent's real creation time; an explicit skip of the lookup SHALL itself be reported as a problem.

#### Scenario: SCEN-CON-06 template fields and gate fields cannot drift
- **WHEN** the evidence contract's required field set is compared with the shipped smoke and audit templates
- **THEN** every required field appears in its template and every top-level template field is part of the contract.

#### Scenario: SCEN-CON-07 placeholder judgement follows field ownership
- **WHEN** an evidence file's `notes:` prose contains a common placeholder word while a contract field holds a real value
- **THEN** the structure gate accepts the file, and the same word inside a contract field is still rejected.

#### Scenario: SCEN-CON-08 required scenarios come from the frozen matrix
- **WHEN** the acceptance gate runs with `--matrix` against a matrix whose required row is missing from the evidence
- **THEN** the gate rejects, and adding that id via `--require-scenario` cannot remove any matrix-derived requirement.

### Requirement: Run ledger refuses to erase receipts and reports only collected facts
The run ledger SHALL refuse to void an intent that already carries a real agent receipt, since voiding means "this dispatch did not happen" while a receipt proves it did and names an agent; recovering from a lost agent SHALL use a new attempt key instead.

The ledger SHALL provide a report command whose every number is derived from facts already recorded in the ledger. Metrics that the ledger does not record — audit conclusions, state transition times — SHALL be reported as not collected rather than estimated. The report SHALL distinguish an absent ledger from a ledger with zero activity.

A dispatch count SHALL count only intents that carry a real agent receipt, and every dispatch count in the report SHALL use that same definition. An intent that was never dispatched — one that is still open, or one explicitly voided because its creation failed — SHALL NOT be counted as a dispatch, regardless of its phase or role. Voided intents SHALL be reported by their own count and SHALL NOT be folded into any dispatch count, so that the number of audits actually performed stays distinguishable from the number of audit intents that were attempted.

The ledger SHALL record the orchestrating skill's git identity when a lease is acquired. A later mismatch between the recorded identity and the current one SHALL warn and SHALL NOT block reading or acting on the ledger; a ledger without the field SHALL be reported as not collected.

#### Scenario: SCEN-CON-09 a receipted intent cannot be voided
- **WHEN** `fail` is issued for an intent that was already recorded with an agent id
- **THEN** the command exits non-zero, the intent keeps its receipt, and a claim on a new attempt key succeeds.

#### Scenario: SCEN-CON-10 report separates measured from uncollected
- **WHEN** the report runs on a ledger holding two dispatches and on a missing ledger
- **THEN** the first reports counts derived from recorded intents while stating that first-pass review outcome and ready wait are not collected, and the second reports the ledger as absent instead of zero-valued metrics.

#### Scenario: SCEN-CON-11 skill version drift warns without blocking
- **WHEN** a ledger records a skill HEAD different from the current one, or records none at all
- **THEN** status prints a drift warning in the first case and a not-collected line in the second, and both remain readable.

#### Scenario: SCEN-CON-27 a voided audit intent is not counted as an audit dispatch
- **WHEN** an audit intent is claimed and then explicitly voided because its agent creation failed, alongside one writer dispatch that carries a real receipt
- **THEN** the report counts one dispatch and zero audit dispatches, reports the voided intent under the voided count, and the writer dispatch is still counted as dispatched.

### Requirement: Documentation states the same contract the code enforces
The skill documentation SHALL present the run-ledger commands in a form that can be executed as written, including the owner argument required while a lease is active, and SHALL state the consequence of omitting it. Every run-ledger subcommand named in the documentation SHALL exist in the script. Role names used for dispatch SHALL come from the live profile source; the historical role `qingqibing` SHALL remain recognisable for reading existing agent labels and SHALL NOT appear as a dispatchable role. Documentation SHALL NOT describe a wake mechanism, an evidence field set, or a review-tag form that the code does not implement.

#### Scenario: SCEN-CON-12 documented commands run against the script
- **WHEN** the run-ledger command block in the documentation is compared with the script
- **THEN** every claim/record/fail example carries `--owner`, every referenced subcommand has a matching implementation, and the omission consequence is stated.

#### Scenario: SCEN-CON-13 the hotfix path resolves its profile fail-closed
- **WHEN** `hotfix.sh` runs with a profile config lacking the writer profile it requires
- **THEN** it exits non-zero instead of dispatching with an empty provider, and it does not consult the historical role profile as a dispatch source.

### Requirement: A Pod merges as one batch, so its internal dependencies are satisfied by that merge
The skill's Pod mode SHALL merge a `pod/<change>` branch exactly once, covering the whole frozen member set. Because that single merge is the only event that can prove its members Done, the merge entry point SHALL treat a dependency between two tasks of the same requested batch as satisfied by the batch itself, rather than requiring it to be already proven Done by a first-parent merge.

The exemption SHALL be limited to the requested batch: a dependency whose task is not in the requested set SHALL still be rejected unless a first-parent merge already proves it Done, so that any two tasks cannot bypass the dependency gate merely by being requested together. A single-task merge SHALL therefore behave exactly as before.

The freeze check SHALL report whether a frozen member set's dependency closure lies entirely inside the member set, because that is what decides whether one merge can satisfy it. Dependency cycles SHALL remain graph-severity errors, rejected at parse time before any batch exemption is considered.

#### Scenario: SCEN-CON-14 a pod batch satisfies its own dependencies but not outside ones
- **WHEN** a Pod merge is requested for a member set whose tasks depend on each other, and separately for a set whose task depends on a task outside the set that no merge has proven Done
- **THEN** the first merge is accepted and marks every member, and the second is rejected naming the outside dependency; a single-task merge of a dependent task whose dependency is unproven is still rejected, and the freeze check states which of the two cases the frozen member set is in.

