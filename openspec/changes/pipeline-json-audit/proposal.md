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

## OPEN-DECISION

None. Confirmed decisions supplied by the dispatcher brief (R1, R2, scope, Verify discipline).
