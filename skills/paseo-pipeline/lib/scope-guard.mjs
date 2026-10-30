// 写范围判定（零依赖）：有编排租约期间，命中任务 Write scope 的写入必须
// 能对上一个在途写手意图，否则拒绝。
//
// 为什么需要它：2026-10-27 `eas-filing-and-local-ocr` 的越权代写（LESSONS §13）里，
// 总控在主 checkout 直接写了 `invoice-parser-service.ts` —— 那是 T-02 的 Write scope。
// 全部门禁都在别处生效：`merge-task.mjs` exit 30/31 只在**合流**时检查，原地写完不提交
// 就根本走不到合流。`reconcile.mjs` 现在能看见脏树（同一个 `isFileWithinScopes`），
// 但看见已经晚了；本模块是**写之前**的那道减速带。
//
// 两个入口共用这一份判据：
//   guard-scope.mjs              —— 人工/诊断用 CLI（单 change，退出码表达裁决）
//   hooks/scope-guard-hook.mjs   —— PreToolUse hook（扫描全部活跃租约，输出 deny JSON）
//
// 刻意保守，宁可少拦：
//   - 无有效租约 → 放行。日常小修与诊断不该被流水线规程拦住（门禁只在一次 run 内成立）。
//   - 路径不在任何任务的 Write scope 内 → 放行并标注。越界提交由 merge-task exit 30 兜底，
//     本判据不假装能做路径归属的全部判断。
//   - 读不到 tasks.md / 账本 → 放行并标注（fail-open）。守卫是减速带，不是沙箱；
//     锁死工作区的代价远大于漏拦一次。
//
// 已知覆盖缺口（必须如实记录，不要靠它宣称隔离）：Bash 里的 `sed -i`、`>` 重定向、
// `git apply` 都能写文件，本判据看不到；它只对结构化写入工具（Write/Edit）生效。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseTasks, isFileWithinScopes } from './tasks.mjs';
import { readRunState, runStateRoot, leaseStatus, isFailed } from './run-state.mjs';
import { WRITER_ROLES } from './roles.mjs';

/** 仓库根（用于把绝对路径换成仓内相对路径）。非 git 仓库时退回 cwd。 */
function repoRoot(cwd) {
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000,
    }).trim();
    return top === '' ? cwd : top;
  } catch {
    return cwd;
  }
}

/**
 * 两边都先过 realpath 再比较。
 *
 * macOS 上 `/tmp` 是 `/private/tmp` 的符号链接，git 返回的是 realpath，而写入工具的
 * file_path 通常不是——只做 `path.relative` 会得到 `../../..`，于是所有写入都被判成
 * 「不在本仓库内」而放行（守卫静默失效，且没有任何信号）。目标文件可能尚不存在（新建文件），
 * 所以沿父目录向上找到**最深的存在祖先**做 realpath，再把剩余段接回去。
 */
function realpathLoose(target) {
  let current = path.resolve(target);
  const rest = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...rest);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * 枚举当前持有**有效租约**的 change。
 *
 * 没有有效租约的 change 不拦截：租约过期意味着上一任编排者已死，此时任何写入都不该
 * 被一份陈旧账本冻住。扫描只读 run-state.json，不调用 Paseo。
 *
 * @returns {Array<{change: string, lease: object, state: object}>}
 */
export function activeLeases(cwd = process.cwd(), now = Date.now()) {
  const root = runStateRoot(cwd);
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const active = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const change = entry.name;
    // 目录名可能是历史遗留的旗标形态（`--change`），它不是 change 名，跳过。
    if (change.startsWith('-') || change.startsWith('.')) continue;
    const ledger = readRunState(change, cwd);
    if (!ledger.present) continue;
    const lease = leaseStatus(ledger.state, now);
    if (lease === null || !lease.valid) continue;
    active.push({ change, lease, state: ledger.state });
  }
  return active;
}

/**
 * 判定一次写入。
 *
 * @param {{change: string, target: string, cwd?: string, state?: object, now?: number}} input
 * @returns {{verdict: 'allow'|'deny', reason: string, path: string|null,
 *            scopeOwners: string[], covered: string[], lease: object|null}}
 */
export function assessWrite({ change, target, cwd = process.cwd(), state = null, now = Date.now() }) {
  const base = { path: null, scopeOwners: [], covered: [], lease: null };
  const ledgerState = state ?? readRunState(change, cwd).state;
  const lease = leaseStatus(ledgerState, now);
  if (lease === null || !lease.valid) {
    return {
      ...base,
      verdict: 'allow',
      reason: lease === null ? '无编排租约（未在 run 内）' : `租约已过期（owner=${lease.owner}，到期 ${lease.expiresAt}）`,
    };
  }
  const root = realpathLoose(repoRoot(cwd));
  const relative = path.relative(root, realpathLoose(path.resolve(cwd, target)));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return { ...base, lease, verdict: 'allow', reason: '目标不在本仓库内' };
  }
  const normalized = relative.split(path.sep).join('/');
  if (normalized === 'openspec' || normalized.startsWith('openspec/')) {
    // 账本与规范产物是流程自身的写入范围，不属于任何任务的业务 scope。
    return { ...base, path: normalized, lease, verdict: 'allow', reason: 'openspec/ 下的流程产物' };
  }

  const tasksFile = path.join(root, 'openspec', 'changes', change, 'tasks.md');
  if (!fs.existsSync(tasksFile)) {
    return { ...base, path: normalized, lease, verdict: 'allow', reason: `读不到 ${tasksFile}；无法判定 scope（fail-open）` };
  }
  const { tasks, errors } = parseTasks(fs.readFileSync(tasksFile, 'utf8'));
  if (errors.length > 0 || tasks.length === 0) {
    return {
      ...base, path: normalized, lease, verdict: 'allow',
      reason: `tasks.md 解析异常（${errors.length} 条）；无法判定 scope（fail-open）`,
    };
  }
  const owners = tasks.filter((task) => isFileWithinScopes(normalized, task.scope));
  if (owners.length === 0) {
    return {
      ...base, path: normalized, lease, verdict: 'allow',
      reason: '不在任何任务的 Write scope 内（越界提交由 merge-task exit 30 兜底）',
    };
  }

  // 命中 scope：必须能对上一个在途写手意图。
  // 已作废（fail）的意图不算覆盖——作废的语义是「这次派发没有发生」，它不能再当写入授权。
  const writerIntents = ledgerState.intents.filter((intent) => WRITER_ROLES.has(intent.role) && !isFailed(intent));
  const owned = owners.map((task) => task.id);
  const covered = owners.filter((task) => writerIntents.some((intent) => intent.task === task.id));
  const scopeOwners = owned;
  if (covered.length > 0) {
    const coveredIds = covered.map((task) => task.id);
    const coveredOpen = covered.filter((task) => writerIntents.some((intent) =>
      intent.task === task.id && !intent.resolvedAt));
    return {
      path: normalized, scopeOwners, covered: coveredIds, lease, verdict: 'allow',
      reason: `落在 ${coveredIds.join(', ')} 的 Write scope，且账本有对应写手意图`
        + `${coveredOpen.length > 0 ? '（含在途未回执）' : ''}`,
    };
  }
  return {
    path: normalized, scopeOwners, covered: [], lease, verdict: 'deny',
    reason: `${normalized} 落在 ${owned.join(', ')} 的 Write scope 内，但账本里没有这些任务的写手意图`
      + `（owner=${lease.owner} gen=${lease.generation}）。有租约期间的写入必须先 claim 再派发；`
      + '总控不得直接改业务代码（SKILL §8 硬红线）。若这是人工排障，设 PIPELINE_GUARD_SCOPE=off 显式豁免。',
  };
}

/** 扫描全部活跃租约，返回第一个拒绝（没有拒绝则返回第一个允许的理由）。 */
export function assessAnyWrite({ target, cwd = process.cwd(), now = Date.now() }) {
  if (process.env.PIPELINE_GUARD_SCOPE === 'off') {
    return { verdict: 'allow', reason: 'PIPELINE_GUARD_SCOPE=off 显式关闭', change: null, path: null };
  }
  let first = null;
  for (const { change, state } of activeLeases(cwd, now)) {
    const verdict = assessWrite({ change, target, cwd, state, now });
    if (verdict.verdict === 'deny') return { ...verdict, change };
    if (first === null) first = { ...verdict, change };
  }
  return first ?? { verdict: 'allow', reason: '无有效编排租约', change: null, path: null };
}
