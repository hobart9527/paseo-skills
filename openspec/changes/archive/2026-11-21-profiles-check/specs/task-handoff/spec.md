## Purpose

Align the role prompts and deterministic planner so ordinary workers own tests and implementation, while explicitly strict tasks receive one separate Red-test handoff without duplicate dispatch after interruption.

## ADDED Requirements

### Requirement: Strict tasks dispatch a tester before an implementation worker
The planner SHALL dispatch `ceshi` first for `Review: strict` tasks without a test-author commit. Standard and mechanical tasks SHALL continue directly to their worker. The plan SHALL print the test-author role, branch, title and tester brief. Risk metadata alone SHALL NOT add a tester stage. Existing own implementation commits SHALL retain the current merge path, not retroactively add a stage.

#### Scenario: Strict task is new or has an empty branch
- **WHEN** a ready strict task has no own commits and no prior tester on the current attempt
- **THEN** the real plan reports `create-branch+dispatch-tester` or `dispatch-tester`, `ceshi` identity and `templates/tester.md`

**Verify:** `node --test skills/paseo-pipeline/test/frontier.test.mjs`

### Requirement: Tester completion is reconciled from the current branch
The planner SHALL count own `ceshi` commits separately from implementation commits. A Red-only branch SHALL dispatch its worker on the same branch, never merge. A running tester SHALL hold the task. A stopped tester with no test commit on the current attempt SHALL report `BLOCKED_TESTER_RESULT` for recovery, never duplicate dispatch or assume success. Earlier attempts SHALL NOT satisfy the current attempt.

#### Scenario: Tester hands off a Red commit
- **WHEN** a strict task has a test-author commit and no implementation commit
- **THEN** the real plan reports `dispatch-worker` on the existing branch

**Verify:** `node --test skills/paseo-pipeline/test/frontier.test.mjs`

#### Scenario: Tester stopped without a commit
- **WHEN** the current attempt has a finished tester but no test-author commit
- **THEN** the planner returns `BLOCKED_TESTER_RESULT` without dispatch

**Verify:** `node --test skills/paseo-pipeline/test/frontier.test.mjs`

### Requirement: Human names do not alter protocol identities
Daily routing SHALL use descriptive Chinese display names while preserving profile ids, Pipeline title tokens and commit role values. Prompts SHALL distinguish ordinary tests, independent Red evidence, actual read-only enforcement and an advisory review. The profile checker SHALL remain advisory lint, not claim to prove backend identity or sandbox safety.

#### Scenario: Prompt and route integration
- **WHEN** a tester hands a task to an implementer
- **THEN** their briefs name the Red commit, actual command, assertion failure and allowed test paths; missing dependencies or unfinished interfaces are not Red evidence

**Verify:** `node --test skills/paseo-pipeline/test/role-handoff-docs.test.mjs`
