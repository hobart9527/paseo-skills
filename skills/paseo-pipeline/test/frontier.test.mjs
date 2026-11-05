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
  assert.deepEqual(report.dispatch.map((item) => item.action), ['create-branch+dispatch-worker']);
  assert.deepEqual(report.waiting.map((item) => item.task), ['T-01', 'T-02', 'T-03', 'T-04']);
  assert.deepEqual(report.waiting.find((item) => item.task === 'T-01').on, ['T-00']);
});

test('a Uses consumer dispatches once the skeleton is Done, before the producer finishes', () => {
  const report = frontier(dag, { done: ['T-00'] });
  assert.deepEqual(report.dispatch.map((item) => item.task).sort(), ['T-01', 'T-02', 'T-03']);
  assert.ok(report.dispatch.every((item) => item.action === 'create-branch+dispatch-worker'));
  assert.deepEqual(report.waiting.map((item) => item.task), ['T-04']);
});

test('worker capacity limits slots instead of hiding the frontier', () => {
  const agents = [{ id: 'a1', role: 'gongbu', task: 'T-01', status: 'running' }];
  const branches = { 'T-01': { attempts: 1, implementationCommits: 1 } };
  const report = frontier(dag, { done: ['T-00'], agents, branches }, { workerCap: 2 });
  assert.equal(report.capacity.workers.used, 1);
  assert.deepEqual(report.dispatch.map((item) => item.task), ['T-03']);
  assert.deepEqual(report.dispatch.map((item) => item.action), ['create-branch+dispatch-worker']);
  const full = frontier(dag, { done: ['T-00'], agents, branches }, { workerCap: 1 });
  assert.equal(full.capacity.workers.used, 1);
  assert.deepEqual(full.dispatch, []);
});

test('a worker commit is dispatched for merge, never for a per-task review', () => {
  const branches = {
    'T-01': { attempts: 1, implementationCommits: 1 },
    'T-02': { attempts: 1, implementationCommits: 1 },
  };
  const report = frontier(dag, { done: ['T-00'], branches });
  // T-03 is not blocked by any review pool; it is still ready for a worker.
  assert.deepEqual(report.dispatch.map((item) => [item.task, item.action]), [
    ['T-03', 'create-branch+dispatch-worker'],
    ['T-01', 'merge'],
    ['T-02', 'merge'],
  ]);
});

test('a merge waits for its Uses producer even after the consumer is implemented', () => {
  const tasks = [
    task({ id: 'T-01' }),
    task({ id: 'T-02', uses: ['T-01'] }),
  ];
  const branches = {
    'T-01': { attempts: 1, implementationCommits: 1 },
    'T-02': { attempts: 1, implementationCommits: 1 },
  };
  const report = frontier(tasks, { done: [], branches });
  assert.deepEqual(report.dispatch.map((item) => item.task), ['T-01']);
  assert.deepEqual(report.mergeWaiting, [{ task: 'T-02', on: ['T-01'] }]);
  const merged = frontier(tasks, { done: ['T-01'], branches });
  assert.deepEqual(merged.dispatch.map((item) => item.task), ['T-02']);
  assert.deepEqual(merged.mergeWaiting, []);
});

test('scope overlap with a task in flight holds the pair, not the whole frontier', () => {
  const overlapping = [
    task({ id: 'T-01', scope: ['src/shared/a.ts'], est: 'L' }),
    task({ id: 'T-02', scope: ['src/shared'], est: 'S' }),
    task({ id: 'T-03', scope: ['src/other.ts'], est: 'S' }),
  ];
  const agents = [{ id: 'w1', role: 'gongbu', task: 'T-01', status: 'running' }];
  const branches = { 'T-01': { attempts: 1, implementationCommits: 1 } };
  const report = frontier(overlapping, { done: [], branches, agents });
  assert.ok(!report.dispatch.some((item) => item.task === 'T-02'));
  // T-01 is still running; T-02 is held by the scope overlap.
  assert.deepEqual(report.dispatch.map((item) => [item.task, item.action]), [
    ['T-03', 'create-branch+dispatch-worker'],
  ]);
});

test('branch attempts above the cap are blocked and stop dispatch', () => {
  const report = frontier(dag, { done: ['T-00'], branches: { 'T-01': { attempts: 4, implementationCommits: 2 } } });
  assert.deepEqual(report.blocked, [{ task: 'T-01', kind: 'BLOCKED_ATTEMPTS', reason: '4 branches; cap is 3' }]);
  assert.ok(!report.dispatch.some((item) => item.task === 'T-01'));
});

test('pending permission and stale labels surface as attention', () => {
  const agents = [
    { id: 'a1', role: 'gongbu', task: 'T-01', status: 'running', pendingPermissions: true },
    { id: 'a2', role: 'jiangzuo', task: 'T-99', status: 'running' },
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
  const state = { done: ['T-00'], branches: { 'T-01': { attempts: 1, implementationCommits: 0 } } };
  assert.deepEqual(frontier(dag, state), frontier(dag, state));
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
function fakePaseo(agents) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'frontier-bin-'));
  const payload = Buffer.from(JSON.stringify(agents)).toString('base64');
  fs.writeFileSync(path.join(bin, 'paseo'), `#!/bin/sh\nif [ "$1" = inspect ]; then printf '{}'; else printf '%s' '${payload}' | base64 -d; fi\n`);
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
  assert.deepEqual(report.dispatch.map((item) => item.action), ['create-branch+dispatch-worker']);
  assert.deepEqual(report.waiting, [{ task: 'T-02', on: ['T-01'] }]);
});

test('CLI treats a legacy Red-only branch as needing a worker, not a merge', () => {
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
  assert.deepEqual(report.dispatch, [{ task: 'T-01', action: 'dispatch-worker', reason: 'branch present; no commit yet' }]);
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

test('running worker holds both uncommitted and committed task branches', () => {
  for (const ownCommits of [0, 1]) {
    const report = frontier([task()], { agents: [{ id: 'w', role: 'gongbu', task: 'T-01', status: 'running' }], branches: { 'T-01': { attempts: 1, ownCommits } } });
    assert.deepEqual(report.dispatch, []);
  }
});

test('third attempt remains executable', () => {
  const report = frontier([task()], { branches: { 'T-01': { attempts: 3, ownCommits: 1 } } });
  assert.equal(report.dispatch[0].action, 'merge');
});

test('finished worker is not silently redispatched or merged; a new attempt may dispatch', () => {
  for (const status of ['idle', 'closed', 'error']) {
    for (const ownCommits of [0, 1]) {
      const agents = [{ id: 'w', role: 'gongbu', task: 'T-01', status, attempt: 1 }];
      const report = frontier([task()], { agents, branches: { 'T-01': { attempts: 1, latestAttempt: 1, ownCommits } } });
      if (ownCommits) assert.equal(report.dispatch[0].action, 'merge');
      else { assert.deepEqual(report.dispatch, []); assert.equal(report.blocked[0].kind, 'BLOCKED_WORKER_RESULT'); }
      const retry = frontier([task()], { agents, branches: { 'T-01': { attempts: 2, latestAttempt: 2, ownCommits: 0 } } });
      assert.equal(retry.dispatch[0].action, 'dispatch-worker');
    }
  }
});

test('inactive worker commit merges after lost notification; empty failure permits dispatch', () => {
  for (const status of ['idle', 'closed', 'error']) {
    const agents = [{ id: 'w', role: 'gongbu', task: 'T-01', status }];
    assert.equal(frontier([task()], { agents, branches: { 'T-01': { attempts: 1, ownCommits: 1 } } }).dispatch[0]?.action, 'merge');
    assert.equal(frontier([task()], { agents, branches: { 'T-01': { attempts: 1, ownCommits: 0 } } }).blocked[0]?.kind, 'BLOCKED_WORKER_RESULT');
  }
  assert.equal(frontier([task()], { branches: { 'T-01': { attempts: 1, ownCommits: 0, mergeFailure: { status: 'failed' } } } }).dispatch[0]?.action, 'dispatch-worker');
  assert.equal(frontier([task()], { branches: { 'T-01': { attempts: 1, ownCommits: 0, mergeFailure: { status: 'pending' } } } }).blocked[0]?.kind, 'BLOCKED_MERGE');
});

test('initializing worker occupies capacity and holds merge', () => {
  const agents = [{ id: 'w', role: 'gongbu', task: 'T-01', status: 'initializing' }];
  const report = frontier([task()], { agents, branches: { 'T-01': { attempts: 1, ownCommits: 1 } } });
  assert.equal(report.capacity.workers.used, 1);
  assert.deepEqual(report.dispatch, []);
});

test('idle worker awaiting permission holds task even with commits', () => {
  const agents = [{ id: 'w', role: 'gongbu', task: 'T-01', status: 'idle', pendingPermissions: true }];
  const report = frontier([task()], { agents, branches: { 'T-01': { attempts: 1, ownCommits: 1 } } });
  assert.deepEqual(report.dispatch, []);
  assert.equal(report.attention[0].kind, 'PENDING_PERMISSION');
});

test('failed empty merge and existing worker holds dispatch', () => {
  for (const status of ['idle', 'closed', 'error']) {
    const agents = [{ id: 'w', role: 'gongbu', task: 'T-01', status }];
    const branches = { 'T-01': { attempts: 1, ownCommits: 0, mergeFailure: { status: 'failed' } } };
    const report = frontier([task()], { agents, branches });
    assert.deepEqual(report.dispatch, []);
    assert.equal(report.blocked[0].kind, 'BLOCKED_WORKER_RESULT');
  }
});

test('priority uses the remaining full dispatch graph, excluding Done descendants', () => {
  const tasks = [
    task({ id: 'T-01' }), task({ id: 'T-02' }),
    task({ id: 'T-03', depends: ['T-02'] }), task({ id: 'T-04', depends: ['T-03'] }),
  ];
  assert.equal(frontier(tasks, {}, { workerCap: 1 }).dispatch[0].task, 'T-02');
  assert.equal(frontier(tasks, { done: ['T-03', 'T-04'] }, { workerCap: 1 }).dispatch[0].task, 'T-01');
});

test('serial Uses skeleton chain dispatches one task at each frontier', () => {
  const tasks = [
    task({ id: 'T-00', kind: 'skeleton' }), task({ id: 'T-01', uses: ['T-00'] }),
    task({ id: 'T-02', depends: ['T-01'] }), task({ id: 'T-03', depends: ['T-02'] }),
  ];
  for (let n = 0; n < tasks.length; n += 1) {
    const report = frontier(tasks, { done: tasks.slice(0, n).map((item) => item.id) });
    assert.deepEqual(report.dispatch.map((item) => item.task), [tasks[n].id]);
  }
});

test('mixed Uses and Depends on can create a mutually waiting dispatch frontier', () => {
  const tasks = [task({ id: 'T-00', kind: 'skeleton', depends: ['T-01'] }), task({ id: 'T-01', uses: ['T-00'] })];
  const report = frontier(tasks);
  assert.deepEqual(report.dispatch, []);
  assert.deepEqual(report.waiting, [{ task: 'T-00', on: ['T-01'] }, { task: 'T-01', on: ['T-00'] }]);
});

test('Uses-only cycle permits dispatch but blocks both merges', () => {
  const tasks = [task({ id: 'T-01', uses: ['T-02'] }), task({ id: 'T-02', uses: ['T-01'] })];
  const report = frontier(tasks, { branches: { 'T-01': { attempts: 1 }, 'T-02': { attempts: 1 } } });
  assert.deepEqual(report.dispatch, []);
  assert.deepEqual(report.mergeWaiting, [{ task: 'T-01', on: ['T-02'] }, { task: 'T-02', on: ['T-01'] }]);
});

test('next-actions rejects invalid tasks before reading Paseo state', () => {
  const invalid = cliTasks.replace('  - Write scope: src/a.ts', '  - Uses: T-02\n  - Write scope: src/a.ts');
  const { dir } = repo(invalid);
  const direct = spawnSync(process.execPath, [path.join(root, 'next-actions.mjs'), path.join(dir, 'openspec/changes/chg'), '--json'], {
    encoding: 'utf8', env: { ...process.env, PATH: '/usr/bin:/bin' },
  });
  assert.equal(direct.status, 3, direct.stderr);
  assert.match(direct.stderr, /CYCLE/);
  assert.equal(direct.stdout, '');
});

test('scope-overlapping tasks with commits merge sequentially rather than deadlocking', () => {
  const tasks = [
    task({ id: 'T-01', scope: ['src/shared'], est: 'S' }),
    task({ id: 'T-02', scope: ['src/shared/sub'], est: 'S' }),
  ];
  const branches = {
    'T-01': { attempts: 1, ownCommits: 1 },
    'T-02': { attempts: 1, ownCommits: 1 },
  };
  const report = frontier(tasks, { done: [], branches, agents: [] });
  assert.equal(report.dispatch.length > 0, true);
  assert.equal(report.dispatch[0].action, 'merge');
  assert.equal(report.dispatch[0].task, 'T-01');
});

test('unstarted scope-overlapping tasks do not race dispatch in the same wave', () => {
  const tasks = [
    task({ id: 'T-01', scope: ['src/shared'], est: 'S' }),
    task({ id: 'T-02', scope: ['src/shared/sub'], est: 'S' }),
  ];
  const report = frontier(tasks, { done: [], branches: {}, agents: [] });
  assert.deepEqual(report.dispatch.map((item) => item.task), ['T-01']);
  assert.equal(report.dispatch[0].action, 'create-branch+dispatch-worker');
});

test('unresolved scope deadlock surfaces as BLOCKED_SCOPE_COLLISION', () => {
  const tasks = [
    task({ id: 'T-01', scope: ['src/shared'], est: 'S' }),
    task({ id: 'T-02', scope: ['src/shared'], est: 'S' }),
  ];
  // Both have attempts but no commits and no active agents -> neither can advance
  const branches = {
    'T-01': { attempts: 1, ownCommits: 0 },
    'T-02': { attempts: 1, ownCommits: 0 },
  };
  const report = frontier(tasks, { done: [], branches, agents: [] });
  assert.deepEqual(report.dispatch, []);
  const collision = report.blocked.find((b) => b.kind === 'BLOCKED_SCOPE_COLLISION');
  assert.ok(collision, JSON.stringify(report.blocked));
  assert.match(collision.reason, /serialize with Depends on or resolve branch collision/);
});

test('unresolved scope collision surfaces even when downstream tasks are waiting', () => {
  const tasks = [
    task({ id: 'T-01', scope: ['src/shared'], est: 'S' }),
    task({ id: 'T-02', scope: ['src/shared'], est: 'S' }),
    task({ id: 'T-03', scope: ['src/other'], est: 'S', depends: ['T-01'] }),
  ];
  const branches = {
    'T-01': { attempts: 1, ownCommits: 0 },
    'T-02': { attempts: 1, ownCommits: 0 },
  };
  const report = frontier(tasks, { done: [], branches, agents: [] });
  assert.deepEqual(report.dispatch, []);
  assert.deepEqual(report.waiting.map((w) => w.task), ['T-03']);
  const collisions = report.blocked.filter((b) => b.kind === 'BLOCKED_SCOPE_COLLISION');
  assert.equal(collisions.length, 2, JSON.stringify(report.blocked));
  assert.deepEqual(collisions.map((c) => c.task).sort(), ['T-01', 'T-02']);
});
