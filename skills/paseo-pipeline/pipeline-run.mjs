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

if (command === 'plan') {
  const dir = changeDirOf(positional[0]);
  const result = spawnSync(process.execPath, [path.join(HOME, 'next-actions.mjs'), dir, ...options], {
    encoding: 'utf8',
    stdio: 'inherit',
  });
  process.exit(result.status ?? 1);
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
