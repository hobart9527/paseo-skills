#!/usr/bin/env node
// Deterministic driver for a frozen change. The main session is an event router:
// it runs `plan`, executes the printed worker/merge actions, and runs `merge` after
// a worker reports. It never recomputes the frontier by hand and never schedules
// with an LLM (SKILL.md).
//
// Usage:
//   pipeline-run.mjs plan   <change-dir> [--json] [--worker-cap N] [--idle-minutes N]
//   pipeline-run.mjs merge  <change-dir> <task-id> [--timeout=ms] [--allow-attempt-over]
//   pipeline-run.mjs status <change-dir>
//   pipeline-run.mjs cleanup <change-dir> [--json] [--change <name>]
//   pipeline-run.mjs scenarios <change-dir> [--json]
//   pipeline-run.mjs acceptance run|check <change-dir> --evidence <file> ...
//   pipeline-run.mjs install-hook <worktree> [<worktree>...]
//
// `merge` must run inside the integration worktree (`integration/<change>`).
// Exit: plan/status 0 ok, 3 invalid or unreadable state; scenarios 0 ok, 1 unparseable input,
// 2 usage; merge forwards merge-task's exit code.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseTasks } from './lib/tasks.mjs';
import { readTasksMarkdown } from './lib/tasks-source.mjs';
import { runGit } from './lib/git.mjs';
import { parseOptions, planOptions } from './lib/cli.mjs';
import { runCleanup } from './lib/cleanup.mjs';

const HOME = path.dirname(fileURLToPath(import.meta.url));
const [command, ...rest] = process.argv.slice(2);

function die(message, code = 2) {
  console.error(`[pipeline-run] ${message}`);
  process.exit(code);
}

function changeDirOf(arg) {
  const dir = path.resolve(arg || '.');
  if (!fs.existsSync(path.join(dir, 'tasks.md'))) die(`no tasks.md in ${dir}`, 3);
  return dir;
}

const HOOKS_DIR = path.join(HOME, 'hooks', 'git');

// The hook is what stamps Pipeline-Author; without it a worker's commit reaches the merge gate
// with no trailer and exits 31, long after the mistake. Check every worktree this change owns,
// including the integration worktree, where merge-task also runs.
function hookWarnings(change) {
  const listed = runGit(undefined, ['worktree', 'list', '--porcelain']);
  if (listed.status !== 0) return [];
  const worktrees = [];
  let current = null;
  for (const line of listed.stdout.split('\n')) {
    if (line.startsWith('worktree ')) { current = { path: line.slice('worktree '.length) }; worktrees.push(current); }
    else if (current && line.startsWith('branch ')) current.branch = line.slice('branch '.length).replace('refs/heads/', '');
  }
  const warnings = [];
  for (const tree of worktrees) {
    if (!tree.branch) continue;
    if (tree.branch !== `integration/${change}` && !tree.branch.startsWith(`task/${change}/`)) continue;
    const configured = runGit(undefined, ['-C', tree.path, 'config', '--worktree', '--get', 'core.hooksPath']);
    const value = configured.status === 0 ? configured.stdout.trim() : '';
    if (value && path.resolve(value) === path.resolve(HOOKS_DIR)) continue;
    warnings.push(`WARN ${tree.branch} (${tree.path}) has no author hook: run \`node ${path.join(HOME, 'pipeline-run.mjs')} install-hook ${tree.path}\`, or its worker commits will exit 31`);
  }
  return warnings;
}

if (command === 'acceptance') {
  const result = spawnSync(process.execPath, [path.join(HOME, 'acceptance-run.mjs'), ...rest], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
} else if (command === 'plan') {
  let parsed;
  try { parsed = parseOptions(rest, planOptions); } catch (error) { die(error.message); }
  if (parsed.positional.length !== 1) die('plan needs <change-dir>');
  const dir = changeDirOf(parsed.positional[0]);
  for (const warning of hookWarnings(path.basename(dir))) console.error(`[pipeline-run] ${warning}`);
  const result = spawnSync(process.execPath, [path.join(HOME, 'next-actions.mjs'), ...rest], {
    encoding: 'utf8',
    stdio: 'inherit',
  });
  process.exit(result.status ?? 1);
} else if (command === 'install-hook') {
  // One command per workspace instead of two raw git invocations; idempotent.
  let parsed;
  try { parsed = parseOptions(rest, {}); } catch (error) { die(error.message); }
  const targets = parsed.positional.length ? parsed.positional.map((item) => path.resolve(item)) : [process.cwd()];
  let failed = false;
  for (const target of targets) {
    if (!fs.existsSync(target)) die(`no worktree at ${target}`, 3);
    const probe = runGit(target, ['rev-parse', '--is-inside-work-tree']);
    if (probe.status !== 0) die(`not a git worktree: ${target}`, 3);
    const enable = runGit(target, ['config', 'extensions.worktreeConfig', 'true']);
    if (enable.status !== 0) { console.error(`[pipeline-run] cannot enable worktreeConfig in ${target}: ${enable.stderr.trim()}`); failed = true; continue; }
    const set = runGit(target, ['config', '--worktree', 'core.hooksPath', HOOKS_DIR]);
    if (set.status !== 0) { console.error(`[pipeline-run] cannot set core.hooksPath in ${target}: ${set.stderr.trim()}`); failed = true; continue; }
    console.log(`hook installed: ${target}`);
  }
  process.exit(failed ? 1 : 0);
} else if (command === 'merge') {
  let parsed;
  try { parsed = parseOptions(rest, { timeout: 'value', 'allow-attempt-over': 'boolean', 'allow-test-infra': 'boolean' }); } catch (error) { die(error.message); }
  if (parsed.positional.length !== 2) die('merge needs <change-dir> <task-id>');
  const dir = changeDirOf(parsed.positional[0]);
  const taskId = parsed.positional[1];
  const mergeOptions = [];
  if (parsed.options.timeout !== undefined) mergeOptions.push(`--timeout=${parsed.options.timeout}`);
  if (parsed.options['allow-attempt-over']) mergeOptions.push('--allow-attempt-over');
  if (parsed.options['allow-test-infra']) mergeOptions.push('--allow-test-infra');
  const change = path.basename(dir);
  const refs = runGit(undefined, ['for-each-ref', '--format=%(refname:short)', `refs/heads/task/${change}/`]).stdout
    .split('\n').map((line) => line.trim()).filter(Boolean);
  const candidates = refs
    .filter((ref) => ref === `task/${change}/${taskId}` || ref.startsWith(`task/${change}/${taskId}-a`))
    .sort((a, b) => {
      const attempt = (ref) => Number(ref.match(/-a(\d+)$/)?.[1] ?? 1);
      return attempt(a) - attempt(b);
    });
  const branch = candidates.at(-1);
  if (!branch) die(`no branch for ${taskId} under task/${change}/`, 3);
  const result = spawnSync(process.execPath, [path.join(HOME, 'merge-task.mjs'), branch, taskId, ...mergeOptions], {
    encoding: 'utf8',
    stdio: 'inherit',
  });
  process.exit(result.status ?? 1);
} else if (command === 'cleanup') {
  process.exit(runCleanup(rest));
} else if (command === 'scenarios') {
  // Read-only derivation: it reads the change directory once and prints relations. It is a
  // separate process so it cannot even import the scheduler; the child's exit code is the answer.
  const result = spawnSync(process.execPath, [path.join(HOME, 'scenarios.mjs'), ...rest], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
} else if (command === 'status') {
  let parsed;
  try { parsed = parseOptions(rest, { json: 'boolean' }); } catch (error) { die(error.message); }
  if (parsed.positional.length > 1) die('status accepts one <change-dir>');
  const dir = changeDirOf(parsed.positional[0]);
  const change = path.basename(dir);
  // Done state is written on the integration branch; never report the stale local copy.
  let markdown;
  let tasksSource;
  try { ({ markdown, source: tasksSource } = readTasksMarkdown(dir, change)); }
  catch (error) { die(`cannot read tasks.md: ${error.message}`, 3); }
  const { tasks, errors } = parseTasks(markdown);
  if (!tasks.length) errors.push({ code: 'EMPTY_TASKS', message: 'tasks.md parsed to zero tasks' });
  if (errors.length) die(`invalid tasks.md (${tasksSource}):\n${errors.map((error) => `${error.code}${error.task ? ` ${error.task}` : ''}: ${error.message}`).join('\n')}`, 3);
  const done = tasks.filter((task) => task.done);
  const head = runGit(undefined, ['rev-parse', '--verify', '--quiet', `refs/heads/integration/${change}`]);
  const headSha = head.status === 0 ? head.stdout.trim() : null;
  if (parsed.options.json) {
    console.log(JSON.stringify({
      change,
      integrationHead: headSha,
      tasksSource,
      done: done.map((task) => task.id),
      open: tasks.filter((task) => !task.done).map((task) => task.id),
    }, null, 2));
  } else {
    console.log(`${change}${headSha ? ` @ ${headSha.slice(0, 7)}` : ''} (tasks: ${tasksSource})`);
    console.log(`done ${done.length}/${tasks.length}: ${done.map((task) => task.id).join(', ') || 'none'}`);
    for (const task of tasks.filter((item) => !item.done)) console.log(`OPEN ${task.id}: ${task.title}`);
  }
} else {
  die('usage: pipeline-run.mjs plan|merge|status|cleanup|scenarios|acceptance <change-dir> ...', 2);
}
