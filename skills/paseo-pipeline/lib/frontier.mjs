// Pure frontier computation: graph + observed state -> deterministic next actions.
// No I/O, no dispatch, no ledger. The Lead executes the list; git and Paseo stay
// the only state (SKILL.md principle 5).
import { dispatchDeps, readyIds } from './schedule.mjs';
import { normalizeScope } from './tasks.mjs';

const WRITER_ROLES = new Set(['ceshi', 'gongbu', 'gaogong', 'jiangzuo']);
const REVIEWER_ROLES = new Set(['anchasi']);
const LEAD_ROLES = new Set(['shangshu', 'hanlin']);

export const DEFAULTS = {
  writerCap: 6,
  reviewerCap: 4,
  idleMinutes: 15,
  maxAttempts: 3,
};

function scopesOverlap(left, right) {
  return left.scope.some((scope) => right.scope.some((other) => {
    const a = normalizeScope(scope);
    const b = normalizeScope(other);
    if (!a || !b) return false;
    return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
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
 * @param {object} options { writerCap, reviewerCap, idleMinutes, maxAttempts }
 */
export function frontier(tasks, state = {}, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const done = new Set(state.done || []);
  const agents = (state.agents || []).filter((agent) => agent && agent.status !== 'closed');
  const branches = state.branches || {};
  const now = state.now ? new Date(state.now).getTime() : Date.now();
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const ancestors = ancestorSet(byId);
  const open = tasks.filter((task) => !done.has(task.id));

  const runningWriters = agents.filter((agent) => WRITER_ROLES.has(agent.role) && agent.status === 'running');
  const runningReviewers = agents.filter((agent) => REVIEWER_ROLES.has(agent.role) && agent.status === 'running');
  const capacity = {
    writers: { used: new Set(runningWriters.map((agent) => agent.task).filter(Boolean)).size, cap: opts.writerCap },
    reviewers: { used: new Set(runningReviewers.map((agent) => agent.task).filter(Boolean)).size, cap: opts.reviewerCap },
  };

  const attention = [];
  for (const agent of agents) {
    const task = agent.task;
    if (task && !byId.has(task)) {
      attention.push({ task, agent: agent.id, kind: 'STALE_LABEL', reason: `${task} is not in tasks.md` });
      continue;
    }
    if (task && done.has(task) && agent.status === 'running') {
      attention.push({ task, agent: agent.id, kind: 'DONE_AGENT_RUNNING', reason: `${task} is Done but ${agent.role || 'an agent'} still runs` });
      continue;
    }
    if (agent.pendingPermissions) {
      attention.push({ task, agent: agent.id, kind: 'PENDING_PERMISSION', reason: 'agent is blocked on a permission prompt' });
      continue;
    }
    if (agent.status === 'idle' && agent.updatedAt && !LEAD_ROLES.has(agent.role)) {
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
    if (attempts >= opts.maxAttempts) {
      blocked.push({ task: task.id, kind: 'BLOCKED_ATTEMPTS', reason: `${attempts} branches; cap is ${opts.maxAttempts}` });
      continue;
    }
    // A live writer on the same files would race. Depends-on pairs are serialised by
    // the unmet check above; Uses pairs can overlap only when freeze-check allowed it.
    const overlap = open.some((other) => other.id !== task.id
      && !ancestors(task.id).has(other.id) && !ancestors(other.id).has(task.id)
      && scopesOverlap(task, other)
      && (runningWriters.some((agent) => agent.task === other.id) || branches[other.id]));
    if (overlap) continue;
    ready.push(task);
  }

  // Longest remaining weighted path first; skeleton first on ties (lib/schedule.mjs).
  const order = readyIds(ready, [...done]);
  const ordered = order.map((id) => byId.get(id)).filter(Boolean);
  const writerSlots = Math.max(0, capacity.writers.cap - capacity.writers.used);
  const reviewerSlots = Math.max(0, capacity.reviewers.cap - capacity.reviewers.used);
  const writerItems = [];
  const reviewItems = [];
  const mergeItems = [];
  for (const task of ordered) {
    const branch = branches[task.id] || {};
    const mechanical = task.review === 'mechanical';
    if (!branch.attempts) {
      writerItems.push({ task: task.id, action: mechanical ? 'create-branch+dispatch-implementer' : 'create-branch+dispatch-ceshi', reason: 'deps Done; scope disjoint' });
    } else if (!branch.implementationCommits) {
      writerItems.push({ task: task.id, action: 'dispatch-implementer', reason: 'Red commit present; no implementation commit yet' });
    } else if (mechanical) {
      mergeItems.push({ task: task.id, action: 'merge', reason: 'implementation present; merge on pass(mechanical@tip/base)' });
    } else if (task.review === 'deferred') {
      mergeItems.push({ task: task.id, action: 'merge', reason: 'implementation present; merge on pass(deferred@tip/base), FINAL owns review' });
    } else if (!runningReviewers.some((agent) => agent.task === task.id)) {
      reviewItems.push({ task: task.id, action: 'dispatch-reviewer', reason: 'implementation commit present; review not running' });
    }
  }
  // Merges consume no writer slot; only greenfield branches and Red writers do.
  const dispatch = [...writerItems.slice(0, writerSlots), ...reviewItems.slice(0, reviewerSlots), ...mergeItems];

  return {
    done: [...done].sort(),
    dispatch,
    waiting: waiting.sort((a, b) => (a.task < b.task ? -1 : 1)),
    attention: attention.sort((a, b) => `${a.task}${a.kind}`.localeCompare(`${b.task}${b.kind}`)),
    blocked: blocked.sort((a, b) => (a.task < b.task ? -1 : 1)),
    capacity,
  };
}
