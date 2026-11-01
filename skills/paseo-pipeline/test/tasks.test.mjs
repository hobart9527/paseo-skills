import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTasks, parseTaskLine, computeWaves, isFileWithinScopes, parseReviewTag, isTestPath, verifyLegs, needsReplay } from '../lib/tasks.mjs';

const md = `
- [ ] 1.1 T-01 contract
  - Write scope: src/shared
  - Verify with: node --test test/shared.test.mjs
- [ ] 1.2 T-02 alpha
  - Depends on: T-01
  - Write scope: src/alpha,test/alpha.test.mjs
  - Verify with: node --test test/alpha.test.mjs
  - Scen: SCEN-A
- [ ] 1.3 T-03 beta
  - Depends on: T-01
  - Write scope: src/beta,test/beta.test.mjs
  - Verify with: node --test test/beta.test.mjs
`;
test('parses tasks, dependencies and waves', () => {
  const { tasks, errors } = parseTasks(md);
  assert.equal(errors.length, 0);
  assert.equal(tasks.length, 3);
  assert.deepEqual(tasks[1].depends, ['T-01']);
  const waves = computeWaves(tasks);
  assert.deepEqual([...waves.get(1)], ['T-01']);
  assert.equal(waves.get(2).length, 2);
});
test('rejects graph and task errors', () => {
  const bad = '- [ ] 1.1 A-1 x\n  - Depends on: A-1\n  - Write scope: a\n  - Verify with: true\n- [ ] 1.2 A-1 y\n';
  const { errors } = parseTasks(bad);
  assert.ok(errors.some((e) => e.code === 'SELF_DEP'));
  assert.ok(errors.some((e) => e.code === 'DUPLICATE_ID'));
});
test('scope containment and review tag', () => {
  assert.equal(isFileWithinScopes('src/a/b.ts', ['src/a']), true);
  assert.equal(isFileWithinScopes('src/a-b.ts', ['src/a']), false);
  assert.equal(parseReviewTag('pass(01234567@abcdef0123/1234567)')?.tip, 'abcdef0123');
});

test('review tag accepts real Paseo ids: 7-char shortId and full UUID', () => {
  const short = parseReviewTag('pass(9b2f4c3@abcdef1/abcdef2)');
  assert.equal(short?.reviewer, '9b2f4c3');
  const uuid = parseReviewTag('pass(9b2f4c1e-3333-4a2b-8c3d-000000000003@abcdef1/abcdef2)');
  assert.equal(uuid?.reviewer, '9b2f4c1e-3333-4a2b-8c3d-000000000003');
  assert.equal(parseReviewTag('pass(9b2f4c3@abcdef1/abcdef2)')?.tip, 'abcdef1');
  assert.equal(parseReviewTag('pass(nope@abcdef1/abcdef2)'), null);
});

test('test paths cover pytest, Go, e2e and fixture layouts', () => {
  for (const file of ['pkg/test_foo.py', 'pkg/foo_test.py', 'src/foo_test.go', 'tests/x.py', 'e2e/login.e2e.ts', 'src/foo.test.ts', 'fixtures/a.json', 'testdata/x.json', 'src/__snapshots__/a.snap']) {
    assert.equal(isTestPath(file), true, file);
  }
  for (const file of ['src/contest.ts', 'src/latest.py', 'docs/testing.md']) {
    assert.equal(isTestPath(file), false, file);
  }
});

test('verify legs: paths decide narrowness, not runner names', () => {
  const narrow = [
    'node --test test/a.test.mjs',
    'go test ./pkg/a',
    'pnpm test src/b/b.test.ts',
    'npm test -- src/b/b.test.ts',
    'PYTHONPATH=runtime python3 -m pytest tests/x_test.py',
  ];
  for (const command of narrow) {
    assert.equal(verifyLegs(command).every((leg) => !leg.broad), true, command);
  }
  // `cargo test --test integration` and `cargo test -p crate` name a target, not a path.
  // They stay conservative (broad) rather than being guessed at.
  const broad = ['npm test', 'pytest', 'pytest -q', 'go test ./...', 'node --test', 'vitest run', 'make test', 'cargo test -p crate', 'cargo test --test integration'];
  for (const command of broad) {
    assert.equal(verifyLegs(command).some((leg) => leg.broad), true, command);
  }
  assert.deepEqual(verifyLegs('node --test test/a.test.mjs && npm test').map((leg) => leg.broad), [false, true]);
  assert.deepEqual(verifyLegs('go test ./pkg/a').map((leg) => leg.paths), [['pkg/a']]);
});

test('official task template is parser-compatible', () => {
  const { tasks, errors } = parseTasks('- [ ] 1.1 T-01 contract\n  - Depends on: none\n  - Write scope: src/a,test/a.test.mjs\n  - Verify with: `node --test test/a.test.mjs`\n');
  assert.deepEqual(errors, []);
  assert.equal(tasks.length, 1);
  assert.deepEqual(tasks[0].depends, []);
  assert.equal(tasks[0].verify, 'node --test test/a.test.mjs');
  assert.equal(parseTaskLine('- [x] 1.1 T-010 label').id, 'T-010');
});

test('Reads is parsed, optional, and must be repo-relative', () => {
  const body = (reads) => `- [ ] 1.1 T-01 a\n  - Write scope: src/a\n${reads}  - Verify with: node --test src/a/a.test.mjs\n`;
  assert.deepEqual(parseTasks(body('  - Reads: src/b, lib/x.mjs\n')).tasks[0].reads, ['src/b', 'lib/x.mjs']);
  assert.deepEqual(parseTasks(body('')).tasks[0].reads, []);
  assert.ok(parseTasks(body('  - Reads: ../etc\n')).errors.some((error) => error.code === 'BAD_READS'));
  assert.ok(parseTasks(body('  - Reads: /abs/path\n')).errors.some((error) => error.code === 'BAD_READS'));
});

test('needsReplay: dependency edge or footprint overlap, never a shared ancestor alone', () => {
  const { tasks } = parseTasks(`- [ ] 1.1 T-01 root\n  - Write scope: src/core\n  - Verify with: node --test src/core/c.test.mjs\n- [ ] 1.2 T-02 a\n  - Depends on: T-01\n  - Write scope: src/a\n  - Reads: src/b\n  - Verify with: node --test src/a/a.test.mjs\n- [ ] 1.3 T-03 b\n  - Depends on: T-01\n  - Write scope: src/b\n  - Verify with: node --test src/b/b.test.mjs\n- [ ] 1.4 T-04 c\n  - Depends on: T-01\n  - Write scope: src/c\n  - Verify with: node --test src/c/c.test.mjs\n`);
  const [root, a, b, c] = tasks;
  assert.equal(needsReplay(a, root, tasks), true, 'dependency edge');
  assert.equal(needsReplay(b, a, tasks), true, 'prior reads what this task writes');
  assert.equal(needsReplay(c, a, tasks), false, 'siblings sharing only an ancestor');
  assert.equal(needsReplay(c, b, tasks), false);
});

test('malformed checkbox lines are reported instead of silently ignored', () => {
  const { tasks, errors } = parseTasks('# Tasks\n- [ ] 1.1 missing ID\n');
  assert.equal(tasks.length, 0);
  assert.ok(errors.some((error) => error.code === 'MALFORMED_LINE'));
});
