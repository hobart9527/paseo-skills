## Purpose

Contract for `pipeline-audit-fixes`: seven deterministic gates/refusals closing the 2026-11-20 Neon audit findings F-1..F-7 at `d712ac6`. No new mechanism, service, ledger or external write; Git stays the delivery state.

## ADDED Requirements

### Requirement: The full freeze run enforces the same scenario and overlap rules as the staged specs run
`freeze-check.mjs` SHALL judge every declared scenario for a `- **Verify:**` line and every requirement overlap with another active change in the full run exactly as it already does under `--stage specs`. A scenario with no Verify line SHALL block the full run with `MISSING_SCEN_VERIFY`; a requirement another active change also modifies or removes SHALL produce the same `ADVISORY_REQ_OVERLAP` advisory. `--structural` does not skip these two rules.

#### Scenario: SCEN-FULL-01 a full run with a Verify-less scenario blocks
- **WHEN** a package has tasks, acceptance, review and a spec whose `#### Scenario: SCEN-CAP-01` carries no `- **Verify:**` line, and the full run is executed without `--stage specs`
- **THEN** the run exits 1 and the blocking list contains `MISSING_SCEN_VERIFY SCEN-CAP-01 specs/cap/spec.md`
- **Verify:** `node --test test/freeze-check.test.mjs`

#### Scenario: SCEN-FULL-02 the overlap advisory also appears in the full run
- **WHEN** this change MODIFIES a requirement that another active change also REMOVES, and the full run executes
- **THEN** the advisory list contains `ADVISORY_REQ_OVERLAP <requirement>: this change MODIFIED it, and other also REMOVED it`
- **Verify:** `node --test test/freeze-check.test.mjs`

### Requirement: Planning refuses to deadlock on an unrelated or unresolvable pipeline agent
`pipeline-run.mjs plan`/`next-actions.mjs` SHALL NOT treat a non-running `[Pipeline]` agent as an error for the change being planned when the agent cannot be attributed to any change of the current repository. An agent SHALL be attributed by its `pipeline.change` label, by a change id in its title, or by a live change directory under its `cwd`. An agent whose `cwd` no longer resolves to a git repository SHALL be a diagnostic, not a blocker, unless that agent is running or awaiting a permission. A genuinely ambiguous running agent still exits 3.

#### Scenario: SCEN-PLAN-01 a closed agent from a deleted worktree does not block a new change
- **WHEN** a closed `[Pipeline]` agent's `cwd` no longer exists, or belongs to another repository, and a new change is planned
- **THEN** the plan exits 0 and prints the agent as a diagnostic instead of exiting 3
- **Verify:** `node --test test/next-actions.test.mjs`

#### Scenario: SCEN-PLAN-02 a running agent with an unattributable identity still stops the plan
- **WHEN** a running `[Pipeline]` agent has no `pipeline.change` label, no change id in its title, and no resolvable repository
- **THEN** the plan exits 3 with the existing "lacks a matching change label" message
- **Verify:** `node --test test/next-actions.test.mjs`

### Requirement: The tool guard honours an explicit null as inherit
`hooks/tool-guard-hook.mjs` SHALL accept an explicit `null` for `settings.modeId`, `settings.thinkingOptionId` or `settings.features` on a profile whose own value is `null`/absent, as its own comment promises, instead of denying the launch.

#### Scenario: SCEN-GUARD-01 an explicit null thinking option on a profile without one is allowed
- **WHEN** `mcp__paseo__create_agent` is called with `provider: "claude/cc"` and `settings.thinkingOptionId: null`, and the matching profile sets none
- **THEN** the hook allows the call and sets no deny reason
- **Verify:** `node --test test/tool-guard-hook.test.mjs`

### Requirement: A sign-off cannot be minted by the contract author
`freeze-check.mjs` SHALL block with `R0_SELF_REVIEW` when the last `R0: pass(<signer>@<sha>)` signer matches a `Pipeline-Author` trailer on a contract commit reachable at that `<sha>`. The `commit-msg` hook SHALL stamp `Pipeline-Author` for `hanlin` author commits, as it already does for writer roles, so the check has evidence to read.

#### Scenario: SCEN-R0-01 the author signing its own contract blocks
- **WHEN** the same agent id appears as `Pipeline-Author` on the signed contract commit and as the `R0: pass(...)` signer
- **THEN** the run exits 1 and the blocking list contains `R0_SELF_REVIEW`
- **Verify:** `node --test test/freeze-check.test.mjs`

#### Scenario: SCEN-R0-02 an independent signer still passes
- **WHEN** the signer differs from every `Pipeline-Author` on the signed contract commits
- **THEN** no `R0_SELF_REVIEW` is emitted
- **Verify:** `node --test test/freeze-check.test.mjs`

### Requirement: A required acceptance command that can hide a failure is rejected
`freeze-check.mjs` and `acceptance-run.mjs` SHALL reject a `Required=yes` Verify that contains an unquoted pipe, `||`, or a command that proves nothing, using the same leg/proves/fixture judgement the task Verify rules already apply. `acceptance-run.mjs` SHALL execute with `pipefail` so a red first leg cannot be masked by a later one.

#### Scenario: SCEN-ACC-01 a piped acceptance command is rejected at freeze
- **WHEN** a `Required=yes` row's Verify is `node --test test/a.test.mjs | tail -n 20`
- **THEN** the freeze run exits 1 and the blocking list contains `BAD_ACCEPTANCE_VERIFY SCEN-...`
- **Verify:** `node --test test/freeze-check.test.mjs`

#### Scenario: SCEN-ACC-02 a red leg inside a pipeline is not PASS
- **WHEN** acceptance runs a command whose first leg fails but a later leg succeeds
- **THEN** the recorded row is `FAIL` and the run is not valid
- **Verify:** `node --test test/acceptance-run.test.mjs`

### Requirement: Role rules and the profile lint agree on every dispatched role
`SKILL.md` `## Roles` SHALL name every role the pipeline dispatches, including the independent R0 reviewer (契约审查 Neon), and `profiles-check.mjs` SHALL check that role too. Because a profile id is not always `agent_profile_<role>`, the lint SHALL resolve a role through an explicit role-to-profile-id mapping and keep the `agent_profile_<role>` default for the rest; a role that resolves to no profile SHALL be `MISSING_PROFILE`. Repository briefs pointed to by `brief:` notes SHALL exist and match the profile's declared `use:` boundary: the research profile does not carry the author brief. Live Paseo profiles and `~/.paseo/task-routing.md` are outside the repository; this change records their required edits in the delivery report instead of writing them.

#### Scenario: SCEN-PROF-01 a dispatched role missing from the lint set fails
- **WHEN** `SKILL.md` names an R0 reviewer role that has no entry in the lint's role set and no `agent_profile_<role>` profile
- **THEN** `profiles-check.mjs` exits 1 and reports `MISSING_PROFILE` for that role
- **Verify:** `node --test test/profiles-check.test.mjs`

#### Scenario: SCEN-PROF-02 every declared role resolves to a profile
- **WHEN** the lint runs with the repository root against the live config, where the R0 reviewer profile id is not `agent_profile_<role>`
- **THEN** the R0 reviewer role resolves through the mapping, every brief path exists, and the run exits 0
- **Verify:** `node --test test/profiles-check.test.mjs`

### Requirement: The hook installer refuses to displace an existing hooks directory
`pipeline-run.mjs install-hook` SHALL, before writing, detect an existing `core.hooksPath` that is not the pipeline hooks directory and any non-sample executable file in the default hooks directory. If either is present it SHALL exit non-zero, list what would be displaced, and require an explicit `--replace-hooks` flag plus human approval.

#### Scenario: SCEN-HOOK-01 an existing core.hooksPath is not silently replaced
- **WHEN** a repository sets `core.hooksPath=.husky` and `install-hook` runs without `--replace-hooks`
- **THEN** it exits non-zero, names `.husky`, and leaves `core.hooksPath` unchanged
- **Verify:** `node --test test/pipeline-run.test.mjs`

#### Scenario: SCEN-HOOK-02 an empty hooks directory still installs
- **WHEN** the repository has no custom `core.hooksPath` and only `.sample` files in `.git/hooks`
- **THEN** `install-hook` exits 0 and points `core.hooksPath` at the pipeline hooks
- **Verify:** `node --test test/pipeline-run.test.mjs`
