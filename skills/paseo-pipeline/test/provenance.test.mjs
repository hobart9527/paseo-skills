// Cherry-pick provenance lookup, exercised without a repository.
//
// The fail-closed branches matter more than the happy path: `merge-task` refuses to merge when
// `samePatchCommits` returns null, so a bug that returned `[]` instead would silently accept a
// hand-recreated commit. These tests pin that contract with an injected git.
import test from 'node:test';
import assert from 'node:assert/strict';
import { samePatchCommits, patchIdOf } from '../lib/provenance.mjs';

const SELF = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SIBLING = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const UNRELATED = 'cccccccccccccccccccccccccccccccccccccccc';
const PATCH = '1111111111111111111111111111111111111111';
const OTHER_PATCH = '2222222222222222222222222222222222222222';

// A fake git: `responses` maps the first argument to a handler returning a spawnSync-shaped result.
// The handler receives the spawn options so it can inspect stdin.
function fakeGit(handlers) {
  return (cwd, args, options = {}) => {
    const handler = handlers[args[0]];
    if (!handler) throw new Error(`unexpected git ${args.join(' ')}`);
    return handler(args, options);
  };
}

const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
const bad = () => ({ status: 1, stdout: '', stderr: 'boom' });

// Both `patch-id` calls carry stdin (the commit's own patch, then the log scan), so the two are
// told apart by the content of that stdin rather than by whether it is present.
const patchIds = (logIds, selfId = PATCH) => (args, options) =>
  ok(options.input.includes('log output') ? logIds : `${selfId} ${SELF}\n`);

test('patch-id differing, a git failure and a low buffer limit all return null', () => {
  // Baseline: the path-filtered scan succeeds and finds no sibling.
  const clean = fakeGit({
    'diff-tree': () => ok('src/a.mjs\0'),
    show: () => ok(`commit ${SELF}\n`),
    'patch-id': patchIds(`${PATCH} ${SELF}\n${OTHER_PATCH} ${UNRELATED}\n`),
    log: () => ok('log output\n'),
  });
  assert.deepEqual(samePatchCommits(SELF, { git: clean }), []);

  // 1. A git failure anywhere in the scan is unknown, not "no siblings".
  assert.equal(samePatchCommits(SELF, { git: fakeGit({
    'diff-tree': () => bad(),
  }) }), null);
  assert.equal(samePatchCommits(SELF, { git: fakeGit({
    'diff-tree': () => ok('src/a.mjs\0'),
    show: () => ok(`commit ${SELF}\n`),
    'patch-id': patchIds(''),
    log: () => bad(),
  }) }), null);

  // 2. No patch-id for the commit itself: cannot compare, so unknown.
  assert.equal(samePatchCommits(SELF, { git: fakeGit({
    'diff-tree': () => ok('src/a.mjs\0'),
    show: () => bad(),
  }) }), null);

  // 3. The log is at the buffer limit: the result may be truncated, so unknown.
  const atLimit = fakeGit({
    'diff-tree': () => ok('src/a.mjs\0'),
    show: () => ok(`commit ${SELF}\n`),
    'patch-id': patchIds(''),
    log: () => ok('x'.repeat(10)),
  });
  assert.equal(samePatchCommits(SELF, { git: atLimit, limit: 10 }), null);

  // 4. An unparseable patch-id line is not evidence of a sibling either way; it is dropped.
  const garbage = fakeGit({
    'diff-tree': () => ok('src/a.mjs\0'),
    show: () => ok(`commit ${SELF}\n`),
    'patch-id': patchIds('not-a-patch-id line\n'),
    log: () => ok('log output\n'),
  });
  assert.deepEqual(samePatchCommits(SELF, { git: garbage }), []);
});

test('a sibling with the same patch-id is reported, and an unrelated patch-id is not', () => {
  const git = fakeGit({
    'diff-tree': () => ok('src/a.mjs\0src/b.mjs\0'),
    show: () => ok(`commit ${SELF}\n`),
    'patch-id': patchIds(
      `${PATCH} ${SELF}\n${PATCH} ${SIBLING}\n${OTHER_PATCH} ${UNRELATED}\n`,
    ),
    log: () => ok('log output\n'),
  });
  assert.deepEqual(samePatchCommits(SELF, { git }), [SIBLING]);
});

test('patchIdOf takes the first field of the first line and null on failure', () => {
  const git = fakeGit({
    show: () => ok(`commit ${SELF}\n`),
    'patch-id': () => ok(`  ${PATCH}  ${SELF}\nsecond line\n`),
  });
  assert.equal(patchIdOf(SELF, { git }), PATCH);
  assert.equal(patchIdOf(SELF, { git: fakeGit({ show: () => bad() }) }), null);
});

test('a commit that touches no paths has no siblings to scan', () => {
  const git = fakeGit({
    'diff-tree': () => ok(''),
  });
  assert.deepEqual(samePatchCommits(SELF, { git }), []);
});
