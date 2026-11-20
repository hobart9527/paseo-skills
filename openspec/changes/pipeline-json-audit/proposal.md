## Why

Two pipeline CLIs leave their callers guessing. `profiles-check.mjs` prints prose only, so the main session and scripts must scrape text to learn which roles were checked and what failed. `pipeline-run.mjs install-hook` refuses (or, with `--replace-hooks`, overwrites) without naming the hook objects it would displace, so a human cannot tell what an approval would destroy.

## What Changes

- R1: `profiles-check.mjs --json` prints exactly one JSON object on stdout with keys `roles` (role list), `findings` (string array), `advisories` (string array), `ok` (boolean), and nothing else on stdout.
- R1a: without `--json`, profiles-check text output and exit codes (0 / 1 / 2) stay byte-identical to the baseline.
- R2: `pipeline-run.mjs install-hook`, before refusing, prints one `displaced: <item>` line per displaced object (an existing non-pipeline `core.hooksPath`; each executable non-`.sample` file in the hooks dir), then the existing refusal sentence.
- R2a: after an approved `--replace-hooks`, install-hook prints one `replaced: <item>` line per object actually replaced, plus the existing `hook installed: <target>` line.
- R2b: install-hook SCEN-HOOK-01/02 semantics and the nothing-to-displace route stay unchanged.

## Capabilities

### New Capabilities
- `pipeline-json-audit`: machine-readable profiles-check output and install-hook displacement audit lines.

### Modified Capabilities

## Impact

`skills/paseo-pipeline/profiles-check.mjs`, `skills/paseo-pipeline/pipeline-run.mjs`, `skills/paseo-pipeline/SKILL.md` (Tools table rows only), and their two tests.

## Baseline

- `skills/paseo-pipeline/profiles-check.mjs:100-107`: the flag loop walks args in pairs and throws (exit 2) on any token other than `--skill`/`--config`/`--root` with a value, so a bare `--json` is a usage error today; R1 must teach the loop a boolean flag without loosening the pair check.
- `skills/paseo-pipeline/profiles-check.mjs:39-42`: `arg()` reads the token after a flag; `--json` must not be taken as another flag's value (the loop already rejects values starting with `--`).
- `skills/paseo-pipeline/profiles-check.mjs:108-110`: `roles` comes from `rolesOf()` (`:44-47`) in table order; `profiles` from `daemon.agentProfiles`; this is the `roles` key's source.
- `skills/paseo-pipeline/profiles-check.mjs:58-92`: `check()` already returns `{ findings, advisories }` as string arrays; R1 serialises them, it does not recompute.
- `skills/paseo-pipeline/profiles-check.mjs:111-114`: read/usage errors print `Usage: ...` to stderr and exit 2; under `--json` stdout stays empty there.
- `skills/paseo-pipeline/profiles-check.mjs:115-118`: text mode prints `ADVISE <advisory>` per advisory, then findings or `profiles ok (<n> roles)`, exit `findings.length ? 1 : 0`; R1a freezes this byte-for-byte.
- `skills/paseo-pipeline/pipeline-run.mjs:99-102`: `install-hook` parses only boolean `--replace-hooks`; targets default to cwd.
- `skills/paseo-pipeline/pipeline-run.mjs:111-132`: `displaced` collects `core.hooksPath=<value>` (non-pipeline path, `:113-116`) then each executable non-`.sample` file in `<git-common-dir>/hooks` as an absolute path, sorted (`:121-132`); this list is the item source for both `displaced:` and `replaced:` lines.
- `skills/paseo-pipeline/pipeline-run.mjs:134-137`: refusal prints one stderr sentence joining items with `, ` and sets `failed`; R2 prepends per-item `displaced:` lines and keeps this sentence unchanged.
- `skills/paseo-pipeline/pipeline-run.mjs:139-143`: install enables `extensions.worktreeConfig`, sets `core.hooksPath`, then prints `hook installed: <target>` on stdout; a failure `continue`s before that line, so `replaced:` lines belong after `:142` succeeds.
- `skills/paseo-pipeline/test/pipeline-run.test.mjs:235-274`: SCEN-HOOK-01/02 assert refusal names `.husky`/`pre-commit` and `--replace-hooks`, nothing written on refusal, and the samples-only/non-executable routes exit 0; R2b keeps them green untouched.
- `skills/paseo-pipeline/test/profiles-check.test.mjs:28-37`: `run()` spawns the real CLI with `--skill`/`--config`; new SCENs reuse the spawn path, not `check()` directly.
- `skills/paseo-pipeline/SKILL.md:46`: the `profiles-check.mjs` Tools row lists `[--skill F] [--config F]` only.
- `skills/paseo-pipeline/test/docs.test.mjs:27`: SKILL.md must stay under 10000 chars; at baseline it is 9986 (`node -e` length), so T-03 must shorten Tools-table wording to fit the `--json` text.
- Sink Verify on baseline `4d4aca9`: `bash skills/paseo-pipeline/test/run-all.sh` exit 0 (683 pass, 0 fail).

## OPEN-DECISION

None. Confirmed decisions supplied by the dispatcher brief (R1, R2, scope, Verify discipline).
