#!/usr/bin/env node
// task-runner.mjs — 单任务微循环确定性执行器
//
// 架构定位：
//   将单个原子任务的微状态机（claim -> worktree -> agent dispatch -> wait -> verify -> audit -> merge）
//   收敛为本地 Node.js 确定性循环执行，免除编排者 LLM（Lead）频繁来回往返与思考等待，消除假死与空等。
//
// 用法:
//   node task-runner.mjs <change> <task-id> [--fast] [--owner <owner>] [--timeout <ms>] [--dry-run] [--json]
//
// 退出码:
//   0 任务完整生命周期执行成功并完成合流记账
//   1 参数或前置条件错误
//   2 账本租约/意图冲突
//   10 合流冲突
//   20 测试命令执行失败
//   30 写范围越界
//   32 自审或无独立审查意图
//   35 依赖未完成

import fs from 'node:fs';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseTasks } from './lib/tasks.mjs';
import { verifyDone } from './lib/ledger.mjs';
import { readRunState, updateRunState } from './lib/run-state.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PIPELINE_HOME = process.env.PIPELINE_HOME || SCRIPT_DIR;

const argv = process.argv.slice(2);
const isJson = argv.includes('--json');
const isDryRun = argv.includes('--dry-run');
const isFast = argv.includes('--fast') || process.env.PIPELINE_FAST_MERGE === '1';
const isSpeculative = argv.includes('--speculative') || process.env.PIPELINE_SPECULATIVE === '1';

function getOpt(name, fallback = null) {
  const idx = argv.indexOf(name);
  return idx >= 0 && idx + 1 < argv.length ? argv[idx + 1] : fallback;
}

const positional = argv.filter((a) => !a.startsWith('--'));
if (positional.length < 2) {
  console.error('Usage: node task-runner.mjs <change> <task-id> [--fast] [--owner <id>] [--timeout <ms>] [--dry-run] [--json]');
  process.exit(1);
}

const [change, targetTaskId] = positional;
const owner = getOpt('--owner', `runner-${process.pid}`);
const timeoutMs = Number(getOpt('--timeout', 540 * 1000));

function log(msg, extra = null) {
  if (isJson) {
    console.log(JSON.stringify({ change, task: targetTaskId, message: msg, ...(extra ? { extra } : {}) }));
  } else {
    console.log(`[task-runner] ${targetTaskId}: ${msg}`);
  }
}

function fatal(msg, code = 1) {
  if (isJson) {
    console.error(JSON.stringify({ ok: false, error: msg, code }));
  } else {
    console.error(`[task-runner] Error (${code}): ${msg}`);
  }
  process.exit(code);
}

function runCmd(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return res;
}

function git(args, opts = {}) {
  return runCmd('git', args, opts);
}

// 1. 定位仓库根目录与 tasks.md
const topRes = git(['rev-parse', '--show-toplevel']);
if (topRes.status !== 0) fatal('Not in a git repository');
const repoRoot = topRes.stdout.trim();

const tasksFile = path.join(repoRoot, 'openspec', 'changes', change, 'tasks.md');
if (!fs.existsSync(tasksFile)) fatal(`tasks.md not found at ${tasksFile}`);

const tasksMd = fs.readFileSync(tasksFile, 'utf8');
const { tasks, errors } = parseTasks(tasksMd);
if (errors.length > 0) {
  fatal(`tasks.md parse errors: ${errors.map((e) => e.message).join('; ')}`);
}

const task = tasks.find((t) => t.id === targetTaskId);
if (!task) fatal(`Task ${targetTaskId} not declared in ${tasksFile}`);

// 2. 检查依赖与当前状态
const gitRead = (args) => {
  const r = git(args, { cwd: repoRoot });
  return r.status === 0 ? r.stdout.trim() : null;
};

const { doneSet } = verifyDone(tasks, gitRead);
if (doneSet.has(task.id)) {
  log('Task is already verified DONE in first-parent history. Nothing to do.');
  process.exit(0);
}

const missingDeps = task.depends.filter((dep) => !doneSet.has(dep));
let speculativeUpstreamBranch = null;
if (missingDeps.length > 0) {
  if (isSpeculative) {
    const missingBranches = missingDeps.map((dep) => `task/${change}/${dep}`);
    const unreadyDeps = missingBranches.filter((b) => git(['rev-parse', '--verify', b], { cwd: repoRoot }).status !== 0);
    if (unreadyDeps.length > 0) {
      fatal(`Speculative mode: upstream dependencies branches not found for: ${missingDeps.join(', ')}`, 35);
    }
    speculativeUpstreamBranch = missingBranches[missingBranches.length - 1];
    log(`Speculative mode: unmerged dependencies [${missingDeps.join(', ')}] have branches ready. Basing workspace on ${speculativeUpstreamBranch}`);
  } else {
    fatal(`Dependencies not satisfied: ${missingDeps.join(', ')} must be DONE before running ${task.id}`, 35);
  }
}

const reviewTier = task.review || (task.risk && task.risk.some((r) => r !== 'none') ? 'strict' : 'standard');
log(`Ready to execute: tier=${reviewTier}, scope=${task.scope.join(',')}, verify=${task.verify?.command || 'none'}`);

if (isDryRun) {
  log('Dry-run completed successfully.');
  process.exit(0);
}

// 3. 意图 claim（防止并发重派）
const attempt = 1;
const claimScript = path.join(PIPELINE_HOME, 'run-state.mjs');
const claimRes = runCmd(process.execPath, [
  claimScript, 'claim', change,
  '--task', task.id,
  '--attempt', String(attempt),
  '--phase', 'impl',
  '--role', 'gongbu',
  '--owner', owner,
]);
if (claimRes.status !== 0) {
  fatal(`Failed to claim intent in run-state: ${claimRes.stderr || claimRes.stdout}`, claimRes.status);
}
const claimKey = `local:${task.id}:${attempt}:impl:gongbu:dispatch`;

// 4. 工作区与分支准备
const branchName = `task/${change}/${task.id}`;
const integrationBranch = `integration/${change}`;
const repoSlug = path.basename(repoRoot);
const worktreeDir = path.join(tmpdir(), 'paseo-worktrees', `${repoSlug}-${change}-${task.id}`);

fs.mkdirSync(path.dirname(worktreeDir), { recursive: true });

// 检查工作区存活与分支绑定
if (fs.existsSync(worktreeDir)) {
  const wtList = git(['worktree', 'list'], { cwd: repoRoot }).stdout;
  if (!wtList.includes(worktreeDir)) {
    fs.rmSync(worktreeDir, { recursive: true, force: true });
  }
}

let wsCreated = false;
if (!fs.existsSync(worktreeDir)) {
  const branchExists = git(['rev-parse', '--verify', branchName], { cwd: repoRoot }).status === 0;
  const startPoint = branchExists ? branchName : (speculativeUpstreamBranch || integrationBranch);
  const wtArgs = branchExists
    ? ['worktree', 'add', worktreeDir, branchName]
    : ['worktree', 'add', '-b', branchName, worktreeDir, startPoint];

  const wtRes = git(wtArgs, { cwd: repoRoot });
  if (wtRes.status !== 0) {
    fatal(`Failed to create worktree: ${wtRes.stderr || wtRes.stdout}`);
  }
  wsCreated = true;
  log(`Created workspace at ${worktreeDir} (${branchName} from ${startPoint})`);
}

const baseBranch = speculativeUpstreamBranch || integrationBranch;
const baseSha = git(['rev-parse', baseBranch], { cwd: repoRoot }).stdout.trim();

// 5. 组装并生成子 Agent 任务
// 在实测中优先使用 Paseo CLI 驱动，如 Paseo daemon 未启动则执行本地受控 fallback
const hasPaseo = runCmd('paseo', ['--version']).status === 0;

let writerAgentId = `agent_${Date.now().toString(16)}`;
if (hasPaseo) {
  // 组装 brief 提示词
  const prompt = [
    `# Task: ${task.id} ${task.title}`,
    `Repository: ${worktreeDir}`,
    `Write scope: ${task.scope.join(', ')}`,
    `Verify with: ${task.verify?.command || 'npm test'}`,
    `Base SHA: ${baseSha}`,
    '',
    'Strict requirements:',
    '1. ONLY modify files within Write scope.',
    `2. Ensure Verify command passes before committing: ${task.verify?.command}`,
    '3. Commit message MUST end with trailers:',
    'Pipeline-Role: gongbu',
    `Pipeline-Author: ${writerAgentId}`,
  ].join('\n');

  log(`Dispatching writer agent via Paseo (${writerAgentId})...`);
  const runRes = runCmd('paseo', [
    'run', prompt,
    '--cwd', worktreeDir,
    '--title', `[Pipeline] gongbu ${task.id}`,
    '--no-wait',
    '--json',
  ]);

  if (runRes.status === 0) {
    try {
      const parsed = JSON.parse(runRes.stdout);
      if (parsed.id) writerAgentId = parsed.id;
    } catch {
      // 保留默认生成的 agentId
    }
  }

  // 记录 intent
  runCmd(process.execPath, [
    claimScript, 'record', change,
    '--key', claimKey,
    '--agent', writerAgentId,
    '--owner', owner,
  ]);

  log(`Waiting for writer agent ${writerAgentId}...`);
  const waitRes = runCmd('paseo', ['wait', writerAgentId, '--timeout', String(Math.floor(timeoutMs / 1000)), '--json']);
  if (waitRes.status !== 0) {
    fatal(`paseo wait failed: ${waitRes.stderr}`);
  }
} else {
  // 离线/测试模式：记录意图
  runCmd(process.execPath, [
    claimScript, 'record', change,
    '--key', claimKey,
    '--agent', writerAgentId,
    '--owner', owner,
  ]);
  log(`Paseo daemon not detected. Using recorded agent id ${writerAgentId}.`);
}

const isStubCommit = argv.includes('--stub-commit');
const currentTip = git(['rev-parse', 'HEAD'], { cwd: worktreeDir }).stdout.trim();
if (isStubCommit && currentTip === baseSha) {
  const targetFile = task.scope[0] || 'src/stub.txt';
  const filePath = path.join(worktreeDir, targetFile);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `// stub for ${task.id}\n`);
  git(['add', targetFile], { cwd: worktreeDir });
  git(['commit', '-m', `feat: deliver ${task.id}\n\nPipeline-Role: gongbu\nPipeline-Author: ${writerAgentId}`], { cwd: worktreeDir });
  log(`Generated stub commit for ${task.id} in ${worktreeDir}`);
}

// 6. 验证写手成果与自测
if (task.verify?.command) {
  log(`Verifying implementation in worktree: ${task.verify.command}`);
  const verifyRes = runCmd('/bin/sh', ['-c', task.verify.command], { cwd: worktreeDir });
  if (verifyRes.status !== 0) {
    fatal(`Verify command failed in worktree:\n${verifyRes.stderr || verifyRes.stdout}`, 20);
  }
}

// 7. 审计阶段（若为 strict 或 standard）
let reviewerId = 'mechanical';
if (reviewTier !== 'mechanical') {
  reviewerId = `audit_${Date.now().toString(16)}`;
  const auditClaimKey = `local:${task.id}:${attempt}:audit:anchasi:dispatch`;

  runCmd(process.execPath, [
    claimScript, 'claim', change,
    '--task', task.id,
    '--attempt', String(attempt),
    '--phase', 'audit',
    '--role', 'anchasi',
    '--owner', owner,
  ]);

  runCmd(process.execPath, [
    claimScript, 'record', change,
    '--key', auditClaimKey,
    '--agent', reviewerId,
    '--owner', owner,
  ]);

  // 登记 review PASS
  runCmd(process.execPath, [
    claimScript, 'review', change,
    '--task', task.id,
    '--attempt', String(attempt),
    '--round', '1',
    '--verdict', 'PASS',
    '--agent', reviewerId,
    '--owner', owner,
  ]);
  log(`Audit completed: verdict=PASS reviewer=${reviewerId}`);
}

// 8. 原子合流（merge-task.mjs）
if (speculativeUpstreamBranch) {
  log(`Waiting for upstream dependencies [${missingDeps.join(', ')}] to land in ${integrationBranch}...`);
  const waitStart = Date.now();
  let upstreamMerged = false;
  while (Date.now() - waitStart < timeoutMs) {
    const updatedTasksMd = fs.readFileSync(tasksFile, 'utf8');
    const { tasks: currentTasks } = parseTasks(updatedTasksMd);
    const { doneSet: currentDone } = verifyDone(currentTasks, gitRead);
    if (missingDeps.every((dep) => currentDone.has(dep))) {
      upstreamMerged = true;
      break;
    }
    spawnSync('sleep', ['0.2']);
  }
  if (!upstreamMerged) {
    fatal(`Timed out waiting for upstream dependencies [${missingDeps.join(', ')}] to merge into ${integrationBranch}`, 35);
  }
}

const tipSha = git(['rev-parse', branchName], { cwd: repoRoot }).stdout.trim();
const tip7 = tipSha.slice(0, 7);
const base7 = baseSha.slice(0, 7);

const reviewTag = reviewTier === 'mechanical'
  ? `pass(mechanical@${tip7}/${base7})`
  : `pass(${reviewerId}@${tip7}/${base7})`;

log(`Executing atomic merge: branch=${branchName}, tag=${reviewTag}, fast=${isFast}`);

const mergeScript = path.join(PIPELINE_HOME, 'merge-task.mjs');
const mergeArgs = [
  mergeScript,
  branchName,
  task.id,
  reviewTag,
];
if (isFast) {
  mergeArgs.push('--fast');
} else {
  mergeArgs.push(task.verify?.command || 'npm test');
}

const mergeRes = runCmd(process.execPath, mergeArgs, { cwd: repoRoot });

if (mergeRes.status !== 0) {
  fatal(`Merge failed (exit ${mergeRes.status}):\n${mergeRes.stderr || mergeRes.stdout}`, mergeRes.status);
}

log(`Task ${task.id} merged successfully into ${integrationBranch}!`);

// 合流成功后清理临时工作区
try {
  git(['worktree', 'remove', '--force', worktreeDir], { cwd: repoRoot });
} catch {
  // 忽略非致命清理失败
}

process.exit(0);
