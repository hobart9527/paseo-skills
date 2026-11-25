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

test('human-readable plan lists active workers and dependency-chain summaries', () => {
  const f = fixture();
  const agent = { id: 'worker-id', name: '[Pipeline] gongbu T-01', status: 'running', cwd: f.cwd };
  fs.writeFileSync(path.join(f.cwd, '.fake-bin', 'paseo'), `#!/bin/sh\nif [ "$1" = inspect ]; then printf '%s' '${JSON.stringify({ Id: agent.id, Name: agent.name, Status: 'running', PendingPermissions: [] })}'; else printf '%s' '${JSON.stringify([agent])}'; fi\n`);
  const dir = path.join(f.cwd, 'openspec/changes/chg');
  const result = run(f.cwd, f.localEnv, ['plan', dir]);
  assert.equal(result.status, 0, result.out);
  assert.match(result.stdout, /RUNNING T-01: gongbu worker-id \(running\)/);
  assert.match(result.stdout, /WAIT T-02: on T-01/);
  assert.match(result.stdout, /dependency chain: T-01/);
});

test('human-readable plan prints real dependency paths for fan-in and diamond waits', () => {
  const f = fixture();
  const dir = path.join(f.cwd, 'openspec/changes/chg');
  const tasksFile = path.join(dir, 'tasks.md');
  const task = (number, id, dependency = '') => `- [ ] 1.${number} ${id} task\n`
    + `${dependency ? `  - Depends on: ${dependency}\n` : ''}`
    + `  - Write scope: src/${id},test/${id}\n  - Verify with: node --test test/${id}.test.mjs\n`;
  const tasks = (items) => items.map((item) => task(...item)).join('');
  const cases = [
    {
      name: 'fan-in',
      tasks: tasks([[1, 'T-01'], [2, 'T-02', 'T-01'], [3, 'T-03', 'T-01']]),
      paths: ['T-01 → T-02', 'T-01 → T-03'],
    },
    {
      name: 'linear chain',
      tasks: tasks([[1, 'T-01'], [2, 'T-02', 'T-01'], [3, 'T-03', 'T-02']]),
      paths: ['T-01 → T-02 → T-03'],
    },
    {
      name: 'diamond',
      tasks: tasks([[1, 'T-01'], [2, 'T-02', 'T-01'], [3, 'T-03', 'T-01'], [4, 'T-04', 'T-02,T-03']]),
      paths: ['T-01 → T-02 → T-04', 'T-01 → T-03 → T-04'],
    },
  ];
  for (const item of cases) {
    fs.writeFileSync(tasksFile, item.tasks);
    git(f.cwd, 'add', 'openspec/changes/chg/tasks.md');
    git(f.cwd, 'commit', '-qm', `scenario ${item.name}`);
    const result = run(f.cwd, f.localEnv, ['plan', dir]);
    assert.equal(result.status, 0, result.out);
    for (const expected of item.paths) assert.ok(result.stdout.includes(expected), `${item.name}: missing ${expected}\n${result.stdout}`);
  }
});

test('plan and status flag forged Done source against first-parent merge trailers', () => {
  const f = fixture();
  implement(f.cwd, 'task/chg/T-01');
  const dir = path.join(f.cwd, 'openspec/changes/chg');
  assert.equal(run(f.cwd, f.localEnv, ['merge', dir, 'T-01']).status, 0);
  let result = run(f.cwd, f.localEnv, ['plan', dir, '--json']);
  assert.deepEqual(JSON.parse(result.stdout).attention, []);
  const tasks = path.join(dir, 'tasks.md');
  fs.writeFileSync(tasks, fs.readFileSync(tasks, 'utf8').replace(/Done: source=[0-9a-f]{7}/, 'Done: source=deadbee'));
  git(f.cwd, 'add', 'openspec/changes/chg/tasks.md');
  git(f.cwd, 'commit', '-qm', 'forge done source');
  for (const command of ['plan', 'status']) {
    result = run(f.cwd, f.localEnv, [command, dir, '--json']);
    assert.equal(result.status, 0, result.out);
    const report = JSON.parse(result.stdout);
    assert.ok(report.attention.some((item) => item.kind === 'DONE_UNVERIFIED' && item.task === 'T-01'));
  }
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

// SCEN-HOOK-01: installation replaces the whole hooks directory, so an existing setup would be
// silently displaced. It must refuse, name what it found, leave everything unchanged, and need an
// explicit --replace-hooks.
test('SCEN-HOOK-01 install-hook refuses to displace an existing core.hooksPath', () => {
  const f = fixture();
  git(f.cwd, 'config', 'core.hooksPath', '.husky');
  const refused = run(f.cwd, f.localEnv, ['install-hook', f.cwd]);
  assert.notEqual(refused.status, 0, refused.out);
  assert.match(refused.out, /\.husky/);
  assert.match(refused.out, /--replace-hooks/);
  // Nothing moved: the refusal happens before any write.
  assert.equal(git(f.cwd, 'config', '--get', 'core.hooksPath'), '.husky');
  assert.notEqual(spawnSync('git', ['config', '--get', 'extensions.worktreeConfig'], { cwd: f.cwd, env, encoding: 'utf8' }).stdout.trim(), 'true');
  // The explicit flag is the approval, and then the pipeline hooks win.
  const replaced = run(f.cwd, f.localEnv, ['install-hook', '--replace-hooks', f.cwd]);
  assert.equal(replaced.status, 0, replaced.out);
  assert.match(git(f.cwd, 'config', '--worktree', '--get', 'core.hooksPath'), /paseo-pipeline\/hooks\/git$/);
});

// A sample file ships with `git init`; replacing the directory would be no loss, so installation
// must stay non-interactive there (SCEN-HOOK-02).
test('SCEN-HOOK-02 an empty hooks directory still installs, and a live hook is named', () => {
  const f = fixture();
  const hooks = path.join(f.cwd, '.git', 'hooks');
  assert.ok(fs.existsSync(path.join(hooks, 'commit-msg.sample')));
  const clean = run(f.cwd, f.localEnv, ['install-hook', f.cwd]);
  assert.equal(clean.status, 0, clean.out);
  // Idempotent: the installed path is the pipeline's own, so a second run displaces nothing.
  assert.equal(run(f.cwd, f.localEnv, ['install-hook', f.cwd]).status, 0);

  const g = fixture();
  write(g.cwd, '.git/hooks/pre-commit', '#!/bin/sh\nexit 0\n');
  fs.chmodSync(path.join(g.cwd, '.git/hooks/pre-commit'), 0o755);
  const refused = run(g.cwd, g.localEnv, ['install-hook', g.cwd]);
  assert.notEqual(refused.status, 0, refused.out);
  assert.match(refused.out, /pre-commit/);
  assert.match(refused.out, /--replace-hooks/);
  // A non-executable leftover is not a hook git would run; the name alone is not a conflict.
  const h = fixture();
  write(h.cwd, '.git/hooks/pre-commit', '#!/bin/sh\nexit 0\n');
  fs.chmodSync(path.join(h.cwd, '.git/hooks/pre-commit'), 0o644);
  assert.equal(run(h.cwd, h.localEnv, ['install-hook', h.cwd]).status, 0);
});

// SCEN-PJ-05: a refusal must name every object it would displace, in the order the approval will
// replace them, before the refusal sentence — a human reading stderr knows exactly what is lost.
test('SCEN-PJ-05 refusal lists each displaced object first, on stderr', () => {
  const f = fixture();
  git(f.cwd, 'config', 'core.hooksPath', '.husky');
  write(f.cwd, '.git/hooks/pre-commit', '#!/bin/sh\nexit 0\n');
  fs.chmodSync(path.join(f.cwd, '.git/hooks/pre-commit'), 0o755);
  const preCommit = path.join(f.cwd, '.git', 'hooks', 'pre-commit');

  const refused = run(f.cwd, f.localEnv, ['install-hook', f.cwd]);
  assert.notEqual(refused.status, 0, refused.out);
  // Stream placement is part of the contract: audit lines belong on stderr with the refusal.
  assert.equal(refused.stdout, '');
  const lines = refused.stderr.split('\n');
  const displacedAt = lines
    .map((line, index) => (line.startsWith('displaced: ') ? index : -1))
    .filter((index) => index >= 0);
  const refusalAt = lines.findIndex((line) => line.startsWith('[pipeline-run]') && line.includes('--replace-hooks'));
  assert.ok(refusalAt >= 0, refused.stderr);
  // Exactly the two objects, both before the refusal sentence, in array order.
  assert.deepEqual(
    displacedAt.map((index) => lines[index]),
    [`displaced: core.hooksPath=.husky`, `displaced: ${preCommit}`],
  );
  assert.ok(displacedAt.every((index) => index < refusalAt), refused.stderr);
  // The refusal is before any write.
  assert.equal(git(f.cwd, 'config', '--get', 'core.hooksPath'), '.husky');
  assert.notEqual(spawnSync('git', ['config', '--get', 'extensions.worktreeConfig'], { cwd: f.cwd, env, encoding: 'utf8' }).stdout.trim(), 'true');
});

// SCEN-PJ-06: with the flag, the same objects are reported as replaced, on stdout, before the
// install confirmation — and only because the write actually succeeded.
test('SCEN-PJ-06 approved replace lists each replaced object, on stdout', () => {
  const f = fixture();
  git(f.cwd, 'config', 'core.hooksPath', '.husky');
  write(f.cwd, '.git/hooks/pre-commit', '#!/bin/sh\nexit 0\n');
  fs.chmodSync(path.join(f.cwd, '.git/hooks/pre-commit'), 0o755);
  const preCommit = path.join(f.cwd, '.git', 'hooks', 'pre-commit');

  const replaced = run(f.cwd, f.localEnv, ['install-hook', '--replace-hooks', f.cwd]);
  assert.equal(replaced.status, 0, replaced.out);
  const lines = replaced.stdout.split('\n');
  const replacedAt = lines
    .map((line, index) => (line.startsWith('replaced: ') ? index : -1))
    .filter((index) => index >= 0);
  const installedAt = lines.indexOf(`hook installed: ${f.cwd}`);
  assert.ok(installedAt >= 0, replaced.stdout);
  assert.deepEqual(
    replacedAt.map((index) => lines[index]),
    [`replaced: core.hooksPath=.husky`, `replaced: ${preCommit}`],
  );
  assert.ok(replacedAt.every((index) => index < installedAt), replaced.stdout);
  // Replaced means replaced: the audit lines do not appear on the refusal stream.
  assert.equal(replaced.stderr, '');
  assert.match(git(f.cwd, 'config', '--worktree', '--get', 'core.hooksPath'), /paseo-pipeline\/hooks\/git$/);
});

// SCEN-PJ-07: nothing to displace means nothing to audit — no stray lines on either stream, with
// or without the flag, and repeated installs stay quiet.
test('SCEN-PJ-07 a fresh hooks dir prints no displaced or replaced lines', () => {
  const f = fixture();
  assert.ok(fs.existsSync(path.join(f.cwd, '.git', 'hooks', 'commit-msg.sample')));
  const auditLines = (out) => out.split('\n').filter((line) => line.startsWith('displaced: ') || line.startsWith('replaced: '));

  const first = run(f.cwd, f.localEnv, ['install-hook', f.cwd]);
  assert.equal(first.status, 0, first.out);
  assert.deepEqual(auditLines(`${first.stdout}${first.stderr}`), []);
  const second = run(f.cwd, f.localEnv, ['install-hook', f.cwd]);
  assert.equal(second.status, 0, second.out);
  assert.deepEqual(auditLines(`${second.stdout}${second.stderr}`), []);
  const flagged = run(f.cwd, f.localEnv, ['install-hook', '--replace-hooks', f.cwd]);
  assert.equal(flagged.status, 0, flagged.out);
  assert.deepEqual(auditLines(`${flagged.stdout}${flagged.stderr}`), []);
  assert.ok(flagged.stdout.split('\n').includes(`hook installed: ${f.cwd}`), flagged.stdout);
});

// The audit line states a fact: no replacement is reported when the write that would perform it
// fails.
test('a failed install reports no replaced lines', () => {
  const f = fixture();
  git(f.cwd, 'config', 'core.hooksPath', '.husky');
  // A held lock makes the config write fail the way a concurrent git process would.
  fs.writeFileSync(path.join(f.cwd, '.git', 'config.lock'), 'held');
  const r = run(f.cwd, f.localEnv, ['install-hook', '--replace-hooks', f.cwd]);
  assert.notEqual(r.status, 0, r.out);
  assert.doesNotMatch(r.stdout, /^replaced: /m, r.stdout);
  assert.doesNotMatch(r.stdout, /hook installed/, r.stdout);
  assert.match(r.stderr, /cannot (enable worktreeConfig|set core\.hooksPath)/);
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

test('prepare-task invoked from integration worktree defaults .claude/worktrees under primary checkout', () => {
  const f = fixture({ done: true });
  git(f.cwd, 'switch', '-q', 'main');
  const intWt = path.join(path.dirname(f.cwd), `${path.basename(f.cwd)}-int`);
  git(f.cwd, 'worktree', 'add', '-q', intWt, 'integration/chg');
  const intChangeDir = path.join(intWt, 'openspec/changes/chg');
  const r = run(intWt, f.localEnv, ['prepare-task', intChangeDir, 'T-02', '--json']);
  assert.equal(r.status, 0, r.out);
  const out = JSON.parse(r.stdout);
  assert.ok(out.worktree.startsWith(fs.realpathSync(f.cwd)), `expected primary checkout root, got ${out.worktree}`);
  assert.equal(fs.existsSync(path.join(intWt, '.claude')), false);
});

test('prepare-task --new-attempt increments -a2/-a3, blocks -a4 at exit 37 without --allow-attempt-over, and worker-check checks infra + drift + merge-base', () => {
  const f = fixture({ done: false });
  const telOff = { ...f.localEnv, PIPELINE_TELEMETRY: 'off' };
  const dir = path.join(f.cwd, 'openspec/changes/chg');
  const a1 = JSON.parse(run(f.cwd, telOff, ['prepare-task', dir, 'T-01', '--json']).stdout);
  assert.equal(a1.branch, 'task/chg/T-01');
  const a2 = JSON.parse(run(f.cwd, telOff, ['prepare-task', dir, 'T-01', '--new-attempt', '--json']).stdout);
  assert.equal(a2.branch, 'task/chg/T-01-a2');
  assert.notEqual(a2.worktree, a1.worktree);
  const a3 = JSON.parse(run(f.cwd, telOff, ['prepare-task', dir, 'T-01', '--new-attempt', '--json']).stdout);
  assert.equal(a3.branch, 'task/chg/T-01-a3');

  const blocked4 = run(f.cwd, telOff, ['prepare-task', dir, 'T-01', '--new-attempt', '--json']);
  assert.equal(blocked4.status, 37, blocked4.out);
  const allowed4 = run(f.cwd, telOff, ['prepare-task', dir, 'T-01', '--new-attempt', '--allow-attempt-over', '--json']);
  assert.equal(allowed4.status, 0, allowed4.out);
  assert.equal(JSON.parse(allowed4.stdout).branch, 'task/chg/T-01-a4');

  // worker-check standalone: without integration/ branch uses merge-base(main, HEAD), checks auditTestInfra & main drift
  const wRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-standalone-'));
  write(wRoot, 'seed/outside.txt', 'root file\n');
  git(wRoot, 'init', '-q', '-b', 'main');
  git(wRoot, 'add', '.'); git(wRoot, 'commit', '-qm', 'root seed');
  write(wRoot, 'openspec/changes/wc/tasks.md', '- [ ] 1.1 T-01 work\n  - Write scope: src,test\n  - Verify with: node --test test/a.test.mjs\n');
  git(wRoot, 'add', '.'); git(wRoot, 'commit', '-qm', 'contract');
  git(wRoot, 'switch', '-qc', 'feat/wc-t1');
  write(wRoot, 'src/a.txt', 'a');
  write(wRoot, 'test/a.test.mjs', PASSING_TEST);
  git(wRoot, 'add', '.');
  git(wRoot, 'commit', '-qm', `impl\n\nPipeline-Role: gongbu\nPipeline-Author: ${WORKER}`);

  const workerCheckScript = fileURLToPath(new URL('../worker-check.mjs', import.meta.url));
  const runWc = (args = []) => spawnSync(process.execPath, [workerCheckScript, path.join(wRoot, 'openspec/changes/wc'), 'T-01', ...args], {
    cwd: wRoot,
    encoding: 'utf8',
    env: { ...env, PIPELINE_TELEMETRY: 'off' },
  });
  assert.equal(runWc().status, 0, 'merge-base(main, HEAD) must ignore earlier root commit seed/outside.txt');

  // test/setup/* triggers auditTestInfra exit 38 unless --allow-test-infra
  write(wRoot, 'test/setup/helper.mjs', 'export const h = 1;\n');
  git(wRoot, 'add', 'test/setup/helper.mjs');
  git(wRoot, 'commit', '-qm', `infra\n\nPipeline-Role: gongbu\nPipeline-Author: ${WORKER}`);
  assert.equal(runWc().status, 38);
  assert.equal(runWc(['--allow-test-infra']).status, 0);

  // main drift overlapping task scope fails exit 34
  git(wRoot, 'switch', '-q', 'main');
  write(wRoot, 'src/concurrent.txt', 'drift\n');
  git(wRoot, 'add', 'src/concurrent.txt');
  git(wRoot, 'commit', '-qm', 'main drift on src');
  git(wRoot, 'switch', '-q', 'feat/wc-t1');
  const driftRes = runWc(['--allow-test-infra']);
  assert.equal(driftRes.status, 34, driftRes.stderr);
  assert.match(driftRes.stderr, /BASE_DRIFT/);
});

test('escalate-tier2 losslessly migrates modified, staged, deleted, and untracked changes to a linked worktree and cleans primary checkout', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-escalate-'));
  const root = path.join(dir, 'repo');
  const wt = path.join(dir, 'repo-wt-fix-auth');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 't@t');
  git(root, 'config', 'user.name', 't');
  write(root, 'src/keep.mjs', 'export const keep = 1;\n');
  write(root, 'src/drop.mjs', 'export const drop = 1;\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'seed');

  // Create mixed dirty state on primary checkout: modified tracked, staged new, deleted tracked, and nested untracked.
  write(root, 'src/keep.mjs', 'export const keep = 2;\n');
  write(root, 'src/staged.mjs', 'export const staged = true;\n');
  git(root, 'add', 'src/staged.mjs');
  fs.rmSync(path.join(root, 'src/drop.mjs'));
  write(root, 'tmp-notes/scratch.txt', 'untracked note\n');

  const res = spawnSync(process.execPath, [script, 'escalate-tier2', 'fix-auth', '--cwd', root, '--json'], {
    encoding: 'utf8',
    env: { ...env, PIPELINE_TELEMETRY: 'off' },
  });
  assert.equal(res.status, 0, res.stderr + res.stdout);
  const out = JSON.parse(res.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.branch, 'feat/fix-auth');
  assert.equal(out.worktree, fs.realpathSync(wt));
  assert.deepEqual(out.migratedFiles, ['src/keep.mjs', 'src/staged.mjs', 'tmp-notes/scratch.txt']);
  assert.deepEqual(out.deletedFiles, ['src/drop.mjs']);

  // Primary checkout is clean at HEAD with untracked dir cleaned up
  assert.equal(git(root, 'status', '--porcelain=v1'), '');
  assert.equal(fs.readFileSync(path.join(root, 'src/keep.mjs'), 'utf8'), 'export const keep = 1;\n');
  assert.equal(fs.existsSync(path.join(root, 'src/drop.mjs')), true);
  assert.equal(fs.existsSync(path.join(root, 'tmp-notes')), false);

  // Linked worktree has all migrated modifications/untracked files and deletions preserved
  assert.equal(fs.readFileSync(path.join(wt, 'src/keep.mjs'), 'utf8'), 'export const keep = 2;\n');
  assert.equal(fs.readFileSync(path.join(wt, 'src/staged.mjs'), 'utf8'), 'export const staged = true;\n');
  assert.equal(fs.readFileSync(path.join(wt, 'tmp-notes/scratch.txt'), 'utf8'), 'untracked note\n');
  assert.equal(fs.existsSync(path.join(wt, 'src/drop.mjs')), false);

  // Running escalate-tier2 inside a linked worktree is refused (exit 2)
  const nested = spawnSync(process.execPath, [script, 'escalate-tier2', 'again', '--cwd', wt, '--json'], {
    encoding: 'utf8',
    env: { ...env, PIPELINE_TELEMETRY: 'off' },
  });
  assert.equal(nested.status, 2);
  assert.match(nested.stderr, /already in linked worktree/);
});

test('escalate-tier2 --into migrates dirty primary changes into an existing clean worktree and tier2-merge verifies, checks review, syncs drift, and fast-forwards main', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-t2-seam-'));
  const root = path.join(dir, 'repo');
  const wt = path.join(dir, 'repo-wt-enter');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 't@t');
  git(root, 'config', 'user.name', 't');
  write(root, 'package.json', JSON.stringify({ name: 't2-merge-app', type: 'module' }));
  write(root, 'src/app.mjs', 'export const val = () => 1;\n');
  write(root, 'src/drop.mjs', 'export const drop = true;\n');
  write(root, 'test/app.test.mjs', "import test from 'node:test'; import assert from 'node:assert/strict'; import { val } from '../src/app.mjs'; test('val', () => { assert.equal(val(), 1); });\n");
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'init');

  // Simulate EnterWorktree creating a clean linked worktree first, while primary still holds dirty edits
  git(root, 'worktree', 'add', '-q', '-b', 'feat/t2-enter', wt);
  write(root, 'src/app.mjs', 'export const val = () => 2;\n');
  write(root, 'test/app.test.mjs', "import test from 'node:test'; import assert from 'node:assert/strict'; import { val } from '../src/app.mjs'; test('val', () => { assert.equal(val(), 2); });\n");
  fs.rmSync(path.join(root, 'src/drop.mjs'));
  write(root, 'notes/todo.txt', 'migrate me\n');

  // --into with primary checkout rejected
  const badTarget = spawnSync(process.execPath, [script, 'escalate-tier2', '--into', root, '--cwd', root, '--json'], {
    encoding: 'utf8',
    env: { ...env, PIPELINE_TELEMETRY: 'off' },
  });
  assert.equal(badTarget.status, 2);

  // Pull dirty primary changes from inside the existing clean worktree (`--into .`)
  const intoRes = spawnSync(process.execPath, [script, 'escalate-tier2', '--into', '.', '--cwd', wt, '--json'], {
    encoding: 'utf8',
    env: { ...env, PIPELINE_TELEMETRY: 'off' },
  });
  assert.equal(intoRes.status, 0, intoRes.stderr + intoRes.stdout);
  const intoJson = JSON.parse(intoRes.stdout);
  assert.equal(intoJson.ok, true);
  assert.equal(intoJson.mode, 'into');
  assert.equal(intoJson.branch, 'feat/t2-enter');
  assert.equal(git(root, 'status', '--porcelain=v1'), '');
  assert.equal(fs.readFileSync(path.join(wt, 'src/app.mjs'), 'utf8'), 'export const val = () => 2;\n');
  assert.equal(fs.existsSync(path.join(wt, 'src/drop.mjs')), false);
  assert.equal(fs.readFileSync(path.join(wt, 'notes/todo.txt'), 'utf8'), 'migrate me\n');

  // Commit in worktree; tier2-merge must refuse before tier2-verify receipt exists
  git(wt, 'add', '.');
  git(wt, 'commit', '-qm', 'feat impl');
  const noReceipt = spawnSync(process.execPath, [script, 'tier2-merge', 'feat/t2-enter', '--cwd', root, '--json'], {
    encoding: 'utf8',
    env: { ...env, PIPELINE_TELEMETRY: 'off' },
  });
  assert.equal(noReceipt.status, 3);
  assert.match(noReceipt.stderr, /tier2-verify/);

  // Run tier2-verify in worktree (writes receipt)
  const t2v = spawnSync(process.execPath, [script, 'tier2-verify', 'main', '--verify', 'node --test test/app.test.mjs', '--cwd', wt, '--json'], {
    encoding: 'utf8',
    env: { ...env, PIPELINE_TELEMETRY: 'off' },
  });
  assert.equal(t2v.status, 0, t2v.stderr + t2v.stdout);

  // Add a risky commit, verify again (REVIEW_REQUIRED), ensure tier2-merge refuses without review signoff
  write(wt, 'src/auth/token.mjs', 'export const check = () => true;\n');
  git(wt, 'add', '.');
  git(wt, 'commit', '-qm', 'add auth module');
  const t2vRisk = spawnSync(process.execPath, [script, 'tier2-verify', 'main', '--verify', 'node --test test/app.test.mjs', '--cwd', wt, '--json'], {
    encoding: 'utf8',
    env: { ...env, PIPELINE_TELEMETRY: 'off' },
  });
  assert.equal(t2vRisk.status, 0, t2vRisk.stderr + t2vRisk.stdout);
  assert.equal(JSON.parse(t2vRisk.stdout).verdict, 'REVIEW_REQUIRED');

  const noReview = spawnSync(process.execPath, [script, 'tier2-merge', 'feat/t2-enter', '--cwd', root, '--json'], {
    encoding: 'utf8',
    env: { ...env, PIPELINE_TELEMETRY: 'off' },
  });
  assert.equal(noReview.status, 3);
  assert.match(noReview.stderr, /Tier 2 review signoff/);

  // Record PASS signoff, also advance main with unrelated non-conflicting commit to exercise drift-sync + post-sync Verify
  const rec = spawnSync(process.execPath, [script, 'record-review', '--mode', 'tier2', '--verdict', 'PASS', '--reviewer', 'anchasi-t2', '--cwd', wt, '--json'], {
    encoding: 'utf8',
    env: { ...env, PIPELINE_TELEMETRY: 'off' },
  });
  assert.equal(rec.status, 0, rec.stderr + rec.stdout);

  write(root, 'README.md', '# concurrent main commit\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-qm', 'main advances');

  // If post-sync verify fails, exit 20 and main must NOT move
  const mainShaBefore = git(root, 'rev-parse', 'HEAD');
  const failDrift = spawnSync(process.execPath, [script, 'tier2-merge', 'feat/t2-enter', '--verify', 'node -e "process.exit(1)"', '--cwd', root, '--json'], {
    encoding: 'utf8',
    env: { ...env, PIPELINE_TELEMETRY: 'off' },
  });
  assert.equal(failDrift.status, 20, failDrift.stderr + failDrift.stdout);
  assert.equal(git(root, 'rev-parse', 'HEAD'), mainShaBefore, 'main must stay unchanged on post-sync Verify failure');

  // Re-run tier2-merge cleanly using preserved receipt commands -> syncs pending verify and fast-forwards main
  const okMerge = spawnSync(process.execPath, [script, 'tier2-merge', 'feat/t2-enter', '--cwd', root, '--json'], {
    encoding: 'utf8',
    env: { ...env, PIPELINE_TELEMETRY: 'off' },
  });
  assert.equal(okMerge.status, 0, okMerge.stderr + okMerge.stdout);
  const mergeJson = JSON.parse(okMerge.stdout);
  assert.equal(mergeJson.ok, true);
  assert.equal(mergeJson.driftedSynced, true);
  assert.equal(mergeJson.driftVerified, true);
  assert.equal(mergeJson.rollbackSha, mainShaBefore);
  assert.equal(mergeJson.driftVerifyResults.length, 1);
  assert.equal(fs.readFileSync(path.join(root, 'src/app.mjs'), 'utf8'), 'export const val = () => 2;\n');
});
