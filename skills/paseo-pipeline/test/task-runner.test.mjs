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

/**
 * `verify === null` 表示任务**不写** `Verify with` 字段（不是写空值）：SCEN-HND-12 要复现的
 * 是「冻结契约里根本没有验证命令」，那与「写了一句自然语言」是两种不同的缺失形态。
 */
function tasksContent(verifyCommand = passCommand, review = 'mechanical') {
  const verifyLine = verifyCommand === null ? [] : [`  - Verify with: ${verifyCommand}`];
  return [
    '# Tasks',
    '',
    '- [ ] 1.1 T-01 Task 1',
    '  - Depends on: none',
    '  - Write scope: src/a.txt',
    `  - Review: ${review}`,
    ...verifyLine,
    '',
    '- [ ] 1.2 T-02 Task 2',
    '  - Depends on: T-01',
    '  - Write scope: src/b.txt',
    `  - Review: ${review}`,
    ...verifyLine,
  ].join('\n');
}

/**
 * 合流替身：只记录 argv 与放宽门禁的变量，绝不真的合并。（ESM：与真实 merge-task.mjs 同形态）
 *
 * 微生命周期入口不得替调用者放宽任何合流门禁。原断言只盯 PIPELINE_ALLOW_HOMOGENEOUS_REVIEW
 * 一个变量——该变量随因子 3c 一起删了，断言就退化成永远成立的空转：测试还绿着，守的东西没了。
 * 改为记录所有 `PIPELINE_ALLOW_*`，与变量名解耦；fixture 又预先剔除了继承来的同名变量，
 * 所以这里出现的任何一条都只可能是入口自己设置的。
 */
const mergeStub = `import fs from 'node:fs';
import path from 'node:path';
const ledgerFile = process.env.PASEO_LEDGER_FILE;
const record = {
  argv: process.argv.slice(2),
  allowances: Object.keys(process.env).filter((key) => key.startsWith('PIPELINE_ALLOW_')).sort(),
  // 合流子进程运行期间，入口是不是还攥着 run-state 锁？锁文件与账本同目录
  // （run-state.lock），持有与否是可直接观测的文件事实，不需要探针进程。
  runStateLockHeld: fs.existsSync(path.join(path.dirname(ledgerFile), 'run-state.lock')),
};
fs.appendFileSync(process.env.MERGE_CALL_FILE, JSON.stringify(record) + '\\n');
process.exit(0);
`;

/**
 * 仓库 + Paseo 替身。
 *
 * 替身 `paseo` 记录每次 argv 并**真的**建一个 worktree（模拟 `--new-workspace worktree`
 * 的效果），这样 Verify 能落在写手的任务 workspace 上；它还会在 `run` 当时把运行账本
 * 快照落盘，用于断言「claim 发生在派发之前」。
 *
 * 默认写手**真的交付**：在任务分支上留下一个带 trailer 的提交，让「分支 tip 领先 base」
 * 是真实 git 事实。`PASEO_FIXTURE_NO_COMMIT=1` 才模拟零提交（写手没干活）——那是 exit 52
 * 场景，不能让它在既有测试里默不作声地成立。
 */
function fixture(context, { profile = { provider: 'claude', model: 'fixture-claude' }, verify, review = 'mechanical', noCommit = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-runner-test-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home', '.paseo');
  const bin = path.join(root, 'bin');
  const repo = path.join(root, 'repo');
  const callsFile = path.join(root, 'paseo-calls.jsonl');
  const snapshotFile = path.join(root, 'ledger-at-run.json');
  const worktreeDir = path.join(root, 'ws');
  const stateDir = path.join(root, 'ledger');
  const mergeDir = path.join(root, 'merge-bin');
  const mergeCallFile = path.join(root, 'merge-calls.jsonl');
  for (const directory of [home, bin, repo, mergeDir]) fs.mkdirSync(directory, { recursive: true });
  // PIPELINE_HOME 指向替身目录：只把 merge-task.mjs 换掉，run-state.mjs 与 lib 仍是真的。
  const realScripts = path.dirname(runnerScript);
  fs.writeFileSync(path.join(mergeDir, 'merge-task.mjs'), mergeStub, { mode: 0o755 });
  fs.symlinkSync(path.join(realScripts, 'run-state.mjs'), path.join(mergeDir, 'run-state.mjs'));
  fs.symlinkSync(path.join(realScripts, 'lib'), path.join(mergeDir, 'lib'));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    daemon: { agentProfiles: profile === null ? [] : [{ id: 'agent_profile_gongbu', ...profile }] },
  }));
  fs.writeFileSync(path.join(bin, 'paseo'), `#!/usr/bin/env node
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.PASEO_CALLS_FILE, JSON.stringify(argv) + '\\n');
const value = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
// 轮询次数由文件计数驱动：每次 inspect 前进一格，用来模拟「先失败、后 idle」与「永不到达」。
const bump = () => {
  const file = process.env.PASEO_FIXTURE_COUNTER_FILE;
  const n = (fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : 0) + 1;
  fs.writeFileSync(file, String(n));
  return n;
};
if (argv[0] === 'run') {
  if (process.env.PASEO_FIXTURE_FAIL_RUN === '1') {
    console.error('fixture: dispatch failed');
    process.exit(1);
  }
  const branch = value('--new-branch');
  const base = value('--base');
  execFileSync('git', ['worktree', 'add', '-q', '-b', branch, process.env.PASEO_FIXTURE_WORKTREE, base], { stdio: 'ignore' });
  // 写手默认真的交付一个提交；PASEO_FIXTURE_NO_COMMIT=1 才模拟「写手没干活」。
  // 落点必须是 tasksContent() 声明的 Write scope（src/a.txt），否则夹具一旦接真实
  // merge-task 就会因越界失败，也不再表达「写手在声明范围内交付」。
  if (process.env.PASEO_FIXTURE_NO_COMMIT !== '1') {
    const wt = process.env.PASEO_FIXTURE_WORKTREE;
    const delivered = require('node:path').join(wt, 'src', 'a.txt');
    fs.mkdirSync(require('node:path').dirname(delivered), { recursive: true });
    fs.writeFileSync(delivered, 'delivered by fixture writer\\n');
    execFileSync('git', ['-C', wt, 'add', 'src/a.txt'], { stdio: 'ignore' });
    execFileSync('git', ['-C', wt, 'commit', '-q', '-m',
      'feat: fixture writer delivery\\n\\nPipeline-Role: gongbu\\nPipeline-Author: ${AGENT_ID}'], { stdio: 'ignore' });
  }
  if (process.env.PASEO_SNAPSHOT_FILE) {
    const ledger = process.env.PASEO_LEDGER_FILE;
    fs.writeFileSync(process.env.PASEO_SNAPSHOT_FILE, fs.existsSync(ledger) ? fs.readFileSync(ledger, 'utf8') : '');
  }
  console.log('${AGENT_ID}');
} else if (argv[0] === 'wait') {
  // wait 模式：idle | error（终态：已崩）| failed（WAIT_FAILED + 非零退出）| timeout（首轮等满）
  const mode = process.env.PASEO_FIXTURE_WAIT || 'idle';
  if (mode === 'failed') {
    console.error('WAIT_FAILED');
    process.exit(1);
  }
  const status = mode === 'timeout' ? 'timeout' : (mode === 'error' ? 'error' : 'idle');
  console.log(JSON.stringify({ id: argv[1], status }));
} else if (argv[0] === 'inspect') {
  // inspect 模式：idle | error（终态：已崩）| never（永远 running）| late（第 2 次起 idle）| failed（非零退出）
  const mode = process.env.PASEO_FIXTURE_INSPECT || 'idle';
  const n = bump();
  if (mode === 'failed') {
    console.error('inspect failed');
    process.exit(1);
  }
  const status = mode === 'never' ? 'running'
    : (mode === 'error' ? 'error' : (mode === 'late' && n < 2 ? 'running' : 'idle'));
  console.log(JSON.stringify({ Id: argv[1], Name: 'fixture', Status: status }));
} else {
  console.error('Unexpected paseo command: ' + argv[0]);
  process.exit(1);
}
`, { mode: 0o755 });

  const env = {
    ...gitEnv,
    HOME: path.join(root, 'home'),
    PATH: [bin, path.dirname(process.execPath), process.env.PATH].join(path.delimiter),
    // PIPELINE_HOME 指向替身目录：合流调用落在 merge-task.mjs 替身上，绝不动真实仓库。
    PIPELINE_HOME: mergeDir,
    PIPELINE_PASEO_HOME: home,
    PIPELINE_RUN_STATE_DIR: stateDir,
    PIPELINE_AGENT_POLL_MS: '20',
    PASEO_CALLS_FILE: callsFile,
    PASEO_SNAPSHOT_FILE: snapshotFile,
    PASEO_LEDGER_FILE: path.join(stateDir, change, 'run-state.json'),
    PASEO_FIXTURE_WORKTREE: worktreeDir,
    PASEO_FIXTURE_COUNTER_FILE: path.join(root, 'inspect-count'),
    PASEO_FIXTURE_WAIT: 'idle',
    PASEO_FIXTURE_INSPECT: 'idle',
    PASEO_FIXTURE_NO_COMMIT: noCommit ? '1' : '0',
    MERGE_CALL_FILE: mergeCallFile,
  };
  // 继承来的门禁放宽变量不属于「入口自己设置的」，先剔掉，替身看到的才算入口行为。
  for (const key of Object.keys(env)) {
    if (key.startsWith('PIPELINE_ALLOW_')) delete env[key];
  }

  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Pipeline Test');
  git(repo, 'config', 'user.email', 'pipeline-test@example.invalid');
  git(repo, 'config', 'commit.gpgsign', 'false');
  write(repo, 'README.md', '# test repo\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-m', 'chore: initial commit');
  git(repo, 'checkout', '-b', integrationBranch);
  write(repo, tasksPath, tasksContent(verify, review));
  git(repo, 'add', tasksPath);
  git(repo, 'commit', '-m', 'docs: add tasks.md');

  return { cwd: repo, env, callsFile, snapshotFile, worktreeDir, stateDir, home, bin, mergeCallFile };
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

function ledgerPath(setup) {
  return path.join(setup.stateDir, change, 'run-state.json');
}

function ledger(setup) {
  const file = ledgerPath(setup);
  assert.ok(fs.existsSync(file), `run ledger must exist: ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function mergeCalls(setup) {
  if (!fs.existsSync(setup.mergeCallFile)) return [];
  return fs.readFileSync(setup.mergeCallFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
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

// SCEN-HND-05
test('task-runner derives the next attempt from existing -aN branches alone', (context) => {
  // 只有 `-a2`、没有基础分支：最大 attempt 是 2，重派必须落到 `-a3`，
  // 而不是回到已存在的 `-a2` 上去撞名。
  const setup = fixture(context, { verify: failCommand });
  git(setup.cwd, 'branch', `task/${change}/T-01-a2`, integrationBranch);
  const res = invoke(setup, [change, 'T-01']);
  assert.equal(res.status, 20, `${res.stdout}\n${res.stderr}`);

  const dispatched = runs(setup);
  assert.equal(dispatched.length, 1, `exactly one paseo run: ${res.stdout}\n${res.stderr}`);
  assert.deepEqual(optionValues(dispatched[0], '--new-branch'), [`task/${change}/T-01-a3`]);
  assert.ok(
    optionValues(dispatched[0], '--label').includes('pipeline.attempt=3'),
    `attempt label must be 3: ${optionValues(dispatched[0], '--label').join(',')}`,
  );

  const snapshot = JSON.parse(fs.readFileSync(setup.snapshotFile, 'utf8'));
  const intent = snapshot.intents.find((entry) => entry.task === 'T-01');
  assert.equal(intent.attempt, 3, 'the intent attempt must be 3 on redispatch');
});

test('task-runner exits 20 when verify command fails in the writer workspace', (context) => {
  const setup = fixture(context, { verify: failCommand });
  const res = invoke(setup, [change, 'T-01']);
  assert.equal(res.status, 20, `${res.stdout}\n${res.stderr}`);
  assert.match(res.stderr, /Verify command failed/);
});

// SCEN-HND-12
test('task-runner exits 36 when the task declares no Verify with and dispatches nothing', (context) => {
  // 旧实现在合流参数里写 `task.verify?.command || 'npm test'`：契约没有验证命令时，
  // 入口自己补一条默认测试命令，非 Node 仓库的交付就被一条无关命令「验过」。
  // 这里断言的是「拒绝而不是猜」：退出码与 merge-task 同一语义、点名任务、零派发、零合流，
  // 且拒在 claim 之前（账本文件根本不该出现）。
  const setup = fixture(context, { verify: null, review: 'mechanical' });
  const res = invoke(setup, [change, 'T-01', '--owner', 'test-owner']);

  assert.equal(res.status, 36, `${res.stdout}\n${res.stderr}`);
  assert.match(res.stderr, /T-01/, 'the failure must name the task');
  assert.match(res.stderr, /Verify with/, 'the failure must name the missing contract');
  assert.doesNotMatch(res.stderr, /npm test/,
    'the entry must not mention a substituted default test command at all');
  assert.equal(runs(setup).length, 0, 'an unverifiable task must not be dispatched');
  assert.equal(mergeCalls(setup).length, 0, 'an unverifiable task must not reach the merge gate');
  assert.equal(fs.existsSync(ledgerPath(setup)), false,
    'the refusal must happen before the intent is claimed');
});

// SCEN-HND-12
test('task-runner exits 36 in dry-run too, so the missing contract surfaces before dispatch', (context) => {
  // dry-run 的职责是提前暴露契约问题。缺失 Verify 不是「跑到测试才知道」的运行期失败，
  // 把它藏到 dry-run 之后再报等于让编排者按一次假绿的计划往下走。
  const setup = fixture(context, { verify: null });
  const res = invoke(setup, [change, 'T-01', '--dry-run']);
  assert.equal(res.status, 36, `${res.stdout}\n${res.stderr}`);
  assert.doesNotMatch(res.stdout, /Dry-run completed successfully/);
});

// SCEN-HND-12
test('task-runner exits 36 when Verify with is prose rather than an executable command', (context) => {
  // 与「字段缺失」是两种不同的缺失形态，判据都来自 lib/tasks.mjs 的同一份解析器：
  // command === null 表示那一行不是命令。拿描述当命令去跑，等于没有验证。
  const setup = fixture(context, { verify: 'run the full test suite', review: 'mechanical' });
  const res = invoke(setup, [change, 'T-01', '--owner', 'test-owner']);

  assert.equal(res.status, 36, `${res.stdout}\n${res.stderr}`);
  assert.match(res.stderr, /T-01/);
  assert.match(res.stderr, /natural-language description is not a test command/);
  assert.equal(runs(setup).length, 0, 'an unverifiable task must not be dispatched');
  assert.equal(mergeCalls(setup).length, 0, 'an unverifiable task must not reach the merge gate');
});

// SCEN-HND-12
test('task-runner exits 36 on a --review-tag re-entry with no executable Verify, never guessing one', (context) => {
  // 重入路径同样走合流（spec 的 WHEN 指向「reaches the merge step」）。旧实现里这条路径
  // 传给 merge-task 的仍是 `|| 'npm test'`，于是审计通过的交付会被一条默认命令替代冻结契约。
  const setup = fixture(context, { review: 'strict', verify: null });
  const branch = `task/${change}/T-01`;
  const { tip7, base7 } = deliverTaskBranch(setup, branch);

  const res = invoke(setup, [change, 'T-01', '--review-tag', `pass(1234abcd@${tip7}/${base7})`,
    '--owner', 'test-owner']);
  assert.equal(res.status, 36, `${res.stdout}\n${res.stderr}`);
  assert.equal(runs(setup).length, 0, 'a tagged re-entry must not dispatch the writer');
  assert.equal(mergeCalls(setup).length, 0,
    'no merge subprocess may run when the frozen contract carries no executable command');
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

/**
 * 在夹具仓库的任务分支上放一个真实交付提交：重入合流只读 git 事实（tip/base 由 tag 绑定），
 * 所以这里必须留下一个带写手 trailer 的 commit，而不是伪造一个 tag。
 */
function deliverTaskBranch(setup, branch, { author = AGENT_ID } = {}) {
  git(setup.cwd, 'checkout', '-b', branch, integrationBranch);
  write(setup.cwd, 'src/a.txt', 'delivered\n');
  git(setup.cwd, 'add', 'src/a.txt');
  git(setup.cwd, 'commit', '-m', `feat: ${branch}\n\nPipeline-Role: gongbu\nPipeline-Author: ${author}`);
  const tip7 = git(setup.cwd, 'rev-parse', '--short=7', branch);
  const base7 = git(setup.cwd, 'rev-parse', '--short=7', integrationBranch);
  git(setup.cwd, 'checkout', integrationBranch);
  return { tip7, base7 };
}

// SCEN-HND-06
test('task-runner exits 50 for a non-mechanical task and fabricates no audit facts', (context) => {
  const setup = fixture(context, { review: 'standard' });
  const res = invoke(setup, [change, 'T-01', '--owner', 'test-owner']);
  assert.equal(res.status, 50, `${res.stdout}\n${res.stderr}`);
  assert.match(res.stderr, /--review-tag/, 'the stop must name the re-entry flag');
  assert.equal(runs(setup).length, 1, 'the writer is dispatched exactly once');
  assert.equal(mergeCalls(setup).length, 0, 'a non-mechanical task must not merge on its own');

  // 账本里不得出现本入口自造的审计意图或审计结论。
  const state = ledger(setup);
  const auditIntents = state.intents.filter((entry) => entry.phase === 'audit');
  assert.deepEqual(auditIntents, [], `no audit intent may be created: ${JSON.stringify(auditIntents)}`);
  assert.deepEqual(state.reviews, [], `no review record may be created: ${JSON.stringify(state.reviews)}`);
});

test('task-runner exits 52 when the writer produced no commit (all review tiers)', (context) => {
  // 零提交时 Verify 跑的是未经任何修改的代码，假绿不能报成「已交付并通过 Verify」，
  // 也不能交给 merge-task 由 exit 31 事后兜底——那是「nothing to merge」，不是「写手没干活」。
  for (const review of ['mechanical', 'standard', 'strict']) {
    const setup = fixture(context, { review, noCommit: true });
    const res = invoke(setup, [change, 'T-01', '--owner', 'test-owner']);

    assert.equal(res.status, 52, `tier=${review}\n${res.stdout}\n${res.stderr}`);
    assert.match(res.stderr, /写手未产出提交/, `tier=${review}: 必须点明写手没干活`);
    assert.match(res.stderr, /tip[\s\S]{0,80}(base|基点)/i,
      `tier=${review}: 必须说明分支 tip 等于 base`);
    assert.doesNotMatch(res.stderr, /passed Verify/, `tier=${review}: 不得暗示 Verify 覆盖了实现`);
    // 只许陈述 git 事实：写手可能改了工作区却没提交，断言消息不得声称 Verify 跑的是基线代码。
    assert.doesNotMatch(res.stderr, /基线代码|baseline code|未经任何修改/i,
      `tier=${review}: 不得断言 Verify 跑的是基线代码（写手可能留下未提交改动）`);
    assert.doesNotMatch(res.stdout, /passed Verify/, `tier=${review}: 不得暗示 Verify 覆盖了实现`);
    assert.equal(runs(setup).length, 1, `tier=${review}: 写手仍只派发一次`);
    assert.equal(mergeCalls(setup).length, 0, `tier=${review}: 零提交不得进入合流`);
  }
});

test('task-runner exits 52 on a --review-tag re-entry when the task branch never advanced', (context) => {
  // 重入不派发写手，但 tip 等于基点说明那条分支没有交付内容可合——同样不能进 merge-task。
  // 合并门禁只会报「没有东西可合」，分不清空交付与「工作已被吸收」。
  const setup = fixture(context, { review: 'strict' });
  const branch = `task/${change}/T-01`;
  git(setup.cwd, 'branch', branch, integrationBranch);
  const tip7 = git(setup.cwd, 'rev-parse', '--short=7', branch);
  const base7 = git(setup.cwd, 'rev-parse', '--short=7', integrationBranch);
  assert.equal(tip7, base7, 'fixture precondition: the branch must sit exactly on the base');

  const res = invoke(setup, [change, 'T-01', '--review-tag', `pass(1234abcd@${tip7}/${base7})`,
    '--owner', 'test-owner']);
  assert.equal(res.status, 52, `${res.stdout}\n${res.stderr}`);
  assert.match(res.stderr, /写手未产出提交/);
  assert.equal(runs(setup).length, 0, 'a tagged re-entry must not dispatch the writer');
  assert.equal(mergeCalls(setup).length, 0, 'an unadvanced branch must not reach the merge gate');
});

// SCEN-HND-06
test('task-runner accepts a review tag re-entry and sets no gate relaxation', (context) => {
  const setup = fixture(context, { review: 'strict' });
  const branch = `task/${change}/T-01`;
  const { tip7, base7 } = deliverTaskBranch(setup, branch, { author: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
  const tag = `pass(1234abcd@${tip7}/${base7})`;

  const res = invoke(setup, [change, 'T-01', '--review-tag', tag, '--owner', 'test-owner']);
  assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
  assert.equal(runs(setup).length, 0, 'a tagged re-entry must not dispatch again');

  const merges = mergeCalls(setup);
  assert.equal(merges.length, 1, `exactly one merge call: ${JSON.stringify(merges)}`);
  assert.equal(merges[0].argv[0], branch, 'the merge must target the delivered task branch');
  assert.equal(merges[0].argv[2], tag, 'the review tag must be passed through verbatim');
  assert.deepEqual(merges[0].allowances, [],
    'the entry must not set any PIPELINE_ALLOW_* gate relaxation on the caller\'s behalf');

  // 重入也不得凭空登记审计事实：那是真实 Auditor 的账。文件缺失本身即「一次都没写账」。
  const state = fs.existsSync(ledgerPath(setup)) ? ledger(setup) : { intents: [], reviews: [] };
  assert.deepEqual(state.reviews, [], 'a tagged re-entry must not write review records');
  assert.deepEqual(state.intents.filter((entry) => entry.phase === 'audit'), [], 'no audit intent');
});

/**
 * 在夹具账本里放一份编排租约（形状与 run-state.mjs 落盘的一致）。
 *
 * 用文件而不是 `run-state begin`：夹具要精确控制 `expiresAt`（过期场景没法等 30 分钟），
 * 而租约字段本来就是这个形状——测试断言的是入口读账本的行为，不是 begin 的行为。
 */
function leaseLedgerJson({ owner, generation = 1, expiresAt }) {
  return `${JSON.stringify({
    version: 1,
    run: null,
    lease: {
      owner,
      generation,
      acquiredAt: new Date().toISOString(),
      renewedAt: null,
      expiresAt,
      ttlMs: 30 * 60 * 1000,
    },
    intents: [],
    heartbeats: [],
    reviews: [],
    merges: [],
    readyObs: [],
    confirmations: [],
    skill: null,
  }, null, 2)}\n`;
}

function writeLease(setup, { owner, generation = 1, expiresAt }) {
  fs.mkdirSync(path.dirname(ledgerPath(setup)), { recursive: true });
  fs.writeFileSync(ledgerPath(setup), leaseLedgerJson({ owner, generation, expiresAt }));
}

/** 直接落一份账本（续等入口要读「有回执的在途写手意图」，只有能预置意图才复现得出来）。 */
function writeLedger(setup, { lease = null, intents = [] }) {
  fs.mkdirSync(path.dirname(ledgerPath(setup)), { recursive: true });
  const state = JSON.parse(leaseLedgerJson({ owner: 'unused', expiresAt: new Date(0).toISOString() }));
  state.lease = lease;
  state.intents = intents;
  fs.writeFileSync(ledgerPath(setup), `${JSON.stringify(state, null, 2)}\n`);
}

/** 一条已回执的 impl 写手意图：`resolvedAt` 只代表回执已登记，不代表 agent 结束。 */
function writerIntent(agentId = AGENT_ID) {
  return {
    key: 'local:T-01:1:impl:gongbu:dispatch',
    task: 'T-01',
    attempt: 1,
    phase: 'impl',
    role: 'gongbu',
    action: 'dispatch',
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    resolvedAt: new Date(Date.now() - 59_000).toISOString(),
    agentId,
    workspaceId: null,
  };
}

function futureIso(ms = 30 * 60 * 1000) {
  return new Date(Date.now() + ms).toISOString();
}

/**
 * 在入口的 `bin` 目录里装一个 `git` 转发器：命中一次性目标调用时先把账本换成另一个 owner，
 * 再原样透传真正的 git。
 *
 * 为什么不用「等 N 毫秒后 begin」：那靠时序对齐，慢机器上必然飘。git 调用是入口内部
 * 确定会发生的同步点，把接管钉在某个调用上，复现「入口检查之后、合流之前被接管」时不带计时因素。
 */
function installGitShim(setup, { marker, ledger: ledgerText }) {
  const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
  const shim = `#!/usr/bin/env node
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const argv = process.argv.slice(2);
const marker = process.env.GIT_SHIM_MARKER;
const targeted = argv[0] === 'rev-parse' && argv.includes('--verify')
  && argv.some((arg) => arg.startsWith('task/'));
if (targeted && !fs.existsSync(marker)) {
  fs.writeFileSync(marker, 'fired');
  fs.writeFileSync(process.env.GIT_SHIM_LEDGER_FILE, process.env.GIT_SHIM_LEDGER);
}
try {
  execFileSync(process.env.REAL_GIT, argv, { stdio: 'inherit' });
} catch (error) {
  process.exit(typeof error.status === 'number' ? error.status : 1);
}
`;
  fs.writeFileSync(path.join(setup.bin, 'git'), shim, { mode: 0o755 });
  setup.env.REAL_GIT = realGit;
  setup.env.GIT_SHIM_MARKER = marker;
  setup.env.GIT_SHIM_LEDGER_FILE = ledgerPath(setup);
  setup.env.GIT_SHIM_LEDGER = ledgerText;
}

// SCEN-HND-11
test('task-runner refuses a --review-tag re-entry that is not the lease owner', (context) => {
  // 重入不经过 claim，旧实现因此是一条免检旁路：旧会话拿着旧标签就能合流并写入账本。
  // 判据必须与 claim 一致——有效租约下 --owner 必填且必须匹配。
  const setup = fixture(context, { review: 'strict' });
  const branch = `task/${change}/T-01`;
  const { tip7, base7 } = deliverTaskBranch(setup, branch);
  const tag = `pass(1234abcd@${tip7}/${base7})`;
  writeLease(setup, { owner: 'lead-a', expiresAt: futureIso() });

  // a. 省略 --owner：缺省的 runner-<pid> 不算身份证明。
  const omitted = invoke(setup, [change, 'T-01', '--review-tag', tag]);
  assert.equal(omitted.status, 2, `${omitted.stdout}\n${omitted.stderr}`);
  assert.match(omitted.stderr, /lead-a/, 'the refusal must name the current owner');
  assert.match(omitted.stderr, /--owner/, 'the refusal must say the flag is required');
  assert.equal(mergeCalls(setup).length, 0, 'an owner-less re-entry must not reach the merge gate');

  // b. owner 不匹配：旧 Lead 不得继续提交动作。
  const stale = invoke(setup, [change, 'T-01', '--review-tag', tag, '--owner', 'lead-b']);
  assert.equal(stale.status, 2, `${stale.stdout}\n${stale.stderr}`);
  assert.match(stale.stderr, /lead-a/);
  assert.equal(mergeCalls(setup).length, 0, 'a foreign owner must not reach the merge gate');

  // c. 当前 owner 重入：照常进入合流门禁（门禁本身仍由 merge-task 判）。
  const allowed = invoke(setup, [change, 'T-01', '--review-tag', tag, '--owner', 'lead-a']);
  assert.equal(allowed.status, 0, `${allowed.stdout}\n${allowed.stderr}`);
  assert.equal(mergeCalls(setup).length, 1, 'the lease owner must proceed to the merge gate');
});

// SCEN-HND-11
test('task-runner refuses a --review-tag re-entry on an expired lease even for its recorded owner', (context) => {
  // 与 claim 同一判据：过期即须显式 begin 领新代际，旧 owner 的身份不再构成授权。
  const setup = fixture(context, { review: 'strict' });
  const branch = `task/${change}/T-01`;
  const { tip7, base7 } = deliverTaskBranch(setup, branch);
  writeLease(setup, { owner: 'lead-a', expiresAt: new Date(Date.now() - 60_000).toISOString() });

  const res = invoke(setup, [change, 'T-01', '--review-tag', `pass(1234abcd@${tip7}/${base7})`, '--owner', 'lead-a']);
  assert.equal(res.status, 2, `${res.stdout}\n${res.stderr}`);
  assert.match(res.stderr, /过期/);
  assert.match(res.stderr, /begin/, 'the refusal must say how to get a new generation');
  assert.equal(mergeCalls(setup).length, 0, 'an expired lease must not reach the merge gate');
});

// SCEN-HND-11
test('task-runner treats a corrupt ledger as unreadable on a --review-tag re-entry, not as lease-free', (context) => {
  // 读不出租约 ≠ 没有租约：把损坏当「未启用租约」放行，等于让一次损坏降级成合流许可。
  const setup = fixture(context, { review: 'strict' });
  const branch = `task/${change}/T-01`;
  const { tip7, base7 } = deliverTaskBranch(setup, branch);
  fs.mkdirSync(path.dirname(ledgerPath(setup)), { recursive: true });
  fs.writeFileSync(ledgerPath(setup), '{ not json');

  const res = invoke(setup, [change, 'T-01', '--review-tag', `pass(1234abcd@${tip7}/${base7})`, '--owner', 'lead-a']);
  assert.equal(res.status, 2, `${res.stdout}\n${res.stderr}`);
  assert.match(res.stderr, /损坏/);
  assert.equal(mergeCalls(setup).length, 0, 'a corrupt ledger must not reach the merge gate');
  assert.equal(fs.readFileSync(ledgerPath(setup), 'utf8'), '{ not json',
    'the corrupt ledger must be left untouched');
});

// SCEN-HND-11
test('task-runner re-checks the lease before merging when another owner takes over mid-re-entry', (context) => {
  // 接管判据：入口开头的校验只对「校验那一刻」成立。检查之后、合流之前租约可能被新 owner
  // 的 begin 接管，旧 owner 不能凭开头那次通过把交付合进去，所以合流前必须终判。
  //
  // 复现方式钉在入口一定会发生的调用上：`ensureBranchAdvanced` 的 `rev-parse --verify`
  // 之前把账本换成 lead-b 的租约（模拟 lead-b 的 begin 落在那个窗口里）。修复前合流照常
  // 发生 → 本断言红；修复后终判看到 lead-b → exit 2、0 次合流。
  const setup = fixture(context, { review: 'strict' });
  const branch = `task/${change}/T-01`;
  const { tip7, base7 } = deliverTaskBranch(setup, branch);
  writeLease(setup, { owner: 'lead-a', expiresAt: futureIso() });
  installGitShim(setup, {
    marker: path.join(path.dirname(setup.mergeCallFile), 'shim-fired'),
    ledger: leaseLedgerJson({ owner: 'lead-b', generation: 2, expiresAt: futureIso() }),
  });

  const res = invoke(setup, [change, 'T-01', '--review-tag', `pass(1234abcd@${tip7}/${base7})`, '--owner', 'lead-a']);
  assert.equal(res.status, 2, `${res.stdout}\n${res.stderr}`);
  assert.match(res.stderr, /lead-b/, 'the refusal must name the owner that took over');
  assert.equal(mergeCalls(setup).length, 0, 'the take-over must stop the merge, not race it');
});

// SCEN-HND-11
test('task-runner re-checks lease expiry before merging, not only on entry', (context) => {
  // 同一窗口的另一种后果：租约在重入过程中过期（没有 begin 接手）。过期即须显式 begin，
  // 入口不得凭开头那次「还有效」把合流做完。
  const setup = fixture(context, { review: 'strict' });
  const branch = `task/${change}/T-01`;
  const { tip7, base7 } = deliverTaskBranch(setup, branch);
  writeLease(setup, { owner: 'lead-a', expiresAt: futureIso() });
  installGitShim(setup, {
    marker: path.join(path.dirname(setup.mergeCallFile), 'shim-fired'),
    ledger: leaseLedgerJson({ owner: 'lead-a', generation: 2, expiresAt: new Date(Date.now() - 60_000).toISOString() }),
  });

  const res = invoke(setup, [change, 'T-01', '--review-tag', `pass(1234abcd@${tip7}/${base7})`, '--owner', 'lead-a']);
  assert.equal(res.status, 2, `${res.stdout}\n${res.stderr}`);
  assert.match(res.stderr, /过期/);
  assert.equal(mergeCalls(setup).length, 0, 'an expired-lease merge must be refused before merging');
});

// SCEN-HND-11
test('task-runner runs the merge subprocess without holding the run-state lock', (context) => {
  // 合流子进程里的验证命令是长耗时动作，可能跑几十分钟；把它包进 run-state 锁临界区，
  // 整个 run 的 begin/claim/record 都会被挡在锁外。锁只保护账本读改写，不保护合流。
  // 替身在子进程里检查锁文件是否存在——这是可直接观测的文件事实，不靠探针进程抢锁。
  const setup = fixture(context, { review: 'strict' });
  const branch = `task/${change}/T-01`;
  const { tip7, base7 } = deliverTaskBranch(setup, branch);
  writeLease(setup, { owner: 'lead-a', expiresAt: futureIso() });

  const res = invoke(setup, [change, 'T-01', '--review-tag', `pass(1234abcd@${tip7}/${base7})`, '--owner', 'lead-a']);
  assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
  const merges = mergeCalls(setup);
  assert.equal(merges.length, 1, `exactly one merge call: ${JSON.stringify(merges)}`);
  assert.equal(merges[0].runStateLockHeld, false,
    'the run-state lock must be free while the merge subprocess runs');
});

// SCEN-HND-11
test('task-runner records the merge in the run ledger through the real merge gate', (context) => {
  // 账本记账在 merge-task 结束时发生（updateRunState）。入口若在合流子进程运行期间攥着
  // run-state 锁，merge-task 的记账会 ELOCKED 并被自己吞成一条 warning——合流成功，
  // merges[] 却永远少一条，report 的「已合流任务」随之失真。这里用**真实** merge-task
  // 走完整门禁，断言账本恰好新增一条合流记录。
  const setup = fixture(context, { review: 'mechanical' });
  const branch = `task/${change}/T-01`;
  const { tip7, base7 } = deliverTaskBranch(setup, branch);
  writeLease(setup, { owner: 'lead-a', expiresAt: futureIso() });
  // 只换回真实合流入口；run-state 与 lib 仍是夹具符号链接指向的真实实现。
  setup.env.PIPELINE_HOME = path.dirname(runnerScript);

  const before = ledger(setup).merges.length;
  const res = invoke(setup, [change, 'T-01', '--review-tag', `pass(mechanical@${tip7}/${base7})`, '--owner', 'lead-a']);
  assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);

  const after = ledger(setup).merges;
  assert.equal(after.length, before + 1,
    `the merge must be booked exactly once: ${JSON.stringify(after)}`);
  assert.equal(after[after.length - 1].task, 'T-01');
  assert.match(after[after.length - 1].sha, /^[0-9a-f]{40}$/, 'the booked sha must be a real merge commit');
});

// SCEN-HND-07
test('task-runner degrades a failed paseo wait to inspect polling and proceeds when idle', (context) => {
  const setup = fixture(context);
  setup.env.PASEO_FIXTURE_WAIT = 'failed';
  setup.env.PASEO_FIXTURE_INSPECT = 'late';
  const res = invoke(setup, [change, 'T-01', '--owner', 'test-owner']);

  const calls = paseoCalls(setup).map((argv) => argv[0]);
  assert.ok(calls.includes('inspect'), `a failed wait must fall back to inspect: ${calls.join(',')}`);
  assert.equal(runs(setup).length, 1, 'the failed wait must not trigger a redispatch');
  // late 模式下第 2 次 inspect 报 idle：流程应继续到合流（mechanical 直连）。
  assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
  assert.equal(mergeCalls(setup).length, 1, 'the run must proceed as if the wait had returned idle');
});

// SCEN-HND-07, SCEN-HND-13
test('task-runner exits 51 with re-entry guidance when the agent never reaches a terminal state', (context) => {
  const setup = fixture(context);
  setup.env.PASEO_FIXTURE_WAIT = 'failed';
  setup.env.PASEO_FIXTURE_INSPECT = 'never';
  const res = invoke(setup, [change, 'T-01', '--timeout', '600', '--owner', 'test-owner']);

  assert.equal(res.status, 51, `${res.stdout}\n${res.stderr}`);
  assert.match(res.stderr, /do NOT redispatch/);
  // SCEN-HND-13：文案必须给可执行的续等路径，而不是只喊「别重派」。
  assert.match(res.stderr, /Re-running this same command \(same task id\) continues waiting on the same attempt/,
    'the deadline message must state that re-invoking the same task id continues the same attempt');
  assert.match(res.stderr, /does not dispatch a second writer/,
    'the deadline message must state that re-entry does not redispatch');
  assert.match(res.stderr, new RegExp(`last observed status=(running|idle|timeout)`),
    'the deadline message must report the last observed status');
  assert.equal(runs(setup).length, 1, 'the deadline must not cause a second paseo run');
  assert.equal(mergeCalls(setup).length, 0, 'a timed-out wait must not merge');
});

// SCEN-HND-14
test('task-runner treats a wait-reported error as terminal and exits 53 without polling', (context) => {
  const setup = fixture(context);
  setup.env.PASEO_FIXTURE_WAIT = 'error';
  setup.env.PASEO_FIXTURE_INSPECT = 'never';
  const res = invoke(setup, [change, 'T-01', '--timeout', '600', '--owner', 'test-owner']);

  assert.equal(res.status, 53, `${res.stdout}\n${res.stderr}`);
  assert.match(res.stderr, new RegExp(AGENT_ID), 'the error report must name the crashed agent id');
  assert.match(res.stderr, /status=error/, 'the error report must state the observed state');
  assert.doesNotMatch(res.stderr, /did not reach a terminal status/,
    'error is terminal: it must not be reported as a deadline timeout');
  // 终态不走轮询：一次 inspect 都不该发生（也就没有「耗掉截止时间」）。
  const calls = paseoCalls(setup).map((argv) => argv[0]);
  assert.ok(!calls.includes('inspect'), `a terminal error must not fall into polling: ${calls.join(',')}`);
  assert.equal(runs(setup).length, 1, 'a crashed writer must not be redispatched by this entry');
  assert.equal(mergeCalls(setup).length, 0, 'a crashed writer must not reach the merge gate');
});

// SCEN-HND-14
test('task-runner treats an inspect-polled error as terminal and exits 53', (context) => {
  const setup = fixture(context);
  // wait 失败 → 降级轮询；轮询第一次就报 error：必须立刻返回，不等截止时间。
  setup.env.PASEO_FIXTURE_WAIT = 'failed';
  setup.env.PASEO_FIXTURE_INSPECT = 'error';
  const startedAt = Date.now();
  const res = invoke(setup, [change, 'T-01', '--timeout', '600', '--owner', 'test-owner']);

  assert.equal(res.status, 53, `${res.stdout}\n${res.stderr}`);
  assert.match(res.stderr, /status=error/);
  assert.equal(runs(setup).length, 1, 'an errored writer must not be redispatched');
  assert.equal(mergeCalls(setup).length, 0, 'an errored writer must not reach the merge gate');
  // 600s 的截止时间几乎没被消耗：说明是终态早退，不是等满了才超时。
  assert.ok(Date.now() - startedAt < 60_000,
    `an error state must short-circuit the deadline, took ${Date.now() - startedAt}ms`);
});

// SCEN-HND-13
test('task-runner re-runs waiting on the same in-flight writer instead of dispatching a second one', (context) => {
  // 退出 51 之后写手可能仍在跑。重跑同一条命令若再派一个写手，同一任务就有两个写手共用一条分支。
  // 账本里那条有真实回执、agent 仍 running 的意图就是「续等」的唯一证据。
  const setup = fixture(context);
  const branch = `task/${change}/T-01`;
  deliverTaskBranch(setup, branch);
  // 写手的那条检出必须是已登记的 worktree：续等不看目录存在性，但 Verify 只能落在写手的检出上。
  git(setup.cwd, 'worktree', 'add', '-q', setup.worktreeDir, branch);
  writeLedger(setup, { intents: [writerIntent()] });
  setup.env.PASEO_FIXTURE_INSPECT = 'late';
  const res = invoke(setup, [change, 'T-01', '--owner', 'test-owner']);

  assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
  assert.equal(runs(setup).length, 0, 're-entry must never dispatch a second writer');
  assert.match(res.stdout, new RegExp(`Resuming wait on writer agent ${AGENT_ID}`),
    'the entry must announce that it is continuing the same writer');
  const waited = paseoCalls(setup).filter((argv) => argv[0] === 'wait').map((argv) => argv[1]);
  assert.deepEqual(waited, [AGENT_ID], 'the wait must target the original agent id');
  // 续等的 Verify 与合流必须落在**原 attempt 的分支**上，而不是一条还没人碰过的新分支。
  const merges = mergeCalls(setup);
  assert.equal(merges.length, 1, `exactly one merge call: ${JSON.stringify(merges)}`);
  assert.equal(merges[0].argv[0], branch, 'the merge must target the branch the writer actually worked on');
});

// SCEN-HND-13
test('task-runner does not resume a writer that already finished, and does not redispatch it', (context) => {
  // 账本里有回执不等于 agent 还在跑：交付完的写手是 idle/closed，续等它会把早已结案的产出
  // 重验一遍。判据只能是 Paseo 的实时状态；不续等时也不能顺手再派一个。
  const setup = fixture(context, { verify: failCommand });
  writeLedger(setup, { intents: [writerIntent()] });
  setup.env.PASEO_FIXTURE_INSPECT = 'idle';
  const res = invoke(setup, [change, 'T-01', '--owner', 'test-owner']);

  assert.doesNotMatch(res.stdout, /Resuming wait/, 'a finished writer is not something to keep waiting on');
  // 已回执的意图由 claim 的幂等闸门挡住重复派发（exit 2），不是悄悄再派一个写手。
  assert.equal(res.status, 2, `${res.stdout}\n${res.stderr}`);
  assert.equal(runs(setup).length, 0, 'an already-receipted attempt must not be dispatched twice');
});

// SCEN-HND-13
test('task-runner refuses to resume a writer when the caller is not the lease owner', (context) => {
  // 续等和 --review-tag 重入一样不经过 claim：不补租约判据，旧会话就能接着别人的写手继续推进。
  const setup = fixture(context);
  writeLedger(setup, {
    lease: {
      owner: 'lead-a',
      generation: 1,
      acquiredAt: new Date().toISOString(),
      renewedAt: null,
      expiresAt: futureIso(),
      ttlMs: 30 * 60 * 1000,
    },
    intents: [writerIntent()],
  });

  // 写手仍在跑（inspect=running）才谈得上续等；租约判据在续等入口拦下非当前 owner。
  setup.env.PASEO_FIXTURE_INSPECT = 'never';
  const res = invoke(setup, [change, 'T-01', '--owner', 'lead-b']);
  assert.equal(res.status, 2, `${res.stdout}\n${res.stderr}`);
  assert.match(res.stderr, /lead-a/, 'the refusal must name the current lease owner');
  assert.match(res.stderr, /续等/, 'the refusal must say which action it refused');
  assert.equal(paseoCalls(setup).filter((argv) => argv[0] === 'wait').length, 0,
    'a refused resume must not start waiting at all');
});

// SCEN-HND-13
test('task-runner treats a corrupt ledger as unreadable when deciding resume versus dispatch', (context) => {
  // 读不出在途派发就无从判断该续等还是该重派；按「没有在途意图」放行会直接引入重复派发。
  const setup = fixture(context);
  fs.mkdirSync(path.dirname(ledgerPath(setup)), { recursive: true });
  fs.writeFileSync(ledgerPath(setup), '{ not json');

  const res = invoke(setup, [change, 'T-01', '--owner', 'test-owner']);
  assert.equal(res.status, 2, `${res.stdout}\n${res.stderr}`);
  assert.equal(runs(setup).length, 0, 'a corrupt ledger must not be read as "nothing in flight"');
});
