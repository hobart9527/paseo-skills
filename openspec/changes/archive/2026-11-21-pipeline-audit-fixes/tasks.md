## 1. Freeze gate parity for the full run (F-1)
- [ ] 1.1 Run the staged-specs Verify-line scan and the requirement-overlap advisory from the full run too, sharing one helper | Verify: `node --test test/freeze-check.test.mjs`

## 2. Planner attribution for stale or foreign agents (F-2)
- [ ] 2.1 Attribute a pipeline agent by label, title change id, or live change dir; treat an unresolvable non-running cwd as a diagnostic, keep exit 3 for ambiguous running agents | Verify: `node --test test/next-actions.test.mjs`

## 3. Tool guard null-as-inherit (F-3)
- [ ] 3.1 Accept an explicit `null` for `modeId`/`thinkingOptionId`/`features` when the profile sets none, and cover it with a regression test | Verify: `node --test test/tool-guard-hook.test.mjs`

## 4. R0 self-review block (F-4)
- [ ] 4.1 Block `R0_SELF_REVIEW` when the signer matches a `Pipeline-Author` on a contract commit reachable at the signed sha; stamp `Pipeline-Author` for `hanlin` in `commit-msg` | Verify: `node --test test/freeze-check.test.mjs`

## 5. Acceptance command integrity (F-5)
- [ ] 5.1 Reject a `Required=yes` Verify with an unquoted pipe, `||`, or a non-proving command at freeze, reusing the task leg/proves/fixture judgement | Verify: `node --test test/freeze-check.test.mjs`
- [ ] 5.2 Execute acceptance commands with `pipefail` so a red first leg is not masked | Verify: `node --test test/acceptance-run.test.mjs`

## 6. Role table, lint and brief agreement (F-6, repository side only)
- [ ] 6.1 Add the R0 reviewer role to the `SKILL.md` Roles table and the routing table, and extend `profiles-check.mjs` to check it; align the research-profile brief pointer; record the live-config migration note in the delivery report | Verify: `node skills/paseo-pipeline/profiles-check.mjs --root .`

## 7. Hook installer refusal (F-7)
- [ ] 7.1 Detect an existing non-pipeline `core.hooksPath` and non-sample executables in the default hooks dir, exit non-zero listing them, and require `--replace-hooks` | Verify: `node --test test/pipeline-run.test.mjs`
