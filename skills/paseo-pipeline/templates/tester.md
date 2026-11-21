# Independent Red Brief

Task: `<T-id>` in `<change>`. Workspace/branch: `<workspace>` / `<branch>`.
Contract: `<task + spec sections>`. Base SHA: `<sha>`.
Test paths: `<explicit test file paths within frozen Write scope>`.
Real entry / available interface: `<path:symbol and baseline evidence>`.
Frozen Verify: `<command>`. Scenarios: `<SCENs>`. Role: `ceshi`.

## Own the test oracle, not implementation

- Used only for explicit `Review: strict`, or requested test-first work in Tier 2. Ordinary workers own both tests and implementation. A risk label alone does not select a separate tester.
- Read the task packet and the actual entry/interface. If it is missing or undecided, return `BLOCKED` with the exact question. Do not invent a future interface, patch production code, or test a duplicate implementation in a fixture.
- Run the baseline command. Missing dependencies are environment faults: install per lockfile if permitted, then rerun. Missing module/file paths or test syntax errors are not Red evidence; when verifying a newly specified export/method on an existing target module, an explicit assertion (`assert.equal(typeof target.newFn, 'function')`) or direct call failure that pins the missing capability is valid Red evidence.
- Modify only the supplied test paths, not only a literal `test/` directory; never change test infrastructure or production files. Exercise the actual behavior. Demonstrate an assertion failure that represents the requested missing/wrong behavior and record why it fails.
- Stage and commit Red test files ONLY on the assigned branch with `Pipeline-Role: ceshi` and your real `$PASEO_AGENT_ID` as `Pipeline-Author` (no invented IDs, `--amend`, or history rewrite; do NOT run `worker-check` on failing Red tests). If a linked-worktree sandbox blocks `.git/worktrees` commit writes, leave Red test files cleanly staged (`git add`) and return the staged paths, Red test output, and your `$PASEO_AGENT_ID` so the coordinator commits via `PASEO_AGENT_ID=<ceshi-uuid>`. Do not bypass hooks.
- Leave the task to its implementation owner after the Red handoff. Do not start a second implementer or redispatch yourself.

## Return to implementation owner

`COMPLETE | BLOCKED | INCOMPLETE`, task, branch, base/tip SHA, **Red commit**, changed test paths, scenarios, **actual command**, exit code, **assertion failure**, and why it is an expected behavior failure. Include missing interfaces and limitations. Never report unrun commands as evidence.

The dispatcher checks this evidence before starting the worker. A test-author commit is a routing signal, not proof that tests are meaningful; the plan cannot infer assertion quality from Git trailers.
