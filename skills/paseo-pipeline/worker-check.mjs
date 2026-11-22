#!/usr/bin/env node
// Worker pre-delivery self-check: catches scope violations (exit 30), broken trailers (exit 31),
// ceshi Red-test tampering (exit 38), and Verify failures (exit 20/36) inside the worker's worktree
// BEFORE handing back to the main session for merge-task.
import fs from 'node:fs';
import path from 'node:path';
import { parseTasks, isFileWithinScopes, taskErrorsFor, graphErrors, auditTestInfra } from './lib/tasks.mjs';
import { runGit } from './lib/git.mjs';
import { WRITER_ROLES } from './lib/roles.mjs';
import { runVerifyCommand } from './lib/verify-runner.mjs';
import { parseOptions } from './lib/cli.mjs';
import { recordEvent } from './lib/telemetry.mjs';

const usage = 'Usage: worker-check.mjs <change-dir> <task-id> [--timeout ms] [--allow-test-infra]';

function fail(message, code = 1, reasonCode = 'check_failed') {
  console.error(message);
  recordEvent('worker_check', { ok: false, exit: code, reasonCode });
  process.exit(code);
}

let parsedArgs;
try {
  parsedArgs = parseOptions(process.argv.slice(2), { timeout: 'value', 'allow-test-infra': 'boolean' });
} catch (error) {
  console.error(`[worker-check] ${error.message}\n${usage}`);
  process.exit(2);
}

const [changeDirArg, taskId] = parsedArgs.positional;
if (!changeDirArg || !taskId || parsedArgs.positional.length > 2) {
  console.error(usage);
  process.exit(2);
}

const timeout = Number(parsedArgs.options.timeout ?? '1800000');
const changeDir = path.resolve(changeDirArg);
const change = path.basename(changeDir);

function git(args) {
  const res = runGit(process.cwd(), args);
  if (res.status !== 0) fail(`[worker-check] git ${args.join(' ')} failed: ${res.stderr}`, 1, 'git_error');
  return res.stdout.trim();
}

if (git(['status', '--porcelain=v1', '--untracked-files=all'])) {
  fail('[worker-check] worktree has uncommitted changes; commit your work first', 1, 'dirty_worktree');
}

const tasksFile = path.join(changeDir, 'tasks.md');
if (!fs.existsSync(tasksFile)) fail(`[worker-check] missing ${tasksFile}`, 1, 'missing_tasks');
const parsed = parseTasks(fs.readFileSync(tasksFile, 'utf8'));
if (graphErrors(parsed.errors).length) fail('[worker-check] invalid tasks graph', 1, 'invalid_graph');
const task = parsed.tasks.find((item) => item.id === taskId);
if (!task) fail(`[worker-check] unknown task ${taskId}`, 1, 'unknown_task');
if (taskErrorsFor(parsed.errors, taskId).length) fail(`[worker-check] invalid task ${taskId}`, 1, 'invalid_task');

const integrationRef = `refs/heads/integration/${change}`;
const hasIntegration = runGit(process.cwd(), ['rev-parse', '--verify', '--quiet', integrationRef]).status === 0;
const defaultBranch = ['main', 'master'].find(
  (name) => runGit(process.cwd(), ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]).status === 0,
);
let base = null;
if (hasIntegration) {
  base = git(['merge-base', integrationRef, 'HEAD']);
} else if (defaultBranch) {
  const mb = runGit(process.cwd(), ['merge-base', defaultBranch, 'HEAD']);
  if (mb.status === 0 && mb.stdout.trim()) base = mb.stdout.trim();
}
if (!base) base = git(['rev-list', '--max-parents=0', 'HEAD']).split('\n')[0];
const tip = git(['rev-parse', 'HEAD']);

const changedRes = runGit(process.cwd(), ['diff', '--name-only', '-z', '--no-renames', `${base}..${tip}`]);
const changedFiles = (changedRes.stdout || '').split('\0').filter(Boolean);
const testInfra = auditTestInfra(changedFiles);
if (testInfra.length && !parsedArgs.options['allow-test-infra']) {
  fail(`[worker-check] TEST_ORACLE_TAMPERING: test infrastructure changes require human approval (--allow-test-infra): ${testInfra.join(', ')}`, 38, 'oracle_tampering');
}
for (const file of changedFiles) {
  if (!isFileWithinScopes(file, task.scope)) {
    fail(`[worker-check] SCOPE_VIOLATION: ${file} is outside ${taskId} Write scope`, 30, 'scope_violation');
  }
}
if (defaultBranch) {
  const driftDiff = runGit(process.cwd(), ['diff', '--no-renames', '--name-only', '-z', `${base}...${defaultBranch}`]);
  if (driftDiff.status === 0) {
    const mainFiles = (driftDiff.stdout || '').split('\0').filter(Boolean);
    const clash = mainFiles.filter((file) => isFileWithinScopes(file, task.scope) || changedFiles.includes(file));
    if (clash.length) {
      fail(`[worker-check] BASE_DRIFT: ${defaultBranch} advanced on task scope (${clash.join(', ')}); sync base and re-verify`, 34, 'base_drift');
    }
  }
}

const commits = git(['rev-list', '--reverse', `${base}..${tip}`]).split(/\r?\n/).filter(Boolean);
if (!commits.length) fail('[worker-check] no commits ahead of integration base', 31, 'no_commits');

const ceshiFiles = new Set();
for (const commit of commits) {
  const roles = git(['show', '-s', '--format=%(trailers:key=Pipeline-Role,valueonly)', commit]).split(/\r?\n/).map((x) => x.trim().toLowerCase()).filter(Boolean);
  const authors = git(['show', '-s', '--format=%(trailers:key=Pipeline-Author,valueonly)', commit]).split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  if (!roles.length || roles.some((role) => !WRITER_ROLES.has(role)) || !authors.length) {
    fail(`[worker-check] PROVENANCE_ERROR: ${commit.slice(0, 7)} lacks valid Pipeline-Role / Pipeline-Author trailers`, 31, 'provenance_error');
  }
  const filesRes = runGit(process.cwd(), ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', commit]);
  const commitFiles = (filesRes.stdout || '').split('\0').filter(Boolean);
  if (roles.includes('ceshi')) {
    commitFiles.forEach((f) => ceshiFiles.add(f));
  } else if (!parsedArgs.options['allow-test-infra']) {
    const tampered = commitFiles.filter((f) => ceshiFiles.has(f));
    if (tampered.length) {
      fail(`[worker-check] TEST_ORACLE_TAMPERING: ${commit.slice(0, 7)} modified ceshi-authored Red test file(s): ${tampered.join(', ')}`, 38, 'oracle_tampering');
    }
  }
}

const verify = await runVerifyCommand(task.verify, { cwd: process.cwd(), timeout, streamToStdout: true });
if (!verify.ok) {
  if (verify.missingMessage) {
    fail(`[worker-check] MISSING_DEPS: ${verify.missingMessage}`, 36, 'missing_deps');
  }
  fail(`[worker-check] VERIFY_FAILED: ${task.verify}${verify.dirtyChanged ? ' (modified worktree)' : ''}`, 20, 'verify_failed');
}

recordEvent('worker_check', { ok: true, exit: 0, durationMs: verify.durationMs, count: changedFiles.length });
console.log(`[worker-check] PASS ${taskId} tip=${tip.slice(0, 7)} files=${changedFiles.length} durationMs=${verify.durationMs}`);
