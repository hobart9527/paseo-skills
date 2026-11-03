#!/usr/bin/env node
// Calibrate the scheduling cost model from git history instead of guessing.
//
// Pure reads: no writes, no network, no Paseo calls. Every number is derived from
// commit timestamps and trailers that `merge-task.mjs` already produced, so the
// result can be reproduced by anyone holding the repository.
//
// Mapping to lib/schedule.mjs DEFAULT_MODEL (imported defensively; the module may
// only exist on a parallel branch):
//   red -> impl interval   => implMin
//   impl -> merge interval => reviewMin after subtracting the measured verify and
//                             regression phases (both run inside that interval)
//   rework commit spacing  => reworkMin
//   run-log timing_ms      => regressionMinPerTask (and verify, reported in measured)
// Unmeasurable keys (redMin, mergeMin, caps) keep the imported defaults.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseTasks, parseTaskLine, isTestPath } from './lib/tasks.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const changeFlagIndex = args.indexOf('--change');
const changeFilter = changeFlagIndex >= 0 ? args[changeFlagIndex + 1] : null;
if (changeFlagIndex >= 0 && !changeFilter) {
  console.error('Usage: calibrate.mjs <repo> [--change <name>] [--json]');
  process.exit(2);
}
const positional = args.filter((arg, index) => !arg.startsWith('--') && (changeFlagIndex < 0 || index !== changeFlagIndex + 1));
const repo = path.resolve(positional[0] || '.');
if (!fs.existsSync(repo) || !fs.statSync(repo).isDirectory()) {
  console.error('Usage: calibrate.mjs <repo> [--change <name>] [--json]');
  process.exit(2);
}

function git(gitArgs) {
  const result = spawnSync('git', gitArgs, { cwd: repo, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

if (git(['rev-parse', '--is-inside-work-tree']) !== 'true') {
  console.error(`[calibrate] ${repo} is not a git repository`);
  process.exit(2);
}

const FALLBACK_MODEL = {
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

const { DEFAULT_MODEL } = await import(new URL('./lib/schedule.mjs', import.meta.url).href)
  .catch(() => ({ DEFAULT_MODEL: {} }));
const importedModel = DEFAULT_MODEL && Object.keys(DEFAULT_MODEL).length ? DEFAULT_MODEL : FALLBACK_MODEL;

const BRANCH = /^task\/([^/]+)\/([A-Za-z][A-Za-z0-9]*-\d+)(?:-a(\d+))?$/;
const IMPLEMENTATION_ROLES = new Set(['gongbu', 'gaogong', 'jiangzuo', 'writer', 'implementer']);
const TEST_ROLES = new Set(['ceshi', 'tester']);

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
const minutes = (seconds) => seconds / 60;
const msToMinutes = (milliseconds) => milliseconds / 60000;
const round1 = (value) => (value == null ? null : Math.round(value * 10) / 10);

function commitTime(sha) {
  const out = git(['show', '-s', '--format=%ct', sha]);
  return out ? Number(out) : null;
}
function commitRole(sha) {
  const out = git(['show', '-s', '--format=%(trailers:key=Pipeline-Role,valueonly)', sha]);
  return (out || '').split(/\r?\n/).map((line) => line.trim().toLowerCase()).filter(Boolean);
}
function commitFiles(sha) {
  const out = git(['diff-tree', '--no-commit-id', '--name-only', '-r', sha]);
  return out ? out.split(/\r?\n/).filter(Boolean) : [];
}

// ---- task branches ----
const branchLines = (git(['for-each-ref', '--format=%(refname:short)', 'refs/heads']) || '')
  .split(/\r?\n/).filter(Boolean);
const allBranches = [];
for (const name of branchLines) {
  const match = name.match(BRANCH);
  if (!match) continue;
  const [, change, task, attempt] = match;
  if (changeFilter && change !== changeFilter) continue;
  allBranches.push({ name, change, task, attempt: Number(attempt || 1) });
}

// ---- frozen contract: Est and Review per task ----
function readContract(change) {
  const file = path.join(repo, 'openspec', 'changes', change, 'tasks.md');
  let markdown;
  try { markdown = fs.readFileSync(file, 'utf8'); } catch { return { est: new Map(), review: new Map() }; }
  const parsed = parseTasks(markdown);
  const review = new Map(parsed.tasks.map((task) => [task.id, task.review]));
  const est = new Map();
  let current = null;
  for (const line of markdown.split(/\r?\n/)) {
    const taskLine = parseTaskLine(line);
    if (taskLine) { current = taskLine.id; continue; }
    const field = line.match(/^\s+[-*]\s+([^:]+):\s*(.*)$/);
    if (!field) {
      if (current && /^\s*[^#\s]/.test(line)) current = null;
      continue;
    }
    if (!current) continue;
    if (field[1].trim().toLowerCase() === 'est') {
      const size = field[2].trim().toUpperCase().match(/\b(S|M|L)\b/);
      if (size) est.set(current, size[1]);
    }
  }
  return { est, review };
}
const contracts = new Map();
function contractFor(change) {
  if (!contracts.has(change)) contracts.set(change, readContract(change));
  return contracts.get(change);
}

// ---- per-branch measurements ----
// Commits on the task branch that the integration branch never received: the branch's
// own history, oldest first. After a merge the task tip is an ancestor of integration,
// so the bound is the merge's first parent, not the integration tip.
function branchCommits(entry, merge) {
  const tip = git(['rev-parse', '--verify', '--quiet', `${entry.name}^{commit}`]);
  if (!tip) return { tip: null, commits: [] };
  let base = null;
  if (merge) {
    const before = git(['rev-parse', '--verify', '--quiet', `${merge.sha}^1`]);
    if (before) base = git(['merge-base', tip, before]);
  }
  const integrationTip = git(['rev-parse', '--verify', '--quiet', `refs/heads/integration/${entry.change}`]);
  for (const other of [integrationTip, git(['rev-parse', '--verify', '--quiet', 'refs/heads/main'])]) {
    if (base) break;
    if (other) base = git(['merge-base', tip, other]);
  }
  const range = base ? `${base}..${tip}` : tip;
  const shas = (git(['rev-list', '--reverse', range]) || '').split(/\r?\n/).filter(Boolean);
  return { tip, commits: shas };
}

function mergeFor(tip, change) {
  const integration = `integration/${change}`;
  if (!git(['rev-parse', '--verify', '--quiet', `refs/heads/${integration}`])) return null;
  const merges = (git(['rev-list', '--merges', '--first-parent', integration]) || '').split(/\r?\n/).filter(Boolean);
  for (const sha of merges) {
    const parents = (git(['rev-list', '--parents', '-n', '1', sha]) || '').split(/\s+/).slice(1);
    if (parents.includes(tip)) return { sha, ct: commitTime(sha) };
  }
  return null;
}

function measure(entry) {
  const tipBefore = git(['rev-parse', '--verify', '--quiet', `${entry.name}^{commit}`]);
  if (!tipBefore) return null;
  const merge = mergeFor(tipBefore, entry.change);
  const { tip, commits } = branchCommits(entry, merge);
  if (!tip || !commits.length) return null;
  const rows = commits.map((sha) => ({ sha, ct: commitTime(sha), roles: commitRole(sha), files: commitFiles(sha) }));
  const isTest = (row) => row.roles.some((role) => TEST_ROLES.has(role));
  const isImpl = (row) => row.roles.some((role) => IMPLEMENTATION_ROLES.has(role));

  let testRow = rows.find(isTest);
  if (!testRow) {
    // Legacy branch with no trailers: a commit touching only test paths is the Red commit.
    testRow = rows.find((row) => row.files.length > 0 && row.files.every(isTestPath));
  }
  let implIndex = rows.findIndex((row, index) => isImpl(row) && (!testRow || index > rows.indexOf(testRow)));
  if (implIndex < 0) {
    implIndex = rows.findIndex((row, index) => (!testRow || index > rows.indexOf(testRow)) && row.files.some((file) => !isTestPath(file)));
  }
  if (implIndex < 0) implIndex = testRow ? -1 : 0;
  const implRow = implIndex >= 0 ? rows[implIndex] : null;
  const later = implIndex >= 0 ? rows.slice(implIndex + 1) : [];

  const redToImpl = testRow && implRow && testRow.ct != null && implRow.ct != null
    ? minutes(implRow.ct - testRow.ct) : null;
  const implToMerge = implRow && merge && implRow.ct != null && merge.ct != null
    ? minutes(merge.ct - implRow.ct) : null;

  const reworkRows = later.filter((row) => (isImpl(row) || row.roles.length === 0));
  const reworkGaps = [];
  let previous = implRow;
  for (const row of reworkRows) {
    if (previous && previous.ct != null && row.ct != null) reworkGaps.push(minutes(row.ct - previous.ct));
    previous = row;
  }

  const contract = contractFor(entry.change);
  return {
    branch: entry.name,
    change: entry.change,
    task: entry.task,
    attempt: entry.attempt,
    est: contract.est.get(entry.task) || null,
    review: contract.review.get(entry.task) || null,
    merged: Boolean(merge),
    redToImplMin: redToImpl,
    implToMergeMin: implToMerge,
    reworkCommits: reworkRows.length,
    reworkGaps,
  };
}

// One sample per task: prefer the attempt that actually merged, else the newest attempt.
const byTask = new Map();
for (const entry of allBranches) {
  const sample = measure(entry);
  if (!sample) continue;
  const key = `${sample.change}/${sample.task}`;
  const existing = byTask.get(key);
  if (!existing
    || (sample.merged && !existing.merged)
    || (sample.merged === existing.merged && sample.attempt > existing.attempt)) {
    byTask.set(key, sample);
  }
}
const samples = [...byTask.values()];

// ---- run-log timings ----
const changeNames = changeFilter
  ? [changeFilter]
  : [...new Set([...allBranches.map((entry) => entry.change),
    ...(fs.existsSync(path.join(repo, 'openspec', 'changes'))
      ? fs.readdirSync(path.join(repo, 'openspec', 'changes'), { withFileTypes: true })
        .filter((entry) => entry.isDirectory()).map((entry) => entry.name)
      : [])])];
const verifySamples = [];
const regressionSamples = [];
for (const change of changeNames) {
  const file = path.join(repo, 'openspec', 'changes', change, 'run-log.md');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
  for (const match of text.matchAll(/timing_ms=(\{[^}]*\})/g)) {
    let timing;
    try { timing = JSON.parse(match[1]); } catch { continue; }
    if (Number.isFinite(timing.verify)) verifySamples.push(msToMinutes(timing.verify));
    if (Number.isFinite(timing.regression)) regressionSamples.push(msToMinutes(timing.regression));
  }
}

// ---- model ----
const model = { ...importedModel };
const defaultImpl = (importedModel && typeof importedModel.implMin === 'object') ? importedModel.implMin : { S: 15, M: 25, L: 45 };
const defaultReview = (importedModel && typeof importedModel.reviewMin === 'object')
  ? importedModel.reviewMin : { strict: 30, standard: 25, deferred: 0, mechanical: 0 };
const defaultReworkRate = (importedModel && typeof importedModel.reworkRate === 'object')
  ? importedModel.reworkRate : { strict: 0.35, standard: 0.2, deferred: 0.2, mechanical: 0 };

const sizes = ['S', 'M', 'L'];
const redToImplValues = samples.map((sample) => sample.redToImplMin).filter(Number.isFinite);
const implToMergeValues = samples.map((sample) => sample.implToMergeMin).filter(Number.isFinite);
const reworkGapValues = samples.flatMap((sample) => sample.reworkGaps || []).filter(Number.isFinite);
const redToImplOverall = median(redToImplValues);
const implToMergeOverall = median(implToMergeValues);
const reworkGapMedian = median(reworkGapValues);

const estSamples = samples.filter((sample) => sample.est && Number.isFinite(sample.redToImplMin));
const perSize = Object.fromEntries(sizes.map((size) => [
  size,
  median(estSamples.filter((sample) => sample.est === size).map((sample) => sample.redToImplMin)),
]));
const perSizeMerge = Object.fromEntries(sizes.map((size) => [
  size,
  median(samples.filter((sample) => sample.est === size && Number.isFinite(sample.implToMergeMin))
    .map((sample) => sample.implToMergeMin)),
]));

if (redToImplOverall != null) {
  const next = { ...defaultImpl };
  for (const size of sizes) next[size] = round1(perSize[size] != null ? perSize[size] : redToImplOverall);
  model.implMin = next;
}

if (implToMergeOverall != null) {
  const verifyMin = median(verifySamples);
  const regressionMin = median(regressionSamples);
  const overhead = (verifyMin ?? 0) + (regressionMin ?? 0);
  const reviewMinutes = overhead > 0 && overhead < implToMergeOverall
    ? implToMergeOverall - overhead
    : implToMergeOverall;
  model.reviewMin = {
    ...defaultReview,
    strict: round1(reviewMinutes),
    standard: round1(reviewMinutes),
  };
}

if (reworkGapMedian != null) model.reworkMin = round1(reworkGapMedian);
const regressionMedian = median(regressionSamples);
if (regressionMedian != null) model.regressionMinPerTask = round1(regressionMedian);

const sampleCount = samples.length;
const reworked = samples.filter((sample) => sample.reworkCommits > 0).length;
const reworkRate = sampleCount ? Number((reworked / sampleCount).toFixed(2)) : 0;
const byReview = new Map();
for (const sample of samples) {
  if (!sample.review) continue;
  const bucket = byReview.get(sample.review) || { total: 0, reworked: 0 };
  bucket.total += 1;
  if (sample.reworkCommits > 0) bucket.reworked += 1;
  byReview.set(sample.review, bucket);
}
if (byReview.size) {
  const next = { ...defaultReworkRate };
  for (const [review, bucket] of byReview) next[review] = Number((bucket.reworked / bucket.total).toFixed(2));
  model.reworkRate = next;
}

const measured = {
  redToImplMin: { overall: round1(redToImplOverall), bySize: Object.fromEntries(sizes.map((size) => [size, round1(perSize[size])])) },
  implToMergeMin: { overall: round1(implToMergeOverall), bySize: Object.fromEntries(sizes.map((size) => [size, round1(perSizeMerge[size])])) },
  verifyMin: round1(median(verifySamples)),
  regressionMin: round1(regressionMedian),
  reworkMin: round1(reworkGapMedian),
  reworkCommitsPerTask: round1(median(samples.map((sample) => sample.reworkCommits))),
};
const confidence = sampleCount < 5 ? 'low' : 'medium';
const notes = [];
notes.push('implMin is measured as test-author commit -> first implementation commit.');
if (verifySamples.length || regressionSamples.length) notes.push('reviewMin subtracts measured verify+regression phases from the impl->merge interval.');
else notes.push('no run-log timing_ms found; reviewMin is the raw impl->merge interval.');
notes.push('redMin, mergeMin and concurrency caps are not measurable from git and keep their defaults.');
if (!samples.some((sample) => sample.est)) notes.push('no Est: field in the frozen tasks.md; implMin uses the overall median for every size.');
if (sampleCount < 5) notes.push(`only ${sampleCount} task sample(s); confidence is low (needs 5).`);

const result = {
  ...model,
  change: changeFilter,
  samples: { tasks: sampleCount, branches: allBranches.length, reworkRate },
  confidence,
  measured,
  notes,
};

if (json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`[calibrate] ${repo}${changeFilter ? ` change=${changeFilter}` : ''}`);
  console.log(`samples tasks=${sampleCount} branches=${allBranches.length} reworkRate=${reworkRate} confidence=${confidence}`);
  console.log(`implMin S=${model.implMin?.S} M=${model.implMin?.M} L=${model.implMin?.L} (measured red->impl median=${measured.redToImplMin.overall ?? 'n/a'} min)`);
  console.log(`reviewMin strict=${model.reviewMin?.strict} standard=${model.reviewMin?.standard} (measured impl->merge median=${measured.implToMergeMin.overall ?? 'n/a'} min)`);
  console.log(`reworkMin=${model.reworkMin} regressionMinPerTask=${model.regressionMinPerTask}`);
  for (const note of notes) console.log(`NOTE ${note}`);
  for (const sample of samples) {
    console.log(`SAMPLE ${sample.branch} est=${sample.est ?? '-'} red->impl=${round1(sample.redToImplMin) ?? '-'}m impl->merge=${round1(sample.implToMergeMin) ?? '-'}m rework=${sample.reworkCommits}`);
  }
}
