// handoff-check 回归：确认点 1 之后、建集成 workspace 之前的机械交接门禁。
//
// 这道门禁存在的理由：change 产物没提交就开工，写手拿到的是「本地看着有、git 里没有」的
// 契约；`tasks.md` 不在集成基点，任务就能被派发但合流时读不到最新契约。两种事故都不报错，
// 只在最后一公里变成返工。因此判据必须机械、逐路径点名，且**只读 git 对象**，不看工作树。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs, { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkHandoff } from '../lib/handoff.mjs';

const script = fileURLToPath(new URL('../handoff-check.mjs', import.meta.url));
const change = 'demo';
const changeDir = `openspec/changes/${change}`;
const integrationBranch = `integration/${change}`;
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

/**
 * 临时仓库：main 上先提交一份基线，再把 change 产物提交到 integration/<change>。
 * `beforeTasks` 是 tasks.md 提交前的 sha，用来构造「工作树干净但基点读不到 tasks.md」。
 */
function fixture(context) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'pipeline-handoff-'));
  context.after(() => rmSync(cwd, { recursive: true, force: true }));
  git(cwd, 'init', '-q', '-b', 'main');
  git(cwd, 'config', 'commit.gpgsign', 'false');
  git(cwd, 'config', 'core.hooksPath', '/dev/null');
  write(cwd, 'src/base.txt', 'base\n');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', 'fixture baseline');
  const beforeTasks = git(cwd, 'rev-parse', 'HEAD');
  write(cwd, `${changeDir}/tasks.md`, `# Tasks\n\n- [ ] 1.1 T-01 deliver\n`);
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', 'change artifacts');
  git(cwd, 'switch', '-qc', integrationBranch);
  return { cwd, beforeTasks };
}

function run(cwd, args = []) {
  const result = spawnSync(process.execPath, [script, change, ...args], {
    cwd, env: gitEnv, encoding: 'utf8', timeout: 20_000,
  });
  assert.ifError(result.error);
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

// SCEN-HND-01
test('untracked or modified files under the change directory fail the gate and are named', (context) => {
  const { cwd } = fixture(context);
  const untracked = `${changeDir}/specs/new/spec.md`;
  write(cwd, untracked, 'untracked\n');
  writeFileSync(path.join(cwd, `${changeDir}/tasks.md`), '# Tasks\n\n- [ ] 1.1 T-01 deliver again\n');

  const result = run(cwd);
  assert.equal(result.code, 1, `expected a non-zero exit:\n${result.out}`);
  assert.ok(result.out.includes(untracked), `output must name ${untracked}:\n${result.out}`);
  assert.ok(result.out.includes(`${changeDir}/tasks.md`), `output must name the modified tasks.md:\n${result.out}`);
});

// SCEN-HND-01
test('a staged rename under the change directory names both endpoints', (context) => {
  const { cwd } = fixture(context);
  write(cwd, `${changeDir}/notes.md`, 'notes\n');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', 'notes');
  git(cwd, 'mv', `${changeDir}/notes.md`, `${changeDir}/moved.md`);

  const result = run(cwd);
  assert.equal(result.code, 1, `expected a non-zero exit:\n${result.out}`);
  assert.ok(result.out.includes(`${changeDir}/moved.md`), `output must name the new path:\n${result.out}`);
  assert.ok(result.out.includes(`${changeDir}/notes.md`), `output must name the old path:\n${result.out}`);
});

// SCEN-HND-02
test('a committed change on the integration branch passes', (context) => {
  const { cwd } = fixture(context);
  const result = run(cwd);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /RESULT/);
});

// SCEN-HND-02
test('any other branch fails with a branch-naming message', (context) => {
  const { cwd } = fixture(context);
  git(cwd, 'switch', '-qc', `task/${change}/T-01`);
  const result = run(cwd);
  assert.equal(result.code, 1, `expected a non-zero exit:\n${result.out}`);
  assert.ok(result.out.includes(integrationBranch), `output must name ${integrationBranch}:\n${result.out}`);
  assert.ok(result.out.includes(`task/${change}/T-01`), `output must name the current branch:\n${result.out}`);
});

// SCEN-HND-02
test('tasks.md must be readable from the integration base, not just the working tree', (context) => {
  const { cwd, beforeTasks } = fixture(context);
  const result = run(cwd, ['--base', beforeTasks]);
  assert.equal(result.code, 1, `expected a non-zero exit:\n${result.out}`);
  assert.ok(result.out.includes(`${changeDir}/tasks.md`), `output must name tasks.md:\n${result.out}`);
});

// SCEN-HND-02
test('unknown usage exits 2 so a broken invocation is not read as a passed gate', (context) => {
  const { cwd } = fixture(context);
  const result = spawnSync(process.execPath, [script], { cwd, env: gitEnv, encoding: 'utf8' });
  assert.equal(result.status, 2, `${result.stdout}${result.stderr}`);
});

// SCEN-HND-02
test('checkHandoff returns the shared structured result for reuse by task-runner', (context) => {
  const { cwd } = fixture(context);
  const ok = checkHandoff({ root: cwd, change });
  assert.equal(ok.ok, true);
  assert.equal(ok.branch, integrationBranch);
  assert.deepEqual(ok.problems, []);
});
