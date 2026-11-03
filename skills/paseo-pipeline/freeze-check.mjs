#!/usr/bin/env node
// Freeze gate: validate the DAG before humans confirm CP-1.
// Deliberately small: syntax, DAG, scenario mapping, wave conflicts, narrow Verify.

import fs from 'node:fs';
import path from 'node:path';
import { listAgents, inspectAgent, findAgents, nameOf } from './lib/paseo-agents.mjs';
import { parseTasks, computeWaves, normalizeScope, isFileWithinScopes, isTestPath, verifyLegs, FULL_SUITE_LEG } from './lib/tasks.mjs';
import { weightedSpeedup, weightedCriticalPath, verifyScope, dispatchDeps, readsOnlyEdges, pathWithin } from './lib/schedule.mjs';
import { runGit } from './lib/git.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const explain = args.includes('--explain');
// --structural: validate the contract the authors wrote, before hanlin reviews it. The R0
// sign-off is the output of that review, so requiring it here would deadlock the entry flow.
const structural = args.includes('--structural');
// --skip-signer-check: offline escape hatch; the R0 signer uuid is then format-checked only.
const skipSignerCheck = args.includes('--skip-signer-check');
const positional = args.filter((arg) => !arg.startsWith('--'));
const changeDir = positional[0];
if (!changeDir) {
  console.error('Usage: freeze-check.mjs <change-dir> [--json] [--explain] [--structural] [--skip-signer-check]');
  process.exit(2);
}

function read(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name === 'spec.md') out.push(full);
  }
  return out;
}

// One concrete fix per blocking rule, printed by --explain.
const RULE_FIXES = {
  MALFORMED_LINE: 'rewrite the task line as `- [ ] <n> T-<id> <title>` with a valid id',
  DUPLICATE_ID: 'give every task a unique id',
  MISSING_SCOPE: 'add a non-empty `Write scope:` of repo-relative paths',
  MISSING_VERIFY: 'add an executable `Verify with:` command',
  UNKNOWN_REVIEW: 'use Review: strict, standard, mechanical or deferred',
  UNKNOWN_DEP: 'point Depends on at an existing task id',
  SELF_DEP: 'remove the self-dependency',
  CYCLE: 'break the dependency cycle into a DAG',
  BAD_READS: 'use repo-relative paths without `..` or a leading slash',
  MISSING_READS_PATH: 'point Reads at a path that already exists in the repository; Reads is a read-only anchor, not a file the task creates',
  MALFORMED_ACCEPTANCE_ROW: 'escape a literal pipe inside a cell as `\\|`, or keep one cell free of `|`; the row must have the header column count',
  VERIFY_JUNK_LEG: 'put shell setup inside the leg it belongs to: `bash -c \'set -e; <command>\'`, or use `&&` between real commands',
  BAD_EST: 'use Est: S, M or L',
  BAD_INTERFACE: 'use Interface: <repo-path>[#<symbol>]',
  BAD_KIND: 'use Kind: skeleton (or omit it)',
  UNKNOWN_SCEN: 'claim a SCEN declared under specs/',
  UNCLAIMED_SCEN: 'assign each declared SCEN to at least one task',
  NO_SCEN: 'claim at least one SCEN, or mark the task Review: mechanical',
  EMPTY_TASKS: 'write at least one parseable task line',
};

const tasksMarkdown = read(path.join(changeDir, 'tasks.md'));
if (tasksMarkdown === null) {
  if (json) console.log(JSON.stringify({ error: 'tasks.md not found' }));
  else console.error('[freeze-check] tasks.md not found');
  process.exit(1);
}

const { tasks, errors } = parseTasks(tasksMarkdown);
const blocking = errors.map((error) => `${error.code}${error.task ? ` ${error.task}` : ''}: ${error.message}`);
const advisories = [];
const fixes = new Map();
if (blocking.length) fixes.set('CONTRACT', 'fix the field named in the message; see openspec-schema/templates/tasks.md for the exact shape');

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
// A sink is a task nothing consumes. `Uses` is a merge edge too (the consumer merges
// after the producer), so a producer read only through Uses is still not a sink; counting
// `depends` alone falsely marked such producers as sinks and rejected their deferred review.
const sinkIds = new Set(tasks
  .filter((task) => !tasks.some((other) => (other.depends || []).includes(task.id) || (other.uses || []).includes(task.id)))
  .map((task) => task.id));
const waveList = [...waves.entries()].sort((a, b) => a[0] - b[0]).map(([wave, ids]) => ({ wave, ids }));
const maxWidth = waveList.reduce((max, item) => Math.max(max, item.ids.length), 0);

const scopesClash = (left, right) => left.scope.some((scope) => right.scope.some((other) => pathWithin(normalizeScope(scope), normalizeScope(other))));

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
// A Uses edge makes the consumer wait for the producer's merge, so it serialises a pair exactly
// like Depends on does — including the skeleton exemption below.
const orderedPair = (left, right) => ancestorsOf(left.id).has(right.id) || ancestorsOf(right.id).has(left.id)
  || left.uses?.includes(right.id) || right.uses?.includes(left.id);
const skeletonCovers = (skeleton, other) => skeleton.kind === 'skeleton' && other.id !== skeleton.id
  && (dispatchDeps(other, tasks).includes(skeleton.id) || other.uses?.includes(skeleton.id));
for (let i = 0; i < tasks.length; i += 1) {
  for (let j = i + 1; j < tasks.length; j += 1) {
    const left = tasks[i];
    const right = tasks[j];
    if (orderedPair(left, right)) continue;
    // The skeleton owns the interface files every consumer imports; consumers depend on it, so
    // their overlap is serialised by the dependency rather than a hidden race.
    if (skeletonCovers(left, right) || skeletonCovers(right, left)) continue;
    if (scopesClash(left, right)) {
      blocking.push(`SCOPE_CONFLICT ${left.id} and ${right.id}: scopes overlap and neither depends on the other; add Depends on or split scope`);
      fixes.set('SCOPE_CONFLICT', 'add a Depends on edge between the pair, or give each task its own files');
    }
  }
}

// Uses/Reads/skeleton contract. Dispatch treats Uses as "start as soon as the interface is frozen";
// merge still waits for the producer, so a Uses pair that writes the same files needs a real
// Depends on edge to serialise the writers.
const dependsBetween = (a, b) => ancestorsOf(a).has(b) || ancestorsOf(b).has(a);
const skeletons = tasks.filter((task) => task.kind === 'skeleton');
for (const task of tasks) {
  for (const used of task.uses || []) {
    if (used === task.id || !byId.has(used)) {
      blocking.push(`USES_UNKNOWN ${task.id}: Uses ${used} is not a task in this file; name a real producer or use Depends on`);
      fixes.set('USES_UNKNOWN', 'point Uses at an existing task id (never the task itself)');
      continue;
    }
    const target = byId.get(used);
    if (!target.interface.length) {
      blocking.push(`USES_WITHOUT_INTERFACE ${task.id}: Uses ${used} but ${used} declares no Interface; freeze the symbol on the producer`);
      fixes.set('USES_WITHOUT_INTERFACE', `add Interface: <path>#<symbol> to ${used}, or use Depends on if the implementation is required`);
    }
    if (scopesClash(task, target) && !dependsBetween(task.id, target.id)) {
      blocking.push(`USES_SCOPE_OVERLAP ${task.id} and ${used}: Write scopes overlap but no Depends on edge exists; Uses only skips the implementation wait`);
      fixes.set('USES_SCOPE_OVERLAP', 'add a Depends on edge between the producer and consumer, or split the overlapping Write scope');
    }
  }
  for (const entry of task.interface || []) {
    const interfacePath = entry.split('#')[0];
    if (!skeletons.some((skeleton) => isFileWithinScopes(interfacePath, skeleton.scope))) {
      blocking.push(`INTERFACE_UNOWNED ${task.id}: Interface ${entry} is not inside any Kind: skeleton Write scope`);
      fixes.set('INTERFACE_UNOWNED', 'move the interface file into a Kind: skeleton task Write scope, or declare the skeleton that owns it');
    }
  }
  if (task.kind === 'skeleton' && task.review !== 'mechanical') {
    blocking.push(`SKELETON_NOT_MECHANICAL ${task.id}: Kind: skeleton requires Review: mechanical`);
    fixes.set('SKELETON_NOT_MECHANICAL', `set Review: mechanical on ${task.id}`);
  }
  if (task.review === 'deferred') {
    if (sinkIds.has(task.id)) {
      blocking.push(`DEFERRED_NOT_STANDARD ${task.id}: the sink cannot defer review; FINAL review owns it and the sink is its entry point`);
      fixes.set('DEFERRED_NOT_STANDARD', 'use Review: standard or strict on the sink; only non-sink standard tasks may defer');
    }
    if (task.riskSurface.some((risk) => risk === 'persistence' || risk === 'security')) {
      blocking.push(`DEFERRED_NOT_STANDARD ${task.id}: Risk-surface ${task.riskSurface.join(', ')} must be Review: strict and reviewed inline`);
      fixes.set('DEFERRED_NOT_STANDARD', 'set Review: strict for persistence/security surfaces; deferred is only for standard tasks');
    }
  }
}

// Reads is a read-only anchor: it must already exist, unless another task's Write scope
// will create it. A greenfield consumer legitimately verifies against a module a sibling
// produces (and `merge-task` must replay it when that sibling merges), so a forward
// reference inside a Write scope is allowed. A path that is neither on disk nor inside any
// Write scope is a typo and still blocks; it must not silently degrade to "no anchor".
{
  const toplevel = gitIn(changeDir, ['rev-parse', '--show-toplevel']);
  if (toplevel.status === 0) {
    const repoRoot = toplevel.stdout.trim();
    for (const task of tasks) {
      for (const read of task.reads) {
        if (fs.existsSync(path.join(repoRoot, read))) continue;
        if (tasks.some((other) => isFileWithinScopes(read, other.scope))) continue;
        blocking.push(`MISSING_READS_PATH ${task.id}: Reads ${read} does not exist in the repository`);
      }
    }
  }
}

// Narrow verification. A leg is narrow when its paths all sit inside the task
// Write scope (or its reads-only anchors); a leg without paths must not invoke a
// whole-suite runner. One sink may run one broad leg; final acceptance always
// runs on integration HEAD.
const SHELL_CONSTRUCT = /\b(?:for|while|if|case|until)\b/;
// `set -e; cmd` and `a || exit 1` are shell setup, not verify legs. commandParts
// splits them into legs that prove nothing; name the real cause instead of the
// downstream VERIFY_NOT_NARROW.
const CONTROL_LEG = /^(?:set(?:\s|$)|exit(?:\s|$)|true$|false$|do(?:\s|$)|done$|fi$|else$|then$|esac$)/;
for (const task of tasks) {
  const legs = verifyLegs(task.verify);
  const broadLegs = legs.filter((leg) => leg.broad).length;
  // A leg must also prove something: a known test runner, or a test/spec path. `true`,
  // `echo ok` and `node src/a.mjs` pass a path-only check but verify nothing.
  const proves = (leg) => FULL_SUITE_LEG.test(leg.command) || leg.paths.some((p) => /(?:test|spec)/i.test(p));
  const allowed = verifyScope(task);
  const unscoped = legs.filter((leg) => !leg.broad && (!proves(leg) || leg.paths.some((path) => !isFileWithinScopes(path, allowed))));
  // Shell loops are legitimate (a sink iterating `scripts/specs/*.mjs`), but the
  // leg splitter cannot see inside them; report that instead of inventing legs.
  if (SHELL_CONSTRUCT.test(task.verify)) {
    advisories.push(`ADVISORY_SHELL_VERIFY ${task.id}: Verify uses shell control syntax; freeze-check splits legs naively, so only whole-command checks apply`);
  } else {
    const junk = legs.filter((leg) => CONTROL_LEG.test(leg.command));
    if (junk.length) {
      blocking.push(`VERIFY_JUNK_LEG ${task.id}: ${junk.map((leg) => `"${leg.command}"`).join(', ')} is shell setup, not a verify leg`);
    }
    if (/\|\|/.test(task.verify)) {
      blocking.push(`VERIFY_JUNK_LEG ${task.id}: \`||\` is split into two mandatory legs; use \`&&\` or \`bash -c '...'\``);
    }
  }
  if (broadLegs && !sinkIds.has(task.id)) {
    blocking.push(`VERIFY_FULL_SUITE_NON_SINK ${task.id}: full-suite command is reserved for the sole sink`);
    fixes.set('VERIFY_FULL_SUITE_NON_SINK', 'replace the full-suite leg with a narrow test path, and leave the suite to the sink');
  }
  // A sink with no full-suite leg is just a task: its Verify must be narrow too (mechanical tasks may run any check).
  const mustBeNarrow = !sinkIds.has(task.id) || (broadLegs === 0 && task.review !== 'mechanical');
  if (mustBeNarrow && (legs.length === 0 || unscoped.length > 0 || broadLegs > 0)) {
    blocking.push(`VERIFY_NOT_NARROW ${task.id}: every Verify leg must name a test/spec path inside Write scope${unscoped.length ? ` (outside: ${unscoped.map((leg) => leg.command).join(', ')})` : ''}`);
    fixes.set('VERIFY_NOT_NARROW', 'name a runnable test path inside Write scope or Reads, or add that anchor to Reads (Reads never authorises edits)');
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
  // A literal `|` inside a cell silently changed the column count and the old parser
  // just skipped the row. Count against the header instead, and accept `\|`.
  const cellsOf = (line) => line.split(/(?<!\\)\|/).slice(1, -1)
    .map((cell) => cell.trim().replace(/\\\|/g, '|').replace(/^`|`$/g, ''));
  const lines = acceptanceMarkdown.split(/\r?\n/);
  const header = lines.find((line) => /^\s*\|.*\|\s*$/.test(line) && /\bScenario\b/i.test(line));
  const expectedColumns = header ? cellsOf(header).length : 7;
  let rowNumber = 0;
  for (const line of lines) {
    rowNumber += 1;
    if (!/^\s*\|\s*SCEN-[A-Za-z0-9-]+\s*\|/.test(line)) continue;
    const cells = cellsOf(line);
    if (cells.length !== expectedColumns) {
      blocking.push(`MALFORMED_ACCEPTANCE_ROW acceptance.md:${rowNumber}: ${cells.length} cells, header has ${expectedColumns}; a literal \`|\` must be written \`\\|\``);
      continue;
    }
    acceptanceScenarios.add(cells[0].toUpperCase());
    if (/^yes$/i.test(cells[4])) requiredRows.push(cells);
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
// as a line of review.md (the LAST such line counts, so a post-CP-1 contract delta is re-signed by
// appending a new line instead of deadlocking on STALE_R0_SIGNOFF). The sha is the commit hanlin reviewed, so any contract edit
// after it voids the sign-off. --structural skips this: it runs before the review exists.
function gitIn(dir, gitArgs) {
  return runGit(dir, gitArgs);
}
const nulList = (result) => (result.stdout || '').split('\0').filter(Boolean);
if (!structural) {
  const reviewMarkdown = read(path.join(changeDir, 'review.md'));
  const r0Match = reviewMarkdown ? [...reviewMarkdown.matchAll(/^R0:\s*pass\(([^@)]+)@([a-f0-9]{7,40})\)/gim)].at(-1) : undefined;
  if (!r0Match) {
    blocking.push('MISSING_R0_SIGNOFF: review.md must contain `R0: pass(<reviewer-uuid>@<sha>)` — run hanlin R0 review before freeze');
  } else {
    // The signer must be a real Paseo agent, so a made-up uuid cannot satisfy the gate. Role is not
    // exposed by `paseo ls`; a name without `hanlin` is only an advisory, merge-task keeps the hard
    // reviewer-vs-author and model checks.
    if (!skipSignerCheck) {
      const signer = r0Match[1].trim();
      const { agents, error } = listAgents();
      // Unreachable Paseo is advisory, not a block: it says nothing about the signer, and
      // merge-task fails closed (exit 32) on the same lookup before anything is merged.
      if (error) advisories.push(`R0_SIGNER_UNVERIFIED: ${error}; signer ${signer} was not checked against Paseo`);
      else {
        const hits = findAgents(signer, agents);
        const resolved = hits.length === 1 ? hits[0] : hits.length === 0 ? inspectAgent(signer) : null;
        if (hits.length > 1) blocking.push(`R0_SIGNER_UNKNOWN: signer ${signer} matches ${hits.length} agents; use the full agent uuid`);
        else if (!resolved) blocking.push(`R0_SIGNER_UNKNOWN: signer ${signer} is not a Paseo agent`);
        else if (!/hanlin/i.test(nameOf(resolved))) advisories.push(`R0_SIGNER_NOT_HANLIN: signer name "${nameOf(resolved)}" does not mention hanlin; confirm the R0 reviewer was dispatched as hanlin`);
      }
    }
  }
  if (r0Match && gitIn(changeDir, ['rev-parse', '--is-inside-work-tree']).status === 0) {
    const sha = r0Match[2];
    if (gitIn(changeDir, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]).status !== 0) {
      blocking.push(`STALE_R0_SIGNOFF: reviewed commit ${sha} does not exist in this repository`);
    } else {
      // Working tree (staged, unstaged, untracked) vs the reviewed commit; review.md is written after the review.
      const diff = gitIn(changeDir, ['diff', '--name-only', '-z', sha, '--', '.']);
      const untracked = gitIn(changeDir, ['ls-files', '--others', '--exclude-standard', '-z', '--', '.']);
      // review.md is written after the review; rulings.md records accepted non-obvious
      // decisions made during it. Neither changes the contract, so neither is drift.
      const drift = [...new Set([...nulList(diff), ...nulList(untracked)])]
        .filter((file) => !['review.md', 'rulings.md'].includes(path.basename(file)));
      if (diff.status !== 0) blocking.push(`STALE_R0_SIGNOFF: cannot diff contract against reviewed commit ${sha}`);
      else if (drift.length) blocking.push(`STALE_R0_SIGNOFF: contract changed after R0 reviewed ${sha}: ${drift.slice(0, 5).join(', ')} — re-run hanlin R0`);
    }
  }
}

// Cross-change overlap: another change's integration branch that already touches files in this
// change's Write scope will collide at CP-2. Advisory only (LESSONS §12): never blocks, any git
// error or non-repo is silently skipped. Runs in both modes.
{
  const refs = gitIn(changeDir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/integration/']);
  const defaultBranch = refs.status === 0
    ? ['main', 'master'].find((name) => gitIn(changeDir, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]).status === 0)
    : undefined;
  if (defaultBranch) {
    const own = `integration/${path.basename(path.resolve(changeDir))}`;
    for (const branch of refs.stdout.split('\n').map((line) => line.trim()).filter((line) => line && line !== own)) {
      const diff = gitIn(changeDir, ['diff', '--name-only', '-z', `${defaultBranch}...${branch}`]);
      if (diff.status !== 0) continue;
      const changed = nulList(diff);
      for (const task of tasks) {
        const overlap = changed.filter((file) => isFileWithinScopes(file, task.scope));
        if (overlap.length) advisories.push(`CROSS_CHANGE_SCOPE_OVERLAP ${task.id} vs ${branch}: ${overlap.slice(0, 5).join(', ')}`);
      }
    }
  }
}

if (tasks.length === 0) blocking.push('EMPTY_TASKS: tasks.md parsed to zero tasks');
// Expected speedup of running the DAG concurrently vs one task at a time, weighted by the
// measured per-task cost model (lib/schedule.mjs). `speedup` keeps the legacy wave ratio for
// existing consumers; the advisory routes on the weighted number.
const speedup = waveList.length ? Number((tasks.length / waveList.length).toFixed(2)) : 0;
const weighted = weightedSpeedup(tasks);
// Critical chain: the longest path by the same weighted cost model the scheduler and the
// benchmark use (lib/schedule.mjs). The wave-based chain this used to print counted edges,
// not minutes, so it named a different path than the one that actually bounds the makespan
// and pointed the removable-edge advice at edges that were not the bottleneck.
// Each edge is tagged by why it exists: `scope` (shared files, forced), `uses` (an
// interface target), `reads` (only a shared read-only fixture connects the pair), or
// `logical` (author choice; the only removable kind).
const criticalChain = [];
{
  const weightedChain = weightedCriticalPath(tasks).chain;
  for (let index = 0; index < weightedChain.length; index += 1) {
    const id = weightedChain[index];
    const previous = index > 0 ? byId.get(weightedChain[index - 1]) : null;
    const current = byId.get(id);
    let via = null;
    if (previous && current) {
      if ((current.uses || []).includes(previous.id) && !(current.depends || []).includes(previous.id)) via = 'uses';
      else if (scopesClash(previous, current)) via = 'scope';
      else if ((previous.reads || []).length
        && (current.reads || []).some((read) => (previous.reads || []).some((other) => pathWithin(read, other)))) via = 'reads';
      else via = 'logical';
    }
    criticalChain.push({ id, via });
  }
}
if (tasks.length >= 4 && maxWidth >= 2 && weighted < 1.8) {
  advisories.push(`ADVISORY_LOW_SPEEDUP: weighted ${weighted}x (legacy ${speedup}x); compare with Tier 2 handoff before CP-1`);
}
// A dependency whose only shared surface is a read-only fixture is a candidate for removal:
// `merge-task` replays every Done task whose Verify scope overlaps the changed files, so the
// fixture is re-run against the merged tree whether or not the author serialised the pair.
// Advisory only — dropping the edge is a contract decision the author records in design.md.
{
  const chainIds = new Set(criticalChain.map((step) => step.id));
  const edges = readsOnlyEdges(tasks);
  if (edges.length) {
    const rendered = edges.map((edge) => `${edge.task} -> ${edge.dep} (${edge.shared.join(', ')})`
      + (chainIds.has(edge.task) && chainIds.has(edge.dep) ? ' on the critical chain' : ''));
    advisories.push(`ADVISORY_READS_ONLY_EDGE ${rendered.join('; ')}: the pair shares only a read-only fixture and Write scopes do not overlap; merge-task replays it after either side merges. Record in design.md whether the edge is still needed before CP-1.`);
  }
}
const route = maxWidth >= 2 && tasks.length >= 4 ? 'pipeline' : 'handoff';
const summaryBlocking = (items) => [...new Set(items)].map((item) => {
  const match = item.match(/^([A-Z][A-Z0-9_]*)\b(?:\s+[^:]*)?:\s*(.*)$/);
  const code = match?.[1] ?? item;
  return {
    code,
    reason: match?.[2] ?? item,
    fix: fixes.get(code) ?? RULE_FIXES[code] ?? 'correct the contract field named in the reason and re-run freeze-check',
  };
});
const explanations = summaryBlocking(blocking);
const summary = {
  change: path.resolve(changeDir),
  tasks: tasks.length,
  waves: waveList,
  maxWidth,
  criticalPath: waveList.length,
  criticalChain,
  speedup,
  weightedSpeedup: weighted,
  route,
  blocking: [...new Set(blocking)],
  advisories,
  explanations,
};
if (json) console.log(JSON.stringify(summary, null, 2));
else {
  console.log(`[freeze-check] ${summary.change}`);
  console.log(`tasks=${tasks.length} waves=${waveList.length} maxWidth=${maxWidth} criticalPath=${waveList.length}`);
  console.log(`[ROUTE] ${route}${route === 'pipeline' ? ': DAG has real concurrency' : ': no concurrency benefit; use Tier 2 handoff'}`);
  for (const wave of waveList) console.log(`WAVE ${wave.wave}: ${wave.ids.join(', ')}`);
  console.log(`CRITICAL ${criticalChain.map((step) => (step.via ? `-${step.via}-> ` : '') + step.id).join(' ')}`);
  for (const item of summary.advisories) console.log(`ADVISE ${item}`);
  for (const item of summary.blocking) console.error(`BLOCK ${item}`);
  if (explain) for (const item of summary.explanations) console.error(`EXPLAIN ${item.code}: ${item.reason}\n  fix: ${item.fix}`);
  console.log(summary.blocking.length ? `RESULT freeze rejected (${summary.blocking.length})` : 'RESULT freeze ok');
}
process.exit(summary.blocking.length ? 1 : 0);
