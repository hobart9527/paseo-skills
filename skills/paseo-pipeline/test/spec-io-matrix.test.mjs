import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

// Differential matrix for the single spec-I/O entry (`loadSpecTree`) and the two callers that hold
// policy over it. Every expectation is generated from the fixture and from the real base script; no
// hand-written expected output. The oracle rule:
//   - base exits normally (no uncaught exception)  => the full run must be byte-identical to base;
//   - base crashes (uncaught exception)            => exit 1, never a pass phrase, and under --json
//                                                     a parseable object blocking UNREADABLE_SPEC.
// One class is deliberately NOT byte-identical: a parent directory that exists but cannot be
// traversed (mode 0444 with no execute bit). Base's `existsSync` guard returns false for EACCES, so
// it silently skips the whole subtree and can pass; the fix reports UNREADABLE_SPEC instead. Those
// cells assert that divergence explicitly, with base's own normal exit as the evidence.
// The staged and namespace modes have no base equivalent, so their policy is asserted directly:
// absent => no problem, unreadable => problem + exit 1, never exit 0 on an unreadable input.

const root = path.resolve(import.meta.dirname, '..');
const script = (name) => path.join(root, name);
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const cleanups = [];

// ---- base oracle ----
// The base module imports ./lib/*, so the whole base skill tree is extracted and run in place. A
// lone script copy cannot resolve those imports and would fail for the wrong reason.
let baseScript = null;
function baseFreezeCheck() {
  if (baseScript) return baseScript;
  const repoRoot = execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-matrix-base-'));
  cleanups.push(() => fs.rmSync(tree, { recursive: true, force: true }));
  const archive = execFileSync('git', ['-C', repoRoot, 'archive', 'ab13b9d', 'skills/paseo-pipeline'], { maxBuffer: 64 << 20 });
  execFileSync('tar', ['-x', '-C', tree], { input: archive });
  baseScript = path.join(tree, 'skills', 'paseo-pipeline', 'freeze-check.mjs');
  return baseScript;
}
// An uncaught exception from base, as opposed to a normal blocking report. The marker is a V8 stack
// frame pointing into the base script itself; the error kinds differ by failure (TypeError for a
// dangling link, a plain EACCES Error for a locked directory), so the frame is the reliable test.
const crashed = (result) => /^\s+at .*freeze-check\.mjs:\d+:\d+/m.test(result.stderr);

// ---- fixtures ----
const table = (rows) => '| Scenario | Entry | Tasks | Verify | Required | Result | Evidence |\n|---|---|---|---|---|---|---|\n' + rows;
// The same complete package the golden fixture pins: base exercises every full-run rule on it and
// exits normally, so a mutation of one spec input stays a comparison, not a stack of missing files.
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-matrix-'));
  cleanups.push(() => { chmodAll(dir); fs.rmSync(dir, { recursive: true, force: true }); });
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  };
  write('openspec/changes/current/tasks.md', `- [ ] 1.1 T-01 shared
  - Write scope: src/shared,test/shared.test.mjs
  - Verify with: node --test test/shared.test.mjs
  - Scen: SCEN-1
- [ ] 1.2 T-02 sink
  - Depends on: T-01
  - Write scope: src/app.mjs,test/sink.test.mjs
  - Verify with: npm test
  - Scen: SCEN-1,SCEN-2
`);
  write('openspec/changes/current/proposal.md', 'x\n');
  write('openspec/changes/current/acceptance.md', table('| SCEN-1 | CLI | T-01,T-02 | node -e "0" | yes | PENDING | pending |\n| SCEN-2 | CLI | T-02 | node -e "0" | no | PENDING | pending |'));
  write('openspec/changes/current/specs/cap/spec.md', '## ADDED Requirements\n### Requirement: Added one\n#### Scenario: SCEN-1 one\nWHEN a\nTHEN b\n');
  write('openspec/changes/current/specs/other/spec.md', '## MODIFIED Requirements\n### Requirement: Changed\n#### Scenario: SCEN-2 two\nWHEN c\nTHEN d\n');
  write('openspec/specs/cap/spec.md', '## Requirements\n### Scenario: SCEN-9 base\n');
  write('openspec/changes/other/specs/cap/spec.md', '## MODIFIED Requirements\n### Requirement: Added one\n#### Scenario: SCEN-3 foreign\n');
  execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'main']);
  return {
    dir,
    change: path.join(dir, 'openspec/changes/current'),
    baseline: path.join(dir, 'openspec/specs'),
    other: path.join(dir, 'openspec/changes/other/specs'),
  };
}
function chmodAll(dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { /* already gone */ }
  try { fs.chmodSync(dir, 0o755); } catch { /* best effort */ }
  for (const entry of entries) if (entry.isDirectory()) chmodAll(path.join(dir, entry.name));
}

// One spec input in one state. `absent` creates nothing; `empty` and `normal` are readable files;
// the last three exist but cannot be read or listed.
const STATES = ['absent', 'empty', 'normal', 'dangling', 'unreadable-file', 'unlistable-dir'];
const contentFor = (state, unique) => {
  if (state === 'empty') return '';
  return `## ADDED Requirements\n### Requirement: ${unique}\n#### Scenario: ${unique} scenario\nWHEN x\nTHEN y\n`;
};
function applyState(locDir, state, unique, { fileName = 'extra.md', scenarioId = 'SCEN-Z-01' } = {}) {
  if (state === 'absent') return;
  if (state === 'unlistable-dir') {
    const locked = path.join(locDir, 'locked');
    fs.mkdirSync(locked, { recursive: true });
    fs.writeFileSync(path.join(locked, 'spec.md'), `## Requirements\n#### Scenario: ${scenarioId} locked\n`);
    fs.chmodSync(locked, 0o000);
    return;
  }
  const file = path.join(locDir, fileName);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (state === 'dangling') { fs.symlinkSync(path.join(path.dirname(file), 'missing-target.md'), file); return; }
  fs.writeFileSync(file, contentFor(state, unique));
  if (state === 'unreadable-file') fs.chmodSync(file, 0o000);
}

// Location × state. `dirOf` names the directory the input lives in. The current change's own tree is
// read by base's `walk`, which only looks at files literally named `spec.md`, so the injected file
// there must be a `spec.md` too; baseline and other changes are read as every `.md`.
const LOCATIONS = [
  { name: 'baseline', dirOf: (f) => f.baseline, fileName: 'extra.md' },
  { name: 'other-change', dirOf: (f) => f.other, fileName: 'extra.md' },
  { name: 'current-change', dirOf: (f) => path.join(f.change, 'specs'), fileName: 'cap/extra/spec.md' },
];
const STRUCTURAL_ABSENCES = [
  // Only this one removes the change's own declarations, so only this one is NO_SPEC_SCEN.
  { name: 'no current specs/ dir', noScenario: true, apply: (f) => fs.rmSync(path.join(f.change, 'specs'), { recursive: true, force: true }) },
  { name: 'no openspec/specs', apply: (f) => fs.rmSync(f.baseline, { recursive: true, force: true }) },
  { name: 'no openspec/changes siblings', apply: (f) => fs.rmSync(path.join(f.dir, 'openspec/changes/other'), { recursive: true, force: true }) },
];
// Content base never opens. Each cell makes part of it unreadable or non-spec, and the new run must
// stay byte-identical to base: the traversal scope is base's, not "everything under the repo".
const UNRELATED_CONTENT = [
  {
    name: 'unreadable archive subtree',
    permission: true,
    apply: (f) => {
      const dir = path.join(f.dir, 'openspec/changes/archive/old/private');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'spec.md'), '#### Scenario: SCEN-77 archived\n');
      fs.chmodSync(dir, 0o000);
    },
  },
  {
    name: 'unreadable <change>/private outside specs',
    permission: true,
    apply: (f) => {
      const dir = path.join(f.dir, 'openspec/changes/other/private');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'spec.md'), '#### Scenario: SCEN-78 private\n');
      fs.chmodSync(dir, 0o000);
    },
  },
  {
    name: 'plain file directly in openspec/changes',
    apply: (f) => fs.writeFileSync(path.join(f.dir, 'openspec/changes/notes.md'), '#### Scenario: SCEN-79 note\n'),
  },
  {
    name: 'symlinked change dir not followed',
    apply: (f) => {
      const target = path.join(f.dir, 'elsewhere');
      fs.mkdirSync(path.join(target, 'specs/cap'), { recursive: true });
      fs.writeFileSync(path.join(target, 'specs/cap/spec.md'), '## ADDED Requirements\n#### Scenario: SCEN-3 foreign\n');
      fs.symlinkSync(target, path.join(f.dir, 'openspec/changes/linked'));
    },
  },
];

// ---- modes ----
const runFull = (bin, dir, json) => {
  const flags = ['--structural', '--skip-signer-check', ...(json ? ['--json'] : [])];
  return spawnSync('node', [bin, dir, ...flags], { encoding: 'utf8' });
};
const runStage = (dir, json) => {
  const flags = ['--structural', '--skip-signer-check', '--stage', 'specs', ...(json ? ['--json'] : [])];
  return spawnSync('node', [script('freeze-check.mjs'), dir, ...flags], { encoding: 'utf8' });
};
const runNamespace = (dir, json) => spawnSync('node', [script('namespace.mjs'), dir, ...(json ? ['--json'] : [])], { encoding: 'utf8' });
const parseJson = (result, label) => {
  try { return JSON.parse(result.stdout); }
  catch { assert.fail(`${label}: stdout is not JSON: ${JSON.stringify(result.stdout.slice(0, 300))}`); }
};

// ---- shared assertions per mode ----
// Base-normal comparison. `identical` is false for the deliberate divergence above.
function compareFull(base, f, label, { identical }) {
  let normalExit = 0;
  let crash = 0;
  for (const json of [false, true]) {
    const mode = json ? 'full --structural --json' : 'full --structural';
    const baseRun = runFull(base, f.change, json);
    const tipRun = runFull(script('freeze-check.mjs'), f.change, json);
    if (!crashed(baseRun)) {
      normalExit += 1;
      if (identical) {
        assert.equal(tipRun.status, baseRun.status, `${label} (${mode}): exit: ${tipRun.stderr}`);
        assert.equal(tipRun.stdout, baseRun.stdout, `${label} (${mode}): stdout`);
        assert.equal(tipRun.stderr, baseRun.stderr, `${label} (${mode}): stderr`);
      } else {
        // The documented divergence: base completed and reported nothing, which is the silent skip
        // this change removes. Base's own output is the evidence, asserted here, not assumed.
        assert.equal(baseRun.status, 0, `${label} (${mode}): base passed silently, which is the defect`);
        if (json) {
          const baseReport = parseJson(baseRun, `${label} base (${mode})`);
          assert.deepEqual(baseReport.blocking, [], `${label} (${mode}): base reported nothing`);
        }
        assert.equal(tipRun.status, 1, `${label} (${mode}): exit`);
        assert.match(tipRun.stderr, /unreadable spec /, `${label} (${mode}): readable message`);
        if (json) {
          const report = parseJson(tipRun, `${label} (${mode})`);
          assert.ok(report.blocking.some((item) => item.startsWith('UNREADABLE_SPEC ')), `${label} (${mode}): ${report.blocking.join(' | ')}`);
        }
      }
    } else {
      crash += 1;
      assert.equal(baseRun.status, 1, `${label} (${mode}): base crashed with a nonzero exit`);
      assert.equal(tipRun.status, 1, `${label} (${mode}): exit`);
      assert.doesNotMatch(tipRun.stdout, /RESULT freeze ok/, `${label} (${mode})`);
      assert.match(tipRun.stderr, /unreadable spec /, `${label} (${mode}): readable message`);
      if (json) {
        const report = parseJson(tipRun, `${label} (${mode})`);
        assert.ok(report.blocking.some((item) => item.startsWith('UNREADABLE_SPEC ')), `${label} (${mode}): ${report.blocking.join(' | ')}`);
      }
    }
  }
  return { normalExit, crash };
}
function assertStage(f, label, { problem, noScenario, status }) {
  for (const json of [false, true]) {
    const mode = json ? 'stage --json' : 'stage';
    const result = runStage(f.change, json);
    const expected = status ?? (problem || noScenario ? 1 : 0);
    assert.equal(result.status, expected, `${label} (${mode}): exit ${result.stdout}${result.stderr}`);
    if (json) {
      const report = parseJson(result, `${label} (${mode})`);
      assert.equal(report.stage, 'specs', `${label} (${mode})`);
      assert.equal(report.blocking.some((item) => item.startsWith('UNREADABLE_SPEC ')), problem, `${label} (${mode}): ${report.blocking.join(' | ')}`);
      if (noScenario) assert.ok(report.blocking.some((item) => item.startsWith('NO_SPEC_SCEN')), `${label} (${mode}): ${report.blocking.join(' | ')}`);
    }
    if (problem || noScenario) assert.doesNotMatch(result.stdout, /RESULT specs ok/, `${label} (${mode})`);
  }
}
function assertNamespace(f, label, { problem }) {
  for (const json of [false, true]) {
    const mode = json ? 'namespace --json' : 'namespace';
    const result = runNamespace(f.change, json);
    assert.equal(result.status, problem ? 1 : 0, `${label} (${mode}): exit ${result.stderr}`);
    if (json) {
      const report = parseJson(result, `${label} (${mode})`);
      if (problem) assert.ok(report.unreadable.length > 0, `${label} (${mode}): unreadable entry`);
      else assert.deepEqual(report.unreadable, [], `${label} (${mode})`);
    } else if (problem) assert.match(result.stdout, /Unreadable spec files or directories/, `${label} (${mode})`);
    else assert.doesNotMatch(result.stdout, /Unreadable spec files or directories/, `${label} (${mode})`);
  }
}

test('the differential matrix holds for every spec location and state', (t) => {
  const base = baseFreezeCheck();
  if (isRoot) t.diagnostic('SKIP permission-based cells: running as root, chmod does not deny reads');

  const covered = { normalExit: 0, crash: 0, problem: 0, absent: 0, divergence: 0, unrelated: 0 };

  // (1) Location × state. Base-normal => byte-identical; base-crash => fail closed.
  for (const location of LOCATIONS) {
    for (const state of STATES) {
      if (isRoot && (state === 'unreadable-file' || state === 'unlistable-dir')) continue;
      const f = fixture();
      applyState(location.dirOf(f), state, `Requirement-${location.name}-${state}`, { fileName: location.fileName });
      const problem = state === 'dangling' || state === 'unreadable-file' || state === 'unlistable-dir';
      if (problem) covered.problem += 1;
      const label = `${location.name} / ${state} in ${f.dir}`;
      const { normalExit, crash } = compareFull(base, f, label, { identical: true });
      covered.normalExit += normalExit; covered.crash += crash;
      assertStage(f, label, { problem, noScenario: false });
      assertNamespace(f, label, { problem });
    }
  }

  // (2) Whole-tree absences: absent is not a problem, but a change with no specs/ has NO_SPEC_SCEN.
  for (const absence of STRUCTURAL_ABSENCES) {
    const f = fixture();
    absence.apply(f);
    covered.absent += 1;
    const label = `${absence.name} in ${f.dir}`;
    const { normalExit, crash } = compareFull(base, f, label, { identical: true });
    covered.normalExit += normalExit; covered.crash += crash;
    assertStage(f, label, { problem: false, noScenario: absence.noScenario === true });
    assertNamespace(f, label, { problem: false });
  }

  // (3) Parent exists but cannot be traversed. Base's existsSync swallows EACCES and can pass; this
  // is the one deliberate divergence, asserted with base's own exit as the evidence.
  if (!isRoot) {
    for (const where of ['baseline', 'other-change']) {
      const f = fixture();
      const parent = where === 'baseline' ? f.baseline : path.join(f.dir, 'openspec/changes/other');
      fs.chmodSync(parent, 0o444);
      cleanups.push(() => { try { fs.chmodSync(parent, 0o755); } catch { /* gone */ } });
      covered.divergence += 1;
      const label = `${where} parent not traversable (0444) in ${f.dir}`;
      const { normalExit, crash } = compareFull(base, f, label, { identical: false });
      covered.normalExit += normalExit; covered.crash += crash;
      assertStage(f, label, { problem: true, noScenario: false });
      assertNamespace(f, label, { problem: true });
    }
  } else {
    t.diagnostic('SKIP parent-not-traversable cells: running as root, chmod 0444 does not deny traversal');
  }

  // (4) Unrelated content base never reads: unreadable things under archive/, under <change>/ outside
  // specs/, a plain file directly in openspec/changes, and a symlinked change dir. Base is normal on
  // all of these, so the full run must be byte-identical and no mode may invent a problem.
  for (const cell of UNRELATED_CONTENT) {
    if (isRoot && cell.permission) { t.diagnostic(`SKIP ${cell.name}: running as root`); continue; }
    const f = fixture();
    cell.apply(f);
    covered.unrelated += 1;
    const label = `${cell.name} in ${f.dir}`;
    const { normalExit, crash } = compareFull(base, f, label, { identical: true });
    assert.equal(crash, 0, `${label}: base must complete normally`);
    covered.normalExit += normalExit;
    assertStage(f, label, { problem: false, noScenario: false });
    assertNamespace(f, label, { problem: false });
  }

  // Both base branches were compared, every unreadable state was constructed, and the deliberate
  // divergence and unrelated-content families were actually exercised.
  assert.ok(covered.normalExit > 0 && covered.crash > 0, `oracle branches: ${JSON.stringify(covered)}`);
  assert.equal(covered.absent, STRUCTURAL_ABSENCES.length, `absence cells: ${JSON.stringify(covered)}`);
  assert.equal(covered.problem, isRoot ? LOCATIONS.length : LOCATIONS.length * 3, `unreadable cells: ${JSON.stringify(covered)}`);
  assert.equal(covered.divergence, isRoot ? 0 : 2, `divergence cells: ${JSON.stringify(covered)}`);
  assert.equal(covered.unrelated, UNRELATED_CONTENT.length, `unrelated cells: ${JSON.stringify(covered)}`);
});

test('--stage is parsed in one pass: exactly once, with --structural, and the value is specs', () => {
  const f = fixture();
  const cases = [
    // accepted
    { args: ['--structural', '--stage', 'specs'], status: 0 },
    { args: ['--structural', '--stage', 'specs', '--json'], status: 0 },
    // rejected: value, duplication, missing value, missing --structural, unknown value
    { args: ['--structural', '--stage', 'tasks'], status: 2 },
    { args: ['--structural', '--stage', 'specs', '--stage', 'specs'], status: 2 },
    { args: ['--structural', '--stage', 'specs', '--stage', 'tasks'], status: 2 },
    { args: ['--structural', '--stage'], status: 2 },
    { args: ['--stage', 'specs'], status: 2 },
    { args: ['--stage'], status: 2 },
    // Any token that looks like `--stage...` is stage syntax, never an unknown flag to ignore.
    { args: ['--structural', '--stage=specs'], status: 2 },
    { args: ['--structural', '--stage=tasks'], status: 2 },
    { args: ['--structural', '--stagefoo'], status: 2 },
    { args: ['--structural', '--stage', 'specs', '--stage=tasks'], status: 2 },
    { args: ['--structural', '--stage', 'specs', '--stagefoo'], status: 2 },
    { args: ['--stage', 'specs', '--structural', '--stage'], status: 2 },
  ];
  for (const { args, status } of cases) {
    const result = spawnSync('node', [script('freeze-check.mjs'), f.change, ...args], { encoding: 'utf8' });
    assert.equal(result.status, status, `${args.join(' ')}: ${result.stdout}${result.stderr}`);
    if (status === 2) assert.match(result.stderr, /Usage:/, args.join(' '));
  }
  // The one valid form runs: exit 1 here because this fixture's staging run has no --skip-signer
  // check equivalent to hide, and exit status is 0 or 1, never 2.
  const valid = spawnSync('node', [script('freeze-check.mjs'), f.change, '--structural', '--stage', 'specs'], { encoding: 'utf8' });
  assert.ok(valid.status === 0 || valid.status === 1, `valid stage form: ${valid.status} ${valid.stderr}`);
  // A positional after `--stage specs` is still not the change directory: the value was consumed.
  const trailing = spawnSync('node', [script('freeze-check.mjs'), f.change, '--structural', '--stage', 'specs', '--json'], { encoding: 'utf8' });
  assert.equal(JSON.parse(trailing.stdout).change, path.resolve(f.change));
});

test.after(() => {
  for (const cleanup of cleanups.reverse()) cleanup();
});
