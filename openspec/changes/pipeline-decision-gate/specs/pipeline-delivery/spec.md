## ADDED Requirements

### Requirement: Undecided hard decisions stop the contract early
A `## OPEN-DECISION` entry in `proposal.md` SHALL carry `Class: money | auth | external-write | product` and either `Status: open` or `Decided: <user words and date>`; an entry without `Class:` counts as hard. `freeze-check` SHALL report blocking code `UNDECIDED_HARD_DECISION` and route `null` when an open hard-class entry (money, auth, external-write) is referenced by its id from a spec scenario or a `tasks.md` task. An open hard entry nobody references, and any open `product` entry, SHALL produce an advisory only. The author brief and the proposal template SHALL give one rule: on an open hard decision the author commits current state and returns `BLOCKED (decision)` instead of writing a default into specs or tasks. Fact: `skills/paseo-pipeline/freeze-check.mjs:916` computes route from task count and width only; `openspec-schema/templates/proposal.md:42` says "Continue on the recommended default" while `templates/author.md:25` says "continue only on an authorized safe default".

#### Scenario: Referenced open money decision blocks route
- **WHEN** `proposal.md` has `OD-1` with `Class: money` and `Status: open`, and a task or scenario names `OD-1`
- **THEN** `freeze-check --structural --json` exits 1 with a blocking item starting `UNDECIDED_HARD_DECISION` and `route` is `null`
- **Verify:** `node --test skills/paseo-pipeline/test/freeze-check.test.mjs`

#### Scenario: Decided or unreferenced decisions do not block
- **WHEN** the same entry carries `Decided:`, or no task or scenario names it, or its class is `product`
- **THEN** no `UNDECIDED_HARD_DECISION` block is reported and the route is computed as before; the unreferenced open hard and open product cases appear in `advisories`
- **Verify:** `node --test skills/paseo-pipeline/test/freeze-check.test.mjs`

#### Scenario: Author and proposal template agree
- **WHEN** `templates/author.md`, `openspec-schema/templates/proposal.md` and `openspec-schema/schema.yaml` are read
- **THEN** none tells the author to continue on a recommended default for an open hard decision, and the author brief names `BLOCKED (decision)`
- **Verify:** `node --test skills/paseo-pipeline/test/pipeline-friction-docs.test.mjs`

### Requirement: Scenarios carry Verify in both routes
The pipeline spec template and schema instruction SHALL require one `**Verify:**` line per scenario, the same form `docs/tier2-contract.md:18` requires, so a change routed `handoff` needs no Verify rewrite. When the author's structural route is `handoff` and `acceptance.md` exists, the author brief SHALL require it to be marked historical, superseded by the Tier 2 Evidence recheck. Fact: D10 needed main-session commit `fc8f7974` only to add Verify lines.

#### Scenario: Templates require scenario Verify and historical acceptance on handoff
- **WHEN** `openspec-schema/templates/spec.md`, `openspec-schema/schema.yaml` and `templates/author.md` are read
- **THEN** the spec template shows a `**Verify:**` line under each scenario, the schema specs instruction requires it, and the author brief's handoff step marks an existing `acceptance.md` historical
- **Verify:** `node --test skills/paseo-pipeline/test/pipeline-friction-docs.test.mjs`

### Requirement: Red evidence and backstop timing are replayable
`docs/tier2-handoff-brief.md` SHALL require a slice that adds behaviour tests to commit those tests first (test files only, failing on the base) and the implementation in a second commit, and the Evidence recheck SHALL rerun the Red command at the test commit. `SKILL.md` SHALL state that a dispatch heartbeat uses an absolute one-shot cron computed from dispatch time plus the backstop window, with explicit `timezone` and `maxRuns: 1`, never a step cron like `*/30`. Fact: D10 brief demanded one implementation commit, so Red could not be replayed; heartbeat `*/30` fired at the next half hour.

#### Scenario: Brief and SKILL state replayable Red and one-shot heartbeat
- **WHEN** `docs/tier2-handoff-brief.md` and `skills/paseo-pipeline/SKILL.md` are read
- **THEN** the brief requires a test commit before the implementation commit and a Red rerun at it, and SKILL requires an absolute one-shot heartbeat cron with `maxRuns: 1` and `timezone`
- **Verify:** `node --test skills/paseo-pipeline/test/pipeline-friction-docs.test.mjs`

#### Scenario: Whole repository suite stays green
- **WHEN** the full skills suite runs at the delivery tip
- **THEN** every test passes
- **Verify:** `node --test 'skills/**/test/*.test.mjs'`
