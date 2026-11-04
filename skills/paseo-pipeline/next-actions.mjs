#!/usr/bin/env node
// Deterministic next-action list for the main session: one read-only query over git
// and Paseo, no dispatch, no merge, no ledger. The caller executes the list; if the
// list is lost it recomputes (SKILL.md principle 5).
//
// Usage: next-actions.mjs <change-dir> [--json] [--worker-cap 8] [--idle-minutes 15]
// Exit: 0 list printed (including "nothing to do"); 2 usage; 3 Git/Paseo unreadable.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { parseTasks } from './lib/tasks.mjs';
import { frontier } from './lib/frontier.mjs';
import { runGit } from './lib/git.mjs';
import { readMergeState } from './lib/merge-state.mjs';
import { parseOptions, planOptions } from './lib/cli.mjs';

let parsedArgs;
try { parsedArgs = parseOptions(process.argv.slice(2), planOptions); }
catch (error) { console.error(`[next-actions] ${error.message}`); process.exit(2); }
const { positional, options: flags } = parsedArgs;
if (positional.length !== 1) { console.error('[next-actions] needs <change-dir>'); process.exit(2); }
const json = !!flags.json;
function option(name, fallback) {
  const raw = flags[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`[next-actions] --${name} needs a positive number`);
    process.exit(2);
  }
  return value;
}
const extraChanges = flags['other-change'] ?? [];
if (extraChanges.some((value) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value))) {
  console.error('[next-actions] --other-change needs a change ID'); process.exit(2);
}
option('reviewer-cap', 1);
const changeDir = path.resolve(positional[0] || '.');
const change = path.basename(changeDir);
const options = {
  // `--writer-cap` stays accepted as an alias for an older caller.
  workerCap: option('worker-cap', option('writer-cap', 8)),
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
  const entry = branches[id] ?? { attempts: 0, implementationCommits: 0, ownCommits: 0 };
  // Every branch is an attempt, even one with no commits yet: `lead.md` caps a task at 3
  // branches and `merge-task` refuses `-a4`, so counting only non-empty branches would let
  // the breaker drift from both.
  entry.attempts += 1;
  // Only this attempt's own commits count. Branching from the integration tip carries
  // every earlier merge commit, and those trailers are not this task's work: counting
  // them made a fresh Red-only branch look implemented, so the Lead dispatched a
  // reviewer before the writer and the merge died at exit 31.
  const base = integrationSha ? gitMaybe(['merge-base', integrationSha, `refs/heads/${ref}`]) : null;
  const range = base ? `${base}..refs/heads/${ref}` : `refs/heads/${ref}`;
  const commits = git(['log', '--format=%H%x00%(trailers:key=Pipeline-Role,valueonly)', '--no-merges', range])
    .split('\n').filter(Boolean);
  let workerCommits = 0;
  for (const line of commits) {
    const [, role = ''] = line.split('\0');
    // A legacy `ceshi` Red commit is not worker output; a branch holding only that
    // still needs a worker dispatch.
    if (role.trim() && role.trim() !== 'ceshi') workerCommits += 1;
  }
  const attemptNumber = Number(ref.match(/-a(\d+)$/)?.[1] ?? 1);
  const tip = git(['rev-parse', '--verify', `refs/heads/${ref}^{commit}`]).trim();
  branches[id] = {
    latestAttempt: Math.max(entry.latestAttempt || 0, attemptNumber),
    tip: attemptNumber > (entry.latestAttempt || 0) ? tip : entry.tip,
    attempts: entry.attempts,
    implementationCommits: attemptNumber > (entry.latestAttempt || 0) ? workerCommits : entry.implementationCommits,
    ownCommits: attemptNumber > (entry.latestAttempt || 0) ? workerCommits : entry.ownCommits,
  };
}

for (const [id, branch] of Object.entries(branches)) {
  try {
    const state = readMergeState(changeDir, change, id);
    if (state?.tip === branch.tip) branch.mergeFailure = state;
  } catch (error) {
    console.error(`[next-actions] cannot read merge state: ${error.message}`);
    process.exit(3);
  }
}

// Query all workspaces for this change. A malformed identity or unavailable detail is
// not evidence that a task is idle; stop rather than risk a duplicate worker.
const listed = spawnSync('paseo', ['ls', '--global', '--background', '--label', `pipeline.change=${change}`, '--json'], { encoding: 'utf8', timeout: 10_000 });
if (listed.error || listed.status !== 0) {
  console.error('[next-actions] cannot read Paseo state (`paseo ls --json`)');
  process.exit(3);
}
let listedAgents;
try { listedAgents = JSON.parse(listed.stdout); } catch {
  console.error('[next-actions] invalid JSON from `paseo ls --json`');
  process.exit(3);
}
if (!Array.isArray(listedAgents)) {
  console.error('[next-actions] invalid Paseo agent list');
  process.exit(3);
}
const all = spawnSync('paseo', ['ls', '--global', '--background', '--json'], { encoding: 'utf8', timeout: 10_000 });
let allAgents;
try { allAgents = all.status === 0 && !all.error ? JSON.parse(all.stdout) : null; } catch { allAgents = null; }
if (!Array.isArray(allAgents)) {
  console.error('[next-actions] cannot read global Paseo agent list');
  process.exit(3);
}
const labelledIds = new Set(listedAgents.map((agent) => agent?.id));
function commonDir(cwd) {
  if (typeof cwd !== 'string' || !cwd) return null;
  const expanded = cwd === '~' ? os.homedir() : cwd.startsWith('~/') ? path.join(os.homedir(), cwd.slice(2)) : cwd;
  if (!path.isAbsolute(expanded)) return null;
  const result = runGit(expanded, ['rev-parse', '--git-common-dir']);
  if (result.error || result.status !== 0) return null;
  try { return fs.realpathSync(path.resolve(expanded, result.stdout.trim())); } catch { return null; }
}
const repository = commonDir(changeDir);
if (!repository) {
  console.error('[next-actions] cannot identify repository');
  process.exit(3);
}
const otherChanges = new Map();
const integrationRefs = runGit(changeDir, ['for-each-ref', '--format=%(refname:strip=3)', 'refs/heads/integration/']);
if (integrationRefs.error || integrationRefs.status !== 0) {
  console.error('[next-actions] cannot enumerate integration branches');
  process.exit(3);
}
const knownChanges = integrationRefs.stdout.split('\n').filter((item) => item && item !== change);
knownChanges.push(...extraChanges.filter((item) => item !== change));
function changesIn(cwd) {
  if (typeof cwd !== 'string') return [];
  const expanded = cwd === '~' ? os.homedir() : cwd.startsWith('~/') ? path.join(os.homedir(), cwd.slice(2)) : cwd;
  const top = runGit(expanded, ['rev-parse', '--show-toplevel']);
  if (top.error || top.status !== 0) return [];
  try { return fs.readdirSync(path.join(top.stdout.trim(), 'openspec', 'changes'), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name); }
  catch { return []; }
}
function labelledFor(other, id) {
  if (!otherChanges.has(other)) {
    const query = spawnSync('paseo', ['ls', '--global', '--background', '--label', `pipeline.change=${other}`, '--json'], { encoding: 'utf8', timeout: 10_000 });
    let found;
    try { found = query.status === 0 && !query.error ? JSON.parse(query.stdout) : null; } catch { found = null; }
    if (!Array.isArray(found) || found.some((item) => !item || typeof item.id !== 'string')) {
      console.error(`[next-actions] cannot verify other change label: ${other}`);
      process.exit(3);
    }
    otherChanges.set(other, new Set(found.map((item) => item.id)));
  }
  return otherChanges.get(other).has(id);
}
for (const agent of allAgents) {
  if (!agent || typeof agent.id !== 'string' || typeof agent.name !== 'string' || typeof agent.status !== 'string') {
    console.error('[next-actions] invalid global Paseo agent identity or status');
    process.exit(3);
  }
  if (agent.status === 'closed' || labelledIds.has(agent.id)) continue;
  if (!agent.name.startsWith('[Pipeline]') && !/^(gongbu|gaogong|jiangzuo|hanlin|anchasi|chanpin)-/.test(agent.name)) continue;
  const agentRepo = commonDir(agent.cwd);
  if (agentRepo && agentRepo !== repository) continue;
  const identity = agent.name.match(/^\[Pipeline\]\s+\S+\s+\S+\s+(\S+)$/);
  const candidates = new Set([...knownChanges, ...changesIn(agent.cwd).filter((item) => item !== change), ...(identity && identity[1] !== change ? [identity[1]] : [])]);
  if ([...candidates].some((other) => labelledFor(other, agent.id))) continue;
  console.error(`[next-actions] active pipeline agent lacks a matching change label or unambiguous identity: ${agent.id} ${agent.name}. Verify its change label, then pass --other-change <id> to verify that label; otherwise inspect and resolve the agent before planning`);
  process.exit(3);
}
const agents = [];
for (const agent of listedAgents) {
  if (!agent || typeof agent.id !== 'string' || typeof agent.status !== 'string' || typeof agent.name !== 'string') {
    console.error('[next-actions] invalid Paseo agent identity or status');
    process.exit(3);
  }
  const parts = agent.name.match(/^\[Pipeline\]\s+(\S+)\s+(\S+)(?:\s+.*)?$/);
  const match = parts && /^(gongbu|gaogong|jiangzuo)$/.test(parts[1]) && /^[A-Za-z][A-Za-z0-9]*-\d+(?:-a[1-9]\d*)?$/.test(parts[2]) ? parts : null;
  const nonWorker = parts && /^(hanlin|anchasi|gongbu|gaogong|chanpin)$/.test(parts[1]) && /^(R0|FINAL|FULL|SPEC|TASKS)$/.test(parts[2]);
  if (agent.status === 'closed' && !match) continue;
  const agentRepo = commonDir(agent.cwd);
  if (agentRepo && agentRepo !== repository) continue;
  if (!['running', 'initializing', 'idle', 'closed', 'error'].includes(agent.status)) {
    console.error(`[next-actions] unknown Paseo status for ${agent.id}: ${agent.status}`);
    process.exit(3);
  }
  if (!match) {
    // Non-worker pipeline roles must also have unambiguous titles.
    if (agentRepo && nonWorker) continue;
    if (!nonWorker) {
      console.error(`[next-actions] unrecognized pipeline agent title: ${agent.name}. Inspect ${agent.id}; only after confirming its role is non-worker, rename with paseo agent update ${agent.id} --name "[Pipeline] anchasi FINAL" (use its actual role and stage), or stop/close it`);
      process.exit(3);
    }
  }
  if (agent.status === 'closed') {
    agents.push({ id: agent.id, role: match[1], task: match[2].replace(/-a\d+$/, ''), attempt: Number(match[2].match(/-a(\d+)$/)?.[1] ?? 1), status: 'closed' });
    continue;
  }
  const detail = spawnSync('paseo', ['inspect', agent.id, '--json'], { encoding: 'utf8', timeout: 10_000 });
  let inspected;
  try { inspected = detail.status === 0 && !detail.error ? JSON.parse(detail.stdout) : null; } catch { inspected = null; }
  if (!inspected || typeof inspected !== 'object' || Array.isArray(inspected)
    || inspected.Id !== agent.id || inspected.Name !== agent.name || !['running', 'initializing', 'idle', 'closed', 'error'].includes(inspected.Status)
    || !Array.isArray(inspected.PendingPermissions)) {
    console.error(`[next-actions] cannot inspect Paseo agent ${agent.id}`);
    process.exit(3);
  }
  if (!agentRepo && ([agent.status, inspected.Status].some((status) => status === 'running' || status === 'initializing') || inspected.PendingPermissions.length)) {
    console.error(`[next-actions] cannot identify repository for active Paseo agent ${agent.id}`);
    process.exit(3);
  }
  if (nonWorker && !match) continue;
  agents.push({
    id: agent.id, role: match[1], task: match[2].replace(/-a\d+$/, ''),
    attempt: Number(match[2].match(/-a(\d+)$/)?.[1] ?? 1), status: [agent.status, inspected.Status].some((status) => status === 'running' || status === 'initializing') ? 'running' : inspected.Status,
    updatedAt: inspected.UpdatedAt ?? null,
    pendingPermissions: (inspected.PendingPermissions ?? []).length > 0,
  });
}

const result = frontier(tasks, { done, branches, agents }, options);
const report = { change, integrationHead: integrationSha, ...result };

if (json) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`[next-actions] ${change}${report.integrationHead ? ` @ ${report.integrationHead.slice(0, 7)}` : ''}`);
  console.log(`capacity: workers ${report.capacity.workers.used}/${report.capacity.workers.cap}`);
  for (const item of report.dispatch) console.log(`DISPATCH ${item.task}: ${item.action} — ${item.reason}`);
  for (const item of report.waiting) console.log(`WAIT ${item.task}: on ${item.on.join(', ')}`);
  for (const item of report.mergeWaiting) console.log(`MERGE-WAIT ${item.task}: on ${item.on.join(', ')}`);
  for (const item of report.blocked) console.log(`BLOCKED ${item.task}: ${item.kind} — ${item.reason}`);
  for (const item of report.attention) console.log(`ATTENTION ${item.task || '?'} ${item.agent}: ${item.kind} — ${item.reason}`);
  if (!report.dispatch.length && !report.attention.length) console.log('nothing to dispatch');
}
