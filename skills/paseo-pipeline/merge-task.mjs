#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseTasks } from './lib/tasks.mjs';

const usage = [
  'Usage: node merge-task.mjs <branch> <task-ids> <review-tag> <test-cmd>',
  'review-tag: pass(<reviewer-id8>@<tip7>/<base7>)',
  'Note: this validates tag/SHA consistency only; it cannot prove a review occurred.',
].join('\n');

function fail(message, code = 1) {
  console.error(`[merge-task] Error: ${message}`);
  process.exit(code);
}

function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.error) fail(`git ${args.join(' ')} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${result.status})\n${result.stdout}${result.stderr}`);
  }
  return result.stdout.trim();
}

function gitMaybe(args) {
  return spawnSync('git', args, { encoding: 'utf8' });
}

function parseSourceBranch(branch) {
  let match = branch.match(/^task\/([^/]+)\/([A-Za-z]+-\d+)(?:-a\d+)?$/);
  if (match) return { change: match[1], taskId: match[2] };
  match = branch.match(/^pod\/([^/]+)$/);
  if (match) return { change: match[1], taskId: null };
  return null;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function changedFiles(fromRef, toRef) {
  const output = git(['diff', '--name-only', `${fromRef}..${toRef}`]);
  return output === '' ? [] : output.split('\n');
}

function abortMerge() {
  const mergeHead = gitMaybe(['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
  if (!mergeHead.error && mergeHead.status !== 0) return;
  const abort = gitMaybe(['merge', '--abort']);
  if (!abort.error && abort.status === 0) return;
  const detail = abort.error
    ? `git merge --abort could not start: ${abort.error.message}`
    : `git merge --abort failed (status=${abort.status}${abort.signal ? ` signal=${abort.signal}` : ''})\n${abort.stdout}${abort.stderr}`;
  const status = gitMaybe(['status', '--porcelain']);
  const site = status.error
    ? `git status could not start: ${status.error.message}`
    : status.stdout || '(working tree clean)';
  console.error([
    `[merge-task] Error: ${detail}`,
    '[merge-task] On-site state (git status --porcelain):',
    site,
    '[merge-task] Manual guidance: the repository may still be mid-merge (MERGE_HEAD present).',
    '[merge-task] Inspect with `git status`, resolve the blocker, then run `git merge --abort` by hand.',
    '[merge-task] Do NOT discard the working tree with a hard reset: uncommitted work would be lost.',
  ].join('\n'));
  process.exit(40);
}

function markTasksDone(tasksFile, requestedTasks, tip7, reviewTag) {
  const lines = fs.readFileSync(tasksFile, 'utf8').split('\n');

  for (const task of requestedTasks) {
    const taskPattern = new RegExp(
      `^(\\s*[-*]\\s*\\[) (\\]\\s+${escapeRegExp(task.num)}\\s+${escapeRegExp(task.id)}(?:\\s+|$).*)$`
    );
    const index = lines.findIndex((line) => taskPattern.test(line));
    if (index === -1) throw new Error(`无法在 tasks.md 精确定位未完成任务 ${task.id}`);
    const match = lines[index].match(taskPattern);
    lines[index] = `${match[1]}x${match[2]}`;
    lines.splice(index + 1, 0, `  - Done: source=${tip7} review=${reviewTag}`);
  }

  fs.writeFileSync(tasksFile, lines.join('\n'), 'utf8');
}

function appendRunLog(logFile, entry) {
  const previous = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  const separator = previous !== '' && !previous.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(logFile, `${previous}${separator}${entry}\n`, 'utf8');
}

if (process.argv.length !== 6) {
  console.error(usage);
  process.exit(1);
}

const [branch, taskIdsArg, reviewTag, testCommand] = process.argv.slice(2);
const source = parseSourceBranch(branch);
if (!source) fail(`branch must be task/<change>/<task-id>[-aN] or pod/<change>: ${branch}`);

const currentBranch = git(['branch', '--show-current']);
if (currentBranch !== `integration/${source.change}`) {
  fail(`current branch must be integration/${source.change}, got ${currentBranch || '(detached HEAD)'}`);
}

const dirty = git(['status', '--porcelain']);
if (dirty !== '') fail(`working tree is not clean before merge:\n${dirty}`);

const preMergeHead = git(['rev-parse', 'HEAD']);
const tip = git(['rev-parse', '--verify', `${branch}^{commit}`]);
const tip7 = tip.slice(0, 7);

const reviewMatch = reviewTag.match(/^pass\((mechanical|[0-9a-f]{8})@([0-9a-f]{7})\/([0-9a-f]{7})\)$/);
if (!reviewMatch) fail(`malformed review tag: ${reviewTag}`);
const [, reviewer, reviewedTip7, reviewedBase7] = reviewMatch;
if (reviewedTip7 !== tip7) {
  fail(`review tip mismatch: tag=${reviewedTip7} branch=${tip7}`);
}

const reviewedBase = gitMaybe(['rev-parse', '--verify', `${reviewedBase7}^{commit}`]);
if (reviewedBase.error) {
  fail(`git rev-parse could not start: ${reviewedBase.error.message}`);
}
if (reviewedBase.status !== 0) {
  fail(`review base does not resolve to a commit: ${reviewedBase7}\n${reviewedBase.stderr}`);
}
const reviewedBaseSha = reviewedBase.stdout.trim();

const changeDir = path.join('openspec', 'changes', source.change);
const tasksFile = path.join(changeDir, 'tasks.md');
const logFile = path.join(changeDir, 'run-log.md');
if (!fs.existsSync(tasksFile)) fail(`missing tasks ledger: ${tasksFile}`);

const taskIds = taskIdsArg.split(',').map((id) => id.trim());
if (taskIds.length === 0 || taskIds.some((id) => id === '')) fail('task IDs must be a non-empty comma-separated list');
if (new Set(taskIds).size !== taskIds.length) fail(`duplicate task IDs requested: ${taskIdsArg}`);
if (source.taskId !== null && (taskIds.length !== 1 || taskIds[0] !== source.taskId)) {
  fail(`task branch ${branch} may merge only exact task ID ${source.taskId}`);
}

const parsed = parseTasks(fs.readFileSync(tasksFile, 'utf8'));
if (parsed.errors.length > 0) {
  fail(`invalid tasks ledger:\n${parsed.errors.map((error) => `${error.code}: ${error.message}`).join('\n')}`);
}

const tasksById = new Map(parsed.tasks.map((task) => [task.id, task]));
const requestedTasks = taskIds.map((id) => {
  const task = tasksById.get(id);
  if (!task) fail(`unknown task ID: ${id}`);
  if (task.done) fail(`task is already Done: ${id}`);
  return task;
});

if (reviewer === 'mechanical' && requestedTasks.some((task) => task.review !== 'mechanical')) {
  fail('mechanical review requires Review: mechanical on every requested task');
}

let drifted = false;
if (reviewedBaseSha !== preMergeHead) {
  const integrationFiles = new Set(changedFiles(reviewedBaseSha, preMergeHead));
  const overlap = changedFiles(reviewedBaseSha, tip).filter((file) => integrationFiles.has(file));
  if (overlap.length > 0) {
    fail(`baseline drift overlaps branch changes; re-review required: ${overlap.join(', ')}`);
  }
  drifted = true;
}

const merge = gitMaybe(['merge', '--no-ff', '--no-commit', branch]);
if (merge.error) {
  console.error(`[merge-task] Error: git merge could not start: ${merge.error.message}`);
  abortMerge();
  process.exit(10);
}
if (merge.status !== 0) {
  console.error(`[merge-task] Error: git merge failed (${merge.status})\n${merge.stdout}${merge.stderr}`);
  abortMerge();
  process.exit(10);
}

const startedAt = Date.now();
const test = spawnSync(testCommand, { shell: true, stdio: 'inherit' });
if (test.error) {
  console.error(`[merge-task] Error: test command could not start: ${test.error.message}`);
  abortMerge();
  process.exit(20);
}
if (test.status !== 0 || test.signal !== null) {
  console.error(`[merge-task] Error: test command failed: ${testCommand}`);
  abortMerge();
  process.exit(20);
}
const testDuration = Date.now() - startedAt;

try {
  markTasksDone(tasksFile, requestedTasks, tip7, reviewTag);
  const driftNote = drifted ? ` baseline-drift=${reviewedBase7}..${preMergeHead.slice(0, 7)}` : '';
  appendRunLog(
    logFile,
    `- ${new Date().toISOString()} merge tasks=${taskIds.join(',')} branch=${branch} source=${tip} review=${reviewTag} test_cmd=${JSON.stringify(testCommand)} test_duration=${testDuration}ms${driftNote}`
  );
  git(['add', tasksFile, logFile]);
  git([
    'commit',
    '-m',
    `merge(${taskIds.join(',')}): ${branch}`,
    '-m',
    `Pipeline-Task: ${taskIds.join(',')}\nPipeline-Source: ${tip}`,
  ]);
} catch (error) {
  console.error(`[merge-task] Error: ${error.stack || error.message}`);
  abortMerge();
  process.exit(1);
}

const mergeSha = git(['rev-parse', 'HEAD']);
console.log(`[merge-task] Success: tasks=${taskIds.join(',')} branch=${branch} source=${tip} merge=${mergeSha} test_duration=${testDuration}ms`);
