#!/usr/bin/env node
// Unified CLI facade and deterministic driver for the SDD pipeline (ADR-0001..0005).
// Exposes all day-to-day commands under one entrypoint while keeping standalone scripts compatible.
//
// Usage:
//   pipeline-run.mjs plan   <change-dir> [--json] [--worker-cap N] [--idle-minutes N]
//   pipeline-run.mjs merge  <change-dir> <task-id> [--timeout=ms] [--allow-attempt-over]
//   pipeline-run.mjs status <change-dir>
//   pipeline-run.mjs cleanup <change-dir> [--json] [--change <name>]
//   pipeline-run.mjs scenarios <change-dir> [--json]
//   pipeline-run.mjs inspect <change-dir> [--json]
//   pipeline-run.mjs freeze <change-dir> [--json] [--explain] [--structural] [--skip-signer-check] [--strict]
//   pipeline-run.mjs profiles [--skill F] [--config F] [--root R] [--json]
//   pipeline-run.mjs preflight <repo> [--json] [--strict]
//   pipeline-run.mjs acceptance run|check|sync <change-dir> ...
//   pipeline-run.mjs prepare-author <change-dir> [--repo <path>] [--schema paseo-pipeline|paseo-tier2] [--scaffold] [--capability <cap>] [--hydrate] [--base main] [--json]
//   pipeline-run.mjs prepare-task <change-dir> <task-id> [--worktree-root <dir>] [--workspace-dir <dir>] [--hydrate] [--new-attempt] [--allow-attempt-over] [--json]
//   pipeline-run.mjs hydrate [<dir>] [--json]
//   pipeline-run.mjs record-review --mode r0|final|tier2|tier1 --verdict PASS|BLOCKED|INCOMPLETE|HUMAN_ACCEPT --reviewer <id> [--sha <ref>] [--change-dir <dir>] [--reason <text>] [--cwd <dir>] [--json]
//   pipeline-run.mjs cp2-merge <change-dir> [--base main] [--verify <cmd>]... [--timeout ms] [--skip-drift-verify] [--json]
//   pipeline-run.mjs brief <role> --change <name> --repo <path> ...
//   pipeline-run.mjs worker-check <change-dir> <task-id> [--timeout ms] [--allow-test-infra]
//   pipeline-run.mjs tier2-verify <base> [--change-dir <dir>] [--verify <cmd>]... [--auto-verify] [--strict-scope] [--cwd <dir>] [--json]
//   pipeline-run.mjs risk-scan <base> [<head>] [--cwd <dir>] [--working-tree] [--files <p1,p2>] [--tracked-only] [--json] [--require-clean]
//   pipeline-run.mjs install-hook <worktree> [<worktree>...]
//   pipeline-run.mjs report [--days N] [--json]

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseTasks } from './lib/tasks.mjs';
import { readTasksMarkdown } from './lib/tasks-source.mjs';
import { parseAcceptanceTable } from './lib/acceptance.mjs';
import { findStaleChanges, scanScenarios } from './lib/spec-scan.mjs';
import { runGit, listWorktreesMaybe, worktreeForBranch, primaryWorktree } from './lib/git.mjs';
import { parseOptions, planOptions } from './lib/cli.mjs';
import { runCleanup } from './lib/cleanup.mjs';
import { recommendedWorkerRole } from './lib/roles.mjs';
import { runVerifyCommand } from './lib/verify-runner.mjs';
import { proveVerifyCommand } from './lib/verify-policy.mjs';
import { recordReview, findReviewSignoff } from './lib/review-record.mjs';
import { recordEvent, summarizeTelemetry } from './lib/telemetry.mjs';

const HOME = path.dirname(fileURLToPath(import.meta.url));
const [command, ...rest] = process.argv.slice(2);

function die(message, code = 2) {
  console.error(`[pipeline-run] ${message}`);
  process.exit(code);
}

function resolveWithExistingRealpath(targetPath) {
  let cur = path.resolve(targetPath || '.');
  const tail = [];
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    tail.unshift(path.basename(cur));
    cur = parent;
  }
  const existingReal = fs.existsSync(cur) ? fs.realpathSync(cur) : cur;
  const resolved = tail.length ? path.join(existingReal, ...tail) : existingReal;
  let existingDir = existingReal;
  try {
    if (!fs.statSync(existingReal).isDirectory()) existingDir = path.dirname(existingReal);
  } catch {
    existingDir = process.cwd();
  }
  return { resolved, existingDir };
}

function changeDirOf(arg) {
  const dir = path.resolve(arg || '.');
  if (!fs.existsSync(path.join(dir, 'tasks.md'))) die(`no tasks.md in ${dir}`, 3);
  return dir;
}

const HOOKS_DIR = path.join(HOME, 'hooks', 'git');

function commonGitDir(dir) {
  const abs = runGit(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (abs.status === 0 && abs.stdout.trim()) {
    try { return fs.realpathSync(abs.stdout.trim()); } catch { return path.resolve(abs.stdout.trim()); }
  }
  const rel = runGit(dir, ['rev-parse', '--git-common-dir']);
  if (rel.status !== 0 || !rel.stdout.trim()) return null;
  const target = path.isAbsolute(rel.stdout.trim()) ? rel.stdout.trim() : path.resolve(dir, rel.stdout.trim());
  try { return fs.realpathSync(target); } catch { return path.resolve(target); }
}

function hydrateWorktree(worktreePath) {
  if (!fs.existsSync(path.join(worktreePath, 'package.json'))) {
    return { attempted: false, skippedReason: 'no-package-json' };
  }
  if (fs.existsSync(path.join(worktreePath, 'node_modules'))) {
    return { attempted: false, skippedReason: 'already-present' };
  }
  const candidates = [
    ['pnpm-lock.yaml', 'pnpm', ['install', '--frozen-lockfile', '--prefer-offline']],
    ['package-lock.json', 'npm', ['ci', '--prefer-offline']],
    ['yarn.lock', 'yarn', ['install', '--frozen-lockfile']],
    ['bun.lock', 'bun', ['install', '--frozen-lockfile']],
    ['bun.lockb', 'bun', ['install', '--frozen-lockfile']],
  ];
  const match = candidates.find(([lock]) => fs.existsSync(path.join(worktreePath, lock)));
  if (!match) return { attempted: false, skippedReason: 'no-lockfile' };
  const [, tool, toolArgs] = match;
  const startedAt = Date.now();
  const res = spawnSync(tool, toolArgs, { cwd: worktreePath, encoding: 'utf8', timeout: 120_000 });
  const ok = !res.error && res.status === 0;
  return {
    attempted: true,
    tool,
    ok,
    status: res.status ?? 1,
    durationMs: Date.now() - startedAt,
    ...(ok ? {} : { error: (res.error?.message || res.stderr || res.stdout || '').trim().slice(0, 240) }),
  };
}

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

function hookWarnings(change) {
  const worktrees = listWorktreesMaybe(undefined);
  if (!worktrees.length) return [];
  const warnings = [];
  for (const tree of worktrees) {
    if (!tree.branch) continue;
    if (tree.branch !== `integration/${change}` && !tree.branch.startsWith(`task/${change}/`)) continue;
    const configured = runGit(undefined, ['-C', tree.path, 'config', '--get', 'core.hooksPath']);
    const value = configured.status === 0 ? configured.stdout.trim() : '';
    if (value && path.resolve(value) === path.resolve(HOOKS_DIR)) continue;
    warnings.push(`WARN ${tree.branch} (${tree.path}) has no author hook: run \`node ${path.join(HOME, 'pipeline-run.mjs')} install-hook ${tree.path}\`, or its worker commits will exit 31`);
  }
  return warnings;
}

function forward(scriptName, scriptArgs = rest) {
  const result = spawnSync(process.execPath, [path.join(HOME, scriptName), ...scriptArgs], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}

if (command === 'acceptance') {
  const [sub, ...subRest] = rest;
  if (sub === 'sync') forward('acceptance-sync.mjs', subRest);
  forward('acceptance-run.mjs');
} else if (command === 'brief') {
  forward('brief.mjs');
} else if (command === 'worker-check') {
  forward('worker-check.mjs');
} else if (command === 'tier2-verify') {
  forward('tier2-verify.mjs');
} else if (command === 'freeze') {
  forward('freeze-check.mjs');
} else if (command === 'profiles') {
  forward('profiles-check.mjs');
} else if (command === 'preflight') {
  forward('preflight.mjs');
} else if (command === 'scenarios') {
  forward('scenarios.mjs');
} else if (command === 'risk-scan') {
  forward('risk-scan.mjs');
} else if (command === 'inspect') {
  let parsed;
  try { parsed = parseOptions(rest, { json: 'boolean' }); } catch (error) { die(error.message); }
  if (parsed.positional.length !== 1) die('inspect needs <change-dir>');
  const dir = path.resolve(parsed.positional[0]);
  const parseChild = (scriptName, childArgs) => {
    const res = spawnSync(process.execPath, [path.join(HOME, scriptName), ...childArgs], { encoding: 'utf8' });
    let data = null;
    try { data = JSON.parse(res.stdout); } catch { data = null; }
    return { status: res.status ?? 1, data, stderr: res.stderr.trim() };
  };
  const ns = parseChild('namespace.mjs', [dir, '--json']);
  const sc = parseChild('scenarios.mjs', [dir, '--json']);
  const hs = parseChild('r0-hotspots.mjs', [dir]);
  const ok = ns.status === 0 && sc.status === 0 && hs.status === 0;
  if (parsed.options.json) {
    console.log(JSON.stringify({
      change: dir,
      ok,
      namespace: { exit: ns.status, ...(ns.data ?? { error: ns.stderr }) },
      scenarios: { exit: sc.status, ...(sc.data ?? { error: sc.stderr }) },
      hotspots: { exit: hs.status, ...(hs.data ?? { error: hs.stderr }) },
    }, null, 2));
  } else {
    console.log(`[inspect] ${dir} (ok=${ok})`);
    console.log(`- namespace: exit=${ns.status} prefixes=${ns.data?.scenarios?.length ?? 0}`);
    console.log(`- scenarios: exit=${sc.status} declared=${sc.data?.scenarios?.length ?? 0} undeclaredClaims=${sc.data?.undeclaredClaims?.length ?? 0}`);
    console.log(`- hotspots: exit=${hs.status} tasks=${hs.data?.tasks?.length ?? 0} requirements=${hs.data?.requirements?.length ?? 0}`);
    for (const sub of [ns, sc, hs]) if (sub.status !== 0 && sub.stderr) console.error(sub.stderr);
  }
  process.exit(ok ? 0 : 1);
} else if (command === 'report') {
  let parsed;
  try { parsed = parseOptions(rest, { days: 'value', json: 'boolean' }); } catch (error) { die(error.message); }
  if (parsed.positional.length > 0) die('report takes no positional arguments');
  const days = parsed.options.days ? Number(parsed.options.days) : 7;
  if (!Number.isFinite(days) || days <= 0) die('--days must be a positive number');
  const summary = summarizeTelemetry({ days });
  if (parsed.options.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`[report] window=${summary.windowDays}d events=${summary.totalEvents} file=${summary.file}`);
    console.log(`- tool_guard: rewrite=${summary.hookActions.rewrite} deny=${summary.hookActions.deny} advise=${summary.hookActions.advise}`);
    console.log(`- tier2_verify: total=${summary.verify.total} pass=${summary.verify.pass} review_required=${summary.verify.reviewRequired} fail=${summary.verify.fail} unprovable=${summary.verify.unprovableRejections}`);
    console.log(`- worker_check: total=${summary.workerCheck.total} pass=${summary.workerCheck.pass} fail=${summary.workerCheck.fail}`);
    console.log(`- tier_stop blocks: total=${summary.stopBlocks.total}`);
    if (summary.authorGuard && (summary.authorGuard.warn || summary.authorGuard.stop || summary.authorGuard.compactEmptySpecs)) {
      console.log(`- author_guard: warn=${summary.authorGuard.warn} stop=${summary.authorGuard.stop} compact_empty_specs=${summary.authorGuard.compactEmptySpecs}`);
    }
    if (summary.tierWrite && (summary.tierWrite.ask || summary.tierWrite.deny)) {
      console.log(`- tier_write: ask=${summary.tierWrite.ask} deny=${summary.tierWrite.deny}`);
    }
    if (summary.freezeCheck?.total) {
      console.log(`- freeze_check: total=${summary.freezeCheck.total} pipeline=${summary.freezeCheck.pipeline} handoff=${summary.freezeCheck.handoff} failed=${summary.freezeCheck.failed}`);
    }
    if (summary.mergeTask?.total) {
      console.log(`- merge_task: total=${summary.mergeTask.total} pass=${summary.mergeTask.pass} fail=${summary.mergeTask.fail}`);
    }
    if (summary.cp2Merge?.total) {
      console.log(`- cp2_merge: total=${summary.cp2Merge.total} pass=${summary.cp2Merge.pass} fail=${summary.cp2Merge.fail} drift_synced=${summary.cp2Merge.driftSynced}`);
    }
    if (summary.reviews?.total) {
      console.log(`- reviews: total=${summary.reviews.total} pass=${summary.reviews.pass} blocked=${summary.reviews.blocked} incomplete=${summary.reviews.incomplete} human_accept=${summary.reviews.humanAccept}`);
    }
    const ns = summary.northStar || {};
    const nsItems = [
      ns.tier2PassRate !== null ? `tier2_pass=${ns.tier2PassRate}%` : null,
      ns.workerFirstPassRate !== null ? `worker_pass=${ns.workerFirstPassRate}%` : null,
      ns.mergePassRate !== null ? `merge_pass=${ns.mergePassRate}%` : null,
      ns.tier3HandoffRate !== null ? `tier3_handoff=${ns.tier3HandoffRate}%` : null,
    ].filter(Boolean);
    if (nsItems.length) console.log(`- north_star: ${nsItems.join(', ')}`);
    if (summary.pruneCandidates?.length) {
      console.log(`- prune_candidates (${summary.windowDays}d 0-hit): ${summary.pruneCandidates.join(', ')}`);
    }
    if (summary.topReasonCodes.length) {
      console.log(`- top reasons: ${summary.topReasonCodes.slice(0, 8).map((r) => `${r.code}=${r.count}`).join(', ')}`);
    }
  }
  process.exit(0);
} else if (command === 'hydrate') {
  let parsed;
  try { parsed = parseOptions(rest, { json: 'boolean' }); } catch (error) { die(error.message); }
  if (parsed.positional.length > 1) die('hydrate accepts at most one <dir>');
  const targetDir = path.resolve(parsed.positional[0] || process.cwd());
  if (!fs.existsSync(targetDir)) die(`missing directory: ${targetDir}`, 3);
  const topRes = runGit(targetDir, ['rev-parse', '--show-toplevel']);
  const rootDir = topRes.status === 0 ? fs.realpathSync(topRes.stdout.trim()) : targetDir;
  const hydration = hydrateWorktree(rootDir);
  if (parsed.options.json) {
    console.log(JSON.stringify({ dir: rootDir, ...hydration }, null, 2));
  } else {
    console.log(`[hydrate] ${rootDir}: attempted=${hydration.attempted}${hydration.tool ? ` tool=${hydration.tool} ok=${hydration.ok}` : ` reason=${hydration.skippedReason}`}`);
    if (hydration.attempted && !hydration.ok && hydration.error) console.error(hydration.error);
  }
  process.exit(hydration.attempted && !hydration.ok ? 1 : 0);
} else if (command === 'record-review') {
  let parsed;
  try {
    parsed = parseOptions(rest, {
      mode: 'value',
      verdict: 'value',
      reviewer: 'value',
      sha: 'value',
      'change-dir': 'value',
      reason: 'value',
      cwd: 'value',
      json: 'boolean',
    });
  } catch (error) { die(error.message); }
  if (parsed.positional.length > 0) die('record-review takes options only (--mode --verdict --reviewer ...)');
  try {
    const out = recordReview({
      cwd: parsed.options.cwd || process.cwd(),
      mode: parsed.options.mode,
      verdict: parsed.options.verdict,
      reviewer: parsed.options.reviewer,
      sha: parsed.options.sha || 'HEAD',
      changeDir: parsed.options['change-dir'] || null,
      reason: parsed.options.reason || '',
    });
    if (parsed.options.json) console.log(JSON.stringify(out, null, 2));
    else console.log(`[record-review] ${out.line} (${out.targets.join(', ')})`);
    process.exit(0);
  } catch (error) {
    die(error.message, 2);
  }
} else if (command === 'plan') {
  let parsed;
  try { parsed = parseOptions(rest, planOptions); } catch (error) { die(error.message); }
  if (parsed.positional.length !== 1) die('plan needs <change-dir>');
  const dir = changeDirOf(parsed.positional[0]);
  for (const warning of hookWarnings(path.basename(dir))) console.error(`[pipeline-run] ${warning}`);
  forward('next-actions.mjs');
} else if (command === 'install-hook') {
  let parsed;
  try { parsed = parseOptions(rest, { 'replace-hooks': 'boolean' }); } catch (error) { die(error.message); }
  const targets = parsed.positional.length ? parsed.positional.map((item) => path.resolve(item)) : [process.cwd()];
  let failed = false;
  for (const target of targets) {
    if (!fs.existsSync(target)) die(`no worktree at ${target}`, 3);
    const probe = runGit(target, ['rev-parse', '--is-inside-work-tree']);
    if (probe.status !== 0) die(`not a git worktree: ${target}`, 3);
    const displaced = [];
    const configured = runGit(target, ['config', '--get', 'core.hooksPath']);
    const current = configured.status === 0 ? configured.stdout.trim() : '';
    if (current && path.resolve(target, current) !== path.resolve(HOOKS_DIR)) {
      displaced.push(`core.hooksPath=${current}`);
    }
    const commonDir = runGit(target, ['rev-parse', '--git-common-dir']);
    if (commonDir.status === 0) {
      const dir = path.resolve(target, commonDir.stdout.trim(), 'hooks');
      const entries = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
      for (const name of entries.sort()) {
        if (name.endsWith('.sample')) continue;
        const file = path.join(dir, name);
        try {
          if (fs.statSync(file).isFile() && (fs.statSync(file).mode & 0o111)) displaced.push(file);
        } catch {}
      }
    }
    if (displaced.length && !parsed.options['replace-hooks']) {
      for (const item of displaced) console.error(`displaced: ${item}`);
      console.error(`[pipeline-run] ${target} already has hooks this install would displace: ${displaced.join(', ')}; re-run with --replace-hooks after confirming replacing them is intended`);
      failed = true;
      continue;
    }
    const enable = runGit(target, ['config', 'extensions.worktreeConfig', 'true']);
    if (enable.status !== 0) { console.error(`[pipeline-run] cannot enable worktreeConfig in ${target}: ${enable.stderr.trim()}`); failed = true; continue; }
    const set = runGit(target, ['config', '--worktree', 'core.hooksPath', HOOKS_DIR]);
    if (set.status !== 0) { console.error(`[pipeline-run] cannot set core.hooksPath in ${target}: ${set.stderr.trim()}`); failed = true; continue; }
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
    .sort((a, b) => Number(a.match(/-a(\d+)$/)?.[1] ?? 1) - Number(b.match(/-a(\d+)$/)?.[1] ?? 1));
  const branch = candidates.at(-1);
  if (!branch) die(`no branch for ${taskId} under task/${change}/`, 3);
  forward('merge-task.mjs', [branch, taskId, ...mergeOptions]);
} else if (command === 'cleanup') {
  process.exit(runCleanup(rest));
} else if (command === 'prepare-author') {
  let parsed;
  try {
    parsed = parseOptions(rest, {
      repo: 'value',
      schema: 'value',
      scaffold: 'boolean',
      capability: 'value',
      hydrate: 'boolean',
      base: 'value',
      json: 'boolean',
    });
  } catch (error) { die(error.message); }
  if (parsed.positional.length !== 1) die('prepare-author needs <change-dir>');
  const schema = parsed.options.schema || 'paseo-pipeline';
  if (!['paseo-pipeline', 'paseo-tier2'].includes(schema)) {
    die(`prepare-author --schema must be paseo-pipeline or paseo-tier2, got "${schema}"`);
  }
  const dir = path.resolve(parsed.positional[0]);
  const change = path.basename(dir);
  const existingAncestor = (target) => {
    let cur = path.resolve(target);
    while (!fs.existsSync(cur)) {
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    return fs.existsSync(cur) ? cur : process.cwd();
  };
  const repoProbe = parsed.options.repo ? path.resolve(parsed.options.repo) : existingAncestor(dir);
  const repoTop = runGit(repoProbe, ['rev-parse', '--show-toplevel']);
  if (repoTop.status !== 0) die('prepare-author must run inside a git repository', 3);
  const root = fs.realpathSync(repoTop.stdout.trim());

  fs.mkdirSync(dir, { recursive: true });
  const openspecYaml = path.join(dir, '.openspec.yaml');
  if (!fs.existsSync(openspecYaml)) {
    fs.writeFileSync(openspecYaml, `schema: ${schema}\ncreated: ${new Date().toISOString().slice(0, 10)}\n`);
  }

  const head = runGit(root, ['rev-parse', 'HEAD']).stdout.trim();
  const branch = runGit(root, ['symbolic-ref', '--short', '-q', 'HEAD']).stdout.trim() || 'DETACHED';
  const dirtyLines = runGit(root, ['status', '--porcelain=v1', '--untracked-files=all']).stdout.split('\n').filter(Boolean);
  const dirtyCount = dirtyLines.length;
  const baseCandidate = parsed.options.base
    || ['main', 'master'].find((name) => runGit(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]).status === 0)
    || null;
  const revCounts = (left, right) => {
    const r = runGit(root, ['rev-list', '--left-right', '--count', `${left}...${right}`]);
    if (r.status !== 0) return null;
    const [a, b] = r.stdout.trim().split(/\s+/).map((n) => Number.parseInt(n, 10));
    return Number.isInteger(a) && Number.isInteger(b) ? { behind: a, ahead: b } : null;
  };
  const drift = {
    base: baseCandidate,
    headVsBase: baseCandidate ? revCounts(baseCandidate, 'HEAD') : null,
    originVsBase: baseCandidate && runGit(root, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${baseCandidate}`]).status === 0
      ? revCounts(baseCandidate, `origin/${baseCandidate}`)
      : null,
  };

  const hydration = parsed.options.hydrate ? hydrateWorktree(root) : null;
  if (hydration?.attempted && !hydration.ok) {
    console.error(`[pipeline-run] WARN hydration via ${hydration.tool} failed (exit=${hydration.status}): ${hydration.error || 'unknown error'}`);
  }

  const runJson = (scriptName, scriptArgs) => {
    const res = spawnSync(process.execPath, [path.join(HOME, scriptName), ...scriptArgs], { cwd: root, encoding: 'utf8' });
    let data = null;
    try { data = JSON.parse(res.stdout); } catch { data = null; }
    return { status: res.status ?? 1, data, stdout: res.stdout.trim(), stderr: res.stderr.trim() };
  };
  const preflightRes = runJson('preflight.mjs', [root, '--json']);
  const namespaceRes = runJson('namespace.mjs', [dir, '--json']);

  const proposalPath = path.join(dir, 'proposal.md');
  let ruleCount = 0;
  let capabilityCount = 0;
  if (fs.existsSync(proposalPath)) {
    const prop = fs.readFileSync(proposalPath, 'utf8');
    const what = prop.split(/^##\s+What Changes\s*$/m)[1]?.split(/^##\s+/m)[0] ?? '';
    ruleCount = (what.match(/^\s*[-*]\s+R\d+\b/gm) || []).length;
    const caps = prop.split(/^##\s+Capabilities\s*$/m)[1]?.split(/^##\s+/m)[0] ?? '';
    capabilityCount = (caps.match(/^\s*[-*]\s+`/gm) || []).length;
  }
  const specsDir = path.join(dir, 'specs');
  if (fs.existsSync(specsDir)) {
    const capDirs = new Set();
    const walk = (p) => {
      for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        const full = path.join(p, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name === 'spec.md') {
          const top = path.relative(specsDir, full).split(path.sep)[0];
          if (top && top !== 'spec.md') capDirs.add(top);
        }
      }
    };
    walk(specsDir);
    capabilityCount = Math.max(capabilityCount, capDirs.size);
  }
  const stale = findStaleChanges(root, change);
  const splitReasons = [];
  if (ruleCount > 10) splitReasons.push(`rules=${ruleCount}>10`);
  if (capabilityCount > 2) splitReasons.push(`capabilities=${capabilityCount}>2`);
  const splitRecommended = splitReasons.length > 0;

  const driftLine = (() => {
    const parts = [];
    if (drift.headVsBase) parts.push(`HEAD vs ${drift.base}: ahead=${drift.headVsBase.ahead}, behind=${drift.headVsBase.behind}`);
    if (drift.originVsBase) parts.push(`${drift.base} vs origin/${drift.base}: local_only=${drift.originVsBase.behind}, origin_ahead=${drift.originVsBase.ahead}`);
    return parts.join('; ') || 'none';
  })();
  const preflightSummary = preflightRes.data
    ? `ok=${preflightRes.status === 0} findings=${preflightRes.data.findings?.length ?? 0}`
    : `exit=${preflightRes.status}`;
  const nsSummary = namespaceRes.data?.scenarios?.length
    ? namespaceRes.data.scenarios.slice(0, 12).map((s) => `SCEN-${s.prefix}(next=${s.next})`).join(', ')
    : 'none';

  const scaffolded = [];
  let suggestedScenarios = [];
  const capSlug = String(parsed.options.capability || change)
    .trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'core';
  if (parsed.options.scaffold && schema === 'paseo-tier2') {
    const alphaWords = capSlug.split('-').map((w) => w.replace(/[^a-z]/g, '')).filter(Boolean);
    let prefix = alphaWords.length >= 3
      ? alphaWords.slice(0, 4).map((w) => w[0]).join('').toUpperCase()
      : (alphaWords.length === 2
        ? `${alphaWords[0].slice(0, 2)}${alphaWords[1].slice(0, 2)}`.toUpperCase()
        : (alphaWords[0] || capSlug.replace(/[^a-z]/g, '') || 'CAP').slice(0, 4).toUpperCase());
    if (prefix.length < 2) prefix = `${prefix}X`.slice(0, 3);
    const existingPrefix = (namespaceRes.data?.scenarios || []).find((item) => item.prefix === prefix);
    const nsNext = existingPrefix ? Math.max(1, Number(existingPrefix.next) || (Number(existingPrefix.max) + 1)) : 1;
    let localMax = 0;
    const scanPrefixText = (text) => {
      for (const found of scanScenarios(text)) {
        const match = /^SCEN-(.*)-(\d+)$/.exec(found.id);
        if (match && match[1] === prefix) localMax = Math.max(localMax, Number.parseInt(match[2], 10));
      }
      const rx = /\bSCEN-([A-Z0-9-]+)-(\d+)\b/g;
      for (const m of String(text || '').matchAll(rx)) {
        if (m[1] === prefix) localMax = Math.max(localMax, Number.parseInt(m[2], 10));
      }
    };
    if (fs.existsSync(specsDir)) {
      const stack = [specsDir];
      while (stack.length) {
        const cur = stack.pop();
        for (const ent of fs.readdirSync(cur, { withFileTypes: true })) {
          const full = path.join(cur, ent.name);
          if (ent.isDirectory()) stack.push(full);
          else if (ent.isFile() && ent.name === 'spec.md') {
            try { scanPrefixText(fs.readFileSync(full, 'utf8')); } catch {}
          }
        }
      }
    }
    const existingTasksPath = path.join(dir, 'tasks.md');
    if (fs.existsSync(existingTasksPath)) {
      try { scanPrefixText(fs.readFileSync(existingTasksPath, 'utf8')); } catch {}
    }
    const startNum = Math.max(nsNext, localMax + 1);
    const scen01 = `SCEN-${prefix}-${String(startNum).padStart(2, '0')}`;
    const scen02 = `SCEN-${prefix}-${String(startNum + 1).padStart(2, '0')}`;
    suggestedScenarios = [scen01, scen02];

    const tplRoot = path.join(HOME, 'openspec-schema-tier2', 'templates');
    const hasExistingSpec = (() => {
      if (!fs.existsSync(specsDir)) return false;
      const stack = [specsDir];
      while (stack.length) {
        const cur = stack.pop();
        for (const ent of fs.readdirSync(cur, { withFileTypes: true })) {
          if (ent.isFile() && ent.name === 'spec.md') return true;
          if (ent.isDirectory()) stack.push(path.join(cur, ent.name));
        }
      }
      return false;
    })();
    const specTarget = path.join(specsDir, capSlug, 'spec.md');
    if (!fs.existsSync(specTarget) && (parsed.options.capability || !hasExistingSpec)) {
      fs.mkdirSync(path.dirname(specTarget), { recursive: true });
      const specTpl = fs.readFileSync(path.join(tplRoot, 'spec.md'), 'utf8')
        .replace(/SCEN-<CAP>-01/g, scen01)
        .replace(/SCEN-<CAP>-02/g, scen02);
      fs.writeFileSync(specTarget, specTpl);
      scaffolded.push(path.relative(dir, specTarget).split(path.sep).join('/'));
    }
    const tasksTarget = path.join(dir, 'tasks.md');
    if (!fs.existsSync(tasksTarget)) {
      const tasksTpl = fs.readFileSync(path.join(tplRoot, 'tasks.md'), 'utf8')
        .replace(/SCEN-CAP-01/g, scen01)
        .replace(/SCEN-CAP-02/g, scen02);
      fs.writeFileSync(tasksTarget, tasksTpl);
      scaffolded.push('tasks.md');
    }
  }

  const stage0Block = [
    '<!-- STAGE0:START -->',
    `- Generated: ${new Date().toISOString()} | Change: \`${change}\` | Branch: \`${branch}\` | HEAD: \`${head.slice(0, 12)}\` | Dirty: ${dirtyCount}`,
    `- Drift: ${driftLine}`,
    `- Preflight: ${preflightSummary}${hydration ? ` | Hydration: ${hydration.ok ? 'ok' : hydration.skippedReason || `exit=${hydration.status}`}` : ''}`,
    `- Namespace prefixes: ${nsSummary}`,
    `- Entropy check: rules=${ruleCount}/10, capabilities=${capabilityCount}/2 (${splitRecommended ? `SPLIT_RECOMMENDED: ${splitReasons.join(', ')}` : 'ok'})`,
    ...(stale.count > 0 ? [`- Workspace changes: ${stale.count} other unarchived directory(s)${stale.advisory ? ' (ARCHIVE_RECOMMENDED)' : ''}`] : []),
    '<!-- STAGE0:END -->',
  ].join('\n');

  const factsPath = path.join(dir, 'baseline-facts.md');
  let preservedBody = [
    '## Verified Code Facts (Stage 1 — chanpin)',
    '',
    '<!-- Append objective path:line facts, real shapes/constraints, and capability gaps only. Keep total file <= 15KB. -->',
    '',
    '## Affected Existing Tests',
    '',
    '## Capability Gaps & Open Decisions',
  ].join('\n');
  if (fs.existsSync(factsPath)) {
    const existing = fs.readFileSync(factsPath, 'utf8');
    const endMarker = '<!-- STAGE0:END -->';
    const endIdx = existing.indexOf(endMarker);
    if (endIdx !== -1) {
      const tail = existing.slice(endIdx + endMarker.length).trim();
      if (tail) preservedBody = tail;
    } else {
      const stripped = existing.replace(/^#\s+Baseline Facts\s*\r?\n+/i, '').trim();
      if (stripped) preservedBody = stripped;
    }
  }
  const fullFacts = `# Baseline Facts\n\n${stage0Block}\n\n${preservedBody}\n`;
  fs.writeFileSync(factsPath, fullFacts);

  const nextCommands = schema === 'paseo-tier2'
    ? [
        `openspec validate ${change} --strict`,
        `node "$PIPELINE_HOME"/pipeline-run.mjs tier2-verify ${baseCandidate || 'main'} --change-dir openspec/changes/${change}`,
        `node "$PIPELINE_HOME"/pipeline-run.mjs brief tier2 --change ${change} --repo . --task T-01`,
      ]
    : [];

  const payload = {
    change,
    changeDir: dir,
    schema,
    repo: root,
    head,
    branch,
    dirtyCount,
    drift,
    ...(hydration ? { hydration } : {}),
    preflight: { exit: preflightRes.status, ...(preflightRes.data ? { findings: preflightRes.data.findings?.length ?? 0 } : {}) },
    namespace: { exit: namespaceRes.status, prefixes: namespaceRes.data?.scenarios?.length ?? 0 },
    baselineFactsPath: factsPath,
    ...(scaffolded.length ? { scaffolded } : {}),
    ...(suggestedScenarios.length ? { suggestedScenarios } : {}),
    ...(nextCommands.length ? { nextCommands } : {}),
    splitRecommended,
    splitReasons,
    staleChanges: stale.names,
    ...(stale.advisory ? { staleAdvisory: stale.advisory } : {}),
    ...(schema === 'paseo-pipeline' && !branch.startsWith('author/')
      ? { worktreeNote: 'If dispatching hanlin in a separate branch-off worktree, pass/sync baseline-facts.md and remove untracked Stage 0 seeds from the default branch before CP-1 --ff-only merge.' }
      : {}),
  };
  if (parsed.options.json) console.log(JSON.stringify(payload, null, 2));
  else {
    console.log(`[prepare-author] ${change} (${schema}) @ ${head.slice(0, 7)} (${branch}, dirty=${dirtyCount})`);
    console.log(`- baseline-facts: ${factsPath}`);
    if (scaffolded.length) console.log(`- scaffolded: ${scaffolded.join(', ')} (suggested: ${suggestedScenarios.join(', ')})`);
    console.log(`- drift: ${driftLine}`);
    console.log(`- preflight: ${preflightSummary} | namespace prefixes: ${nsSummary}`);
    if (stale.advisory) console.log(`ADVISE ${stale.advisory}`);
    if (splitRecommended) console.log(`SPLIT_RECOMMENDED: ${splitReasons.join(', ')}`);
    if (nextCommands.length) {
      console.log('Next commands:');
      for (const cmdLine of nextCommands) console.log(`  ${cmdLine}`);
    }
    if (payload.worktreeNote) console.log(`- note: ${payload.worktreeNote}`);
  }
} else if (command === 'prepare-task') {
  let parsed;
  try {
    parsed = parseOptions(rest, {
      'worktree-root': 'value',
      'workspace-dir': 'value',
      hydrate: 'boolean',
      json: 'boolean',
      'replace-hooks': 'boolean',
      'new-attempt': 'boolean',
      'allow-attempt-over': 'boolean',
    });
  } catch (error) { die(error.message); }
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
  let branch = refs.at(-1) ?? `task/${change}/${taskId}`;
  if (parsed.options['new-attempt'] && refs.length > 0) {
    const maxAttempt = Math.max(...refs.map((ref) => Number(ref.match(/-a(\d+)$/)?.[1] ?? 1)));
    const nextAttempt = maxAttempt + 1;
    if (nextAttempt > 3 && !parsed.options['allow-attempt-over']) {
      die(`${taskId} attempt -a${nextAttempt} exceeds retry cap 3; record human approval and pass --allow-attempt-over`, 37);
    }
    branch = `task/${change}/${taskId}-a${nextAttempt}`;
    const mkAttempt = runGit(root, ['branch', branch, baseBranch]);
    if (mkAttempt.status !== 0) die(`cannot create branch ${branch}: ${mkAttempt.stderr.trim()}`, 1);
  } else if (!refs.length) {
    const mkBranch = runGit(root, ['branch', branch, baseBranch]);
    if (mkBranch.status !== 0) die(`cannot create branch ${branch}: ${mkBranch.stderr.trim()}`, 1);
  }

  let worktreePath = null;
  if (parsed.options['workspace-dir']) {
    worktreePath = path.resolve(parsed.options['workspace-dir']);
    if (!fs.existsSync(worktreePath)) die(`no workspace directory at ${worktreePath}`, 3);
    if (runGit(worktreePath, ['rev-parse', '--is-inside-work-tree']).status !== 0) {
      die(`workspace is not a git worktree: ${worktreePath}`, 3);
    }
    if (commonGitDir(worktreePath) !== commonGitDir(root)) {
      die(`workspace ${worktreePath} belongs to a different git repository`, 2);
    }
    worktreePath = fs.realpathSync(worktreePath);
    const current = runGit(worktreePath, ['symbolic-ref', '--short', '-q', 'HEAD']).stdout.trim();
    if (current !== branch) {
      if (runGit(worktreePath, ['status', '--porcelain=v1', '--untracked-files=all']).stdout.trim()) {
        die(`workspace ${worktreePath} has uncommitted changes on ${current || 'HEAD'}`, 3);
      }
      const sw = runGit(worktreePath, ['checkout', branch]);
      if (sw.status !== 0) die(`cannot attach ${worktreePath} to ${branch}: ${sw.stderr.trim()}`, 1);
    }
  } else {
    worktreePath = worktreeForBranch(root, branch);
    if (!worktreePath) {
      const defaultWtRoot = path.join(primaryWorktree(root) || root, '.claude', 'worktrees');
      const wtRoot = parsed.options['worktree-root']
        ? path.resolve(parsed.options['worktree-root'])
        : defaultWtRoot;
      fs.mkdirSync(wtRoot, { recursive: true });
      const attemptSuffix = branch.match(/-a\d+$/)?.[0] ?? '';
      worktreePath = path.join(wtRoot, `task-${change}-${taskId}${attemptSuffix}`);
      const addWt = runGit(root, ['worktree', 'add', worktreePath, branch]);
      if (addWt.status !== 0) die(`cannot create worktree ${worktreePath}: ${addWt.stderr.trim()}`, 1);
    }
  }

  const hookArgs = [path.join(HOME, 'pipeline-run.mjs'), 'install-hook', worktreePath];
  if (parsed.options['replace-hooks']) hookArgs.push('--replace-hooks');
  const hookRes = spawnSync(process.execPath, hookArgs, { cwd: root, encoding: 'utf8' });
  if (hookRes.status !== 0) die(`install-hook failed:\n${hookRes.stderr}${hookRes.stdout}`, hookRes.status ?? 1);

  const hydration = parsed.options.hydrate ? hydrateWorktree(worktreePath) : null;
  if (hydration?.attempted && !hydration.ok) {
    console.error(`[pipeline-run] WARN hydration via ${hydration.tool} failed (exit=${hydration.status}): ${hydration.error || 'unknown error'}`);
  }

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
    ...(hydration ? { hydration } : {}),
  };
  if (parsed.options.json) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(`prepared ${taskId}: branch=${branch} worktree=${worktreePath} role=${role} briefKind=${briefKind}`);
    if (hydration) console.log(`hydration: attempted=${hydration.attempted}${hydration.tool ? ` tool=${hydration.tool} ok=${hydration.ok}` : ` reason=${hydration.skippedReason}`}`);
    console.log(`title="${out.title}" label=pipeline.change=${change}`);
  }
} else if (command === 'cp2-merge') {
  let parsed;
  try {
    parsed = parseOptions(rest, {
      base: 'value',
      verify: 'repeat',
      timeout: 'value',
      'skip-drift-verify': 'boolean',
      json: 'boolean',
    });
  } catch (error) { die(error.message); }
  if (parsed.positional.length !== 1) die('cp2-merge needs <change-dir>');
  const timeout = Number(parsed.options.timeout ?? '600000');
  if (!Number.isSafeInteger(timeout) || timeout < 1) die('--timeout must be a positive integer');
  const { resolved: dir, existingDir } = resolveWithExistingRealpath(parsed.positional[0]);
  const change = path.basename(dir);
  const baseBranch = parsed.options.base || 'main';
  const rootRes = runGit(existingDir, ['rev-parse', '--show-toplevel']);
  if (rootRes.status !== 0) die('not a git repository', 3);
  const root = fs.realpathSync(rootRes.stdout.trim());
  const relChangeDir = path.relative(root, dir).split(path.sep).join('/');
  if (!relChangeDir || relChangeDir.startsWith('..') || path.isAbsolute(relChangeDir)) {
    die(`change directory ${dir} is outside repository ${root}`, 3);
  }
  const curBranch = runGit(root, ['symbolic-ref', '--short', 'HEAD']).stdout.trim();
  const dirtyPrimary = runGit(root, ['status', '--porcelain=v1', '--untracked-files=all']).stdout.trim();
  if (dirtyPrimary) die(`working tree is not clean (${dirtyPrimary.split('\n').length} entries); commit/stash other session work first`, 3);
  const integrationBranch = `integration/${change}`;
  if (runGit(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${integrationBranch}`]).status !== 0) {
    die(`missing branch ${integrationBranch}`, 3);
  }
  const intWorktree = worktreeForBranch(root, integrationBranch);
  const baseWorktree = worktreeForBranch(root, baseBranch);
  const targetBaseWt = baseWorktree || (curBranch === baseBranch ? root : null);
  if (!targetBaseWt) die(`checkout ${baseBranch} in a clean worktree before cp2-merge`, 3);
  if (runGit(targetBaseWt, ['status', '--porcelain=v1', '--untracked-files=all']).stdout.trim()) {
    die(`${baseBranch} worktree ${targetBaseWt} has uncommitted changes; aborting merge`, 3);
  }
  const baseShaBefore = runGit(targetBaseWt, ['rev-parse', baseBranch]).stdout.trim();
  const integrationTip = runGit(root, ['rev-parse', integrationBranch]).stdout.trim();
  const readBranchChangeFile = (branchRef, fileName) => {
    if (branchRef === integrationBranch && intWorktree) {
      const onDisk = path.join(intWorktree, relChangeDir, fileName);
      if (fs.existsSync(onDisk)) return fs.readFileSync(onDisk, 'utf8');
    }
    const show = runGit(root, ['show', `${branchRef}:${relChangeDir}/${fileName}`]);
    return show.status === 0 ? show.stdout : null;
  };
  const intTasksMd = readBranchChangeFile(integrationBranch, 'tasks.md');
  if (!intTasksMd) {
    recordEvent('cp2_merge', { tier: '3', ok: false, verdict: 'incomplete_tasks', reasonCode: 'missing_tasks' });
    die(`missing tasks.md on ${integrationBranch}; cannot merge unverified change`, 3);
  }
  const parsedIntTasks = parseTasks(intTasksMd);
  const incompleteTasks = parsedIntTasks.tasks.filter((t) => !t.checked || !t.done);
  if (parsedIntTasks.errors.length || !parsedIntTasks.tasks.length || incompleteTasks.length) {
    recordEvent('cp2_merge', { tier: '3', ok: false, verdict: 'incomplete_tasks', reasonCode: 'incomplete_tasks' });
    const detail = !parsedIntTasks.tasks.length
      ? 'no tasks found'
      : parsedIntTasks.errors.length
        ? `${parsedIntTasks.errors.length} tasks.md error(s)`
        : `incomplete tasks: ${incompleteTasks.map((t) => t.id).join(', ')}`;
    die(`refusing cp2-merge: ${integrationBranch} has ${detail} (every task must be checked Done before CP-2)`, 3);
  }

  const gitCommon = commonGitDir(root);
  const pendingDriftMarker = gitCommon
    ? path.join(gitCommon, `paseo-cp2-pending-${change.replace(/[^A-Za-z0-9._-]/g, '_')}`)
    : null;
  let driftMarker = null;
  if (pendingDriftMarker && fs.existsSync(pendingDriftMarker)) {
    const rawMarker = fs.readFileSync(pendingDriftMarker, 'utf8').trim();
    if (rawMarker) {
      try {
        const obj = JSON.parse(rawMarker);
        driftMarker = obj && typeof obj === 'object' ? obj : { baseSha: rawMarker };
      } catch {
        driftMarker = { baseSha: rawMarker };
      }
    } else {
      driftMarker = {};
    }
  }
  const signoffCwd = intWorktree || root;
  const tipSignoff = findReviewSignoff({
    cwd: signoffCwd,
    changeDir: relChangeDir,
    sha: integrationTip,
    ref: intWorktree ? null : integrationBranch,
    mode: 'final',
  });
  if (tipSignoff?.verdict === 'BLOCKED') {
    recordEvent('cp2_merge', { tier: '3', ok: false, verdict: 'final_blocked', reasonCode: 'final_blocked' });
    die(`FINAL review is BLOCKED on ${integrationBranch} (${integrationTip.slice(0, 7)})`, 3);
  }
  let validFinalSignoff = ['PASS', 'HUMAN_ACCEPT'].includes(tipSignoff?.verdict) ? tipSignoff : null;
  let signedPreSyncSha = validFinalSignoff ? integrationTip : null;
  if (!validFinalSignoff && driftMarker?.signedPreSyncSha) {
    const anc = runGit(root, ['merge-base', '--is-ancestor', driftMarker.signedPreSyncSha, integrationTip]);
    if (anc.status === 0) {
      const preSyncSignoff = findReviewSignoff({
        cwd: signoffCwd,
        changeDir: relChangeDir,
        sha: driftMarker.signedPreSyncSha,
        ref: driftMarker.signedPreSyncSha,
        mode: 'final',
      });
      if (['PASS', 'HUMAN_ACCEPT'].includes(preSyncSignoff?.verdict)) {
        validFinalSignoff = preSyncSignoff;
        signedPreSyncSha = driftMarker.signedPreSyncSha;
      }
    }
  }
  if (!validFinalSignoff) {
    recordEvent('cp2_merge', { tier: '3', ok: false, verdict: 'missing_final_signoff', reasonCode: 'missing_final_signoff' });
    die(`refusing cp2-merge: missing valid FINAL signoff (PASS or HUMAN_ACCEPT) for ${integrationBranch} @ ${integrationTip.slice(0, 7)}`, 3);
  }

  const drifted = runGit(targetBaseWt, ['merge-base', '--is-ancestor', baseShaBefore, integrationBranch]).status !== 0;
  let driftedSynced = Boolean(driftMarker);
  let driftVerified = false;
  const driftVerifyResults = [];
  if (drifted) {
    if (!intWorktree) die(`${baseBranch} advanced past integration base and ${integrationBranch} has no checked-out worktree to sync`, 3);
    if (runGit(intWorktree, ['status', '--porcelain=v1', '--untracked-files=all']).stdout.trim()) {
      die(`integration worktree ${intWorktree} is dirty`, 3);
    }
    const syncMerge = runGit(intWorktree, ['merge', '--no-ff', '--no-edit', baseBranch]);
    if (syncMerge.status !== 0) {
      runGit(intWorktree, ['merge', '--abort']);
      recordEvent('cp2_merge', { tier: '3', ok: false, verdict: 'conflict', reasonCode: 'merge_conflict' });
      die(`${baseBranch} drifted and conflicts with ${integrationBranch}; resolve manually in ${intWorktree} and re-run Verify`, 10);
    }
    driftedSynced = true;
    const preservedSignedSha = driftMarker?.signedPreSyncSha || signedPreSyncSha || integrationTip;
    if (pendingDriftMarker) {
      fs.writeFileSync(pendingDriftMarker, `${JSON.stringify({ baseSha: baseShaBefore, signedPreSyncSha: preservedSignedSha })}\n`);
    }
  }
  if (driftedSynced) {
    if (parsed.options['skip-drift-verify']) {
      if (pendingDriftMarker && fs.existsSync(pendingDriftMarker)) fs.unlinkSync(pendingDriftMarker);
    } else {
      if (!intWorktree) {
        recordEvent('cp2_merge', { tier: '3', ok: false, verdict: 'missing_int_wt', reasonCode: 'missing_int_wt' });
        die(`pending post-drift Verify requires a checked-out worktree for ${integrationBranch}; check it out, verify, and retry cp2-merge`, 3);
      }
      if (runGit(intWorktree, ['status', '--porcelain=v1', '--untracked-files=all']).stdout.trim()) {
        recordEvent('cp2_merge', { tier: '3', ok: false, verdict: 'dirty_int_wt', reasonCode: 'dirty_int_wt' });
        die(`integration worktree ${intWorktree} is dirty; commit or clean changes before retrying cp2-merge`, 3);
      }
      const verifyCwd = intWorktree;
      const cmds = [...(parsed.options.verify ?? [])];
      const intChangeDir = path.join(verifyCwd, 'openspec', 'changes', change);
      if (!cmds.length) {
        const accFile = path.join(intChangeDir, 'acceptance.md');
        if (fs.existsSync(accFile)) {
          const table = parseAcceptanceTable(fs.readFileSync(accFile, 'utf8'));
          for (const row of table.rows) {
            if (/^yes$/i.test(row.required) && row.verify && !cmds.includes(row.verify)) cmds.push(row.verify);
          }
        }
      }
      if (!cmds.length) {
        const tasksFile = path.join(intChangeDir, 'tasks.md');
        if (fs.existsSync(tasksFile)) {
          const parsedTasks = parseTasks(fs.readFileSync(tasksFile, 'utf8'));
          for (const t of parsedTasks.tasks) {
            const v = String(t.verify || '').replace(/^`(.+)`$/, '$1').trim();
            if (v && !cmds.includes(v)) cmds.push(v);
          }
        }
      }
      const unprovable = cmds.map((c) => ({ c, ...proveVerifyCommand(c) })).filter((r) => !r.ok);
      if (!cmds.length || unprovable.length) {
        recordEvent('cp2_merge', { tier: '3', ok: false, verdict: 'drift_unverified', reasonCode: 'verify_unprovable' });
        const detail = !cmds.length
          ? 'no Verify commands found in --verify, acceptance.md, or tasks.md'
          : `unprovable Verify command(s): ${unprovable.map((u) => u.c).join(', ')}`;
        die(`synced ${baseBranch} drift into ${integrationBranch}, but refusing to fast-forward ${baseBranch} unverified (${detail}); run Verify in ${verifyCwd} or re-run cp2-merge with --verify "<cmd>"`, 20);
      }
      for (const cmd of cmds) {
        const res = await runVerifyCommand(cmd, { cwd: verifyCwd, timeout, streamToStdout: !parsed.options.json });
        driftVerifyResults.push({ command: cmd, ok: res.ok, status: res.status, durationMs: res.durationMs });
        if (!res.ok) {
          recordEvent('cp2_merge', { tier: '3', ok: false, verdict: 'drift_verify_failed', reasonCode: 'verify_failed' });
          die(`synced ${baseBranch} drift into ${integrationBranch}, but post-sync Verify failed (command=${cmd}, status=${res.status}); ${baseBranch} was NOT updated — fix in ${verifyCwd} before merging`, 20);
        }
      }
      if (pendingDriftMarker && fs.existsSync(pendingDriftMarker)) fs.unlinkSync(pendingDriftMarker);
      driftVerified = true;
    }
  }
  const ff = runGit(targetBaseWt, ['merge', '--ff-only', integrationBranch]);
  if (ff.status !== 0) {
    recordEvent('cp2_merge', { tier: '3', ok: false, verdict: 'ff_failed', reasonCode: 'ff_failed' });
    die(`fast-forward merge into ${baseBranch} failed: ${ff.stderr}`, 1);
  }
  const mergedSha = runGit(targetBaseWt, ['rev-parse', 'HEAD']).stdout.trim();
  recordEvent('cp2_merge', { tier: '3', ok: true, verdict: driftedSynced ? 'drift_synced' : 'clean', count: driftVerifyResults.length });
  const payload = { change, base: baseBranch, rollbackSha: baseShaBefore, mergedSha, driftedSynced, driftVerified, driftVerifyResults };
  if (parsed.options.json) console.log(JSON.stringify(payload, null, 2));
  else console.log(`cp2-merge ok: ${integrationBranch} -> ${baseBranch} @ ${mergedSha.slice(0, 7)} (rollback=${baseShaBefore.slice(0, 7)}${driftedSynced ? `, synced main drift & verified (${driftVerifyResults.length} cmd)` : ''})`);
} else if (command === 'status') {
  let parsed;
  try { parsed = parseOptions(rest, { json: 'boolean' }); } catch (error) { die(error.message); }
  if (parsed.positional.length > 1) die('status accepts one <change-dir>');
  const dir = changeDirOf(parsed.positional[0]);
  const change = path.basename(dir);
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
  die('usage: pipeline-run.mjs plan|prepare-author|prepare-task|hydrate|record-review|merge|cp2-merge|status|cleanup|inspect|freeze|profiles|preflight|scenarios|acceptance|worker-check|tier2-verify|brief|risk-scan|install-hook|report ...', 2);
}
