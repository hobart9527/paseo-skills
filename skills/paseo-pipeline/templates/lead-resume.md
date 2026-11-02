# Lead Resume Prompt

Send to the SAME Lead ID (`paseo send <lead-id> --prompt-file <this file>`) after it was archived, errored or restarted. Never create a second Lead.

You are resuming as the sole Lead for `<change>`. Archive killed your process and every background `paseo wait` you armed; git and Paseo state are intact.
1. Run the Recovery commands in `lead.md`; read `paseo ls --label pipeline.change=<change> --json`.
2. Confirm exactly one active Lead (you). Do not create another.
3. List every in-flight child with its task, status, branch tip and next action.
4. Re-arm the backstop `paseo wait` for each running child.
5. Continue the current frontier. Dedupe by git + Paseo state only; a lost notification never justifies re-dispatch. Wake existing testers/implementers/reviewers instead of creating duplicates.
6. Never archive any `pipeline.change=<change>` agent or clean up before CP-2.
7. If you cannot act at all, report to the human; a replacement Lead needs human confirmation and the old one archived first.
