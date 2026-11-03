import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../adversarial.mjs', import.meta.url));

// One task per case: every risk surface, an unknown surface, an explicit `none`,
// and a task with no Risk-surface field at all.
const TASKS = `# Tasks
- [ ] 1.1 T-01 alpha
  - Write scope: src/a.mjs
  - Risk-surface: [persistence, public-api]
- [ ] 1.2 T-02 beta
  - Risk-surface: concurrency
- [ ] 1.3 T-03 gamma
  - Risk-surface: [none]
- [ ] 1.4 T-04 delta
  - Write scope: src/d.mjs
- [ ] 1.5 T-05 epsilon
  - Risk-surface: [telepathy]
`;

function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'adversarial-'));
  const file = path.join(cwd, 'tasks.md');
  fs.writeFileSync(file, TASKS);
  return { cwd, file };
}
function run(args) {
  const result = spawnSync('node', [script, ...args], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, out: `${result.stdout}${result.stderr}` };
}
function byId(report) {
  return Object.fromEntries(report.tasks.map((task) => [task.id, task.checklist]));
}

test('adversarial: each risk surface maps to its concrete checklist', () => {
  const { file } = fixture();
  const result = run([file, '--json']);
  assert.equal(result.status, 0, result.out);
  const tasks = byId(JSON.parse(result.stdout));

  // Merged surfaces keep a stable order and duplicate nothing.
  assert.equal(tasks['T-01'].length, 8);
  assert.ok(tasks['T-01'].includes('state survives reload / process restart'));
  assert.ok(tasks['T-01'].includes('unknown endpoint/method returns the documented status code'));
  assert.equal(new Set(tasks['T-01']).size, tasks['T-01'].length);

  assert.ok(tasks['T-02'].includes('two in-flight requests: the documented policy (last-write-wins vs conflict) holds'));
  assert.ok(tasks['T-02'].includes('duplicate/retried request does not apply the effect twice'));
});

test('adversarial: none and a missing Risk-surface produce an empty checklist', () => {
  const { file } = fixture();
  const tasks = byId(JSON.parse(run([file, '--json']).stdout));
  assert.deepEqual(tasks['T-03'], []);
  assert.deepEqual(tasks['T-04'], []);
});

test('adversarial: an unknown surface asks for a scenario-derived case instead of guessing', () => {
  const { file } = fixture();
  const tasks = byId(JSON.parse(run([file, '--json']).stdout));
  assert.equal(tasks['T-05'].length, 1);
  assert.match(tasks['T-05'][0], /unmapped risk surface "telepathy"/);
  assert.match(tasks['T-05'][0], /Scenarios/);
});

test('adversarial: output is deterministic and the human view lists every case', () => {
  const { file } = fixture();
  const first = run([file, '--json']);
  const second = run([file, '--json']);
  assert.equal(first.stdout, second.stdout);

  const human = run([file]);
  assert.equal(human.status, 0, human.out);
  assert.match(human.stdout, /T-01: 8 adversarial case\(s\)/);
  assert.match(human.stdout, /- state survives reload \/ process restart/);
  assert.match(human.stdout, /T-04: 0 adversarial case\(s\)/);
});

test('adversarial: a missing tasks file is a usage error, not an empty checklist', () => {
  const result = run([path.join(os.tmpdir(), 'no-such-tasks-file.md'), '--json']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /cannot read/);
});
