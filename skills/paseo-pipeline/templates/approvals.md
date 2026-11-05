# Destructive-Step Approval Checklist

Use before any destructive or production step: deploy, `archive_workspace`, branch/worktree deletion,
`/tmp` cleanup, production database read.

1. **Object list, not a summary.** One line per object, with the exact command that will touch it:
   ```
   - workspace <workspace-id>  branch <branch>  host path <path>  → paseo archive_workspace(...)
   - branch <branch> (tip <sha>)  → git branch -D <branch>
   - path <host-path>  → rm -rf <host-path>
   ```
   Include every object the command reaches transitively; an omitted object is a new approval.
2. **Ask.** State what is irreversible, what is archived versus deleted, and what is pushed. Never
   bundle two object classes in one question.
3. **Record the approval verbatim** in `openspec/changes/<change>/run-log.md`:
   ```
   Approval: <ISO timestamp> <the user's words, unedited>
   Objects: <ids/branches/paths copied from step 1>
   Command: <the exact command>
   ```
   Do not paraphrase, translate or compress the user's words.
4. **File wins.** After compaction or resume, re-read `run-log.md` instead of trusting the summary.
   Execute only objects and commands the record covers; if the list or command differs, re-ask.
5. Push and history rewrite need their own approval even when cleanup was approved.
