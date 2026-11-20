- 2026-11-20T15:31:26.752Z merge task=T-02 source=529003ce22e486400fd743401d71eeda36a93f7d verify="node --test skills/paseo-pipeline/test/pipeline-run.test.mjs" timing_ms={"verify":16103,"regression":7,"replayed":0,"total":16299}
- 2026-11-20T15:34:54.525Z merge task=T-01 source=2f803dd8c90d7a2ca5bce42b88ec854aba1ad679 verify="node --test skills/paseo-pipeline/test/profiles-check.test.mjs" timing_ms={"verify":748,"regression":8,"replayed":0,"total":948}
- 2026-11-20T15:53:53.696Z merge task=T-03 source=5da7b5b8ee5cfe6b03896c92354f0d29dfac7955 verify="node --test skills/paseo-pipeline/test/profiles-check.test.mjs skills/paseo-pipeline/test/docs.test.mjs" timing_ms={"verify":734,"regression":744,"replayed":1,"total":1730}

## T-04 integration verification — 2026-11-20T16:00Z

- Integrated tip (full SHA): `7ecec31e74758ba69924c02e8b35ffeb489b30c1` (`task/pipeline-json-audit/T-04`, T-01/T-02/T-03 merged)
- Agent: `ffe6e96c-b743-42de-ad36-7dcb54b5c73f`; role `gongbu`; write scope: this file only.

### Full suite

```
$ bash skills/paseo-pipeline/test/run-all.sh
exit 0
ℹ tests 694
ℹ pass 694
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

### Acceptance-row commands (frozen `Verify` cells, run separately)

| Row | Command | Exit | tests | pass | fail |
| --- | --- | --- | --- | --- | --- |
| SCEN-PJ-01..04 (+PJ-08 partial) | `node --test skills/paseo-pipeline/test/profiles-check.test.mjs` | 0 | 23 | 23 | 0 |
| SCEN-PJ-05..07 | `node --test skills/paseo-pipeline/test/pipeline-run.test.mjs` | 0 | 31 | 31 | 0 |
| SCEN-PJ-08 budget/token guard | `node --test skills/paseo-pipeline/test/docs.test.mjs` | 0 | 19 | 19 | 0 |

### Real-behaviour exercise (not only tests)

Fixture: temp dir with `config.json` holding one complete `agent_profile_gongbu` (family claude; harness claude; write; use; not; brief: none) and a one-role `SKILL.md`.

`--json` mode on the complete single-role fixture (exit 0):

```
{"roles":["gongbu"],"findings":[],"advisories":[],"ok":true}
```

`--json` mode against the real 9-role `SKILL.md` with the one-profile config (exit 1, `findings` populated, stderr empty):

```
{"roles":["chanpin","hanlin","ceshi","gongbu","gaogong","jiangzuo","anchasi","neon","shangshu"],"findings":["MISSING_PROFILE chanpin (agent_profile_chanpin)","MISSING_PROFILE hanlin (agent_profile_hanlin)","MISSING_PROFILE ceshi (agent_profile_ceshi)","MISSING_PROFILE gaogong (agent_profile_gaogong)","MISSING_PROFILE jiangzuo (agent_profile_jiangzuo)","MISSING_PROFILE anchasi (agent_profile_anchasi)","MISSING_PROFILE neon (agent_profile_mvvzv70y_bweu1x85oc9)","MISSING_PROFILE shangshu (agent_profile_shangshu)"],"advisories":[],"ok":false}
```

Text mode (no `--json`), same real 9-role input (exit 1) — unchanged text form, same finding lines one per line, no JSON:

```
MISSING_PROFILE chanpin (agent_profile_chanpin)
MISSING_PROFILE hanlin (agent_profile_hanlin)
MISSING_PROFILE ceshi (agent_profile_ceshi)
MISSING_PROFILE gaogong (agent_profile_gaogong)
MISSING_PROFILE jiangzuo (agent_profile_jiangzuo)
MISSING_PROFILE anchasi (agent_profile_anchasi)
MISSING_PROFILE neon (agent_profile_mvvzv70y_bweu1x85oc9)
MISSING_PROFILE shangshu (agent_profile_shangshu)
```

Text mode on the complete single-role fixture (exit 0): `profiles ok (1 roles)`

Usage error `--json --skill /nonexistent --config /nonexistent`: exit `2`, stdout `0` bytes, stderr:

```
Usage: profiles-check.mjs [--skill SKILL.md] [--config ~/.paseo/config.json] [--root repo]
ENOENT: no such file or directory, open '/nonexistent'
```

### `install-hook` displacement (throwaway temp repo under `$TMPDIR`, executable `.git/hooks/pre-commit`; never against this workspace)

Before install: `.git/hooks/pre-commit` present, mode `-rwxr-xr-x`.

Refusal (`install-hook <tmpdir>`, no flags) — exit `1`, stdout empty, stderr:

```
displaced: /var/folders/rb/9mmkr1ln6wjblh9f5cp466fh0000gn/T/t04-hook2.akFANw/.git/hooks/pre-commit
[pipeline-run] /var/folders/rb/9mmkr1ln6wjblh9f5cp466fh0000gn/T/t04-hook2.akFANw already has hooks this install would displace: /var/folders/rb/9mmkr1ln6wjblh9f5cp466fh0000gn/T/t04-hook2.akFANw/.git/hooks/pre-commit; re-run with --replace-hooks after confirming replacing them is intended
```

After refusal `core.hooksPath` was unset (nothing written).

Approved replacement (`install-hook <tmpdir> --replace-hooks`) — exit `0`, stderr empty, stdout:

```
replaced: /var/folders/rb/9mmkr1ln6wjblh9f5cp466fh0000gn/T/t04-hook2.akFANw/.git/hooks/pre-commit
hook installed: /var/folders/rb/9mmkr1ln6wjblh9f5cp466fh0000gn/T/t04-hook2.akFANw
```

After install `git config --worktree --get core.hooksPath` returned the pipeline hooks dir under the workspace (`.../skills/paseo-pipeline/hooks/git`).

### Notes

- No product edits; no failures in any command above.
- Repo `.git/hooks` already held other hooks in the earlier (first) temp-repo run and both paths behaved identically; the recorded output is from the second, clean temp repo.
- 2026-11-20T16:04:05.336Z merge task=T-04 source=b9599781cb6d888dbe8463b813e993e244b03ba4 verify="bash skills/paseo-pipeline/test/run-all.sh" timing_ms={"verify":32978,"regression":8,"replayed":0,"total":33161}

## CP-2 merge and cleanup, after main moved

Approval: 2026-11-20T16:27:16.716Z 合入 main 并清理 worktree
Object: integration/pipeline-json-audit -> main (CP-2 merge)
Command: git merge --no-ff main under .claude/worktrees/integration-pipeline-json-audit; then git merge --ff-only integration/pipeline-json-audit in the primary checkout
Executor: main session

`main` had moved `7e20375` -> `aba7238` (another session) after CP-2, so the approved fast-forward became a real merge.
One content conflict, `skills/paseo-pipeline/SKILL.md`: kept main's rewritten sections, re-applied this change's
`--json` Tools row (with the "not independence/sandbox proof" caveat main's copy also lacked). SKILL.md 9591 chars.
Merged main = `936efe9`. Rollback point before this merge = `aba7238` (`git reset --hard aba7238` on main).

Post-merge evidence at `936efe9`:
- `bash skills/paseo-pipeline/test/run-all.sh` exit 0, 684/684 pass.
  main alone was 673; +11 are this change's new tests (pipeline-run +4, profiles-check +7).
  The reviewed tip's 694 is higher because main's `aba7238` rewrote `tier-gate.test.mjs`/`tier-gate-friction.test.mjs` (-24 tests there).
- All three frozen Verify commands re-run at the merged SHA, exit 0:
  `profiles-check.test.mjs` 23/23, `pipeline-run.test.mjs` 31/31, `profiles-check+docs` 42/42.
- `acceptance run --source 936efe9` refuses ("integration branch changed"): the recorded source SHA must be on
  `integration/<change>`, which no longer exists as a distinct tip after the merge. Same operator limitation noted
  in the resume file; the per-row Verify commands above are the substitute evidence.

Cleanup objects (all merged into main, all worktrees clean):

```text
Object: git worktree remove .claude/worktrees/integration-pipeline-json-audit
Object: git worktree remove .claude/worktrees/task-pipeline-json-audit-T-01
Object: git worktree remove .claude/worktrees/task-pipeline-json-audit-T-02
Object: git worktree remove .claude/worktrees/task-pipeline-json-audit-T-03
Object: git worktree remove .claude/worktrees/task-pipeline-json-audit-T-04
Object: git worktree remove .claude/worktrees/authors+pipeline-json-audit
Object: git worktree remove .claude/worktrees/final-pipeline-json-audit
Object: git branch -d integration/pipeline-json-audit
Object: git branch -d task/pipeline-json-audit/T-01
Object: git branch -d task/pipeline-json-audit/T-02
Object: git branch -d task/pipeline-json-audit/T-03
Object: git branch -d task/pipeline-json-audit/T-04
Object: git branch -d worktree-authors+pipeline-json-audit
Command: as listed; `git branch -d` (safe form) only, never -D
Executor: main session
```

`fix-neon-f1-f7` belongs to the earlier 7-BLOCKER branch and is out of this cleanup.

## Evidence persisted

`evidence/acceptance-bb608bf.json` is the `acceptance run --execute` record from the reviewed SHA
`bb608bff7d03f2ecaadcbf3787e5c8a2545e821a`: `valid: true`, 8 rows, every row exit 0. Copied here from
`/tmp/acceptance-pipeline-json-audit.txt` before `/tmp` is cleared; the JSON embeds the frozen matrix
and each row's stdout.
