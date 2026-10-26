#!/usr/bin/env node
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseTasks, isFileWithinScopes } from './lib/tasks.mjs';
import { verifyDone, buildMergeAcceptance, expandDoneSource as expandDoneSourceFor } from './lib/ledger.mjs';
import { WRITER_ROLES, CONTROL_ROLES, READONLY_ROLES, isControlRole } from './lib/roles.mjs';
import { acquireLock } from './lib/lock.mjs';
import { readRunState } from './lib/run-state.mjs';

const usage = [
  'Usage: node merge-task.mjs <branch> <task-ids> <review-tag> <test-cmd> [--allow-legacy-author]',
  'review-tag: pass(<reviewer-id8>@<tip7>/<base7>)',
  '--allow-legacy-author requires PIPELINE_ALLOW_LEGACY_AUTHOR=1 and is recorded in run-log.',
  'Note: this validates tag/SHA consistency, author provenance, scope containment, and tests.',
  'Verify with: every requested task MUST declare an executable `Verify with`; it is always run first.',
  '  The positional <test-cmd> is appended (an identical duplicate is skipped), never a substitute.',
].join('\n');

function fail(message, code = 1) {
  console.error(`[merge-task] Error: ${message}`);
  process.exit(code);
}

function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.error) fail(`git ${args.join(' ')} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${result.status})\n${result.stdout}${result.stderr}`);
  }
  return result.stdout.trim();
}

function gitMaybe(args) {
  return spawnSync('git', args, { encoding: 'utf8' });
}

function parseSourceBranch(branch) {
  let match = branch.match(/^task\/([^/]+)\/([A-Za-z]+-\d+)(?:-a\d+)?$/);
  if (match) return { change: match[1], taskId: match[2] };
  match = branch.match(/^pod\/([^/]+)$/);
  if (match) return { change: match[1], taskId: null };
  return null;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 分支相对 base 改动的文件列表。
 *
 * 两个必须的开关，实测都会造成写范围门禁静默失效：
 *   `-z`            非 ASCII 路径默认被转义成 `"src/\344\270\255\346\226\207..."`，
 *                   与 tasks.md 里的真实路径字面量永不相等 → 合法改动被判越界（fail closed 但误伤）。
 *   `--no-renames`  改名默认只报新路径，被删除的旧路径（可能在新 scope 外）完全不出现在列表里
 *                   → 一次 `git mv` 就能把旧 scope 之外的文件移出校验视野。
 */
function changedFiles(fromRef, toRef) {
  // 不走 git()：它会对整段输出 trim，而 `-z` 输出以 NUL 分隔，
  // 首尾 trim 会吃掉「以空格开头的文件名」的首空格（合法但罕见的路径）。
  const result = gitMaybe(['diff', '--name-only', '-z', '--no-renames', `${fromRef}..${toRef}`]);
  if (result.error) fail(`git diff could not start: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`git diff failed (${result.status})\n${result.stdout}${result.stderr}`);
  }
  return result.stdout.split('\0').filter(Boolean);
}

// 合流开始前的集成 HEAD，由 abortMerge 用来判断「现场是否还值得回滚」。
// `git merge --abort` 只在 MERGE_HEAD 存在时能工作；一旦测试命令自己执行了 `git commit`，
// MERGE_HEAD 消失而提交已经落盘——此时静默 return 会让集成 HEAD 前进一步却没有 Done 记账，
// 下一次合流就会在错误的基线上计算漂移与写范围。
let expectedPreMergeHead = null;

function abortMerge() {
  const mergeHead = gitMaybe(['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
  const mergeHeadGone = !mergeHead.error && mergeHead.status !== 0;
  if (mergeHeadGone) {
    // MERGE_HEAD 消失有两种含义：合流从未开始（正常，直接返回），
    // 或测试命令在合流期间自己提交了（异常，集成 HEAD 已被推进）。
    // 后者绝不能静默：没有记账的提交会让后续合流在错误基线上运行。
    const head = gitMaybe(['rev-parse', 'HEAD']);
    const headNow = !head.error && head.status === 0 ? head.stdout.trim() : null;
    if (expectedPreMergeHead === null || headNow === expectedPreMergeHead) return;
    const status = gitMaybe(['status', '--porcelain']);
    const site = status.error
      ? `git status could not start: ${status.error.message}`
      : status.stdout || '(working tree clean)';
    console.error([
      '[merge-task] Error: the merge state vanished without being aborted — '
        + 'something committed during the merge (likely the test command ran `git commit`).',
      `[merge-task] Integration HEAD was ${expectedPreMergeHead}, now ${headNow ?? '(unreadable)'}.`,
      '[merge-task] On-site state (git status --porcelain):',
      site,
      '[merge-task] This commit has NO Pipeline-Task / Pipeline-Source accounting; '
        + 'downstream merges would compute drift against a baseline that was never booked.',
      '[merge-task] Manual guidance: inspect `git log --oneline -3`, then decide whether to keep '
        + `or revert ${headNow ? headNow.slice(0, 7) : 'that commit'} by hand. This script did NOT reset anything.`,
    ].join('\n'));
    process.exit(40);
  }
  const abort = gitMaybe(['merge', '--abort']);
  if (!abort.error && abort.status === 0) return;
  const detail = abort.error
    ? `git merge --abort could not start: ${abort.error.message}`
    : `git merge --abort failed (status=${abort.status}${abort.signal ? ` signal=${abort.signal}` : ''})\n${abort.stdout}${abort.stderr}`;
  const status = gitMaybe(['status', '--porcelain']);
  const site = status.error
    ? `git status could not start: ${status.error.message}`
    : status.stdout || '(working tree clean)';
  console.error([
    `[merge-task] Error: ${detail}`,
    '[merge-task] On-site state (git status --porcelain):',
    site,
    '[merge-task] Manual guidance: the repository may still be mid-merge (MERGE_HEAD present).',
    '[merge-task] Inspect with `git status`, resolve the blocker, then run `git merge --abort` by hand.',
    '[merge-task] Do NOT discard the working tree with a hard reset: uncommitted work would be lost.',
  ].join('\n'));
  process.exit(40);
}

function markTasksDone(tasksFile, requestedTasks, tip7, reviewTag) {
  const lines = fs.readFileSync(tasksFile, 'utf8').split('\n');

  for (const task of requestedTasks) {
// Done 行定位：ID 后允许空格或冒号两种分隔（与 lib/tasks.mjs 的 TASK_LINE 保持同一兼容性）。
// 只认空格形式会让冒号式 tasks.md 报「无法精确定位未完成任务」，合流直接失败。
    const taskPattern = new RegExp(
      `^(\\s*[-*]\\s*\\[) (\\]\\s+${escapeRegExp(task.num)}\\s+${escapeRegExp(task.id)}(?::(?=\\s|$)|\\s+|$).*)$`
    );
    const index = lines.findIndex((line) => taskPattern.test(line));
    if (index === -1) throw new Error(`无法在 tasks.md 精确定位未完成任务 ${task.id}`);
    const match = lines[index].match(taskPattern);
    lines[index] = `${match[1]}x${match[2]}`;
    lines.splice(index + 1, 0, `  - Done: source=${tip7} review=${reviewTag}`);
  }

  fs.writeFileSync(tasksFile, lines.join('\n'), 'utf8');
}

function appendRunLog(logFile, entry) {
  const previous = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  const separator = previous !== '' && !previous.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(logFile, `${previous}${separator}${entry}\n`, 'utf8');
}

const allowLegacyAuthorRequested = process.argv.includes('--allow-legacy-author');
// legacy 豁免是放宽项，不能靠某个调用者顺手加个参数就生效：
// 它会让「没有 Pipeline-Role / Pipeline-Author trailer 的提交」也能合流，
// 等于把作者血统门禁整体关掉。因此要求显式的环境变量二次确认，并且无论成功与否都记进 run-log。
// 控制面角色检查在这段之外，豁免不覆盖它。
if (allowLegacyAuthorRequested && process.env.PIPELINE_ALLOW_LEGACY_AUTHOR !== '1') {
  fail('--allow-legacy-author 关闭了作者血统门禁；需同时设置 PIPELINE_ALLOW_LEGACY_AUTHOR=1 显式确认，'
    + '并在 run-log 留下记录', 31);
}
const allowLegacyAuthor = allowLegacyAuthorRequested;
const positionalArgs = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));

if (positionalArgs.length !== 4) {
  console.error(usage);
  process.exit(1);
}

const [branch, taskIdsArg, reviewTag, testCommand] = positionalArgs;
const source = parseSourceBranch(branch);
if (!source) fail(`branch must be task/<change>/<task-id>[-aN] or pod/<change>: ${branch}`);

const currentBranch = git(['branch', '--show-current']);
if (currentBranch !== `integration/${source.change}`) {
  fail(`current branch must be integration/${source.change}, got ${currentBranch || '(detached HEAD)'}`);
}

const dirty = git(['status', '--porcelain']);
if (dirty !== '') fail(`working tree is not clean before merge:\n${dirty}`);

// --- 单写者锁：校验—合流—提交是一条读-改-写序列 ---
//
// 没有锁时两个并发合流的 abort 会互相撤掉对方正在进行的合并，双方都以为自己在写集成历史。
// 锁放在 git common dir（所有 worktree 可见），持锁后**重读 HEAD**：之前读到的基线在等待
// 期间可能已被另一个合流推进，用它继续校验会算出错误的漂移与写范围。
const lockDir = path.resolve(process.cwd(), git(['rev-parse', '--git-common-dir']), 'paseo-pipeline', 'locks');
const lock = acquireLock(lockDir, `merge-${source.change}`, { purpose: `${branch} -> ${taskIdsArg}` });
if (!lock.ok) {
  fail(`another merge is in progress for this repository (${lock.holder}); `
    + `serialize merges — never run two at once. Lock: ${lock.file}`, 37);
}
process.on('exit', () => lock.release());

const preMergeHead = git(['rev-parse', 'HEAD']);
expectedPreMergeHead = preMergeHead;
const tip = git(['rev-parse', '--verify', `${branch}^{commit}`]);
const tip7 = tip.slice(0, 7);

// reviewer 可以是 8 位短 ID（日常用法）、完整 UUID（便于与 Paseo 原生 id 对照），
// 或 mechanical（仅限显式声明 Review: mechanical 的任务）。
const REVIEW_TAG = /^pass\((mechanical|[0-9a-f]{8}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})@([0-9a-f]{7})\/([0-9a-f]{7})\)$/;
const reviewMatch = reviewTag.match(REVIEW_TAG);
if (!reviewMatch) fail(`malformed review tag: ${reviewTag}`);
const [, reviewer, reviewedTip7, reviewedBase7] = reviewMatch;
if (reviewedTip7 !== tip7) {
  fail(`review tip mismatch: tag=${reviewedTip7} branch=${tip7}`);
}

const reviewedBase = gitMaybe(['rev-parse', '--verify', `${reviewedBase7}^{commit}`]);
if (reviewedBase.error) {
  fail(`git rev-parse could not start: ${reviewedBase.error.message}`);
}
if (reviewedBase.status !== 0) {
  fail(`review base does not resolve to a commit: ${reviewedBase7}\n${reviewedBase.stderr}`);
}
const reviewedBaseSha = reviewedBase.stdout.trim();

// review 的 base 必须是集成历史的祖先：否则 `reviewedBaseSha..tip` 的差异范围根本不对应
// 「这个任务相对集成基线改了什么」，写范围校验与基线漂移校验都会算错。
const baseIsAncestor = gitMaybe(['merge-base', '--is-ancestor', reviewedBaseSha, preMergeHead]);
if (baseIsAncestor.error) fail(`git merge-base could not start: ${baseIsAncestor.error.message}`);
if (baseIsAncestor.status !== 0) {
  fail(`review base ${reviewedBaseSha.slice(0, 7)} is not an ancestor of integration HEAD ${preMergeHead.slice(0, 7)}; `
    + 'a newer/unrelated base changes the diff under review', 34);
}

// base 还必须是 tip 的祖先，这一条不能由上面的检查代替：
// 集成在任务分支拉出之后又前进时，用那个新提交当 base 仍然「是集成 HEAD 的祖先」，
// 但 `base..tip` 会把集成侧之后的所有改动算成本任务的 diff——写范围与漂移校验都会被放大，
// reviewer 审的也不是这份内容。
const baseReachedTip = gitMaybe(['merge-base', '--is-ancestor', reviewedBaseSha, tip]);
if (baseReachedTip.error) fail(`git merge-base could not start: ${baseReachedTip.error.message}`);
if (baseReachedTip.status !== 0) {
  fail(`review base ${reviewedBaseSha.slice(0, 7)} is not an ancestor of the merged tip ${tip7}; `
    + 'the diff under review would include commits this task did not author', 34);
}

const changeDir = path.join('openspec', 'changes', source.change);
const tasksFile = path.join(changeDir, 'tasks.md');
const logFile = path.join(changeDir, 'run-log.md');
if (!fs.existsSync(tasksFile)) fail(`missing tasks ledger: ${tasksFile}`);

const taskIds = taskIdsArg.split(',').map((id) => id.trim());
if (taskIds.length === 0 || taskIds.some((id) => id === '')) fail('task IDs must be a non-empty comma-separated list');
if (new Set(taskIds).size !== taskIds.length) fail(`duplicate task IDs requested: ${taskIdsArg}`);
if (source.taskId !== null && (taskIds.length !== 1 || taskIds[0] !== source.taskId)) {
  fail(`task branch ${branch} may merge only exact task ID ${source.taskId}`);
}

// --- Pod 成员集合：与 reconcile 同一份冻结记录 ---
//
// pod/<change> 分支名不携带任务身份，唯一的成员真源是冻结时写的 pod-members.json。
// reconcile 读它做归属，合流入口若不读，两条路径的契约就不对称：调度侧认为这个 Pod
// 只包含 {T-02,T-03}，调用者却可以拿同一条分支合流任意任务 ID，把 Pod 变成万能通道。
// 缺文件时不允许按「调用者说了算」处理——没有冻结成员就没有可验证的边界。
if (source.taskId === null) {
  const membersFile = path.join(changeDir, 'pod-members.json');
  if (!fs.existsSync(membersFile)) {
    fail(`pod branch ${branch} requires the frozen member list ${membersFile}; `
      + 'without it the task set of this Pod cannot be verified', 31);
  }
  let members;
  try {
    members = JSON.parse(fs.readFileSync(membersFile, 'utf8'));
  } catch (error) {
    fail(`cannot read frozen Pod members ${membersFile}: ${error.message}`, 31);
  }
  const frozen = Array.isArray(members?.tasks) ? members.tasks.filter((id) => typeof id === 'string') : [];
  if (frozen.length === 0) fail(`frozen Pod member list ${membersFile} has no task IDs`, 31);
  const requested = new Set(taskIds);
  const frozenSet = new Set(frozen);
  const extra = taskIds.filter((id) => !frozenSet.has(id));
  const missing = frozen.filter((id) => !requested.has(id));
  if (extra.length > 0 || missing.length > 0) {
    fail(`pod ${branch} task set mismatch: requested [${taskIds.join(', ')}]`
      + `${extra.length ? ` extra [${extra.join(', ')}]` : ''}`
      + `${missing.length ? ` missing [${missing.join(', ')}]` : ''}`
      + `; frozen members are [${frozen.join(', ')}]`, 31);
  }
}

const parsed = parseTasks(fs.readFileSync(tasksFile, 'utf8'));
if (parsed.errors.length > 0) {
  fail(`invalid tasks ledger:\n${parsed.errors.map((error) => `${error.code}: ${error.message}`).join('\n')}`);
}

const tasksById = new Map(parsed.tasks.map((task) => [task.id, task]));
const requestedTasks = taskIds.map((id) => {
  const task = tasksById.get(id);
  if (!task) fail(`unknown task ID: ${id}`);
  return task;
});

// --- 已 Done 的拒绝必须区分「已合过」与「换了 revision」 ---
//
// 规范的语义没有变：已 Done 即 exit 非零且不产生新提交（SCEN-MRG-08）。
// 变的只是**诊断精度**——旧实现只打印 `task is already Done`，执行器无法判断
// 这是「回执丢失后的重试，其实已经成功」还是「拿旧成果顶替新一轮产物」，
// 两种完全不同的处置被压成一条含糊告警，人工必须去翻 git 才能分清。
// 判据是可核验事实：Done 行绑定的 source 展开后是否等于本次 tip。
const ledgerRead = (args) => {
  const result = gitMaybe(args);
  return !result.error && result.status === 0 ? result.stdout.trim() : null;
};
for (const task of requestedTasks) {
  if (!task.done) continue;
  const source = task.doneLine ? expandDoneSourceFor(ledgerRead, task.doneLine.source) : null;
  if (source !== null && source === tip) {
    fail(`task ${task.id} is already merged from ${tip7}: its Done line records this exact tip `
      + 'and the merge is proven on first-parent. Nothing to do — if this is a retry after a lost '
      + 'merge receipt, the merge already succeeded; do not re-dispatch the task.', 1);
  }
  fail(`task is already Done: ${task.id}`
    + `${task.doneLine ? ` (Done source=${task.doneLine.source})` : ' (no Done line)'}; `
    + `this merge would target ${tip7} — a different revision cannot be merged under the same task`, 1);
}

// --- 因子 0: 依赖必须先被 first-parent 合流证明为 Done (Dependency Gate) ---
//
// 调度器（reconcile）只在依赖 DONE 后放行，但合流入口必须独立守住同一条前置条件：
// 直接调用本脚本就能绕开调度顺序。判定必须复用 lib/ledger.mjs 的 first-parent 验收，
// 不能只读 tasks.md 的 `[x]` —— 勾选是账本声明，first-parent 合流才是事实。
const { doneSet } = verifyDone(parsed.tasks, ledgerRead, preMergeHead);
for (const task of requestedTasks) {
  const unmet = task.depends.filter((dep) => !doneSet.has(dep));
  if (unmet.length > 0) {
    fail(`task ${task.id} depends on ${unmet.join(', ')} which are not verified Done on integration HEAD `
      + `${preMergeHead.slice(0, 7)}; merge dependencies first`, 35);
  }
}

// --- 冻结验证命令：测试的权威来源是 tasks.md 的 `Verify with`，不是调用者传的参数 ---
//
// 旧实现只执行位置参数里的 <test-cmd>，冻结的 Verify with 从不被读取：调用者传 `true`
// 就能合流一条验证命令完全没跑过的任务（实测 status=0）。这使「验过」退化为自报。
// 因此：任务声明的 Verify with 一律先跑；自然语言描述直接拒绝（它不是命令）；
// 位置参数只能追加，不能替代。任务完全没写 Verify with 时才允许单独使用调用者命令，并记入 run-log。
const frozenCommands = [];
for (const task of requestedTasks) {
  if (task.verify === null) continue;
  if (task.verify.command === null) {
    fail(`task ${task.id} declares a non-executable Verify with: ${JSON.stringify(task.verify.raw)}\n`
      + 'a natural-language description is not a test command; rewrite it as an executable command', 36);
  }
  if (!frozenCommands.includes(task.verify.command)) frozenCommands.push(task.verify.command);
}
const testPlan = [...frozenCommands];
if (!testPlan.includes(testCommand)) testPlan.push(testCommand);
const verifySource = frozenCommands.length === 0
  ? `caller-only (${testCommand})`
  : `tasks.md (${frozenCommands.join(' ; ')})${testPlan.length > frozenCommands.length ? ' + caller' : ''}`;

// --- 因子 1: 写范围封闭性校验 (Write Scope Containment) ---
const branchFiles = changedFiles(reviewedBaseSha, tip);
const allowedScopes = requestedTasks.flatMap((task) => task.scope);
for (const file of branchFiles) {
  if (!isFileWithinScopes(file, allowedScopes)) {
    fail(`file ${file} modified on ${branch} is outside declared Write scope: ${allowedScopes.join(', ')}`, 30);
  }
}

// --- 因子 2: 作者来源与控制面隔离校验 (Author Provenance Check) ---
//
// 必须**逐个 commit** 判定，不能把区间内所有 trailer 各自聚合成一个平铺列表：
// 旧实现只要区间里存在任一合法 writer role，就能掩盖另一个完全没有 trailer 的提交
// （例如总控直接 Edit 后提交、旁边再挂一个写手的正常提交）。
// 每个 commit 必须同时具备 Pipeline-Role 与 Pipeline-Author，且角色是写入者。
const commits = git(['rev-list', '--reverse', `${reviewedBaseSha}..${tip}`])
  .split('\n')
  .filter(Boolean);

/** 读取单个 commit 的 trailer 值（同一 key 多次出现时取全部）。 */
function trailersOf(commit, key) {
  return git(['show', '-s', `--format=%(trailers:key=${key},valueonly)`, commit])
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean);
}

const provenance = commits.map((commit) => {
  const roles = trailersOf(commit, 'Pipeline-Role').map((role) => role.toLowerCase());
  const authors = trailersOf(commit, 'Pipeline-Author');
  return { commit, roles, authors };
});

// 控制面角色任何时候都不允许出现在代码提交里，legacy 豁免也不覆盖这条。
for (const { commit, roles } of provenance) {
  for (const role of roles) {
    if (isControlRole(role)) {
      fail(`commit ${commit.slice(0, 8)} contains orchestrator/control role '${role}'; `
        + 'orchestrator code writing is strictly forbidden', 31);
    }
  }
}

if (!allowLegacyAuthor) {
  if (commits.length === 0) {
    fail(`branch ${branch} has no commits after ${reviewedBase7}; nothing to merge`, 31);
  }
  for (const { commit, roles, authors } of provenance) {
    if (roles.length === 0) {
      fail(`commit ${commit.slice(0, 8)} is missing the Pipeline-Role trailer `
        + `(must be one of: ${[...WRITER_ROLES].join(', ')})`, 31);
    }
    for (const role of roles) {
      if (!WRITER_ROLES.has(role)) {
        fail(`commit ${commit.slice(0, 8)} has unauthorized author role '${role}' `
          + `(must be one of: ${[...WRITER_ROLES].join(', ')})`, 31);
      }
    }
    if (authors.length === 0) {
      fail(`commit ${commit.slice(0, 8)} is missing the Pipeline-Author trailer; `
        + 'author identity is required to prove this was written by a worker agent, not the orchestrator', 31);
    }
  }
}

// --- 因子 3: 非自审与独立审计员校验 (Anti-Self-Approval Check) ---
//
// reviewer 在 tag 里只写 8 位前缀，而 author trailer 通常是完整 UUID。
// 直接 `includes` 比较会漏判；必须按「完整值 / 唯一可解析前缀」比较，歧义则拒绝。
const authorIds = [...new Set(provenance.flatMap(({ authors }) => authors))];
if (reviewer !== 'mechanical') {
  for (const author of authorIds) {
    if (reviewerMatchesAuthor(reviewer, author)) {
      fail(`anti-self-approval violation: reviewer '${reviewer}' matches commit author '${author}'`, 32);
    }
  }
}

/**
 * reviewer 前缀是否指向某个 author。
 * 规则：完整相等即匹配；前缀必须唯一命中某个 author，命中多个则视为歧义并拒绝（fail closed）。
 */
function reviewerMatchesAuthor(reviewer, author) {
  const short = author.toLowerCase();
  if (short === reviewer) return true;
  if (!short.startsWith(reviewer)) return false;
  const ambiguous = authorIds.filter((other) => other.toLowerCase().startsWith(reviewer)
    && other.toLowerCase() !== reviewer);
  if (ambiguous.length > 1) {
    fail(`ambiguous reviewer id '${reviewer}' matches multiple authors: ${ambiguous.join(', ')}`, 32);
  }
  return true;
}

if (reviewer === 'mechanical' && requestedTasks.some((task) => task.review !== 'mechanical')) {
  fail('mechanical review requires Review: mechanical on every requested task');
}

function isWriterRole(role) {
  return typeof role === 'string' && WRITER_ROLES.has(role.toLowerCase());
}

function isReadonlyRole(role) {
  return typeof role === 'string' && READONLY_ROLES.has(role.toLowerCase());
}

/**
 * reviewer 是否指向候选集合中的某个 id。
 *
 * 与 `reviewerMatchesAuthor` 同一套前缀规则，但候选来自运行账本而非提交 trailer：
 * 8 位前缀命中多个不同 id 时是歧义，必须 fail closed——否则调用者可以用一个模糊前缀
 * 同时「证明」自己是审计员、又不是写手。
 */
function reviewerMatchesAny(reviewer, ids) {
  const lower = ids.map((id) => id.toLowerCase());
  if (lower.includes(reviewer)) return true;
  const prefixed = lower.filter((id) => id.startsWith(reviewer));
  if (prefixed.length > 1) {
    fail(`ambiguous reviewer id '${reviewer}' matches multiple dispatched agents: ${prefixed.join(', ')}`, 32);
  }
  return prefixed.length === 1;
}

// --- 因子 3b: reviewer 与派发记录的交叉核对 ---
//
// 历史事故（pipeline-native-closure T-02）：review tag 写的 `dfa79d7b` 就是该任务写手本人，
// 但那个提交没有 `Pipeline-Author` trailer，上面按 commit 作者做的自审检查完全落空——
// 合流账本上留下了「已审」的假收据。
//
// 根因是审查员身份只看提交元数据。运行账本记录了「谁被派去做什么」，两份记录必须对齐：
//   1) reviewer 不得等于本任务任一写手意图的 agent（即使 commit 上没有作者 trailer）；
//   2) reviewer 必须是本任务至少一条已回执的审计意图（role=anchasi）的 agent
//      ——Pod 是一次审查覆盖整组成员，因此按「任一成员有该审计派发」判定，不要求逐任务各派一次。
//
// 运行账本不存在时跳过——那表示这个 change 没走流水线记账（例如热修只合并单任务），
// 此时沿用上面的 trailer 检查。存在即按账本判定：账本在，就不得用「没记」当豁免。
const runLedger = readRunState(source.change);
if (runLedger.error !== null) {
  fail(`run-state ledger is unreadable, refusing to attest review independence: ${runLedger.error}`, 32);
}
if (runLedger.present && reviewer !== 'mechanical') {
  const recorded = runLedger.state.intents.filter((intent) => typeof intent.agentId === 'string' && intent.agentId !== '');
  const scoped = recorded.filter((intent) => taskIds.includes(intent.task));
  const writerIntents = scoped.filter((intent) => isWriterRole(intent.role));
  const writerAgent = writerIntents.find((intent) => reviewerMatchesAny(reviewer, [intent.agentId]));
  if (writerAgent !== undefined) {
    fail(`anti-self-approval violation: reviewer '${reviewer}' is the agent dispatched as a writer for ${writerAgent.task} `
      + `(run-state intent ${writerAgent.key}); review by the implementer is never independent`, 32);
  }
  const auditIntent = scoped.find((intent) => isReadonlyRole(intent.role)
    && reviewerMatchesAny(reviewer, [intent.agentId]));
  if (auditIntent === undefined) {
    fail(`reviewer '${reviewer}' has no recorded audit dispatch for ${taskIds.join(',')}: `
      + 'run-state holds no resolved anchasi intent for this reviewer, so independent review is unproven '
      + '(dispatch the auditor through run-state claim/record before merging)', 32);
  }
}

let drifted = false;
if (reviewedBaseSha !== preMergeHead) {
  const integrationFiles = new Set(changedFiles(reviewedBaseSha, preMergeHead));
  const overlap = changedFiles(reviewedBaseSha, tip).filter((file) => integrationFiles.has(file));
  if (overlap.length > 0) {
    fail(`baseline drift overlaps branch changes; re-review required: ${overlap.join(', ')}`);
  }
  drifted = true;
}

// 合流固定 tip：审查收据绑定的就是这个 commit，用可变的分支名合流会让「审查过的内容」
// 与「实际合入的内容」在两次 rev-parse 之间发生漂移。
const merge = gitMaybe(['merge', '--no-ff', '--no-commit', tip]);
if (merge.error) {
  console.error(`[merge-task] Error: git merge could not start: ${merge.error.message}`);
  abortMerge();
  process.exit(10);
}
if (merge.status !== 0) {
  console.error(`[merge-task] Error: git merge failed (${merge.status})\n${merge.stdout}${merge.stderr}`);
  abortMerge();
  process.exit(10);
}

// 测试前给「待提交状态」拍指纹。测试若改写了工作树（生成快照、就地格式化、写测试数据），
// 合流提交就会把测试副作用一起带进集成历史——而 Done 记账声称接受的是被审查过的那个 tip。
// 指纹必须覆盖工作树与未跟踪文件：`git write-tree` 只反映索引，看不见测试对工作树的改写。
const stateBeforeTest = git(['status', '--porcelain=v1', '--untracked-files=all']);

/**
 * 跑一条冻结验证命令，超时则**杀掉整个进程组**。
 *
 * `spawnSync(..., { shell: true, timeout })` 只能杀掉 `/bin/sh -c` 这一层：命令里再起的
 * 孙进程（npm → jest → worker、`bash run.sh` → 子测试）脱离 shell 继续运行，
 * 一边写工作区一边让合流的「测试后指纹」比对失真——脚本以为测试结束了，其实还在改文件。
 * 因此用 `detached: true` 让子进程自成进程组，超时时对 `-pid` 发信号，覆盖整棵进程树。
 *
 * 只有在超时时才这么做：正常退出走标准 exit 事件，不引入额外的轮询延迟。
 */
function runTestCommand(command, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      stdio: 'inherit',
      detached: true,
    });
    let settled = false;
    let timedOut = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      // 负号 = 整个进程组。SIGTERM 先给优雅退出的机会，2 秒后仍在则 SIGKILL。
      const sigterm = (signal) => {
        try {
          process.kill(-child.pid, signal);
        } catch {
          try { child.kill(signal); } catch { /* already gone */ }
        }
      };
      sigterm('SIGTERM');
      setTimeout(() => sigterm('SIGKILL'), 2000).unref();
    }, timeoutMs);
    child.on('error', (error) => {
      finish({ error, status: null, signal: null, timedOut });
    });
    child.on('exit', (code, signal) => {
      // 超时后 shell 可能先于孙进程退出；等进程组真正消失再返回，
      // 否则「测试后指纹」会在孙进程仍写文件时被采样。
      if (timedOut) {
        const deadline = Date.now() + 5000;
        const waitGroup = () => {
          if (Date.now() > deadline) return finish({ error: null, status: code, signal, timedOut });
          try {
            process.kill(-child.pid, 0);
            setTimeout(waitGroup, 100).unref();
            return undefined;
          } catch {
            return finish({ error: null, status: code, signal, timedOut });
          }
        };
        return waitGroup();
      }
      return finish({ error: null, status: code, signal, timedOut });
    });
  });
}

const startedAt = Date.now();
const testTimeoutMs = Number(process.env.MERGE_TEST_TIMEOUT_MS ?? 30 * 60 * 1000);
const timeout = Number.isFinite(testTimeoutMs) && testTimeoutMs > 0 ? testTimeoutMs : 30 * 60 * 1000;
for (const command of testPlan) {
  const test = await runTestCommand(command, timeout);
  if (test.error) {
    console.error(`[merge-task] Error: test command could not start: ${command} ${test.error.message}`);
    abortMerge();
    process.exit(20);
  }
  if (test.timedOut) {
    console.error(`[merge-task] Error: test command timed out: ${command} (limit ${testTimeoutMs}ms)`);
    abortMerge();
    process.exit(20);
  }
  if (test.status !== 0 || test.signal !== null) {
    console.error(`[merge-task] Error: test command failed: ${command}`
      + `\n[merge-task] Verify source: ${verifySource}`);
    abortMerge();
    process.exit(20);
  }
}
const testDuration = Date.now() - startedAt;

const stateAfterTest = git(['status', '--porcelain=v1', '--untracked-files=all']);
if (stateAfterTest !== stateBeforeTest) {
  console.error('[merge-task] Error: the test command modified the working tree; '
    + 'refusing to commit test side effects into the integration history');
  console.error('[merge-task] Entry state:');
  console.error(stateBeforeTest === '' ? '(clean)' : stateBeforeTest);
  console.error('[merge-task] Exit state:');
  console.error(stateAfterTest === '' ? '(clean)' : stateAfterTest);
  // 先撤掉测试对**已跟踪文件**的改写，再 abort：索引里带着测试改写时
  // `git merge --abort` 会因 Entry not uptodate 失败，把可恢复的情况升级成 exit 40 人工介入。
  // 只恢复已跟踪文件；测试新建的未跟踪文件保留原样，由人工判断是否清理。
  const restore = gitMaybe(['checkout', '--', '.']);
  if (restore.error || restore.status !== 0) {
    console.error('[merge-task] Warning: could not restore tracked files before aborting: '
      + `${restore.error?.message ?? restore.stderr}`);
  }
  const cleanUntracked = gitMaybe(['clean', '-nd']);
  if (!cleanUntracked.error && cleanUntracked.status === 0 && cleanUntracked.stdout.trim() !== '') {
    console.error('[merge-task] Untracked files left by the test command (NOT deleted):');
    console.error(cleanUntracked.stdout.trim());
  }
  abortMerge();
  process.exit(20);
}

try {
  markTasksDone(tasksFile, requestedTasks, tip7, reviewTag);
  const driftNote = drifted ? ` baseline-drift=${reviewedBase7}..${preMergeHead.slice(0, 7)}` : '';
  const legacyNote = allowLegacyAuthor ? ' author-provenance=BYPASSED(legacy)' : '';
  appendRunLog(
    logFile,
    `- ${new Date().toISOString()} merge tasks=${taskIds.join(',')} branch=${branch} source=${tip} review=${reviewTag} test_cmd=${JSON.stringify(testPlan)} verify_source=${JSON.stringify(verifySource)} test_duration=${testDuration}ms${driftNote}${legacyNote}`
  );
  git(['add', tasksFile, logFile]);
  const trailers = [
    `Pipeline-Task: ${taskIds.join(',')}`,
    `Pipeline-Source: ${tip}`,
  ];
  // 合流提交记录参与本次合流的全部作者与角色（去重、稳定排序），
  // 而不是只抄「第一个」——否则跨 commit 的任务在账本上看不出真实作者集合。
  const authors = [...new Set(provenance.flatMap(({ authors: a }) => a))].sort();
  const roles = [...new Set(provenance.flatMap(({ roles: r }) => r))].sort();
  for (const author of authors) trailers.push(`Pipeline-Author: ${author}`);
  for (const role of roles) trailers.push(`Pipeline-Role: ${role}`);
  trailers.push(`Pipeline-Reviewer: ${reviewer}`);

  git([
    'commit',
    '-m',
    `merge(${taskIds.join(',')}): ${branch}`,
    '-m',
    trailers.join('\n'),
  ]);
} catch (error) {
  console.error(`[merge-task] Error: ${error.stack || error.message}`);
  abortMerge();
  process.exit(1);
}

const mergeSha = git(['rev-parse', 'HEAD']);
console.log(`[merge-task] Success: tasks=${taskIds.join(',')} branch=${branch} source=${tip} merge=${mergeSha} test_duration=${testDuration}ms`);
