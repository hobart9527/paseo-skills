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

test('next-actions: integration merge commits do not count as this task\'s implementation', () => {
  const { cwd, localEnv } = fixture();
  const result = run(cwd, localEnv);
  assert.equal(result.status, 0, result.out);
  const dispatch = result.json.dispatch.map((item) => `${item.task}:${item.action}`);
  assert.deepEqual(dispatch, ['T-01:dispatch-implementer'], JSON.stringify(result.json));
});

test('next-actions: an implementation commit on the branch does advance to review', () => {
  const { cwd, localEnv } = fixture();
  const git = (...args) => spawnSync('git', args, { cwd, env: localEnv, encoding: 'utf8' });
  git('switch', '-q', 'task/c1/T-01');
  fs.writeFileSync(path.join(cwd, 'src/one.mjs'), 'export const one = true;\n');
  git('add', '-A');
  git('commit', '-qm', 'work(T-01)\n\nPipeline-Role: gongbu\nPipeline-Author: 11111111-0000-4000-8000-000000000001');
  git('switch', '-q', 'integration/c1');
  const result = run(cwd, localEnv);
  assert.equal(result.status, 0, result.out);
  // T-01 is Review: deferred, so its implementation merges directly; the point is that
  // it is not "dispatch-implementer" any more.
  assert.deepEqual(result.json.dispatch.map((item) => `${item.task}:${item.action}`), ['T-01:merge']);
});
