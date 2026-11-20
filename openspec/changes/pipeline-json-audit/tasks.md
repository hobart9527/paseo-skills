# Tasks

## 1. Behaviour slices (wave 0)

- [x] 1.1 T-01 profiles-check `--json` prints one JSON object (`roles`, `findings`, `advisories`, `ok`); text mode and exit codes stay byte-identical
  - Done: source=2f803dd review=worker
  - Depends on: none
  - Write scope: skills/paseo-pipeline/profiles-check.mjs, skills/paseo-pipeline/test/profiles-check.test.mjs
  - Est: S
  - Review: standard
  - Verify with: node --test skills/paseo-pipeline/test/profiles-check.test.mjs
  - Scenarios: SCEN-PJ-01, SCEN-PJ-02, SCEN-PJ-03, SCEN-PJ-04

- [x] 1.2 T-02 install-hook prints `displaced: <item>` lines before refusing and `replaced: <item>` lines after an approved `--replace-hooks`; SCEN-HOOK-01/02 stay green
  - Done: source=529003c review=worker
  - Depends on: none
  - Write scope: skills/paseo-pipeline/pipeline-run.mjs, skills/paseo-pipeline/test/pipeline-run.test.mjs
  - Est: S
  - Review: standard
  - Verify with: node --test skills/paseo-pipeline/test/pipeline-run.test.mjs
  - Scenarios: SCEN-PJ-05, SCEN-PJ-06, SCEN-PJ-07

## 2. Documentation (wave 1)

- [x] 2.1 T-03 SKILL.md Tools row shows `profiles-check.mjs --json` and its four keys, within the 10000-char budget (`test/docs.test.mjs:27`); test asserts the row
  - Done: source=5da7b5b review=worker
  - Depends on: T-01
  - Write scope: skills/paseo-pipeline/SKILL.md, skills/paseo-pipeline/test/profiles-check.test.mjs
  - Reads: skills/paseo-pipeline/test/docs.test.mjs
  - Est: S
  - Review: standard
  - Verify with: node --test skills/paseo-pipeline/test/profiles-check.test.mjs skills/paseo-pipeline/test/docs.test.mjs
  - Scenarios: SCEN-PJ-08

## 3. Integration (sink, verification-only)

- [x] 3.1 T-04 run the full suite and every acceptance row at the integrated tip; record commands, exit codes and tip SHA in the change's run-log, no product edits
  - Done: source=b959978 review=worker
  - Depends on: T-01, T-02, T-03
  - Write scope: openspec/changes/pipeline-json-audit/run-log.md
  - Est: S
  - Review: mechanical
  - Verify with: bash skills/paseo-pipeline/test/run-all.sh
