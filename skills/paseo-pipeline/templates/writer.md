# Implementation Brief

Task: `<T-id>` in `<change>`. Branch/workspace: `<branch>` / `<workspace>`.
Contract: `<tasks.md + spec paths>`. Write scope: `<exact frozen scope>`.
Test-author commit/files: `<ceshi agent id + test paths>`. Frozen Verify: `<command>`.
Role trailer value: `<Lead-selected role>`.

## Rules
- Implement only frozen behavior and only within Write scope. Treat test-author commits as immutable; never alter their files.
- Confirm test-author's Red proof is committed. Implement the smallest behavior change, run frozen narrow Verify to Green, and add regression coverage only if permitted by scope and not editing test-author files.
- If a test contradicts frozen contract, return `blocked: TEST_DISPUTE` with exact evidence. Do not edit the disputed test; Lead asks Hanlin for one contract ruling.
- If required files fall outside scope or conflict with another task, stop with `BLOCKED_ON_CONFLICT` and paths. Do not silently amend scope.
- Commit with `Pipeline-Role: <provided role>` and `Pipeline-Author: <agent-id>` trailers.

## Return envelope
`task`, `branch`, `base`, `tip`, `verify`, `verify_result`, `SCENs`, `blocked`, `conflicting_tests`, `commits`.
