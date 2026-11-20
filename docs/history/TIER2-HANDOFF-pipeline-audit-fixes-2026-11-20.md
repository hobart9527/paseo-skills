# Tier 2 Handoff Brief — pipeline-audit-fixes (Neon audit F-1..F-7)

Filled from `docs/tier2-handoff-brief.md`. Serial slices only; no DAG, no Tier 3.

## Assignment

- **Workspace:** `/Users/hobart/Codex/paseo-skills/.claude/worktrees/fix-neon-f1-f7` (this linked worktree; the main session already entered it).
- **Branch:** `worktree-fix-neon-f1-f7`.
- **Base SHA:** `7ab98e8` (contract commits `08ae599` + `7ab98e8` on top of `d712ac6`). Re-read `git rev-parse HEAD` at start; the contract is already committed and must not be edited.
- **Delegate:** `gongbu` (开发/工部). Cross-module rework is not expected; seven narrow gate fixes in one skill package.
- **Testing:** owner — you write the tests and the implementation in each slice. No independent Red requested.
- **Requirements:** user accepted the Neon audit and chose serial execution on 2026-11-20 ("AAA"). Its verdict was `AUDIT: fail @d712ac6`; fix exactly these, nothing else:
  R1 full `freeze-check` must enforce `MISSING_SCEN_VERIFY` and `ADVISORY_REQ_OVERLAP` like `--stage specs` does (F-1).
  R2 `plan` must not exit 3 on a stale/foreign closed `[Pipeline]` agent whose worktree is deleted or in another repo (F-2).
  R3 `tool-guard-hook` must accept an explicit `null` optional setting as inherit (F-3).
  R4 R0 sign-off must be blocked when the signer is a `Pipeline-Author` of the signed contract commit, and `commit-msg` must stamp `Pipeline-Author` for `hanlin` (F-4).
  R5 a `Required=yes` acceptance Verify with an unquoted pipe / `||` / a non-proving command must be rejected at freeze, and `acceptance-run` must run with `pipefail` (F-5).
  R6 the R0 reviewer role must appear in `SKILL.md` Roles and be checked by `profiles-check.mjs`, resolving a non-`agent_profile_<role>` id through an explicit mapping; repository brief pointers must match each profile's `use:` boundary. Live `~/.paseo/config.json` and `~/.paseo/task-routing.md` are OUT of scope — record the edits they need in your report (F-6).
  R7 `install-hook` must refuse to displace an existing non-pipeline `core.hooksPath` or non-sample hooks, requiring `--replace-hooks` (F-7).
  Scope files: `skills/paseo-pipeline/{freeze-check.mjs,next-actions.mjs,pipeline-run.mjs,profiles-check.mjs,acceptance-run.mjs,SKILL.md}`, `skills/paseo-pipeline/hooks/{tool-guard-hook.mjs,git/commit-msg}`, and their tests under `skills/paseo-pipeline/test/`.
- **Authorization:** none for stop-point operations. "AAA" on 2026-11-20 selected serial Tier 2 execution, repo-only scope for F-6, and one real Tier 3 end-to-end run afterwards. No default-branch merge, push, deploy, migration, production write, amend, history rewrite or destructive cleanup. Commits on this linked non-default branch are pre-authorized.
- **Pending decisions:** none material. Defaults if a corner appears: keep every existing exit code and message unless the contract names a new one; prefer the smallest diff that makes the named test fail-before/pass-after.
- **Slices:** serial; each slice is its own commit(s). Contract scenarios are in `openspec/changes/pipeline-audit-fixes/specs/pipeline-audit/spec.md`.

  S1: R1 | `skills/paseo-pipeline/freeze-check.mjs`, `skills/paseo-pipeline/test/freeze-check.test.mjs` | no existing test asserts the full run skipping these; add regression tests | done evidence: new tests red on the current code, green after the change; `node --test test/freeze-check.test.mjs` exits 0 with the same or higher pass count.

  S2: R2 | `skills/paseo-pipeline/next-actions.mjs`, `skills/paseo-pipeline/test/next-actions.test.mjs` | no existing test asserts the stale-agent deadlock; add both SCEN-PLAN-01 and SCEN-PLAN-02 cases | done evidence: `node --test test/next-actions.test.mjs` exits 0.

  S3: R3 | `skills/paseo-pipeline/hooks/tool-guard-hook.mjs`, `skills/paseo-pipeline/test/tool-guard-hook.test.mjs` | if any existing test asserts a `null` deny, change it to assert allow and note it here | done evidence: `node --test test/tool-guard-hook.test.mjs` exits 0.

  S4: R4 | `skills/paseo-pipeline/freeze-check.mjs`, `skills/paseo-pipeline/hooks/git/commit-msg`, `skills/paseo-pipeline/test/freeze-check.test.mjs`, `skills/paseo-pipeline/test/author-hook.test.mjs` | no existing test locks in the self-review hole; add both SCEN-R0 cases | done evidence: both test files exit 0.

  S5: R5 | `skills/paseo-pipeline/freeze-check.mjs`, `skills/paseo-pipeline/acceptance-run.mjs`, `skills/paseo-pipeline/test/freeze-check.test.mjs`, `skills/paseo-pipeline/test/acceptance-run.test.mjs` | fixtures using `node -e "0"` and piped commands that must stay allowed are listed above; change only fixtures that the new rule correctly rejects, and say which | done evidence: both test files exit 0.

  S6: R6 | `skills/paseo-pipeline/SKILL.md`, `skills/paseo-pipeline/profiles-check.mjs`, `skills/paseo-pipeline/test/profiles-check.test.mjs` | existing `profiles ok (8 roles)` expectation changes to the new count; update it and say the new count | done evidence: `node --test test/profiles-check.test.mjs` exits 0 and `node skills/paseo-pipeline/profiles-check.mjs --root .` exits 0.

  S7: R7 | `skills/paseo-pipeline/pipeline-run.mjs`, `skills/paseo-pipeline/test/pipeline-run.test.mjs` | existing `install-hook` test expects a silent set on an empty hooks dir; keep it green under SCEN-HOOK-02 | done evidence: `node --test test/pipeline-run.test.mjs` exits 0.

  Final slice (verification only, no source): run `bash skills/paseo-pipeline/test/run-all.sh` and report the count; run `openspec validate pipeline-audit-fixes --strict` at the tip.

- **Size estimate:** 7 source files + 1 hook script + 6 test files; about 600 changed lines total; 120–180 minutes. Stop at >780 changed lines, a new mechanism, or a persistence/schema change: `BLOCKED (scope expansion)`.
- **Risk:** none. These are CLI gates and a hook; no auth/authorization/security boundary is changed, no cross-process concurrency primitive is added, no persistence/schema. The R0 self-review check is a gate strengthening, tested with evidence. If you find you must change auth semantics or a concurrency primitive, stop and report.
- **Contract:** `openspec/changes/pipeline-audit-fixes/`, `specs/pipeline-audit/spec.md` + `tasks.md`, `openspec validate pipeline-audit-fixes --strict` exits 0 at `7ab98e8`. Each scenario carries a `**Verify:**` line.

## Pre-dispatch check

- All required fields present; `Slices`, `Risk:`, `Contract:`, `Delegate:`, `Testing:`, `Authorization:`, `Pending decisions` all filled. Contract validates strictly.
- No must-pass test asserts a defect being fixed; the slices name every fixture that may need to change.
- No pending decision touches a risky operation, auth or money semantics.
- Repro already observed by the dispatcher: F-1 and F-5 reproduce on a throwaway package (full `--structural` run with no `**Verify:**` line and with `node --test test/a.test.mjs | tail -n 20` both exit 0); F-3 reproduces as a deny for `thinkingOptionId: null`; F-2's triggering shape is a live closed `[Pipeline]` agent whose worktree path no longer exists. F-4/F-7 were not reproducible from the dispatcher's worktree because the isolation guard blocks creating scratch git repos there — reproduce them yourself.

## Delivery and evidence

Return `COMPLETE | BLOCKED | INCOMPLETE`, base/tip full SHA, changed files and line counts, per-R evidence as `R<n>: <command> → exit <code>, <passed>/<total>`, the final full-suite count, the `openspec validate` result, the F-6 live-config migration note (exact edits needed in `~/.paseo/config.json` and `~/.paseo/task-routing.md`, not applied), and known gaps. A command not run is `UNVERIFIED: <reason>`.
