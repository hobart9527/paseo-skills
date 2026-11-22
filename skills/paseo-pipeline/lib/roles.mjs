// Single authoritative role registry for Paseo Pipeline and Tier 2 gates.
// Every CLI, hook, and lint imports role sets and mappings from here instead of duplicating regexes.

export const ROLES = {
  chanpin: {
    kind: 'control',
    brief: 'skills/paseo-pipeline/templates/recon.md',
    stageTitles: ['FULL', 'RECON'],
  },
  hanlin: {
    kind: 'author',
    brief: 'skills/paseo-pipeline/templates/author.md',
    stageTitles: ['FULL', 'REVISE', 'R0', 'FINAL'],
    canSignR0: true,
  },
  neon: {
    kind: 'reviewer',
    legacy: true,
    profileId: 'agent_profile_mvvzv70y_bweu1x85oc9',
    brief: 'skills/paseo-pipeline/templates/reviewer.md',
    stageTitles: ['R0', 'FINAL'],
    canSignR0: true,
  },
  anchasi: {
    kind: 'reviewer',
    brief: 'Tier 3 skills/paseo-pipeline/templates/reviewer.md; Tier 2 docs/tier2-reviewer-brief.md',
    stageTitles: ['FINAL', 'R0'],
    canSignR0: true,
  },
  ceshi: {
    kind: 'tester',
    brief: 'skills/paseo-pipeline/templates/tester.md',
    isWriter: true,
  },
  gongbu: {
    kind: 'writer',
    brief: 'skills/paseo-pipeline/templates/worker.md',
    isWriter: true,
    isImplementer: true,
    stageTitles: ['FULL'],
  },
  gaogong: {
    kind: 'writer',
    brief: 'skills/paseo-pipeline/templates/worker.md',
    isWriter: true,
    isImplementer: true,
    stageTitles: ['FULL'],
  },
  jiangzuo: {
    kind: 'writer',
    brief: 'skills/paseo-pipeline/templates/worker.md',
    isWriter: true,
    isImplementer: true,
    stageTitles: ['FULL'],
  },
  shangshu: {
    kind: 'control',
    brief: 'skills/paseo-pipeline/SKILL.md',
    stageTitles: ['FULL'],
  },
};

export const ROLE_NAMES = Object.keys(ROLES);
export const ROLE_PROFILE_IDS = Object.fromEntries(
  Object.entries(ROLES).filter(([, meta]) => meta.profileId).map(([id, meta]) => [id, meta.profileId]),
);
export const AUTHOR_ROLES = ROLE_NAMES.filter((id) => ROLES[id].kind === 'author');
export const IMPLEMENTER_ROLES = ROLE_NAMES.filter((id) => ROLES[id].isImplementer);
export const WRITER_ROLES = new Set(ROLE_NAMES.filter((id) => ROLES[id].isWriter));
export const R0_ROLES = ROLE_NAMES.filter((id) => ROLES[id].canSignR0);
export const NON_WORKER_STAGE_ROLES = ROLE_NAMES.filter((id) => !ROLES[id].legacy && Array.isArray(ROLES[id].stageTitles));
export const RECOGNIZED_NON_WORKER_STAGE_ROLES = ROLE_NAMES.filter((id) => Array.isArray(ROLES[id].stageTitles));
export const AUTHORING_COMMIT_ROLES = new Set([...WRITER_ROLES, ...AUTHOR_ROLES]);

export function profileIdOf(role) {
  return ROLE_PROFILE_IDS[role] ?? `agent_profile_${role}`;
}

export function expectedBriefFor(role) {
  return ROLES[role]?.brief ?? null;
}

const UI_SCOPE_RE = /\.(?:tsx|jsx|vue|svelte)$|(?:^|\/)(?:ui|components|pages|views|styles)(?:\/|$)/i;

/** Pick default worker profile from task metadata without inventing runtime state. */
export function recommendedWorkerRole(task, extra = {}) {
  const scope = Array.isArray(task?.scope) ? task.scope : [];
  if (scope.some((item) => UI_SCOPE_RE.test(String(item))) && !extra['risk-surface']) return 'jiangzuo';
  if (task?.est === 'L' || extra['risk-surface']) return 'gaogong';
  return 'gongbu';
}
