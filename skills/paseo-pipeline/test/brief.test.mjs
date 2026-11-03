import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../brief.mjs', import.meta.url));
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'brief-tester',
  GIT_AUTHOR_EMAIL: 'brief@test.local',
  GIT_COMMITTER_NAME: 'brief-tester',
  GIT_COMMITTER_EMAIL: 'brief@test.local',
};
delete env.NODE_TEST_CONTEXT;

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}
function write(cwd, file, text) {
  const full = path.join(cwd, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
}

function fixture({ gitRepo = true } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-'));
  const change = 'c1';
  write(cwd, `openspec/changes/${change}/tasks.md`, `# Tasks
- [x] 1.1 T-01 alpha
  - Write scope: src/a.mjs,test/a.test.mjs
  - Verify with: node --test test/a.test.mjs
  - Review: standard
  - Scenarios: SCEN-C1-01
  - Done: source=abcdef1 review=pass(1234567@abcdef1/abcdef0)
- [ ] 1.2 T-02 beta
  - Depends on: T-01
  - Uses: T-01
  - Reads: docs/contract.md
  - Write scope: src/b.mjs,test/b.test.mjs
  - Verify with: node --test test/b.test.mjs
  - Review: strict
  - Scenarios: SCEN-C1-02
  - Est: M
  - Risk-surface: [error-handling]
`);
  write(cwd, `openspec/changes/${change}/specs/core/spec.md`, '#### Scenario: SCEN-C1-01 alpha\n#### Scenario: SCEN-C1-02 beta\n');
  write(cwd, `openspec/changes/${change}/design.md`, '# Design\n## Impact Inventory\n- T-01\n');
  write(cwd, `openspec/changes/${change}/acceptance.md`, '# Acceptance\n');
  write(cwd, 'docs/contract.md', '# Contract\n');
  if (gitRepo) {
    git(cwd, ['init', '-q', '-b', 'main']);
    git(cwd, ['add', '-A']);
    git(cwd, ['commit', '-qm', 'contract']);
  }
  return { cwd, change };
}

function run(args) {
  const result = spawnSync('node', [script, ...args], { env, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, out: `${result.stdout}${result.stderr}` };
}

test('brief: a task brief renders every required section from the frozen contract', () => {
  const { cwd, change } = fixture();
  const result = run(['tester', '--change', change, '--repo', cwd, '--task', 'T-02', '--base', 'HEAD', '--json']);
  assert.equal(result.status, 0, result.out);
  const { prompt, missing } = JSON.parse(result.stdout);
  assert.deepEqual(missing, []);
  for (const needle of [
    'T-02', 'src/b.mjs, test/b.test.mjs', 'node --test test/b.test.mjs', 'SCEN-C1-02',
    'Frozen task contract', 'Depends on: T-01', 'Done=yes', 'Uses: T-01', 'Reads: docs/contract.md',
    'Review: strict', 'Est: M', 'Exact test paths: test/b.test.mjs',
    'Files you must not touch', 'src/a.mjs', 'test/a.test.mjs',
  ]) {
    assert.ok(prompt.includes(needle), `${needle}\n---\n${prompt}`);
  }
  // Placeholders are resolved; runtime ones the child owns may remain.
  assert.doesNotMatch(prompt, /<change>|<T-id>|<base>|<change-dir>|<integration-branch>|<workspace>/);
  assert.match(prompt, /integration\/c1/);
  // No concrete model id may leak into a child prompt.
  assert.doesNotMatch(prompt, /\b(?:sonnet|opus|haiku|gpt-[\w.]+|claude-[\w.]+|anthropic\/\w+|openai\/\w+)/i);
});

test('brief: a dependency that is not Done is reported as such', () => {
  const { cwd, change } = fixture();
  const tasksFile = path.join(cwd, `openspec/changes/${change}/tasks.md`);
  fs.writeFileSync(tasksFile, fs.readFileSync(tasksFile, 'utf8').replace('  - Done: source=abcdef1 review=pass(1234567@abcdef1/abcdef0)\n', ''));
  const result = run(['writer', '--change', change, '--repo', cwd, '--task', 'T-02', '--json']);
  assert.equal(result.status, 0, result.out);
  const { prompt } = JSON.parse(result.stdout);
  assert.match(prompt, /T-01: Done=no/);
});

test('brief: leads get the integration placeholders resolved, not a model id', () => {
  const { cwd, change } = fixture();
  const result = run(['lead', '--change', change, '--repo', cwd, '--base', 'HEAD', '--json']);
  assert.equal(result.status, 0, result.out);
  const { prompt, missing } = JSON.parse(result.stdout);
  assert.deepEqual(missing, []);
  assert.match(prompt, /integration\/c1/);
  assert.match(prompt, new RegExp(cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(prompt, /<change>/);
});

test('brief: an unknown role fails with a clear error', () => {
  const { cwd, change } = fixture();
  const result = run(['wizard', '--change', change, '--repo', cwd, '--json']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown role "wizard"/);
});

test('brief: an unknown task fails instead of rendering a partial brief', () => {
  const { cwd, change } = fixture();
  const result = run(['tester', '--change', change, '--repo', cwd, '--task', 'T-99', '--json']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown task T-99/);
});

test('brief: an unresolvable required placeholder fails and lists it', () => {
  const { cwd, change } = fixture();
  const result = run(['tester', '--change', change, '--repo', cwd, '--task', 'T-02',
    '--base', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', '--json']);
  assert.equal(result.status, 1, result.out);
  const { missing } = JSON.parse(result.stdout);
  assert.ok(missing.includes('base'), JSON.stringify(missing));
});

test('brief: a FINAL reviewer brief lists every deferred task with its merged diff range', () => {
  const { cwd, change } = fixture();
  const tasksFile = path.join(cwd, `openspec/changes/${change}/tasks.md`);
  const text = fs.readFileSync(tasksFile, 'utf8')
    .replace('Review: standard\n  - Scenarios: SCEN-C1-01\n  - Done: source=abcdef1 review=pass(1234567@abcdef1/abcdef0)',
      'Review: deferred\n  - Scenarios: SCEN-C1-01\n  - Done: source=abcdef1 review=pass(deferred@abcdef1/abcdef0)')
    .replace('Review: strict', 'Review: deferred');
  fs.writeFileSync(tasksFile, text);
  const result = run(['reviewer', '--change', change, '--repo', cwd, '--base', 'HEAD', '--json']);
  assert.equal(result.status, 0, result.out);
  const { prompt } = JSON.parse(result.stdout);
  assert.match(prompt, /## Deferred tasks/);
  assert.match(prompt, /T-01 alpha: `git diff abcdef0\.\.abcdef1`/);
  assert.match(prompt, /T-02 beta: not Done yet/);
});

test('brief: a repository with no deferred task adds no deferred section', () => {
  const { cwd, change } = fixture();
  const result = run(['reviewer', '--change', change, '--repo', cwd, '--base', 'HEAD', '--json']);
  assert.equal(result.status, 0, result.out);
  assert.doesNotMatch(JSON.parse(result.stdout).prompt, /Deferred tasks/);
});
