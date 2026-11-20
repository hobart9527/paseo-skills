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
//   pipeline-run.mjs acceptance run|check|sync <change-dir> ...
//   pipeline-run.mjs prepare-task <change-dir> <task-id> [--worktree-root <dir>] [--json]
//   pipeline-run.mjs cp2-merge <change-dir> [--base main] [--json]
//   pipeline-run.mjs brief <role> --change <name> --repo <path> ...
//   pipeline-run.mjs worker-check <change-dir> <task-id> [--timeout ms] [--allow-test-infra]
//   pipeline-run.mjs tier2-verify <base> [--change-dir <dir>] [--verify <cmd>]... [--auto-verify] [--cwd <dir>] [--json]
//   pipeline-run.mjs risk-scan <base> [<head>] [--cwd <dir>] [--working-tree] [--json] [--require-clean]
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
import { recommendedWorkerRole } from './lib/roles.mjs';

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

function doneVerification(change, tasks, cwd) {
  const head = runGit(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/integration/${change}`]);
  if (head.status !== 0) return [];
  const history = runGit(cwd, ['log', '--first-parent', '--merges', '--format=%H', head.stdout.trim()]);
  if (history.status !== 0) return tasks.filter((task) => task.done).map((task) => ({ task: task.id, kind: 'DONE_UNVERIFIED', reason: 'cannot read integration first-parent history' }));
  const merges = history.stdout.split('\n').filter(Boolean).map((sha) => {
    const task = runGit(cwd, ['show', '-s', '--format=%(trailers:key=Pipeline-Task,valueonly)', sha]);
    const source = runGit(cwd, ['show', '-s', '--format=%(trailers:key=Pipeline-Source,valueonly)', sha]);
    return { task: task.status === 0 ? task.stdout.trim() : '', source: source.status === 0 ? source.stdout.trim() : '' };
  }).filter((commit) => commit.task && commit.source);
  return tasks.filter((task) => task.done && (runGit(cwd, ['rev-parse', '--verify', '--quiet', `${task.done.source}^{commit}`]).status !== 0
    || !merges.some((commit) => commit.task === task.id && commit.source.startsWith(task.done.source))))
    .map((task) => ({ task: task.id, kind: 'DONE_UNVERIFIED', reason: `Done source ${task.done.source} has no matching first-parent merge trailer` }));
}

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
  const [sub, ...subRest] = rest;
  if (sub === 'sync') {
    const result = spawnSync(process.execPath, [path.join(HOME, 'acceptance-sync.mjs'), ...subRest], { stdio: 'inherit' });
    process.exit(result.status ?? 1);
  }
  const result = spawnSync(process.execPath, [path.join(HOME, 'acceptance-run.mjs'), ...rest], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
} else if (command === 'brief') {
  const result = spawnSync(process.execPath, [path.join(HOME, 'brief.mjs'), ...rest], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
} else if (command === 'worker-check') {
  const result = spawnSync(process.execPath, [path.join(HOME, 'worker-check.mjs'), ...rest], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
} else if (command === 'tier2-verify') {
  const result = spawnSync(process.execPath, [path.join(HOME, 'tier2-verify.mjs'), ...rest], { stdio: 'inherit' });
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
  try { parsed = parseOptions(rest, { 'replace-hooks': 'boolean' }); } catch (error) { die(error.message); }
  const targets = parsed.positional.length ? parsed.positional.map((item) => path.resolve(item)) : [process.cwd()];
  let failed = false;
  for (const target of targets) {
    if (!fs.existsSync(target)) die(`no worktree at ${target}`, 3);
    const probe = runGit(target, ['rev-parse', '--is-inside-work-tree']);
    if (probe.status !== 0) die(`not a git worktree: ${target}`, 3);
    // Installation replaces the whole hooks directory, so anything already there would be lost
    // silently. Name it and stop before writing; `--replace-hooks` is the human's approval.
    const displaced = [];
    const configured = runGit(target, ['config', '--get', 'core.hooksPath']);
    const current = configured.status === 0 ? configured.stdout.trim() : '';
    if (current && path.resolve(target, current) !== path.resolve(HOOKS_DIR)) {
      displaced.push(`core.hooksPath=${current}`);
    }
    // The default hooks directory may hold the repository's own hooks. Samples are inert.
    // `--git-path hooks` honours `core.hooksPath`, so it would report the pipeline's own hooks
    // after a first install and make the command refuse itself; the default directory is
    // `<git-common-dir>/hooks`.
    const commonDir = runGit(target, ['rev-parse', '--git-common-dir']);
    if (commonDir.status === 0) {
      const dir = path.resolve(target, commonDir.stdout.trim(), 'hooks');
      const entries = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
      for (const name of entries.sort()) {
        if (name.endsWith('.sample')) continue;
        const file = path.join(dir, name);
        // git runs only an executable regular file; a leftover without the bit is inert.
        try {
          if (fs.statSync(file).isFile() && (fs.statSync(file).mode & 0o111)) displaced.push(file);
        } catch {}
      }
    }
    if (displaced.length && !parsed.options['replace-hooks']) {
      // Name each object before refusing so the human approving --replace-hooks sees what is lost.
      for (const item of displaced) console.error(`displaced: ${item}`);
      console.error(`[pipeline-run] ${target} already has hooks this install would displace: ${displaced.join(', ')}; re-run with --replace-hooks after confirming replacing them is intended`);
      failed = true;
      continue;
    }
    const enable = runGit(target, ['config', 'extensions.worktreeConfig', 'true']);
    if (enable.status !== 0) { console.error(`[pipeline-run] cannot enable worktreeConfig in ${target}: ${enable.stderr.trim()}`); failed = true; continue; }
    const set = runGit(target, ['config', '--worktree', 'core.hooksPath', HOOKS_DIR]);
    if (set.status !== 0) { console.error(`[pipeline-run] cannot set core.hooksPath in ${target}: ${set.stderr.trim()}`); failed = true; continue; }
    // Only after the install succeeded: an approved replacement is now factual.
    for (const item of displaced) console.log(`replaced: ${item}`);
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
} else if (command === 'risk-scan') {
  const result = spawnSync(process.execPath, [path.join(HOME, 'risk-scan.mjs'), ...rest], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
} else if (command === 'prepare-task') {
  let parsed;
  try { parsed = parseOptions(rest, { 'worktree-root': 'value', json: 'boolean', 'replace-hooks': 'boolean' }); } catch (error) { die(error.message); }
  if (parsed.positional.length !== 2) die('prepare-task needs <change-dir> <task-id>');
  const dir = changeDirOf(parsed.positional[0]);
  const taskId = parsed.positional[1];
  const change = path.basename(dir);
  const { markdown } = readTasksMarkdown(dir, change);
  const parsedTasks = parseTasks(markdown);
  const task = parsedTasks.tasks.find((item) => item.id === taskId);
  if (!task) die(`unknown task ${taskId} in ${dir}`, 3);
  const repoTop = runGit(dir, ['rev-parse', '--show-toplevel']);
  if (repoTop.status !== 0) die('prepare-task must run inside a git repository', 3);
  const root = fs.realpathSync(repoTop.stdout.trim());
  const integrationRef = `integration/${change}`;
  const baseCheck = runGit(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${integrationRef}`]);
  const baseBranch = baseCheck.status === 0 ? integrationRef : 'HEAD';

  const refs = runGit(root, ['for-each-ref', '--format=%(refname:short)', `refs/heads/task/${change}/`]).stdout
    .split('\n').map((line) => line.trim()).filter(Boolean)
    .filter((ref) => ref === `task/${change}/${taskId}` || ref.startsWith(`task/${change}/${taskId}-a`))
    .sort((a, b) => Number(a.match(/-a(\d+)$/)?.[1] ?? 1) - Number(b.match(/-a(\d+)$/)?.[1] ?? 1));
  const branch = refs.at(-1) ?? `task/${change}/${taskId}`;
  if (!refs.length) {
    const mkBranch = runGit(root, ['branch', branch, baseBranch]);
    if (mkBranch.status !== 0) die(`cannot create branch ${branch}: ${mkBranch.stderr.trim()}`, 1);
  }

  const wtList = runGit(root, ['worktree', 'list', '--porcelain']).stdout.split(/\r?\n\r?\n/);
  let worktreePath = null;
  for (const block of wtList) {
    const lines = block.split(/\r?\n/);
    if (lines.find((l) => l === `branch refs/heads/${branch}`)) {
      const wtLine = lines.find((l) => l.startsWith('worktree '));
      if (wtLine) { worktreePath = wtLine.slice('worktree '.length); break; }
    }
  }
  if (!worktreePath) {
    const wtRoot = parsed.options['worktree-root']
      ? path.resolve(parsed.options['worktree-root'])
      : path.join(root, '.claude', 'worktrees');
    fs.mkdirSync(wtRoot, { recursive: true });
    worktreePath = path.join(wtRoot, `task-${change}-${taskId}`);
    const addWt = runGit(root, ['worktree', 'add', worktreePath, branch]);
    if (addWt.status !== 0) die(`cannot create worktree ${worktreePath}: ${addWt.stderr.trim()}`, 1);
  }

  const hookArgs = [path.join(HOME, 'pipeline-run.mjs'), 'install-hook', worktreePath];
  if (parsed.options['replace-hooks']) hookArgs.push('--replace-hooks');
  const hookRes = spawnSync(process.execPath, hookArgs, { cwd: root, encoding: 'utf8' });
  if (hookRes.status !== 0) die(`install-hook failed:\n${hookRes.stderr}${hookRes.stdout}`, hookRes.status ?? 1);

  const commits = runGit(worktreePath, ['log', '--format=%(trailers:key=Pipeline-Role,valueonly)', '--no-merges', `${baseBranch}..${branch}`]);
  const hasCeshiCommit = commits.status === 0 && commits.stdout.split(/\r?\n/).some((r) => r.trim().toLowerCase() === 'ceshi');
  const briefKind = task.review === 'strict' && !hasCeshiCommit ? 'tester' : 'worker';
  const role = briefKind === 'tester' ? 'ceshi' : recommendedWorkerRole(task);
  const briefRes = spawnSync(process.execPath, [path.join(HOME, 'brief.mjs'), briefKind, '--change', change, '--repo', root, '--task', taskId, '--json'], { cwd: root, encoding: 'utf8' });
  if (briefRes.status !== 0) die(`brief failed:\n${briefRes.stderr}${briefRes.stdout}`, briefRes.status ?? 1);
  const briefData = JSON.parse(briefRes.stdout);
  const titleFull = `[Pipeline] ${role} ${branch.slice(`task/${change}/`.length)} ${change}`;
  const out = {
    change,
    task: taskId,
    branch,
    base: baseBranch,
    worktree: worktreePath,
    role,
    briefKind,
    title: titleFull.length <= 60 ? titleFull : `[Pipeline] ${role} ${branch.slice(`task/${change}/`.length)}`,
    labels: { 'pipeline.change': change },
    prompt: briefData.prompt,
  };
  if (parsed.options.json) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(`prepared ${taskId}: branch=${branch} worktree=${worktreePath} role=${role} briefKind=${briefKind}`);
    console.log(`title="${out.title}" label=pipeline.change=${change}`);
  }
} else if (command === 'cp2-merge') {
  let parsed;
  try { parsed = parseOptions(rest, { base: 'value', json: 'boolean' }); } catch (error) { die(error.message); }
  if (parsed.positional.length !== 1) die('cp2-merge needs <change-dir>');
  const dir = changeDirOf(parsed.positional[0]);
  const change = path.basename(dir);
  const baseBranch = parsed.options.base || 'main';
  const rootRes = runGit(dir, ['rev-parse', '--show-toplevel']);
  if (rootRes.status !== 0) die('not a git repository', 3);
  const root = fs.realpathSync(rootRes.stdout.trim());
  const curBranch = runGit(root, ['symbolic-ref', '--short', 'HEAD']).stdout.trim();
  const dirtyPrimary = runGit(root, ['status', '--porcelain=v1', '--untracked-files=all']).stdout.trim();
  if (dirtyPrimary) die(`working tree is not clean (${dirtyPrimary.split('\n').length} entries); commit/stash other session work first`, 3);
  const integrationBranch = `integration/${change}`;
  if (runGit(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${integrationBranch}`]).status !== 0) {
    die(`missing branch ${integrationBranch}`, 3);
  }
  const wtList = runGit(root, ['worktree', 'list', '--porcelain']).stdout.split(/\r?\n\r?\n/);
  let intWorktree = null;
  let baseWorktree = null;
  for (const block of wtList) {
    const lines = block.split(/\r?\n/);
    const bLine = lines.find((l) => l.startsWith('branch '));
    const wLine = lines.find((l) => l.startsWith('worktree '));
    if (!bLine || !wLine) continue;
    if (bLine === `branch refs/heads/${integrationBranch}`) intWorktree = wLine.slice('worktree '.length);
    if (bLine === `branch refs/heads/${baseBranch}`) baseWorktree = wLine.slice('worktree '.length);
  }
  const targetBaseWt = baseWorktree || (curBranch === baseBranch ? root : null);
  if (!targetBaseWt) die(`checkout ${baseBranch} in a clean worktree before cp2-merge`, 3);
  if (runGit(targetBaseWt, ['status', '--porcelain=v1', '--untracked-files=all']).stdout.trim()) {
    die(`${baseBranch} worktree ${targetBaseWt} has uncommitted changes; aborting merge`, 3);
  }
  const baseShaBefore = runGit(targetBaseWt, ['rev-parse', baseBranch]).stdout.trim();
  const drifted = runGit(targetBaseWt, ['merge-base', '--is-ancestor', baseShaBefore, integrationBranch]).status !== 0;
  let driftedSynced = false;
  if (drifted) {
    if (!intWorktree) die(`${baseBranch} advanced past integration base and ${integrationBranch} has no checked-out worktree to sync`, 3);
    if (runGit(intWorktree, ['status', '--porcelain=v1', '--untracked-files=all']).stdout.trim()) {
      die(`integration worktree ${intWorktree} is dirty`, 3);
    }
    const syncMerge = runGit(intWorktree, ['merge', '--no-ff', '--no-edit', baseBranch]);
    if (syncMerge.status !== 0) {
      runGit(intWorktree, ['merge', '--abort']);
      die(`${baseBranch} drifted and conflicts with ${integrationBranch}; resolve manually in ${intWorktree} and re-run Verify`, 10);
    }
    driftedSynced = true;
  }
  const ff = runGit(targetBaseWt, ['merge', '--ff-only', integrationBranch]);
  if (ff.status !== 0) die(`fast-forward merge into ${baseBranch} failed: ${ff.stderr}`, 1);
  const mergedSha = runGit(targetBaseWt, ['rev-parse', 'HEAD']).stdout.trim();
  const payload = { change, base: baseBranch, rollbackSha: baseShaBefore, mergedSha, driftedSynced };
  if (parsed.options.json) console.log(JSON.stringify(payload, null, 2));
  else console.log(`cp2-merge ok: ${integrationBranch} -> ${baseBranch} @ ${mergedSha.slice(0, 7)} (rollback=${baseShaBefore.slice(0, 7)}${driftedSynced ? ', synced main drift — rerun full Verify now' : ''})`);
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
      attention: doneVerification(change, tasks, dir),
    }, null, 2));
  } else {
    console.log(`${change}${headSha ? ` @ ${headSha.slice(0, 7)}` : ''} (tasks: ${tasksSource})`);
    console.log(`done ${done.length}/${tasks.length}: ${done.map((task) => task.id).join(', ') || 'none'}`);
    for (const task of tasks.filter((item) => !item.done)) console.log(`OPEN ${task.id}: ${task.title}`);
    for (const item of doneVerification(change, tasks, dir)) console.log(`ATTENTION ${item.task}: ${item.kind} — ${item.reason}`);
  }
} else {
  die('usage: pipeline-run.mjs plan|prepare-task|merge|cp2-merge|status|cleanup|scenarios|acceptance|worker-check|tier2-verify|brief|risk-scan|install-hook ...', 2);
}
