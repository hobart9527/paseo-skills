import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MODEL, resolveModel, taskWeight, dispatchDeps, mergeDeps, verifyScope,
  nodeCost, weightedCriticalPath, weightedSpeedup, readyIds, simulate, regressionReplays, readsOnlyEdges,
} from '../lib/schedule.mjs';

const task = (over = {}) => ({
  id: 'T-01', depends: [], uses: [], scope: [], reads: [], est: 'M', kind: null, review: 'standard', ...over,
});

const dag = [
  task({ id: 'T-00', kind: 'skeleton', review: 'mechanical', est: 'S', scope: ['src/iface.ts'], interface: ['src/iface.ts#useDraft'] }),
  task({ id: 'T-01', scope: ['src/a.ts'] }),
  task({ id: 'T-02', scope: ['src/b.ts'], uses: ['T-00'], depends: ['T-00'] }),
  task({ id: 'T-03', scope: ['src/c.ts'], uses: ['T-02'] }),
  task({ id: 'T-04', scope: ['src/d.ts'], reads: ['src/shared'] , depends: ['T-02'] }),
];

test('default model matches the frozen contract and deep-merges overrides', () => {
  assert.deepEqual(DEFAULT_MODEL, {
    redMin: 20,
    implMin: { S: 15, M: 25, L: 45 },
    reviewMin: { strict: 30, standard: 25, deferred: 0, mechanical: 0 },
    reworkMin: 20,
    mergeMin: 5,
    regressionMinPerTask: 2,
    reviewerCap: 4,
    writerCap: 6,
    reworkRate: { strict: 0.35, standard: 0.2, deferred: 0.2, mechanical: 0 },
    minSpeedup: 1.8,
  });
  const resolved = resolveModel({ implMin: { M: 10 }, reviewerCap: 2 });
  assert.equal(resolved.implMin.M, 10);
  assert.equal(resolved.implMin.L, 45);
  assert.equal(resolved.reviewMin.strict, 30);
  assert.equal(resolved.reviewerCap, 2);
  assert.equal(resolved.writerCap, 6);
});

test('task weight maps S/M/L and defaults unknown to M', () => {
  assert.equal(taskWeight(task({ est: 'S' })), 1);
  assert.equal(taskWeight(task({ est: 'M' })), 2.5);
  assert.equal(taskWeight(task({ est: 'L' })), 5);
  assert.equal(taskWeight(task({ est: undefined })), 2.5);
});

test('dispatch waits for Uses skeleton ancestors but not the target implementation', () => {
  const ids = dispatchDeps(dag[3], dag).sort();
  // T-02 is a consumer of the skeleton; T-03 only needs the frozen interface.
  assert.deepEqual(ids, ['T-00']);
  assert.deepEqual(dispatchDeps(dag[2], dag).sort(), ['T-00']);
  // An explicit Depends on remains a dispatch edge; its own skeleton deps are transitively enforced.
  assert.deepEqual(dispatchDeps(dag[4], dag).sort(), ['T-02']);
});

test('merge waits for every Depends on and Uses target', () => {
  assert.deepEqual(mergeDeps(dag[3]).sort(), ['T-02']);
  assert.deepEqual(mergeDeps(dag[2]).sort(), ['T-00']);
  assert.deepEqual(mergeDeps(task({ depends: ['T-01'], uses: ['T-02', 'T-02'] })).sort(), ['T-01', 'T-02']);
});

test('verify scope is Write scope plus read-only anchors', () => {
  assert.deepEqual(verifyScope(dag[4]).sort(), ['src/d.ts', 'src/shared']);
  assert.deepEqual(verifyScope(task({ scope: ['a'] })), ['a']);
});

test('node cost includes red, implementation, review and expected rework', () => {
  assert.equal(nodeCost(task({ est: 'M', review: 'standard' }), DEFAULT_MODEL), 20 + 25 + 25 + 4);
  // Mechanical has no Red commit: simulate() starts it at implementation, so the
  // cost model must not charge redMin or the critical path disagrees with makespan.
  assert.equal(nodeCost(task({ est: 'S', kind: 'skeleton', review: 'mechanical' }), DEFAULT_MODEL), 15);
  assert.equal(nodeCost(task({ est: 'L', review: 'strict' }), DEFAULT_MODEL), 20 + 45 + 30 + 7);
  assert.equal(nodeCost(task({ est: 'M', review: 'deferred' }), DEFAULT_MODEL), 20 + 25 + 0 + 4);
  assert.equal(nodeCost(task({ est: 'M', review: 'standard' }), { implMin: { M: 10 } }), 20 + 10 + 25 + 4);
});

test('weighted critical path follows dispatch edges and weighted speedup is serial/path', () => {
  const chain = [task({ id: 'T-01', est: 'S' }), task({ id: 'T-02', depends: ['T-01'], est: 'M' })];
  const path = weightedCriticalPath(chain);
  assert.deepEqual(path.chain, ['T-01', 'T-02']);
  assert.equal(path.minutes, nodeCost(chain[0]) + nodeCost(chain[1]));
  assert.equal(weightedSpeedup(chain), Number((path.minutes / path.minutes).toFixed(2)));
  const parallel = [task({ id: 'T-01', est: 'M' }), task({ id: 'T-02', est: 'M' })];
  assert.deepEqual(weightedCriticalPath(parallel).chain, ['T-01']);
  assert.equal(weightedSpeedup(parallel), 2);
});

test('readyIds orders by remaining weighted path and puts skeleton first on ties', () => {
  const tasks = [
    task({ id: 'T-01', est: 'S' }),
    task({ id: 'T-02', est: 'S', review: 'mechanical' }),
    task({ id: 'T-03', kind: 'skeleton', est: 'S', review: 'mechanical' }),
    task({ id: 'T-04', depends: ['T-01'], est: 'L' }),
  ];
  const ready = readyIds(tasks, []);
  // T-01 carries the L downstream task; the skeleton wins the tie against T-02 at depth 0.
  assert.deepEqual(ready, ['T-01', 'T-03', 'T-02']);
  assert.deepEqual(readyIds(tasks, ['T-00']).includes('T-04'), false);
  assert.deepEqual(readyIds(tasks, ['T-01']).includes('T-04'), true);
});

test('simulate is deterministic and reports phases plus a critical chain', () => {
  const first = simulate(dag, { policy: 'converged' });
  const second = simulate(dag, { policy: 'converged' });
  assert.deepEqual(first, second);
  assert.ok(first.makespan > 0);
  assert.ok(first.phases.some((phase) => phase.id === 'T-00' && phase.phase === 'impl'));
  assert.deepEqual(first.criticalChain[0], 'T-00');
  assert.deepEqual(simulate(dag, { policy: 'legacy' }), simulate(dag, { policy: 'legacy' }));
});

test('converged scheduling beats the legacy serial-review model on a 6-task DAG', () => {
  const tasks = [
    task({ id: 'T-00', kind: 'skeleton', review: 'mechanical', est: 'S', scope: ['src/iface.ts'] }),
    task({ id: 'T-01', depends: ['T-00'], scope: ['src/a.ts'] }),
    task({ id: 'T-02', depends: ['T-00'], scope: ['src/b.ts'] }),
    task({ id: 'T-03', depends: ['T-00'], scope: ['src/c.ts'] }),
    task({ id: 'T-04', depends: ['T-00'], scope: ['src/d.ts'] }),
    task({ id: 'T-05', depends: ['T-01', 'T-02', 'T-03', 'T-04'], scope: ['src/e.ts'] }),
  ];
  const legacy = simulate(tasks, { policy: 'legacy' });
  const converged = simulate(tasks, { policy: 'converged' });
  assert.ok(converged.makespan < legacy.makespan, `${converged.makespan} !< ${legacy.makespan}`);
  assert.ok(converged.phases.some((phase) => phase.id === 'FINAL'), 'deferred review runs once at FINAL');
  assert.ok(!legacy.phases.some((phase) => phase.id === 'FINAL'));
});

test('simulate honours model overrides', () => {
  const slow = simulate(dag, { policy: 'converged', model: { implMin: { M: 100 } } });
  const fast = simulate(dag, { policy: 'converged', model: { implMin: { M: 5 } } });
  assert.ok(slow.makespan > fast.makespan);
});

test('merge charges regression replay under both policies', () => {
  // `merge-task` replays already-Done overlapping Verify legs whichever policy scheduled
  // the DAG, so a model that charges it only to converged overstates the converged gain.
  const model = { redMin: 0, implMin: { S: 10 }, reviewMin: { standard: 0 }, reworkRate: { standard: 0 }, mergeMin: 0, regressionMinPerTask: 3 };
  const overlapping = [
    task({ id: 'T-01', est: 'S', scope: ['src/shared'] }),
    task({ id: 'T-02', est: 'S', scope: ['src/shared/b.ts'] }),
  ];
  const disjoint = [
    task({ id: 'T-01', est: 'S', scope: ['src/a/a.ts'] }),
    task({ id: 'T-02', est: 'S', scope: ['src/b/b.ts'] }),
  ];
  for (const policy of ['legacy', 'converged']) {
    assert.equal(simulate(disjoint, { policy, model }).makespan, 10, `${policy} disjoint`);
    assert.equal(simulate(overlapping, { policy, model }).makespan, 13, `${policy} overlapping`);
  }
});

test('regressionReplays is the gate rule: changed paths vs the prior Verify surface', () => {
  const priorReads = task({ id: 'T-01', scope: ['test/prior.test.mjs'], reads: ['src/a.txt'] });
  const priorOwns = task({ id: 'T-02', scope: ['src/shared'] });
  const priorElsewhere = task({ id: 'T-03', scope: ['lib'] });
  const merging = task({ id: 'T-09', scope: ['src/a.txt', 'src/shared/b.ts'] });
  // Reads participates: T-01 observes src/a.txt even though it only writes a test file.
  assert.deepEqual(regressionReplays(merging, [priorReads, priorOwns, priorElsewhere]), ['T-01', 'T-02']);
  // Ancestry is not a trigger, and a task cannot replay itself.
  assert.deepEqual(regressionReplays(merging, [priorElsewhere, merging]), []);
  // The gate passes the real diff; an empty diff replays nothing.
  assert.deepEqual(regressionReplays(merging, [priorReads], []), []);
  assert.deepEqual(regressionReplays(merging, [priorReads], ['docs/readme.md']), []);
});

test('readsOnlyEdges names explicit Depends on edges carried only by a shared fixture', () => {
  const fixture = 'scripts/specs/fixture.mjs';
  const shared = task({ id: 'T-01', scope: ['src/a'], reads: [fixture] });
  const consumer = task({ id: 'T-02', scope: ['src/b'], reads: [fixture], depends: ['T-01'] });
  const sink = task({ id: 'T-03', scope: ['src/c'], reads: [fixture], depends: ['T-02'], review: 'mechanical' });
  assert.deepEqual(readsOnlyEdges([shared, consumer, sink]), [{ task: 'T-02', dep: 'T-01', shared: [fixture] }]);
  // An overlapping Write scope is a real serialisation edge. The `sink` above is skipped
  // because the integration point cannot dispatch early whatever its Reads say.
  const writes = task({ ...consumer, scope: ['src/a/b'] });
  assert.deepEqual(readsOnlyEdges([shared, writes, sink]), []);
  // `Uses` is a dispatch/merge edge with its own rule; this advisory only judges Depends on.
  const viaUses = task({ ...consumer, depends: [], uses: ['T-01'] });
  assert.deepEqual(readsOnlyEdges([shared, viaUses, sink]), []);
});

test('waves use dispatch dependencies including Uses skeleton ancestors', async () => {
  const { computeWaves } = await import('../lib/tasks.mjs');
  const chain = [
    task({ id: 'T-00', kind: 'skeleton' }), task({ id: 'T-01', uses: ['T-00'] }),
    task({ id: 'T-02', depends: ['T-01'] }), task({ id: 'T-03', depends: ['T-02'] }),
  ];
  assert.deepEqual([...computeWaves(chain).values()], [['T-00'], ['T-01'], ['T-02'], ['T-03']]);
  const concurrent = [chain[0], task({ id: 'T-01', uses: ['T-00'] }), task({ id: 'T-02', uses: ['T-00'] })];
  assert.deepEqual([...computeWaves(concurrent).values()], [['T-00'], ['T-01', 'T-02']]);
});

test('live weights exclude historical Red and per-task review without changing benchmark defaults', async () => {
  const { LIVE_MODEL } = await import('../lib/schedule.mjs');
  assert.equal(nodeCost(task({ est: 'M', review: 'strict' }), LIVE_MODEL), DEFAULT_MODEL.implMin.M);
  assert.equal(nodeCost(task({ est: 'M', review: 'standard' })), 74);
});
