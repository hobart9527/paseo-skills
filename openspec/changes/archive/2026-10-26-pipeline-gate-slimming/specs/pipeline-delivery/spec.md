## MODIFIED Requirements

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
