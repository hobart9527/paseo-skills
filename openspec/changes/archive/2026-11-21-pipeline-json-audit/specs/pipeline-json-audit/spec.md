## Purpose

Give pipeline callers machine-readable results: `profiles-check.mjs --json` returns one JSON object a script can parse, and `pipeline-run.mjs install-hook` names every hook object its install displaces or replaces, so a human approving `--replace-hooks` sees what is lost.

## ADDED Requirements

### Requirement: profiles-check prints one JSON object under --json

`node skills/paseo-pipeline/profiles-check.mjs` SHALL accept a boolean `--json` flag in any position among its existing `--skill`, `--config` and `--root` flags. With `--json`, after a successful read of the skill and config files, stdout MUST contain exactly one JSON object and nothing else (one trailing newline allowed), with exactly the keys `roles` (array of role names in the order `rolesOf` returns them, `profiles-check.mjs:44-47`), `findings` (array of the finding strings `check()` returns, `profiles-check.mjs:58-92`), `advisories` (array of the advisory strings `check()` returns, without the text-mode `ADVISE ` prefix, `profiles-check.mjs:116`) and `ok` (boolean, `true` exactly when `findings` is empty). The exit code MUST be 0 when `ok` is true and 1 otherwise. A usage or read error under `--json` MUST exit 2 with the existing usage message on stderr and nothing on stdout (`profiles-check.mjs:111-114`).

#### Scenario: SCEN-PJ-01 clean profiles under --json
- **WHEN** `profiles-check.mjs --json --skill <SKILL.md with 9 roles> --config <config with 9 complete, heterogeneous profiles>` runs
- **THEN** stdout parses with `JSON.parse` as one object whose keys are exactly `roles`, `findings`, `advisories`, `ok`; `roles` lists the 9 roles in table order, `findings` and `advisories` are `[]`, `ok` is `true`, and the exit code is 0
- **Verify:** node --test skills/paseo-pipeline/test/profiles-check.test.mjs

#### Scenario: SCEN-PJ-02 findings and advisories under --json
- **WHEN** `profiles-check.mjs --json` runs against a config missing one role's profile and giving a non-`hanlin` role the brief `skills/paseo-pipeline/templates/author.md`, with `--root` pointing at a tree where that brief exists
- **THEN** stdout parses as one object whose `findings` contains `MISSING_PROFILE <role> (<profile id>)` exactly as text mode prints it, whose `advisories` contains the `ADVISORY_BRIEF_OUT_OF_SCOPE <role>: ...` string with no `ADVISE ` prefix, `ok` is `false`, and the exit code is 1
- **Verify:** node --test skills/paseo-pipeline/test/profiles-check.test.mjs

#### Scenario: SCEN-PJ-03 usage error under --json stays a usage error
- **WHEN** `profiles-check.mjs --json --skill /nonexistent --config /nonexistent` runs, and separately `profiles-check.mjs --json --bogus x` runs
- **THEN** each exits 2, stderr carries the `Usage: profiles-check.mjs` message, and stdout is empty
- **Verify:** node --test skills/paseo-pipeline/test/profiles-check.test.mjs

### Requirement: profiles-check text mode is unchanged without --json

Without `--json`, `profiles-check.mjs` stdout, stderr and exit codes (0 clean, 1 findings, 2 usage/read error) MUST stay byte-identical to the baseline at `profiles-check.mjs:94-119`: one `ADVISE <advisory>` line per advisory, then either the findings joined by newlines or `profiles ok (<n> roles)`.

#### Scenario: SCEN-PJ-04 text output byte-identical
- **WHEN** `profiles-check.mjs` runs without `--json` on the clean fixture, on a fixture with one missing profile, and on a fixture with one out-of-scope author brief
- **THEN** stdout equals exactly `profiles ok (9 roles)\n` with exit 0, `MISSING_PROFILE <role> (<profile id>)\n` with exit 1, and `ADVISE ADVISORY_BRIEF_OUT_OF_SCOPE <role>: ...\nprofiles ok (9 roles)\n` with exit 0, respectively; stderr is empty in all three
- **Verify:** node --test skills/paseo-pipeline/test/profiles-check.test.mjs

### Requirement: install-hook names what it displaces and replaces

`node skills/paseo-pipeline/pipeline-run.mjs install-hook [--replace-hooks] <worktree>...` SHALL, for each target whose displaced list (`pipeline-run.mjs:111-132`: a non-pipeline `core.hooksPath` as `core.hooksPath=<value>`, then each executable non-`.sample` regular file in `<git-common-dir>/hooks` as its absolute path, sorted by name) is non-empty:
- without `--replace-hooks`: print to stderr one `displaced: <item>` line per item in that order, followed by the existing refusal sentence unchanged (`pipeline-run.mjs:135`); make no write; exit 1.
- with `--replace-hooks`: after `core.hooksPath` is set successfully, print to stdout one `replaced: <item>` line per item in that order, followed by the existing `hook installed: <target>` line (`pipeline-run.mjs:143`); exit 0. When the install fails for that target, no `replaced:` line is printed for it.
A target with an empty displaced list MUST print no `displaced:` or `replaced:` line, with or without `--replace-hooks`. SCEN-HOOK-01 and SCEN-HOOK-02 semantics (`test/pipeline-run.test.mjs:235-274`) MUST keep holding.

#### Scenario: SCEN-PJ-05 refusal lists each displaced object first
- **WHEN** `install-hook <worktree>` runs on a worktree with `core.hooksPath=.husky` and an executable `.git/hooks/pre-commit`
- **THEN** exit is non-zero; stderr contains, in order, `displaced: core.hooksPath=.husky`, `displaced: <absolute path>/.git/hooks/pre-commit`, then the line `[pipeline-run] <worktree> already has hooks this install would displace: ...; re-run with --replace-hooks ...`; `core.hooksPath` is still `.husky` and `extensions.worktreeConfig` is not `true`
- **Verify:** node --test skills/paseo-pipeline/test/pipeline-run.test.mjs

#### Scenario: SCEN-PJ-06 approved replace lists each replaced object
- **WHEN** `install-hook --replace-hooks <worktree>` runs on the same worktree
- **THEN** exit is 0; stdout contains, in order, `replaced: core.hooksPath=.husky`, `replaced: <absolute path>/.git/hooks/pre-commit`, then `hook installed: <worktree>`; the worktree `core.hooksPath` ends in `paseo-pipeline/hooks/git`
- **Verify:** node --test skills/paseo-pipeline/test/pipeline-run.test.mjs

#### Scenario: SCEN-PJ-07 nothing to displace prints no audit lines
- **WHEN** `install-hook <worktree>` runs on a fresh worktree whose hooks dir holds only `.sample` files, then runs again, then runs with `--replace-hooks`
- **THEN** each run exits 0 and its output has `hook installed: <worktree>` and no line starting with `displaced:` or `replaced:`
- **Verify:** node --test skills/paseo-pipeline/test/pipeline-run.test.mjs

### Requirement: The pipeline Tools table documents profiles-check --json

The `## Tools` table in `skills/paseo-pipeline/SKILL.md` SHALL show the `--json` flag in the `profiles-check.mjs` row and state that it prints one JSON object with `roles`, `findings`, `advisories`, `ok`.

#### Scenario: SCEN-PJ-08 Tools row names --json and its keys
- **WHEN** the `## Tools` section of `skills/paseo-pipeline/SKILL.md` is read
- **THEN** the row whose first cell starts with `` `profiles-check.mjs `` contains `--json` and each of `roles`, `findings`, `advisories`, `ok`, and SKILL.md stays under the 10000-char budget
- **Verify:** node --test skills/paseo-pipeline/test/profiles-check.test.mjs skills/paseo-pipeline/test/docs.test.mjs
