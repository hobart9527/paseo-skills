# Worker Brief

Task: `<T-id>` in `<change>`. Workspace/branch: `<workspace>` / `<branch>`.
Contract: `<tasks.md + spec paths>`. Write scope: `<exact frozen scope>`.
Frozen Verify: `<command>`. Scenarios: `<scenarios>`.
Role trailer value: `gongbu` (or the profile the main session selected).

You own the task: write tests and implementation, then leave frozen Verify green.
Either order is allowed. Test the behavior that could go wrong, not mere code contact.
If a `ceshi` Red commit is already on the branch (recorded as `Red commit SHA` in the dispatch context), those test files are an immutable oracle: make them pass without modifying `ceshi`-authored test paths. If assertions contradict the contract, report the precise conflict (`blocked:`) rather than weakening assertions.

## Rules
- Follow `SKILL.md` and this task's frozen contract; read only your packet (this brief, task entry, claimed SCENs, cited spec sections, Write scope, and declared Reads). Do not survey unrelated repo history. If a required contract/interface/decision is missing or ambiguous, stop with `blocked: <reason>`.
- First run the frozen Verify once before changing anything. If it reports a missing package or command (`Cannot find package 'tsx'`, `command not found`), install workspace dependencies per lockfile and rerun; that is an environment fault, not a test result. Never edit tests or Verify to get past it.
- Implement only the frozen behavior and only within Write scope. Do not touch files outside it; cover every claimed SCEN with real execution/rendering (an assertion on production source text via `fs.readFileSync` + regex does not prove behavior).
- In an isolated worktree, stay inside this workspace: use relative paths inside it; never run `cd <other-dir>`, `git -C <other-dir>`, or multi-directory `git` shell pipelines.
- Before committing, ensure `$PASEO_AGENT_ID` is nonempty (else `blocked:`), commit with `Pipeline-Role: <provided role>` (the git hook injects `Pipeline-Author`), keep trailers in one contiguous last block, and run `node "$PIPELINE_HOME"/pipeline-run.mjs worker-check <change-dir> <T-id>` (checks Write scope, trailers, `ceshi` Red-path immutability, and frozen Verify). Do not rewrite history without human authorization.
- Batch turns to minimize serial latency: issue independent Read/Grep calls together, batch related Edit/Write calls for a slice in one turn instead of single-edit ping-pong, and chain typecheck + tests in one Bash command (starting with an allowlisted command, using `npm --prefix <pkg>` instead of `cd <pkg> &&`, avoiding `VAR=...; echo` wrappers). Target ≤20 turns per slice.

## Return envelope
`task`, `branch`, `base`, `tip`, `verify`, `verify_result`, `SCENs`, `blocked`, `commits`.
