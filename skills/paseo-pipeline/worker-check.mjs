#!/usr/bin/env node
// Worker pre-delivery self-check: catches scope violations (exit 30), broken trailers (exit 31),
// ceshi Red-test tampering (exit 38), and Verify failures (exit 20/36) inside the worker's worktree
// BEFORE handing back to the main session for merge-task.
import fs from 'node:fs';
import path from 'node:path';
import { parseTasks, isFileWithinScopes, taskErrorsFor, graphErrors } from './lib/tasks.mjs';
import { runGit } from './lib/git.mjs';
import { WRITER_ROLES } from './lib/roles.mjs';
import { runVerifyCommand } from './lib/verify-runner.mjs';
import { parseOptions } from './lib/cli.mjs';

const usage = 'Usage: worker-check.mjs <change-dir> <task-id> [--timeout ms] [--allow-test-infra]';

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
  if (res.status !== 0) {
    console.error(`[worker-check] git ${args.join(' ')} failed: ${res.stderr}`);
    process.exit(1);
  }
  return res.stdout.trim();
}

if (git(['status', '--porcelain=v1', '--untracked-files=all'])) {
  console.error('[worker-check] worktree has uncommitted changes; commit your work first');
  process.exit(1);
}

const tasksFile = path.join(changeDir, 'tasks.md');
if (!fs.existsSync(tasksFile)) {
  console.error(`[worker-check] missing ${tasksFile}`);
  process.exit(1);
}
const parsed = parseTasks(fs.readFileSync(tasksFile, 'utf8'));
if (graphErrors(parsed.errors).length) {
  console.error('[worker-check] invalid tasks graph');
  process.exit(1);
}
const task = parsed.tasks.find((item) => item.id === taskId);
if (!task) {
  console.error(`[worker-check] unknown task ${taskId}`);
  process.exit(1);
}
if (taskErrorsFor(parsed.errors, taskId).length) {
  console.error(`[worker-check] invalid task ${taskId}`);
  process.exit(1);
}

const integrationRef = `refs/heads/integration/${change}`;
const hasIntegration = runGit(process.cwd(), ['rev-parse', '--verify', '--quiet', integrationRef]).status === 0;
const base = hasIntegration
  ? git(['merge-base', integrationRef, 'HEAD'])
  : git(['rev-list', '--max-parents=0', 'HEAD']).split('\n')[0];
const tip = git(['rev-parse', 'HEAD']);

const changedRes = runGit(process.cwd(), ['diff', '--name-only', '-z', '--no-renames', `${base}..${tip}`]);
const changedFiles = (changedRes.stdout || '').split('\0').filter(Boolean);
for (const file of changedFiles) {
  if (!isFileWithinScopes(file, task.scope)) {
    console.error(`[worker-check] SCOPE_VIOLATION: ${file} is outside ${taskId} Write scope`);
    process.exit(30);
  }
}

const commits = git(['rev-list', '--reverse', `${base}..${tip}`]).split(/\r?\n/).filter(Boolean);
if (!commits.length) {
  console.error('[worker-check] no commits ahead of integration base');
  process.exit(31);
}

const ceshiFiles = new Set();
for (const commit of commits) {
  const roles = git(['show', '-s', '--format=%(trailers:key=Pipeline-Role,valueonly)', commit]).split(/\r?\n/).map((x) => x.trim().toLowerCase()).filter(Boolean);
  const authors = git(['show', '-s', '--format=%(trailers:key=Pipeline-Author,valueonly)', commit]).split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  if (!roles.length || roles.some((role) => !WRITER_ROLES.has(role)) || !authors.length) {
    console.error(`[worker-check] PROVENANCE_ERROR: ${commit.slice(0, 7)} lacks valid Pipeline-Role / Pipeline-Author trailers`);
    process.exit(31);
  }
  const filesRes = runGit(process.cwd(), ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', commit]);
  const commitFiles = (filesRes.stdout || '').split('\0').filter(Boolean);
  if (roles.includes('ceshi')) {
    commitFiles.forEach((f) => ceshiFiles.add(f));
  } else if (!parsedArgs.options['allow-test-infra']) {
    const tampered = commitFiles.filter((f) => ceshiFiles.has(f));
    if (tampered.length) {
      console.error(`[worker-check] TEST_ORACLE_TAMPERING: ${commit.slice(0, 7)} modified ceshi-authored Red test file(s): ${tampered.join(', ')}`);
      process.exit(38);
    }
  }
}

const verify = await runVerifyCommand(task.verify, { cwd: process.cwd(), timeout, streamToStdout: true });
if (!verify.ok) {
  if (verify.missingMessage) {
    console.error(`[worker-check] MISSING_DEPS: ${verify.missingMessage}`);
    process.exit(36);
  }
  console.error(`[worker-check] VERIFY_FAILED: ${task.verify}${verify.dirtyChanged ? ' (modified worktree)' : ''}`);
  process.exit(20);
}

console.log(`[worker-check] PASS ${taskId} tip=${tip.slice(0, 7)} files=${changedFiles.length} durationMs=${verify.durationMs}`);
