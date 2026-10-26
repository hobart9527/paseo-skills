import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 运行态有两个真实来源，二者形状不同（2026-10-25 实测 Paseo CLI 0.12.0）：
//   1. 持久元数据 ~/.paseo/agents/<cwd-slug>/<id>.json —— 唯一带 labels 的来源；
//   2. `paseo ls --json --all` —— 只有 8 个字段 {created,cwd,id,name,provider,shortId,status,thinking}，**无 labels**。
// 本测试的替身必须复刻这两个来源的真实形状；旧版把 labels 塞进 `paseo ls` 输出，
// 与真实 CLI 契约不符，导致全绿但生产不可用。
const reconcile = fileURLToPath(new URL('../reconcile.mjs', import.meta.url));
const fixtureDir = fileURLToPath(new URL('./fixtures/paseo-state', import.meta.url));
const change = 'reconcile-contract';
const integration = `integration/${change}`;
const states = ['INVALID', 'DONE', 'ACTIVE', 'UNRESOLVED', 'MERGE', 'BLOCKED', 'BLOCKED_RESOURCE', 'INTENT_PENDING', 'READY'];

/** 录制样本的字段集合（来自真实 `paseo ls --json --all` 输出）。 */
function recordedLsKeys() {
  const recorded = JSON.parse(readFileSync(path.join(fixtureDir, 'ls-json-all-label.json'), 'utf8'));
  return recorded.rowKeys;
}

function markdown(tasks) {
  return tasks.map((task, index) => [
    `- [${task.done ? 'x' : ' '}] 1.${index + 1} ${task.id} Task ${task.id}`,
    `  - Depends on: ${task.depends ?? 'none'}`,
    `  - Write scope: ${task.scope ?? `src/${task.id}.mjs`}`,
    ...(task.doneLine ? [`  - Done: ${task.doneLine}`] : []),
  ].join('\n')).join('\n\n');
}

/**
 * 构造一条**真实形状**的持久元数据记录。
 * 键集合与录制样本一致（见下方 schema 断言测试）；`status` 是仅供测试书写的输入别名，
 * 落盘时换算成真实字段 `lastStatus`。
 */
function agent(overrides = {}, labels = {}) {
  const { status = 'running', id = 'agent-01', name, title = name ?? 'contract worker', ...rest } = overrides;
  return {
    id,
    title,
    status,
    cwd: '~/.paseo/worktrees/fake/repo',
    provider: 'codex',
    lastModeId: 'full-access',
    createdAt: '2026-10-25T05:00:00.000Z',
    updatedAt: '2026-10-25T05:05:00.000Z',
    lastActivityAt: '2026-10-25T05:05:00.000Z',
    lastUserMessageAt: null,
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    internal: false,
    archivedAt: null,
    persistence: { provider: 'codex', sessionId: 'fixture', nativeHandle: 'fixture', metadata: null },
    runtimeInfo: { provider: 'codex', model: 'gpt', thinkingOptionId: 'high', modeId: 'full-access' },
    config: {},
    features: {},
    workspaceId: 'wks_fixture',
    ...rest,
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
  const home = path.join(root, 'paseo-home');
  const agentsDir = path.join(home, 'agents', '-fake-repo');
  const runtimeFile = path.join(root, 'runtime.json');
  const tasksFile = path.join(cwd, 'openspec', 'changes', change, 'tasks.md');
  mkdirSync(path.dirname(tasksFile), { recursive: true });
  mkdirSync(bin);
  mkdirSync(agentsDir, { recursive: true });
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
    PIPELINE_PASEO_HOME: home,
    PIPELINE_PASEO_BIN: path.join(bin, 'paseo'),
    PIPELINE_RUN_STATE_DIR: path.join(root, 'run-state'),
  };
  const git = (...args) => execFileSync('git', args, {
    cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
  }).trim();
  const writeTasks = (value) => writeFileSync(tasksFile, typeof value === 'string' ? value : markdown(value));
  // runtime(): 写真实持久元数据 + 供 CLI 回放的 fixture（ls 只有 8 字段，permit ls 提供权限暂停）。
  const runtime = (agents = [], mode = 'ok') => {
    for (const file of readdirSync(agentsDir)) rmSync(path.join(agentsDir, file), { force: true });
    const rows = [];
    const permits = [];
    for (const entry of agents) {
      const record = typeof entry === 'string' ? agent({}, { 'pipeline.role': entry }) : { ...entry };
      // 构造指令（均非真实持久字段）：pendingPermission 由 `paseo permit ls` 提供；
      // noLabels 模拟持久记录缺 labels 键（schema 漂移 → runtime 必须降级）；
      // rawLabels 直接替换整个 labels 对象（模拟真实存在「有 labels 键但无 pipeline.* 标签」的 agent）。
      const pendingPermission = record.pendingPermission === true;
      delete record.pendingPermission;
      const noLabels = record.noLabels === true;
      delete record.noLabels;
      const rawLabels = record.rawLabels;
      delete record.rawLabels;
      if (noLabels) delete record.labels;
      else if (rawLabels !== undefined) record.labels = rawLabels;
      // 真实持久文件用 lastStatus，构造器为可读性用 status；写出时按真实 schema 落盘。
      if ('status' in record) record.lastStatus = record.status;
      delete record.status;
      writeFileSync(path.join(agentsDir, `${record.id}.json`), JSON.stringify(record, null, 2));
      const row = {
        id: record.id,
        shortId: String(record.id).slice(0, 7),
        name: record.title ?? record.id,
        provider: 'codex/gpt',
        thinking: 'high',
        status: record.lastStatus,
        cwd: record.cwd,
        created: '1 minute ago',
      };
      // 替身形状必须与录制样本逐字段一致；真实 CLI 一旦增减字段，这里会比生产更早失败。
      assert.deepEqual(Object.keys(row).sort(), [...recordedLsKeys()].sort(),
        'paseo ls 替身行字段必须与 test/fixtures/paseo-state 的录制样本一致');
      rows.push(row);
      if (pendingPermission) {
        permits.push({ id: `perm-${record.id}`, agentId: record.id, name: 'shell', description: '-' });
      }
    }
    writeFileSync(runtimeFile, JSON.stringify({ rows, permits, mode }));
  };
  // CLI 替身：只实现真实存在的两个只读命令，输出字段与录制样本一致（无 labels）。
  writeFileSync(path.join(bin, 'paseo'), `#!${process.execPath}
import { readFileSync } from 'node:fs';
const fixture = JSON.parse(readFileSync(process.env.RECONCILE_RUNTIME_FIXTURE, 'utf8'));
if (fixture.mode === 'exit') {
  process.stderr.write('daemon unavailable\\n');
  process.exit(1);
}
const argv = process.argv.slice(2);
const emit = (value) => process.stdout.write(fixture.mode === 'garbage' ? 'not JSON' : JSON.stringify(value));
if (argv[0] === 'permit') emit(fixture.mode === 'no-permit' ? [] : fixture.permits);
else if (argv[0] === 'ls') {
  // no-rows：主源可读但 CLI 返回空集（持久文件与 daemon 不一致）→ 必须降级。
  if (fixture.mode === 'no-rows') process.stdout.write('[]');
  else emit(fixture.rows);
}
else { process.stderr.write('unexpected command\\n'); process.exit(2); }
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

  /** Pod 冻结成员文件（真实路径 openspec/changes/<change>/pod-members.json）。 */
  function podMembers(tasks) {
    writeFileSync(
      path.join(cwd, 'openspec', 'changes', change, 'pod-members.json'),
      `${JSON.stringify({ tasks }, null, 2)}\n`
    );
    git('add', 'openspec');
    git('commit', '-qm', 'Freeze pod members');
  }

  /** Pod 分支 pod/<change>：分支名不携带 task 身份，身份只能来自冻结成员文件。 */
  function podBranch(name = `pod/${change}`) {
    const branch = name;
    git('checkout', '-qb', branch);
    const filename = `pod-work-${++branchCount}.txt`;
    writeFileSync(path.join(cwd, filename), `${branch}\n`);
    git('add', filename);
    git('commit', '-qm', 'Pod work');
    const tip = git('rev-parse', 'HEAD');
    git('checkout', '-q', integration);
    return { branch, tip };
  }

  /** 写运行账本（真实路径由 PIPELINE_RUN_STATE_DIR 指定，与生产同一 schema）。 */
  function runState(value) {
    const file = path.join(root, 'run-state', change, 'run-state.json');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  }

  return { git, writeTasks, runtime, taskBranch, mergeTask, run, podMembers, podBranch, runState, root };
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

/**
 * fail-closed 断言：守卫必须**真的**拦住派发，而不是只在全绿路径上验输出形状。
 * 同时要求给出可诊断的 holdReason —— 静默清空和没有守卫一样危险。
 */
function heldClosed(result, pattern) {
  dispatch(result, []);
  assert.ok(Array.isArray(result.holdReasons), 'holdReasons must be an array');
  assert.ok(result.holdReasons.length > 0, 'fail-closed must record at least one hold reason');
  assert.match(JSON.stringify(result.holdReasons), pattern);
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
    heldClosed(result, /runtime=unavailable/);
  });
}

// fail-closed 不是死代码：三种「读不到 / 读不全 / 两源不一致」都必须清空派发。
// 这些用例的 READY 任务没有任何资源冲突，若守卫失效就会真的被派出去。
const settled = agent(
  { id: 'settled', status: 'closed' },
  { 'pipeline.task': 'T-01', 'pipeline.disposition': 'handed-off' },
);
for (const [name, build, expectedRuntime, pattern] of [
  ['labels 键缺失', (s) => s.runtime([agent({ noLabels: true })]), 'degraded', /runtime=degraded/],
  ['CLI 行集合为空', (s) => s.runtime([settled], 'no-rows'), 'degraded', /runtime=degraded/],
  ['runtime 不可用', (s) => s.runtime([], 'exit'), 'unavailable', /runtime=unavailable/],
]) {
  test(`SCEN-REC-13 degraded/unavailable (${name}) clears canDispatchNow`, (context) => {
    const subject = fixture(context, [{ id: 'T-01', scope: 'src/alpha/' }, { id: 'T-02', scope: 'src/beta/' }]);
    build(subject);
    const result = output(subject, ['--cap', '3']);
    assert.equal(result.runtime, expectedRuntime);
    state(result, 'T-01', 'READY');
    state(result, 'T-02', 'READY');
    heldClosed(result, pattern);
  });
}

test('SCEN-REC-13 UNMAPPED live agent holds dispatch even when runtime is ok', (context) => {
  const subject = fixture(context, [{ id: 'T-01', scope: 'src/alpha/' }]);
  // 归属全靠标题通道，而标题解析不出 change → 归属不可判定，必须挂起。
  subject.runtime([agent({ id: 'orphan', title: '[Pipeline] Runner 实施', rawLabels: {} })]);
  const result = output(subject);
  assert.equal(result.runtime, 'ok');
  state(result, 'T-01', 'READY');
  heldClosed(result, /UNMAPPED/);
});

test('SCEN-REC-15 live writer of another change is FOREIGN, not a reason to hold this change', (context) => {
  const subject = fixture(context, [{ id: 'T-01', scope: 'src/alpha/' }]);
  subject.runtime([agent({
    id: 'other-change', rawLabels: {}, title: '[Pipeline] Runner 实施 T-01 other-change-slug',
  })]);
  const result = output(subject);
  assert.deepEqual(result.UNMAPPED, []);
  assert.equal(result.FOREIGN.length, 1);
  assert.equal(result.foreignLiveWriters, 1);
  dispatch(result, ['T-01']);
});

test('SCEN-REC-17 a live writer on a parse-INVALID task (MISSING_SCOPE) still occupies cap', (context) => {
  // 解析级 INVALID（MISSING_SCOPE）过去直接 continue：cap 不算它、占用集里也没有它。
  // 后果是报告显示 cap 仍有余量，而实际已经有人在写一个我们无法界定写范围的任务。
  // scope 未知时按「与一切重叠」保守占位。
  const subject = fixture(context, [
    '- [ ] 1.1 T-01 Task T-01\n  - Depends on: none\n  - Write scope:   ',
    '- [ ] 1.2 T-02 Task T-02\n  - Depends on: none\n  - Write scope: src/beta/\n',
  ].join('\n\n'));
  subject.runtime([agent({ id: 'writer-1' }, { 'pipeline.task': 'T-01' })]);
  const result = output(subject);
  state(result, 'T-01', 'INVALID');
  assert.equal(result.liveWriterCount, 1, 'a live writer must be counted even when its scope is unknown');
  // 另一任务即使 scope 不重叠也保守串行：未知范围不能被证明不冲突。
  conflict(result, 'T-02', 'T-01');
  dispatch(result, []);
});

test('SCEN-REC-17 live writers of other changes are counted against the shared repository', (context) => {
  // foreignLiveWriters 过去只报告不计 cap：同仓两个 change 各派 3 个写手时，
  // 每个 change 都以为自己只用了 cap/2。它们改的是同一个仓库，隔离只在 worktree 层面，
  // 共享文件、端口、DB 文件都不被 worktree 隔离。
  const subject = fixture(context, [{ id: 'T-01', scope: 'src/alpha/' }]);
  const withCap = (extra) => {
    subject.runtime(extra);
    return output(subject, ['--cap', '2']);
  };
  const result = withCap([
    agent({ id: 'other-change', rawLabels: {}, title: '[Pipeline] Runner 实施 T-01 other-change-slug' }),
  ]);
  assert.deepEqual(result.UNMAPPED, []);
  assert.equal(result.FOREIGN.length, 1);
  assert.equal(result.foreignLiveWriters, 1);
  // cap=2，1 个外部写手已占用 → 本 change 只剩 1 个名额；这里只有 1 个 READY 任务，仍可派。
  dispatch(result, ['T-01']);
  // 再加一个外部写手把 cap 占满：本 change 必须停派，并说明占用来自外部。
  const saturated = withCap([
    agent({ id: 'other-change', rawLabels: {}, title: '[Pipeline] Runner 实施 T-01 other-change-slug' }),
    agent({ id: 'other-change-2', rawLabels: {}, title: '[Pipeline] Runner 实施 T-02 other-change-slug' }),
  ]);
  heldClosed(saturated, /外部写手/);
});

test('SCEN-REC-15 liveWriterCount equals real writers, so cap counts truthfully', (context) => {
  const subject = fixture(context, [
    { id: 'T-01', scope: 'src/alpha/' },
    { id: 'T-02', scope: 'src/beta/' },
    { id: 'T-03', scope: 'src/gamma/' },
  ]);
  subject.runtime([agent({ id: 'w1' }, { 'pipeline.task': 'T-01' })]);
  const result = output(subject, ['--cap', '3']);
  assert.equal(result.liveWriterCount, 1);
  assert.equal(result.READY.length, 2);
  // cap 剩余 2 个槽位：两个互不冲突的 READY 都被放行，第 3 个（T-01 自身）是 ACTIVE。
  dispatch(result, ['T-02', 'T-03']);
  assert.ok(result.holdReasons.length === 0);
});

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
  for (const disposition of ['handed-off', 'rejected', 'abandoned']) {
    test(`SCEN-REC-09/11 disposition ${disposition} clears latest ${status} agent`, (context) => {
      const subject = fixture(context);
      subject.runtime([agent({ status }, { 'pipeline.disposition': disposition })]);
      const result = output(subject);
      state(result, 'T-01', 'READY');
      dispatch(result, ['T-01']);
    });
  }
}

// disposition=merged 是 agent 自报，不是验收事实：没有 first-parent 合流账本就没有 Done，
// 无领先分支也不能据此判定「已合流」。自报与事实矛盾时挂起核对，而不是放行派发。
for (const status of ['error', 'idle', 'closed']) {
  test(`SCEN-REC-11 self-reported merged without ledger does not release ${status} task`, (context) => {
    const subject = fixture(context);
    subject.runtime([agent({ status }, { 'pipeline.disposition': 'merged' })]);
    const result = output(subject);
    state(result, 'T-01', 'UNRESOLVED');
    assert.match(JSON.stringify(result.UNRESOLVED), /自称 disposition=merged/);
    dispatch(result, []);
  });
}

// 待批权限属于**某一次派发**，不是「本任务的当前状态」。只看最新一条终态 agent 时，
// 一个更新 attempt 的普通终态会把仍被人卡着的旧 attempt 盖掉：授权一旦被拒绝，
// 任务已经被当成 READY 重派，等于双写。这里的旧 attempt 必须仍然冻住任务。
test('SCEN-REC-11 a pending permission on an older attempt is not masked by a newer terminal agent', (context) => {
  const subject = fixture(context);
  subject.runtime([
    agent({ id: 'old-attempt', status: 'idle', pendingPermission: true }, {
      'pipeline.attempt': '1', 'pipeline.disposition': 'abandoned',
    }),
    agent({ id: 'newer-attempt', status: 'idle' }, {
      'pipeline.attempt': '2', 'pipeline.disposition': 'rejected',
    }),
  ]);
  const result = output(subject);
  state(result, 'T-01', 'UNRESOLVED');
  assert.equal(result.UNRESOLVED[0].agent, 'old-attempt', '必须指向真正待批的那一条');
  dispatch(result, []);
});

// 自报 merged 的报错必须指回判定所依据的那条 agent。走列表首位时，
// 一条更早的无害 attempt 会被当成矛盾方，人按 id 去查会查错对象。
test('SCEN-REC-11 a self-reported merged contradiction names the latest agent, not the first one listed', (context) => {
  const subject = fixture(context);
  subject.runtime([
    agent({ id: 'attempt-one', status: 'closed' }, { 'pipeline.attempt': '1', 'pipeline.disposition': 'merged' }),
    agent({ id: 'attempt-two', status: 'closed' }, { 'pipeline.attempt': '2', 'pipeline.disposition': 'merged' }),
  ]);
  const result = output(subject);
  state(result, 'T-01', 'UNRESOLVED');
  assert.equal(result.UNRESOLVED[0].agent, 'attempt-two');
});

// 自报 merged 且分支确实领先：分支这一可核验事实优先，进 MERGE 走正常合流门禁。
test('SCEN-REC-11 self-reported merged with an ahead branch routes to MERGE not READY', (context) => {
  const subject = fixture(context);
  subject.taskBranch();
  subject.runtime([agent({ status: 'idle' }, { 'pipeline.disposition': 'merged' })]);
  const result = output(subject);
  state(result, 'T-01', 'MERGE');
  dispatch(result, []);
});

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

// 2026-10-25 冻结澄清：非法 scope 先于 ACTIVE 判 INVALID，但写入占用保留（fail closed）。
test('SCEN-DAG-02 invalid scope held by a live writer is INVALID and fails closed against all candidates', (context) => {
  const subject = fixture(context, [{ id: 'T-01', scope: '/outside/file' }, { id: 'T-02', scope: 'docs/' }]);
  subject.runtime([agent({ id: 'writer-1' }, { 'pipeline.task': 'T-01' })]);
  const result = output(subject);
  state(result, 'T-01', 'INVALID');
  conflict(result, 'T-02', 'T-01');
  dispatch(result, []);
});

test('blank Write scope field is INVALID via MISSING_SCOPE', (context) => {
  const subject = fixture(context, '- [ ] 1.1 T-01 Task T-01\n  - Depends on: none\n  - Write scope:   \n');
  const result = output(subject);
  state(result, 'T-01', 'INVALID');
  dispatch(result, []);
});

for (const scope of ['../outside', '/abs']) {
  for (const [name, expected, worker, ahead, done, depends] of [
    ['verified Done evidence', 'DONE', null, false, true],
    ['initializing writer', 'ACTIVE', agent({ status: 'initializing' })],
    ['running writer', 'ACTIVE', agent()],
    ['initializing read-only Auditor', 'ACTIVE', agent({ status: 'initializing' }, { 'pipeline.role': 'anchasi', 'pipeline.phase': 'audit' })],
    ['running read-only Auditor', 'ACTIVE', agent({}, { 'pipeline.role': 'anchasi', 'pipeline.phase': 'audit' })],
    ...['error', 'idle', 'closed'].map((status) => [
      `${status} without disposition`, 'UNRESOLVED', agent({ status }),
    ]),
    ...['error', 'idle', 'closed'].map((status) => [
      `${status} with disposition`, 'READY', agent({ status }, { 'pipeline.disposition': 'rejected' }),
    ]),
    ['pending permission', 'UNRESOLVED', agent({ status: 'idle', pendingPermission: true })],
    ['pending permission with disposition', 'UNRESOLVED', agent({ status: 'idle', pendingPermission: true }, { 'pipeline.disposition': 'abandoned' })],
    ['ahead task branch', 'MERGE', null, true],
    ['unmet dependency', 'BLOCKED', null, false, false, 'T-02'],
    ['ordinary READY task', 'READY'],
  ]) {
    test(`SCEN-REC-13 scope ${scope} is INVALID before ${name}`, (context) => {
      const tasks = [{ id: 'T-01', depends }, { id: 'T-02', scope: 'docs/' }];
      const subject = fixture(context, tasks);
      if (done) {
        const source = subject.taskBranch();
        tasks[0] = doneTask(source);
        subject.mergeTask(source, tasks);
      } else if (ahead) {
        subject.taskBranch();
      }
      if (worker) subject.runtime([worker]);
      state(output(subject), 'T-01', expected);
      subject.writeTasks([{ ...tasks[0], scope }, tasks[1]]);
      const result = output(subject);
      state(result, 'T-01', 'INVALID');
      assert.ok(!ids(result, 'canDispatchNow').includes('T-01'));
    });
  }

  test(`SCEN-REC-13 verified Done evidence with scope ${scope} cannot release a dependent`, (context) => {
    const dependent = { id: 'T-02', depends: 'T-01' };
    const subject = fixture(context, [{ id: 'T-01' }, dependent]);
    const source = subject.taskBranch();
    const completed = doneTask(source);
    subject.mergeTask(source, [completed, dependent]);
    const accepted = output(subject);
    state(accepted, 'T-01', 'DONE');
    state(accepted, 'T-02', 'READY');
    subject.writeTasks([{ ...completed, scope }, dependent]);
    const result = output(subject);
    state(result, 'T-02', 'BLOCKED');
    assert.ok(!ids(result, 'DONE').includes('T-01'));
    dispatch(result, []);
    state(result, 'T-01', 'INVALID');
  });

  for (const status of ['initializing', 'running']) {
    for (const cap of [1, 3]) {
      test(`SCEN-REC-14 INVALID scope ${scope} retains ${status} writer occupancy at cap=${cap}`, (context) => {
        const candidates = [
          { id: 'T-02', scope: 'docs/' },
          { id: 'T-03', scope: 'src/unrelated.mjs' },
          { id: 'T-04', scope: 'assets/' },
        ];
        const subject = fixture(context, [{ id: 'T-01', scope }, ...candidates]);
        const args = ['--cap', String(cap)];
        const available = output(subject, args);
        state(available, 'T-01', 'INVALID');
        for (const candidate of candidates) state(available, candidate.id, 'READY');
        dispatch(available, candidates.slice(0, cap).map((candidate) => candidate.id));
        subject.runtime([agent({ id: 'invalid-scope-writer', status })]);
        const result = output(subject, args);
        assert.equal(result.cap, cap);
        assert.equal(result.RUNNING.length, 1);
        assert.equal(result.RUNNING[0].id, 'invalid-scope-writer');
        for (const candidate of candidates) conflict(result, candidate.id, 'T-01');
        dispatch(result, []);
        state(result, 'T-01', 'INVALID');
      });
    }
  }
}

// --- disposition 转移与打回预算（L1-06） ---
// 实测真实 disposition 只有 rejected（pipeline-native-closure 的 T-02 连续 4 次）。
// 旧实现把 rejected 一律回流 READY，等于无预算重派：反复被拒的任务可以无限自旋。

test('SCEN-REC-16 one rejection keeps the task dispatchable (budget remains)', (context) => {
  const subject = fixture(context);
  subject.runtime([agent({ status: 'idle' }, { 'pipeline.disposition': 'rejected' })]);
  const result = output(subject);
  state(result, 'T-01', 'READY');
  dispatch(result, ['T-01']);
});

test('SCEN-REC-16 rejections at the escalation threshold re-dispatch as gaogong, not BLOCKED', (context) => {
  // 语义变更（2026-10-26）：SKILL 与归档 design 都写「打回 2 轮 + 升级高工 1 次」，
  // 即第 2 次打回不是终点，而是**升级重派**的起点。旧实现在这里直接 BLOCKED，
  // 使「升级」变成一句没有执行载体的承诺。
  const subject = fixture(context);
  subject.runtime([
    agent({ id: 'r1', status: 'idle' }, { 'pipeline.attempt': '1', 'pipeline.phase': 'impl', 'pipeline.disposition': 'rejected' }),
    agent({ id: 'r2', status: 'idle' }, { 'pipeline.attempt': '2', 'pipeline.phase': 'impl', 'pipeline.disposition': 'rejected' }),
  ]);
  const result = output(subject);
  state(result, 'T-01', 'READY');
  dispatch(result, ['T-01']);

  // 升级目标必须是机器可读的：只写在提示词里，执行器无从得知该换哪个角色。
  const ready = result.READY.find((r) => r.id === 'T-01');
  assert.equal(ready.escalate, true, '第 2 次打回后必须标记升级重派');
  assert.equal(ready.role, 'gaogong', '升级目标角色必须是 gaogong');
  assert.equal(ready.rejections, 2);

  const action = (result.nextAction.actions ?? []).find((a) => a.kind === 'dispatch');
  assert.ok(action, `必须给出 dispatch 动作：${JSON.stringify(result.nextAction)}`);
  assert.deepEqual(action.tasks, ['T-01'], '任务标识形状不得因升级而改变（既有公开契约）');
  assert.deepEqual(action.escalations, [{ task: 'T-01', role: 'gaogong', rejections: 2 }]);
});

test('SCEN-REC-16 a third rejection exhausts the budget and blocks for human arbitration', (context) => {
  const subject = fixture(context);
  subject.runtime([
    agent({ id: 'r1', status: 'idle' }, { 'pipeline.attempt': '1', 'pipeline.phase': 'impl', 'pipeline.disposition': 'rejected' }),
    agent({ id: 'r2', status: 'idle' }, { 'pipeline.attempt': '2', 'pipeline.phase': 'impl', 'pipeline.disposition': 'rejected' }),
    agent({ id: 'r3', status: 'idle' }, { 'pipeline.attempt': '3', 'pipeline.phase': 'impl', 'pipeline.disposition': 'rejected' }),
  ]);
  const result = output(subject);
  state(result, 'T-01', 'BLOCKED');
  assert.match(JSON.stringify(result.BLOCKED), /打回预算耗尽/);
  dispatch(result, []);
});

test('SCEN-REC-16 a below-threshold task carries no escalation fields (negative control)', (context) => {
  // 负向对照：升级字段只在升级重派时出现。若它无条件出现，执行器会以为每个任务都要换角色。
  const subject = fixture(context);
  subject.runtime([agent({ status: 'idle' }, { 'pipeline.disposition': 'rejected' })]);
  const result = output(subject);
  state(result, 'T-01', 'READY');
  const ready = result.READY.find((r) => r.id === 'T-01');
  assert.equal(ready.escalate, undefined, '未达阈值不得携带 escalate');
  assert.equal(ready.role, undefined, '未达阈值不得携带 role');
  const action = (result.nextAction.actions ?? []).find((a) => a.kind === 'dispatch');
  assert.equal(action.escalations, undefined, '未达阈值不得出现 escalations 数组');
});

test('SCEN-REC-16 escalation only names tasks actually inside canDispatchNow', (context) => {
  // cap=1 且两个任务都到升级阈值：只有进入 canDispatchNow 的那个能带升级指令，
  // 否则执行器会按 escalations 派发一个本就不该派的任务（突破 cap）。
  const subject = fixture(context, [
    { id: 'T-01', scope: 'src/a.mjs' },
    { id: 'T-02', scope: 'src/b.mjs' },
  ]);
  subject.runtime([
    agent({ id: 'a1', status: 'idle' }, { 'pipeline.task': 'T-01', 'pipeline.attempt': '1', 'pipeline.disposition': 'rejected' }),
    agent({ id: 'a2', status: 'idle' }, { 'pipeline.task': 'T-01', 'pipeline.attempt': '2', 'pipeline.disposition': 'rejected' }),
    agent({ id: 'b1', status: 'idle' }, { 'pipeline.task': 'T-02', 'pipeline.attempt': '1', 'pipeline.disposition': 'rejected' }),
    agent({ id: 'b2', status: 'idle' }, { 'pipeline.task': 'T-02', 'pipeline.attempt': '2', 'pipeline.disposition': 'rejected' }),
  ]);
  const result = output(subject, ['--cap', '1']);
  assert.equal(result.canDispatchNow.length, 1);
  const dispatched = result.canDispatchNow[0].split(' ')[0];
  const action = (result.nextAction.actions ?? []).find((a) => a.kind === 'dispatch');
  assert.deepEqual(action.escalations.map((e) => e.task), [dispatched],
    'escalations 必须与 canDispatchNow 同一口径');
});

test('SCEN-REC-16 mixed rejected and abandoned both consume the retry budget', (context) => {
  const subject = fixture(context);
  subject.runtime([
    agent({ id: 'r1', status: 'error' }, { 'pipeline.attempt': '1', 'pipeline.disposition': 'rejected' }),
    agent({ id: 'r2', status: 'idle' }, { 'pipeline.attempt': '2', 'pipeline.disposition': 'abandoned' }),
  ]);
  state(output(subject), 'T-01', 'READY');
  const ready = output(subject).READY.find((r) => r.id === 'T-01');
  assert.equal(ready.escalate, true, 'abandoned 与 rejected 同样消耗预算，达到阈值即升级');
});

test('SCEN-REC-16 handed-off and superseded do not consume the retry budget', (context) => {
  const subject = fixture(context);
  subject.runtime([
    agent({ id: 'h1', status: 'idle' }, { 'pipeline.attempt': '1', 'pipeline.disposition': 'handed-off' }),
    agent({ id: 'h2', status: 'idle' }, { 'pipeline.attempt': '2', 'pipeline.disposition': 'handed-off' }),
    agent({ id: 'h3', status: 'idle' }, { 'pipeline.attempt': '3', 'pipeline.disposition': 'superseded' }),
  ]);
  const result = output(subject);
  state(result, 'T-01', 'READY');
  dispatch(result, ['T-01']);
});

test('SCEN-REC-16 a rejected attempt branch is STALE, never the merge target', (context) => {
  // 分支领先 = 有产物，但产物来自**被判回的 attempt**。合流它等于接受被拒绝的成果，
  // 而且最新 attempt（2）什么都没交出去。旧实现把这种分支直接当 MERGE，等于用旧产物顶掉返工。
  // 正确结论：旧 attempt 分支报 STALE_BRANCH，任务本身按预算处置
  // （两次打回 → 进入升级重派，不是 BLOCKED；第 3 次才耗尽）。
  const subject = fixture(context);
  subject.taskBranch();
  subject.runtime([
    agent({ id: 'r1', status: 'idle' }, { 'pipeline.attempt': '1', 'pipeline.disposition': 'rejected' }),
    agent({ id: 'r2', status: 'idle' }, { 'pipeline.attempt': '2', 'pipeline.disposition': 'rejected' }),
  ]);
  const result = output(subject);
  state(result, 'T-01', 'READY');
  assert.equal(result.READY.find((r) => r.id === 'T-01').escalate, true);
  assert.equal(result.staleBranches.length, 1);
  assert.equal(result.staleBranches[0].attempt, 1);
  assert.equal(result.staleBranches[0].latestAttempt, 2);
});

test('SCEN-REC-16 the latest attempt branch is the merge target, attempts compared numerically', (context) => {
  // `git for-each-ref` 的字典序把 `-a10` 排在 `-a2` 之前，旧实现的 `branches.find(...)`
  // 会把第 2 次尝试的旧分支当成目标。必须按数值选最高 attempt，并且只认 latest。
  const subject = fixture(context);
  subject.taskBranch('T-01', '-a2');
  const latestBranch = subject.taskBranch('T-01', '-a10');
  subject.runtime([agent({ id: 'h10', status: 'idle' }, { 'pipeline.attempt': '10', 'pipeline.disposition': 'handed-off' })]);
  const result = output(subject);
  state(result, 'T-01', 'MERGE');
  assert.equal(result.MERGE[0].branch, latestBranch.branch);
  assert.deepEqual(result.staleBranches.map((e) => e.attempt), [2]);
});

// --- Pod 分支身份恢复（L1-07） ---
// pod/<change> 分支名不携带任务身份。旧实现在没有冻结成员记录时把它当成「映射不到任何任务」，
// 于是一个已经交付工作的 Pod 分支既不进 MERGE、也不报错，被静默忽略。

test('SCEN-REC-17 a pod branch with frozen members maps to those tasks and enters MERGE', (context) => {
  const subject = fixture(context, [{ id: 'T-01' }, { id: 'T-02', depends: 'T-01' }, { id: 'T-03' }]);
  // T-01 已合流（先让它 DONE），这样 T-02 依赖满足，Pod 分支负责 T-02 与 T-03。
  const source = subject.taskBranch('T-01');
  subject.mergeTask(source, [{ ...{ id: 'T-01' }, done: true, doneLine: `source=${source.tip.slice(0, 7)} review=pass(12345678@${source.tip.slice(0, 7)}/7654321)` }, { id: 'T-02', depends: 'T-01' }, { id: 'T-03' }]);
  subject.podMembers(['T-02', 'T-03']);
  subject.podBranch();
  const result = output(subject);
  state(result, 'T-02', 'MERGE');
  state(result, 'T-03', 'MERGE');
  assert.deepEqual(result.UNMAPPED, []);
});

test('SCEN-REC-17 a leading pod branch without frozen members is UNMAPPED, never silently ignored', (context) => {
  const subject = fixture(context, [{ id: 'T-01' }]);
  subject.podBranch();
  const result = output(subject);
  state(result, 'T-01', 'READY');
  assert.equal(result.UNMAPPED.length, 1);
  assert.match(result.UNMAPPED[0].reason, /pod-members\.json/);
  heldClosed(result, /UNMAPPED/);
});

test('SCEN-REC-17 a nested pod branch that resolves to no task is UNMAPPED, not silent', (context) => {
  // `for-each-ref refs/heads/pod/<change>` 是路径段前置匹配，会把 `pod/<change>/<x>` 也列出来。
  // 旧判据只认「第三段为 undefined」，嵌套分支的第三段是 `<x>`：既解析不出任务，也不进 UNMAPPED，
  // 分支领先成集成分支时 reconcile 报「没有待处理项」——工作已经做完却永远不会被合流。
  const subject = fixture(context, [{ id: 'T-01' }]);
  subject.podBranch(`pod/${change}/nested`);
  const result = output(subject);
  state(result, 'T-01', 'READY');
  assert.equal(result.UNMAPPED.length, 1, JSON.stringify(result.UNMAPPED));
  assert.match(result.UNMAPPED[0].id, /pod\//);
  heldClosed(result, /UNMAPPED/);
});

// --- 确定的下一动作（L4-02） ---
// 决策内核必须输出「该做什么、为什么」，且优先级确定；调用方不得各自再推导一遍。

// 逐任务阻塞只压住被点名的任务。一条非法/待裁决的任务不该冻结整轮推进——
// 旧版任一 INVALID/UNRESOLVED 就输出单一 arbitrate，同时可以把无关任务饿死一整轮。
test('SCEN-REC-18 an invalid task does not freeze dispatch of an unrelated ready task', (context) => {
  const subject = fixture(context, [
    { id: 'T-01', scope: '/outside/file' },
    { id: 'T-02', scope: 'src/T-02.mjs' },
  ]);
  const result = output(subject);
  state(result, 'T-01', 'INVALID');
  state(result, 'T-02', 'READY');
  assert.equal(result.nextAction.kind, 'arbitrate', '主结论仍先报阻塞');
  assert.deepEqual(result.nextAction.tasks, ['T-01 Task T-01']);
  const dispatchAction = result.nextAction.actions.find((a) => a.kind === 'dispatch');
  assert.ok(dispatchAction, `应与仲裁同轮给出派发动作: ${JSON.stringify(result.nextAction)}`);
  assert.deepEqual(dispatchAction.tasks, ['T-02']);
  // NEXT 的 dispatch 与 canDispatchNow 必须说同一件事，否则执行器无从判断该不该派。
  assert.deepEqual(result.canDispatchNow, ['T-02 Task T-02']);
});

test('SCEN-REC-18 an unresolved task does not freeze merge of an unrelated ahead branch', (context) => {
  const subject = fixture(context, [{ id: 'T-01', scope: 'src/T-01.mjs' }, { id: 'T-02', scope: 'src/T-02.mjs' }]);
  subject.taskBranch('T-02');
  subject.runtime([agent({ id: 'stuck-1', status: 'idle' }, { 'pipeline.task': 'T-01' })]);
  const result = output(subject);
  state(result, 'T-01', 'UNRESOLVED');
  state(result, 'T-02', 'MERGE');
  assert.equal(result.nextAction.kind, 'arbitrate');
  const mergeAction = result.nextAction.actions.find((a) => a.kind === 'merge');
  assert.ok(mergeAction, `应与仲裁同轮给出合流动作: ${JSON.stringify(result.nextAction)}`);
  assert.deepEqual(mergeAction.tasks.map((t) => t.task), ['T-02']);
});

test('SCEN-REC-18 global blockers still yield exactly one action', (context) => {
  // 观测不可信时任何局部结论都失去依据：这条仍是单一 hold，不得再给 merge/dispatch。
  const subject = fixture(context, [{ id: 'T-01', scope: '/outside/file' }, { id: 'T-02' }]);
  subject.runtime([], 'exit');
  const result = output(subject);
  assert.equal(result.runtime, 'unavailable');
  assert.equal(result.nextAction.kind, 'hold');
  assert.deepEqual(result.nextAction.actions.map((a) => a.kind), ['hold']);
});

test('SCEN-REC-18 nextAction dispatch names the ready tasks with a capacity reason', (context) => {
  const result = output(fixture(context, [{ id: 'T-01' }, { id: 'T-02' }]));
  assert.equal(result.nextAction.kind, 'dispatch');
  assert.deepEqual(result.nextAction.tasks, ['T-01', 'T-02']);
  assert.match(result.nextAction.reason, /cap=3/);
});

test('SCEN-REC-18 nextAction prefers human arbitration over dispatch when a terminal agent is unresolved', (context) => {
  const subject = fixture(context);
  subject.runtime([agent({ status: 'idle' })]);
  const result = output(subject);
  state(result, 'T-01', 'UNRESOLVED');
  assert.equal(result.nextAction.kind, 'arbitrate');
  dispatch(result, []);
});

test('SCEN-REC-18 nextAction prefers merge over dispatch when a branch is ahead', (context) => {
  const subject = fixture(context);
  subject.taskBranch();
  const result = output(subject);
  assert.equal(result.nextAction.kind, 'merge');
  assert.deepEqual(result.nextAction.tasks.map((t) => t.task), ['T-01']);
});

test('SCEN-REC-18 nextAction holds everything when runtime is not ok', (context) => {
  const subject = fixture(context);
  subject.runtime([], 'exit');
  const result = output(subject);
  assert.equal(result.runtime, 'unavailable');
  assert.equal(result.nextAction.kind, 'hold');
  assert.match(result.nextAction.reason, /unavailable/);
});

test('SCEN-REC-18 nextAction finalizes only when every task is verified Done', (context) => {
  const subject = fixture(context);
  const source = subject.taskBranch();
  const done = { id: 'T-01', done: true, doneLine: `source=${source.tip.slice(0, 7)} review=pass(12345678@${source.tip.slice(0, 7)}/7654321)` };
  subject.mergeTask(source, [done]);
  const result = output(subject);
  state(result, 'T-01', 'DONE');
  assert.equal(result.nextAction.kind, 'finalize');
});

// --- 运行账本：动作意图去重与编排租约（L4-03） ---
// Git 记已合流事实、tasks.md 记任务契约、Paseo 记 Agent 事实，三者都不记「已发出但尚未落盘
// 的派发」。缺这一层时，创建请求在途的窗口会被再派一次，造成同一任务双写同一文件。

function intent(overrides = {}) {
  const task = overrides.task ?? 'T-01';
  return {
    key: `local:${task}:1:impl:gongbu:dispatch`,
    task,
    attempt: 1,
    phase: 'impl',
    role: 'gongbu',
    action: 'dispatch',
    createdAt: new Date().toISOString(),
    resolvedAt: null,
    agentId: null,
    workspaceId: null,
    ...overrides,
  };
}

test('SCEN-REC-19 an open dispatch intent blocks a repeat dispatch of the same task', (context) => {
  const subject = fixture(context, [{ id: 'T-01' }]);
  subject.runState({ version: 1, run: 'local', lease: null, intents: [intent()], heartbeats: [] });
  const result = output(subject);
  state(result, 'T-01', 'INTENT_PENDING');
  dispatch(result, []);
  assert.match(JSON.stringify(result.INTENT_PENDING), /禁止重复派发/);
  heldClosed(result, /派发意图尚无回执/);
});

test('SCEN-REC-19 an intent that already has a matching live agent is not a repeat either', (context) => {
  const subject = fixture(context, [{ id: 'T-01' }]);
  subject.runtime([agent({ id: 'live-1', status: 'running' }, { 'pipeline.task': 'T-01' })]);
  subject.runState({ version: 1, run: 'local', lease: null, intents: [intent()], heartbeats: [] });
  const result = output(subject);
  // 真实 agent 已在跑：任务本身是 ACTIVE，意图也应有对应 agent，不得重复派发。
  state(result, 'T-01', 'ACTIVE');
  dispatch(result, []);
});

test('SCEN-REC-19 an overdue intent with no agent at all becomes an orphan for arbitration', (context) => {
  const subject = fixture(context, [{ id: 'T-01' }]);
  const stale = new Date(Date.now() - 45 * 60 * 1000).toISOString();
  subject.runState({
    version: 1, run: 'local', lease: null,
    intents: [intent({ createdAt: stale })], heartbeats: [],
  });
  const result = output(subject);
  state(result, 'T-01', 'INTENT_PENDING');
  assert.equal(result.ORPHAN_INTENT.length, 1);
  assert.match(result.ORPHAN_INTENT[0].reason, /仍无对应 agent/);
  // 自动化不得自行重派孤儿意图：那正是重复派发的来源，必须交执行器核对。
  assert.equal(result.nextAction.kind, 'arbitrate');
  assert.match(result.nextAction.reason, /超期仍无对应 agent/);
  dispatch(result, []);
});

test('SCEN-REC-19 an intent for a different attempt does not block this attempt', (context) => {
  const subject = fixture(context, [{ id: 'T-01' }]);
  subject.runState({
    version: 1, run: 'local', lease: null,
    intents: [intent({ key: 'local:T-01:1:impl:gongbu:dispatch', attempt: 1 })],
    heartbeats: [],
  });
  // 意图是 attempt=1，当前无 agent，仍在宽限内 → 保守挂起，不得直接判定 attempt=2 可派。
  const result = output(subject);
  state(result, 'T-01', 'INTENT_PENDING');
});

test('SCEN-REC-19 an expired lease is reported for the executor, without changing task classification', (context) => {
  const subject = fixture(context, [{ id: 'T-01' }]);
  subject.runState({
    version: 1, run: 'local',
    lease: {
      owner: 'lead-a', generation: 3, acquiredAt: null, renewedAt: null,
      expiresAt: new Date(Date.now() - 60_000).toISOString(), ttlMs: 1_800_000,
    },
    intents: [], heartbeats: [],
  });
  const result = output(subject);
  assert.equal(result.lease.owner, 'lead-a');
  assert.equal(result.lease.generation, 3);
  assert.equal(result.lease.valid, false, 'an expired lease must not read as valid');
  // 租约只报告，不改判定：任务本身没有其它阻塞理由时仍是 READY。
  state(result, 'T-01', 'READY');
});

test('SCEN-REC-19 no run-state file at all is not an error and blocks nothing', (context) => {
  const result = output(fixture(context, [{ id: 'T-01' }]));
  assert.equal(result.lease, null, 'no lease record means the lease feature is not in use');
  assert.deepEqual(result.INTENT_PENDING, []);
  assert.deepEqual(result.ORPHAN_INTENT, []);
  state(result, 'T-01', 'READY');
});

test('SCEN-REC-19 a corrupt run-state file is reported as absent, never fatal to reconcile', (context) => {
  const subject = fixture(context, [{ id: 'T-01' }]);
  const file = path.join(subject.root, 'run-state', change, 'run-state.json');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '{ not json');
  const result = output(subject);
  assert.equal(result.lease, null);
  state(result, 'T-01', 'READY');
});

// 以下三条来自 2026-10-26 在真实仓库（1604 条持久 agent）上的集成复验，修复前全部失败。
test('SCEN-REC-19 a same-named task agent in another change never satisfies this change intent', (context) => {
  // 真实事故形状：机器上每个 change 都有 T-01。旧版在全量 agents 里按 task 匹配，
  // 于是别的 change 里已终态的 T-01 被当成「本意图的 agent 已终态、回执丢失」，
  // 把一条仍在途的派发误判成需要仲裁的僵尸意图。
  const subject = fixture(context, [{ id: 'T-01' }]);
  subject.runtime([
    agent({ id: 'other-change-1', status: 'closed' }, {
      'pipeline.change': 'another-change',
      'pipeline.task': 'T-01',
    }),
  ]);
  subject.runState({ version: 1, run: 'local', lease: null, intents: [intent()], heartbeats: [] });

  const result = output(subject);
  state(result, 'T-01', 'INTENT_PENDING');
  const entry = result.INTENT_PENDING.find((item) => taskId(item) === 'T-01');
  assert.equal(entry.kind, 'pending', '异 change 的同名 agent 不得把在途意图判成回执丢失');
  assert.equal(result.nextAction.kind, 'wait');
  dispatch(result, []);
});

test('SCEN-REC-19 one intent appears exactly once in INTENT_PENDING and in the open count', (context) => {
  // 旧版逐任务分支与末尾批量补齐各输出一次，同一条意图出现两遍；
  // 执行器按条目数判断「还剩几件要收口」时会直接多算。
  const subject = fixture(context, [{ id: 'T-01' }, { id: 'T-02', scope: 'src/T-02.mjs' }]);
  subject.runState({
    version: 1, run: 'local', lease: null,
    intents: [intent()], heartbeats: [],
  });

  const result = output(subject);
  const keys = result.INTENT_PENDING.map((item) => item.key);
  assert.deepEqual(keys, ['local:T-01:1:impl:gongbu:dispatch']);
  assert.equal(result.INTENT_PENDING.length, 1);
  assert.equal(result.openIntentCount, 1);
  assert.match(JSON.stringify(result.holdReasons), /有 1 项派发意图尚无回执/);
});

test('SCEN-REC-19 a terminal agent with no receipt yields an arbitrate action, not an unexplained state', (context) => {
  // agent 已终态但台账没记回执：必须给出确定的收口动作（record 或 fail）。
  // 旧版让它落到把「在途」也吞掉的同一分支，NEXT 只能报「状态无法解释」。
  const subject = fixture(context, [{ id: 'T-01' }]);
  // 终态 agent 必须自带 disposition，否则任务先被归为 UNRESOLVED（那也是一条真实分支，
  // 但测的是「权限暂停/缺处置」，不是回执丢失）。这里用预算内的 rejected 让流程走到意图层。
  subject.runtime([agent({ id: 'lost-receipt-1', status: 'closed' }, {
    'pipeline.task': 'T-01', 'pipeline.disposition': 'rejected',
  })]);
  subject.runState({ version: 1, run: 'local', lease: null, intents: [intent()], heartbeats: [] });

  const result = output(subject);
  state(result, 'T-01', 'INTENT_PENDING');
  const entry = result.INTENT_PENDING.find((item) => taskId(item) === 'T-01');
  assert.equal(entry.kind, 'receipt-lost');
  assert.equal(entry.agents.length, 1);
  assert.equal(entry.agents[0].live, false);
  assert.equal(result.nextAction.kind, 'arbitrate');
  assert.match(result.nextAction.reason, /回执丢失/);
  assert.deepEqual(result.nextAction.tasks.map(taskId), ['T-01']);
  dispatch(result, []);
});

// --- 非 T- 前缀任务 ID 的 dispatch 动作 ---
//
// `lib/tasks.mjs` 明确定义任务 ID 为 `<前缀>-<数字>`（`TASK-01`、`BUG-3` 都合法），
// reconcile 也直接复用它。但 `nextAction` 组装 dispatch 动作时写的是
// `t.match(/\bT-\d+\b/)?.[0] ?? t`——只认 `T-` 前缀。于是 `TASK-01 Task TASK-01`
// 抽不出 ID，整条 label 被当成任务标识塞给执行器，派发标签就写错。
// 这里断言的是**动作里的任务标识必须等于真实任务 ID**，与 ID 前缀无关。
test('SCEN-REC-20: dispatch 动作给出的任务标识等于真实任务 ID（非 T- 前缀）', (context) => {
  const subject = fixture(context, [{ id: 'TASK-01' }]);
  const result = output(subject);
  const action = (result.nextAction.actions ?? []).find((a) => a.kind === 'dispatch');
  assert.ok(action !== undefined, `必须给出 dispatch 动作：${JSON.stringify(result.nextAction)}`);
  assert.deepEqual(action.tasks, ['TASK-01'], '动作里的任务标识必须是真实 ID，不能是「ID + 标题」整条 label');
});
