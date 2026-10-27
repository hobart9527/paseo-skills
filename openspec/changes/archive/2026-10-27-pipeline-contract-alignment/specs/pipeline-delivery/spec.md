## ADDED Requirements

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
