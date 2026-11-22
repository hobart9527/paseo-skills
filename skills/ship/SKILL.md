---
name: ship
description: One command, no arguments, no confirmation: merge the current branch into the default branch and push to GitHub origin (PR automatically when the default branch is protected), then offer one-shot cleanup of this branch, worktree and Paseo workspace. Use when the user says "ship", "合并到 main 并 push", "merge and push".
user-invocable: true
---

# Ship

Scope is the current branch, current worktree, current workspace. Other branches, worktrees and workspaces stay untouched.

`/ship` is the user's standing authorization (stop point 2 of `~/.claude/CLAUDE.md`) to merge into the default branch and push it to `origin`. Run straight through. Stop only on a failure listed under Stop.

## Steps

1. **Preflight (in `<source>`).**
   - `<default>`: `git symbolic-ref --short refs/remotes/origin/HEAD`, minus `origin/`. `<source>`: current branch.
   - `<main-dir>`: the worktree holding `<default>` (`git worktree list`). `<in-worktree>`: true when `git rev-parse --git-dir` differs from `git rev-parse --git-common-dir`.
   - Tracked changes in `<source>`: on a feature branch, make one atomic commit (`feat:` / `fix:` / `docs:` / `refactor:` verb phrase, `Co-Authored-By` trailer). On `<default>`: Stop. Untracked files never block.
   - Mode: **PR** when `gh api repos/{owner}/{repo}/branches/<default>/protection` returns 200 or `gh api repos/{owner}/{repo}/rules/branches/<default>` is non-empty; otherwise (including 404, empty rules, or HTTP 403 plan-gated/unavailable branch protection on private repos) **local**. Say which in the report.
2. **Verify (in `<source>` before exiting worktree).** When `<in-worktree>` and `<source>` touches `openspec/changes/<name>/` or exceeds Tier 1 (`>3` source files, `>=2` scopes, any `>=800-line` source file, or `>5` test files per `git diff --name-only <default>...HEAD`): run `node "${PIPELINE_HOME:-$HOME/.claude/skills/paseo-pipeline}/pipeline-run.mjs" tier2-verify <default>` at tip SHA (passing `--change-dir openspec/changes/<name>` when present, else `--auto-verify` or `--verify "<cmd>"`). If `REVIEW_REQUIRED`, require a recorded `PASS` at tip SHA (`pipeline-run.mjs record-review --mode tier2` / reviewer output) or explicit user acceptance in this session (quoted in the report); show any unaccepted reviewer `BLOCKED` / `NOT_MET` verbatim and Stop. Otherwise run the project's test command (`package.json`, `Makefile`, CLAUDE.md); none found → say so, continue.
3. **Return to `<main-dir>` (local mode when `<in-worktree>`).**
   - Worktree-isolated Claude Code sessions reject `cd <main-dir>` and `git -C <main-dir>`; never run or retry them from an isolated worktree.
   - Load `ExitWorktree` (via `ToolSearch` if deferred) and call `ExitWorktree` with `action: "keep"` so this session returns to `<main-dir>` on `<default>`. Verify `<main-dir>` is clean and on `<default>` (else Stop).
   - If `ExitWorktree` reports no active `EnterWorktree` session (launched directly in a worktree): do NOT push or deploy an unmerged `<source>` branch in place of `<default>`. When shipping is authorized, delegate the `<main-dir>` merge + push (with verified `<source>` tip SHA and the user's verbatim authorization) to a Paseo agent in `<main-dir>`, or report the exact `<main-dir>` command once and Stop.
4. **Sync & rollback point (in `<main-dir>`).**
   - `git fetch origin`. Behind `origin/<default>`: `git merge --ff-only origin/<default>`.
   - `<source>` = `<default>`: ahead of `origin/<default>` → push (step 6), done. Not ahead → "nothing to ship", end.
   - `PRE=$(git rev-parse <default>)`. Print: before push `reset --hard $PRE`; after push `git revert -m 1 <merge-sha>`. Either needs the user's go.
5. **Merge.**
   - Local (in `<main-dir>`): `git merge --no-ff <source>` (trailer `Co-Authored-By: Claude Code <noreply@anthropic.com>`), rerun tests on the result. Conflict → `merge --abort`, Stop.
   - PR (from `<source>`): `git push -u origin <source>`; open PR with body from `/pr` (reuse an open one: `gh pr view`); `gh pr checks --watch` green; `gh pr merge --merge`; then in `<main-dir>` run `git merge --ff-only origin/<default>` and rerun tests.
6. **Push** (local mode, in `<main-dir>`; PR mode is already on origin): `git push origin <default>`. Rejected → `git fetch`; origin only moved forward and merges clean → merge, re-verify, push once more. Second rejection or conflict → Stop.
7. **Evidence.** `git rev-parse <default> origin/<default>` match; merge SHA; PR or commit URL.
8. **Cleanup, one question.** Skip when `<source>` = `<default>`. List the items below with a number each and ask `y` (all) or numbers. Every `y` item runs; every item left out stays listed:
   1. OpenSpec change archive (when `openspec/changes/<name>/` belongs to `<source>` and `<default>` is merged): `openspec archive <name> -y` (add `--skip-specs` if no `specs/` directory) on `<main-dir>`, then commit the archived spec update on `<default>`.
   2. remote branch: `git push origin --delete <source>` (when it exists on origin)
   3. Paseo workspace: `list_workspaces`, pick the entry whose `cwd` equals the `<source>` worktree path. Archive only when `kind=worktree`, no workspace has it as `parentWorkspaceId`, and `list_agents --cwd` shows no other `running` agent. Otherwise list the blocker and skip. Run last, after the report is printed, if the session still lives inside it.
   4. linked worktree, when no Paseo workspace owns it: `git worktree remove <path>` (from `<main-dir>`)
   5. local branch: `git branch -d <source>` (from `<main-dir>`); the worktree must be gone first (`git worktree list`). Gone not confirmed → report, keep the branch.

## Stop

Dirty `<default>`, failing check or test, conflict, unaccepted `BLOCKED` / `NOT_MET`, second push rejection, refused PR merge, or non-exitable worktree without a `<main-dir>` delegate. Report once with the output, then end the turn. No retry loop.

## Report

Mode, source, default, merge SHA, verify evidence, push or PR URL, cleanup result.
