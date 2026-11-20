## 1. Profile check
- [x] 1.1 Add `profiles-check.mjs` and its test | Verify: `node --test skills/paseo-pipeline/test/profiles-check.test.mjs`
- [x] 1.2 Document notes template, tool row and `Delegate:` field | Verify: `bash skills/paseo-pipeline/test/run-all.sh`

## 2. Role and handoff alignment (user selected A)
- [x] 2.1 Plan strict tester dispatch and interrupted handoff recovery | Verify: `node --test skills/paseo-pipeline/test/frontier.test.mjs`
- [x] 2.2 Align tester/worker/author/reviewer prompts, daily names and Tier 2 wrapper | Verify: `node --test skills/paseo-pipeline/test/role-handoff-docs.test.mjs`
- [x] 2.3 Deliver host profile update payload and verify lint without claiming live application | Verify: `node --test skills/paseo-pipeline/test/profiles-check.test.mjs`

## Evidence (2026-11-20)
- Strict planner regression: baseline new cases failed (2 failures); after fix `frontier.test.mjs` passed 37/37, including real CLI same-branch handoff and fresh attempt isolation.
- Profile checker: 10/10; documentation/payload checks: 3/3. `node skills/paseo-pipeline/profiles-check.mjs --config docs/agent-profiles.json` exited 0, `profiles ok (8 roles)`.
- Full suite: `bash skills/paseo-pipeline/test/run-all.sh` exited 0, 636/636, 0 failed/cancelled/skipped. Earlier prompt budget/wording failures were fixed without changing existing test thresholds.
- `openspec validate profiles-check --strict` exited 0; `git diff --check` exited 0.
- Live profiles NOT applied: daemon config writeback/overwrite semantics remain unverified. No config write, restart, merge or push. Payload-only delivery documented in `docs/agent-team.md`.
