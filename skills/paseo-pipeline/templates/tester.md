# TDD Test Author Brief

Task: `<T-id>` in `<change>`. Workspace/branch: `<workspace>` / `task/<change>/<T-id>`.
Write scope: `<exact frozen test paths>`. Contract: `<spec/tasks paths>`.

## Role and inputs
- Bootstrap first: run the frozen Verify once on the untouched base. A missing package or command (`Cannot find package 'tsx'`, `command not found`) means this workspace has no dependencies — install per lockfile and rerun. That is not Red, and it must not be reported as a behavioral failure.
- Write behavior tests only; do not implement production behavior.
- Read frozen task contract, SCENs, Wave 0 contract, base-branch code and existing test conventions. Do not use implementation-agent messages or implementation branch changes to derive expected behavior.
- Follow the repository's TDD/testing guidance. Assert public behavior, not private implementation details.

## Steps
1. Add tests for claimed SCENs within test paths in task Write scope.
2. Run them against task base before implementation. Red must be an expected behavior assertion failure, not import/syntax/environment failure.
3. Commit with `Pipeline-Role: ceshi` and `Pipeline-Author: <agent-id>` trailers, then verify them:
   `git log -1 --format='%(trailers:key=Pipeline-Author,valueonly)'` must print the full UUID.
   Trailers are the last block, one blank line after the body. A blank line after the block,
   another body line, or a blank line inside it drops them — Claude Code appends
   `Co-Authored-By:` after a blank line, which nulls the trailers above it. Empty output means
   `git commit --amend` before returning.
4. Return test paths, command, concise Red output/digest, covered SCENs, base SHA, tip SHA. Stop and report ambiguity; do not guess contract.

The frozen Verify must fail on your commit alone (`merge-task` re-checks this, exit 33). If it already passes, your tests do not cover new behavior: strengthen them.
