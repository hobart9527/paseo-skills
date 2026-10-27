# Delta: pipeline-delivery

## MODIFIED Requirements

### Requirement: Task contract errors have one severity owner
The task parser SHALL own the severity classification of every parse error, so that each consumer derives severity from one definition instead of keeping its own set. Errors that make the whole task graph untrustworthy (malformed line, duplicate ID, unknown dependency, self dependency, cycle) SHALL be graph-severity and SHALL make the entire `tasks.md` unusable. Errors that affect only the named task (missing Write scope, malformed Done line, unknown Review value, unknown risk token, review/risk conflict, unknown metadata field) SHALL be task-severity and SHALL NOT block work on other tasks. An error code with no declared severity SHALL be treated as graph-severity.

The merge entry point SHALL reject a merge only for graph-severity errors plus task-severity errors belonging to the requested tasks and their direct dependencies. The reconciliation entry point SHALL fail on graph-severity errors only.

A Done line's `review` value SHALL match the merge tag grammar (`pass(<mechanical|reviewer>@<tip7>/<base7>)`), validated by the same definition the merge entry point uses to validate the tag it writes. A Done line whose review value is any other non-empty string SHALL be a task-severity error, because such a line cannot have been produced by the merge entry point. An unrecognised metadata field name SHALL be a task-severity error rather than being silently ignored.

Content inside HTML comments SHALL NOT be parsed as task metadata, and removing such content SHALL NOT remove the surrounding line. A task line or metadata line carrying an inline comment SHALL still be parsed as a task line or metadata line, with the comment span removed and all remaining text preserved. A comment that opens on one line and closes on a later line SHALL delete only the span between the markers, preserving text before the opening marker on the first line and text after the closing marker on the last line.

A `Verify with` value SHALL have a Markdown wrapper removed before the command is handed to a shell: a pair of backticks, or a pair of single or double quotes, enclosing the entire value. Shell syntax characters SHALL NOT be treated as wrapper delimiters: a value enclosed in `(`, `[`, or `{` SHALL be passed through unchanged, because those delimiters are shell structure rather than Markdown formatting, and stripping them changes the command's meaning. Inner quote characters carrying shell meaning SHALL be preserved.

#### Scenario: SCEN-CON-01 an unrelated task error does not block a merge
- **WHEN** task T-02 is missing `Write scope` and T-01 (unrelated, no dependency on T-02) is merged
- **THEN** the merge proceeds for T-01, while a merge of T-02 itself is rejected naming the `MISSING_SCOPE` error.

#### Scenario: SCEN-CON-02 a hand-written Done line is rejected
- **WHEN** a task is checked with `Done: source=abcdef0 review=main-session`
- **THEN** parsing reports `BAD_DONE_LINE` for that task, and the same regex accepts `pass(mechanical@abcdef0/1234567)`.

#### Scenario: SCEN-CON-03 unknown fields and commented text do not change the contract
- **WHEN** a task block contains a misspelled field `Verfy with:` and a template-style HTML comment containing `- Foo: bar`
- **THEN** the misspelling is reported as `UNKNOWN_FIELD` for that task and the commented line produces no field.

#### Scenario: SCEN-CON-15 an inline comment never swallows the line it annotates
- **WHEN** a task line or a metadata line carries a trailing `<!-- ... -->` comment
- **THEN** the task still exists with its id and its metadata fields still hold their values, and no following line's metadata is absorbed by a preceding task.

#### Scenario: SCEN-CON-16 a Markdown-wrapped command is unwrapped but shell structure is not rewritten
- **WHEN** `Verify with` holds a command wrapped in backticks or quotes, and separately a command wrapped in `(`…`)`, `[`…`]`, or `{`…`}`
- **THEN** the backtick- and quote-wrapped commands are unwrapped, and the bracket-wrapped command is passed to the shell verbatim.

### Requirement: Freezing is one mechanical command backed by a project-local schema
The skill SHALL ship an OpenSpec schema whose task template is directly parseable by the production parser, and a freeze check that reuses that same parser. Installing the schema SHALL be a documented copy step that yields `paseo-pipeline` as a project schema, and each new change SHALL declare that schema so its templates are generated from it. The packaged schema and its installed copy SHALL be verified to match, so that a template change cannot reach users in one form and the repository in another.

The freeze check SHALL block on: task lines the parser rejects, zero parsed tasks, illegal write scopes, scenario ids that are referenced but not declared, declared scenario ids no task claims, scenarios without an id, a missing or unparseable acceptance matrix, missing matrix columns, matrix rows referencing unknown scenarios or tasks, a missing Entry or Verify cell, a `Required` value other than yes/no, a matrix with no `Required: yes` row, and a `Result` other than `PENDING`/`BLOCKED`/`UNVERIFIED` at freeze time. It SHALL only advise on write-scope overlap with another change.

Scenario ids the delta carries only because a `MODIFIED` block replaces a whole requirement — that is, ids the baseline spec tree already declares — SHALL NOT count against the change: they SHALL NOT be required to be claimed by a task of this change, and a task referring to one SHALL NOT be reported as referencing an undeclared scenario. An id declared neither by the change nor by the baseline SHALL still block.

For a change located under an `archive` directory the check SHALL NOT emit a freeze verdict: it SHALL report every finding as an advisory, exit successfully, and state that the change is archived. Archived changes are historical records, not plans awaiting execution, and rules introduced after a change was written SHALL NOT be applied to it retroactively as blocking findings.

The check SHALL also state the orchestrator routing implied by the frozen task set: it SHALL estimate the dispatch count as one writer per task, plus one independent auditor for every task whose review tier is not `mechanical`, plus one tester for every `strict` task, and SHALL report `lead` when that estimate reaches six and `pod` otherwise, naming the profile that must be dispatched. The routing SHALL be advisory only and SHALL NOT change the exit status.

#### Scenario: SCEN-CON-04 the freeze check blocks each defect class
- **WHEN** the freeze check runs against a change missing a task id, declaring an unclaimed scenario, or holding any other blocking defect
- **THEN** it exits non-zero naming that defect, and a clean change exits zero.

#### Scenario: SCEN-CON-05 the schema's own templates parse under the production parser
- **WHEN** the shipped `tasks.md` template is parsed by `lib/tasks.mjs`
- **THEN** the sample task parses with no errors and the acceptance template's header carries exactly the columns the freeze check and evidence gate read.

#### Scenario: SCEN-CON-17 an archived change is diagnosed, never blocked
- **WHEN** the freeze check runs against a change under `openspec/changes/archive/` whose tasks violate current syntax rules
- **THEN** every finding is printed as an advisory with no blocking verdict, and the command exits zero.

#### Scenario: SCEN-CON-18 packaged and installed schema copies cannot drift
- **WHEN** a file under the packaged schema differs from its installed counterpart, is missing from either side, or the installed copy is absent
- **THEN** the regression suite fails naming the drifting file.

#### Scenario: SCEN-CON-25 a MODIFIED block does not turn inherited scenarios into this change's debt
- **WHEN** a change's delta copies baseline scenarios back into a `MODIFIED` requirement, and its tasks do not claim them
- **THEN** the check passes with `--baseline` naming that spec tree, and blocks without it, while a scenario id declared nowhere is blocked either way.

#### Scenario: SCEN-CON-26 the freeze check names the orchestrator routing
- **WHEN** the freeze check runs against a frozen task set whose tiers imply three dispatches, and against one whose tiers imply nine
- **THEN** the first reports `pod`, the second reports `lead` naming `agent_profile_shangshu`, the same routing appears in `--json` output, and neither verdict changes the exit status.

### Requirement: Evidence has one field contract, one template set and matrix-driven acceptance
The required evidence field set SHALL be exported by a single module that the structure gate, the evidence templates and the documentation tests all consume, so that a field cannot be required by the gate while absent from the templates.

Placeholder and not-collected judgements SHALL apply only to fields the gate owns: the contract fields and command-shaped fields (names ending in `command`/`cmd`, judged whole-value). Free text in fields the gate does not read SHALL NOT determine whether a receipt is rejected. The literal value `未采集` SHALL remain legal for structural archiving but SHALL NOT satisfy the acceptance gate for any field the gate treats as captured.

The acceptance gate SHALL accept required scenario ids from a frozen acceptance matrix (`--matrix`), taking every row whose `Required` is `yes`, and SHALL reject when any such row's result is not `PASS`. Caller-supplied `--require-scenario` ids SHALL only add to that set. Acceptance SHALL additionally require that the receipt's child agent id resolves to a real persisted agent record and that `dispatched_at`/`notification_at` are not earlier than that agent's real creation time; an explicit skip of the lookup SHALL itself be reported as a problem.

The contract check SHALL distinguish "no test produced yet" from "tests produced but the change is being closed out": in close-out mode, a declared test path that produced nothing SHALL fail rather than skip. Declared scenarios SHALL be able to include those declared by a baseline spec tree, because a delta declares only what the change adds while the test corpus spans the whole skill. Scenarios a change inherits from the baseline SHALL NOT be counted as that change's own untested obligation. The number of scenarios referenced by tests but declared nowhere SHALL be comparable against an explicit allowance, so that pre-existing debt is recorded as a budget rather than asserted as zero: exceeding the allowance SHALL fail, and remaining within it SHALL pass. A value compared with `typeof` SHALL NOT be treated as an asserted error message, because the type name on the right of `typeof` describes an assertion form rather than an error contract.

A scenario id carried by a shell test suite SHALL be recognised the same way as one carried by a Node test file, since a bash case table is a test corpus too. Content inside a shell heredoc fixture SHALL NOT be read as a scenario reference: a scenario spelled inside constructed input is data, not a claim that anything is verified. A scenario id written in a comment line SHALL count as a reference, in both languages, because that is where test files record which scenario a case covers.

A file named by a task's write scope SHALL only be treated as test corpus when its name marks it as a test; when no scope entry is test-shaped, the whole scope SHALL be used instead, so that "declared test produced nothing" remains a judgement rather than a usage error.

#### Scenario: SCEN-CON-06 template fields and gate fields cannot drift
- **WHEN** the evidence contract's required field set is compared with the shipped smoke and audit templates
- **THEN** every required field appears in its template and every top-level template field is part of the contract.

#### Scenario: SCEN-CON-07 placeholder judgement follows field ownership
- **WHEN** an evidence file's `notes:` prose contains a common placeholder word while a contract field holds a real value
- **THEN** the structure gate accepts the file, and the same word inside a contract field is still rejected.

#### Scenario: SCEN-CON-08 required scenarios come from the frozen matrix
- **WHEN** the acceptance gate runs with `--matrix` against a matrix whose required row is missing from the evidence
- **THEN** the gate rejects, and adding that id via `--require-scenario` cannot remove any matrix-derived requirement.

#### Scenario: SCEN-CON-19 a delta-scoped close-out can include the baseline
- **WHEN** a change's spec delta declares its own scenarios and the tests also reference scenarios declared only by the baseline spec tree
- **THEN** the run passes with the baseline merged in, and fails without it, naming the baseline scenarios as phantom.

#### Scenario: SCEN-CON-20 pre-existing phantom debt is a budget, not a zero-assertion
- **WHEN** the tests reference scenario ids declared nowhere and the count exceeds, equals, or is below the stated allowance
- **THEN** the run fails above the allowance and passes at or below it.

#### Scenario: SCEN-CON-21 a type probe is not an error message
- **WHEN** a test asserts `typeof err.message` equals a type name
- **THEN** the type name is not reported as an error message the spec fails to declare.

#### Scenario: SCEN-CON-24 a shell case table is a test corpus
- **WHEN** a scenario id is carried by a bash test suite's comment line, and the same suite's heredoc fixtures spell other scenario ids
- **THEN** the commented id counts as referenced while the fixture ids do not, so the suite neither hides a covered scenario nor invents phantom ones.

### Requirement: Run ledger refuses to erase receipts and reports only collected facts
The run ledger SHALL refuse to void an intent that already carries a real agent receipt, since voiding means "this dispatch did not happen" while a receipt proves it did and names an agent; recovering from a lost agent SHALL use a new attempt key instead.

The ledger SHALL provide a report command whose every number is derived from facts already recorded in the ledger. Metrics the ledger does not record — audit conclusions, state transition times — SHALL NOT occupy report fields as constant placeholders; the report SHALL state, in words, which metrics it does not cover. The report SHALL distinguish an absent ledger from a ledger with zero activity.

The ledger SHALL record the orchestrating skill's git identity when a lease is acquired. A later mismatch between the recorded identity and the current one SHALL warn and SHALL NOT block reading or acting on the ledger; a ledger without the field SHALL be reported as not collected. A failure to capture the identity at acquisition time SHALL be reported immediately and SHALL NOT block acquisition, because a recorded absence and an uncaptured value are indistinguishable once written.

#### Scenario: SCEN-CON-09 a receipted intent cannot be voided
- **WHEN** `fail` is issued for an intent that was already recorded with an agent id
- **THEN** the command exits non-zero, the intent keeps its receipt, and a claim on a new attempt key succeeds.

#### Scenario: SCEN-CON-10 report separates measured from uncollected
- **WHEN** the report runs on a ledger holding two dispatches and on a missing ledger
- **THEN** the first reports counts derived from recorded intents while stating that first-pass review outcome and ready wait are not collected, and the second reports the ledger as absent instead of zero-valued metrics.

#### Scenario: SCEN-CON-11 skill version drift warns without blocking
- **WHEN** a ledger records a skill HEAD different from the current one, or records none at all
- **THEN** status prints a drift warning in the first case and a not-collected line in the second, and both remain readable.

#### Scenario: SCEN-CON-22 uncollected metrics are named, not faked as fields
- **WHEN** the report runs against a ledger that records dispatches but no audit conclusions or transition times
- **THEN** no field carries a constant not-collected value, and the report states in words which metrics it does not cover.

#### Scenario: SCEN-CON-23 an uncapturable skill identity is announced at acquisition
- **WHEN** the skill's git identity cannot be read while a lease is being acquired
- **THEN** the acquisition succeeds and a warning states that the identity was not captured.
