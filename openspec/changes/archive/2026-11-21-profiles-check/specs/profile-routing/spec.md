## Purpose

Keep Paseo agent profile notes consistent with the pipeline role table, and make model-family heterogeneity between writers and auditors checkable by script instead of by prose.

## ADDED Requirements

### Requirement: Profile notes are machine-checkable against the pipeline role table
`skills/paseo-pipeline/profiles-check.mjs` SHALL read the `## Roles` table of a SKILL.md and the `daemon.agentProfiles` of a Paseo config, and exit 1 listing every finding, or exit 0 when none. It SHALL write nothing. Exit 2 on unreadable input or bad arguments.

#### Scenario: Role without a profile
- **WHEN** the Roles table names `gongbu` and the config has no profile with id `agent_profile_gongbu`
- **THEN** the script exits 1 and the output contains `MISSING_PROFILE gongbu`

**Verify:** `node --test skills/paseo-pipeline/test/profiles-check.test.mjs`

#### Scenario: Notes lack the template fields
- **WHEN** a role's profile notes lack a `family:`, `harness:` or `write:` line
- **THEN** the script exits 1 and the output contains `MISSING_FIELD <role> <field>`

**Verify:** `node --test skills/paseo-pipeline/test/profiles-check.test.mjs`

### Requirement: Default implementation pairings have declared family diversity
The script SHALL report `FAMILY_CLASH` when `anchasi` shares a `family:` value with any of `gongbu`, `gaogong`, `jiangzuo`, or when `ceshi` shares one with `gongbu`. It SHALL NOT reject `ceshi` and `anchasi` merely for sharing a family. This is a configuration lint of default pairings, not proof of actual contributor independence, backend identity or sandbox permissions; dispatch SHALL reconcile the chosen reviewers against contributors to the concrete target.

#### Scenario: Auditor same family as writer
- **WHEN** `anchasi` and `gongbu` both declare `family: gemini`
- **THEN** the script exits 1 and the output contains `FAMILY_CLASH anchasi gongbu`

**Verify:** `node --test skills/paseo-pipeline/test/profiles-check.test.mjs`

### Requirement: Unenforceable harnesses declare an after-the-fact check
The script SHALL report `UNENFORCED_WRITE` for a profile whose `provider` is `antigravity` unless its `write:` line contains `diff-check`.

#### Scenario: Antigravity profile without diff-check
- **WHEN** a role's provider is `antigravity` and its `write:` line is `read-only`
- **THEN** the script exits 1 and the output contains `UNENFORCED_WRITE <role>`

**Verify:** `node --test skills/paseo-pipeline/test/profiles-check.test.mjs`

#### Scenario: Complete, heterogeneous profiles
- **WHEN** every role has a profile with all fields, families satisfy the rules above, and antigravity profiles declare `diff-check`
- **THEN** the script exits 0

**Verify:** `node --test skills/paseo-pipeline/test/profiles-check.test.mjs`
