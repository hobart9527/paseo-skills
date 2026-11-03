#!/usr/bin/env node
// Safe merge gate. The only writer of integration history.
// Scope, trailers, review binding, dependencies, frozen Verify, then --no-ff.

import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseTasks, parseTaskLine, parseReviewTag, isFileWithinScopes, graphErrors, isTestPath, verifyLegs } from './lib/tasks.mjs';
import { mergeDeps } from './lib/schedule.mjs';
import { missingDependency, dependencyMessage } from './lib/toolchain.mjs';
import { listAgents, inspectAgent, modelOf, findAgents, nameOf } from './lib/paseo-agents.mjs';

const WRITER_ROLES = new Set(['gongbu', 'gaogong', 'ceshi', 'jiangzuo']);
const TEST_ROLES = new Set(['ceshi']);
const IMPLEMENTATION_ROLES = new Set(['gongbu', 'gaogong', 'jiangzuo']);
const usage = 'Usage: merge-task.mjs <branch> <task-id> <pass(reviewer@tip/base)> [--timeout ms]';
function fail(message, code = 1) {
  console.error(`[merge-task] Error: ${message}`);
  process.exit(code);
}

function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.error) fail(`git ${args[0]} failed: ${result.error.message}`);
  if (result.status !== 0) fail(`git ${args.join(' ')} failed\n${result.stdout}${result.stderr}`);
  return result.stdout.trim();
}

function gitMaybe(args) {
  return spawnSync('git', args, { encoding: 'utf8' });
}

function paseoAgents() {
  const { agents, error } = listAgents();
  if (error) fail(error, 32);
  return agents;
}

function modelFor(agentId, agents) {
  const matches = findAgents(agentId, agents);
  if (matches.length === 1) return modelOf(matches[0]);
  // Unique shortId prefix in the live list; otherwise ask Paseo directly, because
  // `ls` hides some archived agents.
  if (matches.length === 0) return modelOf(inspectAgent(agentId));
  return null;
}

function filesInCommit(commit) {
  const result = gitMaybe(['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', commit]);
  if (result.status !== 0) fail(`cannot inspect files in commit ${commit.slice(0, 7)}`, 31);
  return result.stdout.split('\0').filter(Boolean);
}

function trailers(commit, key) {
  return git(['show', '-s', `--format=%(trailers:key=${key},valueonly)`, commit]).split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
}

// Provenance across cherry-picks. A picked commit keeps its original author trailers only if the
// hook preserved them (conflict-continue) or git did (clean pick); a hand-recreated commit has the
// same patch but a fresh author. (cherry picked from commit <sha>) is the authoritative marker.
const CHERRY_PICK = /\(cherry picked from commit ([0-9a-f]{7,64})\)/i;
const authorKey = (commit) => trailers(commit, 'Pipeline-Author').map((id) => id.toLowerCase()).sort().join(',');
function patchIdOf(commit) {
  const shown = gitMaybe(['show', '--no-color', '--format=commit %H', commit]);
  if (shown.status !== 0) return null;
  const result = spawnSync('git', ['patch-id', '--stable'], { input: shown.stdout, encoding: 'utf8' });
  if (result.status !== 0) return null;
  return String(result.stdout || '').trim().split(/\r?\n/)[0]?.split(/\s+/)[0] || null;
}
// patch-id -> { commits, authors } for every reachable commit, computed in one pass. The author set
// makes the hand-recreation check O(1) per merged commit instead of scanning the whole log.
function patchIdIndex() {
  const log = spawnSync('git', ['log', '--all', '--no-merges', '--no-color', '-p'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (log.status !== 0) return { byCommit: new Map(), byPatch: new Map() };
  const ids = spawnSync('git', ['patch-id', '--stable'], { input: log.stdout, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (ids.status !== 0) return { byCommit: new Map(), byPatch: new Map() };
  const byCommit = new Map();
  const byPatch = new Map();
  for (const line of String(ids.stdout || '').split(/\r?\n/)) {
    const match = line.trim().match(/^([0-9a-f]{7,64})\s+([0-9a-f]{7,64})$/);
    if (!match) continue;
    const [, patchId, commit] = match;
    byCommit.set(commit, patchId);
    const entry = byPatch.get(patchId) || { commits: new Set(), authors: new Set() };
    entry.commits.add(commit);
    entry.authors.add(authorKey(commit));
    byPatch.set(patchId, entry);
  }
  return { byCommit, byPatch };
}

// Red proof is only meaningful when a test ran and failed on its assertions.
// Distinguish that from "the suite could not even load": a collection/import/
// syntax error turns the same command red without exercising any behaviour, and
// `tester.md` already forbids accepting it. The check is deliberately narrow so a
// genuine assertion failure quoting an ImportError still counts as behavioural.
const RED_NON_BEHAVIOR = [
  /SyntaxError/i,
  /ModuleNotFoundError/i,
  /(?:^|\W)(?:Cannot find module|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND)(?:\W|$)/i,
  /\berror(?:s)? during collection\b/i,
  /\b(?:ImportError|IndentationError|NameError) while importing\b/i,
  /\b(?:no tests ran|collected 0 items|Ran 0 tests)\b/i,
  /\bfailed to (?:load|import|collect|start|parse)\b/i,
];
function isBehavioralRed(output) {
  const text = String(output || '');
  if (!/\b(?:fail(?:ed|ures?|ing)?|AssertionError|expected|t\.is|✖|not ok)\b/i.test(text)) return false;
  return !RED_NON_BEHAVIOR.some((pattern) => pattern.test(text));
}

// Greenfield TDD: a test that statically imports a module the task is about to
// create fails with ERR_MODULE_NOT_FOUND on the base. That IS behavioral Red —
// the test asserts the module exists, which is exactly the gap the implementer
// fills. `isBehavioralRed` rejects it because ERR_MODULE_NOT_FOUND is in the
// non-behavior list. This function re-evaluates: if every missing-module path
// resolves to a file inside the task's Write scope, the Red is legitimate.
const MISSING_MODULE_PATH = /Cannot find module '([^']+)'/g;
// Python: `ModuleNotFoundError: No module named 'app.feature'`. Greenfield only when the
// top-level package already exists under a source root (same first-party rule as
// toolchain.mjs, so an uninstalled `pytest` stays exit 36) and the new file lands in Write scope.
const MISSING_PY_MODULE = /No module named ['"]?([\w.]+)['"]?/g;
const PY_ROOTS = ['', 'src/', 'lib/', 'app/'];
// A brand-new top-level package (`billing.core` where nothing named `billing` exists
// yet) has no root to look up, so the first-party test cannot fire. Accept it only
// when the task itself declares the module file inside Write scope; an uninstalled
// `pytest` is never in the task's diff and still reports as a missing dependency.
function pyModuleInScope(dotted, scopes, declaredFiles = []) {
  const top = dotted.split('.')[0];
  const mod = dotted.replaceAll('.', '/');
  const files = [`${mod}.py`, `${mod}/__init__.py`];
  const roots = PY_ROOTS.filter((root) => fs.existsSync(`${root}${top}`) || fs.existsSync(`${root}${top}.py`));
  if (roots.length > 0) {
    return roots.some((root) => files.some((file) => isFileWithinScopes(`${root}${file}`, scopes)));
  }
  // 全新顶层包：`src/billing/core.py` 与 `billing/core.py` 两种布局都要认。此前只比对无前缀
  // 路径，`src/`/`lib/`/`app/` 布局的新包会被误报成 collection error（exit 33/36）。
  return declaredFiles.length > 0
    && PY_ROOTS.some((root) => files.some((file) => {
      const declared = `${root}${file}`;
      return isFileWithinScopes(declared, scopes) && declaredFiles.includes(declared);
    }));
}
// A repo-relative missing module path matches a scope entry when it equals it or sits
// under it. Write scopes may name a directory (`src`, `packages/server/src/services`) or
// an exact file (`packages/server/src/services/a.ts`). Extension differs by runtime: a
// TypeScript test imports `./a.js` (NodeNext) or `./a.ts`, while the frozen scope names
// `.ts`. Compare with the runtime extension stripped so both spellings identify the same
// declared file — without that, a file-scoped task's greenfield Red is rejected as a
// collection error and `merge-task` exits 33.
const TS_EXTENSIONS = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;
function declaredPathMatches(absPath, scope) {
  const normalized = String(absPath).replace(/\\/g, '/').replace(/^\/+/, '');
  const dir = normalized.startsWith(`${scope}/`) || normalized.includes(`/${scope}/`);
  if (dir) return true;
  const candidates = [normalized, absPath.replace(/\\/g, '/')];
  const bareScope = scope.replace(TS_EXTENSIONS, '');
  return candidates.some((candidate) => {
    const bare = candidate.replace(TS_EXTENSIONS, '');
    return bare.endsWith(`/${bareScope}`) || bare === bareScope;
  });
}
function isGreenfieldRed(output, taskScope, declaredFiles = []) {
  const text = String(output || '');
  const paths = [...text.matchAll(MISSING_MODULE_PATH)].map((m) => m[1]);
  // Only file paths (starting with . or /) qualify; bare package names do not.
  const filePaths = paths.filter((p) => /^[./]/.test(p));
  const pyModules = [...text.matchAll(MISSING_PY_MODULE)].map((m) => m[1]);
  if (filePaths.length === 0 && pyModules.length === 0) return false;
  // The missing file must sit inside the task's Write scope. `Cannot find module` already
  // carries the resolved absolute path, so check it against each scope entry.
  return filePaths.every((absPath) => taskScope.some((scope) => declaredPathMatches(absPath, scope)))
    && pyModules.every((mod) => pyModuleInScope(mod, taskScope, declaredFiles));
}

// A fresh linked worktree has no node_modules/.venv, so the frozen Verify can fail
// before any test runs. Exit 36 marks that environment fault instead of blaming the task.

function run(command, timeoutMs, { capture = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', detached: true });
    let output = '';
    if (capture) {
      for (const stream of [child.stdout, child.stderr]) {
        stream.on('data', (chunk) => {
          output += chunk;
          // Keep the operator's view identical to the non-capture path.
          if (output.length <= 200_000) process.stdout.write(chunk);
        });
      }
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      const kill = (signal) => { try { process.kill(-child.pid, signal); } catch { child.kill(signal); } };
      kill('SIGTERM');
      setTimeout(() => kill('SIGKILL'), 2000).unref();
    }, timeoutMs);
    child.on('error', (error) => { clearTimeout(timer); resolve({ error, output }); });
    child.on('exit', (status, signal) => { clearTimeout(timer); resolve({ status, signal, timedOut, output }); });
  });
}

// Wall-clock per merge phase, recorded in run-log.md. The merge is a serial critical
// section, so these numbers decide whether it is worth optimising before anyone guesses.
const timing = {};
const startedAt = Date.now();
// --allow-attempt-over: a human approved attempts beyond the -a3 circuit breaker.
const allowAttemptOver = process.argv.includes('--allow-attempt-over');
const args = process.argv.slice(2).filter((arg) => !arg.startsWith('--timeout') && arg !== '--allow-attempt-over');
const timeoutArg = process.argv.find((arg) => arg.startsWith('--timeout'));
const timeout = Number(timeoutArg?.split('=')[1] ?? 30 * 60 * 1000);
const [branch, taskId, reviewTag] = args;
if (!branch || !taskId || !reviewTag || args.length !== 3) fail(usage, 2);

const match = branch.match(/^task\/([^/]+)\/([A-Za-z][A-Za-z0-9]*-\d+)(?:-a(\d+))?$/);
if (!match) fail(`branch must be task/<change>/<task-id>[-aN]: ${branch}`);
const change = match[1];
if (match[2] !== taskId) fail(`branch task ID ${match[2]} does not match requested ${taskId}`);
// Circuit breaker (lead.md): T-xx, -a2, -a3. A 4th attempt needs explicit human approval.
if (Number(match[3] ?? 1) > 3 && !allowAttemptOver) fail(`${branch} is attempt ${match[3]}; breaker allows 3 without human approval (pass --allow-attempt-over)`, 37);

if (git(['branch', '--show-current']) !== `integration/${change}`) fail(`current branch must be integration/${change}`);
if (git(['status', '--porcelain']) !== '') fail('integration worktree must be clean');
const preMergeHead = git(['rev-parse', 'HEAD']);
const tip = git(['rev-parse', '--verify', `${branch}^{commit}`]);
const tag = parseReviewTag(reviewTag);
if (!tag || !tip.startsWith(tag.tip)) fail(`review tag does not bind this tip: ${reviewTag}`, 32);

const tasksFile = path.join('openspec', 'changes', change, 'tasks.md');
const runLog = path.join('openspec', 'changes', change, 'run-log.md');
if (!fs.existsSync(tasksFile)) fail(`missing ${tasksFile}`);
const parsed = parseTasks(fs.readFileSync(tasksFile, 'utf8'));
const graph = graphErrors(parsed.errors);
if (graph.length) fail(`invalid tasks graph:\n${graph.map((x) => `${x.code}: ${x.message}`).join('\n')}`);
const task = parsed.tasks.find((item) => item.id === taskId);
if (!task) fail(`unknown task ${taskId}`);
if (task.done) fail(`${taskId} is already Done (${task.done.source}); do not re-dispatch`);
for (const dep of mergeDeps(task)) {
  const parent = parsed.tasks.find((item) => item.id === dep);
  if (!parent?.done) {
    const edge = task.depends.includes(dep) ? 'dependency' : 'Uses';
    fail(`${taskId} ${edge} ${dep} is not Done`, 35);
  }
}

const base = git(['rev-parse', '--verify', `${tag.base}^{commit}`]);
for (const [ref, label] of [[base, 'review base'], [tip, 'review tip']]) {
  if (gitMaybe(['merge-base', '--is-ancestor', base, ref]).status !== 0) fail(`${label} is inconsistent`, 34);
}
if (gitMaybe(['merge-base', '--is-ancestor', base, preMergeHead]).status !== 0) {
  fail('review base is not an ancestor of integration HEAD; re-review after rebasing', 34);
}

const files = gitMaybe(['diff', '--name-only', '-z', '--no-renames', `${base}..${tip}`]).stdout.split('\0').filter(Boolean);
for (const file of files) {
  if (!isFileWithinScopes(file, task.scope)) fail(`${file} is outside ${taskId} Write scope`, 30);
}

const commits = git(['rev-list', '--reverse', `${base}..${tip}`]).split(/\r?\n/).filter(Boolean);
if (!commits.length) fail('task branch has no commits', 31);
const authors = new Set();
const testAuthors = new Set();
const implementationAuthors = new Set();
let implementationCommits = 0;
const testFiles = new Set();
let patchIndex = null;
for (const commit of commits) {
  const roles = trailers(commit, 'Pipeline-Role').map((x) => x.toLowerCase());
  const ids = trailers(commit, 'Pipeline-Author');
  if (!roles.length || roles.some((role) => !WRITER_ROLES.has(role)) || !ids.length) {
    fail(`${commit.slice(0, 7)} lacks valid writer Pipeline-Role/Pipeline-Author trailers`, 31);
  }
  // Cherry-pick provenance. A clean pick keeps the original trailers; a conflict-continue pick
  // relies on the commit-msg hook preserving them. A hand-recreated commit has the same patch but a
  // fresh author, so it must carry the marker or it is rejected here.
  const message = git(['show', '-s', '--format=%B', commit]);
  const picked = message.match(CHERRY_PICK);
  if (picked) {
    const source = picked[1];
    if (gitMaybe(['rev-parse', '--verify', '--quiet', `${source}^{commit}`]).status !== 0) {
      fail(`${commit.slice(0, 7)} claims cherry picked from ${source}, which does not exist`, 31);
    }
    const sourceSha = git(['rev-parse', `${source}^{commit}`]);
    if (patchIdOf(commit) !== patchIdOf(sourceSha)) {
      fail(`${commit.slice(0, 7)} cherry-pick patch-id differs from ${sourceSha.slice(0, 7)}; the pick changed the diff`, 31);
    }
    if (authorKey(commit) !== authorKey(sourceSha)) {
      fail(`${commit.slice(0, 7)} cherry-pick Pipeline-Author (${authorKey(commit) || 'none'}) differs from ${sourceSha.slice(0, 7)} (${authorKey(sourceSha) || 'none'})`, 31);
    }
  } else {
    patchIndex ??= patchIdIndex();
    const patchId = patchIndex.byCommit.get(commit);
    if (patchId) {
      const entry = patchIndex.byPatch.get(patchId);
      const otherAuthor = [...(entry?.authors || [])].find((author) => author && author !== authorKey(commit));
      if (otherAuthor) {
        const other = [...entry.commits].find((sha) => sha !== commit);
        fail(`${commit.slice(0, 7)} restates ${other?.slice(0, 7) || 'another commit'} but Pipeline-Author differs and no "(cherry picked from commit ...)" marker is present; replay with git cherry-pick -x`, 31);
      }
    }
  }
  const changed = filesInCommit(commit);
  const testCommit = roles.every((role) => TEST_ROLES.has(role));
  const implementationCommit = roles.every((role) => IMPLEMENTATION_ROLES.has(role));
  if (roles.some((role) => TEST_ROLES.has(role)) && !testCommit) fail(`${commit.slice(0, 7)} mixes test-author and implementation roles`, 31);
  if (testCommit && changed.some((file) => !isTestPath(file))) fail(`test-author commit changes non-test files: ${changed.filter((file) => !isTestPath(file)).join(', ')}`, 30);
  ids.forEach((id) => {
    authors.add(id.toLowerCase());
    if (testCommit) testAuthors.add(id);
    if (implementationCommit) implementationAuthors.add(id);
  });
  if (testCommit) changed.forEach((file) => testFiles.add(file));
  if (implementationCommit) implementationCommits += 1;
}
// Same-branch rework cap (lead.md): the original implementer gets at most 2 implementation commits
// on one branch; a third is a capability problem, not a typo. Escalate to `<T-id>-a2` + gaogong.
if (implementationCommits > 2 && !allowAttemptOver) {
  fail(`${branch} has ${implementationCommits} implementation commits; same-branch rework is capped at 2. Escalate to ${taskId}-a2 (cherry-pick the ceshi Red commit, dispatch gaogong) or pass --allow-attempt-over after human approval`, 37);
}
for (const commit of commits) {
  const roles = trailers(commit, 'Pipeline-Role').map((x) => x.toLowerCase());
  if (!roles.every((role) => TEST_ROLES.has(role)) && filesInCommit(commit).some((file) => testFiles.has(file))) {
    fail(`${commit.slice(0, 7)} modifies test-author files`, 30);
  }
}
if (task.review !== 'mechanical' && (testAuthors.size === 0 || implementationAuthors.size === 0)) fail('behavior task requires separate ceshi test-author and implementation commits', 31);
if (task.review !== 'mechanical' && [...testAuthors].some((id) => implementationAuthors.has(id))) fail('test author and implementer must be different agents', 32);
const needsAgentModels = task.review !== 'mechanical';
const agents = needsAgentModels ? paseoAgents() : [];
const testModels = [...testAuthors].map((id) => modelFor(id, agents));
const implementationModels = [...implementationAuthors].map((id) => modelFor(id, agents));
if (needsAgentModels && [...testModels, ...implementationModels].some((model) => !model)) fail('cannot resolve test-author/implementer model from Paseo; refusing merge', 32);
if (needsAgentModels && testModels.some((model) => implementationModels.includes(model))) fail('test author and implementer must use different models', 32);
// The Lead schedules and merges; a commit authored under its identity is the Lead writing code.
// `ls` hides some archived agents, so an unresolved id is asked of Paseo directly
// before the check gives up (same fallback as `modelFor`).
if (needsAgentModels) {
  for (const id of authors) {
    const hits = findAgents(id, agents);
    const resolved = hits.length === 1 ? hits[0] : hits.length === 0 ? inspectAgent(id) : null;
    if (resolved && /shangshu/i.test(nameOf(resolved))) fail(`${id} is the Lead (shangshu); the Lead must not author task commits`, 31);
  }
}
// Authors are recorded as full UUIDs and the tag may carry a shortId prefix; compare
// identities as well as spellings. The literal check stays as a fallback for when the
// live agent list cannot resolve either side.
const reviewerAgents = ['mechanical', 'deferred'].includes(tag.reviewer) ? [] : findAgents(tag.reviewer, agents);
const deferred = task.review === 'deferred';
const realReviewer = tag.reviewer !== 'mechanical' && tag.reviewer !== 'deferred';
if (realReviewer && (
  authors.has(tag.reviewer.toLowerCase())
  || [...authors].some((id) => findAgents(id, agents).some((agent) => reviewerAgents.includes(agent)))
)) {
  fail('reviewer matches a task author', 32);
}
if (tag.reviewer === 'mechanical' && task.review !== 'mechanical') fail('mechanical review requires Review: mechanical');
if (tag.reviewer === 'deferred' && !deferred) fail('deferred review tag requires Review: deferred', 32);
if (deferred && tag.reviewer !== 'deferred') fail(`${taskId} is Review: deferred and must merge on pass(deferred@<tip>/<base>); the FINAL review owns it`, 32);
// Deferred tasks skip the per-task reviewer-model checks; the FINAL integrated review owns them.
// Their test-author/implementer separation is still enforced above.
if (realReviewer && task.review !== 'mechanical' && !deferred) {
  const reviewerModel = modelFor(tag.reviewer, agents);
  if (!reviewerModel) fail('cannot resolve reviewer model from Paseo; refusing merge', 32);
  if (implementationModels.includes(reviewerModel)) fail('reviewer and implementer must use different models', 32);
  if (testModels.includes(reviewerModel)) console.error(`[merge-task] WARN reviewer shares model ${reviewerModel} with test author; prefer a third profile`);
}

if (base !== preMergeHead) {
  const integrationFiles = new Set(gitMaybe(['diff', '--name-only', '-z', `${base}..${preMergeHead}`]).stdout.split('\0').filter(Boolean));
  if (files.some((file) => integrationFiles.has(file))) fail('integration drift overlaps task files; re-review required', 34);
}

// The integration branch is cut from main and reviewed against it; if main moved on this task's
// files since they diverged, the review and Verify ran on a stale picture. Fail-open when neither
// default branch exists locally (fixtures, detached setups).
{
  const defaultBranch = ['main', 'master'].find((name) => gitMaybe(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]).status === 0);
  if (defaultBranch) {
    const mainFiles = gitMaybe(['diff', '--name-only', '-z', `HEAD...${defaultBranch}`]).stdout.split('\0').filter(Boolean);
    const clash = mainFiles.filter((file) => isFileWithinScopes(file, task.scope) || files.includes(file));
    if (clash.length) fail(`${defaultBranch} advanced on task scope (${clash.join(', ')}); rebase integration/${change} onto ${defaultBranch} and re-review`, 34);
  }
}

// TDD proof: the test-author prefix (commits before the first implementation commit) must fail the frozen Verify
// on its own. Merged without committing in this worktree so dependencies and environment match the real Verify.
if (task.review !== 'mechanical') {
  let redTip = null;
  for (const commit of commits) {
    const roles = trailers(commit, 'Pipeline-Role').map((x) => x.toLowerCase());
    if (!roles.every((role) => TEST_ROLES.has(role))) break;
    redTip = commit;
  }
  if (!redTip) fail('test-author commit must precede the first implementation commit', 31);
  const redMerge = gitMaybe(['merge', '--no-ff', '--no-commit', redTip]);
  if (redMerge.status !== 0) { gitMaybe(['merge', '--abort']); fail('merge conflict while checking Red', 10); }
  const redStart = Date.now();
  const red = await run(task.verify, timeout, { capture: true });
  timing.red = Date.now() - redStart;
  gitMaybe(['merge', '--abort']);
  if (git(['status', '--porcelain=v1', '--untracked-files=all']) !== '') fail('Red check left files in the integration worktree; clean them and retry', 33);
  // A real assertion failure wins over the dependency hint: a test may legitimately
  // quote "Cannot find package" in its own failure message. A greenfield Red does too:
  // the module it names is declared by this task, not a missing install.
  const redBehavioral = isBehavioralRed(red.output);
  const redGreenfield = !redBehavioral && isGreenfieldRed(red.output, task.scope, files);
  const redMissing = (redBehavioral || redGreenfield) ? null : missingDependency(red.output);
  if (redMissing) fail(`Red check: ${dependencyMessage(redMissing)}`, 36);
  if (red.error || red.timedOut || red.signal || [126, 127].includes(red.status)) fail(`Red check could not run Verify (exit ${red.status ?? 'n/a'}): ${task.verify}`, 33);
  if (red.status === 0) fail(`Red check: frozen Verify already passes on the test-author commit ${redTip.slice(0, 7)}; tests do not prove new behavior`, 33);
  if (!redBehavioral && !redGreenfield) fail(`Red check: Verify failed without a test assertion (collection/import/syntax error) on ${redTip.slice(0, 7)}; name a runnable test path: ${task.verify}`, 33);
}

const merge = gitMaybe(['merge', '--no-ff', '--no-commit', tip]);
if (merge.status !== 0) {
  gitMaybe(['merge', '--abort']);
  fail('merge conflict', 10);
}
const before = git(['status', '--porcelain=v1', '--untracked-files=all']);
const verifyStart = Date.now();
const result = await run(task.verify, timeout, { capture: true });
timing.verify = Date.now() - verifyStart;
const after = git(['status', '--porcelain=v1', '--untracked-files=all']);
const verifyChanged = after !== before;
// Missing dependency first: it produces a non-zero exit that would otherwise be read as
// a plain Verify failure (exit 20) and send the operator hunting for a test bug.
// Node/Python report a missing package with exit 1, so any non-zero status qualifies; a real
// assertion failure that merely quotes the message still wins (same guard as the Red check).
if (!verifyChanged && result.status !== 0) {
  const verifyMissing = isBehavioralRed(result.output) ? null : missingDependency(result.output);
  if (verifyMissing) {
    gitMaybe(['merge', '--abort']);
    fail(`frozen Verify: ${dependencyMessage(verifyMissing)}`, 36);
  }
}
if (result.error || result.status !== 0 || result.signal || result.timedOut || verifyChanged) {
  gitMaybe(['merge', '--abort']);
  fail(`frozen Verify failed or changed worktree: ${task.verify}`, 20);
}

// Cross-task regression: with the merge applied, every already-Done task whose scope
// could be affected by this task's changes must still pass its narrow Verify. Broad
// (whole-suite) legs are skipped here; they belong to the sink and final acceptance.
// Only replay tasks that share a transitive dependency with the current task or whose
// scope overlaps the files this task touches — fully independent branches cannot regress.
const scopesOverlap = (scopesA, scopesB) => scopesA.some((a) => scopesB.some((b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)));
const taskAncestors = new Set();
{ const walk = (id) => { for (const dep of (parsed.tasks.find((t) => t.id === id)?.depends ?? [])) { taskAncestors.add(dep); walk(dep); } }; walk(taskId); }
const regressionStart = Date.now();
let replayed = 0;
for (const prior of parsed.tasks.filter((item) => item.done && item.id !== taskId && item.verify)) {
  // Skip if prior is fully independent: no shared dependency chain AND no scope overlap.
  const priorAncestors = new Set();
  { const walk = (id) => { for (const dep of (parsed.tasks.find((t) => t.id === id)?.depends ?? [])) { priorAncestors.add(dep); walk(dep); } }; walk(prior.id); }
  const sharesDep = taskAncestors.has(prior.id) || priorAncestors.has(taskId)
    || [...taskAncestors].some((a) => priorAncestors.has(a));
  if (!sharesDep && !scopesOverlap(task.scope, prior.scope)) continue;
  const legs = verifyLegs(prior.verify).filter((leg) => !leg.broad);
  if (!legs.length) continue;
  replayed += 1;
  const regression = await run(legs.map((leg) => leg.command).join(' && '), timeout);
  if (regression.error || regression.status !== 0 || regression.signal || regression.timedOut) {
    gitMaybe(['merge', '--abort']);
    fail(`merge would regress already-Done ${prior.id}: ${legs.map((leg) => leg.command).join(' && ')}`, 21);
  }
}
if (git(['status', '--porcelain=v1', '--untracked-files=all']) !== before) {
  gitMaybe(['merge', '--abort']);
  fail('regression check changed worktree', 21);
}
timing.regression = Date.now() - regressionStart;
timing.replayed = replayed;
timing.total = Date.now() - startedAt;

const lines = fs.readFileSync(tasksFile, 'utf8').split('\n');
const index = task.line - 1;
const parsedLine = parseTaskLine(lines[index]);
if (!parsedLine || parsedLine.id !== taskId || parsedLine.checked) fail(`cannot locate unfinished ${taskId} at frozen line ${task.line}`);
lines[index] = lines[index].replace(/^(\s*[-*]\s*\[) /, '$1x');
lines.splice(index + 1, 0, `  - Done: source=${tip.slice(0, 7)} review=${reviewTag}`);
fs.writeFileSync(tasksFile, lines.join('\n'));
fs.mkdirSync(path.dirname(runLog), { recursive: true });
fs.appendFileSync(runLog, `- ${new Date().toISOString()} merge task=${taskId} source=${tip} review=${reviewTag} verify=${JSON.stringify(task.verify)} timing_ms=${JSON.stringify(timing)}\n`);
git(['add', tasksFile, runLog]);
git(['commit', '-m', `merge(${taskId}): ${branch}`, '-m', [
  `Pipeline-Task: ${taskId}`,
  `Pipeline-Source: ${tip}`,
  ...[...authors].sort().map((id) => `Pipeline-Author: ${id}`),
  `Pipeline-Role: ${task.review === 'mechanical' ? 'mechanical' : task.review}`,
  `Pipeline-Reviewer: ${tag.reviewer}`,
].join('\n')]);
console.log(`[merge-task] merged ${taskId} from ${tip.slice(0, 7)} as ${git(['rev-parse', 'HEAD']).slice(0, 7)}`);
