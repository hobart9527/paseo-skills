---
name: ship
description: One command, no arguments, no confirmation: merge the current branch into the default branch and push to GitHub origin (PR automatically when the default branch is protected), then ask once to clean up branch, worktree, OpenSpec change, and Paseo workspace. Use when the user says "ship", "合并到 main 并 push", "merge and push".
user-invocable: true
---

# Ship

Goal: merge the current branch into `<default>`, push to `origin`, then ask once to clean up trailing state. Other branches/worktrees stay untouched.

`/ship` is standing authorization to merge `<source>` into `<default>` and push `origin`. Run straight through; only pause on an exception under **Exceptions & Options**.

## Flow

1. **Preflight (in `<source>`).**
   - `<default>`: `git symbolic-ref --short refs/remotes/origin/HEAD` minus `origin/`. `<source>`: current branch.
   - `<main-dir>`: worktree holding `<default>` (`git worktree list`). `<in-worktree>`: `git rev-parse --git-dir` differs from `--git-common-dir`.
   - On feature branch with tracked changes: make one atomic commit (`feat:`/`fix:`/`docs:`/`refactor:`, `Co-Authored-By` trailer). On `<default>`: skip merge, go to push if ahead of `origin/<default>`, else end ("nothing to ship"). Untracked files never block.
   - Mode: **PR** if `gh api repos/{owner}/{repo}/branches/<default>/protection` returns 200 or `gh api repos/{owner}/{repo}/rules/branches/<default>` is non-empty; otherwise (including 404, empty rules, or HTTP 403 on private repos) **local**.
   - **Local-mode early read-only check**: if `<in-worktree>`, inspect `<main-dir>` read-only (current branch & `git status --porcelain`) before heavy work. If `<main-dir>` is dirty or not on `<default>`, go straight to **Exceptions & Options** (check file overlap first).

2. **Verify (in `<source>` at tip SHA).**
   - When `<in-worktree>` and `<source>` touches `openspec/changes/<name>/` or exceeds Tier 1 (`>3` source files, `>=2` scopes, any `>=800-line` source file, or `>5` test files per `git diff --name-only <default>...HEAD`): run `node "${PIPELINE_HOME:-$HOME/.claude/skills/paseo-pipeline}/pipeline-run.mjs" tier2-verify <default>` (pass `--change-dir openspec/changes/<name>` if present, else `--auto-verify` or `--verify "<cmd>"`).
   - If `REVIEW_REQUIRED`: require a recorded `PASS` at tip SHA (`pipeline-run.mjs record-review --mode tier2`) or explicit user words in this session accepting the unreviewed commits / unaccepted `BLOCKED` / `NOT_MET` rows (quote verbatim in Report). **Invoking `/ship` alone is NOT acceptance of `BLOCKED` / `NOT_MET`.** If unaccepted, pause under **Exceptions & Options**.
   - Otherwise run the project's test command (`package.json`, `Makefile`, `CLAUDE.md`; none found → note and continue).

3. **Merge & Push.**
   - **PR mode** (from `<source>`): `git push -u origin <source>`; open/reuse PR (`gh pr view` / `/pr`); `gh pr checks --watch`; `gh pr merge --merge`; then sync `<main-dir>` via `git merge --ff-only origin/<default>` (after returning to `<main-dir>`) and verify.
   - **Local mode** (in `<main-dir>`):
     - If `<in-worktree>`, load `ExitWorktree` (via `ToolSearch` if deferred) and call `ExitWorktree` with `action: "keep"` to return to `<main-dir>`.
     - If `ExitWorktree` returns `No-op` (launched directly in a worktree, or handle lost after compaction/restart): **do NOT push or deploy an unmerged `<source>` branch in place of `<default>`**. Delegate the `<main-dir>` merge + push (with verified `<source>` tip SHA and verbatim user authorization) to a Paseo agent in `<main-dir>`, or go to **Exceptions & Options** with the exact `<main-dir>` commands.
     - In clean `<main-dir>` on `<default>`: `git fetch origin`; if behind `origin/<default>`, `git merge --ff-only origin/<default>`; record `PRE=$(git rev-parse <default>)` (rollback: before push `reset --hard $PRE`; after push `git revert -m 1 <merge-sha>`); `git merge --no-ff <source>` (`Co-Authored-By: Claude Code <noreply@anthropic.com>`); rerun tests; `git push origin <default>` (if rejected only because origin moved forward, fetch, clean-merge, re-verify, push once more; second rejection or conflict → pause).
   - Confirm `git rev-parse <default>` matches `origin/<default>`.

4. **Cleanup (ask once after push succeeds).**
   - Skip if `<source>` = `<default>`. List only applicable items with numbers and ask `y` (run all) or numbers:
     1. OpenSpec archive (when `openspec/changes/<name>/` belongs to `<source>`): `openspec archive <name> -y` (`--skip-specs` if no `specs/`) on `<main-dir>`, then commit and push.
     2. Remote branch: `git push origin --delete <source>` (if on origin).
     3. Paseo workspace: `list_workspaces` matching `<source>` path; archive only when `kind=worktree`, no child workspace uses it as `parentWorkspaceId`, and `list_agents --cwd` shows no other `running` agent (run last if this session is inside it).
     4. Linked worktree (when not owned by a Paseo workspace): `git worktree remove <path>` from `<main-dir>`.
     5. Local branch: `git branch -d <source>` from `<main-dir>` (only after worktree removal is confirmed via `git worktree list`).

## Exceptions & Options

On any blocker — **dirty/wrong-branch `<main-dir>`**, **unaccepted `BLOCKED` / `NOT_MET` / missing tip `PASS`**, **failing test**, **merge/push conflict**, or **non-exitable worktree without a `<main-dir>` delegate** — stop without retrying in loops. Output:
1. **Blocker & impact** in 2–4 lines (e.g., dirty files in `<main-dir>` and whether they overlap `<source>`; verbatim `BLOCKED`/`NOT_MET` summary; deploy side effects if pushing `<default>` auto-deploys).
2. **2–3 concrete options** with one `(Recommended)`, e.g.:
   - Dirty `<main-dir>` (0 overlap): **A (Recommended)** Wait while user/other session commits or cleans `<main-dir>`, then reply to continue `/ship`; **B** Temporarily `stash` `<main-dir>` changes (only if no active writer is editing `<main-dir>`), merge & push, then `stash pop`; **C** Abort `/ship` and keep `<source>`.
   - Unaccepted `BLOCKED` / missing tip `PASS`: **A (Recommended)** Run reviewer (`anchasi`) at tip SHA first; **B** User explicitly confirms accepting the remaining risk/unreviewed delta to proceed; **C** Abort `/ship`.

## Report

Always print: Mode, source + tip SHA, default, merge SHA / PR URL, verify result, push status, rollback command, and cleanup status/prompt.
