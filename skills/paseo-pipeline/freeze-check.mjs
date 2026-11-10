#!/usr/bin/env node
// Freeze gate: validate the DAG before humans confirm CP-1.
// Deliberately small: syntax, DAG, scenario mapping, wave conflicts, narrow Verify.

import fs from 'node:fs';
import path from 'node:path';
import { listAgents, inspectAgent, findAgents, nameOf } from './lib/paseo-agents.mjs';
import { parseTasks, graphErrors, computeWaves, normalizeScope, isFileWithinScopes, isTestPath, isTaskId, legPaths, verifyLegs, FULL_SUITE_LEG } from './lib/tasks.mjs';
import { dispatchDeps, weightedSpeedup, weightedCriticalPath, verifyScope, readsOnlyEdges, pathWithin, resolveModel, LIVE_MODEL } from './lib/schedule.mjs';
import { runGit } from './lib/git.mjs';
import { loadSpecTree, visibleLines, scanScenarios, scanRequirements, classifyScenCollisions } from './lib/spec-scan.mjs';
import { parseAcceptanceTable } from './lib/acceptance.mjs';

const args = process.argv.slice(2);
// One pass over argv. Any token that is `--stage` or starts with it is stage syntax: its value is
// consumed with it and a spelling like `--stage=specs`, `--stagefoo` or a repeat is rejected.
const flags = new Set(); const positional = []; const stageTokens = [];
for (let index = 0; index < args.length; index += 1) {
  if (args[index].startsWith('--stage')) { stageTokens.push(args[index], args[index + 1]); index += 1; }
  else if (args[index].startsWith('--')) flags.add(args[index]);
  else positional.push(args[index]);
}
const json = flags.has('--json');
const explain = flags.has('--explain');
// --structural: validate the contract the authors wrote, before hanlin reviews it. The R0
// sign-off is the output of that review, so requiring it here would deadlock the entry flow.
const structural = flags.has('--structural');
// Valid staged syntax is exactly `--stage specs` with `--structural`; anything else is a usage error.
const validStage = stageTokens.length === 2 && stageTokens[0] === '--stage' && stageTokens[1] === 'specs' && structural;
if (stageTokens.length && !validStage) {
  console.error('Usage: freeze-check.mjs <change-dir> --structural --stage specs [--json]');
  process.exit(2);
}
const stage = stageTokens.length ? 'specs' : null;
// --skip-signer-check: offline escape hatch; the R0 signer uuid is then format-checked only.
const skipSignerCheck = flags.has('--skip-signer-check');
// --strict: promote drift advisories (currently: frozen base behind the default branch) to blocks.
const strict = flags.has('--strict');
const changeDir = positional[0];
if (!changeDir) {
  console.error('Usage: freeze-check.mjs <change-dir> [--json] [--explain] [--structural] [--skip-signer-check] [--strict]');
  process.exit(2);
}

// Non-spec inputs only; spec files go through `loadSpecTree`, which reports an unreadable one.
function read(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
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
  USES_UNKNOWN: 'point Uses at an existing task id (never the task itself)',
  CYCLE: 'break the dependency cycle into a DAG',
  BAD_READS: 'use repo-relative paths without `..` or a leading slash',
  MISSING_READS_PATH: 'point Reads at an existing path or one covered by a task Write scope; separately verify readiness and content',
  BAD_ACCEPTANCE_HEADER: 'use the seven columns Scenario, Entry, Tasks, Verify, Required, Result, Evidence in that order',
  BAD_ACCEPTANCE_REQUIRED: 'set Required to yes or no (case-insensitive)',
  MALFORMED_ACCEPTANCE_ROW: 'escape a literal pipe inside a cell as `\\|`, or keep one cell free of `|`; the row must have the header column count',
  VERIFY_JUNK_LEG: 'put shell setup inside the leg it belongs to: `bash -c \'set -e; <command>\'`, or use `&&` between real commands',
  BAD_EST: 'use Est: S, M or L',
  BAD_INTERFACE: 'use Interface: <repo-path>[#<symbol>]',
  BAD_IMPLEMENTS: 'use Implements: D-<number>[, D-<number>] (decision ids from design.md)',
  BAD_KIND: 'use Kind: skeleton (or omit it)',
  BAD_ACCEPTANCE_TASKS: 'leave Tasks empty to derive the owners from tasks.md Scenarios, or list the task ids that carry this scenario',
  UNKNOWN_ACCEPTANCE_TASK: 'point Tasks at ids declared in tasks.md',
  UNOWNED_ACCEPTANCE_SCEN: 'list a task that claims this SCEN in tasks.md Scenarios',
  UNACCEPTED_SCEN: 'add an acceptance row for every declared SCEN',
  UNACCEPTED_TASK_SCEN: 'list the claiming task id in that scenario\'s acceptance row Tasks cell, or leave the cell empty to derive it',
  ENTRY_OWNER_UNCLAIMED: 'let the task that writes the Entry claim the SCEN, or make a row owner depend on that writer (e.g. a Kind: skeleton that pre-wires the entry)',
  COLLIDING_SCEN: 'choose a new SCEN id, or re-declare a baseline id under MODIFIED/REMOVED Requirements in this change',
  UNREADABLE_SPEC: 'make the file readable (repair or remove the dangling link/permissions); an unreadable spec cannot be checked',
  DESIGN_NAMES_TASK: 'name decisions and affected modules in design.md; let tasks.md declare Implements:',
  UNKNOWN_DECISION: 'add a decision heading (e.g. `- **D-01 <title>**` under `## Decisions`) in design.md',
  UNKNOWN_SCEN: 'claim a SCEN declared under specs/',
  DUPLICATE_SCEN: 'give each scenario declaration a unique SCEN id and update its task claims',
  NO_SPEC_SCEN: 'declare at least one `### Scenario: SCEN-<PREFIX>-NN` in specs/ before committing the frozen set',
  UNCLAIMED_SCEN: 'assign each declared SCEN to at least one task',
  NO_SCEN: 'claim at least one SCEN, or mark the task Review: mechanical',
  EMPTY_TASKS: 'write at least one parseable task line',
  TEST_FILE_UNOWNED: 'add the referenced file to the Write scope of the task that changes it, or narrow the test',
  FROZEN_BEHIND_MAIN: 'rebase the contract onto the default branch (or re-verify it at its tip) and re-run R0',
  R0_HUMAN_ACCEPT_UNRECORDED: 'record the human approval verbatim in run-log.md for the exact reviewed SHA, or get a hanlin pass',
};

const tasksMarkdown = read(path.join(changeDir, 'tasks.md'));
// The staged specs check runs exactly when tasks.md does not exist yet; any other mode still
// requires it.
if (tasksMarkdown === null && stage !== 'specs') {
  if (json) console.log(JSON.stringify({ error: 'tasks.md not found' }));
  else console.error('[freeze-check] tasks.md not found');
  process.exit(1);
}

const { tasks, errors } = parseTasks(tasksMarkdown ?? '');
const blocking = errors.map((error) => `${error.code}${error.task ? ` ${error.task}` : ''}: ${error.message}`);
const advisories = [];
const fixes = new Map();
if (blocking.length) fixes.set('CONTRACT', 'fix the field named in the message; see openspec-schema/templates/tasks.md for the exact shape');

// One snapshot of every spec this run reads (own, baseline, other active changes). `loadSpecTree` is
// the only spec I/O and never throws; the policy for its problems is here, at the caller.
const toplevel = gitIn(changeDir, ['rev-parse', '--show-toplevel']);
const repoRoot = toplevel.status === 0 ? toplevel.stdout.trim() : null;
const specTree = loadSpecTree({ repoRoot, changeDir });

// Scenario mapping.
const declared = new Map();
// Section (`## ...`), heading text and body each id is declared under in THIS change; the
// cross-change check below needs them to tell a legitimate MODIFIED/REMOVED re-declaration from a
// collision, and to recognise a verbatim re-declaration shared with another change.
const declaredSection = new Map();
const declaredTitle = new Map();
const declaredBody = new Map();
for (const { file, text } of specTree.current) {
  for (const found of scanScenarios(text)) {
    const source = path.relative(changeDir, file);
    if (declared.has(found.id)) blocking.push(`DUPLICATE_SCEN ${found.id}: declared in ${declared.get(found.id)} and ${source}`);
    else {
      declared.set(found.id, source);
      declaredSection.set(found.id, found.section);
      declaredTitle.set(found.id, found.title);
      declaredBody.set(found.id, found.body);
    }
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

// Cross-change SCEN collision. `declared` above only knows this change's own files, so a scenario id
// another unarchived change already declares goes unnoticed and the two contracts disagree at merge.
// Classification uses THIS change's declaration section plus the kind of external hit: a baseline id
// may be re-declared under MODIFIED/REMOVED Requirements, while another change's hit is a collision
// unless both the heading text and the scenario body are identical (a verbatim re-declaration is
// legal and mandatory for an unchanged MODIFIED scenario). Identity is byte equality of the compared
// title and body — conservative content identity, not Markdown rendering equivalence. Git history,
// archives and branches are out of scope: only the current checkout is read, and a missing repo
// silently skips the check.
//
// An unreadable spec file or directory is a blocking defect, not an empty declaration set. Base
// crashed with an uncaught TypeError on the same input, so this is deliberately the one place the
// byte-identical-to-base requirement is relaxed: same exit code (1), never a pass, a readable
// message, and the normal JSON object under --json. This runs before the `--stage specs` dispatch,
// so both modes inherit it.
for (const problem of specTree.problems) {
  blocking.push(`UNREADABLE_SPEC ${problem.path}: ${problem.reason}`);
  console.error(`[freeze-check] unreadable spec ${problem.path}: ${problem.reason}`);
}
{
  if (repoRoot) {
    const external = new Map();
    // Which external file declares each id, with its visible heading text and body. The section in
    // that file decides nothing: the external side cannot know whether this change is legitimately
    // re-declaring the id. Fenced examples and comments are not declarations (same helper as above).
    // An unreadable source is absent from the snapshot, so it is never scanned as if it were empty.
    const baselineFiles = new Set(specTree.baseline.map((source) => source.file));
    const sources = [...specTree.baseline, ...specTree.others];
    for (const { file, text } of sources) {
      for (const found of scanScenarios(text)) {
        if (!external.has(found.id)) external.set(found.id, []);
        external.get(found.id).push({
          file: path.relative(repoRoot, file),
          baseline: baselineFiles.has(file),
          title: found.title,
          body: found.body,
        });
      }
    }
    const result = classifyScenCollisions({ declared, declaredSection, declaredTitle, declaredBody, external });
    for (const message of result.blocking) blocking.push(message);
    for (const message of result.advisories) advisories.push(message);
    for (const message of result.blocking) fixes.set('COLLIDING_SCEN', 'choose a new SCEN id, or re-declare a baseline id under MODIFIED/REMOVED Requirements in this change');
  }
}

// With --stage specs, only the declaration rules run: duplicates, cross-change collisions and an
// empty scenario set. Full-run rules that need tasks.md, acceptance.md and design.md are skipped
// because those artifacts do not exist yet.
if (stage === 'specs') {
  const specBlocking = [];
  for (const message of blocking) {
    const code = message.match(/^([A-Z][A-Z0-9_]*)/)?.[1] ?? '';
    if (['DUPLICATE_SCEN', 'COLLIDING_SCEN', 'NO_SPEC_SCEN', 'UNREADABLE_SPEC'].includes(code)) specBlocking.push(message);
  }
  // A specs-only change that declares scenarios is fine; one that declares none is not. The name
  // says what is wrong without borrowing the task-level NO_SCEN rule.
  if (declared.size === 0) specBlocking.push('NO_SPEC_SCEN: specs/ declares no SCEN scenario; every capability delta needs at least one');
  const stageAdvisories = advisories.filter((message) => /^ADVISORY_SHARED_SCEN\b/.test(message));
  // Requirement overlap: another active change already adds, modifies or removes a requirement
  // this change modifies or removes. Structural misses it because each side is a valid delta alone;
  // the merge gives the capability two intentions for one requirement.
  if (repoRoot) {
    const current = { ADDED: new Set(), MODIFIED: new Set(), REMOVED: new Set(), RENAMED: new Set() };
    for (const { text } of specTree.current) {
      for (const found of scanRequirements(text)) current[found.section]?.add(found.name);
    }
    // Unreadable sources are already blocking (see the collision block above) and are absent from
    // the snapshot, so this pass never treats them as requirements-free files.
    const external = new Map();
    for (const { change, text } of specTree.others) {
      for (const found of scanRequirements(text)) {
        if (!['ADDED', 'MODIFIED', 'REMOVED', 'RENAMED'].includes(found.section)) continue;
        if (!external.has(found.name)) external.set(found.name, new Map());
        if (!external.get(found.name).has(change)) external.get(found.name).set(change, new Set());
        external.get(found.name).get(change).add(found.section);
      }
    }
    const touched = [...new Set([...current.MODIFIED, ...current.REMOVED])].sort();
    for (const name of touched) {
      const mine = current.MODIFIED.has(name) ? 'MODIFIED' : 'REMOVED';
      for (const [other, sections] of [...(external.get(name) ?? new Map()).entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        const theirs = ['ADDED', 'MODIFIED', 'REMOVED', 'RENAMED'].filter((section) => sections.has(section));
        if (!theirs.length) continue;
        stageAdvisories.push(`ADVISORY_REQ_OVERLAP ${name}: this change ${mine} it, and ${other} also ${theirs.join('/')} it`);
      }
    }
  }
  const summary = { change: path.resolve(changeDir), stage: 'specs', blocking: [...new Set(specBlocking)], advisories: [...new Set(stageAdvisories)] };
  if (json) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log(`[freeze-check] ${summary.change} (stage specs)`);
    for (const item of summary.advisories) console.log(`ADVISE ${item}`);
    for (const item of summary.blocking) console.error(`BLOCK ${item}`);
    console.log(summary.blocking.length ? `RESULT specs rejected (${summary.blocking.length})` : 'RESULT specs ok');
  }
  process.exit(summary.blocking.length ? 1 : 0);
}

// Dispatch-dependency wave width is a planning heuristic, not exact maximum concurrency.
// Runtime dispatch follows the ready frontier, without wave barriers.
const graphValid = tasks.length > 0 && graphErrors(errors).length === 0;
const waves = graphValid ? computeWaves(tasks) : new Map();
// A sink is a task nothing consumes. `Uses` is a merge edge too (the consumer merges
// after the producer), so a producer read only through Uses is still not a sink; counting
// `depends` alone falsely marked such producers as sinks and rejected their deferred review.
const sinkIds = new Set(tasks
  .filter((task) => !tasks.some((other) => (other.depends || []).includes(task.id) || (other.uses || []).includes(task.id)))
  .map((task) => task.id));
const waveList = [...waves.entries()].sort((a, b) => a[0] - b[0]).map(([wave, ids]) => ({ wave, ids }));
const maxWidth = graphValid ? waveList.reduce((max, item) => Math.max(max, item.ids.length), 0) : null;

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
// Walking the whole edge set matters: a task that depends on a skeleton consumer still cannot
// start before the skeleton merged, so only a task with no path at all is a real writer race.
const reaches = (from, target) => {
  const stack = [...(byId.get(from)?.depends || []), ...(byId.get(from)?.uses || [])];
  const seen = new Set();
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    if (id === target) return true;
    const node = byId.get(id);
    if (node) stack.push(...(node.depends || []), ...(node.uses || []));
  }
  return false;
};
const skeletonCovers = (skeleton, other) => skeleton.kind === 'skeleton' && other.id !== skeleton.id
  && reaches(other.id, skeleton.id);
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
const dispatchAncestors = (task) => {
  const seen = new Set();
  const stack = dispatchDeps(task, tasks);
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    const node = byId.get(id);
    if (node) stack.push(...dispatchDeps(node, tasks));
  }
  return seen;
};
for (const task of tasks) {
  for (const used of task.uses || []) {
    if (used === task.id || !byId.has(used)) {
      continue;
    }
    const target = byId.get(used);
    if (!target.interface.length) {
      blocking.push(`USES_WITHOUT_INTERFACE ${task.id}: Uses ${used} but ${used} declares no Interface; freeze the symbol on the producer`);
      fixes.set('USES_WITHOUT_INTERFACE', `add Interface: <path>#<symbol> to ${used}, or use Depends on if the implementation is required`);
    }
    const ready = dispatchAncestors(task);
    for (const entry of target.interface) {
      const owners = skeletons.filter((skeleton) => isFileWithinScopes(entry.split('#')[0], skeleton.scope));
      if (owners.length && !owners.some((owner) => ready.has(owner.id))) {
        blocking.push(`INTERFACE_NOT_READY ${task.id}: Uses ${used} but Interface ${entry} has no skeleton owner in its dispatch dependencies`);
        fixes.set('INTERFACE_NOT_READY', 'connect the actual skeleton owner to dispatch readiness, or use Depends on when implementation is required');
      }
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
      blocking.push(`DEFERRED_NOT_STANDARD ${task.id}: the sink cannot use Review: deferred under the compatibility rule`);
      fixes.set('DEFERRED_NOT_STANDARD', 'use Review: standard or strict on the sink; only non-sink standard tasks may defer');
    }
    if (task.riskSurface.some((risk) => risk === 'persistence' || risk === 'security')) {
      blocking.push(`DEFERRED_NOT_STANDARD ${task.id}: Risk-surface ${task.riskSurface.join(', ')} cannot use Review: deferred; mark this risk Review: strict for FINAL attention`);
      fixes.set('DEFERRED_NOT_STANDARD', 'set Review: strict for persistence/security surfaces; deferred is only for standard tasks');
    }
  }
}

// A scope permits a forward reference but does not establish file existence or readiness.
// Authors and R0 must check that each worker can complete its Verify in its own branch.
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

// A test the contract writes may assert on files the contract does not own: a fixture, a script,
// a config. If the assertion names a file outside every task Write scope, no task is allowed to
// change it and the merge scope gate deadlocks later. Catch that at freeze.
// Only existing code/shell files are claims: a greenfield module, a missing relative import, a
// manifest or a doc cannot be resolved into an owner, so it is skipped rather than guessed.
const CLAIMABLE_FILE = /\.(?:[cm]?[jt]sx?|py|go|rs|rb|java|kt|swift|php|sh|bash)$/i;
{
  const toplevel = gitIn(changeDir, ['rev-parse', '--show-toplevel']);
  if (toplevel.status === 0) {
    const repoRoot = toplevel.stdout.trim();
    const seen = new Set();
    for (const task of tasks) {
      for (const scope of task.scope) {
        const testFile = path.join(repoRoot, scope);
        if (seen.has(testFile) || !isTestPath(scope) || !fs.existsSync(testFile) || !fs.statSync(testFile).isFile()) continue;
        seen.add(testFile);
        const body = read(testFile) ?? '';
        for (const match of body.matchAll(/(['"`])((?:\.{0,2}\/)?[A-Za-z0-9_.@/-]+\.[A-Za-z0-9]+)\1/g)) {
          const raw = match[2];
          if (/^[a-z]+:\/\//i.test(raw)) continue;
          // An import/export specifier is a dependency, not an assertion target: a shared setup
          // module or a helper loaded for side effects is not "changed by this contract". Only
          // explicit reads (readFileSync, loops, fixtures) claim ownership of another file.
          // Judge only what directly precedes the specifier (it may sit on the line after `from`):
          // `import fs from 'node:fs'; fs.readFileSync('x')` has `import` earlier on the line, but the
          // text right before 'x' is a call, so that is still an explicit read.
          // Conservative: only whitespace may precede the specifier. A comment, or a string holding
          // `import //`, is unresolved and gets reported; a false positive costs one Write-scope line,
          // a missed one bypasses the gate.
          const prefix = body.slice(Math.max(0, match.index - 200), match.index).trimEnd();
          if (/(?:^|[^\w$.])(?:from|import)$|\brequire\s*\($|\bimport\s*\($/.test(prefix)) continue;
          const resolved = raw.startsWith('.')
            ? path.relative(repoRoot, path.resolve(path.dirname(testFile), raw))
            : raw.replace(/^\.\//, '');
          if (!CLAIMABLE_FILE.test(resolved) || resolved.startsWith('..') || resolved.split('/').includes('node_modules')) continue;
          if (!fs.existsSync(path.join(repoRoot, resolved))) continue;
          if (tasks.some((other) => isFileWithinScopes(resolved, other.scope))) continue;
          blocking.push(`TEST_FILE_UNOWNED ${task.id}: ${scope} asserts on ${resolved}, which is outside every task Write scope; add it to the owning task's Write scope or remove the assertion`);
          fixes.set('TEST_FILE_UNOWNED', `add ${resolved} to the Write scope of the task that changes it, or narrow the test so it does not reference it`);
        }
      }
    }
  }
}

// Narrow verification. A leg is narrow when its paths all sit inside the task
// Write scope (or its reads-only anchors); a leg without paths must not invoke a
// whole-suite runner. A sink may run one full-suite leg per package/runner it
// regresses (a monorepo sink runs each package suite explicitly); final acceptance
// always runs on integration HEAD.
const SHELL_CONSTRUCT = /\b(?:for|while|if|case|until)\b/;
// `set -e; cmd` and `a || exit 1` are shell setup, not verify legs. commandParts
// splits them into legs that prove nothing; name the real cause instead of the
// downstream VERIFY_NOT_NARROW.
const CONTROL_LEG = /^(?:set(?:\s|$)|exit(?:\s|$)|true$|false$|do(?:\s|$)|done$|fi$|else$|then$|esac$)/;
// Fixture data is never a test, whatever its file is called: a `foo.test.mjs` under fixtures/ is
// input for another test, so naming it must not satisfy Verify.
const FIXTURE_DIR = /(?:^|\/)(?:fixtures?|testdata|__snapshots__)(?:\/|$)/i;
const verifyTestPath = (p) => isTestPath(p) && !FIXTURE_DIR.test(p);
const testScript = (command) => /^(?:(?:bash|sh)\s+)?(?:\.\/)?(?:[\w.-]+\/)*test(?:[._-][\w.-]+)?\.(?:sh|bash)(?:\s|$)/i.test(command)
  && !FIXTURE_DIR.test(command.replace(/^(?:bash|sh)\s+/, '').split(/\s/)[0]);
for (const task of tasks) {
  const legs = verifyLegs(task.verify);
  const broadLegs = legs.filter((leg) => leg.broad).length;
  // A leg must also prove something: a known test runner, or a test/spec path. `true`,
  // `echo ok` and `node src/a.mjs` pass a path-only check but verify nothing.
  // A runner pointed only at fixture paths runs no real test either.
  // Option arguments (`--config test/fixtures/jest.config.js`) configure the run; they are not what it
  // runs. `--test` and `--` are boolean, so the path after them is a real target.
  // Known limitation: a flag value is skipped wholesale, so `node --test --test-only test/fixtures/foo.test.mjs`
  // sees no target (targets=[]) and the fixture is treated as a real verification target. Not fixed here.
  const fixtureOnly = (leg) => {
    const tokens = leg.command.split(/\s+/);
    const targets = tokens.flatMap((token, i) => {
      const prev = tokens[i - 1] ?? '';
      if (/^-/.test(prev) && !/=/.test(prev) && prev !== '--' && prev !== '--test') return [];
      return legPaths(token);
    });
    return targets.length > 0 && targets.every((p) => FIXTURE_DIR.test(p));
  };
  const proves = (leg) => (FULL_SUITE_LEG.test(leg.command) && !fixtureOnly(leg)) || testScript(leg.command) || leg.paths.some(verifyTestPath);
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
  // A sink may mix full-suite legs (one per package) with narrow checks; broad-free sinks
  // still fall under VERIFY_NOT_NARROW above like any other task.
}
// Vertical slices: behavior tasks must claim a SCEN and own production code, not only tests.
for (const task of tasks) {
  // A test-only sink is not proof of a missing assembly owner: the DAG sink is defined by graph
  // edges, not by who wires the pieces together. Upstream behavior slices may already own the real
  // production entry, and a final integration verification task may legitimately write tests only.
  // A block here would force a fabricated production path, so this is an advisory for R0 to judge.
  if (sinkIds.has(task.id) && task.scope.length && task.scope.every((scope) => isTestPath(scope))) {
    advisories.push(`ADVISORY_SINK_TEST_ONLY ${task.id}: sink Write scope has only test paths; check that an upstream scenario task owns the assembly/wiring entry and that this sink's integration verification is legitimate test-only work`);
  }
  if (task.review === 'mechanical') continue;
  if (!task.scenarios.length) blocking.push(`NO_SCEN ${task.id}: non-mechanical task must claim at least one SCEN (or be Review: mechanical)`);
  if (!sinkIds.has(task.id) && task.scope.length && task.scope.every((scope) => isTestPath(scope))) {
    blocking.push(`FIXTURE_ONLY_TASK ${task.id}: scope has only test paths; fold fixtures into the behavior task that breaks them`);
  }
}

// Baseline reconciliation lives beside each rule (path:line in the spec or decision it
// justifies) since the minimal-contract convergence; there is no digest or alignment
// table to check here. Whether a rule actually matches the baseline is semantic: the
// author brief makes the author the first reader of colliding rules, and R0 checks it.


const fullSuiteSinks = tasks.filter((task) => verifyLegs(task.verify).some((leg) => leg.broad));
if (fullSuiteSinks.length > 1) blocking.push(`TOO_MANY_FULL_SUITE_SINKS: ${fullSuiteSinks.map((task) => task.id).join(', ')}`);

// Entry cells mix prose with a real entry point, so a check has to pull the file-shaped tokens
// out. Route, CLI and prose entries have no extension and are left to R0. Extensions run from
// one char (`main.c`) to long compound forms (`application.properties`); the extension must
// contain a letter so version-like numbers (`1.5`) are not read as files.
const entryFileTokens = (cell) => cell.split(/[\s,;()]+/).map((word) => word.replace(/^[`'"]+|[`'"]+$/g, '').replace(/#.*$/, '').replace(/[.:]+$/, ''))
  .filter((word) => /^[^`'"]*\.[A-Za-z0-9]{1,12}$/.test(word) && /[A-Za-z]/.test(word.split('.').pop()) && !word.includes('*'));
// Write scopes are directories or files; a short entry like `ExpenseBillForm.tsx` names the file
// without its directory, so match it as a path suffix too. No repo lookup: the tasks.md scope is
// the only authority here, which keeps the check independent of the worktree.
const entryWriters = (token) => {
  const normalized = normalizeScope(token);
  if (!normalized) return [];
  return tasks.filter((task) => isFileWithinScopes(normalized, task.scope)
    || task.scope.some((scope) => scope === normalized || scope.endsWith(`/${normalized}`))).map((task) => task.id);
};
const acceptanceMarkdown = read(path.join(changeDir, 'acceptance.md'));
if (!acceptanceMarkdown) blocking.push('MISSING_ACCEPTANCE: acceptance.md not found');
else {
  const acceptanceScenarios = new Set();
  const requiredRows = [];
  // Tasks cells actually read, so tasks.md and acceptance.md must agree in both directions.
  const rowsByScen = new Map();
  const claimsByScen = new Map(tasks.flatMap((task) => task.scenarios.map((scen) => [scen.toUpperCase(), task.id]))
    .reduce((acc, [scen, id]) => { if (!acc.has(scen)) acc.set(scen, new Set()); acc.get(scen).add(id); return acc; }, new Map()));
  // Column parsing lives in lib/acceptance.mjs so the read-only `scenarios` helper reads exactly
  // the same rows this gate judges; the rules and messages below stay here, unchanged.
  const parsedTable = parseAcceptanceTable(acceptanceMarkdown);
  if (!parsedTable.headerOk) {
    blocking.push('BAD_ACCEPTANCE_HEADER: acceptance.md needs exactly Scenario, Entry, Tasks, Verify, Required, Result, Evidence in that order');
  }
  // One pass in file order: base reported a malformed row where it stood, not after every valid
  // row's diagnostics, and it echoed the id as written. Grouping or uppercasing here would change
  // the output of an invalid package without changing any verdict.
  for (const entry of parsedTable.entries) {
    if (entry.malformed) {
      const malformed = entry.malformed;
      blocking.push(`MALFORMED_ACCEPTANCE_ROW acceptance.md:${malformed.line}: ${malformed.cells} cells, header has ${malformed.expectedColumns}; a literal \`|\` must be written \`\\|\``);
      continue;
    }
    const row = entry.row;
    const rowNumber = row.line;
    const scen = row.scen;
    const scenLabel = row.scenRaw;
    acceptanceScenarios.add(scen);
    if (!/^(yes|no)$/i.test(row.required)) {
      blocking.push(`BAD_ACCEPTANCE_REQUIRED acceptance.md:${rowNumber}: ${scenLabel} Required must be yes or no`);
      continue;
    }
    // Column 3 is the Tasks cell; the old parser never read it, so the two files could
    // assign the same SCEN to different tasks (or acceptance could omit a scenario entirely).
    const rawTasks = row.tasksRaw;
    const listed = rawTasks.split(',').map((item) => item.trim()).filter(Boolean);
    const ids = listed.filter((item) => isTaskId(item));
    const required = /^yes$/i.test(row.required);
    // An empty cell means "derive the owners from tasks.md": the task list is then a
    // hand-maintained duplicate of the Scenarios column and drifts (D4: 10 of 34 blocks).
    // A non-task token is still an error on every row; it is not an intentional omission, and
    // deriving owners from it would silently paper over a placeholder like `TBD`.
    const bad = listed.filter((item) => !isTaskId(item));
    if (rawTasks && !listed.length) {
      blocking.push(`BAD_ACCEPTANCE_TASKS acceptance.md:${rowNumber} ${scenLabel}: Tasks cell ${rawTasks} names no task id`);
    }
    if (bad.length) {
      blocking.push(`BAD_ACCEPTANCE_TASKS acceptance.md:${rowNumber} ${scenLabel}: Tasks token ${bad.join(', ')} is not a task id`);
    }
    for (const id of ids) {
      if (!byId.has(id)) blocking.push(`UNKNOWN_ACCEPTANCE_TASK ${scenLabel}: ${id} is not a task in tasks.md`);
    }
    // Derived owners are the claimers, and only a truly empty cell derives; a non-empty cell that
    // yields no id (`,`, `TBD`) is already reported above and keeps its (empty) explicit meaning.
    const owners = rawTasks ? ids : [...(claimsByScen.get(scen) ?? [])];
    if (!rowsByScen.has(scen)) rowsByScen.set(scen, []);
    rowsByScen.get(scen).push({ ids, owners, entry: row.entry, line: rowNumber });
    if (required) requiredRows.push({ scen: scenLabel, verify: row.verify, result: row.result });
  }
  for (const scenario of acceptanceScenarios) {
    if (!declared.has(scenario)) blocking.push(`UNKNOWN_ACCEPTANCE_SCEN: ${scenario} is not declared`);
  }
  // Symmetric with UNCLAIMED_SCEN: every declared scenario needs a row, not only the
  // ones acceptance happens to mention.
  for (const [scen, file] of declared) {
    if (!acceptanceScenarios.has(scen)) blocking.push(`UNACCEPTED_SCEN ${scen} (${file}): every declared SCEN needs an acceptance row`);
  }
  // Ownership is checked per row, not on the union across rows: a Required=no row naming the real
  // owner must not excuse a Required=yes row that assigns the scenario to a task which does not
  // claim it. Applied to every row that lists ids — a Tasks cell means "these tasks carry this
  // scenario" whatever the Required value, and Required=no rows name owners too.
  for (const [scen, rows] of rowsByScen) {
    const union = new Set(rows.flatMap((row) => row.owners));
    const claims = claimsByScen.get(scen);
    for (const row of rows) {
      // Every id in the cell is a claim about that id, so one real owner cannot carry a fabricated
      // one. Naming the id also covers the "none of them claim it" case: it reports each offender.
      for (const id of row.ids) {
        if (!(claims && claims.has(id))) blocking.push(`UNOWNED_ACCEPTANCE_SCEN ${scen}: ${id} does not claim it in tasks.md Scenarios`);
      }
    }
    // ... and every task claiming a SCEN must appear in that SCEN's Tasks cell, so a
    // second owner cannot be silently dropped from acceptance.
    for (const id of claims ?? []) {
      if (!union.has(id)) blocking.push(`UNACCEPTED_TASK_SCEN ${id}: ${scen} is claimed but no acceptance row lists ${id}`);
    }
    // A row can name the right owner and still observe the wrong entry: a component task whose
    // acceptance Entry is assembled by an unrelated downstream task passes the checks above
    // (D4: a component claimed the form scenario whose Entry was ExpenseBillForm.tsx). Only
    // file-path tokens are judged; route/CLI entries and unchanged baseline files stay with R0.
    for (const row of rows) {
      for (const token of entryFileTokens(row.entry)) {
        const writers = entryWriters(token);
        if (!writers.length) continue;
        const covered = row.owners.some((owner) => writers.includes(owner) || writers.some((writer) => reaches(owner, writer)));
        if (!covered) blocking.push(`ENTRY_OWNER_UNCLAIMED ${scen} acceptance.md:${row.line}: Entry ${token} is written by ${writers.join(', ')} but no row owner writes it or depends on its writer`);
      }
    }
  }
  if (!requiredRows.length) blocking.push('MISSING_REQUIRED_ACCEPTANCE: acceptance.md has no Required=yes row');
  for (const row of requiredRows) {
    if (row.result !== 'PENDING') blocking.push(`ACCEPTANCE_NOT_FROZEN ${row.scen}: Result must start PENDING`);
    if (/^`?\s*(?:!|manual|手工|自然语言)/i.test(row.verify)) blocking.push(`BAD_ACCEPTANCE_VERIFY ${row.scen}: Required=yes needs one executable command`);
  }
}

// design.md names decisions, tasks name task ids. design is written before tasks, so it cannot
// cite task ids without becoming circular: a decision is `- **D-01 <title>**` under `## Decisions`,
// and tasks.md points back at it with `Implements:`. Only ids declared in tasks.md are matched, so
// unrelated prose numbers are not mistaken for tasks.
{
  const designMarkdown = read(path.join(changeDir, 'design.md'));
  // With no design.md there are no decision headings, so every Implements id is unresolved. This
  // runs outside the `if` so the ids are not silently accepted just because design.md is missing.
  if (!designMarkdown) {
    for (const task of tasks) {
      for (const decision of task.implements) blocking.push(`UNKNOWN_DECISION ${task.id}: Implements ${decision} is not a decision heading in design.md`);
    }
  } else {
    // Only visible prose counts: the scaffold's HTML comment explains the rule with an example task
    // id, and a fenced example is not a claim about this package.
    const designVisible = visibleLines(designMarkdown).map((entry) => entry.text).join('\n');
    const decisions = new Set([...designVisible.matchAll(/^\s*[-*]\s*\*\*(D-\d+)\b/gm)].map((match) => match[1]));
    for (const task of tasks) {
      const pattern = new RegExp(`(^|[^A-Za-z0-9_-])${task.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_-])`);
      if (pattern.test(designVisible)) {
        blocking.push(`DESIGN_NAMES_TASK ${task.id}: design.md must not name task ids; name decisions and let tasks.md declare Implements:`);
      }
      for (const decision of task.implements) {
        if (!decisions.has(decision)) blocking.push(`UNKNOWN_DECISION ${task.id}: Implements ${decision} is not a decision heading in design.md`);
      }
    }
  }
}

if (!read(path.join(changeDir, 'proposal.md'))) blocking.push('MISSING_PROPOSAL: proposal.md not found');

// R0 sign-off: the contract package must be reviewed before CP-1. Two recorded forms exist, and
// they are not interchangeable. `R0: pass(<reviewer-uuid>@<sha>)` is an independent hanlin
// verdict. `R0: human-accept(@<sha>)` records that the human knowingly accepted the residual risk
// after R0 stopped with blockers; it requires the approval in run-log.md and never counts as a
// reviewer pass. hanlin is read-only and returns its line as text; the main session records it in
// review.md. The LAST sign-off line of either kind wins, so a post-CP-1 contract delta is re-signed
// by appending a line instead of deadlocking, and a later reviewer pass supersedes an earlier
// human exception. The sha is the commit that was signed, so any contract edit after it voids it.
// --structural skips this: it runs before the review exists.
function gitIn(dir, gitArgs) {
  return runGit(dir, gitArgs);
}
const nulList = (result) => (result.stdout || '').split('\0').filter(Boolean);
if (!structural) {
  const reviewMarkdown = read(path.join(changeDir, 'review.md'));
  const signoffs = reviewMarkdown ? [
    ...[...reviewMarkdown.matchAll(/^R0:\s*pass\(([^@)]+)@([a-f0-9]{7,40})\)/gim)]
      .map((match) => ({ kind: 'pass', signer: match[1].trim(), sha: match[2], index: match.index })),
    ...[...reviewMarkdown.matchAll(/^R0:\s*human-accept\(@([a-f0-9]{7,40})\)/gim)]
      .map((match) => ({ kind: 'human-accept', sha: match[1], index: match.index })),
  ].sort((a, b) => a.index - b.index) : [];
  const r0Match = signoffs.at(-1);
  if (!r0Match) {
    blocking.push('MISSING_R0_SIGNOFF: review.md must contain `R0: pass(<reviewer-uuid>@<sha>)` — run hanlin R0 review before freeze — or `R0: human-accept(@<sha>)` when the human accepted the residual risk');
  } else if (r0Match.kind === 'human-accept') {
    // A human exception is legitimate only when the human's words are on record; it is never
    // rewritten as a pass, so the two approval kinds stay distinguishable after the fact.
    const runLog = read(path.join(changeDir, 'run-log.md'));
    const approval = new RegExp(`^Approval: R0 residual risk accepted for ${r0Match.sha}\\s*[-—:]\\s*\\S`, 'm');
    if (!runLog || !approval.test(runLog)) {
      blocking.push(`R0_HUMAN_ACCEPT_UNRECORDED: review.md records \`R0: human-accept(@${r0Match.sha})\` but run-log.md has no matching \`Approval: R0 residual risk accepted for ${r0Match.sha} — <reason>\` line; record the human approval verbatim before freezing`);
    } else {
      advisories.push(`R0_HUMAN_EXCEPTION: freeze relies on a human risk acceptance at ${r0Match.sha}, not an independent hanlin pass; the open items and reasons must be recorded in rulings.md`);
      const rulings = read(path.join(changeDir, 'rulings.md'));
      if (!rulings || !/^R0-\d+-/m.test(rulings)) advisories.push('R0_HUMAN_EXCEPTION_UNRULED: rulings.md has no `R0-<round>-<n>` entries; record each open item and why it was accepted');
    }
  } else {
    // The signer must be a real Paseo agent, so a made-up uuid cannot satisfy the gate. Role is not
    // exposed by `paseo ls`; a name without `hanlin` is only an advisory — the merge gate no longer
    // inspects reviewer identity, so this is the only heterogeneous-R0 check.
    if (!skipSignerCheck) {
      const signer = r0Match.signer;
      const { agents, error } = listAgents();
      // Unreachable Paseo is advisory, not a block: it says nothing about the signer, and
      // the sign-off sha check below still proves the package did not change afterwards.
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
    const sha = r0Match.sha;
    if (gitIn(changeDir, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]).status !== 0) {
      blocking.push(`STALE_R0_SIGNOFF: reviewed commit ${sha} does not exist in this repository`);
    } else {
      // Working tree (staged, unstaged, untracked) vs the reviewed commit; review.md is written after the review.
      const diff = gitIn(changeDir, ['diff', '--no-renames', '--name-only', '-z', sha, '--', '.']);
      const untracked = gitIn(changeDir, ['ls-files', '--others', '--exclude-standard', '--full-name', '-z', '--', '.']);
      // review.md is written after the review; rulings.md records accepted non-obvious
      // decisions made during it; run-log.md records approvals and merge timings. None of
      // them changes the contract, so none is drift.
      const repositoryRoot = fs.realpathSync(gitIn(changeDir, ['rev-parse', '--show-toplevel']).stdout.trim());
      const changeRoot = path.relative(repositoryRoot, fs.realpathSync(changeDir));
      const exemptRecords = new Set(['review.md', 'rulings.md', 'run-log.md'].map((file) => path.join(changeRoot, file)));
      const drift = [...new Set([...nulList(diff), ...nulList(untracked)])]
        .filter((file) => !exemptRecords.has(file));
      if (diff.status !== 0) blocking.push(`STALE_R0_SIGNOFF: cannot diff contract against reviewed commit ${sha}`);
      else if (drift.length) blocking.push(`STALE_R0_SIGNOFF: contract changed after R0 reviewed ${sha}: ${drift.slice(0, 5).join(', ')} — re-run hanlin R0`);
      // A frozen base can be valid and still predate main: the contract was written on an older
      // tree, so a task's Reads/Interfaces may cite files main has since moved. That is a rebase
      // decision for the author, not a contract defect, so it only blocks under --strict.
      const base = ['main', 'master'].find((name) => gitIn(changeDir, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]).status === 0);
      if (base && gitIn(changeDir, ['merge-base', '--is-ancestor', sha, base]).status === 0) {
        const behind = gitIn(changeDir, ['rev-list', '--count', `${sha}..${base}`]);
        const count = Number.parseInt(behind.stdout.trim(), 10);
        if (behind.status === 0 && count > 0) {
          const message = `${base} has ${count} commit(s) since the frozen base ${sha} (git rev-list --count ${sha}..${base}); rebase the contract or re-verify it against ${base} before dispatch`;
          if (strict) blocking.push(`FROZEN_BEHIND_MAIN: ${message}`);
          else advisories.push(`ADVISORY_FROZEN_BEHIND: ${message}`);
        }
      }
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
// cost model in lib/schedule.mjs (hand-set defaults, overridable per call; not measured from
// this repository). `speedup` retains the wave ratio for existing consumers; the weighted
// estimate is advisory and does not determine the route.
const speedup = graphValid ? Number((tasks.length / waveList.length).toFixed(2)) : null;
const weighted = graphValid ? weightedSpeedup(tasks, LIVE_MODEL) : null;
// Critical chain: the longest path by the same weighted cost model the scheduler uses
// (lib/schedule.mjs); historical benchmarks use a separate model. The wave-based chain counted edges,
// not weights, so it could point removable-edge advice at a different path. Neither path
// is a measured makespan or accounts for coordination and merge gates.
// Each edge is tagged by why it exists: `scope` (shared files, forced), `uses` (an
// interface target), `reads` (only a shared read-only fixture connects the pair), or
// `logical` (author choice; the only removable kind).
const criticalChain = [];
if (graphValid) {
  const weightedChain = weightedCriticalPath(tasks, LIVE_MODEL).chain;
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
const policy = resolveModel();
if (graphValid && tasks.length >= 4 && maxWidth >= 2 && weighted < policy.minSpeedup) {
  advisories.push(`ADVISORY_LOW_SPEEDUP: modeled ${weighted}x below advisory reference ${policy.minSpeedup}x (wave ratio ${speedup}x); compare with Tier 2 handoff before CP-1`);
}
// A dependency whose only shared surface is a read-only fixture is a candidate for removal:
// `merge-task` replays every Done task whose Verify scope overlaps the changed files, so the
// fixture is re-run against the merged tree whether or not the author serialised the pair.
// Advisory only — dropping the edge is a contract decision the author records in design.md.
if (graphValid) {
  const chainIds = new Set(criticalChain.map((step) => step.id));
  const edges = readsOnlyEdges(tasks);
  if (edges.length) {
    const rendered = edges.map((edge) => `${edge.task} -> ${edge.dep} (${edge.shared.join(', ')})`
      + (chainIds.has(edge.task) && chainIds.has(edge.dep) ? ' on the critical chain' : ''));
    advisories.push(`ADVISORY_READS_ONLY_EDGE ${rendered.join('; ')}: the pair shares only a read-only fixture and Write scopes do not overlap; merge-task replays it after either side merges. Record in design.md whether the edge is still needed before CP-1.`);
  }
}
const route = graphValid ? (maxWidth >= 2 && tasks.length >= 4 ? 'pipeline' : 'handoff') : null;
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
  maxWidthMeaning: 'largest dispatch-dependency wave; heuristic, not exact maximum concurrency',
  criticalPath: graphValid ? waveList.length : null,
  criticalChain,
  speedup,
  weightedSpeedup: weighted,
  weightedSpeedupMeaning: 'unmeasured worker implementation weights; excludes coordination and FINAL review',
  route,
  blocking: [...new Set(blocking)],
  advisories,
  explanations,
};
if (json) console.log(JSON.stringify(summary, null, 2));
else {
  console.log(`[freeze-check] ${summary.change}`);
  if (graphValid) {
    console.log(`tasks=${tasks.length} waves=${waveList.length} maxWidth=${maxWidth} criticalPath=${waveList.length}`);
    console.log('maxWidth is a wave-width heuristic, not exact maximum concurrency; weighted estimates are unmeasured.');
    console.log(`[ROUTE] ${route}${route === 'pipeline' ? ': wave-width gate met' : ': wave-width/task-count gate not met; use Tier 2 handoff'}`);
    for (const wave of waveList) console.log(`WAVE ${wave.wave}: ${wave.ids.join(', ')}`);
    console.log(`CRITICAL ${criticalChain.map((step) => (step.via ? `-${step.via}-> ` : '') + step.id).join(' ')}`);
  } else console.log(`[ROUTE] invalid: task graph invalid; fix graph errors before routing`);
  for (const item of summary.advisories) console.log(`ADVISE ${item}`);
  for (const item of summary.blocking) console.error(`BLOCK ${item}`);
  if (explain) for (const item of summary.explanations) console.error(`EXPLAIN ${item.code}: ${item.reason}\n  fix: ${item.fix}`);
  console.log(summary.blocking.length ? `RESULT freeze rejected (${summary.blocking.length})` : 'RESULT freeze ok');
}
process.exit(summary.blocking.length ? 1 : 0);
