import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../pipeline-run.mjs', import.meta.url));
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
};
delete env.NODE_TEST_CONTEXT;

const WORKER = '9b2f4c1e-2222-4a2b-8c3d-000000000002';

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}
function write(cwd, file, text) {
  const p = path.join(cwd, file);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}
function fakePaseo(dir, agents = []) {
  const bin = path.join(dir, '.fake-bin');
  fs.mkdirSync(bin, { recursive: true });
  const payload = Buffer.from(JSON.stringify(agents)).toString('base64');
  fs.writeFileSync(path.join(bin, 'paseo'), [
    '#!/bin/sh',
    `if [ "$1" = inspect ]; then printf '{}'; else printf '%s' '${payload}' | base64 -d; fi`,
    "printf '\\n'",
  ].join('\n'));
  fs.chmodSync(path.join(bin, 'paseo'), 0o755);
  return { ...env, PATH: `${bin}:${process.env.PATH}` };
}

const PASSING_TEST = `import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
test('behavior', () => { assert.equal(fs.existsSync('src/a.txt'), true); });
`;

function fixture({ done = false } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-run-'));
  const localEnv = fakePaseo(cwd);
  write(cwd, 'openspec/changes/chg/tasks.md',
    `- [${done ? 'x' : ' '}] 1.1 T-01 task\n  - Write scope: src,test\n  - Verify with: node --test test/a.test.mjs\n`
    + `${done ? '  - Done: source=abcdef1 review=worker\n' : ''}`
    + `- [ ] 1.2 T-02 later\n  - Depends on: T-01\n  - Write scope: src/b,test/b\n  - Verify with: node --test test/b.test.mjs\n`);
  write(cwd, 'openspec/changes/chg/proposal.md', 'p\n');
  write(cwd, 'openspec/changes/chg/acceptance.md', 'a\n');
  git(cwd, 'init', '-q', '-b', 'main');
  git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'contract');
  const base = git(cwd, 'rev-parse', 'HEAD');
  git(cwd, 'switch', '-qc', 'integration/chg');
  return { cwd, localEnv, base };
}

function run(cwd, localEnv, args) {
  const r = spawnSync('node', [script, ...args], { cwd, env: localEnv, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, out: `${r.stdout}${r.stderr}` };
}

function implement(cwd, branch) {
  git(cwd, 'switch', '-qc', branch);
  write(cwd, 'test/a.test.mjs', PASSING_TEST);
  write(cwd, 'src/a.txt', 'a');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', `work\n\nPipeline-Role: gongbu\nPipeline-Author: ${WORKER}`);
  const tip = git(cwd, 'rev-parse', 'HEAD');
  git(cwd, 'switch', '-q', 'integration/chg');
  return tip;
}

test('plan --allow-attempt-over releases only named capped tasks', () => {
  const f = fixture();
  const tasks = path.join(f.cwd, 'openspec/changes/chg/tasks.md');
  fs.writeFileSync(tasks, fs.readFileSync(tasks, 'utf8').replace('  - Depends on: T-01\n', ''));
  git(f.cwd, 'add', 'openspec/changes/chg/tasks.md');
  git(f.cwd, 'commit', '-qm', 'independent task');
  for (const task of ['T-01', 'T-02']) for (const attempt of [1, 2, 3, 4]) {
    const branch = `task/chg/${task}${attempt === 1 ? '' : `-a${attempt}`}`;
    if (attempt !== 4) git(f.cwd, 'branch', branch);
    else {
      git(f.cwd, 'switch', '-qc', branch);
      write(f.cwd, `src/${task}.txt`, task);
      git(f.cwd, 'add', '.');
      git(f.cwd, 'commit', '-qm', `work\n\nPipeline-Role: gongbu\nPipeline-Author: ${WORKER}`);
      git(f.cwd, 'switch', '-q', 'integration/chg');
    }
  }
  const dir = path.join(f.cwd, 'openspec/changes/chg');
  let result = run(f.cwd, f.localEnv, ['plan', dir, '--json']);
  assert.equal(result.status, 0, result.out);
  assert.deepEqual(JSON.parse(result.stdout).dispatch, []);
  result = run(f.cwd, f.localEnv, ['plan', dir, '--json', '--allow-attempt-over', 'T-01']);
  assert.equal(result.status, 0, result.out);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.dispatch.map((item) => item.task), ['T-01']);
  assert.deepEqual(report.blocked.map((item) => item.task), ['T-02']);
});

test('plan delegates to the frontier and prints the ready task', () => {
  const f = fixture();
  const r = run(f.cwd, f.localEnv, ['plan', path.join(f.cwd, 'openspec/changes/chg'), '--json']);
  assert.equal(r.status, 0, r.out);
  const report = JSON.parse(r.stdout);
  assert.deepEqual(report.dispatch.map((item) => item.task), ['T-01']);
  assert.deepEqual(report.dispatch.map((item) => item.action), ['create-branch+dispatch-worker']);
});

test('merge resolves the newest attempt branch and records Done', () => {
  const f = fixture();
  implement(f.cwd, 'task/chg/T-01');
  // A second attempt exists; the driver must pick it.
  const tip2 = implement(f.cwd, 'task/chg/T-01-a2');
  const r = run(f.cwd, f.localEnv, ['merge', path.join(f.cwd, 'openspec/changes/chg'), 'T-01']);
  assert.equal(r.status, 0, r.out);
  const tasks = fs.readFileSync(path.join(f.cwd, 'openspec/changes/chg/tasks.md'), 'utf8');
  assert.match(tasks, new RegExp(`Done: source=${tip2.slice(0, 7)} review=worker`));
});

test('merge forwards the gate exit code for a missing branch', () => {
  const f = fixture();
  const r = run(f.cwd, f.localEnv, ['merge', path.join(f.cwd, 'openspec/changes/chg'), 'T-99']);
  assert.equal(r.status, 3, r.out);
  assert.match(r.stderr, /no branch for T-99/);
});

test('status reports done and open tasks with the integration head', () => {
  const f = fixture({ done: true });
  const r = run(f.cwd, f.localEnv, ['status', path.join(f.cwd, 'openspec/changes/chg'), '--json']);
  assert.equal(r.status, 0, r.out);
  const report = JSON.parse(r.stdout);
  assert.deepEqual(report.done, ['T-01']);
  assert.deepEqual(report.open, ['T-02']);
  assert.match(report.integrationHead, /^[0-9a-f]{40}$/);
});

test('status reads Done lines from the integration branch after a merge', () => {
  const f = fixture();
  implement(f.cwd, 'task/chg/T-01');
  const r = run(f.cwd, f.localEnv, ['merge', path.join(f.cwd, 'openspec/changes/chg'), 'T-01']);
  assert.equal(r.status, 0, r.out);
  const status = run(f.cwd, f.localEnv, ['status', path.join(f.cwd, 'openspec/changes/chg'), '--json']);
  assert.equal(status.status, 0, status.out);
  const report = JSON.parse(status.stdout);
  assert.equal(report.tasksSource, 'integration');
  assert.deepEqual(report.done, ['T-01']);
  assert.deepEqual(report.open, ['T-02']);
});

test('install-hook enables worktree config and points hooksPath at the skill hooks', () => {
  const f = fixture();
  const r = run(f.cwd, f.localEnv, ['install-hook', f.cwd]);
  assert.equal(r.status, 0, r.out);
  assert.match(git(f.cwd, 'config', '--worktree', '--get', 'core.hooksPath'), /paseo-pipeline\/hooks\/git$/);
});

test('plan warns when a change worktree is missing the author hook', () => {
  const f = fixture();
  const changeDir = path.join(f.cwd, 'openspec/changes/chg');
  const before = run(f.cwd, f.localEnv, ['plan', changeDir]);
  assert.equal(before.status, 0, before.out);
  assert.match(before.stderr, /has no author hook/);
  assert.match(before.stderr, /install-hook/);
  assert.equal(run(f.cwd, f.localEnv, ['install-hook', f.cwd]).status, 0);
  const after = run(f.cwd, f.localEnv, ['plan', changeDir]);
  assert.doesNotMatch(after.stderr, /has no author hook/);
});

test('a change directory without tasks.md is unreadable state (exit 3)', () => {
  const f = fixture();
  const r = run(f.cwd, f.localEnv, ['status', path.join(f.cwd, 'openspec/changes/nope')]);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /no tasks.md/);
});

test('failed merge survives process restart and linked worktree; explicit retry recovers same tip', () => {
  const f = fixture();
  git(f.cwd, 'switch', '-qc', 'task/chg/T-01');
  write(f.cwd, 'src/a.txt', 'a');
  write(f.cwd, 'test/a.test.mjs', "if (!process.env.FIXED_ENV) process.exit(1);\n");
  git(f.cwd, 'add', '.');
  git(f.cwd, 'commit', '-qm', `work\n\nPipeline-Role: gongbu\nPipeline-Author: ${WORKER}`);
  git(f.cwd, 'switch', '-q', 'integration/chg');
  const dir = path.join(f.cwd, 'openspec/changes/chg');
  let r = run(f.cwd, f.localEnv, ['merge', dir, 'T-01']);
  assert.equal(r.status, 20, r.out);
  const other = `${f.cwd}-other`;
  git(f.cwd, 'worktree', 'add', '-q', '--detach', other, 'integration/chg');
  r = run(other, f.localEnv, ['plan', path.join(other, 'openspec/changes/chg'), '--json']);
  assert.equal(r.status, 0, r.out);
  assert.equal(JSON.parse(r.stdout).blocked[0].kind, 'BLOCKED_MERGE');
  assert.ok(!JSON.parse(r.stdout).dispatch.some((item) => item.task === 'T-01'));
  r = run(f.cwd, { ...f.localEnv, FIXED_ENV: '1' }, ['merge', dir, 'T-01']);
  assert.equal(r.status, 0, r.out);
  assert.match(fs.readFileSync(path.join(dir, 'tasks.md'), 'utf8'), /\[x\].*T-01/);
});

test('new worker tip releases a previous merge failure', () => {
  const f = fixture();
  git(f.cwd, 'switch', '-qc', 'task/chg/T-01');
  write(f.cwd, 'src/a.txt', 'a');
  write(f.cwd, 'test/a.test.mjs', 'process.exit(1);\n');
  git(f.cwd, 'add', '.');
  git(f.cwd, 'commit', '-qm', `work\n\nPipeline-Role: gongbu\nPipeline-Author: ${WORKER}`);
  git(f.cwd, 'switch', '-q', 'integration/chg');
  const dir = path.join(f.cwd, 'openspec/changes/chg');
  assert.equal(run(f.cwd, f.localEnv, ['merge', dir, 'T-01']).status, 20);
  git(f.cwd, 'switch', '-q', 'task/chg/T-01');
  write(f.cwd, 'test/a.test.mjs', 'process.exit(0);\n');
  git(f.cwd, 'add', '.');
  git(f.cwd, 'commit', '-qm', `fix\n\nPipeline-Role: gongbu\nPipeline-Author: ${WORKER}`);
  git(f.cwd, 'switch', '-q', 'integration/chg');
  const r = run(f.cwd, f.localEnv, ['plan', dir, '--json']);
  assert.equal(r.status, 0, r.out);
  assert.equal(JSON.parse(r.stdout).dispatch.find((item) => item.task === 'T-01').action, 'merge');
  assert.equal(run(f.cwd, f.localEnv, ['merge', dir, 'T-01']).status, 0);
});

test('FINAL repair enters integration through a new task and verification binds to merged SHA', () => {
  const f = fixture();
  implement(f.cwd, 'task/chg/T-01');
  const dir = path.join(f.cwd, 'openspec/changes/chg');
  assert.equal(run(f.cwd, f.localEnv, ['merge', dir, 'T-01']).status, 0);
  // Simulate an approved contract amendment, retaining the original Done line.
  const tasksFile = path.join(dir, 'tasks.md');
  let tasks = fs.readFileSync(tasksFile, 'utf8');
  tasks = tasks.replace('Write scope: src/b,test/b', 'Write scope: src/a.txt,test/fix.test.mjs')
    .replace('node --test test/b.test.mjs', 'node --test test/fix.test.mjs');
  fs.writeFileSync(tasksFile, tasks);
  git(f.cwd, 'add', 'openspec/changes/chg/tasks.md');
  git(f.cwd, 'commit', '-qm', 'approved repair task');
  git(f.cwd, 'switch', '-qc', 'task/chg/T-02');
  write(f.cwd, 'src/a.txt', 'fixed');
  write(f.cwd, 'test/fix.test.mjs', "import {readFileSync} from 'node:fs'; import assert from 'node:assert/strict'; assert.equal(readFileSync('src/a.txt','utf8'), 'fixed');\n");
  git(f.cwd, 'add', '.');
  git(f.cwd, 'commit', '-qm', `repair\n\nPipeline-Role: gaogong\nPipeline-Author: ${WORKER}`);
  git(f.cwd, 'switch', '-q', 'integration/chg');
  const merged = run(f.cwd, f.localEnv, ['merge', dir, 'T-02']);
  assert.equal(merged.status, 0, merged.out);
  const sha = git(f.cwd, 'rev-parse', 'HEAD');
  const validation = spawnSync('node', ['--test', 'test/a.test.mjs', 'test/fix.test.mjs'], { cwd: f.cwd, env: f.localEnv, encoding: 'utf8' });
  assert.equal(validation.status, 0, validation.stderr);
  assert.equal(git(f.cwd, 'rev-parse', 'HEAD'), sha);
  assert.match(fs.readFileSync(tasksFile, 'utf8'), /\[x\].*T-02/);
  assert.equal(git(f.cwd, 'status', '--porcelain'), '');
});

test('interrupted merge marker is shared and blocks automatic retry', () => {
  const f = fixture();
  const tip = implement(f.cwd, 'task/chg/T-01');
  const payload = JSON.stringify({ tip, status: 'pending' });
  const object = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: f.cwd, env, input: payload, encoding: 'utf8' });
  assert.equal(object.status, 0, object.stderr);
  git(f.cwd, 'update-ref', 'refs/pipeline/merge-failures/chg/T-01', object.stdout.trim());
  const dir = path.join(f.cwd, 'openspec/changes/chg');
  const r = run(f.cwd, f.localEnv, ['plan', dir, '--json']);
  assert.equal(r.status, 0, r.out);
  assert.equal(JSON.parse(r.stdout).blocked[0].kind, 'BLOCKED_MERGE');
  assert.equal(run(f.cwd, f.localEnv, ['merge', dir, 'T-01']).status, 0);
});

test('failed empty branch merge allows worker dispatch after restart', () => {
  const f = fixture();
  git(f.cwd, 'branch', 'task/chg/T-01');
  const dir = path.join(f.cwd, 'openspec/changes/chg');
  const failed = run(f.cwd, f.localEnv, ['merge', dir, 'T-01']);
  assert.equal(failed.status, 31, failed.out);
  const report = run(f.cwd, f.localEnv, ['plan', dir, '--json']);
  assert.equal(report.status, 0, report.out);
  assert.equal(JSON.parse(report.stdout).dispatch[0].action, 'dispatch-worker');
});

test('plan forwards explicit other change label before its integration branch exists', () => {
  const f = fixture();
  const agent = { id: 'other', name: '[Pipeline] gongbu FULL', status: 'running', cwd: f.cwd };
  const bin = path.join(f.cwd, '.fake-bin', 'paseo');
  fs.writeFileSync(bin, `#!/bin/sh\ncase " $* " in *" pipeline.change=chg "*) printf '[]' ;; *" pipeline.change=draft "*) printf '%s' '${JSON.stringify([agent])}' ;; *) printf '%s' '${JSON.stringify([agent])}' ;; esac\n`);
  const dir = path.join(f.cwd, 'openspec/changes/chg');
  let r = run(f.cwd, f.localEnv, ['plan', dir, '--json']);
  assert.equal(r.status, 3, r.out);
  r = run(f.cwd, f.localEnv, ['plan', dir, '--json', '--other-change', 'draft']);
  assert.equal(r.status, 0, r.out);
  assert.equal(JSON.parse(r.stdout).dispatch[0].task, 'T-01');
  fs.writeFileSync(bin, `#!/bin/sh\ncase " $* " in *" --label "*) printf '[]' ;; *) printf '%s' '${JSON.stringify([agent])}' ;; esac\n`);
  r = run(f.cwd, f.localEnv, ['plan', dir, '--json', '--other-change', 'draft']);
  assert.equal(r.status, 3, r.out);
});

test('plan strictly parses equals form and rejects unknown or missing options', () => {
  const f = fixture();
  const agent = { id: 'other', name: '[Pipeline] gongbu FULL', status: 'idle', cwd: '/missing/pipeline-worktree' };
  fs.writeFileSync(path.join(f.cwd, '.fake-bin', 'paseo'), `#!/bin/sh\ncase " $* " in *" pipeline.change=chg "*) printf '[]' ;; *" pipeline.change=draft "*) printf '%s' '${JSON.stringify([agent])}' ;; *) printf '%s' '${JSON.stringify([agent])}' ;; esac\n`);
  const dir = path.join(f.cwd, 'openspec/changes/chg');
  let r = run(f.cwd, f.localEnv, ['plan', dir, '--json']);
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /--other-change/);
  r = run(f.cwd, f.localEnv, ['plan', dir, '--json', '--other-change=draft']);
  assert.equal(r.status, 0, r.out);
  for (const args of [['plan', dir, '--bogus'], ['plan', '--other-change', dir], ['plan', dir, '--worker-cap'], ['plan', dir, '--json=1'], ['plan', dir, '--other-change=']]) {
    r = run(f.cwd, f.localEnv, args);
    assert.equal(r.status, 2, `${args}: ${r.out}`);
  }
});

test('pending marker after completed merge does not trigger repeat or rewrite marker', () => {
  const f = fixture();
  const tip = implement(f.cwd, 'task/chg/T-01');
  const dir = path.join(f.cwd, 'openspec/changes/chg');
  assert.equal(run(f.cwd, f.localEnv, ['merge', dir, 'T-01']).status, 0);
  const object = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: f.cwd, env, input: JSON.stringify({ tip, status: 'pending' }), encoding: 'utf8' });
  git(f.cwd, 'update-ref', 'refs/pipeline/merge-failures/chg/T-01', object.stdout.trim());
  let r = run(f.cwd, f.localEnv, ['plan', dir, '--json']);
  assert.equal(r.status, 0, r.out);
  assert.ok(!JSON.parse(r.stdout).dispatch.some((item) => item.task === 'T-01'));
  r = run(f.cwd, f.localEnv, ['merge', dir, 'T-01']);
  assert.notEqual(r.status, 0);
  assert.match(r.out, /already Done/);
  assert.equal(git(f.cwd, 'rev-parse', 'refs/pipeline/merge-failures/chg/T-01'), object.stdout.trim());
});

test('merge driver forwards --allow-test-infra and releases only that gate', () => {
  const f = fixture();
  const tasks = path.join(f.cwd, 'openspec/changes/chg/tasks.md');
  fs.writeFileSync(tasks, fs.readFileSync(tasks, 'utf8').replace('Write scope: src,test', 'Write scope: src,test,vitest.config.ts'));
  git(f.cwd, 'add', 'openspec/changes/chg/tasks.md');
  git(f.cwd, 'commit', '-qm', 'extend test infrastructure scope');
  implement(f.cwd, 'task/chg/T-01');
  git(f.cwd, 'switch', '-q', 'task/chg/T-01');
  write(f.cwd, 'vitest.config.ts', 'export default {};\n');
  git(f.cwd, 'add', 'vitest.config.ts');
  git(f.cwd, 'commit', '-qm', `infra\n\nPipeline-Role: gongbu\nPipeline-Author: ${WORKER}`);
  git(f.cwd, 'switch', '-q', 'integration/chg');
  const dir = path.join(f.cwd, 'openspec/changes/chg');
  const denied = run(f.cwd, f.localEnv, ['merge', dir, 'T-01']);
  assert.equal(denied.status, 38, denied.out);
  assert.match(denied.out, /test infrastructure changes require human approval/);
  const approved = run(f.cwd, f.localEnv, ['merge', dir, 'T-01', '--allow-test-infra']);
  assert.equal(approved.status, 0, approved.out);
});

test('merge driver forwards both timeout forms and rejects unknown options', () => {
  for (const args of [['--timeout', '5000'], ['--timeout=5000']]) {
    const f = fixture();
    implement(f.cwd, 'task/chg/T-01');
    const dir = path.join(f.cwd, 'openspec/changes/chg');
    const result = run(f.cwd, f.localEnv, ['merge', dir, 'T-01', ...args]);
    assert.equal(result.status, 0, result.out);
  }
  const f = fixture();
  const dir = path.join(f.cwd, 'openspec/changes/chg');
  for (const args of [['--bogus'], ['--timeout'], ['--timeout=']]) {
    const result = run(f.cwd, f.localEnv, ['merge', dir, 'T-01', ...args]);
    assert.equal(result.status, 2, result.out);
  }
});

test('plan and status reject corrupt integration contracts rather than reporting a frontier', () => {
  for (const [name, mutate, expected] of [
    ['unknown Uses', (text) => text.replace('  - Write scope: src,test', '  - Uses: T-99\n  - Write scope: src,test'), /USES_UNKNOWN/],
    ['self Uses', (text) => text.replace('  - Write scope: src,test', '  - Uses: T-01\n  - Write scope: src,test'), /USES_UNKNOWN/],
    ['mixed cycle', (text) => text.replace('  - Write scope: src,test', '  - Uses: T-02\n  - Write scope: src,test'), /CYCLE/],
    ['invalid Done', (text) => text.replace('  - Write scope: src,test', '  - Done: corrupted\n  - Write scope: src,test'), /BAD_DONE_LINE/],
    ['missing scope', (text) => text.replace('  - Write scope: src,test\n', ''), /MISSING_SCOPE/],
    ['empty contract', () => '# Tasks\n', /EMPTY_TASKS/],
  ]) {
    const f = fixture();
    const dir = path.join(f.cwd, 'openspec/changes/chg');
    const file = path.join(dir, 'tasks.md');
    fs.writeFileSync(file, mutate(fs.readFileSync(file, 'utf8')));
    git(f.cwd, 'add', 'openspec/changes/chg/tasks.md');
    git(f.cwd, 'commit', '-qm', 'corrupt contract');
    for (const command of ['plan', 'status']) {
      const r = run(f.cwd, f.localEnv, [command, dir, '--json']);
      assert.equal(r.status, 3, `${name} ${command}: ${r.out}`);
      assert.match(r.stderr, expected, `${name} ${command}`);
      assert.equal(r.stdout, '', `${name} ${command}`);
    }
  }
});

test('plan and status accept historical Done review tags', () => {
  for (const review of ['worker', 'main-session', 'pass(94d49a23@fc5df03/51d53dc)']) {
    const f = fixture({ done: true });
    const dir = path.join(f.cwd, 'openspec/changes/chg');
    const file = path.join(dir, 'tasks.md');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('review=worker', `review=${review}`));
    git(f.cwd, 'add', 'openspec/changes/chg/tasks.md');
    git(f.cwd, 'commit', '--allow-empty', '-qm', 'legacy done');
    for (const command of ['plan', 'status']) {
      const r = run(f.cwd, f.localEnv, [command, dir, '--json']);
      assert.equal(r.status, 0, `${review} ${command}: ${r.out}`);
      const report = JSON.parse(r.stdout);
      if (command === 'plan') assert.deepEqual(report.dispatch.map((item) => item.task), ['T-02']);
      else assert.deepEqual(report.done, ['T-01']);
    }
  }
});

test('plan and status accept valid historical Uses references', () => {
  const f = fixture({ done: true });
  const dir = path.join(f.cwd, 'openspec/changes/chg');
  const file = path.join(dir, 'tasks.md');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('  - Depends on: T-01', '  - Uses: T-01'));
  git(f.cwd, 'add', 'openspec/changes/chg/tasks.md');
  git(f.cwd, 'commit', '-qm', 'historical Uses');
  for (const command of ['plan', 'status']) {
    const r = run(f.cwd, f.localEnv, [command, dir, '--json']);
    assert.equal(r.status, 0, `${command}: ${r.out}`);
    assert.doesNotThrow(() => JSON.parse(r.stdout));
  }
});
