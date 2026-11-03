// Ten representative *complex* change shapes for the converged pipeline. Each is a
// realistic 9-10 task decomposition, sized like the measured submit-hub change, and
// each follows the architecture the model is designed for:
//
//   skeleton   freezes the interface FILES (Review: mechanical, no Red)
//   producer   Depends on the skeleton(s) and fills those files; declares Interface
//   consumer   Uses producers, so it dispatches once the skeleton is frozen, not
//              once the producer's implementation is complete; merge still waits
//   sink       one mechanical task that depends on the whole graph
//
// Legacy rendering of the same tasks: `Uses` becomes `Depends on`, Kind/Interface are
// dropped, and every non-strict, non-mechanical task carries its own inline review.
// Task list, files, Est and acceptance are identical; only scheduling semantics differ.
//
// These are synthetic shapes, not measured runs: they exercise the cost model and the
// contract linter. Real history calibration lives in baseline-metrics.mjs.

const testFile = (capability, id) => `test/${capability}/${id.toLowerCase().replace('-', '')}.test.mjs`;
const slug = (file) => file.slice(file.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');

const task = (id, title, capability, { est = 'M', review = 'standard', kind, uses = [], depends = [], scope = [], risk, interface: iface }) => ({
  id,
  title,
  est,
  review,
  kind,
  uses,
  depends,
  scope: [...scope, testFile(capability, id)],
  verify: `node --test ${testFile(capability, id)}`,
  risk,
  interface: iface,
});

/** Interface stub owned by a skeleton: the file(s) it freezes. */
const skeleton = (id, title, capability, files) => task(id, title, capability, {
  est: 'S',
  review: 'mechanical',
  kind: 'skeleton',
  scope: files,
  interface: files.map((file) => `${file}#${slug(file)}`),
});

/** Producer fills a skeleton-owned interface file. */
const producer = (id, title, capability, skeletonId, file, options = {}) => task(id, title, capability, {
  ...options,
  depends: [skeletonId],
  scope: [file],
  interface: [`${file}#${slug(file)}`],
});

/** Consumer starts at interface freeze, merges after its producers. */
const consumer = (id, title, capability, uses, file, options = {}) => task(id, title, capability, {
  ...options,
  uses,
  scope: [file],
});

/**
 * A task that needs another task's *implementation*, not just a frozen interface
 * (chained consumers such as `dedupe` needing `map`'s runtime). `Uses` would be a
 * contract error here — `freeze-check` requires the target to declare an Interface —
 * so the edge is a real `Depends on`.
 */
const follower = (id, title, capability, dependsOn, file, options = {}) => task(id, title, capability, {
  ...options,
  depends: dependsOn,
  scope: [file],
});

const docs = (id, title, capability, dependsOn) => task(id, title, capability, {
  est: 'S',
  review: 'mechanical',
  depends: [dependsOn],
  scope: [`docs/${capability}.md`],
});

const sink = (id, title, capability, dependsOn) => task(id, title, capability, {
  est: 'S',
  review: 'mechanical',
  depends: dependsOn,
  scope: [],
});

export const SCENARIOS = [
  {
    id: 'ui-form-validation',
    title: 'Form validation with frozen field interfaces',
    capability: 'ui-form',
    scen: 'SCEN-UF',
    tasks: [
      skeleton('T-01', 'frozen field / validation / submit interfaces', 'ui-form',
        ['src/form/field.mjs', 'src/form/validate.mjs', 'src/form/submit.mjs']),
      producer('T-02', 'synchronous and async validation rules', 'ui-form', 'T-01', 'src/form/validate.mjs', { review: 'deferred' }),
      producer('T-03', 'submit wiring and payload shaping', 'ui-form', 'T-01', 'src/form/submit.mjs', { review: 'deferred' }),
      consumer('T-04', 'field error banner', 'ui-form', ['T-02'], 'src/form/banner.mjs', { review: 'deferred', est: 'S' }),
      consumer('T-05', 'focus management and keyboard a11y', 'ui-form', ['T-02'], 'src/form/a11y.mjs', { review: 'strict', risk: ['accessibility'], est: 'S' }),
      consumer('T-06', 'draft persistence and restore', 'ui-form', ['T-03'], 'src/form/draft.mjs', { review: 'strict', risk: ['persistence'] }),
      consumer('T-07', 'form state and dirty guard', 'ui-form', ['T-02', 'T-03'], 'src/form/state.mjs', { review: 'deferred', est: 'S' }),
      docs('T-08', 'form behaviour notes', 'ui-form', 'T-06'),
      sink('T-09', 'ui-form integration sink', 'ui-form', ['T-04', 'T-05', 'T-07', 'T-08']),
    ],
  },
  {
    id: 'api-rate-limit',
    title: 'Public API rate limiting with a frozen store and policy interface',
    capability: 'api',
    scen: 'SCEN-RL',
    tasks: [
      skeleton('T-01', 'frozen store and policy interfaces', 'api',
        ['src/api/store.mjs', 'src/api/policy.mjs']),
      producer('T-02', 'token bucket and sliding window policy', 'api', 'T-01', 'src/api/policy.mjs', { review: 'strict', risk: ['public-api'] }),
      consumer('T-03', 'middleware wiring', 'api', ['T-02'], 'src/api/middleware.mjs', { review: 'deferred' }),
      follower('T-04', '429 response shape', 'api', ['T-03'], 'src/api/errors.mjs', { review: 'deferred', est: 'S' }),
      follower('T-05', 'RateLimit headers', 'api', ['T-03'], 'src/api/headers.mjs', { review: 'deferred', est: 'S' }),
      consumer('T-06', 'metrics counters', 'api', ['T-02'], 'src/api/metrics.mjs', { review: 'deferred', est: 'S' }),
      consumer('T-07', 'policy configuration loader', 'api', ['T-01'], 'src/api/config.mjs', { review: 'deferred', est: 'S' }),
      docs('T-08', 'rate-limit contract notes', 'api', 'T-06'),
      sink('T-09', 'api integration sink', 'api', ['T-04', 'T-05', 'T-07', 'T-08']),
    ],
  },
  {
    id: 'csv-import',
    title: 'Transactional CSV import with retry and progress',
    capability: 'import',
    scen: 'SCEN-IM',
    tasks: [
      skeleton('T-01', 'frozen parser and writer interfaces', 'import',
        ['src/import/parse.mjs', 'src/import/write.mjs']),
      producer('T-02', 'streaming CSV parser', 'import', 'T-01', 'src/import/parse.mjs', { review: 'deferred' }),
      producer('T-03', 'transactional writer', 'import', 'T-01', 'src/import/write.mjs', { review: 'strict', risk: ['persistence'], est: 'L' }),
      consumer('T-04', 'retry and rollback', 'import', ['T-03'], 'src/import/retry.mjs', { review: 'deferred', est: 'S' }),
      consumer('T-05', 'column mapping', 'import', ['T-02'], 'src/import/map.mjs', { review: 'deferred' }),
      follower('T-06', 'duplicate detection', 'import', ['T-05'], 'src/import/dedupe.mjs', { review: 'deferred', est: 'S' }),
      consumer('T-07', 'progress reporting', 'import', ['T-03'], 'src/import/progress.mjs', { review: 'deferred', est: 'S' }),
      consumer('T-08', 'import summary report', 'import', ['T-02'], 'src/import/report.mjs', { review: 'deferred', est: 'S' }),
      sink('T-09', 'import integration sink', 'import', ['T-04', 'T-06', 'T-07', 'T-08']),
    ],
  },
  {
    id: 'auth-refresh',
    title: 'Token refresh with security and concurrency surfaces',
    capability: 'auth',
    scen: 'SCEN-AU',
    tasks: [
      skeleton('T-01', 'frozen adapter / refresh / session interfaces', 'auth',
        ['src/auth/adapter.mjs', 'src/auth/refresh.mjs', 'src/auth/session.mjs']),
      producer('T-02', 'refresh exchange', 'auth', 'T-01', 'src/auth/refresh.mjs', { review: 'strict', risk: ['security'] }),
      producer('T-03', 'session rotation', 'auth', 'T-01', 'src/auth/session.mjs', { review: 'strict', risk: ['security'] }),
      consumer('T-04', 'revocation store', 'auth', ['T-02'], 'src/auth/revoke.mjs', { review: 'strict', risk: ['persistence', 'security'] }),
      consumer('T-05', 'concurrent refresh dedupe', 'auth', ['T-02'], 'src/auth/dedupe.mjs', { review: 'strict', risk: ['concurrency'], est: 'S' }),
      consumer('T-06', 'error classification', 'auth', ['T-03'], 'src/auth/errors.mjs', { review: 'deferred', est: 'S' }),
      consumer('T-07', 'audit logging', 'auth', ['T-03'], 'src/auth/audit.mjs', { review: 'deferred', est: 'S' }),
      consumer('T-08', 'auth middleware', 'auth', ['T-01'], 'src/auth/middleware.mjs', { review: 'deferred', est: 'S' }),
      docs('T-09', 'auth flow notes', 'auth', 'T-06'),
      sink('T-10', 'auth integration sink', 'auth', ['T-04', 'T-05', 'T-07', 'T-08', 'T-09']),
    ],
  },
  {
    id: 'queue-worker',
    title: 'Concurrent queue worker with leases and dead letters',
    capability: 'queue',
    scen: 'SCEN-QU',
    tasks: [
      skeleton('T-01', 'frozen envelope and lease interfaces', 'queue',
        ['src/queue/envelope.mjs', 'src/queue/lease.mjs']),
      producer('T-02', 'claim and lease', 'queue', 'T-01', 'src/queue/lease.mjs', { review: 'strict', risk: ['concurrency', 'persistence'], est: 'L' }),
      consumer('T-03', 'retry policy', 'queue', ['T-02'], 'src/queue/retry.mjs', { review: 'strict', risk: ['concurrency'] }),
      consumer('T-04', 'dead-letter handling', 'queue', ['T-02'], 'src/queue/dead.mjs', { review: 'deferred', est: 'S' }),
      consumer('T-05', 'worker loop', 'queue', ['T-02'], 'src/queue/worker.mjs', { review: 'deferred' }),
      consumer('T-06', 'queue metrics', 'queue', ['T-01'], 'src/queue/metrics.mjs', { review: 'deferred', est: 'S' }),
      consumer('T-07', 'queue configuration', 'queue', ['T-01'], 'src/queue/config.mjs', { review: 'deferred', est: 'S' }),
      follower('T-08', 'backoff strategy', 'queue', ['T-03'], 'src/queue/backoff.mjs', { review: 'deferred', est: 'S' }),
      docs('T-09', 'queue contract notes', 'queue', 'T-05'),
      sink('T-10', 'queue integration sink', 'queue', ['T-04', 'T-06', 'T-07', 'T-08', 'T-09']),
    ],
  },
  {
    id: 'search-index',
    title: 'Search index with planning and caching surfaces',
    capability: 'search',
    scen: 'SCEN-SE',
    tasks: [
      skeleton('T-01', 'frozen schema and query interfaces', 'search',
        ['src/search/schema.mjs', 'src/search/query.mjs']),
      producer('T-02', 'index schema and lifecycle', 'search', 'T-01', 'src/search/schema.mjs', { review: 'deferred' }),
      producer('T-03', 'query planner', 'search', 'T-01', 'src/search/query.mjs', { review: 'strict', risk: ['performance'] }),
      consumer('T-04', 'tokenizer', 'search', ['T-02'], 'src/search/tokenize.mjs', { review: 'deferred', est: 'S' }),
      consumer('T-05', 'ranking', 'search', ['T-03'], 'src/search/rank.mjs', { review: 'deferred' }),
      consumer('T-06', 'filters', 'search', ['T-03'], 'src/search/filter.mjs', { review: 'deferred', est: 'S' }),
      consumer('T-07', 'pagination', 'search', ['T-03'], 'src/search/paginate.mjs', { review: 'deferred', est: 'S' }),
      follower('T-08', 'result cache', 'search', ['T-05'], 'src/search/cache.mjs', { review: 'strict', risk: ['persistence'] }),
      consumer('T-09', 'analyzer', 'search', ['T-02'], 'src/search/analyze.mjs', { review: 'deferred', est: 'S' }),
      sink('T-10', 'search integration sink', 'search', ['T-04', 'T-06', 'T-07', 'T-08', 'T-09']),
    ],
  },
  {
    id: 'i18n-extract',
    title: 'Message extraction and catalog pipeline',
    capability: 'i18n',
    scen: 'SCEN-I18',
    tasks: [
      skeleton('T-01', 'frozen schema / extractor / catalog interfaces', 'i18n',
        ['i18n/schema.mjs', 'i18n/extract.mjs', 'i18n/catalog.mjs']),
      producer('T-02', 'message extractor', 'i18n', 'T-01', 'i18n/extract.mjs', { review: 'deferred' }),
      producer('T-03', 'catalog writer', 'i18n', 'T-01', 'i18n/catalog.mjs', { review: 'deferred' }),
      consumer('T-04', 'source scanner', 'i18n', ['T-02'], 'i18n/scan.mjs', { review: 'deferred', est: 'S' }),
      consumer('T-05', 'catalog merge', 'i18n', ['T-02'], 'i18n/merge.mjs', { review: 'deferred', est: 'S' }),
      consumer('T-06', 'locale loader', 'i18n', ['T-03'], 'i18n/locale.mjs', { review: 'deferred' }),
      consumer('T-07', 'fallback chain', 'i18n', ['T-03'], 'i18n/fallback.mjs', { review: 'deferred', est: 'S' }),
      task('T-08', 'generated catalog fixture', 'i18n', { est: 'S', review: 'mechanical', depends: ['T-03'], scope: ['i18n/generated.json'] }),
      sink('T-09', 'i18n integration sink', 'i18n', ['T-04', 'T-05', 'T-06', 'T-07', 'T-08']),
    ],
  },
  {
    id: 'design-tokens',
    title: 'Design tokens driving parallel UI consumers',
    capability: 'tokens',
    scen: 'SCEN-DT',
    tasks: [
      skeleton('T-01', 'frozen token and theme interfaces', 'tokens',
        ['src/tokens/index.mjs', 'src/tokens/theme.mjs']),
      producer('T-02', 'theme resolution', 'tokens', 'T-01', 'src/tokens/theme.mjs', { review: 'deferred' }),
      consumer('T-03', 'button token consumer', 'tokens', ['T-01'], 'src/tokens/button.mjs', { review: 'deferred', est: 'S' }),
      consumer('T-04', 'dialog token consumer', 'tokens', ['T-01'], 'src/tokens/dialog.mjs', { review: 'deferred', est: 'S' }),
      consumer('T-05', 'contrast checks', 'tokens', ['T-02'], 'src/tokens/contrast.mjs', { review: 'strict', risk: ['accessibility'], est: 'S' }),
      consumer('T-06', 'type scale', 'tokens', ['T-02'], 'src/tokens/scale.mjs', { review: 'deferred' }),
      consumer('T-07', 'motion tokens', 'tokens', ['T-02'], 'src/tokens/motion.mjs', { review: 'deferred', est: 'S' }),
      docs('T-08', 'token documentation', 'tokens', 'T-01'),
      sink('T-09', 'tokens integration sink', 'tokens', ['T-03', 'T-04', 'T-05', 'T-06', 'T-07', 'T-08']),
    ],
  },
  {
    id: 'cli-report',
    title: 'CLI report with a long aggregation chain',
    capability: 'report',
    scen: 'SCEN-RP',
    tasks: [
      skeleton('T-01', 'frozen model and aggregation interfaces', 'report',
        ['src/report/model.mjs', 'src/report/aggregate.mjs']),
      producer('T-02', 'report model', 'report', 'T-01', 'src/report/model.mjs', { review: 'deferred' }),
      producer('T-03', 'aggregation', 'report', 'T-01', 'src/report/aggregate.mjs', { review: 'deferred' }),
      consumer('T-04', 'table renderer', 'report', ['T-02'], 'src/report/render.mjs', { review: 'deferred' }),
      consumer('T-05', 'chart data', 'report', ['T-03'], 'src/report/chart.mjs', { review: 'deferred', est: 'S' }),
      follower('T-06', 'CLI flags', 'report', ['T-05'], 'src/report/cli.mjs', { review: 'deferred', est: 'S' }),
      follower('T-07', 'formatting', 'report', ['T-04'], 'src/report/format.mjs', { review: 'deferred', est: 'S' }),
      consumer('T-08', 'export writer', 'report', ['T-03'], 'src/report/export.mjs', { review: 'deferred' }),
      follower('T-09', 'CSV output', 'report', ['T-08'], 'src/report/csv.mjs', { review: 'deferred', est: 'S' }),
      sink('T-10', 'report integration sink', 'report', ['T-06', 'T-07', 'T-09']),
    ],
  },
  {
    id: 'perf-profiler',
    title: 'Profiler instrumentation with sampling and budgets',
    capability: 'perf',
    scen: 'SCEN-PF',
    tasks: [
      skeleton('T-01', 'frozen timer and sampling interfaces', 'perf',
        ['src/perf/timer.mjs', 'src/perf/sample.mjs']),
      producer('T-02', 'sampling policy', 'perf', 'T-01', 'src/perf/sample.mjs', { review: 'strict', risk: ['performance'], est: 'S' }),
      consumer('T-03', 'request spans', 'perf', ['T-01'], 'src/perf/spans.mjs', { review: 'deferred', est: 'S' }),
      follower('T-04', 'database spans', 'perf', ['T-03'], 'src/perf/db.mjs', { review: 'deferred', est: 'S' }),
      consumer('T-05', 'exporter', 'perf', ['T-02'], 'src/perf/export.mjs', { review: 'deferred', est: 'S' }),
      consumer('T-06', 'performance report', 'perf', ['T-02'], 'src/perf/report.mjs', { review: 'deferred', est: 'S' }),
      consumer('T-07', 'budget checks', 'perf', ['T-02'], 'src/perf/budget.mjs', { review: 'deferred', est: 'S' }),
      consumer('T-08', 'trace context', 'perf', ['T-01'], 'src/perf/trace.mjs', { review: 'deferred', est: 'S' }),
      sink('T-09', 'perf integration sink', 'perf', ['T-04', 'T-05', 'T-06', 'T-07', 'T-08']),
    ],
  },
];

const scenOf = (capability, id) => `SCEN-${capability.toUpperCase()}-${id.replace('T-', '')}`;

function renderTask(item, policy, scenario) {
  const uses = policy === 'converged' ? item.uses : [];
  const depends = policy === 'legacy' ? [...new Set([...item.depends, ...item.uses])] : item.depends;
  const kind = policy === 'converged' ? item.kind : undefined;
  const review = policy === 'legacy'
    ? (item.review === 'mechanical' ? 'mechanical' : item.review === 'strict' ? 'strict' : 'standard')
    : item.review;
  const lines = [`- [ ] ${item.id} ${item.title}`];
  if (depends.length) lines.push(`  - Depends on: ${depends.join(', ')}`);
  if (uses.length) lines.push(`  - Uses: ${uses.join(', ')}`);
  if (kind) lines.push(`  - Kind: ${kind}`);
  if (policy === 'converged' && item.interface?.length) lines.push(`  - Interface: ${item.interface.join(', ')}`);
  lines.push(`  - Est: ${item.est}`);
  if (item.risk?.length) lines.push(`  - Risk-surface: [${item.risk.join(', ')}]`);
  lines.push(`  - Review: ${review}`);
  lines.push(`  - Write scope: ${item.scope.join(', ')}`);
  lines.push(`  - Verify with: ${item.verify}`);
  if (review !== 'mechanical') lines.push(`  - Scen: ${scenOf(scenario.capability, item.id)}`);
  return lines.join('\n');
}

export function renderTasks(scenario, policy) {
  return `# Tasks\n\n${scenario.tasks.map((item) => renderTask(item, policy, scenario)).join('\n')}\n`;
}

/** The same scenarios under the old model: implementation edges only, per-task review. */
export function legacyTasks(scenario) {
  return scenario.tasks.map((item) => ({
    ...item,
    kind: null,
    uses: [],
    depends: [...new Set([...item.depends, ...item.uses])],
    review: item.review === 'strict' ? 'strict' : item.review === 'mechanical' ? 'mechanical' : 'standard',
  }));
}

export function scenarioFiles(scenario) {
  const specPath = `specs/${scenario.capability}/spec.md`;
  const behaviour = scenario.tasks.filter((item) => item.review !== 'mechanical');
  const last = scenario.tasks.at(-1);
  return {
    'proposal.md': `# Proposal\n\n${scenario.title}\n`,
    'design.md': `# Design\n\n## Impact Inventory\n${scenario.tasks.map((item) => `- ${item.id}: ${item.scope.join(', ')}`).join('\n')}\n`,
    [specPath]: behaviour.map((item) => `#### Scenario: ${scenOf(scenario.capability, item.id)} ${item.title}`).join('\n') + '\n',
    'acceptance.md': [
      '| Scenario | Entry | Tasks | Verify | Required | Result | Evidence |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      `| ${scenOf(scenario.capability, behaviour.at(-1).id)} | CLI | ${last.id} | ${last.verify} | yes | PENDING | pending |`,
      '',
    ].join('\n'),
  };
}
