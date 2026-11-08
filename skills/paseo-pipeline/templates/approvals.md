# Destructive-Step Approval Checklist

Use before any destructive or production step: deploy, `archive_workspace`, branch/worktree deletion,
`/tmp` cleanup, production database read.

1. **Object list, not a summary.** One line per object, with the exact command that will touch it:
   ```
   - workspace <workspace-id>  branch <branch>  host path <path>  → paseo archive_workspace(...)
   - branch <branch> (tip <sha>)  → git branch -d <branch>
   - path <host-path>  → git worktree remove <host-path>
   ```
   Include every object the command reaches transitively; an omitted object is a new approval.
   For CP-2 cleanup, take the list verbatim from `pipeline-run.mjs cleanup <change-dir>`
   (`--json` for the same objects): one `paseo-workspace`, `git-worktree` or `branch` object
   per line, each with its own exact `command`. An object is covered only by its own
   `Approval:` block naming exactly one `Object:` (workspace id, branch name or absolute host
   path) and one exactly equal `Command:`. A stale registration whose directory is gone is an
   ordinary `git-worktree` object removed individually with `git worktree remove <path>`; a
   dirty or locked worktree refuses, and that refusal is reported as failed, never forced
   (`-D`, `--force`) and never replaced with `rm -rf`.
2. **Ask.** State what is irreversible, what is archived versus deleted, and what is pushed. Never
   bundle two object classes in one question.
3. **Record the approval verbatim** in `openspec/changes/<change>/run-log.md`, one block per
   object:
   ```
   Approval: <ISO timestamp> <the user's words, unedited>
   Object: <exact id, branch or path copied from step 1>
   Command: <the exact command>
   ```
   Do not paraphrase, translate or compress the user's words. `Object:` and `Command:` are
   compared literally: surrounding whitespace is ignored and matching backticks are stripped,
   nothing else. A block with more than one `Object:` or `Command:` line, or with either line
   missing, authorizes nothing.
4. **File wins.** After compaction or resume, re-read `run-log.md` instead of trusting the summary.
   Execute only objects and commands the record covers; if the list or command differs, re-ask.
   `cleanup --execute` appends one record per attempted object to the worktree `run-log.md`:
   ```
   Cleanup: <kind> <id> <command> <done|failed|skipped>[@<full-sha>]
   ```
   A re-run skips objects already recorded `done`. The record is evidence of what ran, not an
   approval. Approvals are read from this worktree
   file first (cleanup happens after CP-2, so committing them to integration would break the
   ancestry proof), the integration copy only when the worktree file is absent. If
   `integration/<change>` is already gone, `--merged-at <sha>` must equal the tip recorded
   on its `Cleanup: branch` done line — an unrecorded tip, or `main` itself, proves nothing.
5. Push and history rewrite need their own approval even when cleanup was approved.
