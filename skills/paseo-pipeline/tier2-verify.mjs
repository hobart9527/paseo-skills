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
import { loadSpecTree, scanScenVerify } from './lib/spec-scan.mjs';
import { parseTasks } from './lib/tasks.mjs';
import { runVerifyCommand } from './lib/verify-runner.mjs';
import { proveVerifyCommand } from './lib/verify-policy.mjs';
import { scanRepo } from './lib/risk-scan.mjs';
import { recordEvent } from './lib/telemetry.mjs';

const usage = 'Usage: tier2-verify.mjs <base> [--change-dir <dir>] [--verify <cmd>]... [--auto-verify] [--cwd <dir>] [--timeout ms] [--json]';

let parsed;
try {
  parsed = parseOptions(process.argv.slice(2), {
    'change-dir': 'value',
    verify: 'repeat',
    'auto-verify': 'boolean',
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
let contractChecked = false;
let openSpecStrictExit = null;
let openSpecStrictError = null;
let autoDiscoveredVerify = [];

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
  const tasksFile = path.join(changeDir, 'tasks.md');
  const taskVerifyByScen = new Map();
  if (fs.existsSync(tasksFile)) {
    const parsedTasks = parseTasks(fs.readFileSync(tasksFile, 'utf8'));
    for (const task of parsedTasks.tasks) {
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
  const changeName = path.basename(changeDir);
  const osCheck = spawnSync('openspec', ['validate', changeName, '--strict'], { cwd: ctx.root, encoding: 'utf8' });
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

const unprovableVerify = [];
const provableCommands = [];
for (const cmd of verifyCommands) {
  const proved = proveVerifyCommand(cmd);
  if (!proved.ok) unprovableVerify.push({ command: cmd, reason: proved.reason });
  else provableCommands.push(proved.command);
}

const verifyResults = [];
let allVerifyPassed = missingVerify.length === 0 && verifyCommands.length > 0 && unprovableVerify.length === 0;
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

const risk = scanRepo({ cwd, base, workingTree: Boolean(dirty) });
const isolatedWorktree = !ctx.isPrimary;
const contractOk = !contractChecked || (!openSpecStrictError && openSpecStrictExit === 0);
const ok = isolatedWorktree && !dirty && allVerifyPassed && contractOk;
const verdict = !ok ? 'FAIL' : (risk.reviewRequired ? 'REVIEW_REQUIRED' : 'PASS');

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
        : (!contractOk ? 'openspec_invalid' : (!allVerifyPassed ? 'verify_failed' : undefined)))),
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
  autoDiscoveredVerify,
  missingVerify,
  unprovableVerify,
  verifyResults,
  risk,
};

if (parsed.options.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`[tier2-verify] ${ctx.branch || 'detached'} @ ${tip.slice(0, 7)} (base ${risk.base.slice(0, 7)})`);
  console.log(`isolatedWorktree=${isolatedWorktree} clean=${!dirty} verifies=${verifyResults.length} riskReviewRequired=${risk.reviewRequired}`);
  if (!isolatedWorktree) console.error('FAIL: Tier 2 delivery is on primary checkout instead of a linked worktree');
  if (dirty) console.error('FAIL: worktree has uncommitted changes');
  if (contractChecked && !contractOk) {
    console.error(`FAIL: openspec validate --strict failed (exit=${openSpecStrictExit ?? 'unavailable'}${openSpecStrictError ? `: ${openSpecStrictError}` : ''})`);
  }
  if (missingVerify.length) console.error(`FAIL: scenarios missing **Verify:**: ${missingVerify.join(', ')}`);
  for (const bad of unprovableVerify) console.error(`FAIL: unprovable Verify command "${bad.command}": ${bad.reason}`);
  if (!verifyCommands.length) {
    console.error(`FAIL: no Verify commands supplied or extracted from specs.\nHINT: for Contract: none, pass \`--verify "<cmd>"\` or \`--auto-verify\` (e.g. pipeline-run.mjs tier2-verify ${base} --verify "<cmd>")`);
  }
  for (const r of verifyResults) console.log(`${r.ok ? 'PASS' : 'FAIL'} verify (${r.durationMs}ms): ${r.command}`);
  if (risk.reviewRequired) {
    console.log(`REVIEW_REQUIRED: classes=[${risk.classes.join(', ')}] testMutations=${risk.testMutations.length} -> run 1+1 independent reviewer (docs/tier2-reviewer-brief.md)`);
  }
  console.log(`RESULT tier2-verify: ${verdict}`);
}

process.exit(ok ? 0 : 1);
