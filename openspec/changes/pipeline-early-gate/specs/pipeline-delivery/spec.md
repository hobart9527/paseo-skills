## ADDED Requirements

### Requirement: The staged specs check blocks a package with an undecided hard decision
`freeze-check.mjs --structural --stage specs` SHALL report blocking code `UNDECIDED_HARD_DECISION` and exit 1 when `proposal.md` carries an `## OPEN-DECISION` entry with no `Decided:` line, whose class is `money`, `auth`, `external-write` or missing, and whose id is referenced in this change's `specs/**/*.md` text. An unreferenced open hard entry, and any open `product` entry, SHALL stay advisory. The staged check and the full run SHALL apply the same rule. Fact: `skills/paseo-pipeline/freeze-check.mjs:757-812` computes the decision gate, but the staged branch at `skills/paseo-pipeline/freeze-check.mjs:194` returns before it; on the D10 first package `3f295215` (proposal + specs, no tasks.md) the staged check exited 0 while hard decisions OD-1..OD-6 were open and referenced in requirement text.

#### Scenario: The D10 first package is rejected before tasks.md exists
- **WHEN** the staged check runs on the fixture `skills/paseo-pipeline/test/fixtures/d10-first-package/` (the D10 first package's `proposal.md` and `specs/`, no `tasks.md`)
- **THEN** it exits 1 and its blocking items start with `UNDECIDED_HARD_DECISION OD-`
- **Verify:** `node --test skills/paseo-pipeline/test/freeze-check.test.mjs`

#### Scenario: A decided, unreferenced or product-class decision does not block the staged check
- **WHEN** the same entry carries `Decided:`, or no spec text names its id, or its class is `product`
- **THEN** the staged check exits 0 and the open product or unreferenced hard case appears in `advisories`
- **Verify:** `node --test skills/paseo-pipeline/test/freeze-check.test.mjs`

### Requirement: The staged specs check blocks a scenario with no Verify command
Every `#### Scenario:` in this change's `specs/**/*.md` SHALL carry a `**Verify:**` line naming one command, and the staged check SHALL report blocking code `MISSING_SCEN_VERIFY` and exit 1 when one is missing. Fact: `openspec-schema/templates/spec.md` requires the line, but no script read it: `skills/paseo-pipeline/lib/spec-scan.mjs` extracts no Verify, and `skills/paseo-pipeline/acceptance-run.mjs:81` reads Verify only from `acceptance.md`, so a package could pass every gate with an unprovable scenario.

#### Scenario: A scenario without a Verify line is rejected
- **WHEN** a change's `specs/**/*.md` declares a scenario with no `**Verify:**` line under it
- **THEN** the staged check exits 1 with a blocking item starting `MISSING_SCEN_VERIFY`
- **Verify:** `node --test skills/paseo-pipeline/test/freeze-check.test.mjs`

#### Scenario: A scenario with a Verify line passes
- **WHEN** every scenario carries one `**Verify:**` line
- **THEN** the staged check exits 0 and reports no `MISSING_SCEN_VERIFY`
- **Verify:** `node --test skills/paseo-pipeline/test/freeze-check.test.mjs`

### Requirement: The pipeline role table and the code that recognizes roles stay in step
The role list in `skills/paseo-pipeline/SKILL.md` and the role patterns in `skills/paseo-pipeline/next-actions.mjs` SHALL name the same roles, and a test SHALL assert they agree. Fact: `skills/paseo-pipeline/SKILL.md:34` lists eight roles including 尚书 `shangshu`; `skills/paseo-pipeline/next-actions.mjs:244` recognizes only `hanlin|anchasi|gongbu|gaogong` as non-worker roles, so a `shangshu` agent fails the title check and exits 3 at `skills/paseo-pipeline/next-actions.mjs:256`.

#### Scenario: A shangshu agent is recognized as a pipeline role
- **WHEN** an active agent is named `[Pipeline] shangshu FULL`
- **THEN** `next-actions.mjs` does not exit 3 on the title check
- **Verify:** `node --test skills/paseo-pipeline/test/next-actions.test.mjs`

#### Scenario: The two role lists are asserted equal
- **WHEN** the role list in `SKILL.md` is compared with the role patterns in `next-actions.mjs`
- **THEN** the test fails when a role appears in one and not the other
- **Verify:** `node --test skills/paseo-pipeline/test/next-actions.test.mjs`

### Requirement: The R0 reviewer does not repeat the author's baseline pass
`skills/paseo-pipeline/templates/reviewer.md` SHALL NOT require a baseline pass of the sink's Verify commands; the author records that baseline once and the reviewer reads it from `## Baseline`. Fact: `skills/paseo-pipeline/templates/reviewer.md:19` and `skills/paseo-pipeline/templates/author.md:48` require the same baseline run, so one package ran it twice.

#### Scenario: reviewer.md no longer asks for the author's baseline pass
- **WHEN** `templates/reviewer.md` and `templates/author.md` are read
- **THEN** the baseline pass appears in the author brief only, and the reviewer brief says where the baseline comes from
- **Verify:** `node --test skills/paseo-pipeline/test/pipeline-friction-docs.test.mjs`

### Requirement: A dispatched agent's runtime settings match its profile
`skills/paseo-pipeline/hooks/tool-guard-hook.mjs` SHALL deny a `create_agent` call whose provider/model or `settings.modeId`, `settings.thinkingOptionId`, `settings.features` differ from the profile in `~/.paseo/config.json` that matches that provider/model, and the denial SHALL name the expected value and the actual value. Fact: the hook already reads `agentProfiles` from `config.json` at `skills/paseo-pipeline/hooks/tool-guard-hook.mjs:67` but checks only the provider string shape, so a dispatch with a stale mode or thinking option passes silently.

#### Scenario: A matching dispatch passes
- **WHEN** `create_agent` carries the provider/model, modeId, thinkingOptionId and features of its profile exactly
- **THEN** the hook allows the call unchanged
- **Verify:** `node --test skills/paseo-pipeline/test/tool-guard-hook.test.mjs`

#### Scenario: A stale mode or thinking option is denied with both values named
- **WHEN** `create_agent` carries a `modeId` or `thinkingOptionId` that differs from the profile
- **THEN** the hook denies the call and the reason names the expected value and the actual value
- **Verify:** `node --test skills/paseo-pipeline/test/tool-guard-hook.test.mjs`
