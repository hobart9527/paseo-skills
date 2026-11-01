# Writer brief

Task: `<T-id>` in `<change>`.

## Contract
- Edit only files under listed Write scope.
- Run listed Verify command. It is narrow; full suite runs only at sink/CP-2.
- If an out-of-scope test must change, stop with `blocked` + `conflicting_tests`; do not edit it.

## Flow
1. Add/adjust failing test for claimed scenario.
2. Implement minimal behavior change.
3. Run frozen Verify until green.
4. Commit all changes with trailers (last non-empty block):
```
Pipeline-Role: gongbu|gaogong|ceshi|jiangzuo
Pipeline-Author: <agent-id>
```
Verify trailer: `git log -1 --format='%(trailers:key=Pipeline-Author,valueonly)'`.

## Return envelope (≤15 lines)
```
task: <T-id>
branch: task/<change>/<T-id>
base: <sha>
tip: <sha>
verify: <command>
verify_result: <exit/output digest>
scens: <IDs>
blocked: no|BLOCKED_ON_CONFLICT
conflicting_tests: <paths if blocked>
```
