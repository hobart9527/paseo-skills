# Recovery and Approval

## FINAL after round 2

For unresolved `NOT_MET` or `UNVERIFIABLE` after two FINAL rounds, human chooses one:

- **Accept:** record `FINAL: human-accept(@<sha>)` in `review.md`, residual risk in `rulings.md`, and `Approval: FINAL residual risk accepted for <sha> — <reason>` in `run-log.md`.
- **New change:** reopen at contract level with delta R0 and CP-1; permit one repair wave and one reopen delta review. No further reopen.
- **Terminate:** stop change.

No unbounded repair loop. A `DEVIATION` may enter one batched repair wave; contract/requirement gaps need human disposition before CP-2. Keep evidence bound to reviewed SHA. Run acceptance check at that SHA before record-only commits; only `review.md`, `rulings.md`, and `run-log.md` may change afterward. CP-2 remains human.

## Destructive or production action

Use before deploy, `archive_workspace`, branch/worktree deletion, `/tmp` cleanup, or production database read.

List every object: workspace ID, branch, host path and exact command, including transitively affected objects. For cleanup, use `pipeline-run.mjs cleanup <change-dir>` output. Ask separately per object class; record approval verbatim in `run-log.md`:

```text
Approval: <ISO timestamp> <user's exact words>
Object: <exact object id>
Command: <exact command>
Executor: <named person or agent>
```

After resume, reread approval records. Changed object or command needs new approval. Never force deletion. Push and history rewrite need their own approval even when cleanup was approved.
