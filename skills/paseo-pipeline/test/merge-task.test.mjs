import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs, { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mergeScript = fileURLToPath(new URL('../merge-task.mjs', import.meta.url));
const shellScript = fileURLToPath(new URL('../merge-task.sh', import.meta.url));
const change = 'merge-contract';
const integrationBranch = `integration/${change}`;
const tasksPath = `openspec/changes/${change}/tasks.md`;
const logPath = `openspec/changes/${change}/run-log.md`;
const initialLog = '# Run Log\n\n- existing entry\n';
const passCommand = `${JSON.stringify(process.execPath)} verify.mjs`;
const failCommand = `${JSON.stringify(process.execPath)} -e "process.exit(9)"`;
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

function taskMarkdown({ id, review = 'strict', done = false, depends = 'none', scope = 'src/task.txt, src/shared.txt' }, index, colonForm = false) {
  return [
    `- [${done ? 'x' : ' '}] 1.${index + 1} ${id}${colonForm ? ':' : ''} Deliver ${id}`,
    ...(done ? ['  - Done: source=1234567 review=pass(12345678@1234567/7654321)'] : []),
    `  - Depends on: ${depends}`,
    `  - Write scope: ${scope}`,
    ...(review === null ? [] : [`  - Review: ${review}`]),
    `  - Verify with: ${passCommand}`,
  ].join('\n');
}

function fixture(context, {
  tasks = [{ id: 'T-1' }, { id: 'T-10' }, { id: 'T-2' }],
  branch = `task/${change}/T-1`,
  runLog = true,
  taskFile = true,
  sharedChange = false,
  fileDirConflict = false,
  colonForm = false,
  baselineFiles = {},
} = {}) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'pipeline-merge-test-'));
  context.after(() => rmSync(cwd, { recursive: true, force: true }));
  git(cwd, 'init', '-q', '-b', 'main');
  git(cwd, 'config', 'core.hooksPath', '/dev/null');
  git(cwd, 'config', 'commit.gpgsign', 'false');
  git(cwd, 'config', 'merge.gpgsign', 'false');
  git(cwd, 'config', 'rerere.enabled', 'false');
  write(cwd, 'src/shared.txt', 'base\n');
  for (const [file, content] of Object.entries(baselineFiles)) write(cwd, file, content);
  write(cwd, 'verify.mjs', [
    "import assert from 'node:assert/strict';",
    "import { readFileSync } from 'node:fs';",
    "assert.equal(readFileSync('src/task.txt', 'utf8'), 'task change\\n');",
    '',
  ].join('\n'));
  if (taskFile) {
    write(cwd, tasksPath, `# Tasks\n\n${tasks.map((task, index) => taskMarkdown(task, index, colonForm)).join('\n\n')}\n`);
  }
  if (runLog) write(cwd, logPath, initialLog);
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', 'fixture baseline');
  git(cwd, 'switch', '-qc', integrationBranch);
  const base = git(cwd, 'rev-parse', 'HEAD');
  git(cwd, 'switch', '-qc', branch);
  write(cwd, 'src/task.txt', 'task change\n');
  if (sharedChange) write(cwd, 'src/shared.txt', 'task version\n');
  // file/directory 冲突：任务分支写文件 `src/conflict`，集成侧把它建成目录。
  // 选这种冲突是为了制造**无文件重叠**的真冲突——同文件冲突会先被基线漂移重叠检查（exit 34）
  // 拦下，测不到 merge 本身的 exit 10 分支。
  if (fileDirConflict) write(cwd, 'src/conflict', 'task wrote a file here\n');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', 'task implementation\n\nPipeline-Role: gongbu\nPipeline-Author: a1b2c3d4');
  const tip = git(cwd, 'rev-parse', 'HEAD');
  const history = git(cwd, 'rev-list', branch);
  git(cwd, 'switch', '-q', integrationBranch);
  return { cwd, branch, base, tip, history, runLog };
}

function reviewTag(repo, { reviewer = '12345678', tip = repo.tip, base = repo.base } = {}) {
  return `pass(${reviewer}@${tip.slice(0, 7)}/${base.slice(0, 7)})`;
}

function invoke(repo, {
  ids = 'T-1',
  tag = reviewTag(repo),
  command = passCommand,
  shell = false,
  branch = repo.branch,
  env = {},
  args = [branch, ids, tag, command],
} = {}) {
  // `gitEnv` 是白名单，本不带继承变量；但这是**唯一**保证测试不受外层环境影响的点，
  // 必须显式写出来：`--allow-legacy-author` 的二次确认走 PIPELINE_ALLOW_LEGACY_AUTHOR，
  // 外层 shell 里若恰好设了它，下面的「无确认应被拒」断言就会直接失效（实测：在
  // PIPELINE_ALLOW_LEGACY_AUTHOR=1 的会话里跑全量，本用例期望 31 却得到 0）。
  const base = { ...gitEnv };
  delete base.PIPELINE_ALLOW_LEGACY_AUTHOR;
  const result = spawnSync(shell ? 'bash' : process.execPath, [shell ? shellScript : mergeScript, ...args], {
    cwd: repo.cwd,
    env: { ...base, ...env },
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  assert.notEqual(result.status, null);
  return result;
}

function assertUnchanged(repo, head = repo.base) {
  assert.equal(git(repo.cwd, 'rev-parse', 'HEAD'), head, 'integration HEAD must remain unchanged');
  assert.equal(git(repo.cwd, 'status', '--porcelain'), '', 'working tree must be clean');
  const mergeHead = spawnSync('git', ['rev-parse', '--verify', 'MERGE_HEAD'], {
    cwd: repo.cwd, env: gitEnv, encoding: 'utf8',
  });
  assert.ifError(mergeHead.error);
  assert.notEqual(mergeHead.status, 0, 'no merge may remain in progress');
  assert.equal(git(repo.cwd, 'rev-list', repo.branch), repo.history, 'source history must not be rewritten');
}

function assertRejected(repo, result, head = repo.base) {
  assert.notEqual(result.status, 0, `merge must be rejected\n${result.stdout}${result.stderr}`);
  assertUnchanged(repo, head);
}

function assertMerged(repo, result, { ids = ['T-1'], tag = reviewTag(repo), head = repo.base } = {}) {
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const merge = git(repo.cwd, 'rev-parse', 'HEAD');
  assert.deepEqual(git(repo.cwd, 'rev-list', '--first-parent', `${head}..HEAD`).split('\n'), [merge],
    'code, task ledger and run log must share exactly one new first-parent commit');
  assert.deepEqual(git(repo.cwd, 'show', '-s', '--format=%P', merge).split(' '), [head, repo.tip]);
  assert.equal(git(repo.cwd, 'show', '-s', '--format=%(trailers:key=Pipeline-Task,valueonly)', merge), ids.join(','));
  assert.equal(git(repo.cwd, 'show', '-s', '--format=%(trailers:key=Pipeline-Source,valueonly)', merge), repo.tip);
  assert.equal(git(repo.cwd, 'show', `${merge}:src/task.txt`), 'task change');
  const lines = git(repo.cwd, 'show', `${merge}:${tasksPath}`).split('\n');
  for (const id of ids) {
    const taskIndex = lines.findIndex((line) => new RegExp(`^- \\[x\\] \\d+\\.\\d+ ${id} `).test(line));
    assert.notEqual(taskIndex, -1, `${id} must be marked Done`);
    assert.equal(lines[taskIndex + 1], `  - Done: source=${repo.tip.slice(0, 7)} review=${tag}`);
  }
  if (repo.runLog) {
    const log = git(repo.cwd, 'show', `${merge}:${logPath}`);
    assert.ok(log.startsWith(initialLog), 'existing log entries must survive');
    const appended = log.slice(initialLog.length).trim().split('\n');
    assert.equal(appended.length, 1, 'exactly one run-log entry must be appended');
    assert.ok(appended[0].length > 0, 'new run-log entry must not be empty');
  }
  assert.equal(git(repo.cwd, 'status', '--porcelain'), '');
  assert.equal(git(repo.cwd, 'rev-parse', repo.branch), repo.tip);
  assert.equal(git(repo.cwd, 'rev-list', repo.branch), repo.history, 'source history must not be rebased');
}

test('SCEN-MRG-01 success atomically merges code, Done evidence, run log and trailers', (context) => {
  const repo = fixture(context);
  assertMerged(repo, invoke(repo));
});

test('SCEN-MRG-01 success does not require an existing run-log.md', (context) => {
  const repo = fixture(context, { runLog: false });
  assertMerged(repo, invoke(repo));
});

test('SCEN-MRG-20 merges a tasks.md that uses the colon form `T-01: 标题`', (context) => {
  // 真实兼容性回归：早期 pipeline 产出的 tasks.md 一律写 `- [ ] 1.1 T-01: 标题`。
  // Done 行定位若只认空格形式，会在 `markTasksDone` 处报「无法精确定位未完成任务」，
  // 这些 change 的合流直接失败。
  const repo = fixture(context, { colonForm: true });
  const result = invoke(repo);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const merge = git(repo.cwd, 'rev-parse', 'HEAD');
  const lines = git(repo.cwd, 'show', `${merge}:${tasksPath}`).split('\n');
  const taskIndex = lines.findIndex((line) => /^- \[x\] 1\.1 T-1: /.test(line));
  assert.notEqual(taskIndex, -1, `colon-form task must be marked Done:\n${lines.join('\n')}`);
  assert.match(lines[taskIndex + 1], /^\s+- Done: source=[0-9a-f]{7} review=pass\(/);
  // 冒号后的标题必须原样保留，不能被 ID 解析吃掉。
  assert.match(lines[taskIndex], /T-1: Deliver T-1$/);
});

for (const count of [0, 1, 2, 3]) {
  test(`SCEN-MRG-02 rejects ${count} arguments without changing HEAD`, (context) => {
    const repo = fixture(context);
    const args = [repo.branch, 'T-1', reviewTag(repo), passCommand].slice(0, count);
    assertRejected(repo, invoke(repo, { args }));
  });
}

test('SCEN-MRG-03 rejects a review bound to an older source tip', (context) => {
  const repo = fixture(context);
  assertRejected(repo, invoke(repo, { tag: reviewTag(repo, { tip: repo.base }) }));
});

for (const kind of ['unbound reviewer', 'bare mechanical', 'short reviewer ID']) {
  test(`SCEN-MRG-03 rejects malformed review tag with ${kind}`, (context) => {
    const repo = fixture(context);
    const tag = kind === 'unbound reviewer' ? 'pass(12345678)'
      : kind === 'bare mechanical' ? 'mechanical' : reviewTag(repo, { reviewer: 'short' });
    assertRejected(repo, invoke(repo, { tag }));
  });
}

test('SCEN-MRG-04 T-1 never marks T-10 or changes its metadata', (context) => {
  const repo = fixture(context);
  const before = readFileSync(path.join(repo.cwd, tasksPath), 'utf8');
  const result = invoke(repo);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const after = readFileSync(path.join(repo.cwd, tasksPath), 'utf8');
  assert.match(after, /^- \[x\] 1\.1 T-1 /m);
  const untouched = before.slice(before.indexOf('- [ ] 1.2 T-10'));
  assert.ok(after.endsWith(untouched), 'T-10 and following tasks must remain byte-for-byte unchanged');
});

test('SCEN-MRG-05 refuses to merge on main', (context) => {
  const repo = fixture(context);
  git(repo.cwd, 'switch', '-q', 'main');
  assertRejected(repo, invoke(repo));
  assert.equal(git(repo.cwd, 'branch', '--show-current'), 'main');
});

test('preconditions reject a different integration change', (context) => {
  const repo = fixture(context);
  git(repo.cwd, 'switch', '-qc', 'integration/other-change');
  assertRejected(repo, invoke(repo));
});

test('preconditions reject a missing tasks.md', (context) => {
  const repo = fixture(context, { taskFile: false });
  assertRejected(repo, invoke(repo));
});

test('preconditions reject a dirty tree without discarding user changes', (context) => {
  const repo = fixture(context);
  write(repo.cwd, 'src/shared.txt', 'user edits\n');
  write(repo.cwd, 'untracked.txt', 'user data\n');
  const before = git(repo.cwd, 'status', '--porcelain');
  const result = invoke(repo);
  assert.notEqual(result.status, 0);
  assert.equal(git(repo.cwd, 'rev-parse', 'HEAD'), repo.base);
  assert.equal(git(repo.cwd, 'status', '--porcelain'), before);
  assert.equal(readFileSync(path.join(repo.cwd, 'src/shared.txt'), 'utf8'), 'user edits\n');
  assert.equal(readFileSync(path.join(repo.cwd, 'untracked.txt'), 'utf8'), 'user data\n');
});

for (const shell of [false, true]) {
  test(`SCEN-MRG-06 failed tests abort cleanly with exit 20 via ${shell ? 'shell' : 'node'}`, (context) => {
    const repo = fixture(context);
    const result = invoke(repo, { shell, command: failCommand });
    assert.equal(result.status, 20, `${result.stdout}${result.stderr}`);
    assertUnchanged(repo);
  });

  test(`SCEN-MRG-07 merge conflicts abort cleanly with exit 10 via ${shell ? 'shell' : 'node'}`, (context) => {
    const repo = fixture(context, {
      fileDirConflict: true,
      tasks: [{ id: 'T-1', scope: 'src/task.txt, src/conflict' }],
    });
    // 集成侧把 `src/conflict` 建成目录，与任务分支的同名文件形成 file/directory 冲突。
    // 这条路不改任务分支的 base（repo.base 仍是两个 tip 的共同祖先），
    // 因此测到的是 merge 冲突分支，而不是 review base 校验。
    write(repo.cwd, 'src/conflict/inner.txt', 'integration made this a directory\n');
    git(repo.cwd, 'add', '.');
    git(repo.cwd, 'commit', '-qm', 'integration change after task branch');
    const head = git(repo.cwd, 'rev-parse', 'HEAD');
    const result = invoke(repo, { shell });
    assert.equal(result.status, 10, `${result.stdout}${result.stderr}`);
    assertUnchanged(repo, head);
  });
}

test('SCEN-MRG-06 merge source contains no destructive reset fallback', () => {
  assert.ok(!readFileSync(mergeScript, 'utf8').includes('reset --hard'));
});

test('SCEN-MRG-08 repeated merge rejects an already Done task without another commit', (context) => {
  const repo = fixture(context);
  const first = invoke(repo);
  assert.equal(first.status, 0, `${first.stdout}${first.stderr}`);
  const head = git(repo.cwd, 'rev-parse', 'HEAD');
  assertRejected(repo, invoke(repo, { tag: reviewTag(repo, { base: head }) }), head);
});

test('SCEN-MRG-08 rejects pre-existing Done evidence even when source is not yet merged', (context) => {
  const repo = fixture(context, { tasks: [{ id: 'T-1', done: true }] });
  assertRejected(repo, invoke(repo));
});

test('SCEN-MRG-09 overlapping baseline drift rejects even a cleanly mergeable change', (context) => {
  const repo = fixture(context);
  write(repo.cwd, 'src/task.txt', 'task change\n');
  git(repo.cwd, 'add', '.');
  git(repo.cwd, 'commit', '-qm', 'integration independently changed task path');
  const head = git(repo.cwd, 'rev-parse', 'HEAD');
  assertRejected(repo, invoke(repo), head);
});

test('SCEN-MRG-10 disjoint baseline drift merges tested tree, records drift and preserves source history', (context) => {
  const repo = fixture(context);
  write(repo.cwd, 'src/integration.txt', 'integration change\n');
  git(repo.cwd, 'add', '.');
  git(repo.cwd, 'commit', '-qm', 'unrelated integration advance');
  const head = git(repo.cwd, 'rev-parse', 'HEAD');
  const checkIntegration = `${JSON.stringify(process.execPath)} -e "require('node:assert/strict').equal(require('node:fs').readFileSync('src/integration.txt','utf8'),'integration change\\n')"`;
  const result = invoke(repo, { command: `${passCommand} && ${checkIntegration}` });
  assertMerged(repo, result, { head });
  const log = git(repo.cwd, 'show', `HEAD:${logPath}`).slice(initialLog.length);
  assert.match(log, /drift|\u6f02\u79fb/i, 'run log must explicitly record baseline drift');
});

for (const ids of ['T-10', 'T-99', 'T-1,T-2']) {
  test(`task branch rejects mismatched task IDs ${ids}`, (context) => {
    const repo = fixture(context);
    assertRejected(repo, invoke(repo, { ids }));
  });
}

test('task branch attempt suffix preserves exact task identity', (context) => {
  const repo = fixture(context, { branch: `task/${change}/T-1-a2` });
  assertMerged(repo, invoke(repo));
});

test('pod branch atomically marks exactly its requested task IDs', (context) => {
  const ids = ['T-1', 'T-2'];
  const repo = fixture(context, {
    branch: `pod/${change}`,
    baselineFiles: { [`openspec/changes/${change}/pod-members.json`]: JSON.stringify({ tasks: ids }, null, 2) },
  });
  assertMerged(repo, invoke(repo, { ids: ids.join(',') }), { ids });
  const tasks = git(repo.cwd, 'show', `HEAD:${tasksPath}`);
  assert.match(tasks, /^- \[ \] 1\.2 T-10 /m);
});

test('pod branch rejects unknown IDs without partially marking known tasks', (context) => {
  const repo = fixture(context, { branch: `pod/${change}` });
  assertRejected(repo, invoke(repo, { ids: 'T-1,T-99' }));
});

// --- Pod 冻结成员集合（L1-07 合流侧） ---
// 分支名 pod/<change> 不携带任务身份，成员真源只有冻结的 pod-members.json。
// reconcile 读它做归属；合流入口若不读，同一条分支就能合流任意任务 ID，Pod 变成万能通道。

test('SCEN-MRG-24 pod merge requires the frozen member list', (context) => {
  const repo = fixture(context, { branch: `pod/${change}` });
  const result = invoke(repo, { ids: 'T-1,T-2' });
  assert.equal(result.status, 31, result.stderr);
  assert.match(result.stderr, /pod-members\.json/);
  assertUnchanged(repo);
});

test('SCEN-MRG-24 pod merge rejects a task set that differs from the frozen members', (context) => {
  const repo = fixture(context, {
    branch: `pod/${change}`,
    baselineFiles: { [`openspec/changes/${change}/pod-members.json`]: JSON.stringify({ tasks: ['T-1', 'T-2'] }, null, 2) },
  });
  // 多报一个不在冻结成员里的任务
  assertRejected(repo, invoke(repo, { ids: 'T-1,T-2,T-10' }));
  // 少报一个冻结成员：只合流一部分等于让 Pod 成员身份与账本脱钩
  assertRejected(repo, invoke(repo, { ids: 'T-1' }));
  // 与冻结成员完全一致才放行
  const ids = ['T-1', 'T-2'];
  assertMerged(repo, invoke(repo, { ids: ids.join(',') }), { ids });
});

test('mechanical review succeeds only for an explicitly mechanical task', (context) => {
  const repo = fixture(context, { tasks: [{ id: 'T-1', review: 'mechanical' }] });
  const tag = reviewTag(repo, { reviewer: 'mechanical' });
  assertMerged(repo, invoke(repo, { tag }), { tag });
});

for (const review of ['strict', null]) {
  test(`mechanical review rejects a task with ${review ?? 'no'} Review declaration`, (context) => {
    const repo = fixture(context, { tasks: [{ id: 'T-1', review }] });
    assertRejected(repo, invoke(repo, { tag: reviewTag(repo, { reviewer: 'mechanical' }) }));
  });
}

test('pod mechanical review rejects a mixed strict/mechanical task list', (context) => {
  const repo = fixture(context, {
    branch: `pod/${change}`,
    tasks: [{ id: 'T-1', review: 'mechanical' }, { id: 'T-2', review: 'strict' }],
    baselineFiles: { [`openspec/changes/${change}/pod-members.json`]: JSON.stringify({ tasks: ['T-1', 'T-2'] }, null, 2) },
  });
  assertRejected(repo, invoke(repo, { ids: 'T-1,T-2', tag: reviewTag(repo, { reviewer: 'mechanical' }) }));
});

// --- Pod 内部依赖（dogfooding 实测缺陷） ---
// Pod 是单次整体合流，成员之间的依赖在合流前不可能被 first-parent 证明——那个合流提交
// 本身就是它们被证明的唯一机会。旧实现只认 first-parent，于是 Pod 成员之间只要有依赖
// 就在合流口 exit 35 死锁，而冻结检查不看这条，报告仍说「0 阻断项」。
// 修复前实测：`merge-task.mjs pod/... T-01..T-07` → exit 35 "T-02 depends on T-01"。

test('SCEN-CON-14 a pod merge satisfies dependencies that are inside its own member set', (context) => {
  const ids = ['T-1', 'T-2'];
  const repo = fixture(context, {
    branch: `pod/${change}`,
    tasks: [{ id: 'T-1' }, { id: 'T-2', depends: 'T-1' }],
    baselineFiles: { [`openspec/changes/${change}/pod-members.json`]: JSON.stringify({ tasks: ids }, null, 2) },
  });
  // T-2 依赖 T-1，两者同批合入：这一次合流同时证明它们的 Done，不应被 exit 35 拦。
  assertMerged(repo, invoke(repo, { ids: ids.join(',') }), { ids });
});

test('SCEN-CON-14 a pod merge still rejects a dependency that is outside its member set', (context) => {
  const ids = ['T-1'];
  const repo = fixture(context, {
    branch: `pod/${change}`,
    // T-10 不在 Pod 成员里，也没有 first-parent 证明：集外依赖不得被同批豁免放宽。
    tasks: [{ id: 'T-1', depends: 'T-10' }, { id: 'T-10' }],
    baselineFiles: { [`openspec/changes/${change}/pod-members.json`]: JSON.stringify({ tasks: ids }, null, 2) },
  });
  const result = invoke(repo, { ids: ids.join(',') });
  assert.equal(result.status, 35, `${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /depends on T-10 which are not verified Done/);
  assertUnchanged(repo);
});

test('SCEN-CON-14 a dependency cycle is rejected at parse time, before the batch is even considered', (context) => {
  const ids = ['T-1', 'T-2'];
  const repo = fixture(context, {
    branch: `pod/${change}`,
    tasks: [{ id: 'T-1', depends: 'T-2' }, { id: 'T-2', depends: 'T-1' }],
    baselineFiles: { [`openspec/changes/${change}/pod-members.json`]: JSON.stringify({ tasks: ids }, null, 2) },
  });
  // 环是 graph 级错误：解析器先于依赖门禁拒绝整份账本，同批豁免不可能放宽它。
  // （闭包内的环检测因此不可达；保留它是防御未来的调用路径。）
  const result = invoke(repo, { ids: ids.join(',') });
  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /CYCLE/);
  assertUnchanged(repo);
});

test('SCEN-CON-14 a single-task merge does not get the pod batch exemption', (context) => {
  // 豁免只属于「同批一并合入」。单任务合流里依赖仍须已被 first-parent 证明，否则
  // 任意两个任务都能靠「一起报上去」绕过依赖门禁。
  const repo = fixture(context, {
    branch: `task/${change}/T-2`,
    tasks: [{ id: 'T-1' }, { id: 'T-2', depends: 'T-1' }],
  });
  const result = invoke(repo, { ids: 'T-2', tag: reviewTag(repo) });
  assert.equal(result.status, 35, `${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /depends on T-1 which are not verified Done/);
});

test('SCEN-MRG-06 abort failure exits 40 with on-site dump and manual guidance', (context) => {
  const repo = fixture(context, {
    fileDirConflict: true,
    tasks: [{ id: 'T-1', scope: 'src/task.txt, src/conflict' }],
  });
  write(repo.cwd, 'src/conflict/inner.txt', 'integration made this a directory\n');
  git(repo.cwd, 'add', '.');
  git(repo.cwd, 'commit', '-qm', 'integration change after task branch');
  const head = git(repo.cwd, 'rev-parse', 'HEAD');
  const binDir = mkdtempSync(path.join(tmpdir(), 'pipeline-merge-fake-git-'));
  context.after(() => rmSync(binDir, { recursive: true, force: true }));
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  assert.notEqual(realGit, '', 'test requires a resolvable real git');
  writeFileSync(path.join(binDir, 'git'), [
    '#!/bin/sh',
    'if [ "$1" = "merge" ] && [ "$2" = "--abort" ]; then',
    '  echo "fake git: merge --abort disabled" >&2',
    '  exit 1',
    'fi',
    `exec ${JSON.stringify(realGit)} "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });
  const result = spawnSync(process.execPath, [mergeScript, repo.branch, 'T-1', reviewTag(repo), passCommand], {
    cwd: repo.cwd,
    env: { ...gitEnv, PATH: `${binDir}${path.delimiter}${gitEnv.PATH}` },
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 40, `${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /merge --abort/);
  assert.match(result.stderr, /MERGE_HEAD/);
  assert.match(result.stderr, /hard reset/);
  assert.ok(!/throw|Unhandled/i.test(result.stderr), 'must not surface an unhandled exception');
  assert.notEqual(git(repo.cwd, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'), '', 'merge state must remain for manual recovery');
  git(repo.cwd, 'merge', '--abort');
  assertUnchanged(repo, head);
});

test('SCEN-MRG-11: branch modifies files outside Write scope is rejected with exit 30', (context) => {
  const repo = fixture(context);
  git(repo.cwd, 'switch', '-q', repo.branch);
  write(repo.cwd, 'src/unauthorized.txt', 'illegal file\n');
  git(repo.cwd, 'add', '.');
  git(repo.cwd, 'commit', '-qm', 'illegal file commit\n\nPipeline-Role: gongbu\nPipeline-Author: a1b2c3d4');
  const tip = git(repo.cwd, 'rev-parse', 'HEAD');
  repo.history = git(repo.cwd, 'rev-list', repo.branch);
  git(repo.cwd, 'switch', '-q', 'integration/merge-contract');

  const result = invoke(repo, {
    tag: reviewTag(repo, { tip }),
  });

  assert.equal(result.status, 30, `${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /outside declared Write scope/);
  assertUnchanged(repo);
});

test('SCEN-MRG-12: commits authored by control/orchestrator role rejected with exit 31', (context) => {
  const repo = fixture(context);
  git(repo.cwd, 'switch', '-q', repo.branch);
  write(repo.cwd, 'src/task.txt', 'orchestrator direct code\n');
  git(repo.cwd, 'add', '.');
  git(repo.cwd, 'commit', '-qm', 'orchestrator commit\n\nPipeline-Role: shangshu\nPipeline-Author: s1s2s3s4');
  const tip = git(repo.cwd, 'rev-parse', 'HEAD');
  repo.history = git(repo.cwd, 'rev-list', repo.branch);
  git(repo.cwd, 'switch', '-q', 'integration/merge-contract');

  const result = invoke(repo, {
    tag: reviewTag(repo, { tip }),
  });

  assert.equal(result.status, 31, `${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /orchestrator\/control role 'shangshu'/);
  assertUnchanged(repo);
});

test('SCEN-MRG-13: reviewer matching commit author rejected with exit 32 (anti-self-approval)', (context) => {
  const repo = fixture(context);
  const result = invoke(repo, {
    tag: reviewTag(repo, { reviewer: 'a1b2c3d4' }),
  });

  assert.equal(result.status, 32, `${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /anti-self-approval violation/);
  assertUnchanged(repo);
});

test('SCEN-MRG-14: valid worker commit within scope merges successfully', (context) => {
  const repo = fixture(context);
  const tag = reviewTag(repo, { reviewer: '98765432' });
  const result = invoke(repo, {
    tag,
  });

  assertMerged(repo, result, { ids: ['T-1'], tag });
});

// --- 逐 commit 的作者/角色配对（L1-02） ---
// 区间里只要有一个合法 writer commit，旧实现就会整体放行；没有 trailer 的提交会被掩盖。

test('SCEN-MRG-15 every commit must carry its own Pipeline-Role, not inherit a sibling commit', (context) => {
  const repo = fixture(context);
  git(repo.cwd, 'switch', '-q', repo.branch);
  write(repo.cwd, 'src/task.txt', 'task change v2\n');
  git(repo.cwd, 'add', '.');
  // 这第二个提交完全没有 trailer：它可能是总控自己 Edit 后提交的。
  git(repo.cwd, 'commit', '-qm', 'hand edit without provenance');
  const tip = git(repo.cwd, 'rev-parse', 'HEAD');
  repo.history = git(repo.cwd, 'rev-list', repo.branch);
  git(repo.cwd, 'switch', '-q', integrationBranch);

  const result = invoke(repo, { tag: reviewTag(repo, { tip }) });
  assert.equal(result.status, 31, `${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /missing the Pipeline-Role trailer/);
  assertUnchanged(repo);
});

test('SCEN-MRG-15 legacy author bypass needs an explicit env confirmation and is recorded', (context) => {
  // `--allow-legacy-author` 会把作者血统门禁整体关掉。调用者顺手加个参数不该够用，
  // 必须同时给 PIPELINE_ALLOW_LEGACY_AUTHOR=1 表明这是有意的、已记录的决定。
  const repo = fixture(context);
  git(repo.cwd, 'switch', '-q', repo.branch);
  // 改写分支提交，去掉 Pipeline-Role/Pipeline-Author trailers（模拟历史遗留提交）。
  git(repo.cwd, 'commit', '-q', '--amend', '-m', 'legacy import without provenance');
  repo.tip = git(repo.cwd, 'rev-parse', 'HEAD');
  repo.history = git(repo.cwd, 'rev-list', repo.branch);
  git(repo.cwd, 'switch', '-q', integrationBranch);
  const tag = reviewTag(repo, { tip: repo.tip });

  const refused = invoke(repo, { tag, args: [repo.branch, 'T-1', tag, passCommand, '--allow-legacy-author'] });
  assert.equal(refused.status, 31, `${refused.stdout}${refused.stderr}`);
  assert.match(refused.stderr, /PIPELINE_ALLOW_LEGACY_AUTHOR=1/);
  assertUnchanged(repo);

  const allowed = invoke(repo, {
    tag,
    env: { PIPELINE_ALLOW_LEGACY_AUTHOR: '1' },
    args: [repo.branch, 'T-1', tag, passCommand, '--allow-legacy-author'],
  });
  assertMerged(repo, allowed, { tag });
  const log = git(repo.cwd, 'show', `HEAD:${logPath}`);
  assert.match(log, /author-provenance=BYPASSED\(legacy\)/);
});

test('SCEN-MRG-15 a missing Pipeline-Author trailer is rejected, not silently accepted', (context) => {
  const repo = fixture(context);
  git(repo.cwd, 'switch', '-q', repo.branch);
  write(repo.cwd, 'src/task.txt', 'task change v2\n');
  git(repo.cwd, 'add', '.');
  git(repo.cwd, 'commit', '-qm', 'role only\n\nPipeline-Role: gongbu');
  const tip = git(repo.cwd, 'rev-parse', 'HEAD');
  repo.history = git(repo.cwd, 'rev-list', repo.branch);
  git(repo.cwd, 'switch', '-q', integrationBranch);

  const result = invoke(repo, { tag: reviewTag(repo, { tip }) });
  assert.equal(result.status, 31, `${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /missing the Pipeline-Author trailer/);
  assertUnchanged(repo);
});

// --- 非自审的 UUID 前缀比较（L1-02） ---
// tag 里 reviewer 只写 8 位前缀，author 是完整 UUID；旧实现直接 includes 必然漏判。

test('SCEN-MRG-16 short reviewer prefix matching a full UUID author is still self-approval', (context) => {
  const repo = fixture(context);
  git(repo.cwd, 'switch', '-q', repo.branch);
  write(repo.cwd, 'src/task.txt', 'task change v2\n');
  git(repo.cwd, 'add', '.');
  git(repo.cwd, 'commit', '-qm', 'uuid authored\n\nPipeline-Role: gongbu\nPipeline-Author: dfa79d7b-1dfb-48ce-b896-cf1c5ed472c5');
  const tip = git(repo.cwd, 'rev-parse', 'HEAD');
  repo.history = git(repo.cwd, 'rev-list', repo.branch);
  git(repo.cwd, 'switch', '-q', integrationBranch);

  const result = invoke(repo, { tag: reviewTag(repo, { tip, reviewer: 'dfa79d7b' }) });
  assert.equal(result.status, 32, `${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /anti-self-approval violation/);
  assertUnchanged(repo);
});

test('SCEN-MRG-16 a full UUID reviewer equal to the author is rejected too', (context) => {
  const repo = fixture(context);
  git(repo.cwd, 'switch', '-q', repo.branch);
  write(repo.cwd, 'src/task.txt', 'task change v2\n');
  git(repo.cwd, 'add', '.');
  git(repo.cwd, 'commit', '-qm', 'uuid authored\n\nPipeline-Role: gongbu\nPipeline-Author: dfa79d7b-1dfb-48ce-b896-cf1c5ed472c5');
  const tip = git(repo.cwd, 'rev-parse', 'HEAD');
  repo.history = git(repo.cwd, 'rev-list', repo.branch);
  git(repo.cwd, 'switch', '-q', integrationBranch);

  // reviewer 写完整 UUID（与 Paseo 原生 id 一致）时也必须被识别为自审。
  const result = invoke(repo, { tag: reviewTag(repo, { tip, reviewer: 'dfa79d7b-1dfb-48ce-b896-cf1c5ed472c5' }) });
  assert.equal(result.status, 32, `${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /anti-self-approval violation/);
});

// --- 因子 3b：reviewer 与运行账本派发记录交叉核对（T-02 自审复刻） ---
//
// T-02 事故：review tag 里的 `dfa79d7b` 就是该任务的写手，但提交没有 `Pipeline-Author`
// trailer，按 commit 作者做的自审检查完全没触发，假收据照样进了合流账本。
// 这组用例把「账本里谁被派去做什么」作为第二道独立性证据。

/**
 * 写一份真实 schema 的运行账本，返回它的根目录（供 `PIPELINE_RUN_STATE_DIR` 覆盖）。
 *
 * 必须放在仓库**之外**：merge-task 开工先校验工作树干净，把账本写进 worktree 会直接
 * 变成一个未跟踪文件，用例会死在「树脏」而不是被测的审计独立性检查上。
 */
function writeRunState(context, intents) {
  const root = mkdtempSync(path.join(tmpdir(), 'pipeline-merge-state-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, change);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'run-state.json'), `${JSON.stringify({
    version: 1, run: null, lease: null, heartbeats: [], intents,
  }, null, 2)}\n`);
  return root;
}

function intent({ task = 'T-1', role, agentId, attempt = 1, phase = 'impl' }) {
  return {
    key: `local:${task}:${attempt}:${phase}:${role}:dispatch`,
    task, attempt, phase, role, action: 'dispatch',
    createdAt: '2026-10-26T00:00:00.000Z', resolvedAt: '2026-10-26T00:05:00.000Z',
    agentId, workspaceId: null,
  };
}

/**
 * 一个**存在但没有账本文件**的状态根目录。
 *
 * 直接不设 `PIPELINE_RUN_STATE_DIR` 也行（默认目录里若已有别的 change 账本，读的仍是被测
 * change 的路径），但显式给空目录能保证用例不被开发机上的真实账本污染。
 */
function emptyStateDir(context) {
  const root = mkdtempSync(path.join(tmpdir(), 'pipeline-merge-empty-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('SCEN-MRG-16 a reviewer that run-state records as the writer is self-approval, not just the trailer author', (context) => {
  const repo = fixture(context);
  // 复刻 T-02 的本质：提交上的作者 trailer 是别人的（或缺失），而 review tag 写的是
  // 账本里被派去写这个任务的 agent。只比对 commit 作者永远看不见这一层。
  const writerAgent = 'dfa79d7b-1dfb-48ce-b896-cf1c5ed472c5';
  const stateDir = writeRunState(context, [
    intent({ role: 'gongbu', agentId: writerAgent }),
    intent({ role: 'anchasi', phase: 'audit', agentId: '11111111-2222-3333-4444-555555555555' }),
  ]);

  const result = invoke(repo, {
    env: { PIPELINE_RUN_STATE_DIR: stateDir },
    tag: reviewTag(repo, { reviewer: 'dfa79d7b' }),
  });
  assert.equal(result.status, 32, `${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /dispatched as a writer for T-1/);
  assertUnchanged(repo);
});

test('SCEN-MRG-16 a reviewer with no recorded audit dispatch is rejected when run-state exists', (context) => {
  const repo = fixture(context);
  // 账本在，但这个 reviewer 从未被派去做审计：独立审查无法证明，不得按「没记录」放行。
  const stateDir = writeRunState(context, [
    intent({ role: 'gongbu', agentId: 'a1b2c3d4' }),
    intent({ role: 'anchasi', phase: 'audit', agentId: '99999999-8888-7777-6666-555555555555' }),
  ]);
  const result = invoke(repo, {
    env: { PIPELINE_RUN_STATE_DIR: stateDir },
    tag: reviewTag(repo, { reviewer: '12345678' }),
  });
  assert.equal(result.status, 32, `${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /no recorded audit or arbitration dispatch/);
  assertUnchanged(repo);
});

test('SCEN-MRG-16 a reviewer recorded as the audit intent for every task merges', (context) => {
  const repo = fixture(context);
  const stateDir = writeRunState(context, [
    intent({ role: 'gongbu', agentId: 'a1b2c3d4' }),
    intent({ role: 'anchasi', phase: 'audit', agentId: '12345678-aaaa-bbbb-cccc-dddddddddddd' }),
  ]);
  const result = invoke(repo, { env: { PIPELINE_RUN_STATE_DIR: stateDir } });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});

test('SCEN-MRG-16 an arbiter (hanlin) recorded as the arbitration intent for tasks merges', (context) => {
  const repo = fixture(context);
  const stateDir = writeRunState(context, [
    intent({ role: 'gongbu', agentId: 'a1b2c3d4' }),
    intent({ role: 'hanlin', phase: 'arbitrate', agentId: '4321abcd-aaaa-bbbb-cccc-dddddddddddd' }),
  ]);
  const result = invoke(repo, {
    env: { PIPELINE_RUN_STATE_DIR: stateDir },
    tag: reviewTag(repo, { reviewer: '4321abcd' }),
  });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});

// --- 因子 3b 的可观测性 ---
//
// 账本缺失时跳过交叉核对是**有意的**（热修单任务不走记账），但跳过必须留痕。
// 2026-10-26 的 5 任务冒烟就是这样跑完的：全程 `run-state.present=false`，
// 自审交叉核对一次都没执行，而 run-log 里没有任何一行说明这件事——
// 「门禁静默消失」与「门禁通过」在账本上长得一模一样。
test('SCEN-MRG-28 merging without a run-state ledger records review-attestation=SKIPPED', (context) => {
  const repo = fixture(context);
  const result = invoke(repo, { env: { PIPELINE_RUN_STATE_DIR: emptyStateDir(context) } });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const merge = git(repo.cwd, 'rev-parse', 'HEAD');
  const log = git(repo.cwd, 'show', `${merge}:${logPath}`);
  assert.match(log, /review-attestation=SKIPPED\(no-run-state\)/,
    'ledger absent must be recorded, not silently treated as attested');
});

test('SCEN-MRG-28 merging with a run-state ledger records review-attestation=run-state', (context) => {
  const repo = fixture(context);
  const stateDir = writeRunState(context, [
    intent({ role: 'gongbu', agentId: 'a1b2c3d4' }),
    intent({ role: 'anchasi', phase: 'audit', agentId: '12345678-aaaa-bbbb-cccc-dddddddddddd' }),
  ]);
  const result = invoke(repo, { env: { PIPELINE_RUN_STATE_DIR: stateDir } });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const merge = git(repo.cwd, 'rev-parse', 'HEAD');
  const log = git(repo.cwd, 'show', `${merge}:${logPath}`);
  assert.match(log, /review-attestation=run-state/);
  assert.doesNotMatch(log, /SKIPPED/);
});

test('SCEN-MRG-28 mechanical review without a ledger is not reported as skipped attestation', (context) => {
  // mechanical 本来就不做独立审计，把它记成 SKIPPED 会制造假警报。
  const repo = fixture(context, { tasks: [{ id: 'T-1', review: 'mechanical' }] });
  const result = invoke(repo, {
    env: { PIPELINE_RUN_STATE_DIR: emptyStateDir(context) },
    tag: reviewTag(repo, { reviewer: 'mechanical' }),
  });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const merge = git(repo.cwd, 'rev-parse', 'HEAD');
  const log = git(repo.cwd, 'show', `${merge}:${logPath}`);
  assert.match(log, /review-attestation=mechanical-review/);
  assert.doesNotMatch(log, /SKIPPED/);
});

// --- 依赖门禁（L1-03） ---
test('SCEN-MRG-17 merging a task whose dependency is not yet Done is rejected exit 35', (context) => {
  const repo = fixture(context, {
    tasks: [{ id: 'T-1' }, { id: 'T-2', depends: 'T-1' }],
    branch: `task/${change}/T-2`,
  });
  const result = invoke(repo, { ids: 'T-2', tag: reviewTag(repo) });
  assert.equal(result.status, 35, `${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /depends on T-1 which are not verified Done/);
  assertUnchanged(repo);
});

test('SCEN-MRG-17 a checked-but-unverified dependency does not unlock the dependent', (context) => {
  // tasks.md 说 T-1 已完成，但没有对应的 first-parent 合流提交 —— 账本声明不是事实。
  const repo = fixture(context, {
    tasks: [{ id: 'T-1', done: true }, { id: 'T-2', depends: 'T-1' }],
    branch: `task/${change}/T-2`,
  });
  const result = invoke(repo, { ids: 'T-2', tag: reviewTag(repo) });
  assert.equal(result.status, 35, `${result.stdout}${result.stderr}`);
  assertUnchanged(repo);
});

test('SCEN-MRG-17 merging the dependency first unblocks the dependent', (context) => {
  const tasks = [{ id: 'T-1' }, { id: 'T-2', depends: 'T-1' }];
  const first = fixture(context, { tasks, branch: `task/${change}/T-1` });
  const merged = invoke(first, { ids: 'T-1', tag: reviewTag(first) });
  assert.equal(merged.status, 0, `${merged.stdout}${merged.stderr}`);

  // 在合流后的集成 HEAD 上，T-1 已被 first-parent 证明 Done，T-2 可合。
  // T-2 只改 scope 内的 src/shared.txt，verify.mjs 保持原断言（src/task.txt 仍是 T-1 合流后的值）。
  git(first.cwd, 'switch', '-qc', `task/${change}/T-2`);
  write(first.cwd, 'src/shared.txt', 'task two version\n');
  git(first.cwd, 'add', '.');
  git(first.cwd, 'commit', '-qm', 'T-2 implementation\n\nPipeline-Role: gongbu\nPipeline-Author: a1b2c3d4');
  const tip2 = git(first.cwd, 'rev-parse', 'HEAD');
  git(first.cwd, 'switch', '-q', integrationBranch);
  const head = git(first.cwd, 'rev-parse', 'HEAD');

  const second = invoke(first, {
    branch: `task/${change}/T-2`,
    ids: 'T-2',
    tag: `pass(87654321@${tip2.slice(0, 7)}/${head.slice(0, 7)})`,
  });
  assert.equal(second.status, 0, `${second.stdout}${second.stderr}`);
  assert.equal(git(first.cwd, 'show', 'HEAD:src/shared.txt'), 'task two version');
});

// --- review base 合法性（L1-03） ---

test('SCEN-MRG-18 a review base that is not an ancestor of integration HEAD is rejected exit 34', (context) => {
  const repo = fixture(context);
  // 造一个与集成历史完全无关的孤立提交作为 base（无父提交，因此不可能是任何分支的祖先）。
  // 不用 `switch --orphan` + `rm .`：空工作树时 `git rm -rfq .` 会因无 pathspec 命中而失败。
  const emptyTree = git(repo.cwd, 'mktree');
  const orphanBase = git(repo.cwd, 'commit-tree', emptyTree, '-m', 'orphan baseline');

  const result = invoke(repo, { tag: reviewTag(repo, { base: orphanBase }) });
  assert.equal(result.status, 34, `${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /is not an ancestor of integration HEAD/);
  assertUnchanged(repo);
});

test('SCEN-MRG-18 a review base newer than the reviewed source is rejected exit 34', (context) => {
  const repo = fixture(context);
  // 集成分支在任务分支拉出之后又前进一步；用这个新 HEAD 当 base 时，它仍是集成历史的祖先，
  // 只查「是集成 HEAD 祖先」会放行——但 `base..tip` 已不再覆盖本任务的改动，
  // 写范围与漂移校验都会算错。必须额外要求 base 也是被合入 tip 的祖先。
  write(repo.cwd, 'src/integration.txt', 'later\n');
  git(repo.cwd, 'add', '.');
  git(repo.cwd, 'commit', '-qm', 'integration advanced past task base');
  const newer = git(repo.cwd, 'rev-parse', 'HEAD');
  const result = invoke(repo, { tag: reviewTag(repo, { base: newer }) });
  assert.equal(result.status, 34, `${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /is not an ancestor of the merged tip/);
  assertUnchanged(repo, newer);
});


// --- 合流原子性边界（L1-08） ---

test('SCEN-MRG-19 merging pins the reviewed tip, so a branch that moved after review is rejected', (context) => {
  const repo = fixture(context);
  const reviewedTip = repo.tip;
  // 审查收据绑定 reviewedTip，但分支在审查后又前进了一步。
  git(repo.cwd, 'switch', '-q', repo.branch);
  write(repo.cwd, 'src/task.txt', 'unreviewed change\n');
  git(repo.cwd, 'add', '.');
  git(repo.cwd, 'commit', '-qm', 'unreviewed follow-up\n\nPipeline-Role: gongbu\nPipeline-Author: a1b2c3d4');
  git(repo.cwd, 'switch', '-q', integrationBranch);

  const result = invoke(repo, {
    tag: `pass(12345678@${reviewedTip.slice(0, 7)}/${repo.base.slice(0, 7)})`,
  });
  // 收据 tip 与实际 tip 不符必须拒绝：否则「审查过的内容」与「合入的内容」不是同一个 commit。
  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /review tip mismatch/);
  // 这里不能用 assertUnchanged：分支被测试自己推进过，分支历史本就该变；
  // 要守的是「集成 HEAD 未动、工作树干净、没有留下未完成合流」。
  assert.equal(git(repo.cwd, 'rev-parse', 'HEAD'), repo.base, 'integration HEAD must remain unchanged');
  assert.equal(git(repo.cwd, 'status', '--porcelain'), '', 'working tree must be clean');
});

test('SCEN-MRG-19 a test command that modifies the working tree is refused, not committed', (context) => {
  const repo = fixture(context);
  // 测试命令通过却顺手写了工作树文件：旧实现会把副作用一起合进集成历史。
  const dirtyCommand = `${JSON.stringify(process.execPath)} -e `
    + `${JSON.stringify("require('fs').writeFileSync('src/task.txt','rewritten by test')")}`;
  const result = invoke(repo, { command: dirtyCommand });
  assert.equal(result.status, 20, `${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /modified the working tree/);
  assertUnchanged(repo);
});

test('SCEN-MRG-25 a test command that commits during the merge is detected, not silently ignored', (context) => {
  // 测试命令在合流期间自己 `git commit`：MERGE_HEAD 消失，但集成 HEAD 已被推进，
  // 而这个提交完全没有 Pipeline-Task/Pipeline-Source 记账。旧 abortMerge 看到
  // MERGE_HEAD 就 return，脚本随后以 exit 20 退出并声称「现场已恢复」——
  // 实际留下一个未记账的提交，后续合流会拿它当基线算漂移与写范围。
  const repo = fixture(context);
  const commitCommand = `${JSON.stringify(process.execPath)} -e `
    + `${JSON.stringify("require('child_process').execFileSync('git',['commit','-m','smuggled by test'],{stdio:'ignore'})")}`;
  const result = invoke(repo, { command: commitCommand });
  assert.equal(result.status, 40, `${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /merge state vanished/);
  assert.match(result.stderr, /NO Pipeline-Task/);
  // 不可静默断言：集成 HEAD 确实前进了，且脚本没有替人 reset。
  assert.notEqual(git(repo.cwd, 'rev-parse', 'HEAD'), repo.base,
    'the smuggled commit must still be present: this script must never reset history');
  assert.equal(git(repo.cwd, 'status', '--porcelain'), '', 'working tree must be clean');
});

test('SCEN-MRG-19 MERGE_TEST_TIMEOUT_MS bounds a hanging test command', (context) => {
  const repo = fixture(context);
  const hangCommand = `${JSON.stringify(process.execPath)} -e `
    + `${JSON.stringify("setTimeout(()=>{}, 60000)")}`;
  const result = spawnSync(process.execPath, [
    mergeScript, repo.branch, 'T-1', reviewTag(repo), hangCommand,
  ], {
    cwd: repo.cwd,
    env: { ...gitEnv, MERGE_TEST_TIMEOUT_MS: '1500' },
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 20, `${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /timed out/);
  assertUnchanged(repo);
});

test('SCEN-MRG-26 a timeout kills the whole process tree, so grandchildren cannot keep writing', (context) => {
  // `spawnSync(..., {shell:true, timeout})` 只杀 /bin/sh 这一层；命令里再起的孙进程
  // （npm → jest → worker、run.sh → 子测试）会脱离 shell 继续跑，一边写工作区一边让
  // 「测试后指纹」比对基于错误的时间点。这里让 shell 起一个**3 秒后**才写文件的孙进程，
  // 超时 1.2 秒就返回：若进程组真的被杀，孙进程活不到写文件那一刻。
  const repo = fixture(context);
  const marker = 'grandchild-wrote.txt';
  const grandchild = `${JSON.stringify(process.execPath)} -e `
    + `${JSON.stringify(`setTimeout(()=>require('fs').writeFileSync('${marker}','late'),3000)`)}`;
  const command = `sh -c ${JSON.stringify(`(${grandchild}) & sleep 60`)}`;
  const result = spawnSync(process.execPath, [
    mergeScript, repo.branch, 'T-1', reviewTag(repo), command,
  ], {
    cwd: repo.cwd,
    env: { ...gitEnv, MERGE_TEST_TIMEOUT_MS: '1200' },
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 20, `${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /timed out/);
  // 孙进程原定 3 秒后写；脚本 1.2 秒超时返回，之后再等 4 秒观察它是否还活着。
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 4000);
  assert.equal(fs.existsSync(path.join(repo.cwd, marker)), false,
    'the grandchild must have been killed with the process group');
  assertUnchanged(repo);
});

test('SCEN-MRG-27 re-merging the same tip is rejected as already-merged, with no new commit', (context) => {
  // 规范语义（SCEN-MRG-08）：已 Done 一律 exit 非零且不产生新提交。
  // 这里要守住的是**诊断精度**：同一 tip 的重试必须被明确指出「已经合过了」，
  // 而不是和「换了 revision 的旧成果顶替」共用一句含糊告警——两者的处置完全相反。
  const repo = fixture(context);
  const tag = reviewTag(repo);
  assertMerged(repo, invoke(repo, { tag }));
  const mergedHead = git(repo.cwd, 'rev-parse', 'HEAD');
  const logAfterFirst = git(repo.cwd, 'show', `HEAD:${logPath}`);

  const again = invoke(repo, { tag });
  assert.notEqual(again.status, 0, `${again.stdout}${again.stderr}`);
  assert.match(again.stderr, /is already merged from [0-9a-f]{7}/);
  assert.match(again.stderr, /retry after a lost merge receipt/);
  // 幂等：不再产生第二个合流提交，也不改账本。
  assert.equal(git(repo.cwd, 'rev-parse', 'HEAD'), mergedHead, 'a retry must not advance integration HEAD');
  assert.equal(git(repo.cwd, 'show', `HEAD:${logPath}`), logAfterFirst, 'a retry must not rewrite the task ledger');
  assert.equal(git(repo.cwd, 'status', '--porcelain'), '', 'a rejected retry must leave the tree clean');
});

test('SCEN-MRG-27 a Done task whose source is a different tip is still rejected', (context) => {
  // 幂等只对「同一个 tip」成立。已 Done 但 Done.source 是别的 revision，
  // 说明本次要合的是另一轮产物——必须拒绝，不能拿旧成果顶替。
  const repo = fixture(context);
  assertMerged(repo, invoke(repo));
  git(repo.cwd, 'switch', '-q', repo.branch);
  write(repo.cwd, 'src/task.txt', 'second attempt\n');
  git(repo.cwd, 'add', '.');
  git(repo.cwd, 'commit', '-qm', 'second attempt\n\nPipeline-Role: gongbu\nPipeline-Author: a1b2c3d4');
  const secondTip = git(repo.cwd, 'rev-parse', 'HEAD');
  git(repo.cwd, 'switch', '-q', integrationBranch);
  const result = invoke(repo, { tag: `pass(12345678@${secondTip.slice(0, 7)}/${repo.base.slice(0, 7)})` });
  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /already Done: T-1 .*different revision|already Done/);
});

// --- 写范围判定的路径保真（2026-10-26 实测缺口） ---
// 两个开关缺一，写范围门禁就会静默失效或被误伤，而当时所有用例仍全绿。

test('SCEN-MRG-21 a renamed file cannot smuggle its old path out of Write scope', (context) => {
  // 旧实现用 `git diff --name-only`（默认开改名检测）：改名只报**新**路径，
  // 被删除的旧路径（本例在 scope 之外）完全不出现在改动列表里 → 一次 git mv 就能绕过写范围。
  // 关键：新路径必须落在 scope 内（src/task.txt），否则普通越界检查也会拦下，
  // 用例就测不到改名这一层（最初版本正是如此，负向对照里照样「通过」）。
  const repo = fixture(context, { baselineFiles: { 'outside/secret.txt': 'must not move\n' } });
  git(repo.cwd, 'switch', '-q', repo.branch);
  git(repo.cwd, 'rm', '-q', 'src/task.txt');
  git(repo.cwd, 'mv', 'outside/secret.txt', 'src/task.txt');
  git(repo.cwd, 'add', '.');
  git(repo.cwd, 'commit', '-qm', 'move outside file into scope\n\nPipeline-Role: gongbu\nPipeline-Author: a1b2c3d4');
  const tip = git(repo.cwd, 'rev-parse', 'HEAD');
  repo.tip = tip;
  repo.history = git(repo.cwd, 'rev-list', repo.branch);
  git(repo.cwd, 'switch', '-q', integrationBranch);

  const result = invoke(repo, { tag: reviewTag(repo, { tip }) });
  assert.equal(result.status, 30, `${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /outside declared Write scope/);
  assertUnchanged(repo);
});

test('SCEN-MRG-22 a non-ASCII in-scope path is not falsely flagged as out of scope', (context) => {
  // 实测：`git diff --name-only` 把非 ASCII 路径转义成 `"src/\344\270\255..."`，
  // 与 tasks.md 写的真实路径字面量永不相等 → 合法改动被判越界。
  const repo = fixture(context, {
    tasks: [{ id: 'T-1', scope: 'src/中文.txt, src/task.txt' }],
  });
  git(repo.cwd, 'switch', '-q', repo.branch);
  write(repo.cwd, 'src/中文.txt', '内容\n');
  git(repo.cwd, 'add', '.');
  git(repo.cwd, 'commit', '-qm', 'add chinese file\n\nPipeline-Role: gongbu\nPipeline-Author: a1b2c3d4');
  const tip = git(repo.cwd, 'rev-parse', 'HEAD');
  repo.history = git(repo.cwd, 'rev-list', repo.branch);
  git(repo.cwd, 'switch', '-q', integrationBranch);

  const tag = reviewTag(repo, { tip });
  // assertMerged 用 repo.tip 校验合流父提交，分支已前移，必须同步否则比的是旧提交。
  repo.tip = tip;
  assertMerged(repo, invoke(repo, { tag }), { ids: ['T-1'], tag });
});

// --- 单写者锁（L1-08） ---
// 没有锁时两个并发合流会互相 `merge --abort`，双方都以为自己在写同一份集成历史。

test('SCEN-MRG-23 a concurrent merge is rejected instead of racing on the same worktree', (context) => {
  const repo = fixture(context);
  // 手工占住锁：模拟另一个合流正在进行（真实并发下第二个进程看到的正是这个状态）。
  const lockDir = path.join(git(repo.cwd, 'rev-parse', '--git-common-dir'), 'paseo-pipeline', 'locks');
  mkdirSync(path.join(repo.cwd, lockDir), { recursive: true });
  writeFileSync(path.join(repo.cwd, lockDir, `merge-${change}.lock`),
    JSON.stringify({ pid: 99999, host: 'other-host', acquiredAt: new Date().toISOString() }));

  const result = invoke(repo);
  assert.equal(result.status, 37, `${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /another merge is in progress/);
  assertUnchanged(repo);
});

test('SCEN-MRG-23 the merge lock is released on success so the next merge can proceed', (context) => {
  const repo = fixture(context);
  assertMerged(repo, invoke(repo));
  const lockDir = path.join(git(repo.cwd, 'rev-parse', '--git-common-dir'), 'paseo-pipeline', 'locks');
  assert.equal(fs.existsSync(path.join(repo.cwd, lockDir, `merge-${change}.lock`)), false,
    'a successful merge must leave no lock behind');
});

// --- 错误严重度：只压住被点名的任务，不因无关任务的问题挡住整批合流 ---
// 严重度归属在 lib/tasks.mjs 的 ERROR_SCOPE 单点定义；这里验的是合流入口的消费方式。
test('SCEN-CON-01 a task-level error on an unrelated task does not block this merge', (context) => {
  // T-2 缺 Write scope（task 级错误），本次合流的是 T-1 —— 两者毫无关系。
  const repo = fixture(context, { tasks: [{ id: 'T-1' }, { id: 'T-2', scope: '' }] });
  assertMerged(repo, invoke(repo));
});

test('SCEN-CON-01 a task-level error on the requested task itself still blocks', (context) => {
  const repo = fixture(context, { tasks: [{ id: 'T-1', scope: '' }] });
  const result = invoke(repo);
  assertRejected(repo, result);
  assert.match(result.stderr, /MISSING_SCOPE/);
});

test('SCEN-CON-01 a task-level error on a direct dependency still blocks', (context) => {
  // 依赖的账本完整性是本次合流真正消费的约束，不能放过。
  const repo = fixture(context, { tasks: [{ id: 'T-1', depends: 'T-2' }, { id: 'T-2', scope: '' }] });
  const result = invoke(repo);
  assertRejected(repo, result);
  assert.match(result.stderr, /MISSING_SCOPE/);
});

test('SCEN-CON-01 a graph-level error blocks every merge regardless of the requested task', (context) => {
  // 依赖指向不存在的任务：整份 DAG 不可信，任何任务的合流都拒绝。
  const repo = fixture(context, { tasks: [{ id: 'T-1' }, { id: 'T-2', depends: 'T-99' }] });
  const result = invoke(repo);
  assertRejected(repo, result);
  assert.match(result.stderr, /UNKNOWN_DEP/);
});
