// Benchmark fixtures are mechanism output, not authored files.
//
// `baseline-tasks.md` is the real frozen DAG and the source of truth; `converged-tasks.md`
// is `derive.mjs`'s rendering of it. Both must pass the pipeline's own `freeze-check
// --structural`, because a fixture the pipeline would refuse to freeze must never produce
// an efficiency number. A hand edit to the converged file (for example, rewriting
// `Depends on:` as `Uses:` without declaring an `Interface:`) fails here rather than
// silently inflating the benchmark.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const bench = path.resolve(here, '../../../benchmarks/pipeline');
const { derive } = await import(path.join(bench, 'derive.mjs'));
const { checkContract } = await import(path.join(bench, 'contract-check.mjs'));
const { simulate } = await import('../lib/schedule.mjs');
const { parseTasks } = await import('../lib/tasks.mjs');

const baseline = fs.readFileSync(path.join(bench, 'baseline-tasks.md'), 'utf8');
const converged = fs.readFileSync(path.join(bench, 'converged-tasks.md'), 'utf8');

test('converged-tasks.md is the derivation of baseline-tasks.md', () => {
  const result = derive(baseline);
  assert.equal(converged, result.markdown,
    'converged-tasks.md drifted from derive.mjs; run `node benchmarks/pipeline/derive.mjs --write`');
});

test('every benchmark contract freezes under the pipeline gate', () => {
  for (const [name, markdown] of [['baseline', baseline], ['converged', converged]]) {
    const result = checkContract(markdown, `bench-${name}`);
    assert.equal(result.ok, true, `${name} rejected by freeze-check --structural:\n${result.output}`);
  }
});

test('a hand-written Uses without Interface is rejected, so the benchmark cannot relabel edges', () => {
  // The exact edit the earlier fixture made by hand: T-04 Uses T-05 while T-05 declares nothing.
  const tampered = converged.replace(
    /(- \[ \] \S+ T-04[^\n]*\n(?:  - [^\n]*\n)*?  - )Depends on: ([^\n]+)/,
    '$1Uses: T-05\n  - Depends on: $2',
  );
  assert.notEqual(tampered, converged, 'tamper target not found; update this test with the fixture');
  const result = checkContract(tampered, 'bench-tampered');
  assert.equal(result.ok, false);
  assert.match(result.output, /USES_WITHOUT_INTERFACE/);
});

test('the reported improvement is what the shared model computes', () => {
  const legacyTasks = parseTasks(baseline).tasks;
  const convergedTasks = parseTasks(converged).tasks;
  const legacy = simulate(legacyTasks, { policy: 'legacy' }).makespan;
  const modern = simulate(convergedTasks, { policy: 'converged' }).makespan;
  // No threshold: the point is that the number is derived, and the README copies this one.
  assert.ok(modern > 0 && legacy > modern, `legacy ${legacy} -> converged ${modern}`);
});
