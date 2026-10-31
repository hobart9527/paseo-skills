import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const runnerScript = fileURLToPath(new URL('../task-runner.mjs', import.meta.url));
const change = 'runner-change';
const integrationBranch = `integration/${change}`;
const tasksPath = `openspec/changes/${change}/tasks.md`;
const passCommand = `${JSON.stringify(process.execPath)} -e "process.exit(0)"`;

const gitEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Pipeline Test',
  GIT_AUTHOR_EMAIL: 'pipeline-test@example.invalid',
  GIT_COMMITTER_NAME: 'Pipeline Test',
  GIT_COMMITTER_EMAIL: 'pipeline-test@example.invalid',
  GIT_TERMINAL_PROMPT: '0',
};

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `git ${args.join(' ')}\n${result.stdout}${result.stderr}`);
  return result.stdout.trim();
}

function write(cwd, filename, content) {
  const target = path.join(cwd, filename);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function fixture(context) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'pipeline-runner-test-'));
  context.after(() => rmSync(cwd, { recursive: true, force: true }));

  git(cwd, 'init', '-b', 'main');
  git(cwd, 'config', 'user.name', 'Pipeline Test');
  git(cwd, 'config', 'user.email', 'pipeline-test@example.invalid');
  git(cwd, 'config', 'commit.gpgsign', 'false');

  write(cwd, 'README.md', '# test repo\n');
  git(cwd, 'add', 'README.md');
  git(cwd, 'commit', '-m', 'chore: initial commit');

  git(cwd, 'checkout', '-b', integrationBranch);

  const tasksContent = [
    '# Tasks',
    '',
    '- [ ] 1.1 T-01 Task 1',
    '  - Depends on: none',
    '  - Write scope: src/a.txt',
    '  - Review: mechanical',
    `  - Verify with: ${passCommand}`,
    '',
    '- [ ] 1.2 T-02 Task 2',
    '  - Depends on: T-01',
    '  - Write scope: src/b.txt',
    '  - Review: mechanical',
    `  - Verify with: ${passCommand}`,
  ].join('\n');

  write(cwd, tasksPath, tasksContent);
  git(cwd, 'add', tasksPath);
  git(cwd, 'commit', '-m', 'docs: add tasks.md');

  return { cwd };
}

function invoke(cwd, args) {
  return spawnSync(process.execPath, [runnerScript, ...args], {
    cwd,
    env: { ...gitEnv, PIPELINE_HOME: path.dirname(runnerScript) },
    encoding: 'utf8',
  });
}

test('task-runner rejects missing arguments', (context) => {
  const repo = fixture(context);
  const res = invoke(repo.cwd, [change]);
  assert.equal(res.status, 1);
});

test('task-runner rejects unknown task ID', (context) => {
  const repo = fixture(context);
  const res = invoke(repo.cwd, [change, 'T-99']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /not declared/);
});

test('task-runner dry-run succeeds on valid ready task', (context) => {
  const repo = fixture(context);
  const res = invoke(repo.cwd, [change, 'T-01', '--dry-run']);
  assert.equal(res.status, 0, `${res.stdout}${res.stderr}`);
  assert.match(res.stdout, /Dry-run completed successfully/);
});

test('task-runner blocks task when dependencies are not satisfied', (context) => {
  const repo = fixture(context);
  const res = invoke(repo.cwd, [change, 'T-02']);
  assert.equal(res.status, 35);
  assert.match(res.stderr, /Dependencies not satisfied/);
});

test('task-runner executes, verifies and merges a ready task, unblocking downstream', (context) => {
  const repo = fixture(context);
  const res1 = invoke(repo.cwd, [change, 'T-01', '--fast', '--stub-commit']);
  assert.equal(res1.status, 0, `${res1.stdout}${res1.stderr}`);
  assert.match(res1.stdout, /merged successfully/);

  // T-02 should now be unblocked because T-01 is DONE
  const res2 = invoke(repo.cwd, [change, 'T-02', '--fast', '--stub-commit']);
  assert.equal(res2.status, 0, `${res2.stdout}${res2.stderr}`);
  assert.match(res2.stdout, /merged successfully/);

  // Re-invoking T-01 when already DONE is a no-op exit 0
  const res1Again = invoke(repo.cwd, [change, 'T-01']);
  assert.equal(res1Again.status, 0, `${res1Again.stdout}${res1Again.stderr}`);
  assert.match(res1Again.stdout, /already verified DONE/);
});

test('task-runner exits 20 when verify command fails', (context) => {
  const repo = fixture(context);
  const failCommand = `${JSON.stringify(process.execPath)} -e "process.exit(1)"`;
  const tasksContent = [
    '# Tasks',
    '',
    '- [ ] 1.1 T-01 Task 1',
    '  - Depends on: none',
    '  - Write scope: src/a.txt',
    '  - Review: mechanical',
    `  - Verify with: ${failCommand}`,
  ].join('\n');
  write(repo.cwd, tasksPath, tasksContent);
  git(repo.cwd, 'add', tasksPath);
  git(repo.cwd, 'commit', '-m', 'docs: update verify to failing command');

  const res = invoke(repo.cwd, [change, 'T-01', '--fast', '--stub-commit']);
  assert.equal(res.status, 20);
  assert.match(res.stderr, /Verify command failed/);
});

test('task-runner speculative mode rejects missing upstream branch but succeeds when branch exists', (context) => {
  const repo = fixture(context);
  // Upstream branch does not exist yet -> exit 35
  const resNoBranch = invoke(repo.cwd, [change, 'T-02', '--speculative', '--dry-run']);
  assert.equal(resNoBranch.status, 35);
  assert.match(resNoBranch.stderr, /upstream dependencies branches not found/);

  // Create upstream task branch with a commit
  git(repo.cwd, 'checkout', '-b', `task/${change}/T-01`);
  write(repo.cwd, 'src/a.txt', 'hello from T-01\n');
  git(repo.cwd, 'add', 'src/a.txt');
  git(repo.cwd, 'commit', '-m', 'feat: T-01 code\n\nPipeline-Role: gongbu\nPipeline-Author: test-author');
  git(repo.cwd, 'checkout', integrationBranch);

  // Now speculative dry-run for T-02 succeeds because upstream branch exists
  const resSpecReady = invoke(repo.cwd, [change, 'T-02', '--speculative', '--dry-run']);
  assert.equal(resSpecReady.status, 0, `${resSpecReady.stdout}${resSpecReady.stderr}`);
  assert.match(resSpecReady.stdout, /Speculative mode: unmerged dependencies/);
  assert.match(resSpecReady.stdout, /Dry-run completed successfully/);
});

