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
  { name: 'no current specs/ dir', apply: (f) => fs.rmSync(path.join(f.change, 'specs'), { recursive: true, force: true }) },
  { name: 'no openspec/specs', apply: (f) => fs.rmSync(f.baseline, { recursive: true, force: true }) },
  { name: 'no openspec/changes siblings', apply: (f) => fs.rmSync(path.join(f.dir, 'openspec/changes/other'), { recursive: true, force: true }) },
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

test('the differential matrix holds for every spec location and state', (t) => {
  const base = baseFreezeCheck();
  const cells = [];
  for (const location of LOCATIONS) {
    for (const state of STATES) cells.push({ name: `${location.name} / ${state}`, location, state });
  }
  for (const absence of STRUCTURAL_ABSENCES) cells.push({ name: absence.name, absence });
  // Running as root defeats chmod, so those states cannot be built on this machine. Say so instead
  // of pretending the cell passed: the skip is visible in the TAP output.
  if (isRoot) t.diagnostic('SKIP unreadable-file and unlistable-dir cells: running as root, chmod 000 does not deny reads');

  // Coverage counters: the matrix must exercise both oracle branches, and must not silently drop the
  // permission-based states on this machine.
  const covered = { normalExit: 0, crash: 0, problem: 0, absent: 0 };
  for (const cell of cells) {
    if (isRoot && (cell.state === 'unreadable-file' || cell.state === 'unlistable-dir')) continue;
    const f = fixture();
    if (cell.absence) { covered.absent += 1; cell.absence.apply(f); }
    else applyState(cell.location.dirOf(f), cell.state, `Requirement-${cell.name.replace(/[^A-Za-z0-9]+/g, '-')}`, { fileName: cell.location.fileName });

    // Does this cell create an input the loader must report as unreadable?
    const problem = cell.state === 'dangling' || cell.state === 'unreadable-file' || cell.state === 'unlistable-dir';
    if (problem) covered.problem += 1;
    // The current change still declares its own scenarios in every cell but one: only removing the
    // whole `specs/` tree makes the staged check's NO_SPEC_SCEN the expected outcome. A broken extra
    // file next to a readable `cap/spec.md` is a problem, not an empty scenario set.
    const currentBroken = cell.absence?.name === 'no current specs/ dir';
    const label = `${cell.name} in ${f.dir}`;

    // Full modes against the base oracle.
    for (const json of [false, true]) {
      const baseRun = runFull(base, f.change, json);
      const tipRun = runFull(script('freeze-check.mjs'), f.change, json);
      const mode = json ? 'full --structural --json' : 'full --structural';
      if (!crashed(baseRun)) {
        covered.normalExit += 1;
        // Base handled this input normally: the new full run must not change one byte of it.
        assert.equal(tipRun.status, baseRun.status, `${label} (${mode}): exit`);
        assert.equal(tipRun.stdout, baseRun.stdout, `${label} (${mode}): stdout`);
        assert.equal(tipRun.stderr, baseRun.stderr, `${label} (${mode}): stderr`);
      } else {
        covered.crash += 1;
        // Base crashed: the tip must still fail closed, and --json must stay machine-readable.
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

    // Staged mode: no base equivalent. Absent input is not a problem, but a specs-only change with
    // no declared scenario is still NO_SPEC_SCEN; an unreadable input is always a block.
    for (const json of [false, true]) {
      const result = runStage(f.change, json);
      const mode = json ? 'stage --json' : 'stage';
      // A staging run passes when the change declares scenarios and every input was readable; it
      // fails on an unreadable input or on an empty declaration set.
      if (problem || currentBroken) assert.equal(result.status, 1, `${label} (${mode}): exit ${result.stdout}${result.stderr}`);
      else assert.equal(result.status, 0, `${label} (${mode}): exit ${result.stdout}${result.stderr}`);
      if (json) {
        const report = parseJson(result, `${label} (${mode})`);
        assert.equal(report.stage, 'specs', `${label} (${mode})`);
        if (problem) assert.ok(report.blocking.some((item) => item.startsWith('UNREADABLE_SPEC ')), `${label} (${mode}): ${report.blocking.join(' | ')}`);
        else assert.equal(report.blocking.some((item) => item.startsWith('UNREADABLE_SPEC ')), false, `${label} (${mode}): absent/empty is not a problem`);
        if (currentBroken) assert.ok(report.blocking.some((item) => item.startsWith('NO_SPEC_SCEN')), `${label} (${mode}): ${report.blocking.join(' | ')}`);
      }
      // Human mode mirrors the same policy: a pass only where the JSON says so.
      if (problem || currentBroken) assert.doesNotMatch(result.stdout, /RESULT specs ok/, `${label} (${mode})`);
    }

    // namespace.mjs: no base equivalent. It excludes the change being authored from the SOURCES it
    // counts, but a spec in that change that cannot be read is still reported: the author must see
    // that the free-range numbers they are about to rely on are incomplete.
    const namespaceProblem = problem;
    for (const json of [false, true]) {
      const result = runNamespace(f.change, json);
      const mode = json ? 'namespace --json' : 'namespace';
      if (json) {
        const report = parseJson(result, `${label} (${mode})`);
        if (namespaceProblem) {
          assert.equal(result.status, 1, `${label} (${mode}): exit`);
          assert.ok(report.unreadable.length > 0, `${label} (${mode}): unreadable entry`);
        } else {
          assert.equal(result.status, 0, `${label} (${mode}): exit ${result.stderr}`);
          assert.deepEqual(report.unreadable, [], `${label} (${mode})`);
        }
      } else if (namespaceProblem) {
        assert.equal(result.status, 1, `${label} (${mode}): exit`);
        assert.match(result.stdout, /Unreadable spec files or directories/, `${label} (${mode})`);
      } else {
        assert.equal(result.status, 0, `${label} (${mode}): exit ${result.stderr}`);
        assert.doesNotMatch(result.stdout, /Unreadable spec files or directories/, `${label} (${mode})`);
      }
    }
  }
  // Both base behaviours were compared, and every unreadable state was actually constructed.
  assert.ok(covered.normalExit > 0 && covered.crash > 0, `oracle branches: ${JSON.stringify(covered)}`);
  assert.equal(covered.absent, STRUCTURAL_ABSENCES.length, `absence cells: ${JSON.stringify(covered)}`);
  // Three locations × the three unreadable states; as root only the dangling-link state remains.
  assert.equal(covered.problem, isRoot ? LOCATIONS.length : LOCATIONS.length * 3, `unreadable cells: ${JSON.stringify(covered)}`);
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
  ];
  for (const { args, status } of cases) {
    const result = spawnSync('node', [script('freeze-check.mjs'), f.change, ...args], { encoding: 'utf8' });
    assert.equal(result.status, status, `${args.join(' ')}: ${result.stdout}${result.stderr}`);
    if (status === 2) assert.match(result.stderr, /Usage:/, args.join(' '));
  }
  // A positional after `--stage specs` is still not the change directory: the value was consumed.
  const trailing = spawnSync('node', [script('freeze-check.mjs'), f.change, '--structural', '--stage', 'specs', '--json'], { encoding: 'utf8' });
  assert.equal(JSON.parse(trailing.stdout).change, path.resolve(f.change));
});

test.after(() => {
  for (const cleanup of cleanups.reverse()) cleanup();
});
