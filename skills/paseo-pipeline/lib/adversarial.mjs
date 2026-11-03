// Fixed adversarial checklist per `Risk-surface`. Deterministic: the same declaration
// always yields the same cases, so a review can diff attempts. `brief.mjs tester`
// renders this table into the child prompt; there is no separate ceremony script.

// One entry per risk surface. Each line is a concrete case a `ceshi` test can encode,
// not a vague instruction. Order is stable so repeated runs are diff-clean.
const CHECKLISTS = {
  persistence: [
    'state survives reload / process restart',
    'concurrent writers do not lose or duplicate the last write',
    'partial write (crash between steps) leaves recoverable state, not a torn record',
    'missing or corrupt persisted state falls back to a defined default',
  ],
  'public-api': [
    'caller sends an extra or renamed field; the documented response shape is unchanged',
    'caller omits an optional field; defaults apply and the call still succeeds',
    'caller sends a wrong type; the documented error is returned, not a stack trace',
    'unknown endpoint/method returns the documented status code',
  ],
  'error-handling': [
    'upstream throws; the caller receives the documented error and the process stays alive',
    'upstream returns an empty result; the empty case is handled explicitly',
    'upstream times out; the timeout is bounded and surfaced as the documented error',
    'upstream returns malformed data; parsing failure is caught and classified',
  ],
  concurrency: [
    'two in-flight requests: the documented policy (last-write-wins vs conflict) holds',
    'a second request arrives before the first commits; no interleaved partial state',
    'duplicate/retried request does not apply the effect twice',
    'cancel or abort during an in-flight operation releases resources',
  ],
  irreversible: [
    're-running after a partial failure is idempotent or refuses with the documented error',
    'failure between destructive steps does not leave resources half-deleted',
    'the operation refuses to run without its required confirmation/guard',
  ],
  security: [
    'an unauthenticated or under-privileged caller is rejected at the boundary',
    'tenant/account isolation: one caller cannot read or mutate another tenant\'s data',
    'untrusted input is not interpolated into a command, query or path',
    'errors and logs do not leak secrets or full internal paths',
  ],
  performance: [
    'the large/boundary input completes within the documented budget',
    'a slow upstream does not block unrelated requests',
    'repeated calls do not grow memory or open handles without bound',
  ],
  migration: [
    'old-format data is read correctly and upgraded once',
    'rollback after a partial migration leaves the previous format usable',
    'mixed old/new versions during rollout do not corrupt records',
  ],
  idempotency: [
    'the same request submitted twice has the same effect as once',
    'a retry after a lost response returns the original result, not a duplicate',
  ],
  none: [],
};

// Deterministic aliases for common spellings in existing contracts.
const ALIASES = {
  'public api': 'public-api',
  publicapi: 'public-api',
  'error handling': 'error-handling',
  errorhandling: 'error-handling',
  'data-integrity': 'persistence',
  'data integrity': 'persistence',
  state: 'persistence',
  idempotent: 'idempotency',
  migrations: 'migration',
  security: 'security',
  perf: 'performance',
};

function normalizeSurface(raw) {
  return String(raw || '').trim().toLowerCase().replace(/^\[|\]$/g, '').trim();
}

function checklistFor(surface) {
  const key = normalizeSurface(surface);
  const canonical = ALIASES[key] || key;
  if (Object.prototype.hasOwnProperty.call(CHECKLISTS, canonical)) return CHECKLISTS[canonical];
  return [`unmapped risk surface "${surface}": derive one adversarial case from the task Scenarios and a second from its Verify boundary`];
}

/**
 * Cases for a raw `Risk-surface:` value (`[persistence, public-api]` or `none`).
 * Deduplicated, stable order, empty for a task that declares no risk.
 */
export function checklistForSurfaces(raw) {
  const surfaces = String(raw || '')
    .split(/[,\n]/)
    .map((item) => item.replace(/^\[|\]$/g, '').trim())
    .filter((item) => item && item.toLowerCase() !== 'none');
  const checklist = [];
  for (const surface of surfaces) {
    for (const item of checklistFor(surface)) if (!checklist.includes(item)) checklist.push(item);
  }
  return checklist;
}
