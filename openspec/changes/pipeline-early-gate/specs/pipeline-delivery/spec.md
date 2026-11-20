## ADDED Requirements

### Requirement: The pipeline role table and the code that recognizes roles stay in step
The role list in `skills/paseo-pipeline/SKILL.md` and the role patterns in `skills/paseo-pipeline/next-actions.mjs` SHALL name the same roles, and a test SHALL assert they agree. Fact: `skills/paseo-pipeline/SKILL.md:34` lists eight roles including 尚书 `shangshu`; `skills/paseo-pipeline/next-actions.mjs:247` did not recognize it as a non-worker role, so a `shangshu` agent failed the title check.

#### Scenario: SCEN-ROLE-01 A shangshu agent is recognized as a pipeline role
- **WHEN** an active agent is named `[Pipeline] shangshu FULL`
- **THEN** `next-actions.mjs` does not exit 3 on the title check
- **Verify:** `node --test skills/paseo-pipeline/test/next-actions.test.mjs`

#### Scenario: SCEN-ROLE-02 The two role lists are asserted equal
- **WHEN** the role list in `SKILL.md` is compared with the role patterns in `next-actions.mjs`
- **THEN** the test fails when a role appears in one and not the other
- **Verify:** `node --test skills/paseo-pipeline/test/next-actions.test.mjs`

### Requirement: The R0 reviewer does not repeat the author's baseline pass
`skills/paseo-pipeline/templates/reviewer.md` SHALL NOT require a baseline pass of the sink's Verify commands; the author records that baseline once and the reviewer reads it from the author's `## Baseline`. Fact: `skills/paseo-pipeline/templates/author.md:50` requires the author to record each exit code, so a second run in the reviewer brief repeated the same work in one package.

#### Scenario: SCEN-RBASE-01 reviewer.md no longer asks for the author's baseline pass
- **WHEN** `templates/reviewer.md` and `templates/author.md` are read
- **THEN** the baseline pass appears in the author brief only, and the reviewer brief says where the baseline comes from
- **Verify:** `node --test skills/paseo-pipeline/test/pipeline-friction-docs.test.mjs`

### Requirement: A dispatched agent's runtime settings match its profile
`skills/paseo-pipeline/hooks/tool-guard-hook.mjs` SHALL deny a `create_agent` call whose provider/model or `settings.modeId`, `settings.thinkingOptionId`, `settings.features` differ from the profile in `~/.paseo/config.json` that matches that provider/model, and the denial SHALL name the expected value and the actual value. When the call omits `settings.modeId` (or states `null`) and every profile sharing that provider/model agrees on one mode, the hook SHALL fill it rather than let the server reject the call. Fact: `skills/paseo-pipeline/hooks/tool-guard-hook.mjs:85` declared the three fields, but the check ran only on stated values (`:95` returned early when none were stated), so a stale mode passed silently and an omitted mode crossed provider boundaries unchecked.

#### Scenario: SCEN-DISP-04 A matching dispatch passes
- **WHEN** `create_agent` carries the provider/model, modeId, thinkingOptionId and features of its profile exactly
- **THEN** the hook allows the call unchanged
- **Verify:** `node --test skills/paseo-pipeline/test/tool-guard-hook.test.mjs`

#### Scenario: SCEN-DISP-05 A stale mode or thinking option is denied with both values named
- **WHEN** `create_agent` carries a `modeId` or `thinkingOptionId` that differs from the profile
- **THEN** the hook denies the call and the reason names the expected value and the actual value
- **Verify:** `node --test skills/paseo-pipeline/test/tool-guard-hook.test.mjs`

#### Scenario: SCEN-DISP-06 An omitted mode is filled from the profile instead of reaching the server
- **WHEN** a claude session sends `create_agent` for `antigravity/<model>` or `codex/<model>` without `settings.modeId`, and every profile sharing that provider/model sets one mode
- **THEN** the hook allows the call with `settings.modeId` set to that profile's mode
- **Verify:** `node --test skills/paseo-pipeline/test/tool-guard-hook.test.mjs`
