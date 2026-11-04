// Render the converged contract from the frozen baseline contract.
//
// `baseline-tasks.md` is the real `submit-hub-offset-and-draft-box` DAG as it was frozen,
// so it is the source of truth. `converged-tasks.md` is a *rendering* of the same tasks
// under the converged model, and a rendering must never be hand-edited: an earlier
// revision rewrote `Depends on:` into `Uses:` by hand, which produced two edges
// `freeze-check` rejects (`Uses` targets must declare `Interface:`). The benchmark then
// measured a contract the pipeline would have refused to freeze.
//
// The only authored input is the design decision — which files the skeleton freezes, which
// read-only fixtures a task executes, which standard tasks defer review. Everything else
// is derived by `freeze-check`'s own rule:
//
//   Interface    the producer that owns a skeleton file declares the frozen symbol
//   Uses         an edge whose target declares `Interface:` (dispatch at freeze)
//   Depends on   every other edge, plus the skeleton edge for interface owners
//   sink         depends on the whole graph
//
// The result is what it is. If it measures worse than the hand-written fixture did, the
// hand-written fixture was measuring a contract the pipeline would have refused.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const libDir = path.resolve(here, '../../skills/paseo-pipeline/lib');
const { parseTasks } = await import(path.join(libDir, 'tasks.mjs'));

export const DESIGN = {
  skeleton: {
    number: '0.1',
    id: 'T-00',
    title: '冻结接口桩：useFormDraft 签名与 LoanOffsetPicker invalidReason 类型',
    heading: '## 0. 接口骨架（Wave 0）',
    scope: [
      'packages/web/src/components/forms/common/useFormDraft.ts',
      'packages/web/src/components/forms/LoanOffsetPicker.tsx',
    ],
    interface: [
      'packages/web/src/components/forms/common/useFormDraft.ts#useFormDraft',
      'packages/web/src/components/forms/LoanOffsetPicker.tsx#invalidReason',
    ],
    // The type-check leg names a config outside the skeleton's Write scope; `Reads` is the
    // read-only anchor that authorises it (freeze-check's VERIFY_NOT_NARROW rule).
    reads: ['packages/web/tsconfig.test.json'],
    verify: 'npx tsc --noEmit -p packages/web/tsconfig.test.json',
  },
  // Write-scope entries that are read-only regression fixtures: the task executes them,
  // it does not edit them (`design.md` D6). They move to `Reads`.
  reads: {
    'T-04': ['scripts/specs/payee-company-scope.mjs'],
    'T-05': ['scripts/specs/payee-company-scope.mjs'],
  },
  // Standard tasks whose review moves to the FINAL batch. Filtered below against the
  // rules `freeze-check` enforces (no deferred sink, no deferred persistence/security).
  deferred: ['T-08', 'T-09', 'T-11'],
};

const FIELD = /^\s+[-*]\s+([^:]+):\s*(.*)$/;
const TASK_LINE = /^\s*[-*]\s*\[[ xX]\]\s+\S+\s+\S+-\d+\b/;
// Canonical field labels, in the order `openspec-schema/templates/tasks.md` uses.
const LABEL = {
  'depends on': 'Depends on',
  uses: 'Uses',
  kind: 'Kind',
  interface: 'Interface',
  est: 'Est',
  'risk-surface': 'Risk-surface',
  review: 'Review',
  'write scope': 'Write scope',
  reads: 'Reads',
  'verify with': 'Verify with',
  scenarios: 'Scenarios',
  note: 'Note',
};

/** Split a tasks.md into section headings and task blocks, keeping raw field values. */
function blocks(markdown) {
  const out = [];
  let heading = null;
  let current = null;
  const flush = () => { if (current) out.push(current); current = null; };
  for (const line of String(markdown).split(/\r?\n/)) {
    if (/^#{1,2}\s/.test(line)) { flush(); heading = line; continue; }
    if (TASK_LINE.test(line)) { flush(); current = { heading, line, fields: new Map() }; continue; }
    if (!current) continue;
    const field = line.match(FIELD);
    if (field) current.fields.set(field[1].trim().toLowerCase(), field[2]);
  }
  flush();
  return out;
}

const symbolFor = (design, file) => {
  const entry = design.skeleton.interface.find((candidate) => candidate.split('#')[0] === file);
  return entry ? entry.split('#')[1] : file.slice(file.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
};

/**
 * Derive the converged rendering from a baseline tasks.md.
 * Returns markdown plus the reason for every edge, so a reader can audit each one.
 */
export function derive(baselineMarkdown, design = DESIGN) {
  const parsed = parseTasks(baselineMarkdown);
  if (parsed.errors.length) {
    throw new Error(`baseline contract is invalid: ${parsed.errors.map((error) => error.code).join(', ')}`);
  }
  const tasks = parsed.tasks;
  const skeletonId = design.skeleton.id;
  const sinkId = tasks.find((task) => !tasks.some((other) => other.depends.includes(task.id) || other.uses.includes(task.id)))?.id;

  // The producer that owns a skeleton file declares its frozen symbol. That is the only
  // thing that makes a `Uses` edge legal, so it is computed rather than asserted.
  const interfaces = new Map(tasks.map((task) => [task.id, []]));
  for (const file of design.skeleton.scope) {
    const owner = tasks.find((task) => task.scope.includes(file));
    if (owner) interfaces.get(owner.id).push(`${file}#${symbolFor(design, file)}`);
  }
  const declares = new Set([...interfaces].filter(([, entries]) => entries.length).map(([id]) => id));
  const reads = new Map(tasks.map((task) => [task.id, design.reads[task.id] ?? []]));

  const decisions = [];
  const rendered = blocks(baselineMarkdown).map((block) => {
    const task = tasks.find((candidate) => block.line.includes(` ${candidate.id} `));
    const iface = interfaces.get(task.id);
    const read = reads.get(task.id);
    const scope = task.scope.filter((file) => !read.includes(file));
    const depends = [];
    const uses = [];
    for (const dep of task.depends) {
      if (declares.has(dep)) {
        uses.push(dep);
        decisions.push(`${task.id} -Uses-> ${dep}: ${dep} declares Interface:`);
      } else {
        depends.push(dep);
        decisions.push(`${task.id} -Depends-> ${dep}: ${dep} declares no Interface: (implementation edge)`);
      }
    }
    if (iface.length && !depends.includes(skeletonId)) {
      depends.unshift(skeletonId);
      decisions.push(`${task.id} -Depends-> ${skeletonId}: fills a skeleton-owned file`);
    }
    if (task.id === sinkId) {
      // The sink is the integration point: it cannot do useful work before the graph is
      // merged, so every edge is a real `Depends on` (no early dispatch).
      for (const used of uses.splice(0)) depends.push(used);
      for (const other of tasks) {
        if (other.id !== task.id && !depends.includes(other.id)) depends.push(other.id);
      }
      if (!depends.includes(skeletonId)) depends.push(skeletonId);
      decisions.push(`${task.id} -Depends-> (whole graph): sole sink`);
    }

    const risky = task.riskSurface.some((risk) => risk === 'persistence' || risk === 'security');
    const deferred = design.deferred.includes(task.id) && task.id !== sinkId && task.review !== 'strict' && !risky;
    const review = deferred ? 'deferred' : task.review;
    return { heading: block.heading, line: block.line, fields: block.fields, depends, uses, iface, read, scope, review };
  });

  const body = rendered.map((item) => {
    const ordered = new Map();
    ordered.set('depends on', item.depends.length ? item.depends.join(', ') : 'none');
    if (item.uses.length) ordered.set('uses', item.uses.join(', '));
    if (item.iface.length) ordered.set('interface', item.iface.join(', '));
    for (const key of ['est', 'risk-surface']) {
      const value = item.fields.get(key);
      if (value !== undefined) ordered.set(key, value);
    }
    ordered.set('review', item.review);
    ordered.set('write scope', item.scope.join(', '));
    if (item.read.length) ordered.set('reads', item.read.join(', '));
    for (const key of ['verify with', 'scenarios', 'note']) {
      const value = item.fields.get(key);
      if (value !== undefined) ordered.set(key, value);
    }
    const lines = [...ordered].map(([key, value]) => `  - ${LABEL[key]}: ${value}`);    return { heading: item.heading, text: [item.line, ...lines].join('\n') };
  });

  const skeletonBlock = [
    design.skeleton.heading,
    '',
    `- [ ] ${design.skeleton.number} ${design.skeleton.id} ${design.skeleton.title}`,
    '  - Depends on: none',
    '  - Kind: skeleton',
    `  - Write scope: ${design.skeleton.scope.join(', ')}`,
    `  - Interface: ${design.skeleton.interface.join(', ')}`,
    '  - Est: S',
    `  - Review: mechanical`,    ...(design.skeleton.reads?.length ? [`  - Reads: ${design.skeleton.reads.join(', ')}`] : []),
    `  - Verify with: ${design.skeleton.verify}`,
    '',
  ].join('\n');

  const sections = [];
  let heading = null;
  for (const item of body) {
    if (item.heading !== heading) {
      if (heading !== null) sections.push('');
      sections.push(item.heading);
      heading = item.heading;
    }
    sections.push('', item.text);
  }

  return {
    markdown: `# Tasks\n\n${skeletonBlock}\n${sections.join('\n')}\n`,
    decisions,
    skeletonId,
    interfaces: Object.fromEntries([...interfaces].filter(([, entries]) => entries.length)),
    reads: Object.fromEntries([...reads].filter(([, entries]) => entries.length)),
    sinkId,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const baseline = fs.readFileSync(path.join(here, 'baseline-tasks.md'), 'utf8');
  const result = derive(baseline);
  const target = path.join(here, 'converged-tasks.md');
  if (process.argv.includes('--write')) {
    fs.writeFileSync(target, result.markdown);
    console.log(`[derive] wrote ${path.relative(process.cwd(), target)}`);
    for (const decision of result.decisions) console.log(`  ${decision}`);
  } else if (fs.readFileSync(target, 'utf8') !== result.markdown) {
    console.error('[derive] converged-tasks.md is not the derivation; run `node benchmarks/pipeline/derive.mjs --write`');
    process.exit(1);
  } else {
    console.log('[derive] converged-tasks.md matches the derivation');
  }
}
