// Pure scheduling model for the frozen DAG. No fs, no process, no clock, no randomness:
// every number here is an expectation, so two runs on the same contract are identical.

export const DEFAULT_MODEL = {
  redMin: 20,
  implMin: { S: 15, M: 25, L: 45 },
  reviewMin: { strict: 30, standard: 25, deferred: 0, mechanical: 0 },
  reworkMin: 20,
  mergeMin: 5,
  regressionMinPerTask: 2,
  reviewerCap: 4,
  writerCap: 6,
  reworkRate: { strict: 0.35, standard: 0.2, deferred: 0.2, mechanical: 0 },
};

export function resolveModel(model = {}) {
  return {
    ...DEFAULT_MODEL,
    ...model,
    implMin: { ...DEFAULT_MODEL.implMin, ...(model.implMin || {}) },
    reviewMin: { ...DEFAULT_MODEL.reviewMin, ...(model.reviewMin || {}) },
    reworkRate: { ...DEFAULT_MODEL.reworkRate, ...(model.reworkRate || {}) },
  };
}

const byId = (tasks) => new Map(tasks.map((task) => [task.id, task]));
const estOf = (task) => (['S', 'M', 'L'].includes(task.est) ? task.est : 'M');
const reviewOf = (task) => (task.kind === 'skeleton' ? 'mechanical' : task.review || 'standard');

export function taskWeight(task) {
  return { S: 1, M: 2.5, L: 5 }[estOf(task)];
}

/** Dispatch readiness edges: explicit Depends on plus the skeleton ancestors of every Uses target. */
export function dispatchDeps(task, tasks) {
  const known = byId(tasks);
  const out = new Set(task.depends || []);
  for (const target of task.uses || []) {
    const stack = [target];
    const seen = new Set();
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      const node = known.get(id);
      if (!node) continue;
      if (node.kind === 'skeleton') out.add(id);
      for (const next of [...(node.depends || []), ...(node.uses || [])]) stack.push(next);
    }
  }
  out.delete(task.id);
  return [...out];
}

/** Merge gate edges: a Uses target's implementation must be merged before the consumer. */
export function mergeDeps(task) {
  return [...new Set([...(task.depends || []), ...(task.uses || [])])];
}

/** Paths a Verify leg may name: Write scope plus read-only anchors. Reads never authorise edits. */
export function verifyScope(task) {
  return [...new Set([...(task.scope || []), ...(task.reads || [])])];
}

export function nodeCost(task, model) {
  const resolved = resolveModel(model);
  const review = reviewOf(task);
  const impl = resolved.implMin[estOf(task)] ?? resolved.implMin.M;
  // `Review: mechanical` has no Red commit, in either policy (see simulate's activate()).
  // Charging redMin here made the critical path disagree with the simulated makespan for
  // the same DAG and overstated a skeleton's cost by redMin.
  const red = review === 'mechanical' ? 0 : resolved.redMin;
  const inlineReview = resolved.reviewMin[review] ?? 0;
  const rework = (resolved.reworkRate[review] ?? 0) * resolved.reworkMin;
  return red + impl + inlineReview + rework;
}

function criticalPath(tasks, depFn, model) {
  const resolved = resolveModel(model);
  const known = byId(tasks);
  const memo = new Map();
  const visiting = new Set();
  const solve = (task) => {
    if (memo.has(task.id)) return memo.get(task.id);
    if (visiting.has(task.id)) return { minutes: nodeCost(task, resolved), chain: [task.id] };
    visiting.add(task.id);
    let best = { minutes: 0, chain: [] };
    for (const dep of depFn(task, tasks)) {
      const node = known.get(dep);
      if (!node || node.id === task.id) continue;
      const sub = solve(node);
      if (sub.minutes > best.minutes) best = sub;
    }
    visiting.delete(task.id);
    const result = { minutes: best.minutes + nodeCost(task, resolved), chain: [...best.chain, task.id] };
    memo.set(task.id, result);
    return result;
  };
  let best = { minutes: 0, chain: [] };
  for (const task of tasks) {
    const result = solve(task);
    if (result.minutes > best.minutes) best = result;
  }
  return best;
}

export function weightedCriticalPath(tasks, model) {
  return criticalPath(tasks, dispatchDeps, model);
}

export function weightedSpeedup(tasks, model) {
  const resolved = resolveModel(model);
  const serial = tasks.reduce((sum, task) => sum + nodeCost(task, resolved), 0);
  const path = weightedCriticalPath(tasks, resolved).minutes;
  return path > 0 ? Number((serial / path).toFixed(2)) : 0;
}

// Longest path starting at each task over a dependency function, used to order the ready frontier
// (longest downstream first) without re-walking the graph per comparison.
function remainingWeights(tasks, depFn, model) {
  const resolved = resolveModel(model);
  const known = byId(tasks);
  const dependents = new Map(tasks.map((task) => [task.id, []]));
  for (const task of tasks) {
    for (const dep of depFn(task, tasks)) {
      if (dependents.has(dep)) dependents.get(dep).push(task.id);
    }
  }
  const memo = new Map();
  const visiting = new Set();
  const remaining = (id) => {
    if (memo.has(id)) return memo.get(id);
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let downstream = 0;
    for (const next of dependents.get(id) || []) downstream = Math.max(downstream, remaining(next));
    visiting.delete(id);
    const value = nodeCost(known.get(id), resolved) + downstream;
    memo.set(id, value);
    return value;
  };
  const values = new Map(tasks.map((task) => [task.id, remaining(task.id)]));
  return values;
}

export function readyIds(tasks, doneIds, model) {
  const done = new Set(doneIds);
  const known = byId(tasks);
  const remaining = remainingWeights(tasks, dispatchDeps, model);
  return tasks
    .filter((task) => !done.has(task.id) && dispatchDeps(task, tasks).every((dep) => !known.has(dep) || done.has(dep)))
    .sort((a, b) => (remaining.get(b.id) - remaining.get(a.id))
      || (a.kind === 'skeleton' ? -1 : b.kind === 'skeleton' ? 1 : 0)
      || a.id.localeCompare(b.id))
    .map((task) => task.id);
}

const pathWithin = (a, b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

/**
 * Which already-Done tasks `merge-task` replays when `task` merges. Single owner: the gate
 * imports this list, and the cost model charges exactly the same count.
 *
 * A prior task is replayed when its Verify can observe something this merge touches. The
 * prior's Verify surface is its Write scope plus `Reads`; the merging side is the changed
 * files plus the merging task's `Reads`.
 *
 * Both halves matter. `Reads` on the prior side catches a Verify that asserts on a file
 * someone else writes. `Reads` on the merging side catches a shared read-only fixture: a
 * spec script both tasks execute may read the merging task's files without naming them in
 * any scope (the `payee-company-scope.mjs` shape), and no Write-scope comparison can see
 * that. Ancestry is deliberately not a trigger: a dependent that writes only its own files
 * cannot break its ancestor's Verify.
 *
 * `changedFiles` defaults to the task's Write scope, which is the model's upper bound; the
 * gate passes the merge's real diff and therefore replays no more than that bound.
 */
export function regressionReplays(task, doneTasks, changedFiles = null) {
  const changed = changedFiles ?? task.scope ?? [];
  const surfaces = [...new Set([...changed, ...(task.reads || [])])].filter(Boolean);
  if (!surfaces.length) return [];
  return doneTasks
    .filter((prior) => prior.id !== task.id)
    .filter((prior) => verifyScope(prior).some((a) => surfaces.some((b) => pathWithin(a, b))))
    .map((prior) => prior.id);
}

export function simulate(tasks, { policy = 'legacy', model } = {}) {
  const resolved = resolveModel(model);
  const converged = policy === 'converged';
  const known = byId(tasks);
  const depFn = converged ? dispatchDeps : (task) => task.depends || [];
  const mergeDepFn = converged ? mergeDeps : (task) => task.depends || [];
  const writerCap = converged ? resolved.writerCap : 4;
  const reviewerCap = converged ? resolved.reviewerCap : 2;
  const remaining = remainingWeights(tasks, depFn, resolved);
  const done = new Set();
  const activated = new Set();
  const workQueue = [];
  const reviewQueue = [];
  const mergeQueue = [];
  const finalBatch = new Set();
  const phases = [];
  const running = [];
  let writerBusy = 0;
  let reviewerBusy = 0;
  let mergeFreeAt = 0;
  let now = 0;
  let seq = 0;

  const depsDone = (task) => depFn(task, tasks).every((dep) => !known.has(dep) || done.has(dep));
  const canMerge = (task) => mergeDepFn(task).every((dep) => !known.has(dep) || done.has(dep));
  const priority = (id) => (converged && known.get(id)?.kind === 'skeleton' ? -1 : 0);
  const byPriority = (a, b) => (priority(a.id ?? a) - priority(b.id ?? b))
    || (remaining.get(b.id ?? b) - remaining.get(a.id ?? a))
    || (a.id ?? a).localeCompare(b.id ?? b);

  const reworkMinutes = (task) => (resolved.reworkRate[reviewOf(task)] ?? 0) * resolved.reworkMin;
  const advance = (id, stage, minutes) => {
    if (minutes <= 0) return finishStage(id, stage);
    phases.push({ at: now, id, phase: stage });
    writerBusy += 1;
    running.push({ seq: seq++, id, phase: stage, resource: 'writer', endAt: now + minutes });
  };
  const startReview = (id, minutes) => {
    if (minutes <= 0) return afterReview(id);
    phases.push({ at: now, id, phase: 'review' });
    reviewerBusy += 1;
    running.push({ seq: seq++, id, phase: 'review', resource: 'reviewer', endAt: now + minutes });
  };
  const enqueueMerge = (id) => {
    const task = known.get(id);
    if (converged && ['standard', 'deferred'].includes(reviewOf(task))) finalBatch.add(id);
    mergeQueue.push(id);
  };
  const afterReview = (id) => {
    if (reworkMinutes(known.get(id)) > 0) {
      workQueue.push({ id, stage: 'rework', minutes: reworkMinutes(known.get(id)) });
      return;
    }
    enqueueMerge(id);
  };
  const afterImpl = (id) => {
    const task = known.get(id);
    const review = reviewOf(task);
    const reviewMinutes = resolved.reviewMin[review] ?? 0;
    if (!converged && reviewMinutes > 0) {
      reviewQueue.push({ id, minutes: reviewMinutes });
      return;
    }
    if (converged && review === 'strict') {
      reviewQueue.push({ id, minutes: reviewMinutes });
      return;
    }
    afterReview(id);
  };
  const finishStage = (id, stage) => {
    if (stage === 'red') workQueue.push({ id, stage: 'impl', minutes: resolved.implMin[estOf(known.get(id))] ?? resolved.implMin.M });
    else if (stage === 'impl') afterImpl(id);
    else if (stage === 'rework') enqueueMerge(id);
    else afterReview(id);
  };
  const activate = () => {
    for (const task of tasks) {
      if (activated.has(task.id) || !depsDone(task)) continue;
      activated.add(task.id);
      const first = reviewOf(task) === 'mechanical' ? 'impl' : 'red';
      workQueue.push({ id: task.id, stage: first, minutes: first === 'red' ? resolved.redMin : (resolved.implMin[estOf(task)] ?? resolved.implMin.M) });
    }
  };
  const dispatchWork = () => {
    while (writerBusy < writerCap && workQueue.length) {
      const entry = workQueue.sort(byPriority).shift();
      advance(entry.id, entry.stage, entry.minutes);
    }
  };
  const dispatchReviews = () => {
    while (reviewerBusy < reviewerCap && reviewQueue.length) {
      const entry = reviewQueue.sort(byPriority).shift();
      startReview(entry.id, entry.minutes);
    }
  };
  const mergeCost = (task) => {
    // `merge-task` replays already-Done tasks whose Verify can observe a file this merge
    // writes, under either policy (the code has no policy branch). The model charges the
    // same set through `regressionReplays`, so the two cannot drift.
    const regressions = regressionReplays(task, [...done].map((id) => known.get(id)).filter(Boolean)).length;
    return resolved.mergeMin + resolved.regressionMinPerTask * regressions;
  };
  const pumpMerges = () => {
    if (running.some((event) => event.resource === 'merge')) return;
    while (mergeQueue.length) {
      const ready = mergeQueue.filter((id) => canMerge(known.get(id)));
      if (!ready.length) return;
      const id = ready.sort(byPriority)[0];
      mergeQueue.splice(mergeQueue.indexOf(id), 1);
      const start = Math.max(now, mergeFreeAt);
      const end = start + mergeCost(known.get(id));
      phases.push({ at: start, id, phase: 'merge' });
      mergeFreeAt = end;
      running.push({ seq: seq++, id, phase: 'merge', resource: 'merge', endAt: end });
      return;
    }
  };

  activate();
  while (true) {
    dispatchWork();
    dispatchReviews();
    pumpMerges();
    if (!running.length) break;
    now = Math.min(...running.map((event) => event.endAt));
    const finished = running.filter((event) => event.endAt === now).sort((a, b) => a.seq - b.seq);
    for (const event of finished) running.splice(running.indexOf(event), 1);
    for (const event of finished) {
      if (event.resource === 'writer') writerBusy -= 1;
      else if (event.resource === 'reviewer') reviewerBusy -= 1;
      if (event.phase === 'merge') done.add(event.id);
      else finishStage(event.id, event.phase);
    }
    activate();
  }

  let makespan = now;
  if (converged && finalBatch.size) {
    const finalReview = Math.max(...[...finalBatch].map((id) => resolved.reviewMin[reviewOf(known.get(id))] ?? 0));
    if (finalReview > 0) {
      phases.push({ at: makespan, id: 'FINAL', phase: 'review' });
      makespan += finalReview;
    }
  }
  phases.sort((a, b) => (a.at - b.at) || a.id.localeCompare(b.id) || a.phase.localeCompare(b.phase));
  return {
    makespan: Number(makespan.toFixed(2)),
    phases,
    criticalChain: criticalPath(tasks, depFn, resolved).chain,
  };
}
