import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../sync-check.mjs', import.meta.url));
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'sync-tester',
  GIT_AUTHOR_EMAIL: 'sync@test.local',
  GIT_COMMITTER_NAME: 'sync-tester',
  GIT_COMMITTER_EMAIL: 'sync@test.local',
};
delete env.NODE_TEST_CONTEXT;

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}
function write(cwd, file, text) {
  const full = path.join(cwd, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
}

function fixture({ conflict = false } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-check-'));
  const change = 'demo';
  git(cwd, ['init', '-q', '-b', 'main']);
  write(cwd, `openspec/changes/${change}/tasks.md`, `- [ ] 1.1 T-01 alpha
  - Write scope: src,test
  - Verify with: node --test test/a.test.mjs
`);
  write(cwd, 'test/a.test.mjs', `import test from 'node:test';
import assert from 'node:assert/strict';
test('passes', () => assert.equal(1, 1));
`);
  write(cwd, 'src/conflict.txt', 'base\n');
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-qm', 'base']);
  const base = git(cwd, ['rev-parse', 'HEAD']);

  // Integration branch diverges.
  git(cwd, ['switch', '-qc', `integration/${change}`]);
  write(cwd, 'src/conflict.txt', conflict ? 'integration\n' : 'base\n');
  write(cwd, 'src/integration.txt', 'integration\n');
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-qm', 'integration work']);
  const integration = git(cwd, ['rev-parse', 'HEAD']);

  // Task branch diverges from the same base.
  git(cwd, ['switch', '-qc', `task/${change}/T-01`, base]);
  write(cwd, 'src/conflict.txt', conflict ? 'task\n' : 'base\n');
  write(cwd, 'src/task.txt', 'task\n');
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-qm', 'task work']);
  const tip = git(cwd, ['rev-parse', 'HEAD']);

  // Step off the task branch so the linked worktree can check it out.
  git(cwd, ['switch', '-q', `integration/${change}`]);
  const worktree = path.join(cwd, 'task-wt');
  git(cwd, ['worktree', 'add', '-q', worktree, `task/${change}/T-01`]);
  return { cwd, change, base, integration, tip, worktree };
}

function run(worktree, integrationBranch, extra = []) {
  const result = spawnSync('node', [script, worktree, integrationBranch, ...extra], { env, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, out: `${result.stdout}${result.stderr}` };
}

test('sync-check: clean integration leaves the worktree clean and exits 0', () => {
  const { worktree } = fixture();
  const headBefore = git(worktree, ['rev-parse', 'HEAD']);
  const result = run(worktree, 'integration/demo', ['--json']);
  assert.equal(result.status, 0, result.out);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.deepEqual(report.conflicts, []);
  assert.equal(report.verify.status, 'passed');
  assert.equal(git(worktree, ['status', '--porcelain']), '');
  assert.equal(git(worktree, ['rev-parse', 'HEAD']), headBefore);
  // No merge state survives.
  const mergeHead = git(worktree, ['rev-parse', '--git-path', 'MERGE_HEAD']);
  assert.equal(fs.existsSync(path.resolve(worktree, mergeHead)), false);
});

test('sync-check: conflicts exit 2 and are reported without leaving a merge behind', () => {
  const { worktree } = fixture({ conflict: true });
  const headBefore = git(worktree, ['rev-parse', 'HEAD']);
  const result = run(worktree, 'integration/demo', ['--json']);
  assert.equal(result.status, 2, result.out);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.deepEqual(report.conflicts, ['src/conflict.txt']);
  assert.equal(git(worktree, ['status', '--porcelain']), '');
  assert.equal(git(worktree, ['rev-parse', 'HEAD']), headBefore);
});

test('sync-check: a failing Verify exits 3 and still restores the worktree', () => {
  const { worktree } = fixture();
  const headBefore = git(worktree, ['rev-parse', 'HEAD']);
  const result = run(worktree, 'integration/demo', ['--json', '--verify', 'node -e "process.exit(1)"']);
  assert.equal(result.status, 3, result.out);
  const report = JSON.parse(result.stdout);
  assert.equal(report.verify.status, 'failed');
  assert.equal(git(worktree, ['status', '--porcelain']), '');
  assert.equal(git(worktree, ['rev-parse', 'HEAD']), headBefore);
});

test('sync-check: a missing dependency is an environment fault, not a task failure', () => {
  const { worktree } = fixture();
  const result = run(worktree, 'integration/demo', [
    '--json',
    '--verify',
    `node -e "console.error(\\"Cannot find package 'tsx'\\"); process.exit(1)"`,
  ]);
  assert.equal(result.status, 4, result.out);
  const report = JSON.parse(result.stdout);
  assert.equal(report.verify.status, 'environment');
  assert.equal(report.verify.dependency, 'tsx');
  assert.equal(git(worktree, ['status', '--porcelain']), '');
});

test('sync-check: a dirty worktree is refused before any merge starts', () => {
  const { worktree } = fixture();
  write(worktree, 'dirty.txt', 'x\n');
  const result = run(worktree, 'integration/demo', ['--verify', 'true']);
  assert.equal(result.status, 1);
  assert.match(result.out, /dirty/);
  assert.match(git(worktree, ['status', '--porcelain']), /dirty\.txt/);
});
