#!/usr/bin/env node
// Deterministic next-action list for the Lead: one read-only query over git and
// Paseo, no dispatch, no merge, no ledger. The Lead executes the list; if the list
// is lost it recomputes (SKILL.md principle 5).
//
// Usage: next-actions.mjs <change-dir> [--json] [--writer-cap 6] [--reviewer-cap 4]
//                          [--idle-minutes 15]
// Exit: 0 list printed (including "nothing to do"); 2 usage; 3 Git/Paseo unreadable.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseTasks } from './lib/tasks.mjs';
import { frontier } from './lib/frontier.mjs';
import { runGit } from './lib/git.mjs';
import { argValue, positionalArgs } from './lib/cli.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
function option(name, fallback) {
  const raw = argValue(args, name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`[next-actions] --${name} needs a positive number`);
    process.exit(2);
  }
  return value;
}
const positional = positionalArgs(args, ['writer-cap', 'reviewer-cap', 'idle-minutes']);
const changeDir = path.resolve(positional[0] || '.');
const change = path.basename(changeDir);
const options = {
  writerCap: option('writer-cap', 6),
  reviewerCap: option('reviewer-cap', 4),
  idleMinutes: option('idle-minutes', 15),
};

const tasksFile = path.join(changeDir, 'tasks.md');
let markdown;
try { markdown = fs.readFileSync(tasksFile, 'utf8'); } catch {
  console.error(`[next-actions] cannot read ${tasksFile}`);
  process.exit(3);
}
const { tasks } = parseTasks(markdown);
const done = tasks.filter((task) => task.done).map((task) => task.id);

function git(gitArgs, cwd = changeDir) {
  const result = runGit(cwd, gitArgs);
  if (result.error || result.status !== 0) {
    console.error(`[next-actions] git ${gitArgs.join(' ')} failed: ${result.stderr || result.error?.message || ''}`);
    process.exit(3);
  }
  return result.stdout;
}
function gitMaybe(gitArgs) {
  const result = runGit(changeDir, gitArgs);
  return result.status === 0 ? result.stdout.trim() : null;
}
git(['rev-parse', '--is-inside-work-tree']);

// Branch state per task: attempts are `task/<change>/<T-id>` and `<T-id>-aN`; an
// implementation commit carries Pipeline-Role: ceshi|gongbu|gaogong|jiangzuo.
const branches = {};
// The integration branch is the base every task branch starts from: only commits after
// the merge base are this task's own work.
const integrationSha = (() => {
  const head = runGit(changeDir, ['rev-parse', '--verify', '--quiet', `refs/heads/integration/${change}`]);
  return head.status === 0 ? head.stdout.trim() : null;
})();
const refs = git(['for-each-ref', '--format=%(refname:short)', `refs/heads/task/${change}/`])
  .split('\n').map((line) => line.trim()).filter(Boolean);
for (const ref of refs) {
  const id = ref.slice(`task/${change}/`.length).replace(/-a\d+$/, '');
  if (!tasks.some((task) => task.id === id)) continue;
  const entry = branches[id] ?? { attempts: 0, implementationCommits: 0 };
  entry.attempts += 1;
  // Only this attempt's own commits count. Branching from the integration tip carries
  // every earlier merge commit, and those trailers are not this task's work: counting
  // them made a fresh Red-only branch look implemented, so the Lead dispatched a
  // reviewer before the writer and the merge died at exit 31.
  const base = integrationSha ? gitMaybe(['merge-base', integrationSha, `refs/heads/${ref}`]) : null;
  const range = base ? `${base}..refs/heads/${ref}` : `refs/heads/${ref}`;
  const commits = git(['log', '--format=%H%x00%(trailers:key=Pipeline-Role,valueonly)', '--no-merges', range])
    .split('\n').filter(Boolean);
  for (const line of commits) {
    const [, role = ''] = line.split('\0');
    if (role.trim() && role.trim() !== 'ceshi') entry.implementationCommits += 1;
  }
  branches[id] = entry;
}

// Paseo: `ls --json` has no labels, so identity comes from the Lead's naming
// convention `[Pipeline] <role> <T-id> ...` (lead.md). Unknown names are ignored.
const listed = spawnSync('paseo', ['ls', '--json'], { encoding: 'utf8', timeout: 10_000 });
if (listed.error || listed.status !== 0) {
  console.error('[next-actions] cannot read Paseo state (`paseo ls --json`)');
  process.exit(3);
}
let listedAgents;
try { listedAgents = JSON.parse(listed.stdout); } catch {
  console.error('[next-actions] invalid JSON from `paseo ls --json`');
  process.exit(3);
}
const agents = [];
for (const agent of Array.isArray(listedAgents) ? listedAgents : []) {
  const match = String(agent.name || '').match(/\[Pipeline\]\s+(\S+)\s+(?:\S+\s+)?([A-Za-z][A-Za-z0-9]*-\d+)\b/);
  if (!match) continue;
  const [, role, task] = match;
  const detail = spawnSync('paseo', ['inspect', agent.id, '--json'], { encoding: 'utf8', timeout: 10_000 });
  let inspected = null;
  try { inspected = detail.status === 0 ? JSON.parse(detail.stdout) : null; } catch { inspected = null; }
  agents.push({
    id: agent.id,
    role,
    task,
    status: agent.status,
    updatedAt: inspected?.UpdatedAt ?? null,
    pendingPermissions: (inspected?.PendingPermissions ?? []).length > 0,
  });
}

const result = frontier(tasks, { done, branches, agents }, options);
const report = { change, integrationHead: integrationSha, ...result };

if (json) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`[next-actions] ${change}${integrationHead ? ` @ ${integrationHead.slice(0, 7)}` : ''}`);
  console.log(`capacity: writers ${report.capacity.writers.used}/${report.capacity.writers.cap}, reviewers ${report.capacity.reviewers.used}/${report.capacity.reviewers.cap}`);
  for (const item of report.dispatch) console.log(`DISPATCH ${item.task}: ${item.action} — ${item.reason}`);
  for (const item of report.waiting) console.log(`WAIT ${item.task}: on ${item.on.join(', ')}`);
  for (const item of report.mergeWaiting) console.log(`MERGE-WAIT ${item.task}: on ${item.on.join(', ')}`);
  for (const item of report.blocked) console.log(`BLOCKED ${item.task}: ${item.kind} — ${item.reason}`);
  for (const item of report.attention) console.log(`ATTENTION ${item.task || '?'} ${item.agent}: ${item.kind} — ${item.reason}`);
  if (!report.dispatch.length && !report.attention.length) console.log('nothing to dispatch');
}
