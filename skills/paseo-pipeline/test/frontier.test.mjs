import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { frontier } from '../lib/frontier.mjs';

const root = path.resolve(import.meta.dirname, '..');
const task = (over = {}) => ({
  id: 'T-01', depends: [], uses: [], scope: [], reads: [], est: 'M', kind: null, review: 'standard', ...over,
});

const dag = [
  task({ id: 'T-00', kind: 'skeleton', review: 'mechanical', est: 'S', scope: ['src/iface.ts'] }),
  task({ id: 'T-01', depends: ['T-00'], scope: ['src/a.ts'], est: 'L' }),
  task({ id: 'T-02', depends: ['T-00'], scope: ['src/b.ts'], est: 'S' }),
  task({ id: 'T-03', uses: ['T-01'], scope: ['src/c.ts'], est: 'M' }),
  task({ id: 'T-04', depends: ['T-03'], scope: ['src/d.ts'], est: 'M' }),
];

test('fresh DAG dispatches the ready frontier in critical-path order and waits on deps', () => {
  const report = frontier(dag, { done: [] });
  assert.deepEqual(report.dispatch.map((item) => item.task), ['T-00']);
  assert.deepEqual(report.waiting.map((item) => item.task), ['T-01', 'T-02', 'T-03', 'T-04']);
  assert.deepEqual(report.waiting.find((item) => item.task === 'T-01').on, ['T-00']);
});

test('a Uses consumer dispatches once the skeleton is Done, before the producer finishes', () => {
  // T-03 Uses T-01, which is not a skeleton: its dispatch edge is only T-01's deps.
  const report = frontier(dag, { done: ['T-00'] });
  assert.deepEqual(report.dispatch.map((item) => item.task).sort(), ['T-01', 'T-02', 'T-03']);
  assert.deepEqual(report.waiting.map((item) => item.task), ['T-04']);
});

test('writer capacity limits slots instead of hiding the frontier', () => {
  const agents = [{ id: 'a1', role: 'gongbu', task: 'T-01', status: 'running' }];
  const branches = { 'T-01': { attempts: 1, implementationCommits: 1 } };
  const report = frontier(dag, { done: ['T-00'], agents, branches }, { writerCap: 2 });
  assert.equal(report.capacity.writers.used, 1);
  // One free writer slot goes to the longest remaining critical path, not the first id;
  // T-01's review is dispatched in parallel because reviewers have their own pool.
  assert.deepEqual(report.dispatch.map((item) => item.task), ['T-03', 'T-01']);
  assert.deepEqual(report.dispatch.map((item) => item.action), ['create-branch+dispatch-ceshi', 'dispatch-reviewer']);
  const full = frontier(dag, { done: ['T-00'], agents, branches }, { writerCap: 1 });
  assert.equal(full.capacity.writers.used, 1);
  assert.deepEqual(full.dispatch.map((item) => item.task), ['T-01']);
});

test('reviewer capacity holds new reviews but never blocks a writer', () => {
  const branches = {
    'T-01': { attempts: 1, implementationCommits: 1 },
    'T-02': { attempts: 1, implementationCommits: 1 },
  };
  const agents = [{ id: 'r1', role: 'anchasi', task: 'T-01', status: 'running' }];
  const report = frontier(dag, { done: ['T-00'], agents, branches }, { reviewerCap: 1 });
  assert.equal(report.capacity.reviewers.used, 1);
  assert.ok(!report.dispatch.some((item) => item.action === 'dispatch-reviewer' && item.task === 'T-02'));
  assert.ok(report.dispatch.some((item) => item.task === 'T-03' && item.action === 'create-branch+dispatch-ceshi'));
});

test('a mechanical or deferred implementation is dispatched for merge, not review', () => {
  const tasks = [
    task({ id: 'T-01', review: 'mechanical' }),
    task({ id: 'T-02', review: 'deferred' }),
  ];
  const branches = {
    'T-01': { attempts: 1, implementationCommits: 1 },
    'T-02': { attempts: 1, implementationCommits: 1 },
  };
  const report = frontier(tasks, { done: [], branches });
  assert.deepEqual(report.dispatch.map((item) => item.action), ['merge', 'merge']);
});

test('scope overlap with a task under review holds the pair, not the whole frontier', () => {
  const overlapping = [
    task({ id: 'T-01', scope: ['src/shared/a.ts'], est: 'L' }),
    task({ id: 'T-02', scope: ['src/shared'], est: 'S' }),
    task({ id: 'T-03', scope: ['src/other.ts'], est: 'S' }),
  ];
  const agents = [{ id: 'r1', role: 'anchasi', task: 'T-01', status: 'running' }];
  const branches = { 'T-01': { attempts: 1, implementationCommits: 1 } };
  const report = frontier(overlapping, { done: [], branches, agents });
  assert.ok(!report.dispatch.some((item) => item.task === 'T-02'));
  assert.deepEqual(report.dispatch.map((item) => item.task), ['T-03']);
});

test('branch attempts at the cap are blocked and stop dispatch', () => {
  const report = frontier(dag, { done: ['T-00'], branches: { 'T-01': { attempts: 3, implementationCommits: 2 } } });
  assert.deepEqual(report.blocked, [{ task: 'T-01', kind: 'BLOCKED_ATTEMPTS', reason: '3 branches; cap is 3' }]);
  assert.ok(!report.dispatch.some((item) => item.task === 'T-01'));
});

test('pending permission and stale labels surface as attention', () => {
  const agents = [
    { id: 'a1', role: 'gongbu', task: 'T-01', status: 'running', pendingPermissions: true },
    { id: 'a2', role: 'anchasi', task: 'T-99', status: 'running' },
  ];
  const report = frontier(dag, { done: [], agents });
  assert.deepEqual(report.attention.map((item) => item.kind).sort(), ['PENDING_PERMISSION', 'STALE_LABEL']);
});

test('a dead idle agent with no result is attention, a live one is not', () => {
  const now = new Date('2026-01-01T12:00:00Z');
  const idle = { id: 'a1', role: 'gongbu', task: 'T-01', status: 'idle', updatedAt: '2026-01-01T11:00:00Z' };
  assert.deepEqual(frontier(dag, { done: [], agents: [idle], now }).attention.map((item) => item.kind), ['IDLE_NO_RESULT']);
  const fresh = { ...idle, updatedAt: '2026-01-01T11:59:00Z' };
  assert.deepEqual(frontier(dag, { done: [], agents: [fresh], now }).attention, []);
});

test('frontier output is deterministic', () => {
  const args = [{ done: ['T-00'], branches: { 'T-01': { attempts: 1, implementationCommits: 0 } } }];
  assert.deepEqual(frontier(dag, ...args), frontier(dag, ...args));
});

// ---- CLI ----
function repo(tasksMarkdown) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frontier-'));
  fs.mkdirSync(path.join(dir, 'openspec', 'changes', 'chg'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'openspec/changes/chg/tasks.md'), tasksMarkdown);
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  git('add', '.'); git('commit', '-qm', 'contract');
  return { dir, git };
}
function fakePaseo(agents, inspect = {}) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'frontier-bin-'));
  const payload = Buffer.from(JSON.stringify(agents)).toString('base64');
  const inspectJson = Buffer.from(JSON.stringify(inspect)).toString('base64');
  fs.writeFileSync(path.join(bin, 'paseo'), `#!/bin/sh\nif [ "$1" = inspect ]; then printf '%s' '${inspectJson}' | base64 -d; else printf '%s' '${payload}' | base64 -d; fi\n`);
  fs.chmodSync(path.join(bin, 'paseo'), 0o755);
  return { ...process.env, PATH: `${bin}:${process.env.PATH}` };
}

const cliTasks = `- [ ] 1.1 T-01 start
  - Write scope: src/a.ts
  - Verify with: node --test test/a.test.mjs
- [ ] 1.2 T-02 later
  - Depends on: T-01
  - Write scope: src/b.ts
  - Verify with: node --test test/b.test.mjs
`;

test('CLI prints the ready task and waits on the dependent', () => {
  const { dir } = repo(cliTasks);
  const changeDir = path.join(dir, 'openspec/changes/chg');
  const result = spawnSync('node', [path.join(root, 'next-actions.mjs'), changeDir, '--json'], {
    encoding: 'utf8', env: fakePaseo([]),
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.dispatch.map((item) => item.task), ['T-01']);
  assert.deepEqual(report.waiting, [{ task: 'T-02', on: ['T-01'] }]);
});

test('CLI recognises a Red-only branch and asks for the implementer', () => {
  const { dir, git } = repo(cliTasks);
  git('checkout', '-q', '-b', 'task/chg/T-01');
  fs.writeFileSync(path.join(dir, 'red.txt'), 'x');
  git('add', '.'); git('commit', '-qm', 'test(T-01): red\n\nPipeline-Role: ceshi\nPipeline-Author: 00000000-0000-4000-8000-000000000001');
  const changeDir = path.join(dir, 'openspec/changes/chg');
  const result = spawnSync('node', [path.join(root, 'next-actions.mjs'), changeDir, '--json'], {
    encoding: 'utf8', env: fakePaseo([]),
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.dispatch, [{ task: 'T-01', action: 'dispatch-implementer', reason: 'Red commit present; no implementation commit yet' }]);
});

test('CLI exits 3 when Paseo is unreadable', () => {
  const { dir } = repo(cliTasks);
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'frontier-bin-'));
  fs.writeFileSync(path.join(bin, 'paseo'), '#!/bin/sh\nexit 1\n');
  fs.chmodSync(path.join(bin, 'paseo'), 0o755);
  const result = spawnSync('node', [path.join(root, 'next-actions.mjs'), path.join(dir, 'openspec/changes/chg')], {
    encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /cannot read Paseo state/);
});
