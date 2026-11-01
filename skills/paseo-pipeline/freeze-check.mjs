#!/usr/bin/env node
// Freeze gate: validate the DAG before humans confirm CP-1.
// Deliberately small: syntax, DAG, scenario mapping, wave conflicts, narrow Verify.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseTasks, computeWaves, normalizeScope, isFileWithinScopes, isTestPath, verifyLegs, FULL_SUITE_LEG } from './lib/tasks.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
// --structural: validate the contract the authors wrote, before hanlin reviews it. The R0
// sign-off is the output of that review, so requiring it here would deadlock the entry flow.
const structural = args.includes('--structural');
const positional = args.filter((arg) => !arg.startsWith('--'));
const changeDir = positional[0];
if (!changeDir) {
  console.error('Usage: freeze-check.mjs <change-dir> [--json] [--structural]');
  process.exit(2);
}

function read(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}
function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name === 'spec.md') out.push(full);
  }
  return out;
}

const tasksMarkdown = read(path.join(changeDir, 'tasks.md'));
if (tasksMarkdown === null) {
  if (json) console.log(JSON.stringify({ error: 'tasks.md not found' }));
  else console.error('[freeze-check] tasks.md not found');
  process.exit(1);
}

const { tasks, errors } = parseTasks(tasksMarkdown);
const blocking = errors.map((error) => `${error.code}${error.task ? ` ${error.task}` : ''}: ${error.message}`);

// Scenario mapping.
const declared = new Map();
for (const file of walk(path.join(changeDir, 'specs'))) {
  for (const line of read(file).split(/\r?\n/)) {
    const match = line.match(/^#{3,6}\s*Scenario\s*:\s*(SCEN-[A-Za-z0-9-]+)(?:\s+.*)?$/i);
    if (match) declared.set(match[1].toUpperCase(), path.relative(changeDir, file));
  }
}
const claimed = new Map(tasks.flatMap((task) => task.scenarios.map((scen) => [scen.toUpperCase(), task.id])));
for (const task of tasks) {
  for (const scen of task.scenarios) {
    if (!declared.has(scen.toUpperCase())) blocking.push(`UNKNOWN_SCEN ${task.id}: ${scen} is not declared`);
  }
}
for (const [scen, file] of declared) {
  if (!claimed.has(scen)) blocking.push(`UNCLAIMED_SCEN: ${scen} (${file}) has no task`);
}

// Wave partition. Waves are planning data only; runtime dispatch follows the ready frontier.
const waves = computeWaves(tasks);
const sinkIds = new Set(tasks.filter((task) => !tasks.some((other) => other.depends.includes(task.id))).map((task) => task.id));
const waveList = [...waves.entries()].sort((a, b) => a[0] - b[0]).map(([wave, ids]) => ({ wave, ids }));
const maxWidth = waveList.reduce((max, item) => Math.max(max, item.ids.length), 0);

// Frontier scheduling runs any two tasks concurrently unless one transitively depends on the other,
// so scope overlap is checked on every unordered pair, not only within a wave.
const byId = new Map(tasks.map((task) => [task.id, task]));
const ancestors = new Map();
const ancestorsOf = (id, trail = new Set()) => {
  if (ancestors.has(id)) return ancestors.get(id);
  const out = new Set();
  if (!trail.has(id)) {
    trail.add(id);
    for (const dep of byId.get(id)?.depends ?? []) { out.add(dep); ancestorsOf(dep, trail).forEach((x) => out.add(x)); }
  }
  ancestors.set(id, out);
  return out;
};
for (let i = 0; i < tasks.length; i += 1) {
  for (let j = i + 1; j < tasks.length; j += 1) {
    const left = tasks[i];
    const right = tasks[j];
    if (ancestorsOf(left.id).has(right.id) || ancestorsOf(right.id).has(left.id)) continue;
    const clash = left.scope.some((scope) => right.scope.some((other) => {
      const a = normalizeScope(scope);
      const b = normalizeScope(other);
      return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
    }));
    if (clash) blocking.push(`SCOPE_CONFLICT ${left.id} and ${right.id}: scopes overlap and neither depends on the other; add Depends on or split scope`);
  }
}

// Narrow verification. A leg is narrow when its paths all sit inside the task
// Write scope; a leg without paths must not invoke a whole-suite runner. One sink
// may run one broad leg; final acceptance always runs on integration HEAD.
for (const task of tasks) {
  const legs = verifyLegs(task.verify);
  const broadLegs = legs.filter((leg) => leg.broad).length;
  // A leg must also prove something: a known test runner, or a test/spec path. `true`,
  // `echo ok` and `node src/a.mjs` pass a path-only check but verify nothing.
  const proves = (leg) => FULL_SUITE_LEG.test(leg.command) || leg.paths.some((p) => /(?:test|spec)/i.test(p));
  const unscoped = legs.filter((leg) => !leg.broad && (!proves(leg) || leg.paths.some((path) => !isFileWithinScopes(path, task.scope))));
  if (broadLegs && !sinkIds.has(task.id)) {
    blocking.push(`VERIFY_FULL_SUITE_NON_SINK ${task.id}: full-suite command is reserved for the sole sink`);
  }
  if (!sinkIds.has(task.id) && (legs.length === 0 || unscoped.length > 0 || broadLegs > 0)) {
    blocking.push(`VERIFY_NOT_NARROW ${task.id}: every Verify leg must name a test/spec path inside Write scope${unscoped.length ? ` (outside: ${unscoped.map((leg) => leg.command).join(', ')})` : ''}`);
  }
  if (sinkIds.has(task.id) && broadLegs > 1) {
    blocking.push(`VERIFY_TOO_BROAD ${task.id}: sole sink may run at most one full-suite leg`);
  }
  if (sinkIds.has(task.id) && broadLegs === 1 && unscoped.length > 0) {
    blocking.push(`VERIFY_TOO_BROAD ${task.id}: combine full-suite and narrow checks on separate tasks/acceptance`);
  }
}
// Vertical slices: behavior tasks must claim a SCEN and own production code, not only tests.
for (const task of tasks) {
  if (task.review === 'mechanical') continue;
  if (!task.scenarios.length) blocking.push(`NO_SCEN ${task.id}: non-mechanical task must claim at least one SCEN (or be Review: mechanical)`);
  if (!sinkIds.has(task.id) && task.scope.length && task.scope.every((scope) => isTestPath(scope))) {
    blocking.push(`FIXTURE_ONLY_TASK ${task.id}: scope has only test paths; fold fixtures into the behavior task that breaks them`);
  }
}

// Impact inventory: exported symbols, call sites, affected fixtures and their owning task.
const designMarkdown = read(path.join(changeDir, 'design.md'));
if (!designMarkdown || !/^#{2,3}\s*Impact/im.test(designMarkdown)) {
  blocking.push('MISSING_IMPACT_INVENTORY: design.md needs an "Impact Inventory" section (changed symbols, call sites, affected fixtures -> owning task)');
} else {
  const section = designMarkdown.split(/^#{2,3}\s*Impact/im)[1].split(/^#{1,3}\s/m)[0].replace(/<!--[\s\S]*?-->/g, '');
  const known = new Set(tasks.map((task) => task.id));
  for (const id of new Set(section.match(/\b[A-Za-z][A-Za-z0-9]*-\d+\b/g) ?? [])) {
    if (/^SCEN-/i.test(id)) continue;
    if (!known.has(id)) blocking.push(`IMPACT_UNKNOWN_TASK ${id}: Impact Inventory names a task that is not in tasks.md`);
  }
}

const fullSuiteSinks = tasks.filter((task) => verifyLegs(task.verify).some((leg) => leg.broad));
if (fullSuiteSinks.length > 1) blocking.push(`TOO_MANY_FULL_SUITE_SINKS: ${fullSuiteSinks.map((task) => task.id).join(', ')}`);

const acceptanceMarkdown = read(path.join(changeDir, 'acceptance.md'));
if (!acceptanceMarkdown) blocking.push('MISSING_ACCEPTANCE: acceptance.md not found');
else {
  const acceptanceScenarios = new Set();
  const requiredRows = [];
  for (const line of acceptanceMarkdown.split(/\r?\n/)) {
    if (/^\s*\|\s*SCEN-[A-Za-z0-9-]+\s*\|/.test(line)) {
      const cells = line.split('|').slice(1, -1).map((cell) => cell.trim().replace(/^`|`$/g, ''));
      if (cells.length < 6) continue;
      acceptanceScenarios.add(cells[0].toUpperCase());
      if (/^yes$/i.test(cells[4])) requiredRows.push(cells);
    }
  }
  for (const scenario of acceptanceScenarios) {
    if (!declared.has(scenario)) blocking.push(`UNKNOWN_ACCEPTANCE_SCEN: ${scenario} is not declared`);
  }
  if (!requiredRows.length) blocking.push('MISSING_REQUIRED_ACCEPTANCE: acceptance.md has no Required=yes row');
  for (const cells of requiredRows) {
    if (cells[5] !== 'PENDING') blocking.push(`ACCEPTANCE_NOT_FROZEN ${cells[0]}: Result must start PENDING`);
    if (/^`?\s*(?:!|manual|手工|自然语言)/i.test(cells[3])) blocking.push(`BAD_ACCEPTANCE_VERIFY ${cells[0]}: Required=yes needs one executable command`);
  }
}

if (!read(path.join(changeDir, 'proposal.md'))) blocking.push('MISSING_PROPOSAL: proposal.md not found');

// R0 sign-off: hanlin must have reviewed the complete contract package before CP-1.
// hanlin is read-only and returns `R0: pass(<uuid>@<sha>)` as text; the main session records it
// as the first line of review.md. The sha is the commit hanlin reviewed, so any contract edit
// after it voids the sign-off. --structural skips this: it runs before the review exists.
function gitIn(dir, gitArgs) {
  return spawnSync('git', ['-C', dir, ...gitArgs], { encoding: 'utf8' });
}
const nulList = (result) => (result.stdout || '').split('\0').filter(Boolean);
if (!structural) {
  const reviewMarkdown = read(path.join(changeDir, 'review.md'));
  const r0Match = reviewMarkdown && reviewMarkdown.match(/^R0:\s*pass\(([^@)]+)@([a-f0-9]{7,40})\)/im);
  if (!r0Match) {
    blocking.push('MISSING_R0_SIGNOFF: review.md must contain `R0: pass(<reviewer-uuid>@<sha>)` — run hanlin R0 review before freeze');
  } else if (gitIn(changeDir, ['rev-parse', '--is-inside-work-tree']).status === 0) {
    const sha = r0Match[2];
    if (gitIn(changeDir, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]).status !== 0) {
      blocking.push(`STALE_R0_SIGNOFF: reviewed commit ${sha} does not exist in this repository`);
    } else {
      // Working tree (staged, unstaged, untracked) vs the reviewed commit; review.md is written after the review.
      const diff = gitIn(changeDir, ['diff', '--name-only', '-z', sha, '--', '.']);
      const untracked = gitIn(changeDir, ['ls-files', '--others', '--exclude-standard', '-z', '--', '.']);
      const drift = [...new Set([...nulList(diff), ...nulList(untracked)])].filter((file) => path.basename(file) !== 'review.md');
      if (diff.status !== 0) blocking.push(`STALE_R0_SIGNOFF: cannot diff contract against reviewed commit ${sha}`);
      else if (drift.length) blocking.push(`STALE_R0_SIGNOFF: contract changed after R0 reviewed ${sha}: ${drift.slice(0, 5).join(', ')} — re-run hanlin R0`);
    }
  }
}

if (tasks.length === 0) blocking.push('EMPTY_TASKS: tasks.md parsed to zero tasks');
const route = maxWidth >= 2 && tasks.length >= 4 ? 'pipeline' : 'handoff';
const summary = {
  change: path.resolve(changeDir),
  tasks: tasks.length,
  waves: waveList,
  maxWidth,
  criticalPath: waveList.length,
  route,
  blocking: [...new Set(blocking)],
};
if (json) console.log(JSON.stringify(summary, null, 2));
else {
  console.log(`[freeze-check] ${summary.change}`);
  console.log(`tasks=${tasks.length} waves=${waveList.length} maxWidth=${maxWidth} criticalPath=${waveList.length}`);
  console.log(`[ROUTE] ${route}${route === 'pipeline' ? ': DAG has real concurrency' : ': no concurrency benefit; use Tier 2 handoff'}`);
  for (const wave of waveList) console.log(`WAVE ${wave.wave}: ${wave.ids.join(', ')}`);
  for (const item of summary.blocking) console.error(`BLOCK ${item}`);
  console.log(summary.blocking.length ? `RESULT freeze rejected (${summary.blocking.length})` : 'RESULT freeze ok');
}
process.exit(summary.blocking.length ? 1 : 0);
