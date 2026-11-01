#!/usr/bin/env node
// Safe merge gate. The only writer of integration history.
// Scope, trailers, review binding, dependencies, frozen Verify, then --no-ff.

import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseTasks, parseTaskLine, parseReviewTag, isFileWithinScopes, graphErrors } from './lib/tasks.mjs';

const WRITER_ROLES = new Set(['gongbu', 'gaogong', 'ceshi', 'jiangzuo']);
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
for (const commit of commits) {
  const roles = trailers(commit, 'Pipeline-Role').map((x) => x.toLowerCase());
  const ids = trailers(commit, 'Pipeline-Author');
  if (!roles.length || roles.some((role) => !WRITER_ROLES.has(role)) || !ids.length) {
    fail(`${commit.slice(0, 7)} lacks valid writer Pipeline-Role/Pipeline-Author trailers`, 31);
  }
  ids.forEach((id) => authors.add(id.toLowerCase()));
}
if (tag.reviewer !== 'mechanical' && authors.has(tag.reviewer.toLowerCase())) {
  fail('reviewer matches a task author', 32);
}
if (tag.reviewer === 'mechanical' && task.review !== 'mechanical') fail('mechanical review requires Review: mechanical');

if (base !== preMergeHead) {
  const integrationFiles = new Set(gitMaybe(['diff', '--name-only', '-z', `${base}..${preMergeHead}`]).stdout.split('\0').filter(Boolean));
  if (files.some((file) => integrationFiles.has(file))) fail('integration drift overlaps task files; re-review required', 34);
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
