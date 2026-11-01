#!/usr/bin/env node
// Safe merge gate. The only writer of integration history.
// Scope, trailers, review binding, dependencies, frozen Verify, then --no-ff.

import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseTasks, parseTaskLine, parseReviewTag, isFileWithinScopes, graphErrors, isTestPath } from './lib/tasks.mjs';

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
  const result = spawnSync('paseo', ['ls', '--all', '--json'], { encoding: 'utf8', timeout: 10_000 });
  if (result.error || result.status !== 0) fail('cannot resolve agent provider/model from `paseo ls --all --json`', 32);
  try {
    const agents = JSON.parse(result.stdout);
    if (!Array.isArray(agents)) throw new Error('expected agent array');
    return agents;
  } catch {
    fail('invalid JSON from `paseo ls --all --json`', 32);
  }
}

function modelFor(agentId, agents) {
  const matches = agents.filter((agent) => agent.id === agentId || agent.shortId === agentId);
  if (matches.length !== 1 || typeof matches[0].provider !== 'string' || !matches[0].provider.includes('/')) return null;
  return matches[0].provider.toLowerCase();
}

function filesInCommit(commit) {
  const result = gitMaybe(['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', commit]);
  if (result.status !== 0) fail(`cannot inspect files in commit ${commit.slice(0, 7)}`, 31);
  return result.stdout.split('\0').filter(Boolean);
}

function trailers(commit, key) {
  return git(['show', '-s', `--format=%(trailers:key=${key},valueonly)`, commit]).split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
}

function run(command, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, stdio: 'inherit', detached: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      const kill = (signal) => { try { process.kill(-child.pid, signal); } catch { child.kill(signal); } };
      kill('SIGTERM');
      setTimeout(() => kill('SIGKILL'), 2000).unref();
    }, timeoutMs);
    child.on('error', (error) => { clearTimeout(timer); resolve({ error }); });
    child.on('exit', (status, signal) => { clearTimeout(timer); resolve({ status, signal, timedOut }); });
  });
}

const args = process.argv.slice(2).filter((arg) => !arg.startsWith('--timeout'));
const timeoutArg = process.argv.find((arg) => arg.startsWith('--timeout'));
const timeout = Number(timeoutArg?.split('=')[1] ?? 30 * 60 * 1000);
const [branch, taskId, reviewTag] = args;
if (!branch || !taskId || !reviewTag || args.length !== 3) fail(usage, 2);

const match = branch.match(/^task\/([^/]+)\/([A-Za-z][A-Za-z0-9]*-\d+)(?:-a\d+)?$/);
if (!match) fail(`branch must be task/<change>/<task-id>[-aN]: ${branch}`);
const change = match[1];
if (match[2] !== taskId) fail(`branch task ID ${match[2]} does not match requested ${taskId}`);

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
for (const dep of task.depends) {
  const parent = parsed.tasks.find((item) => item.id === dep);
  if (!parent?.done) fail(`${taskId} dependency ${dep} is not Done`, 35);
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
const testFiles = new Set();
for (const commit of commits) {
  const roles = trailers(commit, 'Pipeline-Role').map((x) => x.toLowerCase());
  const ids = trailers(commit, 'Pipeline-Author');
  if (!roles.length || roles.some((role) => !WRITER_ROLES.has(role)) || !ids.length) {
    fail(`${commit.slice(0, 7)} lacks valid writer Pipeline-Role/Pipeline-Author trailers`, 31);
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
if (tag.reviewer !== 'mechanical' && authors.has(tag.reviewer.toLowerCase())) {
  fail('reviewer matches a task author', 32);
}
if (tag.reviewer === 'mechanical' && task.review !== 'mechanical') fail('mechanical review requires Review: mechanical');
if (tag.reviewer !== 'mechanical' && task.review !== 'mechanical') {
  const reviewerModel = modelFor(tag.reviewer, agents);
  if (!reviewerModel) fail('cannot resolve reviewer model from Paseo; refusing merge', 32);
  if (implementationModels.includes(reviewerModel)) fail('reviewer and implementer must use different models', 32);
  if (testModels.includes(reviewerModel)) console.error(`[merge-task] WARN reviewer shares model ${reviewerModel} with test author; prefer a third profile`);
}

if (base !== preMergeHead) {
  const integrationFiles = new Set(gitMaybe(['diff', '--name-only', '-z', `${base}..${preMergeHead}`]).stdout.split('\0').filter(Boolean));
  if (files.some((file) => integrationFiles.has(file))) fail('integration drift overlaps task files; re-review required', 34);
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
  const red = await run(task.verify, timeout);
  gitMaybe(['merge', '--abort']);
  if (git(['status', '--porcelain=v1', '--untracked-files=all']) !== '') fail('Red check left files in the integration worktree; clean them and retry', 33);
  if (red.error || red.timedOut || red.signal || [126, 127].includes(red.status)) fail(`Red check could not run Verify (exit ${red.status ?? 'n/a'}): ${task.verify}`, 33);
  if (red.status === 0) fail(`Red check: frozen Verify already passes on the test-author commit ${redTip.slice(0, 7)}; tests do not prove new behavior`, 33);
}

const merge = gitMaybe(['merge', '--no-ff', '--no-commit', tip]);
if (merge.status !== 0) {
  gitMaybe(['merge', '--abort']);
  fail('merge conflict', 10);
}
const before = git(['status', '--porcelain=v1', '--untracked-files=all']);
const result = await run(task.verify, timeout);
const after = git(['status', '--porcelain=v1', '--untracked-files=all']);
if (result.error || result.status !== 0 || result.signal || result.timedOut || after !== before) {
  gitMaybe(['merge', '--abort']);
  fail(`frozen Verify failed or changed worktree: ${task.verify}`, 20);
}

// Cross-task regression: with the merge applied, every already-Done task's frozen narrow Verify must still pass.
// Full-suite commands are skipped here; they belong to the sink and final acceptance.
const FULL_SUITE_LEG = /(^|[\s;&|])(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|(^|[\s;&|])(?:pytest|uv\s+run\s+pytest|go\s+test)(?:\s|$)/i;
for (const prior of parsed.tasks.filter((item) => item.done && item.id !== taskId && item.verify && !FULL_SUITE_LEG.test(item.verify))) {
  const regression = await run(prior.verify, timeout);
  if (regression.error || regression.status !== 0 || regression.signal || regression.timedOut) {
    gitMaybe(['merge', '--abort']);
    fail(`merge would regress already-Done ${prior.id}: ${prior.verify}`, 21);
  }
}
if (git(['status', '--porcelain=v1', '--untracked-files=all']) !== before) {
  gitMaybe(['merge', '--abort']);
  fail('regression check changed worktree', 21);
}

const lines = fs.readFileSync(tasksFile, 'utf8').split('\n');
const index = task.line - 1;
const parsedLine = parseTaskLine(lines[index]);
if (!parsedLine || parsedLine.id !== taskId || parsedLine.checked) fail(`cannot locate unfinished ${taskId} at frozen line ${task.line}`);
lines[index] = lines[index].replace(/^(\s*[-*]\s*\[) /, '$1x');
lines.splice(index + 1, 0, `  - Done: source=${tip.slice(0, 7)} review=${reviewTag}`);
fs.writeFileSync(tasksFile, lines.join('\n'));
fs.mkdirSync(path.dirname(runLog), { recursive: true });
fs.appendFileSync(runLog, `- ${new Date().toISOString()} merge task=${taskId} source=${tip} review=${reviewTag} verify=${JSON.stringify(task.verify)}\n`);
git(['add', tasksFile, runLog]);
git(['commit', '-m', `merge(${taskId}): ${branch}`, '-m', [
  `Pipeline-Task: ${taskId}`,
  `Pipeline-Source: ${tip}`,
  ...[...authors].sort().map((id) => `Pipeline-Author: ${id}`),
  `Pipeline-Role: ${task.review === 'mechanical' ? 'mechanical' : task.review}`,
  `Pipeline-Reviewer: ${tag.reviewer}`,
].join('\n')]);
console.log(`[merge-task] merged ${taskId} from ${tip.slice(0, 7)} as ${git(['rev-parse', 'HEAD']).slice(0, 7)}`);
