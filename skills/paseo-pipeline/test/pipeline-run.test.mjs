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

test('a change directory without tasks.md is unreadable state (exit 3)', () => {
  const f = fixture();
  const r = run(f.cwd, f.localEnv, ['status', path.join(f.cwd, 'openspec/changes/nope')]);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /no tasks.md/);
});
