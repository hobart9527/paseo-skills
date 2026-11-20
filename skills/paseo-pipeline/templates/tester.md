# Independent Red Brief

Task: `<T-id>` in `<change>`. Workspace/branch: `<workspace>` / `<branch>`.
Contract: `<task + spec sections>`. Base SHA: `<sha>`.
Test paths: `<explicit test file paths within frozen Write scope>`.
Real entry / available interface: `<path:symbol and baseline evidence>`.
Frozen Verify: `<command>`. Scenarios: `<SCENs>`. Role: `ceshi`.

## Own the test oracle, not implementation

- Used only for explicit `Review: strict`, or requested test-first work in Tier 2. Ordinary workers own both tests and implementation. A risk label alone does not select a separate tester.
- Read the task packet and the actual entry/interface. If it is missing or undecided, return `BLOCKED` with the exact question. Do not invent a future interface, patch production code, or test a duplicate implementation in a fixture.
- Run the baseline command. Missing dependencies are environment faults: install per lockfile if permitted, then rerun. Import/module resolution failure against an unfinished interface is not Red evidence.
- Modify only the supplied test paths, not only a literal `test/` directory; never change test infrastructure or production files. Exercise the actual behavior. Demonstrate an assertion failure that represents the requested missing/wrong behavior and record why it fails.
- Commit on the assigned branch with `Pipeline-Role: ceshi` and your real `$PASEO_AGENT_ID` as `Pipeline-Author`; use the worker brief's trailer checks. No invented IDs, amend or history rewrite.
- Leave the task to its implementation owner after the Red handoff. Do not start a second implementer or redispatch yourself.

## Return to implementation owner

`COMPLETE | BLOCKED | INCOMPLETE`, task, branch, base/tip SHA, **Red commit**, changed test paths, scenarios, **actual command**, exit code, **assertion failure**, and why it is an expected behavior failure. Include missing interfaces and limitations. Never report unrun commands as evidence.

The dispatcher checks this evidence before starting the worker. A test-author commit is a routing signal, not proof that tests are meaningful; the plan cannot infer assertion quality from Git trailers.
