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
//   pipeline-run.mjs prepare-author <change-dir> [--repo <path>] [--hydrate] [--base main] [--json]
//   pipeline-run.mjs prepare-task <change-dir> <task-id> [--worktree-root <dir>] [--workspace-dir <dir>] [--hydrate] [--json]
//   pipeline-run.mjs cp2-merge <change-dir> [--base main] [--json]
//   pipeline-run.mjs brief <role> --change <name> --repo <path> ...
//   pipeline-run.mjs worker-check <change-dir> <task-id> [--timeout ms] [--allow-test-infra]
//   pipeline-run.mjs tier2-verify <base> [--change-dir <dir>] [--verify <cmd>]... [--auto-verify] [--cwd <dir>] [--json]
//   pipeline-run.mjs risk-scan <base> [<head>] [--cwd <dir>] [--working-tree] [--json] [--require-clean]
//   pipeline-run.mjs install-hook <worktree> [<worktree>...]
//   pipeline-run.mjs report [--days N] [--json]

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseTasks } from './lib/tasks.mjs';
import { readTasksMarkdown } from './lib/tasks-source.mjs';
import { runGit, listWorktreesMaybe, worktreeForBranch, primaryWorktree } from './lib/git.mjs';
import { parseOptions, planOptions } from './lib/cli.mjs';
import { runCleanup } from './lib/cleanup.mjs';
import { recommendedWorkerRole } from './lib/roles.mjs';
import { summarizeTelemetry } from './lib/telemetry.mjs';

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
    const configured = runGit(undefined, ['-C', tree.path, 'config', '--worktree', '--get', 'core.hooksPath']);
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
    if (summary.topReasonCodes.length) {
      console.log(`- top reasons: ${summary.topReasonCodes.slice(0, 8).map((r) => `${r.code}=${r.count}`).join(', ')}`);
    }
  }
  process.exit(0);
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
      hydrate: 'boolean',
      base: 'value',
      json: 'boolean',
    });
  } catch (error) { die(error.message); }
  if (parsed.positional.length !== 1) die('prepare-author needs <change-dir>');
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
    fs.writeFileSync(openspecYaml, `schema: paseo-pipeline\ncreated: ${new Date().toISOString().slice(0, 10)}\n`);
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
  const stage0Block = [
    '<!-- STAGE0:START -->',
    `- Generated: ${new Date().toISOString()} | Change: \`${change}\` | Branch: \`${branch}\` | HEAD: \`${head.slice(0, 12)}\` | Dirty: ${dirtyCount}`,
    `- Drift: ${driftLine}`,
    `- Preflight: ${preflightSummary}${hydration ? ` | Hydration: ${hydration.ok ? 'ok' : hydration.skippedReason || `exit=${hydration.status}`}` : ''}`,
    `- Namespace prefixes: ${nsSummary}`,
    `- Entropy check: rules=${ruleCount}/10, capabilities=${capabilityCount}/2 (${splitRecommended ? `SPLIT_RECOMMENDED: ${splitReasons.join(', ')}` : 'ok'})`,
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
    }
  }
  const fullFacts = `# Baseline Facts\n\n${stage0Block}\n\n${preservedBody}\n`;
  fs.writeFileSync(factsPath, fullFacts);

  const payload = {
    change,
    changeDir: dir,
    repo: root,
    head,
    branch,
    dirtyCount,
    drift,
    ...(hydration ? { hydration } : {}),
    preflight: { exit: preflightRes.status, ...(preflightRes.data ? { findings: preflightRes.data.findings?.length ?? 0 } : {}) },
    namespace: { exit: namespaceRes.status, prefixes: namespaceRes.data?.scenarios?.length ?? 0 },
    baselineFactsPath: factsPath,
    splitRecommended,
    splitReasons,
    ...(!branch.startsWith('author/') ? { worktreeNote: 'If dispatching hanlin in a separate branch-off worktree, pass/sync baseline-facts.md and remove untracked Stage 0 seeds from the default branch before CP-1 --ff-only merge.' } : {}),
  };
  if (parsed.options.json) console.log(JSON.stringify(payload, null, 2));
  else {
    console.log(`[prepare-author] ${change} @ ${head.slice(0, 7)} (${branch}, dirty=${dirtyCount})`);
    console.log(`- baseline-facts: ${factsPath}`);
    console.log(`- drift: ${driftLine}`);
    console.log(`- preflight: ${preflightSummary} | namespace prefixes: ${nsSummary}`);
    if (splitRecommended) console.log(`SPLIT_RECOMMENDED: ${splitReasons.join(', ')}`);
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
  const branch = refs.at(-1) ?? `task/${change}/${taskId}`;
  if (!refs.length) {
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
      worktreePath = path.join(wtRoot, `task-${change}-${taskId}`);
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
  const intWorktree = worktreeForBranch(root, integrationBranch);
  const baseWorktree = worktreeForBranch(root, baseBranch);
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
  die('usage: pipeline-run.mjs plan|prepare-author|prepare-task|merge|cp2-merge|status|cleanup|inspect|freeze|profiles|preflight|scenarios|acceptance|worker-check|tier2-verify|brief|risk-scan|install-hook|report ...', 2);
}
