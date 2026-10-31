import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const runnerScript = fileURLToPath(new URL('../task-runner.mjs', import.meta.url));
const change = 'runner-change';
const integrationBranch = `integration/${change}`;
const tasksPath = `openspec/changes/${change}/tasks.md`;
const passCommand = `${JSON.stringify(process.execPath)} -e "process.exit(0)"`;
const failCommand = `${JSON.stringify(process.execPath)} -e "process.exit(1)"`;
const AGENT_ID = '01234567-89ab-cdef-0123-456789abcdef';

const baseEnv = { ...process.env };
for (const key of Object.keys(baseEnv)) {
  if (key.startsWith('GIT_')) delete baseEnv[key];
}

const gitEnv = {
  ...baseEnv,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: os.devNull,
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
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function tasksContent(verifyCommand = passCommand) {
  return [
    '# Tasks',
    '',
    '- [ ] 1.1 T-01 Task 1',
    '  - Depends on: none',
    '  - Write scope: src/a.txt',
    '  - Review: mechanical',
    `  - Verify with: ${verifyCommand}`,
    '',
    '- [ ] 1.2 T-02 Task 2',
    '  - Depends on: T-01',
    '  - Write scope: src/b.txt',
    '  - Review: mechanical',
    `  - Verify with: ${verifyCommand}`,
  ].join('\n');
}

/**
 * 仓库 + Paseo 替身。
 *
 * 替身 `paseo` 记录每次 argv 并**真的**建一个 worktree（模拟 `--new-workspace worktree`
 * 的效果），这样 Verify 能落在写手的任务 workspace 上；它还会在 `run` 当时把运行账本
 * 快照落盘，用于断言「claim 发生在派发之前」。
 */
function fixture(context, { profile = { provider: 'claude', model: 'fixture-claude' }, verify } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-runner-test-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home', '.paseo');
  const bin = path.join(root, 'bin');
  const repo = path.join(root, 'repo');
  const callsFile = path.join(root, 'paseo-calls.jsonl');
  const snapshotFile = path.join(root, 'ledger-at-run.json');
  const worktreeDir = path.join(root, 'ws');
  const stateDir = path.join(root, 'ledger');
  for (const directory of [home, bin, repo]) fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    daemon: { agentProfiles: profile === null ? [] : [{ id: 'agent_profile_gongbu', ...profile }] },
  }));
  fs.writeFileSync(path.join(bin, 'paseo'), `#!/usr/bin/env node
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.PASEO_CALLS_FILE, JSON.stringify(argv) + '\\n');
const value = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
if (argv[0] === 'run') {
  if (process.env.PASEO_FIXTURE_FAIL_RUN === '1') {
    console.error('fixture: dispatch failed');
    process.exit(1);
  }
  const branch = value('--new-branch');
  const base = value('--base');
  execFileSync('git', ['worktree', 'add', '-q', '-b', branch, process.env.PASEO_FIXTURE_WORKTREE, base], { stdio: 'ignore' });
  if (process.env.PASEO_SNAPSHOT_FILE) {
    const ledger = process.env.PASEO_LEDGER_FILE;
    fs.writeFileSync(process.env.PASEO_SNAPSHOT_FILE, fs.existsSync(ledger) ? fs.readFileSync(ledger, 'utf8') : '');
  }
  console.log('${AGENT_ID}');
} else if (argv[0] !== 'wait') {
  console.error('Unexpected paseo command: ' + argv[0]);
  process.exit(1);
}
`, { mode: 0o755 });

  const env = {
    ...gitEnv,
    HOME: path.join(root, 'home'),
    PATH: [bin, path.dirname(process.execPath), process.env.PATH].join(path.delimiter),
    PIPELINE_HOME: path.dirname(runnerScript),
    PIPELINE_PASEO_HOME: home,
    PIPELINE_RUN_STATE_DIR: stateDir,
    PASEO_CALLS_FILE: callsFile,
    PASEO_SNAPSHOT_FILE: snapshotFile,
    PASEO_LEDGER_FILE: path.join(stateDir, change, 'run-state.json'),
    PASEO_FIXTURE_WORKTREE: worktreeDir,
  };

  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Pipeline Test');
  git(repo, 'config', 'user.email', 'pipeline-test@example.invalid');
  git(repo, 'config', 'commit.gpgsign', 'false');
  write(repo, 'README.md', '# test repo\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-m', 'chore: initial commit');
  git(repo, 'checkout', '-b', integrationBranch);
  write(repo, tasksPath, tasksContent(verify));
  git(repo, 'add', tasksPath);
  git(repo, 'commit', '-m', 'docs: add tasks.md');

  return { cwd: repo, env, callsFile, snapshotFile, worktreeDir, stateDir, home };
}

function invoke(setup, args) {
  return spawnSync(process.execPath, [runnerScript, ...args], {
    cwd: setup.cwd,
    env: setup.env,
    encoding: 'utf8',
    timeout: 30_000,
  });
}

function paseoCalls(setup) {
  if (!fs.existsSync(setup.callsFile)) return [];
  return fs.readFileSync(setup.callsFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function runs(setup) {
  return paseoCalls(setup).filter((argv) => argv[0] === 'run');
}

function optionValues(argv, option) {
  return argv.flatMap((value, index) => (value === option ? [argv[index + 1]] : []));
}

function ledger(setup) {
  const file = path.join(setup.stateDir, change, 'run-state.json');
  assert.ok(fs.existsSync(file), `run ledger must exist: ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('task-runner rejects missing arguments', (context) => {
  const setup = fixture(context);
  const res = invoke(setup, [change]);
  assert.equal(res.status, 1);
});

test('task-runner rejects unknown task ID', (context) => {
  const setup = fixture(context);
  const res = invoke(setup, [change, 'T-99']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /not declared/);
});

test('task-runner dry-run succeeds on valid ready task', (context) => {
  const setup = fixture(context);
  const res = invoke(setup, [change, 'T-01', '--dry-run']);
  assert.equal(res.status, 0, `${res.stdout}${res.stderr}`);
  assert.match(res.stdout, /Dry-run completed successfully/);
  assert.equal(runs(setup).length, 0, 'dry-run must not dispatch');
});

test('task-runner blocks task when dependencies are not satisfied', (context) => {
  const setup = fixture(context);
  const res = invoke(setup, [change, 'T-02']);
  assert.equal(res.status, 35);
  assert.match(res.stderr, /Dependencies not satisfied/);
});

// SCEN-HND-04
test('task-runner creates the writer workspace through Paseo and books the intent around it', (context) => {
  // Verify 故意失败：流程在派发之后、合流之前停下，断言的全是已发生的外部事实
  // （替身记录下来的 argv、账本里的意图/回执、进程退出码）。
  const setup = fixture(context, { verify: failCommand });
  const res = invoke(setup, [change, 'T-01', '--owner', 'test-owner']);
  assert.equal(res.status, 20, `${res.stdout}\n${res.stderr}`);

  const dispatched = runs(setup);
  assert.equal(dispatched.length, 1, `exactly one paseo run: ${res.stdout}\n${res.stderr}`);
  const argv = dispatched[0];
  assert.deepEqual(optionValues(argv, '--new-workspace'), ['worktree']);
  assert.deepEqual(optionValues(argv, '--new-branch'), [`task/${change}/T-01`]);
  assert.deepEqual(optionValues(argv, '--base'), [integrationBranch]);
  assert.deepEqual(optionValues(argv, '--label').sort(), [
    'pipeline.attempt=1',
    `pipeline.change=${change}`,
    'pipeline.phase=impl',
    'pipeline.role=gongbu',
    'pipeline.task=T-01',
  ]);

  // 意图在派发**之前**已 claim：快照里能看到未回执的意图。
  const snapshot = JSON.parse(fs.readFileSync(setup.snapshotFile, 'utf8'));
  const key = `local:T-01:1:impl:gongbu:dispatch`;
  const atDispatch = snapshot.intents.find((entry) => entry.key === key);
  assert.ok(atDispatch, `intent must be claimed before dispatch: ${JSON.stringify(snapshot.intents)}`);
  assert.equal(atDispatch.resolvedAt, null, 'intent must not be resolved before the dispatch returns');

  // 回执在派发**之后**登记真实 agent id。
  const intent = ledger(setup).intents.find((entry) => entry.key === key);
  assert.equal(intent.agentId, AGENT_ID, 'record must store the real agent id');
  assert.ok(intent.resolvedAt, 'record must resolve the intent');
});

// SCEN-HND-04
test('task-runner refuses to dispatch when the writer profile is missing', (context) => {
  const setup = fixture(context, { profile: null, verify: failCommand });
  const res = invoke(setup, [change, 'T-01']);
  assert.notEqual(res.status, 0, `${res.stdout}\n${res.stderr}`);
  assert.match(res.stderr, /agent_profile_gongbu/);
  assert.equal(runs(setup).length, 0, 'an unresolvable profile must fail before paseo run');
});

// SCEN-HND-04
test('task-runner refuses to dispatch when the writer profile resolves to an empty provider', (context) => {
  const setup = fixture(context, { profile: { model: 'fixture-model' }, verify: failCommand });
  const res = invoke(setup, [change, 'T-01']);
  assert.notEqual(res.status, 0, `${res.stdout}\n${res.stderr}`);
  assert.match(res.stderr, /provider\/model|空 provider/);
  assert.equal(runs(setup).length, 0, 'an empty provider must fail before paseo run');
});

test('task-runner voids the intent when paseo run fails', (context) => {
  const setup = fixture(context, { verify: failCommand });
  setup.env.PASEO_FIXTURE_FAIL_RUN = '1';
  const res = invoke(setup, [change, 'T-01']);
  assert.notEqual(res.status, 0, `${res.stdout}\n${res.stderr}`);
  const intent = ledger(setup).intents.find((entry) => entry.key === 'local:T-01:1:impl:gongbu:dispatch');
  assert.ok(intent, 'the intent must be booked before dispatch');
  assert.ok(intent.failedAt, 'a failed dispatch must void the intent instead of leaving it open');
});

// SCEN-HND-05
test('task-runner increments the attempt suffix when the task branch already exists', (context) => {
  const setup = fixture(context, { verify: failCommand });
  git(setup.cwd, 'branch', `task/${change}/T-01`, integrationBranch);
  const res = invoke(setup, [change, 'T-01']);
  assert.equal(res.status, 20, `${res.stdout}\n${res.stderr}`);

  const dispatched = runs(setup);
  assert.equal(dispatched.length, 1);
  assert.deepEqual(optionValues(dispatched[0], '--new-branch'), [`task/${change}/T-01-a2`]);
  assert.ok(
    optionValues(dispatched[0], '--label').includes('pipeline.attempt=2'),
    `attempt label must be 2: ${optionValues(dispatched[0], '--label').join(',')}`,
  );

  const snapshot = JSON.parse(fs.readFileSync(setup.snapshotFile, 'utf8'));
  const intent = snapshot.intents.find((entry) => entry.task === 'T-01');
  assert.equal(intent.attempt, 2, 'the intent attempt must be 2 on redispatch');
});

test('task-runner exits 20 when verify command fails in the writer workspace', (context) => {
  const setup = fixture(context, { verify: failCommand });
  const res = invoke(setup, [change, 'T-01']);
  assert.equal(res.status, 20, `${res.stdout}\n${res.stderr}`);
  assert.match(res.stderr, /Verify command failed/);
});

test('task-runner speculative mode rejects missing upstream branch but succeeds when branch exists', (context) => {
  const setup = fixture(context);
  // Upstream branch does not exist yet -> exit 35
  const resNoBranch = invoke(setup, [change, 'T-02', '--speculative', '--dry-run']);
  assert.equal(resNoBranch.status, 35);
  assert.match(resNoBranch.stderr, /upstream dependencies branches not found/);

  // Create upstream task branch with a commit
  git(setup.cwd, 'checkout', '-b', `task/${change}/T-01`);
  write(setup.cwd, 'src/a.txt', 'hello from T-01\n');
  git(setup.cwd, 'add', 'src/a.txt');
  git(setup.cwd, 'commit', '-m', 'feat: T-01 code\n\nPipeline-Role: gongbu\nPipeline-Author: test-author');
  git(setup.cwd, 'checkout', integrationBranch);

  // Now speculative dry-run for T-02 succeeds because upstream branch exists
  const resSpecReady = invoke(setup, [change, 'T-02', '--speculative', '--dry-run']);
  assert.equal(resSpecReady.status, 0, `${resSpecReady.stdout}${resSpecReady.stderr}`);
  assert.match(resSpecReady.stdout, /Speculative mode: unmerged dependencies/);
  assert.match(resSpecReady.stdout, /Dry-run completed successfully/);
});
