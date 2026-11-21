---
name: ship
description: One command, no arguments, no confirmation: merge the current branch into the default branch and push to GitHub origin (PR automatically when the default branch is protected), then offer one-shot cleanup of this branch, worktree and Paseo workspace. Use when the user says "ship", "合并到 main 并 push", "merge and push".
user-invocable: true
---

# Ship

Scope is the current branch, current worktree, current workspace. Other branches, worktrees and workspaces stay untouched.

`/ship` is the user's standing authorization (stop point 2 of `~/.claude/CLAUDE.md`) to merge into the default branch and push it to `origin`. Run straight through. Stop only on a failure listed under Stop.

## Steps

1. **Preflight.**
   - `<default>`: `git symbolic-ref --short refs/remotes/origin/HEAD`, minus `origin/`. `<source>`: current branch.
   - `<main-dir>`: the worktree holding `<default>` (`git worktree list`). Run every merge step as `git -C <main-dir>`; stay in the current checkout.
   - `git fetch origin`. Behind `origin/<default>`: `git -C <main-dir> merge --ff-only origin/<default>`.
   - `<source>` = `<default>`: ahead of `origin/<default>` → verify (step 2), push (step 5), done. Not ahead → "nothing to ship", end.
   - Tracked changes in `<source>`: on a feature branch, make one atomic commit (`feat:` / `fix:` / `docs:` / `refactor:` verb phrase, `Co-Authored-By` trailer). On `<default>`: Stop. Untracked files never block.
   - Mode: **PR** when `gh api repos/{owner}/{repo}/branches/<default>/protection` returns 200 or `gh api repos/{owner}/{repo}/rules/branches/<default>` is non-empty; otherwise **local**. Say which in the report.
2. **Verify.** Source tree has `docs/tier2-contract.md`: `pipeline-run.mjs tier2-verify <default>` at tip SHA; show reviewer `BLOCKED` / `NOT_MET` verbatim and Stop. Otherwise run the project's test command (`package.json`, `Makefile`, CLAUDE.md); none found → say so, continue.
3. **Rollback point.** `PRE=$(git -C <main-dir> rev-parse <default>)`. Print: before push `reset --hard $PRE`; after push `git revert -m 1 <merge-sha>`. Either needs the user's go.
4. **Merge.**
   - Local: `git -C <main-dir> merge --no-ff <source>` (trailer `Co-Authored-By: Claude Code <noreply@anthropic.com>`), rerun tests on the result. Conflict → `merge --abort`, Stop.
   - PR: `git push -u origin <source>`; open PR with body from `/pr` (reuse an open one: `gh pr view`); `gh pr checks --watch` green; `gh pr merge --merge`; then `git -C <main-dir> merge --ff-only origin/<default>` and rerun tests.
5. **Push** (local mode; PR mode is already on origin): `git -C <main-dir> push origin <default>`. Rejected → `git fetch`; origin only moved forward and merges clean → merge, re-verify, push once more. Second rejection or conflict → Stop.
6. **Evidence.** `git -C <main-dir> rev-parse <default> origin/<default>` match; merge SHA; PR or commit URL.
7. **Cleanup, one question.** Skip when `<source>` = `<default>`. List the items below with a number each and ask `y` (all) or numbers. Every `y` item runs; every item left out stays listed:
   1. remote branch: `git push origin --delete <source>` (when it exists on origin)
   2. Paseo workspace: `list_workspaces`, pick the entry whose `cwd` equals the current directory. Archive only when `kind=worktree`, no workspace has it as `parentWorkspaceId`, and `list_agents --cwd` shows no other `running` agent. Otherwise list the blocker and skip. Run last, after the report is printed, because the session may live inside it.
   3. linked worktree, when no Paseo workspace owns it: `git -C <main-dir> worktree remove <path>`
   4. local branch: `git -C <main-dir> branch -d <source>`; the worktree must be gone first (`git worktree list`). Gone not confirmed → report, keep the branch.

## Stop

Dirty `<default>`, failing check or test, conflict, `BLOCKED` / `NOT_MET`, second push rejection, refused PR merge. Report once with the output, then end the turn. No retry loop.

## Report

Mode, source, default, merge SHA, verify evidence, push or PR URL, cleanup result.
