import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// guard-scope 是 PreToolUse 侧的减速带：有编排租约期间，命中任务 Write scope 的写入必须
// 能对上一个在途写手意图。它与 reconcile 的脏树检测共用 `isFileWithinScopes` 与
// `WRITER_ROLES` 两个属主，所以判据不会在两侧漂移。
//
// 刻意保守的边界同样要测：无租约放行、scope 外放行、读不到 tasks.md 放行（fail-open）。
// 守卫是减速带不是沙箱——锁死工作区的代价远大于漏拦一次。
const script = fileURLToPath(new URL('../guard-scope.mjs', import.meta.url));
const change = 'guard-demo';

function fixture(context, { tasks = null, lease = null, intents = [] } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'pipeline-guard-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  const changeDir = path.join(repo, 'openspec', 'changes', change);
  mkdirSync(changeDir, { recursive: true });
  if (tasks !== null) writeFileSync(path.join(changeDir, 'tasks.md'), tasks);
  mkdirSync(path.join(repo, 'src'), { recursive: true });
  const stateDir = path.join(root, 'run-state');
  const env = {
    ...process.env,
    PIPELINE_RUN_STATE_DIR: stateDir,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  if (lease !== null || intents.length > 0) {
    const dir = path.join(stateDir, change);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'run-state.json'), `${JSON.stringify({
      version: 1, run: 'local', lease, intents, heartbeats: [],
    }, null, 2)}\n`);
  }
  execFileSync('git', ['init', '-q', '-b', 'integration'], { cwd: repo, env, stdio: 'ignore' });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repo, env, stdio: 'ignore' });
  const run = (file, extra = []) => spawnSync(process.execPath, [script, change, '--path', file, '--json', ...extra], {
    cwd: repo, env, encoding: 'utf8', timeout: 30_000,
  });
  return { root, repo, env, run };
}

const TASKS = `- [ ] 1.1 T-01 Demo task
  - Depends on: none
  - Write scope: src/T-01.mjs
  - Verify with: \`true\`
`;

const validLease = () => ({
  owner: 'lead-a', generation: 1, acquiredAt: new Date().toISOString(), renewedAt: null,
  expiresAt: new Date(Date.now() + 1_800_000).toISOString(), ttlMs: 1_800_000,
});

const writerIntent = (overrides = {}) => ({
  key: 'local:T-01:1:impl:gongbu:dispatch',
  task: 'T-01', attempt: 1, phase: 'impl', role: 'gongbu', action: 'dispatch',
  createdAt: new Date().toISOString(), resolvedAt: new Date().toISOString(),
  agentId: '11111111-1111-1111-1111-111111111111', workspaceId: null,
  ...overrides,
});

function verdictOf(result) {
  assert.equal(result.status === 0 || result.status === 2, true,
    `unexpected exit ${result.status}: ${result.stderr}`);
  assert.equal(typeof result.stdout === 'string' && result.stdout.trim() !== '', true,
    `guard must always print a verdict (empty stdout would silently allow): ${result.stderr}`);
  return JSON.parse(result.stdout);
}

test('SCEN-GRD-01 no lease means the guard does not apply (daily edits are not a pipeline run)', (context) => {
  const subject = fixture(context, { tasks: TASKS });
  const result = verdictOf(subject.run('src/T-01.mjs'));
  assert.equal(result.verdict, 'allow');
  assert.match(result.reason, /无编排租约/);
});

test('SCEN-GRD-01 an expired lease also does not apply', (context) => {
  const subject = fixture(context, {
    tasks: TASKS,
    lease: { ...validLease(), expiresAt: new Date(Date.now() - 60_000).toISOString() },
  });
  const result = verdictOf(subject.run('src/T-01.mjs'));
  assert.equal(result.verdict, 'allow');
  assert.match(result.reason, /租约已过期/);
});

test('SCEN-GRD-02 a pending writer intent for the scope owner allows the write', (context) => {
  const subject = fixture(context, {
    tasks: TASKS, lease: validLease(), intents: [writerIntent({ resolvedAt: null, agentId: null })],
  });
  const result = verdictOf(subject.run('src/T-01.mjs'));
  assert.equal(result.verdict, 'allow');
  assert.deepEqual(result.covered, ['T-01']);
  assert.match(result.reason, /含在途未回执/);
});

test('SCEN-GRD-02 a recorded writer intent (real agent) also allows the write', (context) => {
  const subject = fixture(context, { tasks: TASKS, lease: validLease(), intents: [writerIntent()] });
  const result = verdictOf(subject.run('src/T-01.mjs'));
  assert.equal(result.verdict, 'allow');
  assert.deepEqual(result.scopeOwners, ['T-01']);
});

test('SCEN-GRD-03 the exact LESSONS §13 shape is denied: lease active, scope hit, no writer intent', (context) => {
  // 2026-10-27：总控在主 checkout 直接写了 T-02 的 Write scope 文件并跑通单测。
  // 那时没有任何写手意图，租约却在生效。
  const subject = fixture(context, { tasks: TASKS, lease: validLease() });
  const raw = subject.run('src/T-01.mjs');
  assert.equal(raw.status, 2, 'must exit 2 so a hook can deny');
  const result = verdictOf(raw);
  assert.equal(result.verdict, 'deny');
  assert.match(result.reason, /没有这些任务的写手意图/);
  assert.match(result.reason, /总控不得直接改业务代码/);
  assert.deepEqual(result.scopeOwners, ['T-01']);
});

test('SCEN-GRD-03 a voided (failed) writer intent authorises nothing', (context) => {
  const subject = fixture(context, {
    tasks: TASKS, lease: validLease(),
    intents: [writerIntent({ failedAt: new Date().toISOString(), reason: '创建失败' })],
  });
  const raw = subject.run('src/T-01.mjs');
  assert.equal(raw.status, 2);
  assert.equal(verdictOf(raw).verdict, 'deny');
});

test('SCEN-GRD-03 a reviewer intent does not authorise a write', (context) => {
  const subject = fixture(context, {
    tasks: TASKS, lease: validLease(),
    intents: [writerIntent({ role: 'anchasi', phase: 'audit' })],
  });
  const result = subject.run('src/T-01.mjs');
  assert.equal(result.status, 2, '只读角色意图不构成写授权');
});

test('SCEN-GRD-04 a path outside every Write scope is allowed (merge exit 30 owns that judgement)', (context) => {
  const subject = fixture(context, { tasks: TASKS, lease: validLease() });
  const result = verdictOf(subject.run('src/other.mjs'));
  assert.equal(result.verdict, 'allow');
  assert.match(result.reason, /不在任何任务的 Write scope 内/);
});

test('SCEN-GRD-04 openspec/ is the flow\'s own writing range, not a task scope', (context) => {
  const subject = fixture(context, { tasks: TASKS, lease: validLease() });
  const result = verdictOf(subject.run('openspec/changes/guard-demo/tasks.md'));
  assert.equal(result.verdict, 'allow');
  assert.match(result.reason, /openspec\//);
});

test('SCEN-GRD-04 an unreadable tasks.md fails open, never locking the workspace', (context) => {
  const subject = fixture(context, { tasks: null, lease: validLease() });
  const result = verdictOf(subject.run('src/T-01.mjs'));
  assert.equal(result.verdict, 'allow');
  assert.match(result.reason, /fail-open/);
});

test('SCEN-GRD-05 PIPELINE_GUARD_SCOPE=off is an explicit escape hatch', (context) => {
  const subject = fixture(context, { tasks: TASKS, lease: validLease() });
  const result = spawnSync(process.execPath, [script, change, '--path', 'src/T-01.mjs', '--json'], {
    cwd: subject.repo, env: { ...subject.env, PIPELINE_GUARD_SCOPE: 'off' }, encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  assert.match(JSON.parse(result.stdout).reason, /PIPELINE_GUARD_SCOPE=off/);
});

test('SCEN-GRD-06 without a change name the guard scans every active lease (hook shape)', (context) => {
  const subject = fixture(context, { tasks: TASKS, lease: validLease() });
  const result = spawnSync(process.execPath, [script, '--path', 'src/T-01.mjs', '--json'], {
    cwd: subject.repo, env: subject.env, encoding: 'utf8',
  });
  assert.equal(result.status, 2, '扫描形态同样要拦住');
  const verdict = JSON.parse(result.stdout);
  assert.equal(verdict.verdict, 'deny');
  assert.equal(verdict.change, change);
});

test('SCEN-GRD-06 the scan ignores ledger directories named like flags', (context) => {
  const subject = fixture(context, { tasks: TASKS, lease: validLease() });
  const stray = path.join(subject.root, 'run-state', '--change');
  mkdirSync(stray, { recursive: true });
  writeFileSync(path.join(stray, 'run-state.json'), JSON.stringify({
    version: 1, run: 'local', intents: [], heartbeats: [], lease: validLease(),
  }));
  const result = spawnSync(process.execPath, [script, '--path', 'src/T-01.mjs', '--json'], {
    cwd: subject.repo, env: subject.env, encoding: 'utf8',
  });
  const verdict = JSON.parse(result.stdout);
  assert.equal(verdict.change, change, '历史遗留的旗标形态目录不得被当成 change');
});

test('SCEN-GRD-05 a flag-shaped change name is a usage error, never a stray ledger', (context) => {
  const subject = fixture(context, { tasks: TASKS, lease: validLease() });
  const result = spawnSync(process.execPath, [script, '--change', 'guard-demo', '--path', 'src/T-01.mjs'], {
    cwd: subject.repo, env: subject.env, encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /change 必须作为位置参数给出/);
  assert.match(result.stderr, /正确写法：node guard-scope\.mjs <change>/);
});

// --- PreToolUse hook 适配层（hooks/scope-guard-hook.mjs） ---
//
// hook 是判据的**第二个调用点**，所以两条约束必须被测试证伪：
//   1. 事件里不是写入工具 / 没有路径 / JSON 不合法的输入一律不输出（不干预）；
//   2. 判定为 deny 时必须输出 Claude Code 认识的 permissionDecision 结构。
// 如果这两条只靠人工走查，hook 会在某次协议变更后静默失效——而它失效时没有任何信号。
const hook = fileURLToPath(new URL('../hooks/scope-guard-hook.mjs', import.meta.url));

function runHook(subject, payload) {
  return spawnSync(process.execPath, [hook], {
    cwd: subject.repo, env: subject.env, encoding: 'utf8', timeout: 30_000,
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
}

test('SCEN-GRD-07 the hook stays silent for non-write tools, missing paths and junk input', (context) => {
  const subject = fixture(context, { tasks: TASKS, lease: validLease() });
  for (const payload of [
    { tool_name: 'Read', tool_input: { file_path: 'src/T-01.mjs' } },
    { tool_name: 'Bash', tool_input: { command: 'echo x > src/T-01.mjs' } },
    { tool_name: 'Write', tool_input: {} },
    'not json',
  ]) {
    const result = runHook(subject, payload);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), '', `hook 不应输出任何内容：${JSON.stringify(payload)}`);
  }
});

test('SCEN-GRD-07 the hook emits a real PreToolUse deny for an unexplained scope write', (context) => {
  const subject = fixture(context, { tasks: TASKS, lease: validLease() });
  const result = runHook(subject, {
    session_id: 'hook-test', tool_name: 'Write',
    tool_input: { file_path: path.join(subject.repo, 'src', 'T-01.mjs'), content: 'x' },
  });
  assert.equal(result.status, 0, 'hook 自身退出码恒为 0；裁决走 JSON');
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /T-01 的 Write scope/);
});

test('SCEN-GRD-07 the hook allows a scope write that has a writer intent', (context) => {
  const subject = fixture(context, { tasks: TASKS, lease: validLease(), intents: [writerIntent()] });
  const result = runHook(subject, {
    session_id: 'hook-test', tool_name: 'Edit',
    tool_input: { file_path: path.join(subject.repo, 'src', 'T-01.mjs') },
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), '');
});

test('SCEN-GRD-07 no lease means the hook never interferes', (context) => {
  const subject = fixture(context, { tasks: TASKS });
  const result = runHook(subject, {
    session_id: 'hook-test', tool_name: 'Write',
    tool_input: { file_path: path.join(subject.repo, 'src', 'T-01.mjs') },
  });
  assert.equal(result.stdout.trim(), '');
});

test('SCEN-GRD-07 --install-help prints a settings.json fragment naming this hook', (context) => {
  const subject = fixture(context, { tasks: TASKS });
  const result = spawnSync(process.execPath, [hook, '--install-help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /hooks\.PreToolUse/);
  assert.match(result.stdout, /scope-guard-hook\.mjs/);
  assert.match(result.stdout, /PreToolUse|matcher/);
});
