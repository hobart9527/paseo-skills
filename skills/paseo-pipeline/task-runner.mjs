#!/usr/bin/env node
// task-runner.mjs — 单任务微循环确定性执行器，也是唯一的 CLI 派发入口
//
// 架构定位：
//   将单个原子任务的微状态机（claim -> Paseo workspace dispatch -> wait -> verify -> merge）
//   收敛为本地 Node.js 确定性循环执行，免除编排者 LLM（Lead）频繁来回往返与思考等待，消除假死与空等。
//
// 审计不是本入口的职责：非 mechanical 档在 Verify 通过后 exit 50 停下，等编排者派真实 Auditor；
// 编排者拿到 `pass(...)` 标签后以 `--review-tag` 重入，由 `merge-task.mjs` 自己校验 3b（审查独立性与回执）等门禁。
// 本入口**不得**创建审计意图、review 记录或审计员身份，**不得**代设异构审查豁免。
//
// 任务 workspace 一律由 Paseo 创建（`paseo run --new-workspace worktree --new-branch ... --base ...`）。
// 本文件**不得**再出现 `git worktree add`、离线 fallback（无 daemon 时编造 agent id）或 `--stub-commit`：
// 那三条路径会让派发看起来成功、实际没人干活，是本 change 要删掉的缺陷。
//
// 用法:
//   node task-runner.mjs <change> <task-id> [--fast] [--speculative] [--owner <owner>]
//                              [--timeout <ms>] [--review-tag <tag>] [--dry-run] [--json]
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
//   50 非 mechanical 档写手已交付并通过 Verify，等待真实审计（入口不代签审计结论）
//   51 等待写手到终态超时（agent 可能仍在运行，禁止重派）

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

/**
 * 轮询可接受的「已收敛」状态。只认 `idle` 与 `closed`（agent 不再推进且没有出错）：
 * `running`/`initializing` 必须继续等，`timeout` 只是「这一轮等满了」，`error` 不能当成
 * 「可以接着验」——它会一直轮询到截止时间并由调用方 exit 51（不重派、也不合流）。
 */
const TERMINAL_AGENT_STATUSES = new Set(['idle', 'closed']);

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
  console.error('Usage: node task-runner.mjs <change> <task-id> [--fast] [--speculative] [--owner <id>] '
    + '[--timeout <ms>] [--review-tag <tag>] [--dry-run] [--json]');
  process.exit(1);
}

const [change, targetTaskId] = positional;
const owner = getOpt('--owner', `runner-${process.pid}`);
const timeoutMs = Number(getOpt('--timeout', 540 * 1000));

/**
 * 重入用的审计结论标签（`pass(<reviewer>@<tip7>/<base7>)`）。
 *
 * 只有带它时才合流：非 mechanical 档的审计员必须是独立 agent，本入口没有能力派 Auditor
 * 并等待其信封，因此写手交付后停下（exit 50），由编排者拿到真实标签后以本旗标重入，
 * 交 `merge-task.mjs` 自己校验门禁。标签原样透传，本入口不做任何改写或补签。
 */
const reviewTagOption = getOpt('--review-tag');

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
 * `latest` 是**已交付**的那条分支（maxN），给审计后带 `--review-tag` 的重入用：
 * 重入时不能再派发，所以必须合流写手已经推过的分支，而不是下一次 attempt 的新分支。
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
  const branchFor = (n) => (n === 1 ? base : `${base}-a${n}`);
  const attempt = maxAttempt + 1;
  return {
    attempt,
    branch: branchFor(attempt),
    latest: maxAttempt === 0 ? null : { attempt: maxAttempt, branch: branchFor(maxAttempt) },
  };
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
 * 把 `paseo wait` 失败降级成状态轮询：返回 `{status, timedOut}`，主流程只按它分支。
 *
 * 为什么不能「wait 非零即致命」：2026-10-31 实测 `paseo wait` 在 231s 返回 rc=1 `WAIT_FAILED`，
 * 写手其实还在正常跑——把调用方的容错做成致命退出，等于把一次可恢复的观测失败变成中断。
 * 也不能反过来「失败即当作已就绪」：那会让 Verify 去验一个还没写完的检出。
 *
 * 顺序：
 *   1. `paseo wait <id> --timeout <s> --json`，`status=idle` 即完成，`status=timeout` 只表示
 *      这一轮等满了，继续轮询（同一 id，绝不重派）。
 *   2. 非零退出或拿不到 `status`（含 `WAIT_FAILED`）→ 轮询 `paseo inspect <id> --json` 的
 *      `Status` 字段，直到终态或截止时间。
 *   3. 到截止时间仍未终态 → `timedOut: true`，由调用方 exit 51（agent 可能仍在运行）。
 *
 * 轮询间隔默认 5s；`PIPELINE_AGENT_POLL_MS` 只作测试注入，与 `PIPELINE_PASEO_HOME` 同族。
 */
function awaitAgent(agentId, { timeoutMs: deadlineMs }) {
  const pollMs = Number(process.env.PIPELINE_AGENT_POLL_MS) > 0
    ? Number(process.env.PIPELINE_AGENT_POLL_MS)
    : 5000;
  const deadline = Date.now() + deadlineMs;
  const waitSecs = Math.max(1, Math.floor(deadlineMs / 1000));
  const waitRes = runCmd('paseo', ['wait', agentId, '--timeout', String(waitSecs), '--json'], { cwd: repoRoot });
  const waitStatus = readStatusField(waitRes.status === 0 ? parseJson(waitRes.stdout) : null);
  if (waitStatus === 'idle') return { status: 'idle', timedOut: false };
  if (waitStatus === null) {
    log(`paseo wait did not report a parseable status (exit ${waitRes.status}); `
      + 'falling back to polling `paseo inspect`');
  }

  let lastStatus = waitStatus;
  while (Date.now() < deadline) {
    const inspectRes = runCmd('paseo', ['inspect', agentId, '--json'], { cwd: repoRoot });
    const status = inspectRes.status === 0 ? readStatusField(parseJson(inspectRes.stdout)) : null;
    if (status !== null) {
      lastStatus = status;
      if (TERMINAL_AGENT_STATUSES.has(status)) return { status, timedOut: false };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    spawnSync('sleep', [String(Math.min(pollMs, remaining) / 1000)]);
  }
  return { status: lastStatus, timedOut: true };
}

/** 安全解析 JSON；非 JSON 输出（旧版 CLI 只回一行文本）返回 null，由调用方降级。 */
function parseJson(text) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 从 Paseo 输出里取状态字段：`status` / `Status`（大小写按实测），也接受 `agent.status` 包裹。 */
function readStatusField(value) {
  if (value === null || typeof value !== 'object') return null;
  for (const holder of [value, value.agent, value.data]) {
    if (holder === null || typeof holder !== 'object') continue;
    for (const [key, raw] of Object.entries(holder)) {
      if (key.toLowerCase() === 'status' && typeof raw === 'string' && raw.trim() !== '') return raw.trim();
    }
  }
  return null;
}

/**
 * mechanical 档的直联合流标签。只有 `Review: mechanical` 的任务能这么合：
 * 给 strict/standard 档套 mechanical 标签等于让门禁承认「这份交付没被审过也合格」。
 */
function mechanicalTag(branch) {
  const tip = git(['rev-parse', branch], { cwd: repoRoot });
  if (tip.status !== 0) {
    fatal(`Branch ${branch} cannot be resolved for the mechanical review tag: ${tip.stderr || tip.stdout}`);
  }
  return `pass(mechanical@${tip.stdout.trim().slice(0, 7)}/${baseSha.slice(0, 7)})`;
}

/**
 * 调 `merge-task.mjs` 合流。
 *
 * 门禁（tag 与 SHA 一致、作者来源、写范围、测试、审查独立性）全部由 merge-task 自己判——
 * 本入口只传分支、任务与标签，**不**代设任何放宽合流门禁的环境变量：放行只能由人显式设置，
 * 入口替调用者按下它，等于把门禁变成可被自动跳过的装饰。
 * （异构不在此列：原因子 3c 已删除，异构由 Profile 的 provider/model 组合保证。）
 */
function mergeIntoIntegration({ branch, tag }) {
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

  log(`Executing atomic merge: branch=${branch}, tag=${tag}, fast=${isFast}`);

  const mergeArgs = [path.join(PIPELINE_HOME, 'merge-task.mjs'), branch, task.id, tag];
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
  // 任务 workspace 归 Paseo 管：合流后不在这里删 worktree，由编排者/Paseo 归档。
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

// 4. 分支与 attempt 推导（分支是 git 事实，不看目录存在性）
const { attempt, branch: branchName } = resolveAttempt();
const integrationBranch = `integration/${change}`;
const baseBranch = speculativeUpstreamBranch || integrationBranch;
const baseShaRes = git(['rev-parse', '--verify', `${baseBranch}^{commit}`], { cwd: repoRoot });
if (baseShaRes.status !== 0) {
  fatal(`Base ${baseBranch} cannot be resolved: ${baseShaRes.stderr || baseShaRes.stdout}`);
}
const baseSha = baseShaRes.stdout.trim();

// 4b. 带 `--review-tag` 的重入：写手已经交付、Auditor 已经出结论，这里只做合流。
// 不再派发，也不碰写手的任务 workspace——重入时它可能已被 Paseo 归档。
// 标签原样交给 merge-task 自己验（tip/base 一致、作者来源、3b 独立）；
// 本入口不创建审计意图、不写 review 记录、不替调用者放宽任何门禁。
// 合流对象是**已交付**的那次 attempt（最新现存任务分支），不是下一次派发的新分支。
if (reviewTagOption !== null) {
  const { latest } = resolveAttempt();
  if (latest === null) {
    fatal(`--review-tag given but no task branch for ${task.id} exists: nothing has been delivered to review`);
  }
  mergeIntoIntegration({ branch: latest.branch, tag: reviewTagOption });
  process.exit(0);
}

const profile = isDryRun ? null : resolveWriterProfile();

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

// 7. 等待写手到终态（`paseo wait` 失败不致命：降级为状态轮询，超时 exit 51 且不重派）
log(`Waiting for writer agent ${writerAgentId}...`);
const settled = awaitAgent(writerAgentId, { timeoutMs });
if (settled.timedOut) {
  fatal(`Agent ${writerAgentId} did not reach a terminal status within ${Math.round(timeoutMs / 1000)}s `
    + `(last observed status=${settled.status}). The agent may still be running: do NOT redispatch it — `
    + 'wait for its completion envelope or poll `paseo inspect` again.', 51);
}
log(`Writer agent ${writerAgentId} reached status=${settled.status}`);

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

// 9. 审计诚实：非 mechanical 档到这里就停。
//
// 审计员必须是**独立 agent**（merge-task 因子 3b 要求审计意图有真实回执），而派审计员并
// 等待其信封是编排者的职责，不是本入口能代劳的。旧实现直接编一个 `audit_<hex>` 身份、
// 自己 claim/record 审计意图再写一条 `review verdict=PASS`——账本上留下「已审」的假收据，
// 合流门禁因此形同虚设。整段删除，改为打印下一步并以 exit 50 交还给编排者。
if (reviewTier !== 'mechanical') {
  fatal(
    `Task ${task.id} delivered by writer ${writerAgentId} and passed Verify, but review tier is `
    + `'${reviewTier}': a real independent auditor is required before merge. This entry does NOT `
    + 'create an audit intent, review record or reviewer identity. '
    + `Next: dispatch the auditor (anchasi/hanlin) in this task's workspace branch ${branchName}, `
    + `then re-enter with the auditor's tag: node task-runner.mjs ${change} ${task.id} `
    + '--review-tag "pass(<reviewer-id8>@<tip7>/<base7>)"',
    50,
  );
}

// 10. 原子合流（merge-task.mjs）：只有 mechanical 档会走到这里并直联合流。
const reviewTag = mechanicalTag(branchName);
mergeIntoIntegration({ branch: branchName, tag: reviewTag });
process.exit(0);
