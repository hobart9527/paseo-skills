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
//   - 读不到 tasks.md → 放行并标注（fail-open）。守卫是减速带，不是沙箱；
//     锁死工作区的代价远大于漏拦一次。
//   - 账本**损坏** → 命中 Write scope 时拒绝，不算 fail-open 的例外。缺账本时「没有 run」
//     是一句可核验的结论；损坏时租约与在途写手意图都读不出来，把它读成「没有 run」等于让
//     deny 静默退化成 allow（SCEN-LED-03）。损坏时 scope 也无法判定（tasks.md 缺席/解析失败/
//     读取失败）同样拒绝：没有「确证在 scope 外」这个结论，放行等于拿两个未知换一个 allow。
//     其余 scope 外的写入照常放行——一份遗留的损坏账本不该锁死整个仓库，但放行必须把损坏
//     写进 reason 与 `corrupt`/`corruptions`，否则「账本读不了」在最需要它的路径上消失。
//     人工排障仍可设 PIPELINE_GUARD_SCOPE=off 豁免。
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
 * 目标路径所在目录（沿父目录向上找到**最深的存在目录**）。
 *
 * 用来把「以哪个仓库为准」从调用方的 cwd 解耦：PreToolUse hook 由 Claude Code 在
 * session 的 cwd 下启动，而 session 的 cwd 与写入目标所在的仓库可以不同（写绝对路径
 * 到另一个 checkout 很常见）。若拿 cwd 去找账本，目标仓库的租约就完全看不见，
 * 守卫静默放行——实际测到过：从 paseo-skills 目录调用，对 /tmp 下带租约的仓库写入
 * 得到空输出（= 放行）。
 */
function deepestExistingDir(target) {
  let current = path.resolve(target);
  for (;;) {
    try {
      if (fs.statSync(current).isDirectory()) return current;
    } catch {
      // 不存在：继续向上。
    }
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(target);
    current = parent;
  }
}

/**
 * 选定判定所用的仓库上下文。
 *
 * 优先用调用方的 cwd（相对路径与常规调用都依赖它）；只有当解析后的目标**落在
 * cwd 所在仓库之外**时，才改用目标自身的目录反推仓库。这样既能保持 `guard-scope.mjs
 * <change> --path src/x.mjs` 的旧语义，也能覆盖 hook 从别的仓库 cwd 启动、对绝对路径
 * 写入另一个 checkout 的场景。
 *
 * @returns {{root: string, base: string}} root=仓库根（realpath），base=查账本用的目录
 */
function contextForTarget(target, cwd) {
  const resolved = path.resolve(cwd, target);
  const cwdRoot = realpathLoose(repoRoot(cwd));
  const relativeToCwdRoot = path.relative(cwdRoot, realpathLoose(resolved));
  if (!relativeToCwdRoot.startsWith('..') && !path.isAbsolute(relativeToCwdRoot)) {
    return { root: cwdRoot, base: cwd };
  }
  const base = deepestExistingDir(resolved);
  return { root: realpathLoose(repoRoot(base)), base };
}

/**
 * `root` 是否主 checkout（`git-dir` 与 `git-common-dir` 指向同一处）。
 * linked worktree 的 git-dir 是 `<common>/worktrees/<name>`，两者不同。
 * 任何一步读不出来都返回 false（不当作主 checkout）：守卫是减速带，拿不准就放行。
 */
function isMainCheckout(root) {
  try {
    const read = (flag) => fs.realpathSync(path.resolve(root, execFileSync('git', ['rev-parse', flag], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000,
    }).trim()));
    return read('--git-dir') === read('--git-common-dir');
  } catch {
    return false;
  }
}

/**
 * 枚举当前持有**有效租约**的 change，并单独列出账本损坏的 change。
 *
 * 没有有效租约的 change 不拦截：租约过期意味着上一任编排者已死，此时任何写入都不该
 * 被一份陈旧账本冻住。扫描只读 run-state.json，不调用 Paseo。
 *
 * 损坏的账本必须与「没有租约」分开报告：前者的租约、在途写手意图、待批状态全都读不出来，
 * 把它并进 active（因为读不出 lease 而被丢弃）等于让守卫在账本坏掉时静默放行。
 *
 * @returns {{active: Array<{change: string, lease: object, state: object}>,
 *            corrupt: Array<{change: string, file: string, error: string}>}}
 */
export function activeLeases(cwd = process.cwd(), now = Date.now()) {
  const root = runStateRoot(cwd);
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return { active: [], corrupt: [] };
  }
  const active = [];
  const corrupt = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const change = entry.name;
    // 目录名可能是历史遗留的旗标形态（`--change`），它不是 change 名，跳过。
    if (change.startsWith('-') || change.startsWith('.')) continue;
    const ledger = readRunState(change, cwd);
    if (!ledger.present) continue;
    if (ledger.corrupt) {
      corrupt.push({ change, file: ledger.file, error: ledger.error, state: ledger.state });
      continue;
    }
    const lease = leaseStatus(ledger.state, now);
    if (lease === null || !lease.valid) continue;
    active.push({ change, lease, state: ledger.state });
  }
  return { active, corrupt };
}

/**
 * 判定一次写入。
 *
 * `ledger` 可注入 readRunState 的结果（扫描路径共享同一次读取）；缺省时自行读。
 * 损坏时**先于租约判定**处置：空 state 没有租约，若只看 leaseStatus，损坏账本会被读成
 * 「未在 run 内」而放行——那正是 SCEN-LED-03 禁止的 deny 静默降级。
 *
 * @param {{change: string, target: string, cwd?: string, state?: object,
 *          ledger?: object, now?: number}} input
 * @returns {{verdict: 'allow'|'deny', reason: string, path: string|null,
 *            scopeOwners: string[], covered: string[], lease: object|null,
 *            corrupt: {file: string, error: string}|null}}
 */
export function assessWrite({
  change, target, cwd = process.cwd(), state = null, ledger = null, now = Date.now(),
}) {
  const blank = { path: null, scopeOwners: [], covered: [], lease: null, corrupt: null };
  const { root, base: ledgerCwd } = contextForTarget(target, cwd);
  const ledgerInfo = state !== null ? null : (ledger ?? readRunState(change, ledgerCwd));
  const corrupt = ledgerInfo?.corrupt ? { file: ledgerInfo.file, error: ledgerInfo.error } : null;
  const ledgerState = state ?? ledgerInfo?.state ?? {};
  const lease = corrupt === null ? leaseStatus(ledgerState, now) : null;
  // 放行理由必须自己带上损坏说明，不能只靠结构化字段：CLI 的人类可读通道只打印 reason
  // （guard-scope.mjs 的 emit 读的是这一句）。只在 reason 上附加，不改 verdict——
  // R1 审计 SPEC_VIOLATION（scope-guard.mjs:294）要的是「allow 时也不吞掉损坏」，
  // 不是「损坏就让无关写入也 deny」。
  // 扫描形态下这段说明会与 assessAnyWrite 的 withCorruptions 交叠，由后者按文件路径去重。
  const allow = (fields) => (corrupt === null
    ? { ...blank, ...fields, verdict: 'allow' }
    : {
      ...blank, ...fields, corrupt, verdict: 'allow',
      reason: `${fields.reason}；运行账本已损坏（${corrupt.error}），`
        + '被损坏 change 的租约与在途意图均不可读',
    });
  if (corrupt === null && (lease === null || !lease.valid)) {
    return {
      ...blank,
      verdict: 'allow',
      reason: lease === null ? '无编排租约（未在 run 内）' : `租约已过期（owner=${lease.owner}，到期 ${lease.expiresAt}）`,
    };
  }
  const relative = path.relative(root, realpathLoose(path.resolve(cwd, target)));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return allow({ lease, reason: '目标不在本仓库内' });
  }
  const normalized = relative.split(path.sep).join('/');
  if (normalized === 'openspec' || normalized.startsWith('openspec/')) {
    // 账本与规范产物是流程自身的写入范围，不属于任何任务的业务 scope。
    return allow({ path: normalized, lease, reason: 'openspec/ 下的流程产物' });
  }

  // scope 判据读不出来时，**不能**用「读不出」去证明「不在 scope 内」。
  // 账本健康时这是有意的 fail-open（守卫是减速带，锁死工作区的代价更大）；
  // 账本损坏时则相反：这时唯一诚实的状态是「scope 未知且现场损坏」，放行等于把两个未知
  // 叠成一个 allow。R1 审计 SPEC_VIOLATION（scope-guard.mjs:213）即此。
  const unknownScope = (detail) => (corrupt === null
    ? allow({ path: normalized, lease, reason: `${detail}；无法判定 scope（fail-open）` })
    : {
      ...blank, path: normalized, lease: null, corrupt, verdict: 'deny',
      reason: `${detail}，且运行账本已损坏（${corrupt.error}）：无法判定 scope（目标是否命中未知）。`
        + '不能把「读不出」当成「不在 scope 内」，故拒绝写入。先按 corruptLedgerGuidance '
        + '修复或移开账本留档；若这是人工排障，设 PIPELINE_GUARD_SCOPE=off 显式豁免。',
    });

  const tasksFile = path.join(root, 'openspec', 'changes', change, 'tasks.md');
  if (!fs.existsSync(tasksFile)) return unknownScope(`读不到 ${tasksFile}`);
  // 存在 ≠ 可读：tasks.md 变成目录（EISDIR）、权限不足、I/O 错误都会在这里抛。
  // 让异常冒出去会把 CLI 变成崩溃（exit 1 + 栈），hook 侧则被顶层 catch 吞成放行——
  // 两种都不诚实。它与「读不到」「解析失败」同属 scope 未知，走同一条判据。
  let source;
  try {
    source = fs.readFileSync(tasksFile, 'utf8');
  } catch (error) {
    return unknownScope(`读取失败 ${tasksFile}（${error.code ?? error.message}）`);
  }
  const { tasks, errors } = parseTasks(source);
  if (errors.length > 0 || tasks.length === 0) {
    return unknownScope(`tasks.md 解析异常（${errors.length} 条）`);
  }
  const owners = tasks.filter((task) => isFileWithinScopes(normalized, task.scope));
  if (owners.length === 0) {
    return allow({
      path: normalized, lease,
      reason: '不在任何任务的 Write scope 内（越界提交由 merge-task exit 30 兜底）',
    });
  }

  const owned = owners.map((task) => task.id);
  // 损坏：真源（租约、在途写手意图）全部读不出来。此处**不能**按「没有意图」拒绝或
  // 按「没有租约」放行——两者都是从空壳里编出来的结论。只对确证落在任务 scope 内的
  // 写入拒绝：此时旧实现会放行，而这正是要堵的静默降级。scope 之外的写入按普通规则放行
  // （损坏账本不该冻结整个仓库），但输出里带上 corrupt 标记。
  if (corrupt !== null) {
    return {
      path: normalized, scopeOwners: owned, covered: [], lease: null, corrupt, verdict: 'deny',
      reason: `${normalized} 落在 ${owned.join(', ')} 的 Write scope 内，但运行账本已损坏，`
        + `租约与在途写手意图都无法读取（${corrupt.error}）。不能把「读不出」当成「没有 run」，`
        + '故拒绝写入。先按 corruptLedgerGuidance 修复或移开账本留档；'
        + '若这是人工排障，设 PIPELINE_GUARD_SCOPE=off 显式豁免。',
    };
  }

  // 命中 scope：必须能对上一个在途写手意图。
  // 已作废（fail）的意图不算覆盖——作废的语义是「这次派发没有发生」，它不能再当写入授权。
  const writerIntents = ledgerState.intents.filter((intent) => WRITER_ROLES.has(intent.role) && !isFailed(intent));
  const covered = owners.filter((task) => writerIntents.some((intent) => intent.task === task.id));
  const scopeOwners = owned;
  if (covered.length > 0 && isMainCheckout(root)) {
    // 意图在账本里只证明「这个任务派过写手」，不证明**此刻写入者就是那个写手**：
    // record 紧随 create_agent，写手干活时意图早已回执，所以不能用「未回执」收紧。
    // 能区分的是位置——写手一律在自己的 linked worktree 里（SKILL §8），主 checkout 属于
    // 编排者。有租约期间编排者在主 checkout 写任务 scope，就是 §13 的代写，意图存在也不例外。
    const coveredIds = covered.map((task) => task.id);
    return {
      path: normalized, scopeOwners, covered: coveredIds, lease, verdict: 'deny',
      reason: `${normalized} 落在 ${coveredIds.join(', ')} 的 Write scope 内，账本虽有写手意图，`
        + '但这里是主 checkout（不是写手的 linked worktree）。有租约期间业务代码只能由写手在其 worktree 里写，'
        + `编排者不得代写（owner=${lease.owner} gen=${lease.generation}；SKILL §8 硬红线）。`
        + '若这是人工排障，设 PIPELINE_GUARD_SCOPE=off 显式豁免。',
    };
  }
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

/**
 * 扫描全部活跃租约，返回第一个拒绝（没有拒绝则返回第一个允许的理由）。
 *
 * 损坏账本与活跃租约同样参与扫描：它没有可读的租约，若只遍历 active，损坏 change 上的
 * 任务 scope 写入会把「读不出授权」当成「没有 run」而放行（SCEN-LED-03）。
 *
 * 放行同样不得吞掉损坏信号（R1 审计 SPEC_VIOLATION，scope-guard.mjs:294）：扫描是
 * 「多个 change 的联合裁决」，一个健康 change 的 allow 不能代表另一个 change 的账本可读。
 * 因此 allow 也带上 `corruptions` 全集，理由里点名——否则调用方只看到「不在 scope 内」，
 * 而另一个 run 的租约与在途意图此刻全部不可读，这个事实被静默吃掉。
 */
export function assessAnyWrite({ target, cwd = process.cwd(), now = Date.now() }) {
  if (process.env.PIPELINE_GUARD_SCOPE === 'off') {
    return { verdict: 'allow', reason: 'PIPELINE_GUARD_SCOPE=off 显式关闭', change: null, path: null };
  }
  // 账本目录同样按目标反推，否则 hook 从别的仓库 cwd 启动时扫不到目标仓库的租约。
  const { base: ledgerCwd } = contextForTarget(target, cwd);
  const { active, corrupt } = activeLeases(ledgerCwd, now);
  let first = null;
  for (const { change, state } of active) {
    const verdict = assessWrite({ change, target, cwd, state, now });
    if (verdict.verdict === 'deny') return withCorruptions({ ...verdict, change }, corrupt);
    if (first === null) first = { ...verdict, change };
  }
  for (const entry of corrupt) {
    const verdict = assessWrite({
      change: entry.change, target, cwd, now,
      ledger: { corrupt: true, file: entry.file, error: entry.error, state: entry.state },
    });
    if (verdict.verdict === 'deny') return withCorruptions({ ...verdict, change: entry.change }, corrupt);
    if (first === null) first = { ...verdict, change: entry.change };
  }
  if (first === null) {
    return {
      verdict: 'allow', reason: '无有效编排租约', change: null, path: null, corruptions: [],
    };
  }
  return withCorruptions(first, corrupt);
}

function withCorruptions(verdict, corrupt) {
  const corruptions = corrupt.map((entry) => ({
    change: entry.change, file: entry.file, error: entry.error,
  }));
  if (corruptions.length === 0) return { ...verdict, corruptions };
  // 理由必须提到损坏：consumers（CLI 人类通道、hook）直接打印 reason，
  // 只在结构化字段里带上等于人类读不到。
  //
  // 但**已经点过名的**不再重复：assessWrite 的 allow/deny 理由自身就带上了它所依据那份损坏
  // 账本的文件与解析错误，扫描形态再整批追加一次，同一份账本会在同一句话里出现两遍
  // （「…运行账本已损坏（<file>）…；另有 1 个 change 的运行账本已损坏（c1）…」）。
  // 按文件路径去重，只补那些理由里还没提到的。
  const unreported = corruptions.filter((entry) => !verdict.reason.includes(entry.file));
  if (unreported.length === 0) return { ...verdict, corruptions };
  const note = `${unreported.length} 个 change 的运行账本已损坏`
    + `（${unreported.map((c) => c.change).join(', ')}），其租约与在途意图不可读`;
  return {
    ...verdict,
    corruptions,
    reason: `${verdict.reason}；另有 ${note}`,
  };
}
