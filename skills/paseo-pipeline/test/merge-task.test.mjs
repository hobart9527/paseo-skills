import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function taskMarkdown({ id, review = 'strict', done = false }, index) {
  return [
    `- [${done ? 'x' : ' '}] 1.${index + 1} ${id} Deliver ${id}`,
    ...(done ? ['  - Done: source=1234567 review=pass(12345678@1234567/7654321)'] : []),
    '  - Depends on: none',
    '  - Write scope: src/task.txt, src/shared.txt',
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
} = {}) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'pipeline-merge-test-'));
  context.after(() => rmSync(cwd, { recursive: true, force: true }));
  git(cwd, 'init', '-q', '-b', 'main');
  git(cwd, 'config', 'core.hooksPath', '/dev/null');
  git(cwd, 'config', 'commit.gpgsign', 'false');
  git(cwd, 'config', 'merge.gpgsign', 'false');
  git(cwd, 'config', 'rerere.enabled', 'false');
  write(cwd, 'src/shared.txt', 'base\n');
  write(cwd, 'verify.mjs', [
    "import assert from 'node:assert/strict';",
    "import { readFileSync } from 'node:fs';",
    "assert.equal(readFileSync('src/task.txt', 'utf8'), 'task change\\n');",
    '',
  ].join('\n'));
  if (taskFile) write(cwd, tasksPath, `# Tasks\n\n${tasks.map(taskMarkdown).join('\n\n')}\n`);
  if (runLog) write(cwd, logPath, initialLog);
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', 'fixture baseline');
  git(cwd, 'switch', '-qc', integrationBranch);
  const base = git(cwd, 'rev-parse', 'HEAD');
  git(cwd, 'switch', '-qc', branch);
  write(cwd, 'src/task.txt', 'task change\n');
  if (sharedChange) write(cwd, 'src/shared.txt', 'task version\n');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', 'task implementation');
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
  args = [repo.branch, ids, tag, command],
} = {}) {
  const result = spawnSync(shell ? 'bash' : process.execPath, [shell ? shellScript : mergeScript, ...args], {
    cwd: repo.cwd,
    env: gitEnv,
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
    const repo = fixture(context, { sharedChange: true });
    write(repo.cwd, 'src/shared.txt', 'integration version\n');
    git(repo.cwd, 'add', '.');
    git(repo.cwd, 'commit', '-qm', 'conflicting integration change');
    const head = git(repo.cwd, 'rev-parse', 'HEAD');
    const tag = reviewTag(repo, { base: head });
    const result = invoke(repo, { shell, tag });
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
  const repo = fixture(context, { branch: `pod/${change}` });
  const ids = ['T-1', 'T-2'];
  assertMerged(repo, invoke(repo, { ids: ids.join(',') }), { ids });
  const tasks = git(repo.cwd, 'show', `HEAD:${tasksPath}`);
  assert.match(tasks, /^- \[ \] 1\.2 T-10 /m);
});

test('pod branch rejects unknown IDs without partially marking known tasks', (context) => {
  const repo = fixture(context, { branch: `pod/${change}` });
  assertRejected(repo, invoke(repo, { ids: 'T-1,T-99' }));
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
  });
  assertRejected(repo, invoke(repo, { ids: 'T-1,T-2', tag: reviewTag(repo, { reviewer: 'mechanical' }) }));
});
