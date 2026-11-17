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

## Operator reference

`plan`/`status` exit 3 means unreadable or ambiguous state or invalid tasks, not idle: repair the input, or pass a verified `--other-change <id>` for another change's agent. Done lines are written by the merge gate only.

Merge exit codes: 1 ordinary refusal; 2 usage; 3 post-merge record/cleanup failure (check Done before any retry); 10 conflict; 20 Verify; 21 regression (environment issue: fix the environment, keep Verify/tests frozen); 30 scope; 31 provenance; 34 base/drift; 35 dependency; 36 dependencies not installed; 37 retry cap (human approval, then `plan --allow-attempt-over <T-id>`); 38 test-infrastructure change (human approval, then `merge --allow-test-infra`, which releases that check only). Plan labels: `MERGE <T-id>`, `MERGE-WAIT <T-id>`.

Serialize merges. After an interrupted merge, inspect `MERGE_HEAD`, the worktree and refs; pending markers stay until the gate clears them.

Acceptance `run` executes repository-controlled commands unsandboxed: inspect commands and dependencies first; it writes external evidence and may expose secrets. `check` validates record consistency without executing. Neither proves authenticity or authorizes CP-2. Failed/blocked rows need a fix and fresh evidence.
