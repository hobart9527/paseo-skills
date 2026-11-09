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

## Hook installation safety (main session)

Before installation, inspect the effective `core.hooksPath` and existing hooks, including the default hooks directory. Installation enables `extensions.worktreeConfig` in shared repository config and sets `core.hooksPath` per target worktree, switching the entire hooks directory. If existing hooks would be displaced, stop and ask the human; never silently replace them. Obtain approval where required; existing approval covers only its stated scope. The hook stamps `Pipeline-Author` from `PASEO_AGENT_ID`; without it, valid trailers may still pass the merge gate, but automatic stamping is absent.

## Rules
- Read only from your packet: this brief, your task entry, claimed SCENs, cited spec sections, files in Write scope, and declared Reads. Read additional approved design or task-contract sections only when needed for your work; do not survey the repository or re-read unrelated history. The author must make required shared contracts reachable before dispatch. If required interface shape, behavior, or a decision is missing or ambiguous, return `blocked:` with the exact question and evidence rather than guessing.
- First run the frozen Verify once before changing anything. If it reports a missing package or command (`Cannot find package 'tsx'`, `command not found`), install the workspace dependencies per lockfile and rerun; that is an environment fault, not a test result. Never edit tests or the Verify command to get past it.
- The first Verify may be red, including for a file your task will create. Before delivery it must run and pass in your branch. If a required contract, permission, file, or other task's behavior is unavailable, return `blocked:` with evidence; a declared scope or `Reads` does not prove a file exists or was committed, and merge replay cannot replace worker Verify.
- Implement only the frozen behavior and only within Write scope. Do not touch files outside it; a merge with any out-of-scope file fails.
- Cover every SCEN this task claims. Exercise the code under test — load and run it (or render it); an assertion on production source text (`fs.readFileSync` + regex) does not prove behavior.
- If a required file falls outside scope, or the contract is ambiguous or contradicts existing code/tests, stop with `blocked: <reason>` and the exact evidence. Do not silently widen scope or guess the contract.
- Before committing, check that `$PASEO_AGENT_ID` is nonempty. If missing, return `blocked:` with the evidence; never `uuidgen` or type an ID. Commit with a `Pipeline-Role: <provided role>` trailer; the installed hook injects `Pipeline-Author` from `$PASEO_AGENT_ID`.
- After committing, verify the trailer survived:
  `git log -1 --format='%(trailers:key=Pipeline-Author,valueonly)'` must print your `$PASEO_AGENT_ID`.
  Trailers must be the last block of the message, separated from the body by exactly one blank
  line. Keep `Co-Authored-By:` in that same block, with no blank lines between trailers; otherwise
  Git may not parse the earlier trailers. If the check fails, return `blocked:` with the evidence
  and request human authorization before any `git commit --amend` or other history rewrite; do not
  return a tip that fails this check as complete.

## Return envelope
`task`, `branch`, `base`, `tip`, `verify`, `verify_result`, `SCENs`, `blocked`, `commits`.
