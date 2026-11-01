# TDD Test Author Brief

Task: `<T-id>` in `<change>`. Workspace/branch: `<workspace>` / `task/<change>/<T-id>`.
Write scope: `<exact frozen test paths>`. Contract: `<spec/tasks paths>`.

## Role and inputs
- Write behavior tests only; do not implement production behavior.
- Read frozen task contract, SCENs, Wave 0 contract, base-branch code and existing test conventions. Do not use implementation-agent messages or implementation branch changes to derive expected behavior.
- Follow the repository's TDD/testing guidance. Assert public behavior, not private implementation details.

## Steps
1. Add tests for claimed SCENs within test paths in task Write scope.
2. Run them against task base before implementation. Red must be an expected behavior assertion failure, not import/syntax/environment failure.
3. Commit with `Pipeline-Role: ceshi` and `Pipeline-Author: <agent-id>` trailers.
4. Return test paths, command, concise Red output/digest, covered SCENs, base SHA, tip SHA. Stop and report ambiguity; do not guess contract.

The frozen Verify must fail on your commit alone (`merge-task` re-checks this, exit 33). If it already passes, your tests do not cover new behavior: strengthen them.
