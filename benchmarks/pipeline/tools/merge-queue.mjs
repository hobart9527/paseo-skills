#!/usr/bin/env node
// Speculative merge queue: predicts which task branches merge cleanly, in what
// order, without touching the integration worktree. `merge-task` stays the only
// writer; this only saves the main session from discovering a conflict after a serial
// merge attempt has already held the integration branch.
//
// It chains `git merge-tree --write-tree` through synthetic commits (unreachable
// objects, cleaned by the normal gc) so conflict prediction matches what the real
// merge would hit, including conflicts introduced by earlier queued merges.
//
// Usage: merge-queue.mjs <change-dir> [T-id ...] [--json] [--base <ref>]
// Exit: 0 every candidate merges cleanly; 1 at least one conflict; 2 usage; 3 git unreadable.

import fs from 'node:fs';
import path from 'node:path';
import { parseTasks } from '../../../skills/paseo-pipeline/lib/tasks.mjs';
import { mergeDeps } from '../../../skills/paseo-pipeline/lib/schedule.mjs';
import { runGit } from '../../../skills/paseo-pipeline/lib/git.mjs';
import { argValue, positionalArgs } from '../../../skills/paseo-pipeline/lib/cli.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const baseOption = argValue(args, 'base') ?? undefined;
const positional = positionalArgs(args, ['base']);
if (!positional.length) {
  console.error('Usage: merge-queue.mjs <change-dir> [T-id ...] [--json] [--base <ref>]');
  process.exit(2);
}
const changeDir = path.resolve(positional[0]);
const change = path.basename(changeDir);
const only = new Set(positional.slice(1));

// Run git from the canonical toplevel: on macOS /tmp is a symlink, and merge-tree
// prints conflict paths relative to the cwd (../../../src/...) when given a
// non-canonical subdirectory.
const top = runGit(changeDir, ['rev-parse', '--show-toplevel']);
if (top.status !== 0) { console.error('[merge-queue] not a git repository'); process.exit(3); }
const root = top.stdout.trim();

function git(gitArgs, input) {
  const result = runGit(root, gitArgs, { input });
  if (result.error || result.status !== 0) {
    const detail = (result.stderr || result.error?.message || '').trim();
    const error = new Error(`git ${gitArgs.join(' ')} failed${detail ? `: ${detail}` : ''}`);
    error.code = 'GIT';
    throw error;
  }
  return result.stdout;
}
function gitMaybe(gitArgs) {
  return runGit(root, gitArgs);
}

let markdown;
try { markdown = fs.readFileSync(path.join(changeDir, 'tasks.md'), 'utf8'); } catch {
  console.error(`[merge-queue] cannot read ${path.join(changeDir, 'tasks.md')}`);
  process.exit(3);
}
const { tasks } = parseTasks(markdown);
const done = new Set(tasks.filter((task) => task.done).map((task) => task.id));

let baseRef = baseOption || `integration/${change}`;
if (gitMaybe(['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`]).status !== 0) {
  if (baseOption) { console.error(`[merge-queue] --base ${baseRef} does not resolve`); process.exit(3); }
  baseRef = 'HEAD';
  if (gitMaybe(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).status !== 0) {
    console.error('[merge-queue] neither the integration branch nor HEAD resolves');
    process.exit(3);
  }
}
let base;
try { base = git(['rev-parse', '--verify', `${baseRef}^{commit}`]).trim(); } catch (error) { console.error(`[merge-queue] ${error.message}`); process.exit(3); }

// Highest attempt per task: `T-02` first, then `T-02-a2`, `-a3`.
const refs = git(['for-each-ref', '--format=%(refname:short)', `refs/heads/task/${change}/`])
  .split('\n').map((line) => line.trim()).filter(Boolean);
const candidates = new Map();
for (const ref of refs) {
  const match = ref.slice(`task/${change}/`.length).match(/^([A-Za-z][A-Za-z0-9]*-\d+)(?:-a(\d+))?$/);
  if (!match) continue;
  const [, id, attemptRaw] = match;
  const attempt = attemptRaw ? Number(attemptRaw) : 1;
  if (!tasks.some((task) => task.id === id) || done.has(id)) continue;
  if (only.size && !only.has(id)) continue;
  const current = candidates.get(id);
  if (!current || attempt > current.attempt) candidates.set(id, { id, attempt, ref });
}

// Topological order: a task's merge deps must be Done or ahead of it in the queue.
const order = [];
const pending = new Set(candidates.keys());
const visited = new Set();
function visit(id, trail = new Set()) {
  if (visited.has(id) || !pending.has(id)) return true;
  if (trail.has(id)) return false;
  trail.add(id);
  const task = tasks.find((item) => item.id === id);
  for (const dep of mergeDeps(task ?? { depends: [], uses: [] })) {
    if (done.has(dep) || !pending.has(dep)) continue;
    if (!visit(dep, trail)) return false;
  }
  visited.add(id);
  order.push(id);
  return true;
}
for (const id of [...pending].sort()) visit(id);

const queue = [];
const conflicts = [];
const waiting = [];
let tip = base;
for (const id of order) {
  const candidate = candidates.get(id);
  const task = tasks.find((item) => item.id === id);
  const blockers = mergeDeps(task).filter((dep) => !done.has(dep) && !order.includes(dep));
  if (blockers.length) {
    waiting.push({ task: id, on: blockers.sort() });
    continue;
  }
  // Deps that are queued ahead of this candidate are simulated already merged.
  const simulated = mergeDeps(task).filter((dep) => !done.has(dep) && !queue.some((item) => item.task === dep && item.clean));
  if (simulated.length) {
    waiting.push({ task: id, on: simulated.sort() });
    continue;
  }
  const result = runGit(root, ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', tip, candidate.ref]);
  if (result.error || result.status === null) {
    console.error(`[merge-queue] git merge-tree failed: ${result.error?.message || 'no status'}`);
    process.exit(3);
  }
  // `--no-messages -z`: <tree>\0<path>\0... , nothing else.
  const fields = String(result.stdout || '').split('\0');
  const tree = fields[0]?.trim();
  const files = fields.slice(1).filter(Boolean);
  if (result.status === 0 && tree) {
    // Chain the simulated merge so later candidates see its effect.
    try {
      tip = git(['commit-tree', tree, '-p', tip, '-p', candidate.ref], `merge ${id}\n`).trim();
    } catch (error) { console.error(`[merge-queue] ${error.message}`); process.exit(3); }
    queue.push({ task: id, branch: candidate.ref, clean: true });
  } else {
    conflicts.push({ task: id, branch: candidate.ref, files: [...new Set(files)].sort() });
    queue.push({ task: id, branch: candidate.ref, clean: false });
  }
}

const report = { change, base: baseRef, baseSha: base, order, queue, conflicts, waiting };
if (json) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`[merge-queue] ${change} onto ${baseRef} @ ${base.slice(0, 7)} (advisory; merge-task still writes)`);
  for (const item of queue) console.log(`QUEUE ${item.task} ${item.branch}: ${item.clean ? 'clean' : `conflict in ${item.files.join(', ') || 'unknown path'}`}`);
  for (const item of waiting) console.log(`WAIT ${item.task}: on ${item.on.join(', ')}`);
  if (!queue.length) console.log('nothing to queue');
}
process.exit(conflicts.length ? 1 : 0);
