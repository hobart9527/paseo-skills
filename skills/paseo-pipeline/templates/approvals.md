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
   per line, each with its own exact `command`. That command is read-only — it lists and exits;
   the human runs each listed command by hand after approval. A stale registration whose
   directory is gone is an ordinary `git-worktree` object removed individually with `git
   worktree remove <path>`; a dirty or locked worktree refuses, and that refusal is reported,
   never forced (`-D`, `--force`) and never replaced with `rm -rf`. The listing marks a dirty
   worktree, an unreadable one, an unreadable merge marker (exit 3), and for each branch the
   reference `git branch -d` will actually check — its configured upstream, or `HEAD` when it
   has none — plus any worktree registration still holding it, since that alone makes `-d`
   refuse. Delete a holding worktree before its branch.
2. **Ask.** State what is irreversible, what is archived versus deleted, and what is pushed. Never
   bundle two object classes in one question.
3. **Record the approval verbatim** in `openspec/changes/<change>/run-log.md`, one block per
   object:
   ```
   Approval: <ISO timestamp> <the user's words, unedited>
   Object: <the object's exact id copied from step 1>
   Command: <the exact command>
   ```
   Do not paraphrase, translate or compress the user's words. The record is evidence of what
   was approved. Nothing reads it back automatically, so after compaction or resume re-read it
   instead of trusting the summary, and re-ask if the object list or a command differs.
4. **You run it.** After approval, run exactly the recorded commands, one object at a time.
   Never force, and never widen a command to cover an object it did not name.
5. Push and history rewrite need their own approval even when cleanup was approved.
