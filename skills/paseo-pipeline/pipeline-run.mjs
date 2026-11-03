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
//   pipeline-run.mjs install-hook <worktree> [<worktree>...]
//
// `merge` must run inside the integration worktree (`integration/<change>`).
// Exit: plan/status 0 ok, 3 unreadable state; merge forwards merge-task's exit code.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseTasks } from './lib/tasks.mjs';
import { runGit } from './lib/git.mjs';

const HOME = path.dirname(fileURLToPath(import.meta.url));
const [command, ...rest] = process.argv.slice(2);
const options = rest.filter((arg) => arg.startsWith('--'));
const positional = rest.filter((arg) => !arg.startsWith('--'));

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

if (command === 'plan') {
  const dir = changeDirOf(positional[0]);
  for (const warning of hookWarnings(path.basename(dir))) console.error(`[pipeline-run] ${warning}`);
  const result = spawnSync(process.execPath, [path.join(HOME, 'next-actions.mjs'), dir, ...options], {
    encoding: 'utf8',
    stdio: 'inherit',
  });
  process.exit(result.status ?? 1);
} else if (command === 'install-hook') {
  // One command per workspace instead of two raw git invocations; idempotent.
  const targets = positional.length ? positional.map((item) => path.resolve(item)) : [process.cwd()];
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
  const dir = changeDirOf(positional[0]);
  const taskId = positional[1];
  if (!taskId) die('merge needs <task-id>', 2);
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
  const result = spawnSync(process.execPath, [path.join(HOME, 'merge-task.mjs'), branch, taskId, ...options], {
    encoding: 'utf8',
    stdio: 'inherit',
  });
  process.exit(result.status ?? 1);
} else if (command === 'status') {
  const dir = changeDirOf(positional[0]);
  const change = path.basename(dir);
  const { tasks } = parseTasks(fs.readFileSync(path.join(dir, 'tasks.md'), 'utf8'));
  const done = tasks.filter((task) => task.done);
  const head = runGit(undefined, ['rev-parse', '--verify', '--quiet', `refs/heads/integration/${change}`]);
  const headSha = head.status === 0 ? head.stdout.trim() : null;
  if (options.includes('--json')) {
    console.log(JSON.stringify({
      change,
      integrationHead: headSha,
      done: done.map((task) => task.id),
      open: tasks.filter((task) => !task.done).map((task) => task.id),
    }, null, 2));
  } else {
    console.log(`${change}${headSha ? ` @ ${headSha.slice(0, 7)}` : ' (no integration branch)'}`);
    console.log(`done ${done.length}/${tasks.length}: ${done.map((task) => task.id).join(', ') || 'none'}`);
    for (const task of tasks.filter((item) => !item.done)) console.log(`OPEN ${task.id}: ${task.title}`);
  }
} else {
  die('usage: pipeline-run.mjs plan|merge|status <change-dir> ...', 2);
}
