// Ten representative change shapes for the converged pipeline. Each scenario is one
// frozen DAG; only the contract fields differ between the two policies:
//
//   legacy    — every dependency is `Depends on` (the producer's implementation must
//               land before the consumer starts), no skeleton/`Uses`/`Reads`, and
//               every task carries its own inline review.
//   converged — a `Kind: skeleton` interface, `Uses` dispatch edges, `Reads` anchors,
//               and `Review: deferred` for standard non-sink tasks (FINAL owns them).
//
// The task list, files, Est and acceptance are identical, so the makespan delta comes
// from scheduling semantics, not from a different amount of work.
//
// These are synthetic shapes, not measured runs: they exercise the cost model and the
// contract linter. Real history calibration lives in baseline-metrics.mjs.

const t = (id, title, { est = 'M', review = 'standard', kind, uses = [], depends = [], scope, verify, scen, risk, interface: iface }) => ({
  id, title, est, review, kind, uses, depends, scope, verify, scen, risk, interface: iface,
});

export const SCENARIOS = [
  {
    id: 'ui-form-validation',
    title: 'Form validation with a frozen field interface',
    capability: 'ui-form',
    scen: 'SCEN-UF',
    tasks: [
      t('T-01', 'frozen Field interface', { est: 'S', review: 'mechanical', kind: 'skeleton', interface: 'src/ui/form/field.mjs#useField', scope: ['src/ui/form/field.mjs', 'src/ui/form/field.test.mjs'] }),
      t('T-02', 'validation rules', { uses: ['T-01'], review: 'deferred', scope: ['src/ui/form/validate.mjs', 'src/ui/form/validate.test.mjs'] }),
      t('T-03', 'submit wiring', { uses: ['T-01'], review: 'deferred', est: 'S', scope: ['src/ui/form/submit.mjs', 'src/ui/form/submit.test.mjs'] }),
      t('T-04', 'error banner', { uses: ['T-01'], review: 'deferred', est: 'S', scope: ['src/ui/form/banner.mjs', 'src/ui/form/banner.test.mjs'] }),
      t('T-05', 'keyboard a11y pass', { uses: ['T-01'], review: 'strict', est: 'S', risk: ['accessibility'], scope: ['src/ui/form/a11y.mjs', 'src/ui/form/a11y.test.mjs'] }),
      t('T-06', 'form integration sink', { review: 'mechanical', depends: ['T-01', 'T-02', 'T-03', 'T-04', 'T-05'], est: 'S', scope: ['test/ui/form/all.test.mjs'] }),
    ],
  },
  {
    id: 'api-rate-limit',
    title: 'Public API rate limiting with a shared store interface',
    capability: 'api',
    scen: 'SCEN-RL',
    tasks: [
      t('T-01', 'frozen store interface', { est: 'S', review: 'mechanical', kind: 'skeleton', interface: 'src/api/store.mjs#RateLimitStore', scope: ['src/api/store.mjs', 'src/api/store.test.mjs'] }),
      t('T-02', 'token bucket policy', { uses: ['T-01'], review: 'strict', risk: ['public-api'], scope: ['src/api/policy.mjs', 'src/api/policy.test.mjs'] }),
      t('T-03', 'middleware wiring', { uses: ['T-01'], review: 'deferred', scope: ['src/api/middleware.mjs', 'src/api/middleware.test.mjs'] }),
      t('T-04', '429 response shape', { uses: ['T-01'], review: 'deferred', est: 'S', scope: ['src/api/errors.mjs', 'src/api/errors.test.mjs'] }),
      t('T-05', 'metrics counters', { review: 'deferred', est: 'S', scope: ['src/api/metrics.mjs', 'src/api/metrics.test.mjs'] }),
      t('T-06', 'rate-limit integration sink', { review: 'mechanical', depends: ['T-01', 'T-02', 'T-03', 'T-04', 'T-05'], est: 'S', scope: ['test/api/all.test.mjs'] }),
    ],
  },
  {
    id: 'csv-import',
    title: 'CSV import with persistence guarantees',
    capability: 'import',
    scen: 'SCEN-IM',
    tasks: [
      t('T-01', 'CSV parser', { est: 'M', review: 'deferred', scope: ['src/import/parse.mjs', 'src/import/parse.test.mjs'] }),
      t('T-02', 'transactional writer', { est: 'L', review: 'strict', risk: ['persistence'], depends: ['T-01'], scope: ['src/import/write.mjs', 'src/import/write.test.mjs'] }),
      t('T-03', 'CLI entry', { depends: ['T-01'], review: 'deferred', est: 'S', scope: ['src/import/cli.mjs', 'src/import/cli.test.mjs'] }),
      t('T-04', 'progress reporting', { depends: ['T-02'], review: 'deferred', est: 'S', scope: ['src/import/progress.mjs', 'src/import/progress.test.mjs'] }),
      t('T-05', 'import integration sink', { review: 'mechanical', depends: ['T-02', 'T-03', 'T-04'], est: 'S', scope: ['test/import/all.test.mjs'] }),
    ],
  },
  {
    id: 'auth-refresh',
    title: 'Token refresh path with security surfaces',
    capability: 'auth',
    scen: 'SCEN-AU',
    tasks: [
      t('T-01', 'token adapter interface', { est: 'S', review: 'mechanical', kind: 'skeleton', interface: 'src/auth/adapter.mjs#TokenAdapter', scope: ['src/auth/adapter.mjs', 'src/auth/adapter.test.mjs'] }),
      t('T-02', 'refresh exchange', { est: 'M', review: 'strict', risk: ['security', 'public-api'], uses: ['T-01'], scope: ['src/auth/refresh.mjs', 'src/auth/refresh.test.mjs'] }),
      t('T-03', 'session rotation', { est: 'M', review: 'strict', risk: ['security'], uses: ['T-01'], scope: ['src/auth/session.mjs', 'src/auth/session.test.mjs'] }),
      t('T-04', 'revocation store', { est: 'M', review: 'strict', risk: ['persistence', 'security'], uses: ['T-01'], scope: ['src/auth/revoke.mjs', 'src/auth/revoke.test.mjs'] }),
      t('T-05', 'auth integration sink', { review: 'mechanical', depends: ['T-02', 'T-03', 'T-04'], est: 'S', scope: ['test/auth/all.test.mjs'] }),
    ],
  },
  {
    id: 'queue-worker',
    title: 'Concurrent queue worker with a skeleton envelope',
    capability: 'queue',
    scen: 'SCEN-QU',
    tasks: [
      t('T-01', 'frozen envelope interface', { est: 'S', review: 'mechanical', kind: 'skeleton', interface: 'src/queue/envelope.mjs#Envelope', scope: ['src/queue/envelope.mjs', 'src/queue/envelope.test.mjs'] }),
      t('T-02', 'claim and lease', { est: 'L', review: 'strict', risk: ['concurrency', 'persistence'], uses: ['T-01'], scope: ['src/queue/lease.mjs', 'src/queue/lease.test.mjs'] }),
      t('T-03', 'retry backoff', { uses: ['T-01'], review: 'deferred', scope: ['src/queue/retry.mjs', 'src/queue/retry.test.mjs'] }),
      t('T-04', 'dead-letter handling', { uses: ['T-01'], review: 'deferred', est: 'S', scope: ['src/queue/dead.mjs', 'src/queue/dead.test.mjs'] }),
      t('T-05', 'worker loop', { uses: ['T-01'], review: 'deferred', scope: ['src/queue/worker.mjs', 'src/queue/worker.test.mjs'] }),
      t('T-06', 'queue integration sink', { review: 'mechanical', depends: ['T-02', 'T-03', 'T-04', 'T-05'], est: 'S', scope: ['test/queue/all.test.mjs'] }),
    ],
  },
  {
    id: 'search-index',
    title: 'Search index with a read-only architecture anchor',
    capability: 'search',
    scen: 'SCEN-SE',
    tasks: [
      t('T-01', 'index schema', { est: 'M', review: 'deferred', scope: ['src/search/schema.mjs', 'src/search/schema.test.mjs'] }),
      t('T-02', 'tokenizer', { depends: ['T-01'], review: 'deferred', est: 'S', scope: ['src/search/tokenize.mjs', 'src/search/tokenize.test.mjs'] }),
      t('T-03', 'query planner', { depends: ['T-01'], review: 'strict', risk: ['performance'], scope: ['src/search/query.mjs', 'src/search/query.test.mjs'] }),
      t('T-04', 'ranking', { depends: ['T-03'], review: 'deferred', scope: ['src/search/rank.mjs', 'src/search/rank.test.mjs'] }),
      t('T-05', 'search integration sink', { review: 'mechanical', depends: ['T-02', 'T-03', 'T-04'], est: 'S', scope: ['test/search/all.test.mjs'] }),
    ],
  },
  {
    id: 'i18n-extract',
    title: 'Message extraction: mostly mechanical wiring',
    capability: 'i18n',
    scen: 'SCEN-I18',
    tasks: [
      t('T-01', 'catalog schema', { est: 'S', review: 'mechanical', scope: ['i18n/schema.mjs', 'i18n/schema.test.mjs'] }),
      t('T-02', 'extractor', { est: 'M', review: 'deferred', depends: ['T-01'], scope: ['i18n/extract.mjs', 'i18n/extract.test.mjs'] }),
      t('T-03', 'locale loader', { est: 'M', review: 'deferred', depends: ['T-01'], scope: ['i18n/locale.mjs', 'i18n/locale.test.mjs'] }),
      t('T-04', 'generated catalog fixture', { est: 'S', review: 'mechanical', depends: ['T-01'], scope: ['i18n/catalog.json', 'i18n/generated.test.mjs'] }),
      t('T-05', 'i18n integration sink', { review: 'mechanical', depends: ['T-02', 'T-03', 'T-04'], est: 'S', scope: ['test/i18n/all.test.mjs'] }),
    ],
  },
  {
    id: 'design-tokens',
    title: 'Design tokens feeding parallel UI consumers',
    capability: 'tokens',
    scen: 'SCEN-DT',
    tasks: [
      t('T-01', 'frozen token interface', { est: 'S', review: 'mechanical', kind: 'skeleton', interface: 'src/tokens/index.mjs#tokens', scope: ['src/tokens/index.mjs', 'src/tokens/index.test.mjs'] }),
      t('T-02', 'button consumer', { uses: ['T-01'], review: 'deferred', est: 'S', scope: ['src/tokens/button.mjs', 'src/tokens/button.test.mjs'] }),
      t('T-03', 'dialog consumer', { uses: ['T-01'], review: 'deferred', est: 'S', scope: ['src/tokens/dialog.mjs', 'src/tokens/dialog.test.mjs'] }),
      t('T-04', 'contrast checks', { uses: ['T-01'], review: 'strict', risk: ['accessibility'], est: 'S', scope: ['src/tokens/contrast.mjs', 'src/tokens/contrast.test.mjs'] }),
      t('T-05', 'token documentation', { review: 'mechanical', depends: ['T-01'], est: 'S', scope: ['docs/tokens.md', 'docs/tokens.test.mjs'] }),
      t('T-06', 'tokens integration sink', { review: 'mechanical', depends: ['T-02', 'T-03', 'T-04', 'T-05'], est: 'S', scope: ['test/tokens/all.test.mjs'] }),
    ],
  },
  {
    id: 'cli-report',
    title: 'CLI report with a long serial chain',
    capability: 'report',
    scen: 'SCEN-RP',
    tasks: [
      t('T-01', 'report model', { est: 'M', review: 'deferred', scope: ['src/report/model.mjs', 'src/report/model.test.mjs'] }),
      t('T-02', 'aggregation', { est: 'M', review: 'deferred', depends: ['T-01'], scope: ['src/report/aggregate.mjs', 'src/report/aggregate.test.mjs'] }),
      t('T-03', 'renderer', { est: 'M', review: 'deferred', depends: ['T-02'], scope: ['src/report/render.mjs', 'src/report/render.test.mjs'] }),
      t('T-04', 'CLI flags', { est: 'S', review: 'deferred', depends: ['T-03'], scope: ['src/report/cli.mjs', 'src/report/cli.test.mjs'] }),
      t('T-05', 'report integration sink', { review: 'mechanical', depends: ['T-04'], est: 'S', scope: ['test/report/all.test.mjs'] }),
    ],
  },
  {
    id: 'perf-profiler',
    title: 'Profiler instrumentation across independent modules',
    capability: 'perf',
    scen: 'SCEN-PF',
    tasks: [
      t('T-01', 'timer interface', { est: 'S', review: 'mechanical', kind: 'skeleton', interface: 'src/perf/timer.mjs#timer', scope: ['src/perf/timer.mjs', 'src/perf/timer.test.mjs'] }),
      t('T-02', 'request spans', { uses: ['T-01'], review: 'deferred', est: 'S', scope: ['src/perf/spans.mjs', 'src/perf/spans.test.mjs'] }),
      t('T-03', 'db spans', { uses: ['T-01'], review: 'deferred', est: 'S', scope: ['src/perf/db.mjs', 'src/perf/db.test.mjs'] }),
      t('T-04', 'sampling policy', { uses: ['T-01'], review: 'strict', risk: ['performance'], est: 'S', scope: ['src/perf/sample.mjs', 'src/perf/sample.test.mjs'] }),
      t('T-05', 'report exporter', { uses: ['T-01'], review: 'deferred', est: 'S', scope: ['src/perf/export.mjs', 'src/perf/export.test.mjs'] }),
      t('T-06', 'perf integration sink', { review: 'mechanical', depends: ['T-02', 'T-03', 'T-04', 'T-05'], est: 'S', scope: ['test/perf/all.test.mjs'] }),
    ],
  },
];

const defaultVerify = (task) => {
  const testFile = task.scope.find((file) => /(?:\.|_)(?:test|spec)\./.test(file));
  return `node --test ${testFile}`;
};

function renderTask(task, policy, scenario) {
  const uses = policy === 'converged' ? task.uses : [];
  const depends = policy === 'legacy' ? [...new Set([...task.depends, ...task.uses])] : task.depends;
  const kind = policy === 'converged' ? task.kind : undefined;
  const review = policy === 'legacy'
    ? (task.review === 'mechanical' ? 'mechanical' : task.review === 'strict' ? 'strict' : 'standard')
    : task.review;
  const lines = [`- [ ] ${task.id} ${task.title}`];
  if (depends.length) lines.push(`  - Depends on: ${depends.join(', ')}`);
  if (uses.length) lines.push(`  - Uses: ${uses.join(', ')}`);
  if (kind) lines.push(`  - Kind: ${kind}`);
  if (kind && task.interface) lines.push(`  - Interface: ${task.interface}`);
  lines.push(`  - Est: ${task.est}`);
  if (task.risk?.length) lines.push(`  - Risk-surface: [${task.risk.join(', ')}]`);
  lines.push(`  - Review: ${review}`);
  lines.push(`  - Write scope: ${task.scope.join(', ')}`);
  lines.push(`  - Verify with: ${task.verify ?? defaultVerify(task)}`);
  if (review !== 'mechanical' && scenario.scen) lines.push(`  - Scen: ${scenario.scen}-01`);
  return lines.join('\n');
}

export function renderTasks(scenario, policy) {
  return `# Tasks\n\n${scenario.tasks.map((task) => renderTask(task, policy, scenario)).join('\n')}\n`;
}

/** The same scenarios under the old model: implementation edges only, per-task review. */
export function legacyTasks(scenario) {
  return scenario.tasks.map((task) => ({
    ...task,
    kind: null,
    uses: [],
    depends: [...new Set([...task.depends, ...task.uses])],
    review: task.review === 'strict' ? 'strict' : task.review === 'mechanical' ? 'mechanical' : 'standard',
  }));
}

export function scenarioFiles(scenario) {
  const scenarioId = `${scenario.scen}-01`;
  const tasks = scenario.tasks.filter((task) => task.review !== 'mechanical');
  const specPath = `specs/${scenario.capability}/spec.md`;
  return {
    'proposal.md': `# Proposal\n\n${scenario.title}\n`,
    'design.md': `# Design\n\n## Impact Inventory\n${scenario.tasks.map((task) => `- ${task.id}: ${task.scope.join(', ')}`).join('\n')}\n`,
    [specPath]: tasks.map((task) => `#### Scenario: ${scenarioId} ${task.title}`).join('\n') + '\n',
    'acceptance.md': [
      '| Scenario | Entry | Tasks | Verify | Required | Result | Evidence |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      `| ${scenarioId} | CLI | ${scenario.tasks.at(-1).id} | node --test ${scenario.tasks.at(-1).scope[0]} | yes | PENDING | pending |`,
      '',
    ].join('\n'),
  };
}
