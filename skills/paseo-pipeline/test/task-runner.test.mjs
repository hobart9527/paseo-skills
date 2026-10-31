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

function tasksContent(verifyCommand = passCommand, review = 'mechanical') {
  return [
    '# Tasks',
    '',
    '- [ ] 1.1 T-01 Task 1',
    '  - Depends on: none',
    '  - Write scope: src/a.txt',
    `  - Review: ${review}`,
    `  - Verify with: ${verifyCommand}`,
    '',
    '- [ ] 1.2 T-02 Task 2',
    '  - Depends on: T-01',
    '  - Write scope: src/b.txt',
    `  - Review: ${review}`,
    `  - Verify with: ${verifyCommand}`,
  ].join('\n');
}

/** 合流替身：只记录 argv 与豁免变量，绝不真的合并。（ESM：与真实 merge-task.mjs 同形态） */
const mergeStub = `import fs from 'node:fs';
const record = {
  argv: process.argv.slice(2),
  homogeneousExemption: process.env.PIPELINE_ALLOW_HOMOGENEOUS_REVIEW ?? null,
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
  // wait 模式：idle | failed（WAIT_FAILED + 非零退出）| timeout（首轮等满）
  const mode = process.env.PASEO_FIXTURE_WAIT || 'idle';
  if (mode === 'failed') {
    console.error('WAIT_FAILED');
    process.exit(1);
  }
  console.log(JSON.stringify({ id: argv[1], status: mode === 'timeout' ? 'timeout' : 'idle' }));
} else if (argv[0] === 'inspect') {
  // inspect 模式：idle | never（永远 running）| late（第 2 次起 idle）| failed（非零退出）
  const mode = process.env.PASEO_FIXTURE_INSPECT || 'idle';
  const n = bump();
  if (mode === 'failed') {
    console.error('inspect failed');
    process.exit(1);
  }
  const status = mode === 'never' ? 'running' : (mode === 'late' && n < 2 ? 'running' : 'idle');
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

  return { cwd: repo, env, callsFile, snapshotFile, worktreeDir, stateDir, home, mergeCallFile };
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

// SCEN-HND-06
test('task-runner accepts a review tag re-entry and does not set the homogeneous exemption', (context) => {
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
  assert.equal(merges[0].homogeneousExemption, null,
    'the entry must not set PIPELINE_ALLOW_HOMOGENEOUS_REVIEW on the caller\'s behalf');

  // 重入也不得凭空登记审计事实：那是真实 Auditor 的账。文件缺失本身即「一次都没写账」。
  const state = fs.existsSync(ledgerPath(setup)) ? ledger(setup) : { intents: [], reviews: [] };
  assert.deepEqual(state.reviews, [], 'a tagged re-entry must not write review records');
  assert.deepEqual(state.intents.filter((entry) => entry.phase === 'audit'), [], 'no audit intent');
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

// SCEN-HND-07
test('task-runner exits 51 when the agent never becomes idle and never redispatches', (context) => {
  const setup = fixture(context);
  setup.env.PASEO_FIXTURE_WAIT = 'failed';
  setup.env.PASEO_FIXTURE_INSPECT = 'never';
  const res = invoke(setup, [change, 'T-01', '--timeout', '600', '--owner', 'test-owner']);

  assert.equal(res.status, 51, `${res.stdout}\n${res.stderr}`);
  assert.match(res.stderr, /do NOT redispatch/);
  assert.equal(runs(setup).length, 1, 'the deadline must not cause a second paseo run');
  assert.equal(mergeCalls(setup).length, 0, 'a timed-out wait must not merge');
});
