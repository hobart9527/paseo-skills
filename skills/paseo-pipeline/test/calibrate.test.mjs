import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../calibrate.mjs', import.meta.url));
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'calibrator',
  GIT_AUTHOR_EMAIL: 'calibrator@test.local',
  GIT_COMMITTER_NAME: 'calibrator',
  GIT_COMMITTER_EMAIL: 'calibrator@test.local',
};
delete env.NODE_TEST_CONTEXT;

function git(cwd, args, extraEnv = {}) {
  const result = spawnSync('git', args, { cwd, env: { ...env, ...extraEnv }, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}
function write(cwd, file, text) {
  const full = path.join(cwd, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
}
function commit(cwd, message, date, files = {}) {
  for (const [file, text] of Object.entries(files)) write(cwd, file, text);
  git(cwd, ['add', '-A']);
  const at = { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  const body = message.includes('Pipeline-Role:') ? message : message;
  git(cwd, ['commit', '-qm', body], at);
  return git(cwd, ['rev-parse', 'HEAD']);
}

// Two task branches with known timestamps: red -> impl, impl -> merge, one rework
// commit. Medians are exact, so the assertions are not tolerance games.
function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'calibrate-'));
  const change = 'demo';
  git(cwd, ['init', '-q', '-b', 'main']);
  write(cwd, `openspec/changes/${change}/tasks.md`, `# Tasks
- [ ] 1.1 T-01 alpha
  - Write scope: src/a.mjs,test/a.test.mjs
  - Verify with: node --test test/a.test.mjs
  - Review: standard
  - Est: M
- [ ] 1.2 T-02 beta
  - Write scope: src/b.mjs,test/b.test.mjs
  - Verify with: node --test test/b.test.mjs
  - Review: standard
  - Est: S
`);
  write(cwd, `openspec/changes/${change}/run-log.md`, [
    '- 2026-01-01T01:10:00Z merge task=T-01 timing_ms={"red":0,"verify":60000,"regression":30000,"replayed":1,"total":90000}',
    '- 2026-01-01T00:50:00Z merge task=T-02 timing_ms={"red":0,"verify":120000,"regression":0,"replayed":0,"total":120000}',
    '',
  ].join('\n'));
  const baseSha = commit(cwd, 'base', '2026-01-01T00:00:00Z', { 'README.md': 'x\n' });
  git(cwd, ['switch', '-qc', `integration/${change}`]);

  // T-01: red 00:10 -> impl 00:40 (30m) -> merge 01:10 (30m), no rework.
  git(cwd, ['switch', '-qc', `task/${change}/T-01`, baseSha]);
  commit(cwd, `red tests\n\nPipeline-Role: ceshi\nPipeline-Author: 11111111-1111-4111-8111-111111111111`, '2026-01-01T00:10:00Z', { 'test/a.test.mjs': 'import test from "node:test";\n' });
  commit(cwd, `implement\n\nPipeline-Role: gongbu\nPipeline-Author: 22222222-2222-4222-8222-222222222222`, '2026-01-01T00:40:00Z', { 'src/a.mjs': 'export const a = 1;\n' });
  git(cwd, ['switch', '-q', `integration/${change}`]);
  git(cwd, ['merge', '-q', '--no-ff', `task/${change}/T-01`, '-m', 'merge(T-01)'], {
    GIT_AUTHOR_DATE: '2026-01-01T01:10:00Z',
    GIT_COMMITTER_DATE: '2026-01-01T01:10:00Z',
  });

  // T-02: red 00:10 -> impl 00:20 (10m) -> rework 00:26 (6m) -> merge 00:50 (30m).
  git(cwd, ['switch', '-qc', `task/${change}/T-02`, baseSha]);
  commit(cwd, `red tests\n\nPipeline-Role: ceshi\nPipeline-Author: 33333333-3333-4333-8333-333333333333`, '2026-01-01T00:10:00Z', { 'test/b.test.mjs': 'import test from "node:test";\n' });
  commit(cwd, `implement\n\nPipeline-Role: gongbu\nPipeline-Author: 44444444-4444-4444-8444-444444444444`, '2026-01-01T00:20:00Z', { 'src/b.mjs': 'export const b = 1;\n' });
  commit(cwd, `rework\n\nPipeline-Role: gongbu\nPipeline-Author: 44444444-4444-4444-8444-444444444444`, '2026-01-01T00:26:00Z', { 'src/b.mjs': 'export const b = 2;\n' });
  git(cwd, ['switch', '-q', `integration/${change}`]);
  git(cwd, ['merge', '-q', '--no-ff', `task/${change}/T-02`, '-m', 'merge(T-02)'], {
    GIT_AUTHOR_DATE: '2026-01-01T00:50:00Z',
    GIT_COMMITTER_DATE: '2026-01-01T00:50:00Z',
  });

  return { cwd, change, baseSha };
}

function run(cwd, args) {
  const result = spawnSync('node', [script, cwd, ...args], { cwd, env, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, out: `${result.stdout}${result.stderr}` };
}

test('calibrate: derives medians per task size from a synthetic history', () => {
  const { cwd } = fixture();
  const result = run(cwd, ['--json']);
  assert.equal(result.status, 0, result.out);
  const model = JSON.parse(result.stdout);

  assert.equal(model.measured.redToImplMin.overall, 20); // median(30, 10)
  assert.equal(model.measured.implToMergeMin.overall, 30); // median(30, 30)
  assert.equal(model.implMin.M, 30); // T-01 Est: M
  assert.equal(model.implMin.S, 10); // T-02 Est: S
  assert.equal(model.implMin.L, 20); // no L sample -> overall median
  assert.equal(model.reworkMin, 6); // T-02 impl -> rework
  // verify median 1.5m + regression median 0.25m (rounded to 0.3) are folded into the
  // 30m interval.
  assert.equal(model.reviewMin.standard, 28.3);
  assert.equal(model.regressionMinPerTask, 0.3);

  assert.deepEqual(model.samples, { tasks: 2, branches: 2, reworkRate: 0.5 });
  assert.equal(model.confidence, 'low');
  assert.equal(model.reworkRate.standard, 0.5);
  // Same key names as lib/schedule.mjs DEFAULT_MODEL.
  for (const key of ['redMin', 'implMin', 'reviewMin', 'reworkMin', 'mergeMin', 'regressionMinPerTask', 'reviewerCap', 'writerCap', 'reworkRate']) {
    assert.ok(Object.prototype.hasOwnProperty.call(model, key), key);
  }
});

test('calibrate: --change scopes the branches and emits human output', () => {
  const { cwd } = fixture();
  const scoped = run(cwd, ['--json', '--change', 'demo']);
  assert.equal(scoped.status, 0, scoped.out);
  assert.equal(JSON.parse(scoped.stdout).samples.tasks, 2);

  const human = run(cwd, ['--change', 'demo']);
  assert.equal(human.status, 0, human.out);
  assert.match(human.stdout, /samples tasks=2/);
  assert.match(human.stdout, /confidence=low/);
  assert.match(human.stdout, /SAMPLE task\/demo\/T-01/);
});

test('calibrate: an empty repository is not a failure', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'calibrate-empty-'));
  git(cwd, ['init', '-q', '-b', 'main']);
  commit(cwd, 'base', '2026-01-01T00:00:00Z', { 'README.md': 'x\n' });
  const result = run(cwd, ['--json']);
  assert.equal(result.status, 0, result.out);
  const model = JSON.parse(result.stdout);
  assert.deepEqual(model.samples, { tasks: 0, branches: 0, reworkRate: 0 });
  assert.equal(model.confidence, 'low');
});
