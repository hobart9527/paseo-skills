// Regression: a task branch is cut from the integration tip, so its history already
// contains the merge commits of every earlier task. Those merge commits carry
// `Pipeline-Role` trailers, and counting them made a Red-only branch look like it had
// an implementation commit: the Lead then dispatched a reviewer and the merge died at
// exit 31 ("requires separate ceshi test-author and implementation commits").
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../next-actions.mjs', import.meta.url));
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'next-actions-tester',
  GIT_AUTHOR_EMAIL: 'next@test.local',
  GIT_COMMITTER_NAME: 'next-actions-tester',
  GIT_COMMITTER_EMAIL: 'next@test.local',
};
delete env.NODE_TEST_CONTEXT;

const TASKS = `- [x] 1.1 T-00 skeleton
  - Write scope: src/iface.mjs,test/iface.test.mjs
  - Est: S
  - Kind: skeleton
  - Interface: src/iface.mjs#iface
  - Review: mechanical
  - Verify with: node --test test/iface.test.mjs
  - Done: source=aaaaaaa review=pass(mechanical@aaaaaaa/bbbbbbb)
- [ ] 1.2 T-01 behavior task
  - Uses: T-00
  - Write scope: src/one.mjs,test/one.test.mjs
  - Est: S
  - Review: deferred
  - Verify with: node --test test/one.test.mjs
  - Scen: SCEN-X
`;

function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'next-actions-'));
  const bin = path.join(cwd, '.fake-bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'paseo'), '#!/bin/sh\nprintf "[ ]"\n');
  fs.chmodSync(path.join(bin, 'paseo'), 0o755);
  const localEnv = { ...env, PATH: `${bin}:${process.env.PATH}` };
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd, env: localEnv, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    return result.stdout.trim();
  };
  const write = (file, text) => {
    const full = path.join(cwd, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  };
  write('openspec/changes/c1/tasks.md', TASKS);
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-qm', 'contract');
  git('switch', '-qc', 'integration/c1');

  // The skeleton's merge commit is exactly what a task branch started from carries.
  git('switch', '-qc', 'task/c1/T-00');
  write('src/iface.mjs', 'export const iface = true;\n');
  write('test/iface.test.mjs', '// mechanical\n');
  git('add', '-A');
  git('commit', '-qm', 'work(T-00)\n\nPipeline-Role: gongbu\nPipeline-Author: 11111111-0000-4000-8000-000000000001');
  git('switch', '-q', 'integration/c1');
  git('merge', '--no-ff', '-qm', 'merge(T-00)\n\nPipeline-Task: T-00\nPipeline-Role: mechanical', 'task/c1/T-00');

  // A fresh branch with only the Red commit: this is the state that must read as
  // "dispatch-implementer", not "dispatch-reviewer".
  git('switch', '-qc', 'task/c1/T-01');
  write('test/one.test.mjs', '// red\n');
  git('add', '-A');
  git('commit', '-qm', 'test(T-01): red\n\nPipeline-Role: ceshi\nPipeline-Author: 11111111-0000-4000-8000-000000000002');
  git('switch', '-q', 'integration/c1');
  return { cwd, localEnv };
}

function run(cwd, localEnv) {
  const result = spawnSync('node', [script, 'openspec/changes/c1', '--json'], { cwd, env: localEnv, encoding: 'utf8' });
  return { status: result.status, out: `${result.stdout}${result.stderr}`, json: result.stdout ? JSON.parse(result.stdout) : null };
}

test('next-actions: without an integration branch the plan is a preview, not authorization', () => {
  const { cwd, localEnv } = fixture();
  const git = (...args) => spawnSync('git', args, { cwd, env: localEnv, encoding: 'utf8' });
  git('switch', '-q', 'main');
  git('branch', '-D', 'integration/c1');
  const planned = spawnSync('node', [script, 'openspec/changes/c1', '--json'], { cwd, env: localEnv, encoding: 'utf8' });
  assert.equal(planned.status, 0, planned.stderr);
  assert.equal(JSON.parse(planned.stdout).frozen, false);
  const human = spawnSync('node', [script, 'openspec/changes/c1'], { cwd, env: localEnv, encoding: 'utf8' });
  assert.match(human.stdout, /PLANNING PREVIEW/);
  assert.match(human.stdout, /not execution authorization/);
});

test('next-actions: integration merge commits do not count as this task\'s implementation', () => {
  const { cwd, localEnv } = fixture();
  const result = run(cwd, localEnv);
  assert.equal(result.status, 0, result.out);
  const dispatch = result.json.dispatch.map((item) => `${item.task}:${item.action}`);
  assert.deepEqual(dispatch, ['T-01:dispatch-worker'], JSON.stringify(result.json));
});

test('next-actions: human-approved attempt override releases only named tasks', () => {
  const { cwd, localEnv } = fixture();
  const git = (...args) => spawnSync('git', args, { cwd, env: localEnv, encoding: 'utf8' });
  git('branch', 'task/c1/T-01-a2', 'integration/c1');
  git('branch', 'task/c1/T-01-a3', 'integration/c1');
  git('branch', 'task/c1/T-01-a4', 'integration/c1');
  let result = spawnSync('node', [script, 'openspec/changes/c1', '--json', '--allow-attempt-over', 'T-01'], { cwd, env: localEnv, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.dispatch.map((item) => [item.task, item.action]), [['T-01', 'dispatch-worker']]);
  assert.deepEqual(report.blocked, []);
});

test('next-actions: attempt suffix gaps still trip the merge gate breaker', () => {
  const { cwd, localEnv } = fixture();
  const git = (...args) => spawnSync('git', args, { cwd, env: localEnv, encoding: 'utf8' });
  git('branch', 'task/c1/T-01-a4', 'integration/c1');
  const result = run(cwd, localEnv);
  assert.equal(result.status, 0, result.out);
  assert.deepEqual(result.json.blocked.map((item) => [item.task, item.kind]), [['T-01', 'BLOCKED_ATTEMPTS']]);
});

test('next-actions: four branches trip the breaker', () => {
  const { cwd, localEnv } = fixture();
  const git = (...args) => spawnSync('git', args, { cwd, env: localEnv, encoding: 'utf8' });
  // No commits on either replacement branch: every branch is an attempt, so both count.
  git('branch', 'task/c1/T-01-a2', 'integration/c1');
  git('branch', 'task/c1/T-01-a3', 'integration/c1');
  git('branch', 'task/c1/T-01-a4', 'integration/c1');
  const result = run(cwd, localEnv);
  assert.equal(result.status, 0, result.out);
  assert.deepEqual(result.json.blocked.map((item) => [item.task, item.kind]), [['T-01', 'BLOCKED_ATTEMPTS']]);
  assert.ok(!result.json.dispatch.some((item) => item.task === 'T-01'), JSON.stringify(result.json));
});

test('next-actions: an empty branch alone re-dispatches a worker onto it, not a new branch', () => {
  const { cwd, localEnv } = fixture();
  const git = (...args) => spawnSync('git', args, { cwd, env: localEnv, encoding: 'utf8' });
  git('switch', '-q', 'integration/c1');
  git('branch', 'task/c1/T-01-a2', 'integration/c1');
  // Drop the committed attempt so only the empty branch remains: rename it into place.
  git('branch', '-D', 'task/c1/T-01');
  git('branch', '-m', 'task/c1/T-01-a2', 'task/c1/T-01');
  const result = run(cwd, localEnv);
  assert.equal(result.status, 0, result.out);
  assert.deepEqual(result.json.dispatch.map((item) => `${item.task}:${item.action}`), ['T-01:dispatch-worker']);
});

test('next-actions: a worker commit on the branch advances to merge', () => {
  const { cwd, localEnv } = fixture();
  const git = (...args) => spawnSync('git', args, { cwd, env: localEnv, encoding: 'utf8' });
  git('switch', '-q', 'task/c1/T-01');
  fs.writeFileSync(path.join(cwd, 'src/one.mjs'), 'export const one = true;\n');
  git('add', '-A');
  git('commit', '-qm', 'work(T-01)\n\nPipeline-Role: gongbu\nPipeline-Author: 11111111-0000-4000-8000-000000000001');
  git('switch', '-q', 'integration/c1');
  const result = run(cwd, localEnv);
  assert.equal(result.status, 0, result.out);
  // A worker commit merges directly; there is no per-task review stage.
  assert.deepEqual(result.json.dispatch.map((item) => `${item.task}:${item.action}`), ['T-01:merge']);
});

test('next-actions: change label isolates active workers and inspect errors fail closed', () => {
  const { cwd, localEnv } = fixture();
  const paseo = path.join(cwd, '.fake-bin', 'paseo');
  const agent = { id: 'worker', name: '[Pipeline] gongbu T-01 c1', status: 'running', cwd };
  fs.writeFileSync(paseo, `#!/bin/sh\nif [ "$1" = inspect ]; then printf '%s' '${JSON.stringify({ Id: agent.id, Name: agent.name, Status: agent.status, PendingPermissions: [] })}'; exit 0; fi\ncase " $* " in *" --label pipeline.change=c1 "*) printf '%s' '${JSON.stringify([agent])}' ;; *) printf '%s' '${JSON.stringify([agent])}' ;; esac\n`);
  let result = run(cwd, localEnv);
  assert.equal(result.status, 0, result.out);
  assert.deepEqual(result.json.dispatch, []);
  fs.writeFileSync(paseo, `#!/bin/sh\nif [ "$1" = inspect ]; then exit 1; fi\nprintf '%s' '${JSON.stringify([agent])}'\n`);
  result = run(cwd, localEnv);
  assert.equal(result.status, 3, result.out);
});

test('next-actions: malformed list and unrecognized identity fail closed', () => {
  const { cwd, localEnv } = fixture();
  const paseo = path.join(cwd, '.fake-bin', 'paseo');
  for (const payload of [{}, [{ id: 'worker', name: 'gongbu-c1', status: 'running' }]]) {
    fs.writeFileSync(paseo, `#!/bin/sh\nprintf '%s' '${JSON.stringify(payload)}'\n`);
    const result = run(cwd, localEnv);
    assert.equal(result.status, 3, result.out);
  }
});

test('next-actions: old active unlabelled pipeline agent stops scheduling', () => {
  const { cwd, localEnv } = fixture();
  const paseo = path.join(cwd, '.fake-bin', 'paseo');
  fs.writeFileSync(paseo, `#!/bin/sh\ncase " $* " in *" --label "*) printf '[]' ;; *) printf '[{"id":"old","name":"[Pipeline] gongbu T-01","status":"running"}]' ;; esac\n`);
  const result = run(cwd, localEnv);
  assert.equal(result.status, 3, result.out);
  assert.match(result.out, /lacks a matching change label/);
});

test('next-actions: identifiable other change does not interfere', () => {
  const { cwd, localEnv } = fixture();
  const paseo = path.join(cwd, '.fake-bin', 'paseo');
  fs.writeFileSync(paseo, `#!/bin/sh\ncase " $* " in *" pipeline.change=c1 "*) printf '[]' ;; *) printf '[{"id":"other","name":"[Pipeline] gongbu T-01 c2","status":"running"}]' ;; esac\n`);
  const result = run(cwd, localEnv);
  assert.equal(result.status, 0, result.out);
  assert.equal(result.json.dispatch[0].action, 'dispatch-worker');
});

test('next-actions: title claiming another change without its label stops scheduling', () => {
  const { cwd, localEnv } = fixture();
  const paseo = path.join(cwd, '.fake-bin', 'paseo');
  fs.writeFileSync(paseo, `#!/bin/sh\ncase " $* " in *" --label "*) printf '[]' ;; *) printf '[{"id":"old","name":"[Pipeline] gongbu T-01 c2","status":"running"}]' ;; esac\n`);
  const result = run(cwd, localEnv);
  assert.equal(result.status, 3, result.out);
});

test('next-actions: former role-change titles fail closed without label', () => {
  const { cwd, localEnv } = fixture();
  const paseo = path.join(cwd, '.fake-bin', 'paseo');
  fs.writeFileSync(paseo, `#!/bin/sh\ncase " $* " in *" --label "*) printf '[]' ;; *) printf '[{"id":"old","name":"gongbu-c1","status":"running"}]' ;; esac\n`);
  const result = run(cwd, localEnv);
  assert.equal(result.status, 3, result.out);
});

test('next-actions: closed legacy title is ignored and short title accepts initializing transition', () => {
  const { cwd, localEnv } = fixture();
  const paseo = path.join(cwd, '.fake-bin', 'paseo');
  const agents = [{ id: 'old', name: '[Pipeline] old title extra words', status: 'closed', cwd }, { id: 'w', name: '[Pipeline] gongbu T-01', status: 'initializing', cwd }];
  fs.writeFileSync(paseo, `#!/bin/sh\nif [ "$1" = inspect ]; then printf '%s' '${JSON.stringify({Id:'w',Name:agents[1].name,Status:'running',PendingPermissions:[]})}'; else printf '%s' '${JSON.stringify(agents)}'; fi\n`);
  const result = run(cwd, localEnv);
  assert.equal(result.status, 0, result.out);
  assert.deepEqual(result.json.dispatch, []);
  assert.equal(result.json.capacity.workers.used, 1);
});

test('next-actions: active legacy agent in another repository does not block', () => {
  const { cwd, localEnv } = fixture();
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-other-'));
  spawnSync('git', ['init', '-q', other]);
  const paseo = path.join(cwd, '.fake-bin', 'paseo');
  fs.writeFileSync(paseo, `#!/bin/sh\ncase " $* " in *" --label "*) printf '[]' ;; *) printf '%s' '${JSON.stringify([{id:'other',name:'[Pipeline] gongbu T-01',status:'running',cwd:other}])}' ;; esac\n`);
  const result = run(cwd, localEnv);
  assert.equal(result.status, 0, result.out);
});

test('next-actions: Done state comes from the integration branch, not a stale local copy', () => {
  const { cwd, localEnv } = fixture();
  const git = (...args) => spawnSync('git', args, { cwd, env: localEnv, encoding: 'utf8' });
  // integration/c1 now records T-01 as Done; the default branch keeps the pre-merge copy.
  git('switch', '-q', 'integration/c1');
  const done = fs.readFileSync(path.join(cwd, 'openspec/changes/c1/tasks.md'), 'utf8')
    .replace('- [ ] 1.2 T-01 behavior task', '- [x] 1.2 T-01 behavior task')
    .replace('  - Scen: SCEN-X\n', '  - Scen: SCEN-X\n  - Done: source=1234567 review=worker\n');
  fs.writeFileSync(path.join(cwd, 'openspec/changes/c1/tasks.md'), done);
  git('add', '-A');
  git('commit', '-qm', 'merge(T-01): record Done');
  const result = run(cwd, localEnv);
  assert.equal(result.status, 0, result.out);
  assert.equal(result.json.tasksSource, 'integration');
  // Reading the stale local copy would re-dispatch the already-Done T-01.
  assert.deepEqual(result.json.dispatch, []);
  assert.ok(!result.json.dispatch.some((item) => item.task === 'T-01'));
});

test('next-actions: an integration branch without tasks.md is unreadable state', () => {
  const { cwd, localEnv } = fixture();
  const git = (...args) => spawnSync('git', args, { cwd, env: localEnv, encoding: 'utf8' });
  git('rm', '-q', '-r', 'openspec/changes/c1');
  git('commit', '-qm', 'drop the contract');
  fs.mkdirSync(path.join(cwd, 'openspec/changes/c1'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'openspec/changes/c1/tasks.md'), TASKS);
  const result = run(cwd, localEnv);
  assert.equal(result.status, 3, result.out);
  assert.match(result.out, /tasks\.md/);
});

test('next-actions: long change uses label and short title', () => {
  const { cwd, localEnv } = fixture();
  const change = 'long-change-name-that-exceeds-sixty-characters-when-added-to-a-worker-title';
  fs.renameSync(path.join(cwd, 'openspec/changes/c1'), path.join(cwd, 'openspec/changes', change));
  spawnSync('git', ['add', '-A'], { cwd, env: localEnv });
  spawnSync('git', ['commit', '-qm', 'rename the change'], { cwd, env: localEnv });
  spawnSync('git', ['branch', '-m', 'integration/c1', `integration/${change}`], { cwd, env: localEnv });
  const agent = { id: 'w', name: '[Pipeline] gongbu T-01', status: 'running', cwd };
  const paseo = path.join(cwd, '.fake-bin', 'paseo');
  fs.writeFileSync(paseo, `#!/bin/sh\nif [ "$1" = inspect ]; then printf '%s' '${JSON.stringify({Id:'w',Name:agent.name,Status:'running',PendingPermissions:[]})}'; else printf '%s' '${JSON.stringify([agent])}'; fi\n`);
  const result = spawnSync('node', [script, `openspec/changes/${change}`, '--json'], { cwd, env: localEnv, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).dispatch, []);
});

test('next-actions: short title from another labelled change in same repository is isolated', () => {
  const { cwd, localEnv } = fixture();
  spawnSync('git', ['branch', 'integration/c2'], { cwd, env: localEnv });
  const agent = { id: 'other', name: '[Pipeline] gongbu T-01', status: 'running', cwd };
  const paseo = path.join(cwd, '.fake-bin', 'paseo');
  fs.writeFileSync(paseo, `#!/bin/sh\ncase " $* " in *" pipeline.change=c1 "*) printf '[]' ;; *) printf '%s' '${JSON.stringify([agent])}' ;; esac\n`);
  const result = run(cwd, localEnv);
  assert.equal(result.status, 0, result.out);
  assert.equal(result.json.dispatch[0].action, 'dispatch-worker');
});

test('next-actions: labelled idle legacy title with removed cwd is reconciled, active is not', () => {
  const { cwd, localEnv } = fixture();
  const paseo = path.join(cwd, '.fake-bin', 'paseo');
  const agent = { id: 'w', name: '[Pipeline] gongbu T-01 fix legacy behavior', status: 'idle', cwd: path.join(cwd, 'removed') };
  const fake = (status) => fs.writeFileSync(paseo, `#!/bin/sh\nif [ "$1" = inspect ]; then printf '%s' '${JSON.stringify({Id:'w',Name:agent.name,Status:status,PendingPermissions:[]})}'; else printf '%s' '${JSON.stringify([agent])}'; fi\n`);
  fake('idle');
  let result = run(cwd, localEnv);
  assert.equal(result.status, 0, result.out);
  assert.equal(result.json.blocked[0].kind, 'BLOCKED_WORKER_RESULT');
  fake('running');
  result = run(cwd, localEnv);
  assert.equal(result.status, 3, result.out);
});

test('next-actions: other pre-CP1 change discovered in agent worktree', () => {
  const { cwd, localEnv } = fixture();
  fs.mkdirSync(path.join(cwd, 'openspec/changes/c2'), { recursive: true });
  const agent = { id: 'other', name: '[Pipeline] gongbu FULL', status: 'running', cwd };
  const paseo = path.join(cwd, '.fake-bin', 'paseo');
  fs.writeFileSync(paseo, `#!/bin/sh\ncase " $* " in *" pipeline.change=c1 "*) printf '[]' ;; *) printf '%s' '${JSON.stringify([agent])}' ;; esac\n`);
  const result = run(cwd, localEnv);
  assert.equal(result.status, 0, result.out);
  assert.equal(result.json.dispatch[0].action, 'dispatch-worker');
});

test('next-actions: removed cwd closed worker is retained as completion evidence', () => {
  const { cwd, localEnv } = fixture();
  const agent = { id: 'w', name: '[Pipeline] gongbu T-01 old description', status: 'closed', cwd: path.join(cwd, 'removed') };
  fs.writeFileSync(path.join(cwd, '.fake-bin', 'paseo'), `#!/bin/sh\nprintf '%s' '${JSON.stringify([agent])}'\n`);
  const result = run(cwd, localEnv);
  assert.equal(result.status, 0, result.out);
  assert.equal(result.json.blocked[0].kind, 'BLOCKED_WORKER_RESULT');
});

test('next-actions: labelled active legacy description holds task', () => {
  const { cwd, localEnv } = fixture();
  const agent = { id: 'w', name: '[Pipeline] gongbu T-01 detailed legacy task', status: 'running', cwd };
  fs.writeFileSync(path.join(cwd, '.fake-bin', 'paseo'), `#!/bin/sh\nif [ "$1" = inspect ]; then printf '%s' '${JSON.stringify({Id:'w',Name:agent.name,Status:'running',PendingPermissions:[]})}'; else printf '%s' '${JSON.stringify([agent])}'; fi\n`);
  const result = run(cwd, localEnv);
  assert.equal(result.status, 0, result.out);
  assert.deepEqual(result.json.dispatch, []);
});

test('next-actions: removed cwd idle author requires inspect and active state fails closed', () => {
  const { cwd, localEnv } = fixture();
  const agent = { id: 'a', name: '[Pipeline] gongbu FULL authoring', status: 'idle', cwd: path.join(cwd, 'removed') };
  const paseo = path.join(cwd, '.fake-bin', 'paseo');
  const fake = (status) => fs.writeFileSync(paseo, `#!/bin/sh\nif [ "$1" = inspect ]; then printf '%s' '${JSON.stringify({Id:'a',Name:agent.name,Status:status,PendingPermissions:[]})}'; else printf '%s' '${JSON.stringify([agent])}'; fi\n`);
  fake('idle');
  assert.equal(run(cwd, localEnv).status, 0);
  fake('running');
  assert.equal(run(cwd, localEnv).status, 3);
});

test('next-actions: inspect pending permission holds idle worker with commit', () => {
  const { cwd, localEnv } = fixture();
  const git = (...args) => spawnSync('git', args, { cwd, env: localEnv, encoding: 'utf8' });
  git('switch', '-q', 'task/c1/T-01');
  fs.writeFileSync(path.join(cwd, 'src/one.mjs'), 'export const one = true;\n');
  git('add', '-A');
  git('commit', '-qm', 'work\n\nPipeline-Role: gongbu\nPipeline-Author: 11111111-0000-4000-8000-000000000001');
  git('switch', '-q', 'integration/c1');
  const agent = { id: 'w', name: '[Pipeline] gongbu T-01', status: 'idle', cwd };
  fs.writeFileSync(path.join(cwd, '.fake-bin', 'paseo'), `#!/bin/sh\nif [ "$1" = inspect ]; then printf '%s' '${JSON.stringify({Id:'w',Name:agent.name,Status:'idle',PendingPermissions:[{id:'p'}]})}'; else printf '%s' '${JSON.stringify([agent])}'; fi\n`);
  const result = run(cwd, localEnv);
  assert.equal(result.status, 0, result.out);
  assert.deepEqual(result.json.dispatch, []);
  assert.ok(result.json.attention.some((item) => item.kind === 'PENDING_PERMISSION'));
});

test('next-actions rejects invalid options and missing change directory', () => {
  const { cwd, localEnv } = fixture();
  for (const args of [['--other-change', 'openspec/changes/c1'], ['openspec/changes/c1', '--bogus'], ['openspec/changes/c1', '--json=1'], ['openspec/changes/c1', '--other-change=']]) {
    const result = spawnSync('node', [script, ...args], { cwd, env: localEnv, encoding: 'utf8' });
    assert.equal(result.status, 2, `${args}: ${result.stderr}`);
  }
});

test('next-actions explains safe recovery for labelled unrecognized legacy reviewer', () => {
  const { cwd, localEnv } = fixture();
  const agent = { id: 'legacy', name: '[Pipeline] review T-09-a2 deep links', status: 'running', cwd };
  fs.writeFileSync(path.join(cwd, '.fake-bin', 'paseo'), `#!/bin/sh\nprintf '%s' '${JSON.stringify([agent])}'\n`);
  const result = run(cwd, localEnv);
  assert.equal(result.status, 3, result.out);
  assert.match(result.out, /confirming its role is non-worker/);
  assert.match(result.out, /paseo agent update legacy --name/);
});

test('next-actions: R0-r2 and FINAL-r2 roles are recognised, UNKNOWN stages still fail closed', () => {
  const { cwd, localEnv } = fixture();
  const paseo = path.join(cwd, '.fake-bin', 'paseo');
  const fake = (name, status = 'running') => fs.writeFileSync(paseo, `#!/bin/sh\nif [ "$1" = inspect ]; then printf '%s' '${JSON.stringify({ Id: 'a', Name: name, Status: status, PendingPermissions: [] })}'; else printf '%s' '${JSON.stringify([{ id: 'a', name, status, cwd }])}'; fi\n`);
  fake('[Pipeline] hanlin R0-r2');
  assert.equal(run(cwd, localEnv).status, 0, 'R0-r2 is a non-worker stage');
  fake('[Pipeline] anchasi FINAL-r2');
  assert.equal(run(cwd, localEnv).status, 0, 'FINAL-r2 is a non-worker stage');
  fake('[Pipeline] hanlin R0-r0');
  assert.equal(run(cwd, localEnv).status, 3, 'r0 is not a review round');
  fake('[Pipeline] hanlin R0-r2 extra context');
  assert.equal(run(cwd, localEnv).status, 0, 'a trailing description is still allowed');
});
