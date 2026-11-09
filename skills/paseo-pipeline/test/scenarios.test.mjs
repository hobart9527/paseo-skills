import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The read-only `scenarios` helper. It derives declared scenarios, claimant tasks and existing
// acceptance relations from one read of the change directory so the author does not hand-sync two
// sets. It never executes Verify, never writes, and never invents Entry/Verify/Required.
const script = fileURLToPath(new URL('../pipeline-run.mjs', import.meta.url));
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
};
delete env.NODE_TEST_CONTEXT;

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

const HEADER = '| Scenario | Entry | Tasks | Verify | Required | Result | Evidence |\n| --- | --- | --- | --- | --- | --- | --- |\n';
const table = (...rows) => HEADER + rows.join('\n') + '\n';

const TASKS = `- [ ] 1.1 T-01 api
  - Write scope: src/api.mjs,test/api.test.mjs
  - Verify with: node --test test/api.test.mjs
  - Scenarios: SCEN-CAP-01
- [ ] 1.2 T-02 api error path
  - Depends on: T-01
  - Write scope: src/api-error.mjs,test/api-error.test.mjs
  - Verify with: node --test test/api-error.test.mjs
  - Scenarios: SCEN-CAP-01,SCEN-CAP-02
`;

const SPECS = `## ADDED Requirements

### Requirement: Export

#### Scenario: SCEN-CAP-01 export runs
WHEN invoked
THEN it exports

#### Scenario: SCEN-CAP-02 export fails loudly
WHEN invoked badly
THEN it fails
`;

function fixture(overrides = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'scenarios-'));
  const files = {
    'openspec/changes/chg/tasks.md': TASKS,
    'openspec/changes/chg/proposal.md': 'p\n',
    'openspec/changes/chg/specs/cap/spec.md': SPECS,
    'openspec/changes/chg/acceptance.md': table(
      '| SCEN-CAP-01 | CLI `node src/api.mjs` | | node --test test/api.test.mjs | yes | PENDING | pending |',
      '| SCEN-CAP-02 | CLI `node src/api-error.mjs` | | node --test test/api-error.test.mjs | yes | PENDING | pending |',
    ),
    ...overrides,
  };
  for (const [file, text] of Object.entries(files)) write(cwd, file, text);
  git(cwd, 'init', '-q', '-b', 'main');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', 'contract');
  return { cwd, dir: path.join(cwd, 'openspec/changes/chg') };
}

function run(cwd, args, spawnEnv = env) {
  const r = spawnSync('node', [script, ...args], { cwd, env: spawnEnv, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, out: `${r.stdout}${r.stderr}` };
}

// Every file under the fixture with its content and mtime, to prove the helper wrote nothing.
function snapshot(cwd) {
  const out = new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else out.set(path.relative(cwd, file), `${fs.readFileSync(file, 'utf8')}\u0000${fs.statSync(file).mtimeMs}`);
    }
  };
  walk(cwd);
  return out;
}

test('scenarios reports declared scenarios, claimants and existing acceptance relations', () => {
  const f = fixture();
  const r = run(f.cwd, ['scenarios', f.dir, '--json']);
  assert.equal(r.status, 0, r.out);
  const report = JSON.parse(r.stdout);
  const byId = new Map(report.scenarios.map((entry) => [entry.id, entry]));
  assert.deepEqual([...byId.keys()].sort(), ['SCEN-CAP-01', 'SCEN-CAP-02']);
  assert.deepEqual(byId.get('SCEN-CAP-01').claimants, ['T-01', 'T-02']);
  assert.deepEqual(byId.get('SCEN-CAP-02').claimants, ['T-02']);
  // The empty Tasks cells derived the owners; the report shows the relation that already holds.
  // Both rows leave `Tasks` empty, so the owner list is derived rather than restated.
  assert.deepEqual(byId.get('SCEN-CAP-01').acceptanceRows.map((row) => row.tasks), [[]]);
  assert.deepEqual(byId.get('SCEN-CAP-02').acceptanceRows.map((row) => row.tasks), [[]]);
  assert.deepEqual(byId.get('SCEN-CAP-01').gaps, []);
  assert.deepEqual(byId.get('SCEN-CAP-02').gaps, []);
});

test('scenarios is read-only and stable across runs', () => {
  const f = fixture();
  const before = snapshot(f.cwd);
  const first = run(f.cwd, ['scenarios', f.dir, '--json']);
  const second = run(f.cwd, ['scenarios', f.dir, '--json']);
  assert.equal(first.status, 0, first.out);
  assert.equal(second.status, 0, second.out);
  assert.equal(first.stdout, second.stdout, 'same content must yield the same report');
  assert.deepEqual(snapshot(f.cwd), before, 'the helper must not create, edit or touch a file');
});

test('scenarios reports a gap per missing relation without inventing a row', () => {
  const f = fixture({
    'openspec/changes/chg/acceptance.md': table(
      // SCEN-CAP-02 has no row at all; SCEN-CAP-01 names only one of its two claimants.
      '| SCEN-CAP-01 | CLI `node src/api.mjs` | T-01 | node --test test/api.test.mjs | yes | PENDING | pending |',
    ),
  });
  const r = run(f.cwd, ['scenarios', f.dir, '--json']);
  assert.equal(r.status, 0, r.out);
  const report = JSON.parse(r.stdout);
  const byId = new Map(report.scenarios.map((entry) => [entry.id, entry]));
  assert.deepEqual(byId.get('SCEN-CAP-02').gaps, ['NO_ACCEPTANCE_ROW']);
  // The union of the rows must list every claimant; naming T-01 alone hides T-02.
  assert.deepEqual(byId.get('SCEN-CAP-01').gaps, ['ROW_UNION_MISSING T-02']);
  // A gap never becomes a filled row: no Entry, Verify or Required appears anywhere.
  assert.ok(!Object.hasOwn(byId.get('SCEN-CAP-02'), 'entry'));
  assert.ok(!Object.hasOwn(byId.get('SCEN-CAP-02'), 'verify'));
  assert.ok(!Object.hasOwn(byId.get('SCEN-CAP-02'), 'required'));
});

test('scenarios reports an acceptance row that names a non-claimant task', () => {
  const f = fixture({
    'openspec/changes/chg/acceptance.md': table(
      '| SCEN-CAP-01 | CLI `node src/api.mjs` | T-01,T-02 | node --test test/api.test.mjs | yes | PENDING | pending |',
      // T-01 claims only SCEN-CAP-01; listing it under SCEN-CAP-02 is a cross-row error.
      '| SCEN-CAP-02 | CLI `node src/api-error.mjs` | T-01,T-02 | node --test test/api-error.test.mjs | yes | PENDING | pending |',
    ),
  });
  const r = run(f.cwd, ['scenarios', f.dir, '--json']);
  assert.equal(r.status, 0, r.out);
  const report = JSON.parse(r.stdout);
  const entry = report.scenarios.find((item) => item.id === 'SCEN-CAP-02');
  assert.deepEqual(entry.gaps, ['ROW_NAMES_NON_CLAIMANT T-01']);
});

test('scenarios reports a declared scenario that no task claims', () => {
  const f = fixture({
    'openspec/changes/chg/tasks.md': TASKS.replace('  - Scenarios: SCEN-CAP-01,SCEN-CAP-02\n', '  - Scenarios: SCEN-CAP-01\n'),
  });
  const r = run(f.cwd, ['scenarios', f.dir, '--json']);
  assert.equal(r.status, 0, r.out);
  const report = JSON.parse(r.stdout);
  const entry = report.scenarios.find((item) => item.id === 'SCEN-CAP-02');
  assert.deepEqual(entry.claimants, []);
  assert.deepEqual(entry.gaps, ['NO_CLAIMANT_TASK']);
});

test('scenarios offers a Scenario/Tasks candidate but never Entry, Verify or Required', () => {
  const f = fixture();
  const r = run(f.cwd, ['scenarios', f.dir, '--json']);
  assert.equal(r.status, 0, r.out);
  const report = JSON.parse(r.stdout);
  const entry = report.scenarios.find((item) => item.id === 'SCEN-CAP-01');
  // The candidate is the safe default the brief documents: an empty Tasks cell derives owners
  // from tasks.md, so the helper never freezes a second owner list.
  assert.deepEqual(entry.candidate, { Scenario: 'SCEN-CAP-01', Tasks: '' });
  for (const key of ['Entry', 'Verify', 'Required', 'Result', 'Evidence']) {
    assert.ok(!Object.hasOwn(entry.candidate, key), key);
  }
});

test('scenarios fails loudly on an unparseable tasks.md and emits no candidate', () => {
  const f = fixture({ 'openspec/changes/chg/tasks.md': `${TASKS}- [ ] missing id line\n` });
  const r = run(f.cwd, ['scenarios', f.dir, '--json']);
  assert.notEqual(r.status, 0, r.out);
  const report = JSON.parse(r.stdout);
  assert.equal(report.scenarios, undefined, 'a broken parse must not look like a valid report');
  assert.ok(report.errors.some((error) => error.code === 'MALFORMED_LINE'), r.stdout);
});

test('scenarios fails loudly on a malformed acceptance row and emits no candidate', () => {
  const f = fixture({
    'openspec/changes/chg/acceptance.md': table(
      // An unescaped literal `|` widens the row: its cells can no longer be trusted.
      '| SCEN-CAP-01 | CLI `node src/api.mjs` | | node --test test/api.test.mjs | yes | PENDING | pending |',
      '| SCEN-CAP-02 | CLI a | b | | node --test x | yes | PENDING | pending |',
    ),
  });
  const r = run(f.cwd, ['scenarios', f.dir, '--json']);
  assert.notEqual(r.status, 0, r.out);
  const report = JSON.parse(r.stdout);
  assert.equal(report.scenarios, undefined);
  assert.ok(report.errors.some((error) => /MALFORMED_ACCEPTANCE_ROW/.test(error.code)), r.stdout);
});

test('scenarios fails loudly when a spec cannot be read and emits no candidate', () => {
  const f = fixture();
  const spec = path.join(f.dir, 'specs/cap/spec.md');
  fs.rmSync(spec);
  fs.symlinkSync(path.join(f.cwd, 'missing-target.md'), spec);
  const r = run(f.cwd, ['scenarios', f.dir, '--json']);
  assert.notEqual(r.status, 0, r.out);
  const report = JSON.parse(r.stdout);
  assert.equal(report.scenarios, undefined);
  assert.ok(report.errors.some((error) => /UNREADABLE_SPEC/.test(error.code)), r.stdout);
});

test('scenarios identity agrees with the gate: new, baseline reuse, shared and conflict', () => {
  const f = fixture();
  const write = (file, text) => {
    const target = path.join(f.cwd, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  };
  // Baseline declares SCEN-CAP-01 and an untouched SCEN-CAP-99; another active change shares
  // SCEN-CAP-02 verbatim (legal) and declares SCEN-CAP-03 with different text (a collision).
  write('openspec/specs/cap/spec.md', '## Requirements\n### Requirement: Baseline\n#### Scenario: SCEN-CAP-01 legacy run\nWHEN a\nTHEN b\n#### Scenario: SCEN-CAP-99 untouched\nWHEN z\nTHEN z\n');
  write('openspec/changes/other/specs/cap/spec.md', `## MODIFIED Requirements\n### Requirement: Both\n#### Scenario: SCEN-CAP-02 export fails loudly\nWHEN invoked badly\nTHEN it fails\n#### Scenario: SCEN-CAP-03 export retries\nWHEN flaky\nTHEN retried\n`);
  // This change re-declares SCEN-CAP-01 under MODIFIED Requirements (identity reuse), shares
  // SCEN-CAP-02 verbatim, and re-declares SCEN-CAP-03 with different content (a real conflict).
  write('openspec/changes/chg/specs/cap/spec.md', `## MODIFIED Requirements

### Requirement: Export

#### Scenario: SCEN-CAP-01 export runs again
WHEN invoked again
THEN it exports

#### Scenario: SCEN-CAP-02 export fails loudly
WHEN invoked badly
THEN it fails

#### Scenario: SCEN-CAP-03 export retries
WHEN flaky differently
THEN retried differently
`);
  git(f.cwd, 'add', '.');
  git(f.cwd, 'commit', '-qm', 'collision matrix');

  const r = run(f.cwd, ['scenarios', f.dir, '--json']);
  assert.equal(r.status, 0, r.out);
  const report = JSON.parse(r.stdout);
  const kind = (id) => report.scenarios.find((entry) => entry.id === id).identity.kind;
  assert.equal(kind('SCEN-CAP-01'), 'baseline-reuse');
  assert.equal(kind('SCEN-CAP-02'), 'shared-identical');
  assert.equal(kind('SCEN-CAP-03'), 'conflict');

  // Same fixture through the gate: only the conflicting id blocks, which is what the helper's
  // `conflict` label predicted. The helper classifies; it never changes collision semantics.
  write('openspec/changes/chg/acceptance.md', table(
    '| SCEN-CAP-01 | CLI | | node --test test/api.test.mjs | yes | PENDING | pending |',
    '| SCEN-CAP-02 | CLI | | node --test test/api-error.test.mjs | yes | PENDING | pending |',
    '| SCEN-CAP-03 | CLI | | node --test test/api-error.test.mjs | yes | PENDING | pending |',
  ));
  const gate = spawnSync('node', [path.join(path.dirname(script), 'freeze-check.mjs'), f.dir, '--json', '--structural', '--skip-signer-check'], { cwd: f.cwd, env, encoding: 'utf8' });
  const blocking = JSON.parse(gate.stdout).blocking;
  assert.ok(blocking.includes('COLLIDING_SCEN SCEN-CAP-03: already declared in openspec/changes/other/specs/cap/spec.md'), blocking.join('\n'));
  assert.ok(!blocking.some((item) => item.startsWith('COLLIDING_SCEN SCEN-CAP-01')), blocking.join('\n'));
  assert.ok(!blocking.some((item) => item.startsWith('COLLIDING_SCEN SCEN-CAP-02')), blocking.join('\n'));
});

test('scenarios prints a human-readable report and a usage error otherwise', () => {
  const f = fixture();
  const r = run(f.cwd, ['scenarios', f.dir]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.stdout, /SCEN-CAP-01/);
  assert.match(r.stdout, /claimants: T-01, T-02/);
  // No --json parse: the flags are strict like every other pipeline-run subcommand.
  assert.equal(run(f.cwd, ['scenarios', f.dir, '--bogus']).status, 2);
  assert.equal(run(f.cwd, ['scenarios']).status, 2);
});
