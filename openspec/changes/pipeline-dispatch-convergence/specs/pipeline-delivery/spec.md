# Delta: pipeline-delivery

## MODIFIED Requirements

### Requirement: Native delegation is the default dispatch path
Pipeline SHALL delegate through agent-scoped Paseo MCP (`create_agent`/`send_agent_prompt`) using provider, modeId, thinkingOptionId and features copied verbatim from live `list_profiles` (`featureValues` → `settings.features`; undeclared fields omitted), with `notifyOnFinish` enabled and labels `pipeline.change/task/attempt/phase/role`. The only CLI dispatch entry SHALL be `task-runner.mjs`; `hotfix.sh` MAY remain only as a compatibility wrapper that delegates to it and SHALL NOT carry dispatch logic of its own. The CLI path SHALL be documented as legacy and announce that completion callback is not verified for that path; the statement SHALL be scoped to the observed CLI path/version and SHALL NOT be generalized. CLI success or a parent label SHALL NOT be treated as proof of callback delivery.

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
- **THEN** no `dispatch.mjs` exists, the documentation names `task-runner.mjs` as the only CLI dispatch entry and `hotfix.sh` as a wrapper that delegates to it, and `hotfix.sh` contains no `paseo run` invocation of its own.

## ADDED Requirements

### Requirement: Handoff and CLI dispatch are mechanical and single-entry
Between human confirmation point 1 and the first dispatch, a handoff check SHALL verify that the change directory `openspec/changes/<name>/` is committed with no uncommitted or untracked files under it and that `tasks.md` is readable from the integration base, and SHALL fail with a message naming the offending path otherwise. The same check SHALL run again before every CLI dispatch, using one shared definition.

Registering a receipt for a writer-role intent in the impl or test phase SHALL be refused when the receiving agent's recorded working directory is on a branch matching `integration/*`, because writers belong in the task workspace `task/<name>/<task>`. When the agent's working directory or branch cannot be read, the registration SHALL proceed and SHALL print one line stating that the check was not performed.

The CLI dispatch entry SHALL create the writer's workspace through Paseo with branch `task/<name>/<task>` (suffix `-a<attempt>` on redispatch) based on `integration/<name>`, SHALL stamp all five `pipeline.*` labels, SHALL claim the intent before dispatch, register the receipt after, and void the intent when dispatch fails, SHALL resolve the writer profile fail-closed, and SHALL NOT create workspaces with `git worktree add`, invent an agent id, or substitute an offline fallback for a missing Paseo daemon.

For a task whose Review tier is not `mechanical`, the CLI dispatch entry SHALL stop after the writer's Verify passes with a dedicated exit code and SHALL NOT create any audit intent, review record or reviewer identity. It SHALL merge only when given a review tag, and SHALL NOT set the homogeneous-review exemption on the caller's behalf. When waiting for an agent fails or returns no parseable status, it SHALL poll the agent's state until idle or until its deadline, and SHALL exit with a dedicated code on deadline without redispatching.

Documentation SHALL state `task-runner.mjs` as the only CLI dispatch entry, SHALL place committing the frozen artifacts and running the handoff check in the handoff sequence before the integration workspace is built, and SHALL name `test/run-all.sh` as the closing full-suite command.

#### Scenario: SCEN-HND-01 uncommitted change artifacts fail the handoff check
- **WHEN** `handoff-check` runs for a change whose directory has untracked or modified files
- **THEN** it exits non-zero and the output names each offending path.

#### Scenario: SCEN-HND-02 a committed change on the integration branch passes
- **WHEN** `handoff-check` runs on `integration/<name>` with a clean tree and `tasks.md` committed at the base
- **THEN** it exits 0, and it exits non-zero with a branch-naming message when run on any other branch.

#### Scenario: SCEN-HND-03 a writer registered on the integration branch is refused
- **WHEN** `record` registers a gongbu impl intent whose agent record shows a working directory checked out on `integration/<name>`
- **THEN** it exits 2 naming the branch, and the same registration for an agent on `task/<name>/<task>` succeeds.

#### Scenario: SCEN-HND-04 CLI dispatch uses a Paseo-managed task workspace
- **WHEN** the dispatch entry runs against a fixture `paseo`
- **THEN** the recorded `paseo run` argv contains `--new-workspace worktree`, `--new-branch task/<name>/<task>`, `--base integration/<name>` and all five `pipeline.*` labels, the intent is claimed before and recorded after the call, and the run exits non-zero without calling `paseo run` when the writer profile is missing or resolves to an empty provider.

#### Scenario: SCEN-HND-05 redispatch increments the attempt branch suffix
- **WHEN** `task/<name>/<task>` already exists and the dispatch entry runs again
- **THEN** the new branch is `task/<name>/<task>-a2` and the intent attempt is 2.

#### Scenario: SCEN-HND-06 a non-mechanical task stops for a real audit
- **WHEN** the dispatch entry completes a task whose Review tier is `standard` or `strict`
- **THEN** it exits 50, the run ledger contains no audit-phase intent or review record created by the entry, and a later invocation with a review tag runs the merge gate without `PIPELINE_ALLOW_HOMOGENEOUS_REVIEW` being set by the entry.

#### Scenario: SCEN-HND-07 a failed wait degrades to polling and never redispatches
- **WHEN** `paseo wait` exits non-zero with `WAIT_FAILED` while `paseo inspect` later reports the agent idle
- **THEN** the entry proceeds as if the wait had returned idle, and when the agent never becomes idle before the deadline it exits 51 without invoking `paseo run` a second time.

#### Scenario: SCEN-HND-08 the hotfix wrapper delegates and keeps its contract
- **WHEN** `hotfix.sh` runs with a mechanical task and with a non-mechanical task
- **THEN** the mechanical run delegates to the entry, which issues the `paseo run` dispatch with the same argv shape and ledger behaviour (claim, record, fail) as before, the non-mechanical run is refused before any dispatch, and the script itself contains no `paseo run` invocation. Passing the brief file and test command through to the writer is outside this scenario.

#### Scenario: SCEN-HND-09 documentation states the single entry and the handoff gate
- **WHEN** SKILL.md is read
- **THEN** it names `task-runner.mjs` as the only CLI dispatch entry, lists committing frozen artifacts and `handoff-check` before building the integration workspace, and names `test/run-all.sh` as the closing full-suite command.
