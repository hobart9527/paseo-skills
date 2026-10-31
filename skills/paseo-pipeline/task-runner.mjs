#!/usr/bin/env node
// task-runner.mjs — 单任务微循环确定性执行器，也是唯一的 CLI 派发入口
//
// 架构定位：
//   将单个原子任务的微状态机（claim -> Paseo workspace dispatch -> wait -> verify -> audit -> merge）
//   收敛为本地 Node.js 确定性循环执行，免除编排者 LLM（Lead）频繁来回往返与思考等待，消除假死与空等。
//
// 任务 workspace 一律由 Paseo 创建（`paseo run --new-workspace worktree --new-branch ... --base ...`）。
// 本文件**不得**再出现 `git worktree add`、离线 fallback（无 daemon 时编造 agent id）或 `--stub-commit`：
// 那三条路径会让派发看起来成功、实际没人干活，是本 change 要删掉的缺陷。
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
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseTasks } from './lib/tasks.mjs';
import { verifyDone } from './lib/ledger.mjs';
import { checkHandoff } from './lib/handoff.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PIPELINE_HOME = process.env.PIPELINE_HOME || SCRIPT_DIR;

/** 写手 profile 的唯一来源：`list_profiles` 读的同一份活态配置里的固定 id。 */
const WRITER_PROFILE_ID = 'agent_profile_gongbu';

/** Paseo 活态配置目录（与 lib/paseo-state.mjs 同一套注入变量，测试靠它指向假 profile）。 */
const paseoHome = process.env.PIPELINE_PASEO_HOME || path.join(os.homedir(), '.paseo');

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

/**
 * 解析写手 profile。**fail closed**：读不到、缺 provider/model、provider 不是
 * `<provider>/<model>` 形状，一律在派发前退出。
 *
 * 为什么不能「读不到就当空串放行」：`paseo run --provider ""` 仍然会建出 agent，
 * 派发看起来成功了，但没有任何 provider 能完成它——账本上却留下一条已回执的意图。
 * 历史实现正是把解析放在子 shell 里，错误被吞掉后照常派发。
 *
 * mode/thinking 缺省不发明默认值：profile 没声明就省略对应旗标；pi 不接受 `--mode`。
 */
function resolveWriterProfile() {
  const configFile = path.join(paseoHome, 'config.json');
  if (!fs.existsSync(configFile)) {
    fatal(`找不到 ${configFile}：写手 profile 必须从活态配置解析，拒绝以空 provider 派发`);
  }
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  } catch (error) {
    fatal(`${configFile} 不是合法 JSON：${error.message}`);
  }
  const profiles = config?.daemon?.agentProfiles;
  const profile = Array.isArray(profiles) ? profiles.find((entry) => entry?.id === WRITER_PROFILE_ID) : undefined;
  if (!profile) {
    fatal(`${configFile} 中无 ${WRITER_PROFILE_ID}：写手 profile 缺失，拒绝派发`);
  }
  const providerId = typeof profile.provider === 'string' ? profile.provider.trim() : '';
  const model = typeof profile.model === 'string' ? profile.model.trim() : '';
  if (providerId === '' || model === '') {
    fatal(`profile ${WRITER_PROFILE_ID} 缺 provider/model（读到的 provider=${JSON.stringify(profile.provider)}, `
      + `model=${JSON.stringify(profile.model)}）：解析为空即拒绝派发，绝不发空 provider`);
  }
  return {
    providerId,
    // 与 `list_profiles` / hotfix 既有形态一致：provider/model 作为单个 --provider 取值。
    provider: `${providerId}/${model}`,
    // pi provider 不支持 --mode：声明了也要省略，否则 CLI 直接报错。
    mode: providerId.startsWith('pi') ? null : (profile.modeId || null),
    thinking: profile.thinkingOptionId || null,
  };
}

/**
 * 任务分支与 attempt：从**现存的** `task/<c>/<t>` 与 `task/<c>/<t>-a<N>` 取最大 N
 * （基础分支本身算第 1 次），新 attempt = maxN+1，分支为基础名（无任何现存分支时）
 * 或 `-a<maxN+1>`。
 *
 * 不能只判基础分支是否存在再 +1：只留下 `-a2`（基础分支已被清理）时那样会算出 attempt=2，
 * 派发到已存在的 `-a2` 分支上去撞名。
 *
 * 用 `for-each-ref` 判定，不看目录是否存在：分支存在与否是 git 事实，目录只是某次 checkout 的残留。
 * 只接受精确的 `<base>` 与 `<base>-a<数字>` 两种形状，`-a*` 里的其它后缀不参与计数。
 */
function resolveAttempt() {
  const base = `task/${change}/${task.id}`;
  const prefix = `refs/heads/${base}`;
  let maxAttempt = 0;
  const listed = git(['for-each-ref', '--format=%(refname)', `${prefix}*`], { cwd: repoRoot });
  if (listed.status === 0) {
    for (const line of listed.stdout.split('\n')) {
      const ref = line.trim();
      if (!ref.startsWith(prefix)) continue;
      const suffix = ref.slice(prefix.length);
      let n;
      if (suffix === '') {
        n = 1; // 基础分支即第 1 次派的产物
      } else {
        const match = /^-a(\d+)$/.exec(suffix);
        if (!match) continue;
        n = Number(match[1]);
      }
      if (Number.isInteger(n) && n > maxAttempt) maxAttempt = n;
    }
  }
  const attempt = maxAttempt + 1;
  return { attempt, branch: attempt === 1 ? base : `${base}-a${attempt}` };
}

/** 写手 brief：任务契约 + 分支/基点 + 交付约束。 */
function buildWriterBrief({ baseBranch, baseSha, branch }) {
  const title = `[Pipeline] gongbu ${task.id} ${change}`.slice(0, 60);
  const prompt = [
    `# Task ${task.id} ${task.title}`,
    `Change: ${change}`,
    `Branch: ${branch}（基点 ${baseBranch}@${baseSha}）`,
    `Write scope: ${task.scope.join(', ') || '(未声明)'}`,
    `Verify with: ${task.verify?.command || '(未声明)'}`,
    '',
    'Hard constraints:',
    '1. ONLY modify files inside the Write scope above.',
    `2. Run the Verify command and make it pass before committing: ${task.verify?.command || '(none)'}`,
    '3. Commit message MUST end with these two trailers on the last paragraph, no blank line between them:',
    '   Pipeline-Role: gongbu',
    '   Pipeline-Author: <your own agent id>',
    '4. Leave the working tree clean when done.',
  ].join('\n');
  return { title, prompt };
}

/** 从 `paseo run` 的输出里取真实 agent id；取不到返回 null（由调用方作废意图）。 */
function parseAgentId(stdout) {
  const text = typeof stdout === 'string' ? stdout : '';
  try {
    const parsed = JSON.parse(text);
    for (const candidate of [parsed?.id, parsed?.agentId, parsed?.Id, parsed?.data?.id]) {
      if (typeof candidate === 'string' && /^[0-9a-f-]{36}$/i.test(candidate.trim())) return candidate.trim();
    }
  } catch {
    // 非 JSON 输出：落到按行匹配（`-q` 形态只回 id）。
  }
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean).reverse();
  for (const line of lines) {
    if (/^[0-9a-f-]{36}$/i.test(line)) return line;
  }
  return null;
}

/**
 * 找写手 workspace 的检出目录：Paseo 用 `--new-workspace worktree` 建的任务 worktree
 * 会登记在仓库的 worktree 列表里。这里只**读**这份列表，不建任何 worktree。
 *
 * 找不到时返回 null：调用方不得退回到仓库根去跑 Verify——那验的是另一份检出，
 * 「验过」就变成了对错误的目录作证。
 */
function findWorkspaceForBranch(branch) {
  const listed = git(['worktree', 'list', '--porcelain'], { cwd: repoRoot });
  if (listed.status !== 0) return null;
  let current = null;
  for (const line of `${listed.stdout}\n`.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length), branch: null };
      continue;
    }
    if (current === null) continue;
    if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length);
      continue;
    }
    if (line.trim() === '') {
      if (current.branch === `refs/heads/${branch}`) return current.path;
      current = null;
    }
  }
  return null;
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

// 3. 派发前机械校验：交接门禁与写手 profile（fail closed，任一不合格都不派发）
// 交接门禁与 handoff-check.mjs 共用 lib/handoff.mjs 这一份判据：派发前 tasks.md 必须是
// 基点上可读的已提交事实，否则写手拿到的是只存在于本地工作树的契约。
if (!isDryRun) {
  const handoff = checkHandoff({ root: repoRoot, change });
  if (!handoff.ok) {
    for (const problem of handoff.problems) {
      log(`BLOCK [${problem.code}] ${problem.message}`);
    }
    fatal(`Handoff check failed: change artifacts are not committed at the base (${handoff.problems.length} problems)`, 1);
  }
}

const profile = isDryRun ? null : resolveWriterProfile();

// 4. 分支与 attempt 推导（分支是 git 事实，不看目录存在性）
const { attempt, branch: branchName } = resolveAttempt();
const integrationBranch = `integration/${change}`;
const baseBranch = speculativeUpstreamBranch || integrationBranch;
const baseShaRes = git(['rev-parse', '--verify', `${baseBranch}^{commit}`], { cwd: repoRoot });
if (baseShaRes.status !== 0) {
  fatal(`Base ${baseBranch} cannot be resolved: ${baseShaRes.stderr || baseShaRes.stdout}`);
}
const baseSha = baseShaRes.stdout.trim();
log(`Workspace target: branch=${branchName} base=${baseBranch}@${baseSha.slice(0, 7)} attempt=${attempt}`);

// 5. 意图 claim（必须在派发之前：创建在途窗口里重派会被账本拒绝）
const claimScript = path.join(PIPELINE_HOME, 'run-state.mjs');
const claimRes = runCmd(process.execPath, [
  claimScript, 'claim', change,
  '--task', task.id,
  '--attempt', String(attempt),
  '--phase', 'impl',
  '--role', 'gongbu',
  '--owner', owner,
  '--json',
], { cwd: repoRoot });
if (claimRes.status !== 0) {
  fatal(`Failed to claim intent in run-state: ${claimRes.stderr || claimRes.stdout}`, claimRes.status);
}
let claimKey;
try {
  claimKey = JSON.parse(claimRes.stdout)?.intent?.key;
} catch {
  claimKey = undefined;
}
if (typeof claimKey !== 'string' || claimKey === '') {
  fatal(`run-state claim returned no intent key; refusing to dispatch: ${claimRes.stdout}`);
}

// 6. 经 Paseo 创建任务 workspace 并派发写手。
// 分支、基点、五标签都由这里决定；Paseo 负责建 worktree，本进程不碰 `git worktree add`。
const { title, prompt } = buildWriterBrief({ baseBranch, baseSha, branch: branchName });
const paseoArgs = [
  'run', prompt,
  '--title', title,
  '--provider', profile.provider,
];
if (profile.mode !== null) paseoArgs.push('--mode', profile.mode);
if (profile.thinking !== null) paseoArgs.push('--thinking', profile.thinking);
paseoArgs.push(
  '--new-workspace', 'worktree',
  '--new-branch', branchName,
  '--base', baseBranch,
  // 五个身份标签缺一不可：reconcile 依赖它们做归属、cap 计数与 phase 排序。
  '--label', `pipeline.change=${change}`,
  '--label', `pipeline.task=${task.id}`,
  '--label', `pipeline.attempt=${attempt}`,
  '--label', 'pipeline.phase=impl',
  '--label', 'pipeline.role=gongbu',
  '--no-wait',
  '--json',
);

log(`Dispatching writer via Paseo: branch=${branchName} provider=${profile.provider}`);
const runRes = runCmd('paseo', paseoArgs, { cwd: repoRoot });
if (runRes.status !== 0) {
  // 派发失败必须作废意图：未回执意图会挡住后续重派（重复意图 exit 2）。
  runCmd(process.execPath, [
    claimScript, 'fail', change,
    '--key', claimKey,
    '--reason', 'paseo run exited non-zero',
    '--owner', owner,
  ], { cwd: repoRoot });
  fatal(`paseo run failed; intent ${claimKey} voided: ${runRes.stderr || runRes.stdout}`, 1);
}
const writerAgentId = parseAgentId(runRes.stdout);
if (writerAgentId === null) {
  runCmd(process.execPath, [
    claimScript, 'fail', change,
    '--key', claimKey,
    '--reason', 'paseo run produced no agent id',
    '--owner', owner,
  ], { cwd: repoRoot });
  fatal(`paseo run returned no parsable agent id; intent ${claimKey} voided. Output: ${runRes.stdout}`);
}

// 回执只登记真实 agent id：workspace id 采集不到就省略，绝不编造。
const recordRes = runCmd(process.execPath, [
  claimScript, 'record', change,
  '--key', claimKey,
  '--agent', writerAgentId,
  '--owner', owner,
], { cwd: repoRoot });
if (recordRes.status !== 0) {
  fatal(`Intent receipt failed (agent already dispatched: ${writerAgentId}); `
    + `run manually: node ${claimScript} record ${change} --key '${claimKey}' --agent '${writerAgentId}': `
    + `${recordRes.stderr || recordRes.stdout}`);
}
log(`Dispatched writer agent ${writerAgentId} (intent ${claimKey})`);

// 7. 等待写手完成（容错策略属 T-04；此处保持既有语义）
log(`Waiting for writer agent ${writerAgentId}...`);
const waitRes = runCmd('paseo', ['wait', writerAgentId, '--timeout', String(Math.floor(timeoutMs / 1000)), '--json'], { cwd: repoRoot });
if (waitRes.status !== 0) {
  fatal(`paseo wait failed: ${waitRes.stderr || waitRes.stdout}`);
}

// 8. 验证写手成果：Verify 必须在写手自己的任务 workspace 里跑。
// 工作区目录只从 git 的 worktree 登记里读（Paseo 建的那个），本进程不建任何 worktree。
const worktreeDir = findWorkspaceForBranch(branchName);
if (task.verify?.command) {
  if (worktreeDir === null) {
    fatal(`Writer workspace for ${branchName} is not registered as a git worktree; `
      + 'refusing to verify the wrong checkout', 1);
  }
  log(`Verifying implementation in ${worktreeDir}: ${task.verify.command}`);
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

const mergeRes = runCmd(process.execPath, mergeArgs, {
  cwd: repoRoot,
  env: {
    ...process.env,
    PIPELINE_ALLOW_HOMOGENEOUS_REVIEW: '1', // 允许测试/同构环境快速闭环
  },
});

if (mergeRes.status !== 0) {
  fatal(`Merge failed (exit ${mergeRes.status}):\n${mergeRes.stderr || mergeRes.stdout}`, mergeRes.status);
}

log(`Task ${task.id} merged successfully into ${integrationBranch}!`);

// 任务 workspace 归 Paseo 管：合流后不在这里删 worktree，由编排者/Paseo 归档。

process.exit(0);
