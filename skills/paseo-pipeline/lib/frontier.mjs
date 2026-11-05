// Pure frontier computation: graph + observed state -> deterministic next actions.
// No I/O, no dispatch, no ledger. The main session executes the list; git and Paseo
// stay the only state (SKILL.md principle 5).
//
// One track: a ready task gets a worker; a branch with commits merges as soon as its
// merge dependencies are Done. There is no test-author dispatch and no per-task reviewer.
import { dispatchDeps, mergeDeps, readyIds, pathWithin, LIVE_MODEL } from './schedule.mjs';
import { normalizeScope } from './tasks.mjs';

const WORKER_ROLES = new Set(['gongbu', 'gaogong', 'jiangzuo']);
const active = (agent) => agent.status === 'running' || agent.status === 'initializing' || agent.pendingPermissions;

export const DEFAULTS = {
  workerCap: 8,
  idleMinutes: 15,
  maxAttempts: 3,
};

function scopesOverlap(left, right) {
  return left.scope.some((scope) => right.scope.some((other) => {
    const a = normalizeScope(scope);
    const b = normalizeScope(other);
    return Boolean(a && b) && pathWithin(a, b);
  }));
}

function ancestorSet(byId) {
  const cache = new Map();
  const of = (id, trail = new Set()) => {
    if (cache.has(id)) return cache.get(id);
    const out = new Set();
    if (!trail.has(id)) {
      trail.add(id);
      for (const dep of byId.get(id)?.depends ?? []) {
        out.add(dep);
        for (const item of of(dep, trail)) out.add(item);
      }
    }
    cache.set(id, out);
    return out;
  };
  return (id) => of(id);
}

/** Branches for one task: `attempts` counts `T`, `T-a2`, ... */
export function attemptsOf(taskId, branches = {}) {
  return branches[taskId]?.attempts ?? 0;
}

/**
 * @param {Array} tasks parsed tasks.md tasks
 * @param {object} state { done: string[], agents: [], branches: {}, now?: Date|string }
 * @param {object} options { workerCap, idleMinutes, maxAttempts }
 */
export function frontier(tasks, state = {}, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const done = new Set(state.done || []);
  const allAgents = (state.agents || []).filter(Boolean);
  const agents = allAgents.filter((agent) => agent.status !== 'closed');
  const branches = state.branches || {};
  const now = state.now ? new Date(state.now).getTime() : Date.now();
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const ancestors = ancestorSet(byId);
  const open = tasks.filter((task) => !done.has(task.id));

  const runningWorkers = agents.filter((agent) => WORKER_ROLES.has(agent.role) && active(agent));
  const capacity = {
    workers: { used: new Set(runningWorkers.map((agent) => agent.task).filter(Boolean)).size, cap: opts.workerCap },
  };

  const attention = [];
  for (const agent of agents) {
    const task = agent.task;
    if (task && !byId.has(task)) {
      attention.push({ task, agent: agent.id, kind: 'STALE_LABEL', reason: `${task} is not in tasks.md` });
      continue;
    }
    if (task && done.has(task) && active(agent)) {
      attention.push({ task, agent: agent.id, kind: 'DONE_AGENT_RUNNING', reason: `${task} is Done but ${agent.role || 'an agent'} still runs` });
      continue;
    }
    if (agent.pendingPermissions) {
      attention.push({ task, agent: agent.id, kind: 'PENDING_PERMISSION', reason: 'agent is blocked on a permission prompt' });
      continue;
    }
    if (agent.status === 'idle' && agent.updatedAt) {
      const idleMin = (now - new Date(agent.updatedAt).getTime()) / 60000;
      if (Number.isFinite(idleMin) && idleMin >= opts.idleMinutes) {
        attention.push({ task, agent: agent.id, kind: 'IDLE_NO_RESULT', reason: `idle ${Math.floor(idleMin)} min with no finish result` });
      }
    }
  }

  const waiting = [];
  const blocked = [];
  const ready = [];
  for (const task of open) {
    const unmet = dispatchDeps(task, tasks).filter((id) => !done.has(id));
    if (unmet.length) {
      waiting.push({ task: task.id, on: unmet.sort() });
      continue;
    }
    const attempts = attemptsOf(task.id, branches);
    if (attempts > opts.maxAttempts) {
      blocked.push({ task: task.id, kind: 'BLOCKED_ATTEMPTS', reason: `${attempts} branches; cap is ${opts.maxAttempts}` });
      continue;
    }
    // A live worker on the same files would race. Depends-on pairs are serialised by
    // the unmet check above; Uses pairs can overlap only when freeze-check allowed it.
    const branch = branches[task.id] || {};
    const ownCommits = branch.ownCommits ?? (branch.attempts ? 1 : 0);
    const overlap = open.some((other) => other.id !== task.id
      && !ancestors(task.id).has(other.id) && !ancestors(other.id).has(task.id)
      && scopesOverlap(task, other)
      && (runningWorkers.some((agent) => agent.task === other.id) || (!ownCommits && branches[other.id])));
    if (overlap) continue;
    ready.push(task);
  }

  // Longest remaining weighted path first; skeleton first on ties (lib/schedule.mjs).
  const eligible = new Set(ready.map((task) => task.id));
  const order = readyIds(tasks, [...done], LIVE_MODEL);
  const ordered = order.filter((id) => eligible.has(id)).map((id) => byId.get(id));
  const workerSlots = Math.max(0, capacity.workers.cap - capacity.workers.used);
  const workerItems = [];
  const mergeItems = [];
  const mergeWaiting = [];
  const dispatchedWorkerScopes = [];
  for (const task of ordered) {
    if (runningWorkers.some((agent) => agent.task === task.id)) continue;
    if (agents.some((agent) => WORKER_ROLES.has(agent.role) && agent.task === task.id && agent.pendingPermissions)) continue;
    const branch = branches[task.id] || {};
    const ownCommits = branch.ownCommits ?? (branch.attempts ? 1 : 0);
    if (branch.mergeFailure && (ownCommits || branch.mergeFailure.status === 'pending')) {
      blocked.push({ task: task.id, kind: 'BLOCKED_MERGE', reason: `merge ${branch.mergeFailure.status} for ${branch.tip}; inspect failure, fix it, then explicitly retry merge` });
      continue;
    }
    const attempt = branch.latestAttempt || 1;
    if (!ownCommits && allAgents.some((agent) => WORKER_ROLES.has(agent.role) && agent.task === task.id && (agent.attempt || 1) === attempt)) {
      blocked.push({ task: task.id, kind: 'BLOCKED_WORKER_RESULT', reason: 'inspect existing worker result; resume it or explicitly merge after completion' });
      continue;
    }
    // Callers that only pass {attempts, implementationCommits} keep the old meaning: a branch
    // with attempts already carries one of its own commits.
    if (!branch.attempts) {
      if (dispatchedWorkerScopes.some((other) => scopesOverlap(task, other))) continue;
      workerItems.push({ task: task.id, action: 'create-branch+dispatch-worker', reason: 'deps Done; scope disjoint' });
      dispatchedWorkerScopes.push(task);
    } else if (!ownCommits) {
      // The branch exists but carries no commit yet: dispatch onto it, do not create a
      // second branch (that would burn an attempt).
      if (dispatchedWorkerScopes.some((other) => scopesOverlap(task, other))) continue;
      workerItems.push({ task: task.id, action: 'dispatch-worker', reason: 'branch present; no commit yet' });
      dispatchedWorkerScopes.push(task);
    } else {
      // `Uses` is a merge edge: the consumer may implement as soon as the interface
      // skeleton merges, but merging before the producer is Done fails exit 35.
      const unmetMerge = mergeDeps(task).filter((id) => !done.has(id) && byId.has(id));
      if (unmetMerge.length) {
        mergeWaiting.push({ task: task.id, on: unmetMerge.sort() });
        continue;
      }
      mergeItems.push({ task: task.id, action: 'merge', reason: 'worker commit present; gate runs Verify and scope' });
    }
  }
  // Merges consume no worker slot; only greenfield branches and worker dispatches do.
  const dispatch = [...workerItems.slice(0, workerSlots), ...mergeItems];

  const unhandled = open.filter((task) => {
    if (waiting.some((w) => w.task === task.id)) return false;
    if (mergeWaiting.some((m) => m.task === task.id)) return false;
    if (runningWorkers.some((agent) => agent.task === task.id)) return false;
    if (dispatch.some((item) => item.task === task.id)) return false;
    if (blocked.some((b) => b.task === task.id)) return false;
    return true;
  });

  for (const task of unhandled) {
    const conflicting = open.filter((other) => other.id !== task.id
      && !ancestors(task.id).has(other.id) && !ancestors(other.id).has(task.id)
      && scopesOverlap(task, other));
    if (conflicting.length) {
      const activeConflict = conflicting.some((other) =>
        runningWorkers.some((agent) => agent.task === other.id)
        || dispatch.some((item) => item.task === other.id)
      );
      if (!activeConflict) {
        blocked.push({
          task: task.id,
          kind: 'BLOCKED_SCOPE_COLLISION',
          reason: `scope overlaps with ${conflicting.map((c) => c.id).sort().join(', ')}; serialize with Depends on or resolve branch collision`,
        });
      }
    }
  }

  return {
    done: [...done].sort(),
    dispatch,
    waiting: waiting.sort((a, b) => (a.task < b.task ? -1 : 1)),
    mergeWaiting: mergeWaiting.sort((a, b) => (a.task < b.task ? -1 : 1)),
    attention: attention.sort((a, b) => `${a.task}${a.kind}`.localeCompare(`${b.task}${b.kind}`)),
    blocked: blocked.sort((a, b) => (a.task < b.task ? -1 : 1)),
    capacity,
  };
}
