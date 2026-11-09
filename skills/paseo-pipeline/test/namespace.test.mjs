import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../namespace.mjs', import.meta.url));

function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'namespace-'));
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
  const git = spawnSync('git', ['-C', dir, 'init', '-q', '-b', 'main'], { encoding: 'utf8' });
  assert.equal(git.status, 0, git.stderr);
  return dir;
}
// `root` is the repository; the script always receives the change being authored.
const changeDirOf = (root) => path.join(root, 'openspec', 'changes', 'current');
const run = (root, args = []) => spawnSync(process.execPath, [script, changeDirOf(root), ...args], { encoding: 'utf8' });

// Baseline uses SCEN-PAD-01..04 and SCEN-BASE-01; two active changes add to PAD and a third
// change (the current one) is the caller.
const repo = () => fixture({
  'openspec/specs/payee/spec.md': '## Requirements\n#### Scenario: SCEN-PAD-01 baseline billing\n## REMOVED Requirements\n### Requirement: 收款人名录\n#### Scenario: SCEN-PAD-04 removed form\n',
  'openspec/specs/base/spec.md': '## Requirements\n#### Scenario: SCEN-BASE-01 one\n',
  'openspec/changes/other/specs/payee/spec.md': '## ADDED Requirements\n### Requirement: 收款人档案只读浏览\n#### Scenario: SCEN-PAD-05 other view\n## REMOVED Requirements\n### Requirement: 收款人名录与报销单双向数据沉淀\n#### Scenario: SCEN-PAD-06 other removal\n',
  'openspec/changes/third/specs/payee/spec.md': '## MODIFIED Requirements\n### Requirement: 收款人档案只读浏览\n#### Scenario: SCEN-PAD-07 third view\n',
  'openspec/changes/current/specs/payee/spec.md': '## ADDED Requirements\n### Requirement: 本 change\n#### Scenario: SCEN-PAD-08 mine\n',
});

test('computes the next free number per prefix across baseline and other active changes', () => {
  const dir = repo();
  const result = run(dir, ['--json']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  const pad = report.scenarios.find((entry) => entry.prefix === 'PAD');
  assert.equal(pad.max, 7);
  assert.equal(pad.next, 8);
  assert.equal(pad.occurrences, 5);
  assert.deepEqual(pad.sources.map((source) => [source.kind, source.name]), [['baseline', 'baseline'], ['change', 'other'], ['change', 'third']]);
  assert.deepEqual(pad.sources[0].ids, ['SCEN-PAD-01', 'SCEN-PAD-04']);
  const base = report.scenarios.find((entry) => entry.prefix === 'BASE');
  assert.deepEqual([base.max, base.next], [1, 2]);
});

test('excludes the change being authored, by existing directory and by name when it does not exist', () => {
  const dir = repo();
  const byDir = JSON.parse(run(dir, ['--json']).stdout);
  const pad = byDir.scenarios.find((entry) => entry.prefix === 'PAD');
  assert.equal(pad.sources.some((source) => source.name === 'current'), false);
  assert.equal(pad.ids.includes('SCEN-PAD-08'), false);
  // Specs-first: the change directory does not exist yet, so exclusion runs by name.
  const missing = path.join(dir, 'openspec', 'changes', 'current');
  const before = fs.readFileSync(path.join(missing, 'specs/payee/spec.md'), 'utf8');
  fs.rmSync(missing, { recursive: true });
  try {
    const byName = JSON.parse(spawnSync(process.execPath, [script, missing, '--json'], { encoding: 'utf8' }).stdout);
    const entries = byName.scenarios.find((entry) => entry.prefix === 'PAD');
    assert.equal(entries.sources.some((source) => source.name === 'current'), false);
    assert.equal(entries.ids.includes('SCEN-PAD-08'), false);
  } finally {
    fs.mkdirSync(path.dirname(path.join(missing, 'specs/payee/spec.md')), { recursive: true });
    fs.writeFileSync(path.join(missing, 'specs/payee/spec.md'), before);
  }
});

test('lists requirement sections other active changes touch, per capability', () => {
  const dir = repo();
  const report = JSON.parse(run(dir, ['--json']).stdout);
  const payee = report.capabilities.find((entry) => entry.capability === 'payee');
  assert.ok(payee);
  const other = payee.changes.find((change) => change.change === 'other');
  assert.deepEqual(other.sections.ADDED, ['收款人档案只读浏览']);
  assert.deepEqual(other.sections.REMOVED, ['收款人名录与报销单双向数据沉淀']);
  const third = payee.changes.find((change) => change.change === 'third');
  assert.deepEqual(third.sections.MODIFIED, ['收款人档案只读浏览']);
  // The current change's own requirements are excluded, baseline requirements are not deltas.
  assert.equal(payee.changes.some((change) => change.change === 'current'), false);
  assert.equal(report.capabilities.some((entry) => entry.capability === 'base'), false);
});

test('lists non-standard ids under unparsed without crashing or inventing a range', () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, 'openspec/changes/other/specs/payee/spec.md'),
    `${fs.readFileSync(path.join(dir, 'openspec/changes/other/specs/payee/spec.md'), 'utf8')}#### Scenario: SCEN-MDF-03B letter suffix\n#### Scenario: SCEN-NO-NUMBER\n`);
  const result = run(dir, ['--json']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.unparsed.map((entry) => entry.id).sort(), ['SCEN-MDF-03B', 'SCEN-NO-NUMBER']);
  assert.equal(report.scenarios.some((entry) => entry.prefix === 'MDF'), false);
});

test('human output stays compact and names the sources', () => {
  const dir = repo();
  const result = run(dir);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.split('\n').length < 60, 'compact');
  assert.match(result.stdout, /SCEN-PAD\s+max=7 next=8/);
  assert.match(result.stdout, /payee:.*other \[ADDED: 收款人档案只读浏览 \| REMOVED: 收款人名录与报销单双向数据沉淀\]/);
});

test('is read-only and rejects unknown flags', () => {
  const dir = repo();
  const before = spawnSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' }).stdout;
  run(path.join(dir, 'openspec', 'changes', 'current'));
  run(path.join(dir, 'openspec', 'changes', 'current'), ['--json']);
  const after = spawnSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' }).stdout;
  assert.equal(after, before);
  assert.equal(run(path.join(dir, 'openspec', 'changes', 'current'), ['--bogus']).status, 2);
});

test('a change outside a git repository is a usage error, not a crash', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'namespace-nogit-'));
  fs.mkdirSync(path.join(dir, 'openspec', 'changes', 'x'), { recursive: true });
  const result = run(path.join(dir, 'openspec', 'changes', 'x'));
  assert.equal(result.status, 2);
  assert.match(result.stderr, /not inside a git repository/);
});

test('an unreadable spec is reported, never silently skipped, and makes the exit status nonzero', () => {
  const dir = repo();
  const dangling = path.join(dir, 'openspec/changes/other/specs/payee/dangling.md');
  fs.symlinkSync(path.join(dir, 'missing-target.md'), dangling);
  try {
    const human = run(dir);
    assert.equal(human.status, 1, human.stdout + human.stderr);
    assert.match(human.stdout, /Unreadable spec files or directories \(1/);
    assert.match(human.stdout, /openspec\/changes\/other\/specs\/payee\/dangling\.md/);
    assert.match(human.stdout, /SCEN-PAD/);
    const machine = run(dir, ['--json']);
    assert.equal(machine.status, 1);
    const report = JSON.parse(machine.stdout);
    assert.deepEqual(report.unreadable.map((entry) => entry.file), ['openspec/changes/other/specs/payee/dangling.md']);
  } finally { fs.rmSync(dangling, { force: true }); }
  // The same repo without the dangling link is clean again.
  assert.equal(run(dir).status, 0);
});

test('an unlistable baseline directory is reported too, not silently scanned as empty', () => {
  const dir = repo();
  const locked = path.join(dir, 'openspec/specs/locked');
  fs.mkdirSync(locked, { recursive: true });
  fs.writeFileSync(path.join(locked, 'spec.md'), '## Requirements\n#### Scenario: SCEN-PAD-99 locked\n');
  fs.chmodSync(locked, 0o000);
  try {
    const human = run(dir);
    assert.equal(human.status, 1, human.stdout + human.stderr);
    assert.match(human.stdout, /Unreadable spec files or directories \(1/);
    assert.match(human.stdout, /openspec\/specs\/locked\//);
    const machine = run(dir, ['--json']);
    assert.equal(machine.status, 1);
    const report = JSON.parse(machine.stdout);
    assert.deepEqual(report.unreadable.map((entry) => entry.file), ['openspec/specs/locked/']);
    // The locked scenario was never counted, so the range is honest about what it did not see.
    const pad = report.scenarios.find((entry) => entry.prefix === 'PAD');
    assert.equal(pad.max, 7);
  } finally { fs.chmodSync(locked, 0o755); }
});
