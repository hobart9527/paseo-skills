# pipeline-delivery Delta

## MODIFIED Requirements

### Requirement: Handoff and CLI dispatch are mechanical and single-entry
Between human confirmation point 1 and the first dispatch, a handoff check SHALL verify that the change directory `openspec/changes/<name>/` is committed with no uncommitted or untracked files under it and that `tasks.md` is readable from the integration base, and SHALL fail with a message naming the offending path otherwise. The same check SHALL run again before every CLI dispatch, using one shared definition.

The handoff sequence in documentation SHALL be executable as written: committing the frozen artifacts, creating the integration branch, then running the handoff check SHALL be legal in that order. The branch criterion SHALL be context-aware: when the integration base ref already resolves to an existing branch (`refs/heads/integration/<name>` present), the check SHALL require the current branch to be `integration/<name>`; when the base ref does not yet exist (the branch has not been created yet), the check SHALL verify the artifacts from the current commit and SHALL state in its success output that the branch criterion was deferred, rather than failing with WRONG_BRANCH. After the integration workspace is created, the pre-dispatch reuse of the check SHALL always run on the integration branch and SHALL fail otherwise.

Registering a receipt for a writer-role intent in the impl or test phase SHALL be refused when the receiving agent's recorded working directory is on a branch matching `integration/*`, because writers belong in the task workspace `task/<name>/<task>`. When the agent's working directory or branch cannot be read, the registration SHALL proceed and SHALL print one line stating that the check was not performed.

The CLI dispatch entry SHALL create the writer's workspace through Paseo with branch `task/<name>/<task>` (suffix `-a<attempt>` on redispatch) based on `integration/<name>`, SHALL stamp all five `pipeline.*` labels, SHALL claim the intent before dispatch, register the receipt after, and void the intent when dispatch fails, SHALL resolve the writer profile fail-closed, and SHALL NOT create workspaces with `git worktree add`, invent an agent id, or substitute an offline fallback for a missing Paseo daemon.

When the writer settled with the task branch tip equal to the base its workspace was created from, the CLI dispatch entry SHALL exit with a dedicated code for every Review tier, SHALL state that the writer produced no commit, and SHALL NOT report Verify as having covered an implementation. The same comparison SHALL run on the review-tag re-entry path before it merges, because the merge gate below only reports that a branch has nothing to merge, which does not distinguish an empty delivery from a delivery whose work was already absorbed.

For a task whose Review tier is not `mechanical`, after the writer's Verify passes **and** the task branch is confirmed to carry at least one commit beyond its base, the CLI dispatch entry SHALL stop with a dedicated exit code and SHALL NOT create any audit intent, review record or reviewer identity. It SHALL merge only when given a review tag, and SHALL NOT set the homogeneous-review exemption on the caller's behalf. When waiting for an agent fails or returns no parseable status, it SHALL poll the agent's state until a terminal state (idle, closed or error) or until its deadline, and SHALL exit with a dedicated code on deadline without redispatching; that exit message SHALL state that re-invoking the same task id continues waiting on the same attempt rather than starting a new one.

The review-tag re-entry path SHALL enforce the same owner/lease criterion as claim: when a valid orchestration lease exists, the re-entry invocation SHALL carry `--owner` matching the current owner and SHALL be refused otherwise, so an expired-lease session cannot merge after the fact.

A task whose frozen contract declares no executable `Verify with` SHALL NOT be verified with a substituted default command anywhere on the CLI path; the dispatch entry SHALL fail with the same semantics the merge gate uses for an unverifiable contract, instead of guessing a test command.

Documentation SHALL state `task-runner.mjs` as the only CLI dispatch entry, SHALL place committing the frozen artifacts and running the handoff check in the handoff sequence before the first dispatch, and SHALL name `test/run-all.sh` as the closing full-suite command.

#### Scenario: SCEN-HND-01 uncommitted change artifacts fail the handoff check
- **WHEN** `handoff-check` runs for a change whose directory has untracked or modified files
- **THEN** it exits non-zero and the output names each offending path.

#### Scenario: SCEN-HND-02 a committed change on the integration branch passes
- **WHEN** `handoff-check` runs on `integration/<name>` with a clean tree and `tasks.md` committed at the base
- **THEN** it exits 0, and it exits non-zero with a branch-naming message when run on any other branch while the integration branch exists.

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
- **THEN** it exits 50, the run ledger contains no audit-phase intent or review record created by the entry, and a later invocation with a review tag runs the merge gate without setting any homogeneous-review exemption on the caller's behalf.

#### Scenario: SCEN-HND-07 a failed wait degrades to polling and never redispatches
- **WHEN** `paseo wait` exits non-zero with `WAIT_FAILED` while `paseo inspect` later reports the agent idle
- **THEN** the entry proceeds as if the wait had returned idle, and when the agent never becomes idle before the deadline it exits 51 without invoking `paseo run` a second time.

#### Scenario: SCEN-HND-08 the hotfix wrapper delegates and keeps its contract
- **WHEN** `hotfix.sh` runs with a mechanical task and with a non-mechanical task
- **THEN** the mechanical run delegates to the entry, which issues the `paseo run` dispatch with the same argv shape and ledger behaviour (claim, record, fail) as before, the non-mechanical run is refused before any dispatch, and the script itself contains no `paseo run` invocation. Passing the brief file and test command through to the writer is outside this scenario.

#### Scenario: SCEN-HND-09 documentation states the single entry and the handoff gate
- **WHEN** SKILL.md is read
- **THEN** it names `task-runner.mjs` as the only CLI dispatch entry, lists committing frozen artifacts and `handoff-check` in a sequence executable as written (the integration branch is created before the check runs, or the check's branch criterion is deferred with an explicit note), and names `test/run-all.sh` as the closing full-suite command.

#### Scenario: SCEN-HND-10 handoff check passes pre-branch with deferred note
- **WHEN** `handoff-check <name> --base integration/<name>` runs while `refs/heads/integration/<name>` does not exist and all change artifacts are committed on the current branch
- **THEN** it exits 0 with an output line stating the branch criterion was deferred until the integration workspace is created, and the same command after the branch exists but on a different branch exits non-zero naming the expected branch.

#### Scenario: SCEN-HND-11 review-tag re-entry enforces the lease
- **WHEN** the dispatch entry is invoked with `--review-tag` while a valid lease belongs to another owner, or by a session omitting `--owner` under a valid lease
- **THEN** it refuses before any merge with the lease-owner message, and the same invocation with the correct `--owner` proceeds to the merge gate.

#### Scenario: SCEN-HND-12 a task without an executable Verify is refused, not guessed
- **WHEN** the dispatch entry reaches the merge step for a task whose `Verify with` is absent
- **THEN** it fails with the unverifiable-contract semantics, the executed command log contains no substituted default test command, and the failure names the task and the missing contract.

#### Scenario: SCEN-HND-13 a deadline exit tells the caller how to continue
- **WHEN** the writer agent has not reached a terminal state before the deadline and the entry exits 51
- **THEN** the message states that re-invoking the same task id continues waiting on the same attempt and does not redispatch, and an agent in `error` state is treated as terminal without waiting for the deadline.

### Requirement: Reconciliation validates the task graph, runtime and agent identity
`reconcile.mjs` SHALL parse `tasks.md` via a single shared parser and classify every task into exactly one state, evaluated in order: INVALID (including ledger mismatch), DONE, ACTIVE, UNRESOLVED, MERGE_CANDIDATE, BLOCKED_DEP, BLOCKED_RESOURCE, READY. It SHALL exit non-zero on malformed task lines, duplicate IDs, unknown dependency references, cycles, or when HEAD is not `integration/<change>`. If runtime state is unavailable or unparsable, `canDispatchNow` SHALL be empty. Agents SHALL be classified by `pipeline.role` as control-plane (Lead, Watcher, spec Critic, Arbiter, Scout; no task label required, hold no write scope), task-plane read-only (Auditor) or task-plane writer (Runner, Senior, Light, Tester); a running agent with a missing/unknown role, a task-plane role lacking task/attempt/phase, or a task absent from tasks.md SHALL be UNMAPPED and SHALL empty `canDispatchNow`.

`Write scope` SHALL be a repository-root-relative path that does not escape the root after normalization. Invalid scopes SHALL classify the task INVALID before every other task state. Runtime occupancy SHALL be accounted independently of classification: initializing/running writers on INVALID tasks SHALL still consume cap slots and conservatively hold unknown scope, and SHALL empty `canDispatchNow`. This clarification retains the existing a4 normalization rules and adds no DEL/C1 prohibition.

A dispatch intent without a receipt SHALL hold only the task it names: that task SHALL be absent from `canDispatchNow` and reported with a per-task hold reason, while unrelated tasks remain dispatchable within cap. Only global conditions — runtime not `ok`, UNMAPPED running agents, cap exhausted — SHALL empty `canDispatchNow` entirely. Orphan intents (no matching agent past grace) SHALL remain the top-priority `NEXT arbitrate` action and SHALL NOT be auto-redispatched, but SHALL NOT by themselves freeze unrelated tasks.

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

#### Scenario: SCEN-REC-15 an open intent holds only its named task
- **WHEN** an intent for T-02 has no receipt while T-01 and T-03 are otherwise READY and within cap
- **THEN** T-02 is absent from `canDispatchNow` with a per-task hold reason naming the intent, T-01 and T-03 remain in `canDispatchNow`, and no global hold reason about open intents is present.

#### Scenario: SCEN-REC-16 an orphan intent on a finished task does not freeze the change
- **WHEN** an orphan intent names a task already proven DONE and unrelated tasks are READY
- **THEN** the orphan intent is the top-priority `NEXT arbitrate` action, and the unrelated READY tasks remain in `canDispatchNow`.

### Requirement: Run ledger refuses to erase receipts and reports only collected facts
The run ledger SHALL refuse to void an intent that already carries a real agent receipt, since voiding means "this dispatch did not happen" while a receipt proves it did and names an agent; recovering from a lost agent SHALL use a new attempt key instead.

A ledger file that exists but cannot be parsed SHALL be treated as corrupt, not absent: every mutating entry point SHALL refuse to write over it, SHALL name the file and the parse error, and SHALL print recovery guidance (move the file aside or repair it; do not rerun `begin` expecting a fresh ledger). Read-only consumers SHALL surface the corruption as an explicit corruption hold rather than behaving as if no ledger existed. The lock file protecting the ledger SHALL expose a documented manual release entry for crash residue, and stale detection SHALL consider whether the recorded holder process is still alive in addition to age.

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

#### Scenario: SCEN-LED-01 a corrupt ledger is never overwritten
- **WHEN** `run-state.json` holds invalid JSON and a mutating command (`begin`, `claim`, `record`) runs
- **THEN** the command exits non-zero naming the file and the parse error, the file content is byte-identical before and after, and the output states recovery guidance instead of proceeding with an empty ledger.

#### Scenario: SCEN-LED-02 a corrupt ledger surfaces as corruption, not absence
- **WHEN** `reconcile` runs with an unparsable ledger
- **THEN** its output contains an explicit corruption line naming the file and error, and it does not report the ledger as absent or treat the run as lease-free.

#### Scenario: SCEN-LED-03 the scope guard does not silently disable on corruption
- **WHEN** the write-scope guard evaluates a path while the ledger is corrupt
- **THEN** its output marks the ledger corrupt rather than reporting no active lease, so a deny cannot silently degrade to allow.

#### Scenario: SCEN-LED-04 a stale lock names its holder and a documented release
- **WHEN** `run-state.lock` outlives its holder and a claim is attempted
- **THEN** the refusal names the holder (pid/host/age), mentions the documented manual release flag, and the release flag removes the lock when the holder process is dead; stale detection treats a live holder as fresh regardless of age.

### Requirement: Merge is safe, exact, revision-bound and drift-aware
`merge-task.mjs` SHALL require branch, task IDs, review tag and test command (no defaults), and run only on `integration/<change>` with a clean tree. It SHALL match task IDs exactly against `tasks.md` and the branch name and reject already-Done tasks. The review tag `pass(<reviewer-id8>@<tip7>/<base7>)` SHALL have `tip7` equal to the branch tip; if `base7` differs from current HEAD and files changed in `base7..HEAD` intersect files changed by the branch, the merge SHALL be rejected for re-review, otherwise it proceeds with tests on the merged tree and drift recorded in run-log; no rebase is required. The script SHALL document that it cannot prove a review occurred, and the Lead SHALL confirm Auditor verdict PASS and reviewed SHA before invoking. The merge commit SHALL carry trailers `Pipeline-Task` and `Pipeline-Source` (full tip), and contain code merge, `tasks.md` `[x]` + `Done: source=<tip7> review=<tag>`, and run-log append in one commit. On conflict or test failure it SHALL `git merge --abort` and exit non-zero, SHALL NOT use `git reset --hard`, and SHALL NOT swallow errors.

The merge gate SHALL fail closed on an undecided Review tier: a task whose Review is neither declared nor derivable from a non-`none` risk surface SHALL be refused with a dedicated message naming the undecided tier, and SHALL NOT silently default to `standard` or `mechanical`.

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

#### Scenario: SCEN-MRG-11 an undecided review tier fails closed
- **WHEN** a merge is requested for a task with no `Review` field and `Risk-surface: [none]`
- **THEN** the merge is refused with a message naming the undecided tier, no default tier is applied, and the refusal is not a write-scope or authorship failure.

### Requirement: Documentation states the same contract the code enforces
The skill documentation SHALL present the run-ledger commands in a form that can be executed as written, including the owner argument required while a lease is active, and SHALL state the consequence of omitting it. Every run-ledger subcommand named in the documentation SHALL exist in the script. Role names used for dispatch SHALL come from the live profile source; the historical role `qingqibing` SHALL remain recognisable for reading existing agent labels and SHALL NOT appear as a dispatchable role. Documentation SHALL NOT describe a wake mechanism, an evidence field set, or a review-tag form that the code does not implement.

The envelope field count SHALL be stated exactly as the shared definition exports it, and a documentation test SHALL bind the prose count and field list to `ENVELOPE_REQUIRED_FIELDS` so the two cannot drift. The tier gate — its default-on status, its judgement basis (distinct business files written on the primary checkout's main/master), its opt-out (`PIPELINE_TIER_GATE=off`), its limit override and its coverage gap (shell redirection) — SHALL be documented in SKILL.md, and the environment doctor SHALL check that both hooks are registered and report the gate's effective on/off state. Stale architectural narrative that describes removed roles or variables SHALL carry a header note pointing at the governing contract, and the governing spec SHALL NOT reference variables the code no longer reads.

#### Scenario: SCEN-CON-12 documented commands run against the script
- **WHEN** the run-ledger command block in the documentation is compared with the script
- **THEN** every claim/record/fail example carries `--owner`, every referenced subcommand has a matching implementation, and the omission consequence is stated.

#### Scenario: SCEN-CON-13 the hotfix path resolves its profile fail-closed
- **WHEN** `hotfix.sh` runs with a profile config lacking the writer profile it requires
- **THEN** it exits non-zero instead of dispatching with an empty provider, and it does not consult the historical role profile as a dispatch source.

#### Scenario: SCEN-DOC-03 envelope count is bound to the shared definition
- **WHEN** SKILL.md's envelope paragraph is read and compared with `lib/envelope.mjs`
- **THEN** the stated field list equals `ENVELOPE_REQUIRED_FIELDS` in name and count, and a documentation test fails if either side changes alone.

#### Scenario: SCEN-DOC-04 the tier gate is documented and diagnosed
- **WHEN** SKILL.md and `pipeline-doctor.mjs` output are read
- **THEN** SKILL.md documents the tier gate's default-on status, its opt-out, its limit override and its coverage gap, and the doctor reports both hooks' registration plus the gate's effective state.

#### Scenario: SCEN-DOC-05 stale narrative is marked, live spec carries no dead variables
- **WHEN** `docs/sdd-multi-agent-architecture.md` and `openspec/specs/pipeline-delivery/spec.md` are read
- **THEN** the architecture document carries a header note deferring to SKILL.md and the spec for current contracts, and the spec names no environment variable the scripts no longer read.

## ADDED Requirements

### Requirement: Waiting on an agent ends only on terminal states
Any pipeline script that waits on a Paseo agent SHALL treat `idle`, `closed` and `error` as terminal and stop polling when one is observed, and SHALL only run its deadline when no terminal state is reached. A deadline exit SHALL be actionable: its message SHALL name the agent id and state last observed and state the re-entry semantics (re-invoking the same task continues waiting on the same attempt; it neither redispatches nor starts a new attempt). Documentation SHALL state the same semantics in one place and reference it elsewhere, not restate it in divergent copies.

#### Scenario: SCEN-HND-14 an errored agent is terminal
- **WHEN** the polled agent state is `error` before the deadline
- **THEN** the wait loop returns immediately with that state, the deadline is not consumed, and the caller reports the error state rather than timing out.
