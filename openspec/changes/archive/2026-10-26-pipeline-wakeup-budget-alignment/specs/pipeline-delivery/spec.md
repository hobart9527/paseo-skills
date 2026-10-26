## MODIFIED Requirements

### Requirement: Event-driven operation, relay and permission discipline

Ordinary runs SHALL create no recurring heartbeat or schedule. Documentation SHALL state that without a verified timer or external event source a silently lost callback cannot wake an idle Lead and reconciliation runs at the next real invocation; it SHALL NOT claim a ten-minute watchdog, fixed latency, zero compaction, universal success, or exact test counts without collected evidence. Envelopes SHALL be ≤20 lines with `kind=turn-idle|phase-complete|blocked`.

A Lead awaiting a grandchild worker SHALL NOT let its turn end: it SHALL block in `paseo wait <id> --timeout <seconds>` and act on the returned `status`, because `notifyOnFinish` is consumed single-level and the observed failure mode is an idle Lead that a completed child cannot wake. The parent session SHALL NOT be the target of a `send_agent_prompt` relay: the main session is not a Paseo agent, so that path is structurally undeliverable. The main session SHALL instead read the Lead's final envelope after its own blocking `paseo wait` on the Lead's id. Documentation SHALL forbid designing the relay path and SHALL state why.

Notification dedupe SHALL key on agent id plus message/event id plus task, attempt, phase and revision, ignoring duplicates and stale ones. The Lead SHALL NOT call `respond_to_permission`; permission requests are reported to the human.

Retry budgets SHALL be finite and workspaces of failed/Blocked tasks SHALL be retained. The budget SHALL be countable and its escalation target machine-readable: the first `MAX_REJECTIONS` retry-consuming dispositions (rejected/abandoned) SHALL re-dispatch the task under its normal role, the next one SHALL re-dispatch it escalated to the escalation role, and any further retry-consuming disposition SHALL block the task for human arbitration. Reconciliation SHALL expose the escalation target on the task it is about to dispatch, so that a documented escalation is executable rather than advisory.

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
