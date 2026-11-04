#!/usr/bin/env node
// Pre-merge integration rehearsal.
//
// In the task worktree: merge the integration branch with --no-commit --no-ff, run
// the frozen Verify, then always abort the merge. The worktree is left exactly as it
// was found, so a failed rehearsal costs nothing and reveals the conflict before the
// main session discovers it at merge time.
//
// Exit: 0 no conflicts and Verify passed; 2 conflicts; 3 Verify failed; 4 environment
// fault (missing dependency, not a task failure); 1 setup/usage error.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseTasks } from '../../../skills/paseo-pipeline/lib/tasks.mjs';
import { missingDependency, dependencyMessage } from '../../../skills/paseo-pipeline/lib/toolchain.mjs';
import { runGit } from '../../../skills/paseo-pipeline/lib/git.mjs';
import { argValue, positionalArgs } from '../../../skills/paseo-pipeline/lib/cli.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const verifyFromArg = argValue(args, 'verify');
if (args.includes('--verify') && !verifyFromArg) {
  console.error('Usage: sync-check.mjs <task-worktree> <integration-branch> [--json] [--verify "<cmd>"]');
  process.exit(2);
}
const positional = positionalArgs(args, ['verify']);
const [worktreeArg, integrationBranch] = positional;
if (!worktreeArg || !integrationBranch || positional.length !== 2) {
  console.error('Usage: sync-check.mjs <task-worktree> <integration-branch> [--json] [--verify "<cmd>"]');
  process.exit(2);
}
const worktree = path.resolve(worktreeArg);
if (!fs.existsSync(worktree) || !fs.statSync(worktree).isDirectory()) {
  console.error(`[sync-check] worktree not found: ${worktree}`);
  process.exit(1);
}

function git(gitArgs, { allowFailure = false } = {}) {
  const result = runGit(worktree, gitArgs);
  if (result.error) {
    if (allowFailure) return result;
    throw new Error(`git ${gitArgs.join(' ')} failed: ${result.error.message}`);
  }
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`git ${gitArgs.join(' ')} failed\n${result.stdout}${result.stderr}`);
  }
  return result;
}
const gitOut = (gitArgs) => git(gitArgs).stdout.trim();

function fail(message, code = 1, extra = {}) {
  if (json) console.log(JSON.stringify({ ok: false, error: message, ...extra }, null, 2));
  else console.error(`[sync-check] ${message}`);
  process.exit(code);
}

if (git(['rev-parse', '--is-inside-work-tree'], { allowFailure: true }).status !== 0) {
  fail(`not a git worktree: ${worktree}`, 1);
}
const branch = gitOut(['branch', '--show-current']);
const status = gitOut(['status', '--porcelain']);
if (status !== '') fail(`worktree is dirty; commit or discard changes before rehearsing:\n${status}`, 1);
if (git(['rev-parse', '--verify', '--quiet', `${integrationBranch}^{commit}`], { allowFailure: true }).status !== 0) {
  fail(`unknown integration branch: ${integrationBranch}`, 1);
}
if (branch === integrationBranch) fail(`worktree is already on ${integrationBranch}; run in the task worktree`, 1);

// Verify command: argument first, then the frozen `Verify with` for this task.
function parsedVerify() {
  const match = branch.match(/^task\/([^/]+)\/([A-Za-z][A-Za-z0-9]*-\d+)(?:-a\d+)?$/);
  if (!match) return null;
  const tasksFile = path.join(worktree, 'openspec', 'changes', match[1], 'tasks.md');
  let markdown;
  try { markdown = fs.readFileSync(tasksFile, 'utf8'); } catch { return null; }
  const task = parseTasks(markdown).tasks.find((item) => item.id === match[2]);
  return task?.verify || null;
}
const verifyCommand = verifyFromArg || parsedVerify();
if (!verifyCommand) {
  fail('no Verify command: pass --verify "<cmd>" or run from a task/<change>/<T-id> branch whose tasks.md declares Verify with', 2);
}

const headBefore = gitOut(['rev-parse', 'HEAD']);

// The merge is always aborted below, including on exceptions.
let mergeResult = null;
let verify = { status: 'skipped', outputTail: '' };
let conflicts = [];
try {
  mergeResult = git(['merge', '--no-commit', '--no-ff', integrationBranch], { allowFailure: true });
  conflicts = gitOut(['diff', '--name-only', '--diff-filter=U']).split(/\r?\n/).filter(Boolean);

  if (conflicts.length === 0 && mergeResult.status !== 0) {
    const output = `${mergeResult.stdout || ''}${mergeResult.stderr || ''}`;
    verify = { status: 'error', outputTail: tail(output) };
  } else {
    const result = spawnSync('sh', ['-c', verifyCommand], {
      cwd: worktree,
      encoding: 'utf8',
      timeout: 30 * 60 * 1000,
    });
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    if (result.status === 0) {
      verify = { status: 'passed', outputTail: tail(output) };
    } else {
      const missing = missingDependency(output, worktree);
      verify = missing
        ? { status: 'environment', dependency: missing, outputTail: tail(`${dependencyMessage(missing, worktree)}\n${output}`) }
        : { status: 'failed', outputTail: tail(output) };
    }
  }
} finally {
  // Never leave the worktree merged or dirty.
  const mergeHead = git(['rev-parse', '--git-path', 'MERGE_HEAD'], { allowFailure: true });
  const mergeHeadPath = mergeHead.status === 0 ? path.resolve(worktree, mergeHead.stdout.trim()) : null;
  if (mergeHeadPath && fs.existsSync(mergeHeadPath)) git(['merge', '--abort'], { allowFailure: true });
  // Defensive: a failed merge can leave the index staged without MERGE_HEAD.
  if (gitOut(['status', '--porcelain']) !== '') {
    git(['reset', '--hard', headBefore], { allowFailure: true });
  }
}

if (gitOut(['status', '--porcelain']) !== '') fail('worktree could not be restored to its pre-merge state', 1);
if (gitOut(['rev-parse', 'HEAD']) !== headBefore) fail('worktree HEAD moved during rehearsal', 1);

const hadConflict = conflicts.length > 0;
const ok = !hadConflict && verify.status === 'passed';
const report = { ok, conflicts, verify };
const exitCode = hadConflict ? 2 : verify.status === 'passed' ? 0 : verify.status === 'environment' ? 4 : 3;

if (json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`[sync-check] ${branch} <- ${integrationBranch}`);
  console.log(`conflicts=${conflicts.length}${conflicts.length ? `: ${conflicts.join(', ')}` : ''}`);
  console.log(`verify=${verify.status}`);
  if (verify.outputTail) console.log(verify.outputTail);
  console.log(ok ? 'RESULT sync-check ok' : `RESULT sync-check ${verify.status === 'environment' ? 'environment fault' : 'failed'}`);
}

process.exit(exitCode);

function tail(output) {
  const lines = String(output || '').split(/\r?\n/).filter((line) => line !== '');
  return lines.slice(-40).join('\n');
}
