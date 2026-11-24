#!/usr/bin/env node
// Unified Tier 2 delivery gate (applies identically to main-session-in-worktree and /tier2-handoff).
// Verifies isolation, OpenSpec contract & scenario Verify commands (plus F-1..F-7 provability),
// executes every Verify command at the current tip SHA, and runs risk-scan to decide if review is mandatory.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseOptions } from './lib/cli.mjs';
import { runGit } from './lib/git.mjs';
import { repoContext } from './lib/tier-gate.mjs';
import { loadSpecTree, scanScenVerify, analyzeSpecTree, findStaleChanges } from './lib/spec-scan.mjs';
import { parseTasks, isFileWithinScopes } from './lib/tasks.mjs';
import { runVerifyCommand } from './lib/verify-runner.mjs';
import { proveVerifyCommand } from './lib/verify-policy.mjs';
import { scanRepo } from './lib/risk-scan.mjs';
import { findReviewSignoff } from './lib/review-record.mjs';
import { recordEvent } from './lib/telemetry.mjs';

const usage = 'Usage: tier2-verify.mjs <base> [--change-dir <dir>] [--verify <cmd>]... [--auto-verify] [--strict-scope] [--cwd <dir>] [--timeout ms] [--json]';

let parsed;
try {
  parsed = parseOptions(process.argv.slice(2), {
    'change-dir': 'value',
    verify: 'repeat',
    'auto-verify': 'boolean',
    'strict-scope': 'boolean',
    cwd: 'value',
    timeout: 'value',
    json: 'boolean',
  });
} catch (error) {
  console.error(`[tier2-verify] ${error.message}\n${usage}`);
  process.exit(2);
}

const [base] = parsed.positional;
if (!base || parsed.positional.length > 1) {
  console.error(usage);
  process.exit(2);
}

const cwd = path.resolve(parsed.options.cwd || process.cwd());
const timeout = Number(parsed.options.timeout ?? '300000');
const ctx = repoContext(cwd);
if (!ctx) {
  console.error(`[tier2-verify] not a git repository: ${cwd}`);
  process.exit(2);
}

const tipRes = runGit(cwd, ['rev-parse', 'HEAD']);
if (tipRes.status !== 0) {
  console.error('[tier2-verify] cannot resolve HEAD');
  process.exit(2);
}
const tip = tipRes.stdout.trim();
const dirty = runGit(cwd, ['status', '--porcelain=v1', '--untracked-files=all']).stdout.trim();

const verifyCommands = [...(parsed.options.verify ?? [])];
const missingVerify = [];
const specProblems = [];
const duplicateScenarios = [];
const collidingScenarios = [];
const taskErrors = [];
const undeclaredClaims = [];
const unclaimedScenarios = [];
const uncheckedTasks = [];
const scopeDrift = [];
const advisories = [];
let contractChecked = false;
let openSpecStrictExit = null;
let openSpecStrictError = null;
let autoDiscoveredVerify = [];
let scopeUnion = [];
let currentChangeName = null;

function discoverPackageVerifyCommands(rootDir, baseRef) {
  const diffRes = runGit(rootDir, ['diff', '--name-only', `${baseRef}...HEAD`]);
  const changed = diffRes.status === 0 ? diffRes.stdout.split(/\r?\n/).filter(Boolean) : [];
  if (!changed.length) return [];
  const pkgDirs = new Set();
  for (const rel of changed) {
    let dir = path.dirname(path.resolve(rootDir, rel));
    while (dir.startsWith(rootDir)) {
      const pkg = path.join(dir, 'package.json');
      if (fs.existsSync(pkg)) { pkgDirs.add(dir); break; }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  const cmds = [];
  for (const dir of [...pkgDirs].sort()) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      const testScript = pkg?.scripts?.test;
      if (typeof testScript === 'string' && testScript.trim() && !/no test specified/i.test(testScript)) {
        const relDir = path.relative(rootDir, dir) || '.';
        cmds.push(relDir === '.' ? 'npm test' : `npm --prefix ${JSON.stringify(relDir)} test`);
      }
    } catch {}
  }
  return cmds;
}

const startedAt = Date.now();
const changeDir = parsed.options['change-dir'] ? path.resolve(cwd, parsed.options['change-dir']) : null;
if (changeDir) {
  if (!fs.existsSync(changeDir)) {
    console.error(`[tier2-verify] missing change directory: ${changeDir}`);
    process.exit(2);
  }
  contractChecked = true;
  currentChangeName = path.basename(changeDir);
  const tasksFile = path.join(changeDir, 'tasks.md');
  const taskVerifyByScen = new Map();
  const claimedScens = new Set();
  let hasTasks = false;
  let parsedTasksData = null;
  if (fs.existsSync(tasksFile)) {
    parsedTasksData = parseTasks(fs.readFileSync(tasksFile, 'utf8'));
    hasTasks = parsedTasksData.tasks.length > 0;
    // MISSING_VERIFY in tasks.md is allowed when specs/ carries legacy - **Verify:**; missingVerify enforces the union.
    for (const err of parsedTasksData.errors) {
      if (err.code !== 'MISSING_VERIFY') taskErrors.push(`${err.code}${err.task ? ` ${err.task}` : ''}: ${err.message}`);
    }
    for (const task of parsedTasksData.tasks) {
      if (!task.checked) uncheckedTasks.push(task.id);
      for (const s of task.scope || []) scopeUnion.push(s);
      for (const scen of task.scenarios) claimedScens.add(scen.toUpperCase());
      const cmd = String(task.verify || '').replace(/^`(.+)`$/, '$1').trim();
      if (!cmd) continue;
      for (const scen of task.scenarios) {
        const key = scen.toUpperCase();
        if (!taskVerifyByScen.has(key)) taskVerifyByScen.set(key, []);
        if (!taskVerifyByScen.get(key).includes(cmd)) taskVerifyByScen.get(key).push(cmd);
      }
    }
  }
  const specTree = loadSpecTree({ repoRoot: ctx.root, changeDir });
  const specAnalysis = analyzeSpecTree({ specTree, changeDir, repoRoot: ctx.root });
  for (const p of specAnalysis.problems) specProblems.push(p.blocking);
  duplicateScenarios.push(...specAnalysis.duplicates);
  collidingScenarios.push(...specAnalysis.collisions);
  advisories.push(...specAnalysis.advisories);

  if (hasTasks && specAnalysis.declared.size > 0 && parsedTasksData) {
    for (const task of parsedTasksData.tasks) {
      for (const scen of task.scenarios) {
        if (!specAnalysis.declared.has(scen.toUpperCase())) undeclaredClaims.push(`${task.id}: ${scen}`);
      }
    }
    for (const [scen, file] of specAnalysis.declared) {
      if (!claimedScens.has(scen)) unclaimedScenarios.push(`${scen} (${file})`);
    }
  }

  try {
    const metaPath = path.join(changeDir, '.openspec.yaml');
    if (fs.existsSync(metaPath) && !fs.existsSync(path.join(changeDir, 'proposal.md'))) {
      const meta = fs.readFileSync(metaPath, 'utf8');
      if (/^schema:\s*paseo-pipeline\s*$/m.test(meta)) {
        advisories.push('ADVISORY_TIER2_SCHEMA: .openspec.yaml uses schema: paseo-pipeline without proposal.md; use schema: paseo-tier2 so openspec status stays clean');
      }
    }
  } catch {}

  for (const { file, text } of specTree.current) {
    for (const scen of scanScenVerify(text)) {
      const fromTask = taskVerifyByScen.get(scen.id.toUpperCase()) ?? [];
      if (fromTask.length > 0) {
        for (const cmd of fromTask) {
          if (!verifyCommands.includes(cmd)) verifyCommands.push(cmd);
        }
      } else if (scen.verify) {
        const cleanVerify = scen.verify.replace(/^`(.+)`$/, '$1').trim();
        if (!verifyCommands.includes(cleanVerify)) verifyCommands.push(cleanVerify);
      } else {
        missingVerify.push(`${scen.id} (${path.relative(changeDir, file)})`);
      }
    }
  }
  const osCheck = spawnSync('openspec', ['validate', currentChangeName, '--strict'], { cwd: ctx.root, encoding: 'utf8' });
  if (osCheck.error) {
    openSpecStrictError = osCheck.error.message;
  } else {
    openSpecStrictExit = osCheck.status;
    if (osCheck.status !== 0 && osCheck.stderr) openSpecStrictError = osCheck.stderr.trim();
  }
} else if (!verifyCommands.length && parsed.options['auto-verify']) {
  autoDiscoveredVerify = discoverPackageVerifyCommands(ctx.root, base);
  for (const cmd of autoDiscoveredVerify) verifyCommands.push(cmd);
}

const stale = findStaleChanges(ctx.root, currentChangeName);
if (stale.advisory) advisories.push(stale.advisory);

if (changeDir && scopeUnion.length > 0) {
  const diffRes = runGit(ctx.root, ['diff', '--name-only', '-z', dirty ? base : `${base}...HEAD`]);
  if (diffRes.status === 0) {
    const relChangePrefix = `${path.relative(ctx.root, changeDir).split(path.sep).join('/')}/`;
    const changedFiles = (diffRes.stdout || '').split('\0').filter(Boolean);
    for (const file of changedFiles) {
      const normalized = file.replace(/\\/g, '/');
      if (normalized.startsWith(relChangePrefix)) continue;
      if (!isFileWithinScopes(normalized, scopeUnion)) scopeDrift.push(normalized);
    }
    if (scopeDrift.length > 0) {
      advisories.push(`ADVISORY_SCOPE_DRIFT: changed file(s) outside tasks.md Write scope: ${scopeDrift.slice(0, 8).join(', ')}`);
    }
  }
}

const unprovableVerify = [];
const provableCommands = [];
for (const cmd of verifyCommands) {
  const proved = proveVerifyCommand(cmd);
  if (!proved.ok) unprovableVerify.push({ command: cmd, reason: proved.reason });
  else provableCommands.push(proved.command);
}

const isolatedWorktree = !ctx.isPrimary;
const scopeOk = !parsed.options['strict-scope'] || scopeDrift.length === 0;
const contractSemanticOk = !specProblems.length && !duplicateScenarios.length && !collidingScenarios.length
  && !taskErrors.length && !undeclaredClaims.length && !unclaimedScenarios.length && scopeOk;
const contractOk = !contractChecked || (!openSpecStrictError && openSpecStrictExit === 0 && contractSemanticOk);
const prechecksOk = isolatedWorktree && !dirty && contractOk && missingVerify.length === 0
  && verifyCommands.length > 0 && unprovableVerify.length === 0;

const verifyResults = [];
let allVerifyPassed = prechecksOk;
if (prechecksOk) {
  for (const cmd of provableCommands) {
    const res = await runVerifyCommand(cmd, { cwd, timeout, streamToStdout: !parsed.options.json });
    verifyResults.push({
      command: cmd,
      ok: res.ok,
      status: res.status,
      dirtyChanged: res.dirtyChanged,
      durationMs: res.durationMs,
      missingDependency: res.missingDependency,
    });
    if (!res.ok) allVerifyPassed = false;
  }
}

const risk = scanRepo({ cwd, base, head: dirty ? null : tip, workingTree: Boolean(dirty) });
const reviewSignoff = findReviewSignoff({ cwd, changeDir, sha: tip, mode: 'tier2' });
const reviewBlocked = reviewSignoff?.verdict === 'BLOCKED';
const reviewSatisfied = !risk.reviewRequired || ['PASS', 'HUMAN_ACCEPT'].includes(reviewSignoff?.verdict);
const ok = prechecksOk && allVerifyPassed && !reviewBlocked;
const verdict = !ok ? 'FAIL' : (reviewSatisfied ? 'PASS' : 'REVIEW_REQUIRED');

recordEvent('tier2_verify', {
  tier: '2',
  verdict,
  ok,
  durationMs: Date.now() - startedAt,
  riskClasses: risk.classes,
  unprovableCount: unprovableVerify.length,
  reasonCode: !isolatedWorktree ? 'not_worktree'
    : (dirty ? 'dirty_worktree'
      : (unprovableVerify.length ? 'unprovable_verify'
        : (!scopeOk ? 'scope_drift'
          : (!contractOk ? (collidingScenarios.length ? 'colliding_scen' : (taskErrors.length ? 'tasks_invalid' : 'openspec_invalid'))
            : (!allVerifyPassed ? 'verify_failed'
              : (reviewBlocked ? 'review_blocked' : undefined)))))),
});

const report = {
  verdict,
  repo: ctx.root,
  branch: ctx.branch,
  isolatedWorktree,
  clean: !dirty,
  base: risk.base,
  tip,
  contractChecked,
  openSpecStrictExit,
  openSpecStrictError,
  specProblems,
  duplicateScenarios,
  collidingScenarios,
  taskErrors,
  undeclaredClaims,
  unclaimedScenarios,
  uncheckedTasks,
  scopeDrift,
  staleChanges: stale.names,
  advisories,
  autoDiscoveredVerify,
  missingVerify,
  unprovableVerify,
  verifyResults,
  reviewSignoff,
  risk,
};

if (parsed.options.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`[tier2-verify] ${ctx.branch || 'detached'} @ ${tip.slice(0, 7)} (base ${risk.base.slice(0, 7)})`);
  console.log(`isolatedWorktree=${isolatedWorktree} clean=${!dirty} verifies=${verifyResults.length} riskReviewRequired=${risk.reviewRequired}`);
  if (!isolatedWorktree) console.error('FAIL: Tier 2 delivery is on primary checkout instead of a linked worktree');
  if (dirty) {
    const dirtyLines = dirty.split(/\r?\n/).filter(Boolean);
    const sample = dirtyLines.slice(0, 5).map((l) => l.trim()).join(', ');
    console.error(`FAIL: worktree has uncommitted changes (${dirtyLines.length}: ${sample}${dirtyLines.length > 5 ? ', ...' : ''})\nHINT: run \`git status --short\`, commit intended changes (or clean untracked scratch files), then re-run tier2-verify.`);
  }
  if (contractChecked && (openSpecStrictError || openSpecStrictExit !== 0)) {
    console.error(`FAIL: openspec validate --strict failed (exit=${openSpecStrictExit ?? 'unavailable'}${openSpecStrictError ? `: ${openSpecStrictError}` : ''})`);
  }
  for (const item of [...specProblems, ...duplicateScenarios, ...collidingScenarios, ...taskErrors]) console.error(`FAIL: ${item}`);
  if (!scopeOk) console.error(`FAIL: --strict-scope rejected files outside Write scope: ${scopeDrift.join(', ')}`);
  if (undeclaredClaims.length) console.error(`FAIL: tasks.md claims undeclared scenarios: ${undeclaredClaims.join(', ')}`);
  if (unclaimedScenarios.length) console.error(`FAIL: specs declare unclaimed scenarios: ${unclaimedScenarios.join(', ')}`);
  if (missingVerify.length) console.error(`FAIL: scenarios missing **Verify:**: ${missingVerify.join(', ')}`);
  for (const bad of unprovableVerify) console.error(`FAIL: unprovable Verify command "${bad.command}": ${bad.reason}`);
  if (!verifyCommands.length) {
    console.error(`FAIL: no Verify commands supplied or extracted from specs.\nHINT: for Contract: none, pass \`--verify "<cmd>"\` or \`--auto-verify\` (e.g. pipeline-run.mjs tier2-verify ${base} --verify "<cmd>")`);
  }
  for (const adv of advisories) console.log(`ADVISE: ${adv}`);
  if (uncheckedTasks.length) console.log(`WARN: unchecked tasks in tasks.md: ${uncheckedTasks.join(', ')}`);
  for (const r of verifyResults) console.log(`${r.ok ? 'PASS' : 'FAIL'} verify (${r.durationMs}ms): ${r.command}`);
  if (reviewBlocked) {
    console.error(`FAIL: Tier 2 review BLOCKED (${reviewSignoff.reviewer}@${tip.slice(0, 7)}${reviewSignoff.reason ? `: ${reviewSignoff.reason}` : ''})`);
  }
  if (risk.reviewRequired) {
    if (reviewSignoff) {
      console.log(`REVIEW_RECORDED: ${reviewSignoff.verdict} (${reviewSignoff.reviewer}@${tip.slice(0, 7)})`);
    }
    if (!reviewSatisfied) {
      console.log(`REVIEW_REQUIRED: classes=[${risk.classes.join(', ')}] testMutations=${risk.testMutations.length} -> run 1+1 independent reviewer (\`pipeline-run.mjs brief tier2-review ${currentChangeName ? `--change ${currentChangeName} ` : ''}--base ${base} --repo .\`) and record with \`pipeline-run.mjs record-review --mode tier2\``);
    }
  }
  console.log(`RESULT tier2-verify: ${verdict}`);
}

process.exit(ok ? 0 : 1);
