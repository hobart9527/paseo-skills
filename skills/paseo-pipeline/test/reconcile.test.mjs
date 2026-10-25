import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Permission-paused agents use status: 'idle', pendingPermission: true;
// disposition must not hide this pending human decision.
const reconcile = fileURLToPath(new URL('../reconcile.mjs', import.meta.url));
const change = 'reconcile-contract';
const integration = `integration/${change}`;
const states = ['INVALID', 'DONE', 'ACTIVE', 'UNRESOLVED', 'MERGE', 'BLOCKED', 'BLOCKED_RESOURCE', 'READY'];

function markdown(tasks) {
  return tasks.map((task, index) => [
    `- [${task.done ? 'x' : ' '}] 1.${index + 1} ${task.id} Task ${task.id}`,
    `  - Depends on: ${task.depends ?? 'none'}`,
    `  - Write scope: ${task.scope ?? `src/${task.id}.mjs`}`,
    ...(task.doneLine ? [`  - Done: ${task.doneLine}`] : []),
  ].join('\n')).join('\n\n');
}

function agent(overrides = {}, labels = {}) {
  return {
    id: 'agent-01',
    name: 'contract worker',
    status: 'running',
    ...overrides,
    labels: {
      'pipeline.change': change,
      'pipeline.role': 'gongbu',
      'pipeline.task': 'T-01',
      'pipeline.attempt': '1',
      'pipeline.phase': 'impl',
      ...labels,
    },
  };
}

function fixture(context, tasks = [{ id: 'T-01' }]) {
  const root = mkdtempSync(path.join(tmpdir(), 'pipeline-reconcile-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'repo');
  const bin = path.join(root, 'bin');
  const runtimeFile = path.join(root, 'runtime.json');
  const tasksFile = path.join(cwd, 'openspec', 'changes', change, 'tasks.md');
  mkdirSync(path.dirname(tasksFile), { recursive: true });
  mkdirSync(bin);
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Pipeline contract test',
    GIT_AUTHOR_EMAIL: 'pipeline@example.test',
    GIT_COMMITTER_NAME: 'Pipeline contract test',
    GIT_COMMITTER_EMAIL: 'pipeline@example.test',
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
    RECONCILE_RUNTIME_FIXTURE: runtimeFile,
  };
  const git = (...args) => execFileSync('git', args, {
    cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
  }).trim();
  const writeTasks = (value) => writeFileSync(tasksFile, typeof value === 'string' ? value : markdown(value));
  const runtime = (agents = [], mode = 'ok') => writeFileSync(runtimeFile, JSON.stringify({ agents, mode }));
  writeFileSync(path.join(bin, 'paseo'), `#!${process.execPath}
import { readFileSync } from 'node:fs';
const fixture = JSON.parse(readFileSync(process.env.RECONCILE_RUNTIME_FIXTURE, 'utf8'));
if (fixture.mode === 'exit') process.exit(1);
process.stdout.write(fixture.mode === 'garbage' ? 'not JSON' : JSON.stringify(fixture.agents));
`, { mode: 0o755 });
  git('init', '-q', '-b', integration);
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', '/dev/null');
  writeTasks(tasks);
  git('add', 'openspec');
  git('commit', '-qm', 'Seed task ledger');
  runtime();
  let branchCount = 0;

  function taskBranch(task = 'T-01', suffix = '') {
    const branch = `task/${change}/${task}${suffix}`;
    git('checkout', '-qb', branch);
    const filename = `feature-${++branchCount}.txt`;
    writeFileSync(path.join(cwd, filename), `${branch}\n`);
    git('add', filename);
    git('commit', '-qm', `Work for ${task}`);
    const tip = git('rev-parse', 'HEAD');
    git('checkout', '-q', integration);
    return { branch, task, tip };
  }

  function mergeTask(source, ledger, trailer = source.task) {
    git('merge', '--no-ff', '--no-commit', source.branch);
    if (ledger) writeTasks(ledger);
    git('add', 'openspec');
    git('commit', '-qm', `Accept task\n\n${trailer ? `Pipeline-Task: ${trailer}\n` : ''}Pipeline-Source: ${source.tip}`);
    return git('rev-parse', 'HEAD');
  }

  function run(args = []) {
    const result = spawnSync(process.execPath, [reconcile, change, '--json', ...args], {
      cwd, env, encoding: 'utf8', timeout: 30_000,
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    return result;
  }

  return { git, writeTasks, runtime, taskBranch, mergeTask, run };
}

function output(subject, args = []) {
  const result = subject.run(args);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function taskId(entry) {
  const value = typeof entry === 'string' ? entry : entry?.task;
  assert.equal(typeof value, 'string', `Expected task ID: ${JSON.stringify(entry)}`);
  const match = value.match(/\bT-\d+\b/);
  assert.ok(match, `Missing task ID: ${value}`);
  return match[0];
}

function ids(result, group) {
  assert.ok(Array.isArray(result[group]), `${group} must be an array`);
  return result[group].map(taskId).sort();
}

function state(result, task, expected) {
  assert.ok(ids(result, expected).includes(task), `${task} must be ${expected}`);
  for (const group of states.filter((group) => group !== expected)) {
    assert.ok(!ids(result, group).includes(task), `${task} must not also be ${group}`);
  }
}

function dispatch(result, expected) {
  assert.deepEqual(ids(result, 'canDispatchNow'), [...expected].sort());
}

function conflict(result, blocked, holder) {
  state(result, blocked, 'BLOCKED_RESOURCE');
  const entry = result.BLOCKED_RESOURCE.find((entry) => taskId(entry) === blocked);
  assert.ok(JSON.stringify(entry).includes(holder), `${blocked} must name conflicting ${holder}`);
}

function doneTask(source, overrides = {}) {
  const tip = source.tip.slice(0, 7);
  return { id: source.task, done: true, doneLine: `source=${tip} review=pass(12345678@${tip}/7654321)`, ...overrides };
}

test('JSON contract preserves legacy keys and exposes all reconciliation categories', (context) => {
  const result = output(fixture(context));
  assert.equal(result.change, change);
  assert.equal(result.cap, 3);
  assert.equal(result.runtime, 'ok');
  for (const key of [...states, 'UNMAPPED', 'RUNNING', 'canDispatchNow']) {
    assert.ok(Array.isArray(result[key]), `${key} must be an array`);
  }
  state(result, 'T-01', 'READY');
  dispatch(result, ['T-01']);
});

for (const [name, tasks, diagnostic] of [
  ['SCEN-REC-01 unknown dependency', [{ id: 'T-02', depends: 'T-99' }], /T-99/],
  ['SCEN-REC-02 dependency cycle', [{ id: 'T-01', depends: 'T-02' }, { id: 'T-02', depends: 'T-01' }], /cycle|环/i],
  ['duplicate task ID', [{ id: 'T-01' }, { id: 'T-01' }], /duplicate|重复/i],
  ['self dependency', [{ id: 'T-01', depends: 'T-01' }], /self|自身|环/i],
  ['malformed task line', '- [ ] 1.1 MissingTaskId\n  - Write scope: src/task.mjs', /malformed|无法解析|合法.*ID|INVALID/i],
]) {
  test(`${name} rejects graph instead of dispatching`, (context) => {
    const subject = fixture(context, tasks);
    const result = subject.run();
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, diagnostic);
    if (result.stdout.trim().startsWith('{')) {
      const parsed = JSON.parse(result.stdout);
      dispatch(parsed, []);
      assert.deepEqual(ids(parsed, 'READY'), []);
    }
  });
}

for (const branch of ['main', 'integration/another-change', null]) {
  test(`SCEN-REC-03 rejects ${branch ?? 'detached HEAD'} and names expected integration branch`, (context) => {
    const subject = fixture(context);
    if (branch) subject.git('checkout', '-qb', branch);
    else subject.git('checkout', '--detach', '-q');
    const result = subject.run();
    assert.notEqual(result.status, 0);
    assert.ok(`${result.stdout}\n${result.stderr}`.includes(integration));
  });
}

for (const mode of ['exit', 'garbage']) {
  test(`SCEN-REC-04 runtime ${mode} fails closed but retains Git/task classifications`, (context) => {
    const subject = fixture(context, [{ id: 'T-01' }, { id: 'T-02', depends: 'T-01' }, { id: 'T-03' }]);
    subject.taskBranch('T-03');
    subject.runtime([], mode);
    const result = output(subject);
    assert.equal(result.runtime, 'unavailable');
    state(result, 'T-01', 'READY');
    state(result, 'T-02', 'BLOCKED');
    state(result, 'T-03', 'MERGE');
    dispatch(result, []);
  });
}

for (const status of ['running', 'initializing']) {
  test(`SCEN-REC-05 ${status} task is ACTIVE before merge/dependency checks`, (context) => {
    const subject = fixture(context, [{ id: 'T-01', depends: 'T-02' }, { id: 'T-02' }]);
    subject.taskBranch();
    subject.runtime([agent({ status })]);
    const result = output(subject);
    state(result, 'T-01', 'ACTIVE');
    dispatch(result, ['T-02']);
  });
}

for (const status of ['error', 'idle', 'closed']) {
  test(`SCEN-REC-05/10 latest ${status} agent is UNRESOLVED before merge/dependency checks`, (context) => {
    const subject = fixture(context, [{ id: 'T-01', depends: 'T-02' }, { id: 'T-02' }]);
    subject.taskBranch();
    subject.runtime([agent({ status })]);
    const result = output(subject);
    state(result, 'T-01', 'UNRESOLVED');
    dispatch(result, ['T-02']);
  });
}

for (const suffix of ['', '-a2']) {
  test(`SCEN-REC-06 divergent task branch${suffix} is MERGE, not acceptance`, (context) => {
    const subject = fixture(context, [{ id: 'T-01' }, { id: 'T-02', depends: 'T-01' }]);
    subject.taskBranch('T-01', suffix);
    const result = output(subject);
    state(result, 'T-01', 'MERGE');
    state(result, 'T-02', 'BLOCKED');
    dispatch(result, []);
  });
}

for (const role of ['gongbu', 'gaogong', 'qingqibing', 'ceshi', 'anchasi']) {
  for (const field of ['task', 'attempt', 'phase', 'unknown-task']) {
    test(`SCEN-REC-07 ${role} with ${field} identity defect is UNMAPPED`, (context) => {
      const subject = fixture(context);
      const labels = { 'pipeline.role': role };
      if (field === 'unknown-task') labels['pipeline.task'] = 'T-99';
      else labels[`pipeline.${field}`] = undefined;
      const worker = agent({}, labels);
      subject.runtime([worker]);
      const result = output(subject);
      assert.ok(Array.isArray(result.UNMAPPED));
      assert.ok(result.UNMAPPED.length > 0);
      assert.ok(JSON.stringify(result.UNMAPPED).includes(worker.id));
      dispatch(result, []);
    });
  }
}

for (const role of ['gongbu', 'gaogong', 'qingqibing', 'ceshi']) {
  test(`mapped ${role} writer is ACTIVE and holds its scope`, (context) => {
    const subject = fixture(context, [
      { id: 'T-01', scope: 'src/shared/' },
      { id: 'T-02', scope: 'src/shared/file.mjs' },
      { id: 'T-03', scope: 'docs/' },
    ]);
    subject.runtime([agent({}, { 'pipeline.role': role })]);
    const result = output(subject);
    assert.deepEqual(result.UNMAPPED, []);
    state(result, 'T-01', 'ACTIVE');
    conflict(result, 'T-02', 'T-01');
    dispatch(result, ['T-03']);
  });
}

test('mapped anchasi auditor is ACTIVE but holds no write scope', (context) => {
  const subject = fixture(context, [
    { id: 'T-01', scope: 'src/shared/' },
    { id: 'T-02', scope: 'src/shared/file.mjs' },
  ]);
  subject.runtime([agent({}, { 'pipeline.role': 'anchasi', 'pipeline.phase': 'audit' })]);
  const result = output(subject);
  assert.deepEqual(result.UNMAPPED, []);
  state(result, 'T-01', 'ACTIVE');
  state(result, 'T-02', 'READY');
  dispatch(result, ['T-02']);
});

for (const role of [undefined, 'unknown-role']) {
  test(`SCEN-REC-07 initializing agent with ${role ?? 'missing role'} fails closed`, (context) => {
    const subject = fixture(context);
    subject.runtime([agent({ status: 'initializing' }, { 'pipeline.role': role })]);
    const result = output(subject);
    assert.ok(Array.isArray(result.UNMAPPED));
    assert.ok(result.UNMAPPED.length > 0);
    dispatch(result, []);
  });
}

test('SCEN-REC-08 all control-plane roles need no task identity and consume no dispatch slot', (context) => {
  const subject = fixture(context);
  subject.runtime(['shangshu', 'xunjian', 'yushi', 'dalisi', 'dalisi_gemini', 'mige'].map((role) => agent(
    { id: `control-${role}` },
    { 'pipeline.role': role, 'pipeline.task': undefined, 'pipeline.attempt': undefined, 'pipeline.phase': undefined },
  )));
  const result = output(subject, ['--cap', '1']);
  assert.deepEqual(result.UNMAPPED, []);
  state(result, 'T-01', 'READY');
  dispatch(result, ['T-01']);
});

for (const [earlier, later] of [['test', 'impl'], ['impl', 'audit'], ['audit', 'merge']]) {
  test(`SCEN-REC-09 disposed ${later} supersedes historical idle ${earlier}, regardless of list order`, (context) => {
    const subject = fixture(context);
    subject.runtime([
      agent({ id: 'later', status: 'idle' }, { 'pipeline.phase': later, 'pipeline.disposition': 'handed-off' }),
      agent({ id: 'earlier', status: 'idle' }, { 'pipeline.phase': earlier }),
    ]);
    const result = output(subject);
    state(result, 'T-01', 'READY');
    dispatch(result, ['T-01']);
  });
}

test('SCEN-REC-09 newer attempt outranks historical later phase', (context) => {
  const subject = fixture(context);
  subject.runtime([
    agent({ id: 'latest', status: 'idle' }, { 'pipeline.attempt': '10', 'pipeline.phase': 'test', 'pipeline.disposition': 'abandoned' }),
    agent({ id: 'old', status: 'error' }, { 'pipeline.attempt': '9', 'pipeline.phase': 'merge' }),
  ]);
  const result = output(subject);
  state(result, 'T-01', 'READY');
  dispatch(result, ['T-01']);
});

test('SCEN-REC-10 disposed history cannot hide latest idle agent without disposition', (context) => {
  const subject = fixture(context);
  subject.runtime([
    agent({ id: 'latest', status: 'idle' }, { 'pipeline.phase': 'impl' }),
    agent({ id: 'old', status: 'idle' }, { 'pipeline.phase': 'test', 'pipeline.disposition': 'handed-off' }),
  ]);
  const result = output(subject);
  state(result, 'T-01', 'UNRESOLVED');
  dispatch(result, []);
});

for (const status of ['error', 'idle', 'closed']) {
  for (const disposition of ['handed-off', 'merged', 'rejected', 'abandoned']) {
    test(`SCEN-REC-09/11 disposition ${disposition} clears latest ${status} agent`, (context) => {
      const subject = fixture(context);
      subject.runtime([agent({ status }, { 'pipeline.disposition': disposition })]);
      const result = output(subject);
      state(result, 'T-01', 'READY');
      dispatch(result, ['T-01']);
    });
  }
}

for (const status of ['running', 'initializing']) {
  test(`SCEN-REC-12 older ${status} writer retains scope and cap despite disposition and newer attempt`, (context) => {
    const subject = fixture(context, [
      { id: 'T-01', scope: 'src/shared/' },
      { id: 'T-02', scope: 'src/shared/file.mjs' },
      { id: 'T-03', scope: 'docs/' },
    ]);
    subject.runtime([
      agent({ id: 'newer', status: 'idle' }, { 'pipeline.attempt': '2', 'pipeline.disposition': 'abandoned' }),
      agent({ id: 'older', status }, { 'pipeline.disposition': 'rejected' }),
    ]);
    const result = output(subject, ['--cap', '1']);
    state(result, 'T-01', 'ACTIVE');
    conflict(result, 'T-02', 'T-01');
    state(result, 'T-03', 'READY');
    dispatch(result, []);
  });
}

test('SCEN-DAG-01 verified first-parent merge releases only its dependents; DONE precedes idle history', (context) => {
  const subject = fixture(context, [{ id: 'T-01' }, { id: 'T-02' }, { id: 'T-03', depends: 'T-01' }]);
  const source = subject.taskBranch();
  subject.mergeTask(source, [doneTask(source), { id: 'T-02' }, { id: 'T-03', depends: 'T-01' }]);
  subject.runtime([agent({ status: 'error' })]);
  const result = output(subject);
  state(result, 'T-01', 'DONE');
  state(result, 'T-02', 'READY');
  state(result, 'T-03', 'READY');
  dispatch(result, ['T-02', 'T-03']);
});

test('SCEN-DAG-01 older verified first-parent merge remains DONE after another task merge', (context) => {
  const subject = fixture(context, [{ id: 'T-01' }, { id: 'T-02' }, { id: 'T-03', depends: 'T-01, T-02' }]);
  const first = subject.taskBranch();
  subject.mergeTask(first, [doneTask(first), { id: 'T-02' }, { id: 'T-03', depends: 'T-01, T-02' }]);
  const second = subject.taskBranch('T-02');
  subject.mergeTask(second, [doneTask(first), doneTask(second), { id: 'T-03', depends: 'T-01, T-02' }]);
  const result = output(subject);
  state(result, 'T-01', 'DONE');
  state(result, 'T-02', 'DONE');
  state(result, 'T-03', 'READY');
  dispatch(result, ['T-03']);
});

for (const [first, second] of [
  ['src/shared/', 'src/shared/file.mjs'],
  ['src/shared/file.mjs', 'src/shared/'],
  ['src/other.mjs, src/shared/', 'src/shared/file.mjs'],
]) {
  test(`SCEN-DAG-02 overlapping scopes serialize in file order: ${first} vs ${second}`, (context) => {
    const subject = fixture(context, [{ id: 'T-04', scope: first }, { id: 'T-05', scope: second }]);
    const result = output(subject);
    state(result, 'T-04', 'READY');
    conflict(result, 'T-05', 'T-04');
    dispatch(result, ['T-04']);
  });
}

test('SCEN-DAG-03 ancestor-only source is INVALID before ACTIVE and cannot release dependents', (context) => {
  const subject = fixture(context, [{ id: 'T-01' }, { id: 'T-02', depends: 'T-01' }]);
  const source = { task: 'T-01', tip: subject.git('rev-parse', 'HEAD') };
  subject.writeTasks([doneTask(source), { id: 'T-02', depends: 'T-01' }]);
  subject.git('add', 'openspec');
  subject.git('commit', '-qm', 'Ancestor is not merge acceptance');
  subject.runtime([agent()]);
  const result = output(subject);
  state(result, 'T-01', 'INVALID');
  state(result, 'T-02', 'BLOCKED');
  dispatch(result, []);
});

test('SCEN-DAG-03 cherry-picked source without a first-parent merge is INVALID', (context) => {
  const subject = fixture(context);
  const source = subject.taskBranch();
  subject.git('cherry-pick', '--no-commit', source.tip);
  subject.writeTasks([doneTask(source)]);
  subject.git('add', 'openspec');
  subject.git('commit', '-qm', 'Copy changes without accepting a task merge');
  const result = output(subject);
  state(result, 'T-01', 'INVALID');
  dispatch(result, []);
});

test('SCEN-DAG-03 matching merge on a side path, not integration first-parent, is INVALID', (context) => {
  const subject = fixture(context);
  const source = subject.taskBranch();
  subject.git('checkout', '-qb', 'staging');
  subject.mergeTask(source, [doneTask(source)]);
  subject.git('checkout', '-q', integration);
  subject.git('merge', '--no-ff', 'staging', '-m', 'Batch landing\n\nPipeline-Task: T-01');
  const result = output(subject);
  state(result, 'T-01', 'INVALID');
  dispatch(result, []);
});

for (const trailer of ['', 'T-010']) {
  test(`SCEN-DAG-03 second-parent match with ${trailer || 'missing'} task trailer is INVALID`, (context) => {
    const subject = fixture(context);
    const source = subject.taskBranch();
    subject.mergeTask(source, [doneTask(source)], trailer);
    const result = output(subject);
    state(result, 'T-01', 'INVALID');
    dispatch(result, []);
  });
}

test('SCEN-DAG-03 matching trailer cannot accept source other than merge second parent', (context) => {
  const subject = fixture(context);
  const base = subject.git('rev-parse', 'HEAD');
  const source = subject.taskBranch();
  subject.mergeTask(source, [doneTask({ ...source, tip: base })]);
  const result = output(subject);
  state(result, 'T-01', 'INVALID');
  dispatch(result, []);
});

test('legacy merge= Done line is INVALID even when source was merged correctly', (context) => {
  const subject = fixture(context);
  const source = subject.taskBranch();
  subject.mergeTask(source, [doneTask(source, { doneLine: `merge=${source.tip.slice(0, 7)} review=mechanical` })]);
  const result = output(subject);
  state(result, 'T-01', 'INVALID');
  dispatch(result, []);
});

test('checked task without Done evidence is INVALID, not DONE', (context) => {
  const result = output(fixture(context, [{ id: 'T-01', done: true }]));
  state(result, 'T-01', 'INVALID');
  dispatch(result, []);
});

test('SCEN-DAG-04 cap=2 with one ACTIVE and three READY tasks dispatches one', (context) => {
  const subject = fixture(context, ['T-01', 'T-02', 'T-03', 'T-04'].map((id) => ({ id })));
  subject.runtime([agent()]);
  const result = output(subject, ['--cap', '2']);
  assert.equal(result.cap, 2);
  state(result, 'T-01', 'ACTIVE');
  for (const task of ['T-02', 'T-03', 'T-04']) state(result, task, 'READY');
  dispatch(result, ['T-02']);
});

test('SCEN-DAG-05 permission-paused task holds scope even with disposition and later file position', (context) => {
  const subject = fixture(context, [
    { id: 'T-01', scope: 'src/shared/file.mjs' },
    { id: 'T-02', scope: 'src/shared/' },
    { id: 'T-03', scope: 'docs/' },
  ]);
  subject.runtime([agent(
    { status: 'idle', pendingPermission: true },
    { 'pipeline.task': 'T-02', 'pipeline.disposition': 'abandoned' },
  )]);
  const result = output(subject);
  state(result, 'T-02', 'UNRESOLVED');
  conflict(result, 'T-01', 'T-02');
  dispatch(result, ['T-03']);
});

test('MERGE candidate holds write scope before earlier-file READY tasks are considered', (context) => {
  const subject = fixture(context, [
    { id: 'T-01', scope: 'src/shared/file.mjs' },
    { id: 'T-02', scope: 'src/shared/' },
  ]);
  subject.taskBranch('T-02');
  const result = output(subject);
  state(result, 'T-02', 'MERGE');
  conflict(result, 'T-01', 'T-02');
  dispatch(result, []);
});

test('unmet dependency precedes resource conflict classification', (context) => {
  const subject = fixture(context, [
    { id: 'T-01', depends: 'T-03', scope: 'src/shared/file.mjs' },
    { id: 'T-02', scope: 'src/shared/' },
    { id: 'T-03', scope: 'docs/' },
  ]);
  subject.runtime([agent({}, { 'pipeline.task': 'T-02' })]);
  const result = output(subject);
  state(result, 'T-01', 'BLOCKED');
  state(result, 'T-02', 'ACTIVE');
  dispatch(result, ['T-03']);
});

test('SCEN-DAG-06 disjoint scopes dispatch concurrently within cap', (context) => {
  const subject = fixture(context, [{ id: 'T-01', scope: 'src/alpha/' }, { id: 'T-02', scope: 'src/beta/' }]);
  const result = output(subject, ['--cap', '2']);
  state(result, 'T-01', 'READY');
  state(result, 'T-02', 'READY');
  dispatch(result, ['T-01', 'T-02']);
});

test('zero cap leaves READY classification intact without dispatch', (context) => {
  const result = output(fixture(context), ['--cap', '0']);
  state(result, 'T-01', 'READY');
  dispatch(result, []);
});

test('SCEN-DAG-06 segment-prefix lookalikes do not conflict: src/a/b vs src/a/bc', (context) => {
  const subject = fixture(context, [{ id: 'T-01', scope: 'src/a/b' }, { id: 'T-02', scope: 'src/a/bc' }]);
  const result = output(subject, ['--cap', '2']);
  state(result, 'T-01', 'READY');
  state(result, 'T-02', 'READY');
  dispatch(result, ['T-01', 'T-02']);
});

test('SCEN-DAG-02 directory overlaps nested file: src/a/ vs src/a/b/c.mjs', (context) => {
  const subject = fixture(context, [{ id: 'T-04', scope: 'src/a/' }, { id: 'T-05', scope: 'src/a/b/c.mjs' }]);
  const result = output(subject);
  state(result, 'T-04', 'READY');
  conflict(result, 'T-05', 'T-04');
  dispatch(result, ['T-04']);
});

test('SCEN-DAG-02 leading-dot segments are normalized: src/a/ vs ./src/a/file.mjs', (context) => {
  const subject = fixture(context, [{ id: 'T-01', scope: 'src/a/' }, { id: 'T-02', scope: './src/a/file.mjs' }]);
  const result = output(subject);
  state(result, 'T-01', 'READY');
  conflict(result, 'T-02', 'T-01');
  dispatch(result, ['T-01']);
});

test('SCEN-DAG-02 duplicate slashes are normalized: src/a//b vs src/a/b/c', (context) => {
  const subject = fixture(context, [{ id: 'T-01', scope: 'src/a//b' }, { id: 'T-02', scope: 'src/a/b/c' }]);
  const result = output(subject);
  state(result, 'T-01', 'READY');
  conflict(result, 'T-02', 'T-01');
  dispatch(result, ['T-01']);
});

test('SCEN-DAG-02 dot-dot pops a segment: src/x/../a vs src/a/f', (context) => {
  const subject = fixture(context, [{ id: 'T-01', scope: 'src/x/../a' }, { id: 'T-02', scope: 'src/a/f' }]);
  const result = output(subject);
  state(result, 'T-01', 'READY');
  conflict(result, 'T-02', 'T-01');
  dispatch(result, ['T-01']);
});

test('SCEN-DAG-02 dot-dot escaping root fails closed as INVALID', (context) => {
  const subject = fixture(context, [
    { id: 'T-02', scope: '../escape' },
    { id: 'T-01', scope: 'src/a/' },
    { id: 'T-03', scope: 'docs/' },
  ]);
  const result = output(subject, ['--cap', '3']);
  state(result, 'T-01', 'READY');
  state(result, 'T-02', 'INVALID');
  state(result, 'T-03', 'READY');
  dispatch(result, ['T-01', 'T-03']);
});

test('SCEN-DAG-06 normalization is case-preserving: SRC/A vs src/a stay disjoint', (context) => {
  const subject = fixture(context, [{ id: 'T-01', scope: 'SRC/A' }, { id: 'T-02', scope: 'src/a' }]);
  const result = output(subject, ['--cap', '2']);
  state(result, 'T-01', 'READY');
  state(result, 'T-02', 'READY');
  dispatch(result, ['T-01', 'T-02']);
});

test('SCEN-DAG-03 Done source that cannot expand to a unique commit is INVALID', (context) => {
  const subject = fixture(context);
  const source = subject.taskBranch();
  subject.mergeTask(source, [doneTask({ ...source, tip: 'ffffffffffffffffffffffffffffffffffffffff' })]);
  const result = output(subject);
  state(result, 'T-01', 'INVALID');
  dispatch(result, []);
});

// T-02 写范围路径合法性：输入类别 → 期望（表驱动）。
// 非法类别一律 BAD_SCOPE_PATH → INVALID 且不可派发；合法类别仅做规范化比较。
const invalidScopeCases = [
  ['POSIX absolute path', '/x'],
  ['POSIX absolute multi-segment', '/outside/file'],
  ['double-slash UNC form', '//srv/share'],
  ['windows drive absolute with backslash', 'C:\\x'],
  ['windows drive absolute with slash', 'C:/x'],
  ['drive-relative path', 'C:x'],
  ['UNC with backslashes', '\\\\srv\\share'],
  ['backslash dot-dot escape', '..\\outside'],
  ['embedded backslash separator', 'src\\a'],
  ['leading dot-dot escapes root', '..'],
  ['mid-path pop past root', 'a/../../b'],
  ['trailing dot-dot escapes root', 'a/../..'],
  ['NUL character', 'src/\0x'],
  ['control character', 'src/\x01x'],
];

for (const [name, scope] of invalidScopeCases) {
  test(`SCEN-DAG-02 invalid scope (${name}) is BAD_SCOPE_PATH INVALID and not dispatchable`, (context) => {
    const subject = fixture(context, [{ id: 'T-01', scope }, { id: 'T-02', scope: 'docs/' }]);
    const result = output(subject, ['--cap', '2']);
    state(result, 'T-01', 'INVALID');
    const entry = result.INVALID.find((item) => taskId(item) === 'T-01');
    assert.match(entry.reason, /BAD_SCOPE_PATH/);
    state(result, 'T-02', 'READY');
    dispatch(result, ['T-02']);
  });
}

// 合法输入只规范化；expected = 两个 scope 是否冲突（段前缀重叠）。
const normalizationCases = [
  ['trailing slash equivalence', 'src/a/', 'src/a', true],
  ['dot segment removed', 'src/a/', './src/a/f.mjs', true],
  ['duplicate slashes collapse', 'src/a//b', 'src/a/b/c', true],
  ['dot-dot pops within root', 'src/x/../a', 'src/a/f', true],
  ['file and directory prefix overlap', 'src/a', 'src/a/b.mjs', true],
  ['root scope overlaps everything', '.', 'docs/', true],
  ['normalizes-to-root overlaps everything', 'a/..', 'docs/', true],
  ['adjacent segment prefixes stay disjoint', 'src/a/b', 'src/a/bc', false],
  ['glob characters are literal segments', 'src/*', 'src/a', false],
  ['case is preserved', 'SRC/A', 'src/a', false],
];

for (const [name, first, second, expectedConflict] of normalizationCases) {
  test(`SCEN-DAG-02/06 scope normalization (${name})`, (context) => {
    const subject = fixture(context, [{ id: 'T-01', scope: first }, { id: 'T-02', scope: second }]);
    const result = output(subject, ['--cap', '2']);
    state(result, 'T-01', 'READY');
    if (expectedConflict) {
      conflict(result, 'T-02', 'T-01');
      dispatch(result, ['T-01']);
    } else {
      state(result, 'T-02', 'READY');
      dispatch(result, ['T-01', 'T-02']);
    }
  });
}

test('SCEN-DAG-02 invalid scope held by an ACTIVE writer fails closed against all candidates', (context) => {
  const subject = fixture(context, [{ id: 'T-01', scope: '/outside/file' }, { id: 'T-02', scope: 'docs/' }]);
  subject.runtime([agent({ id: 'writer-1' }, { 'pipeline.task': 'T-01' })]);
  const result = output(subject);
  state(result, 'T-01', 'ACTIVE');
  conflict(result, 'T-02', 'T-01');
  dispatch(result, []);
});

test('blank Write scope field is INVALID via MISSING_SCOPE', (context) => {
  const subject = fixture(context, '- [ ] 1.1 T-01 Task T-01\n  - Depends on: none\n  - Write scope:   \n');
  const result = output(subject);
  state(result, 'T-01', 'INVALID');
  dispatch(result, []);
});
