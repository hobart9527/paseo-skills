# Worker Brief

Task: `<T-id>` in `<change>`. Workspace/branch: `<workspace>` / `<branch>`.
Contract: `<tasks.md + spec paths>`. Write scope: `<exact frozen scope>`.
Frozen Verify: `<command>`. Scenarios: `<scenarios>`.
Role trailer value: `gongbu` (or the profile the main session selected).

You own the whole task: write the tests, write the implementation, and leave the
frozen Verify green. Tests and implementation may be written in either order — there
is no separate test author and no per-task reviewer. The final integrated review is
where quality is judged, so write tests that would catch the behaviour actually going
wrong, not tests that merely touch the code.

## Rules
- Read only from your packet: this brief, your task entry, claimed SCENs, cited spec sections, and files in scope. Read additional approved design or task-contract sections only when needed for your work; do not survey the repository or re-read unrelated history. The author must make required shared contracts reachable before dispatch. If required interface shape, behavior, or a decision is missing or ambiguous, return `blocked:` with the exact question and evidence rather than guessing.
- First run the frozen Verify once before changing anything. If it reports a missing package or command (`Cannot find package 'tsx'`, `command not found`), install the workspace dependencies per lockfile and rerun; that is an environment fault, not a test result. Never edit tests or the Verify command to get past it.
- Implement only the frozen behavior and only within Write scope. Do not touch files outside it; a merge with any out-of-scope file fails.
- Cover every SCEN this task claims. Exercise the code under test — load and run it (or render it); an assertion on production source text (`fs.readFileSync` + regex) does not prove behavior.
- If a required file falls outside scope, or the contract is ambiguous or contradicts existing code/tests, stop with `blocked: <reason>` and the exact evidence. Do not silently widen scope or guess the contract.
- Commit with `Pipeline-Role: <provided role>` and `Pipeline-Author: <agent-id>` trailers.
- After committing, verify the trailer survived:
  `git log -1 --format='%(trailers:key=Pipeline-Author,valueonly)'` must print your `$PASEO_AGENT_ID` (never `uuidgen` or a typed ID; a commit hook enforces it).
  Trailers must be the last block of the message, separated from the body by exactly one blank
  line. A blank line after the trailer block, another body line, or a blank line inside the
  block makes git drop them — and Claude Code appends `Co-Authored-By:` after a blank line,
  which nulls every trailer above it. If the check prints empty, `git commit --amend` with a
  corrected message before returning; do not return a tip that fails this check.

## Return envelope
`task`, `branch`, `base`, `tip`, `verify`, `verify_result`, `SCENs`, `blocked`, `commits`.
