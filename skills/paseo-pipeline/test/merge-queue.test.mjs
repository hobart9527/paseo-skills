import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const script = path.resolve(import.meta.dirname, '..', '..', '..', 'benchmarks', 'pipeline', 'tools', 'merge-queue.mjs');
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'q', GIT_AUTHOR_EMAIL: 'q@q',
  GIT_COMMITTER_NAME: 'q', GIT_COMMITTER_EMAIL: 'q@q',
};

const tasks = `- [ ] 1.1 T-01 first
  - Write scope: src/a.txt
  - Verify with: node -e "0"
- [ ] 1.2 T-02 uses first
  - Uses: T-01
  - Write scope: src/b.txt
  - Verify with: node -e "0"
- [ ] 1.3 T-03 sink
  - Depends on: T-01,T-02
  - Write scope: src/c.txt
  - Verify with: node -e "0"
`;

function repo(markdown = tasks) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-queue-'));
  fs.mkdirSync(path.join(dir, 'openspec/changes/chg'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'openspec/changes/chg/tasks.md'), markdown);
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: dir, env, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'base.txt'), 'base\n');
  git('add', '.');
  git('commit', '-qm', 'contract');
  git('branch', 'integration/chg');
  return { dir, git };
}

function run(dir, args = []) {
  const result = spawnSync('node', [script, path.join(dir, 'openspec/changes/chg'), ...args], { cwd: dir, env, encoding: 'utf8' });
  return { status: result.status, out: `${result.stdout}${result.stderr}`, json: () => JSON.parse(result.stdout) };
}

test('queues independent branches in dependency order and reports them clean', () => {
  const { dir, git } = repo();
  const mk = (name, file, text) => {
    git('switch', '-q', '-c', name, 'integration/chg');
    fs.mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
    git('add', '.'); git('commit', '-qm', name);
    git('switch', '-q', 'integration/chg');
  };
  mk('task/chg/T-01', 'src/a.txt', 'a\n');
  mk('task/chg/T-02', 'src/b.txt', 'b\n');
  mk('task/chg/T-03', 'src/c.txt', 'c\n');

  const result = run(dir, ['--json']);
  assert.equal(result.status, 0, result.out);
  const report = result.json();
  assert.deepEqual(report.order, ['T-01', 'T-02', 'T-03']);
  assert.deepEqual(report.queue.map((item) => [item.task, item.clean]), [['T-01', true], ['T-02', true], ['T-03', true]]);
  assert.deepEqual(report.conflicts, []);
});

test('a conflict with an earlier queued branch is detected before any real merge', () => {
  const { dir, git } = repo();
  const mk = (name, text) => {
    git('switch', '-q', '-c', name, 'integration/chg');
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src/shared.txt'), text);
    git('add', '.'); git('commit', '-qm', name);
    git('switch', '-q', 'integration/chg');
  };
  // T-01 and T-02 both write the same file but declare disjoint scopes so both queue.
  mk('task/chg/T-01', 'one\n');
  mk('task/chg/T-02', 'two\n');

  const result = run(dir, ['--json']);
  assert.equal(result.status, 1, result.out);
  const report = result.json();
  assert.equal(report.queue[0].task, 'T-01');
  assert.equal(report.queue[0].clean, true);
  assert.equal(report.queue[1].task, 'T-02');
  assert.equal(report.queue[1].clean, false);
  assert.deepEqual(report.conflicts[0].files, ['src/shared.txt']);
});

test('a branch whose merge dependency has no branch waits instead of queueing', () => {
  const { dir, git } = repo();
  git('switch', '-q', '-c', 'task/chg/T-03', 'integration/chg');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/c.txt'), 'c\n');
  git('add', '.'); git('commit', '-qm', 'T-03');
  git('switch', '-q', 'integration/chg');

  const result = run(dir, ['--json']);
  assert.equal(result.status, 0, result.out);
  const report = result.json();
  assert.deepEqual(report.waiting, [{ task: 'T-03', on: ['T-01', 'T-02'] }]);
  assert.deepEqual(report.queue, []);
});

test('the newest attempt wins and Done tasks are excluded', () => {
  const { dir, git } = repo(tasks.replace('T-01 first', 'T-01 first\n  - Done: source=aaaaaaaa review=pass(mechanical@aaaaaaaa/bbbbbbbb)'));
  const mk = (name) => {
    git('switch', '-q', '-c', name, 'integration/chg');
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, `src/${name.replaceAll('/', '_')}.txt`), 'x\n');
    git('add', '.'); git('commit', '-qm', name);
    git('switch', '-q', 'integration/chg');
  };
  mk('task/chg/T-01');
  mk('task/chg/T-02');
  mk('task/chg/T-02-a2');
  const result = run(dir, ['--json']);
  assert.equal(result.status, 0, result.out);
  const report = result.json();
  assert.deepEqual(report.queue.map((item) => item.task), ['T-02']);
  assert.equal(report.queue[0].branch, 'task/chg/T-02-a2');
});

test('unknown flags and unreadable repositories fail with usage codes', () => {
  const { dir } = repo();
  assert.equal(run(dir, ['--base', 'no-such-ref']).status, 3);
  const empty = spawnSync('node', [script], { encoding: 'utf8' });
  assert.equal(empty.status, 2);
});
