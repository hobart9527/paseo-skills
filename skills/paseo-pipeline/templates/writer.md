# Implementation Brief

Task: `<T-id>` in `<change>`. Branch/workspace: `<branch>` / `<workspace>`.
Contract: `<tasks.md + spec paths>`. Write scope: `<exact frozen scope>`.
Test-author commit/files: `<ceshi agent id + test paths>`. Frozen Verify: `<command>`.
Role trailer value: `<Lead-selected role>`.

## Rules
- First run the frozen Verify once before changing anything. If it reports a missing package or command (`Cannot find package 'tsx'`, `command not found`), install the workspace dependencies per lockfile and rerun; that is an environment fault, not a test result. Never edit tests or the Verify command to get past it.
- Implement only frozen behavior and only within Write scope. Treat test-author commits as immutable; never alter their files.
- Confirm test-author's Red proof is committed. Implement the smallest behavior change, run frozen narrow Verify to Green, and add regression coverage only if permitted by scope and not editing test-author files.
- If a test contradicts frozen contract, return `blocked: TEST_DISPUTE` with exact evidence. Do not edit the disputed test; Lead asks Hanlin for one contract ruling.
- If required files fall outside scope or conflict with another task, stop with `BLOCKED_ON_CONFLICT` and paths. Do not silently amend scope.
- Commit with `Pipeline-Role: <provided role>` and `Pipeline-Author: <agent-id>` trailers.
- After committing, verify the trailer survived:
  `git log -1 --format='%(trailers:key=Pipeline-Author,valueonly)'` must print the full UUID.
  Trailers must be the last block of the message, separated from the body by exactly one blank
  line. A blank line after the trailer block, another body line, or a blank line inside the
  block makes git drop them — and Claude Code appends `Co-Authored-By:` after a blank line,
  which nulls every trailer above it. If the check prints empty, `git commit --amend` with a
  corrected message before returning; do not return a tip that fails this check.

## Return envelope
`task`, `branch`, `base`, `tip`, `verify`, `verify_result`, `SCENs`, `blocked`, `conflicting_tests`, `commits`.
