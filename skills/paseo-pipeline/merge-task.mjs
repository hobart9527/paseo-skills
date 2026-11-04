#!/usr/bin/env node
// Safe merge gate. The only writer of integration history.
// Dependencies, scope, provenance, frozen Verify, regression, then --no-ff.
// Task-level review is gone: quality is owned by the FINAL integrated review.
// The optional third argument is a legacy review tag, used only as a base hint.

import { spawn } from 'node:child_process';
import { parseOptions } from './lib/cli.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { parseTasks, parseTaskLine, isFileWithinScopes, graphErrors, verifyLegs } from './lib/tasks.mjs';
import { mergeDeps, regressionReplays } from './lib/schedule.mjs';
import { runGit } from './lib/git.mjs';
import { writeMergeState, clearMergeState } from './lib/merge-state.mjs';
import { patchIdOf as patchIdFor, samePatchCommits as samePatchCommitsFor } from './lib/provenance.mjs';
import { missingDependency, dependencyMessage } from './lib/toolchain.mjs';

// `ceshi` stays accepted so branches authored before this change still carry valid
// provenance; new work uses one of the worker roles.
const WRITER_ROLES = new Set(['gongbu', 'gaogong', 'jiangzuo', 'ceshi']);
const usage = 'Usage: merge-task.mjs <branch> <task-id> [<legacy-review-tag>] [--timeout ms]';
let mergeState = null;
function fail(message, code = 1) {
  if (mergeState) {
    try { writeMergeState(undefined, mergeState.change, mergeState.task, { tip: mergeState.tip, status: 'failed', code }); }
    catch (error) { console.error(`[merge-task] cannot record failure: ${error.message}`); }
  }
  console.error(`[merge-task] Error: ${message}`);
  process.exit(code);
}

function git(args) {
  const result = runGit(undefined, args);
  if (result.error) fail(`git ${args[0]} failed: ${result.error.message}`);
  if (result.status !== 0) fail(`git ${args.join(' ')} failed\n${result.stdout}${result.stderr}`);
  return result.stdout.trim();
}

function gitMaybe(args) {
  return runGit(undefined, args);
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
const gitAdapter = (cwd, args, options) => runGit(cwd, args, options);
const patchIdOf = (commit) => patchIdFor(commit, { git: gitAdapter });
const samePatchCommits = (commit) => samePatchCommitsFor(commit, { git: gitAdapter });

function run(command, timeoutMs, { capture = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', detached: true });
    let output = '';
    if (capture) {
      for (const stream of [child.stdout, child.stderr]) {
        stream.on('data', (chunk) => {
          output += chunk;
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
let parsedArgs;
try { parsedArgs = parseOptions(process.argv.slice(2), { timeout: 'value', 'allow-attempt-over': 'boolean' }); }
catch (error) { fail(error.message, 2); }
const allowAttemptOver = !!parsedArgs.options['allow-attempt-over'];
const timeoutRaw = parsedArgs.options.timeout ?? '1800000';
const timeout = Number(timeoutRaw);
if (!/^\d+$/.test(timeoutRaw) || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2147483647) fail('--timeout needs a positive integer in milliseconds (maximum 2147483647)', 2);
const args = parsedArgs.positional;
const [branch, taskId, baseHint] = args;
if (!branch || !taskId || args.length > 3) fail(usage, 2);

const match = branch.match(/^task\/([^/]+)\/([A-Za-z][A-Za-z0-9]*-\d+)(?:-a(\d+))?$/);
if (!match) fail(`branch must be task/<change>/<task-id>[-aN]: ${branch}`);
const change = match[1];
if (match[2] !== taskId) fail(`branch task ID ${match[2]} does not match requested ${taskId}`);
if (Number(match[3] ?? 1) > 3 && !allowAttemptOver) fail(`${branch} is attempt ${match[3]}; breaker allows 3 without human approval (pass --allow-attempt-over)`, 37);

if (git(['branch', '--show-current']) !== `integration/${change}`) fail(`current branch must be integration/${change}`);
const preMergeHead = git(['rev-parse', 'HEAD']);
const tip = git(['rev-parse', '--verify', `${branch}^{commit}`]);
// A clean committed Done state can survive a crash before the pending marker clears.
// Never overwrite that evidence when a caller retries the completed task.
const doneFile = path.join('openspec', 'changes', change, 'tasks.md');
if (git(['status', '--porcelain']) === '' && fs.existsSync(doneFile)) {
  const prior = parseTasks(fs.readFileSync(doneFile, 'utf8'));
  if (!graphErrors(prior.errors).length) {
    const completed = prior.tasks.find((item) => item.id === taskId)?.done;
    if (completed) fail(`${taskId} is already Done (${completed.source}); do not re-dispatch`);
  }
}
try {
  writeMergeState(undefined, change, taskId, { tip, status: 'pending' });
  mergeState = { change, task: taskId, tip };
} catch (error) { fail(`cannot record merge state: ${error.message}`, 3); }
if (git(['status', '--porcelain']) !== '') fail('integration worktree must be clean');

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

// Base is the task's fork point. A legacy review tag named the contract commit
// explicitly; keep it as a hint so an older caller still binds the same range.
let base;
if (baseHint) {
  const tagged = String(baseHint).match(/@([0-9a-f]{7,40})\/([0-9a-f]{7,40})\)$/);
  base = git(['rev-parse', '--verify', `${tagged ? tagged[2] : baseHint}^{commit}`]);
} else {
  base = git(['merge-base', preMergeHead, tip]);
}
for (const [ref, label] of [[base, 'base'], [tip, 'tip']]) {
  if (gitMaybe(['merge-base', '--is-ancestor', base, ref]).status !== 0) fail(`${label} is inconsistent`, 34);
}
if (gitMaybe(['merge-base', '--is-ancestor', base, preMergeHead]).status !== 0) {
  fail('base is not an ancestor of integration HEAD; rebase the task branch', 34);
}

const files = gitMaybe(['diff', '--name-only', '-z', '--no-renames', `${base}..${tip}`]).stdout.split('\0').filter(Boolean);
for (const file of files) {
  if (!isFileWithinScopes(file, task.scope)) fail(`${file} is outside ${taskId} Write scope`, 30);
}

const commits = git(['rev-list', '--reverse', `${base}..${tip}`]).split(/\r?\n/).filter(Boolean);
if (!commits.length) fail('task branch has no commits', 31);
const authors = new Set();
const implementationAuthors = new Set();
let implementationCommits = 0;
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
    const samePatch = samePatchCommits(commit);
    if (samePatch === null) {
      fail(`${commit.slice(0, 7)}: cannot verify cherry-pick provenance (git log/patch-id failed or the history scan exceeded its buffer); refusing to merge an unverified commit`, 31);
    }
    const other = samePatch.find((sha) => authorKey(sha) !== authorKey(commit));
    if (other) {
      fail(`${commit.slice(0, 7)} restates ${other.slice(0, 7)} but Pipeline-Author differs and no "(cherry picked from commit ...)" marker is present; replay with git cherry-pick -x`, 31);
    }
  }
  ids.forEach((id) => {
    authors.add(id.toLowerCase());
    implementationAuthors.add(id);
  });
  implementationCommits += 1;
}
// Same-branch rework cap: the worker gets at most 2 commits on one branch; a third
// is a capability problem, not a typo. Escalate to `<T-id>-a2`.
if (implementationCommits > 2 && !allowAttemptOver) {
  fail(`${branch} has ${implementationCommits} commits; same-branch rework is capped at 2. Escalate to ${taskId}-a2 or pass --allow-attempt-over after human approval`, 37);
}

if (base !== preMergeHead) {
  const integrationFiles = new Set(gitMaybe(['diff', '--name-only', '-z', `${base}..${preMergeHead}`]).stdout.split('\0').filter(Boolean));
  if (files.some((file) => integrationFiles.has(file))) fail('integration drift overlaps task files; re-run after rebasing', 34);
}

// The integration branch is cut from main and reviewed against it; if main moved on this task's
// files since they diverged, the Verify ran on a stale picture. Fail-open when neither
// default branch exists locally (fixtures, detached setups).
{
  const defaultBranch = ['main', 'master'].find((name) => gitMaybe(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]).status === 0);
  if (defaultBranch) {
    const mainFiles = gitMaybe(['diff', '--name-only', '-z', `HEAD...${defaultBranch}`]).stdout.split('\0').filter(Boolean);
    const clash = mainFiles.filter((file) => isFileWithinScopes(file, task.scope) || files.includes(file));
    if (clash.length) fail(`${defaultBranch} advanced on task scope (${clash.join(', ')}); rebase integration/${change} onto ${defaultBranch} and re-verify`, 34);
  }
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
if (!verifyChanged && result.status !== 0) {
  const verifyMissing = missingDependency(result.output);
  if (verifyMissing) {
    gitMaybe(['merge', '--abort']);
    fail(`frozen Verify: ${dependencyMessage(verifyMissing)}`, 36);
  }
}
if (result.error || result.status !== 0 || result.signal || result.timedOut || verifyChanged) {
  gitMaybe(['merge', '--abort']);
  fail(`frozen Verify failed or changed worktree: ${task.verify}`, 20);
}

// Cross-task regression: with the merge applied, every already-Done task whose Verify can
// observe a file this merge changed must still pass its narrow Verify. Broad (whole-suite)
// legs are skipped here; they belong to the sink and final acceptance.
const changedFiles = git(['diff', '--name-only', '-z', 'HEAD']).split('\0').filter(Boolean);
const replayIds = new Set(regressionReplays(task, parsed.tasks.filter((item) => item.done && item.verify), changedFiles));
const regressionStart = Date.now();
let replayed = 0;
for (const prior of parsed.tasks.filter((item) => item.done && item.id !== taskId && item.verify)) {
  if (!replayIds.has(prior.id)) continue;
  const legs = verifyLegs(prior.verify).filter((leg) => !leg.broad);
  if (!legs.length) continue;
  replayed += 1;
  const regression = await run(legs.map((leg) => leg.command).join(' && '), timeout);
  if (regression.error || regression.status !== 0 || regression.signal || regression.timedOut) {
    gitMaybe(['merge', '--abort']);
    // A replay failure has two causes and the gate cannot tell them apart: a real regression from
    // this merge, or an environment the Verify needed (a service, a port, a package) that is not
    // present here. Naming both stops the operator from "fixing" a test that is not broken.
    fail(`merge would regress already-Done ${prior.id}: ${legs.map((leg) => leg.command).join(' && ')}\n`
      + '  If the replay failed because the environment it needs is absent (service, port, package, env var),\n'
      + '  fix the environment and re-run merge. Do not edit the Verify command or the tests.', 21);
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
lines.splice(index + 1, 0, `  - Done: source=${tip.slice(0, 7)} review=worker`);
fs.writeFileSync(tasksFile, lines.join('\n'));
fs.mkdirSync(path.dirname(runLog), { recursive: true });
fs.appendFileSync(runLog, `- ${new Date().toISOString()} merge task=${taskId} source=${tip} verify=${JSON.stringify(task.verify)} timing_ms=${JSON.stringify(timing)}\n`);
git(['add', tasksFile, runLog]);
git(['commit', '-m', `merge(${taskId}): ${branch}`, '-m', [
  `Pipeline-Task: ${taskId}`,
  `Pipeline-Source: ${tip}`,
  ...[...authors].sort().map((id) => `Pipeline-Author: ${id}`),
  `Pipeline-Role: ${task.review === 'mechanical' ? 'mechanical' : task.review}`,
].join('\n')]);
try { clearMergeState(undefined, change, taskId); mergeState = null; }
catch (error) { console.error(`[merge-task] merged, but cannot clear merge state: ${error.message}`); process.exit(3); }
console.log(`[merge-task] merged ${taskId} from ${tip.slice(0, 7)} as ${git(['rev-parse', 'HEAD']).slice(0, 7)}`);
