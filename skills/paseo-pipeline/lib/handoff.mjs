// 交接门禁的**唯一判据**（零依赖）。
//
// 为什么需要它：确认点 1 之后、建集成 workspace 之前，change 产物必须是 git 里的事实。
// 产物只躺在工作树里时，写手拿到的是「本地看着有、git 里没有」的契约；`tasks.md` 不在
// 集成基点上时，任务能被派发，合流阶段却读不到它。两种事故都不报错，只在最后一公里变成返工。
//
// 判据必须机械且窄：
//   - change 目录是否已提交 —— `git status --porcelain` 逐路径点名，不报个数。
//   - tasks.md 是否在集成基点 —— 查 git 对象（`cat-file -e <base>:<path>`），**不读工作树**。
//     工作树可能被未提交改动污染，读它就等于把门禁判据交给了被检查对象。
//   - 当前分支必须是 integration/<name> —— 但**只在该分支已存在时**。
//     合法顺序是「提交冻结产物 → 跑交接门禁 → 建集成 workspace」，第三步之前集成分支还不存在；
//     此时硬要求当前分支是 integration/<name>，会把合法顺序判成 WRONG_BRANCH 死锁
//     （2026-10-31 审计 P0）。集成分支尚不存在时分支判据延后，按当前 commit 核对产物，
//     并把延后这件事写进 `notes`（`BRANCH_DEFERRED`）；分支一旦存在就按严格口径判。
//     task-runner 每次派发前复用时分支必然已存在，因此延后不会漏到派发。
//
// task-runner（T-03）派发前调用同一份 checkHandoff；CLI 外壳只做参数解析、输出与退出码。
// 判据逻辑禁止在调用方复制，否则两处判法漂移时门禁先绿后红。

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { changeIdProblem } from './change-id.mjs';

/** 判据涉及的三方事实，任一读不到都是阻断项（fail closed）。 */
export const HANDOFF_CODES = {
  BAD_CHANGE: 'BAD_CHANGE',
  NOT_A_REPO: 'NOT_A_REPO',
  BASE_UNREADABLE: 'BASE_UNREADABLE',
  BRANCH_UNREADABLE: 'BRANCH_UNREADABLE',
  WRONG_BRANCH: 'WRONG_BRANCH',
  DIRTY_CHANGE_DIR: 'DIRTY_CHANGE_DIR',
  TASKS_NOT_AT_BASE: 'TASKS_NOT_AT_BASE',
};

/** 不进 `problems` 的事实：判定延后了，但门禁并没有放过任何东西。 */
export const HANDOFF_NOTES = {
  BRANCH_DEFERRED: 'BRANCH_DEFERRED',
};

/**
 * 在 `root` 里执行 git，返回 { status, stdout, stderr }。
 *
 * 不用 execFileSync 抛异常：调用方需要的正是「命令失败」这件事本身（分支读不到、对象不存在），
 * 把它转成异常会让每个判据都得写一层 try/catch，错误归因反而更容易丢。
 */
function git(root, args) {
  return spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    timeout: 20_000,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

/**
 * 交接门禁。
 *
 * @param {object} options
 * @param {string} [options.root]   仓库根（默认 cwd）
 * @param {string} options.change   change 名（openspec/changes/<name>）
 * @param {string} [options.base]   集成基点（默认 HEAD：集成分支就是当前位置）
 * @returns {{ ok: boolean, branch: string|null, base: string, effectiveBase: string,
 *             deferred: boolean, change: string,
 *             problems: Array<{ code: string, message: string, path?: string }>,
 *             notes: Array<{ code: string, message: string }> }}
 *
 * `problems` 为空才 `ok`。每个 DIRTY_CHANGE_DIR 一条、`path` 精确到违规文件，
 * 供 CLI 逐行输出，也供 task-runner 直接引用而不必重算。
 *
 * `notes` 不进阻断项、不改退出码：它记录「这条判据这次没判、为什么」。目前唯一来源是
 * 集成分支尚不存在时的分支判据延后（`BRANCH_DEFERRED`）——把延后留在结构化输出里，
 * 调用方与人都看得到这次门禁少判了一条，而不是以为判过了。
 */
export function checkHandoff({ root = process.cwd(), change, base = 'HEAD' } = {}) {
  const problems = [];
  const notes = [];
  const changeDir = path.posix.join('openspec', 'changes', change);
  const expectedBranch = `integration/${change}`;

  const badChange = changeIdProblem(change);
  if (badChange !== null) {
    return {
      ok: false,
      branch: null,
      base,
      effectiveBase: base,
      deferred: false,
      change: change ?? null,
      problems: [{ code: HANDOFF_CODES.BAD_CHANGE, message: badChange }],
      notes,
    };
  }

  const inside = git(root, ['rev-parse', '--git-dir']);
  if (inside.status !== 0) {
    return {
      ok: false,
      branch: null,
      base,
      effectiveBase: base,
      deferred: false,
      change,
      problems: [{
        code: HANDOFF_CODES.NOT_A_REPO,
        message: `${root} 不是 git 仓库：交接门禁只能核对已提交事实，无法在非仓库目录判断`,
      }],
      notes,
    };
  }

  // --- 集成分支是否存在：分支判据分语境的唯一开关 ---
  // 用 `refs/heads/` 全名查，不让 `rev-parse integration/<name>` 的短名消歧规则替我们猜
  // （同名 tag 会让短名解析到别的对象，判定随仓库内容漂移）。
  const branchExists = git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${expectedBranch}`]).status === 0;

  // --- 基点：必须能解析成一个 commit ---
  // 解析不到时后续 cat-file 只报「对象不存在」，会把「基点写错了」误报成「tasks.md 没提交」。
  // 例外只有一种：基点写的就是还没创建的集成分支名。那是合法顺序里的「建分支之前」，
  // 此时按当前 commit 核对产物（等价于基点 = HEAD），并把延后记进 notes。
  //
  // 这个例外必须**先于** `rev-parse` 判定：`rev-parse integration/<name>^{commit}` 在分支不存在时
  // 仍可能解析到同名 tag，于是基点悄悄变成 tag 指向的那份历史——当前 commit 缺 tasks.md 也会
  // 因为 tag 有而放行（2026-10-31 审计 B2）。判据是「基点是集成分支名且该分支不存在」，与
  // 名字能否解析无关。
  const baseIsMissingIntegrationBranch = base === expectedBranch && !branchExists;
  let effectiveBase = baseIsMissingIntegrationBranch ? 'HEAD' : base;
  let baseCheckable = false;
  const baseSha = git(root, ['rev-parse', '--verify', '--quiet', `${effectiveBase}^{commit}`]);
  baseCheckable = baseSha.status === 0 && /^[0-9a-f]{40}$/.test(baseSha.stdout.trim());
  if (!baseCheckable) {
    problems.push({
      code: HANDOFF_CODES.BASE_UNREADABLE,
      message: `集成基点 ${base} 解析不到 commit：无法判断 change 产物是否已提交在基点上`,
    });
  }

  // --- 分支：集成分支存在时必须是 integration/<name>，不存在时延后 ---
  const branchResult = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const rawBranch = branchResult.status === 0 ? branchResult.stdout.trim() : '';
  const branch = rawBranch === '' || rawBranch === 'HEAD' ? null : rawBranch;
  if (branch === null) {
    problems.push({
      code: HANDOFF_CODES.BRANCH_UNREADABLE,
      message: `读不到当前分支（git rev-parse --abbrev-ref HEAD 返回 ${JSON.stringify(rawBranch)}）：`
        + `交接必须在 integration/${change} 上进行，detached HEAD 或空仓库都不满足`,
    });
  } else if (branch !== expectedBranch) {
    if (branchExists) {
      problems.push({
        code: HANDOFF_CODES.WRONG_BRANCH,
        message: `当前分支是 ${branch}，交接门禁要求 ${expectedBranch}：`
          + '在别的分支上核对 change 产物与 tasks.md 基点，核对的是另一份历史',
      });
    } else {
      // 集成分支还没建：合法顺序里这一步在它之前。不能在这里报 WRONG_BRANCH——
      // 那会让「提交产物 → 跑门禁 → 建 workspace」这条文档顺序必然死锁。
      notes.push({
        code: HANDOFF_NOTES.BRANCH_DEFERRED,
        message: `${expectedBranch} 尚不存在，本次按当前分支 ${branch} 的 commit 核对 change 产物，`
          + '分支判据延到集成 workspace 创建之后再判：建完必须在 '
          + `${expectedBranch} 上重跑本门禁（task-runner 每次派发前也会复用同一判据）`,
      });
    }
  }

  // --- change 目录：不得有未提交或未跟踪文件 ---
  // `--untracked-files=all` 展开目录：默认的目录级折叠只报 `?? openspec/changes/x/specs/`，
  // 而门禁要的是每个违规路径。用 `-z` 读原始输出，路径含空格时也不会被拆坏。
  const status = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', `${changeDir}/`]);
  if (status.status !== 0) {
    problems.push({
      code: HANDOFF_CODES.DIRTY_CHANGE_DIR,
      message: `git status 失败（exit ${status.status}）：无法确认 ${changeDir}/ 已全部提交\n`
        + `${(status.stderr ?? '').trim()}`,
    });
  } else {
    let renameSource = false;
    for (const entry of status.stdout.split('\0')) {
      // `-z` 下的重命名/复制条目是 `XY <新路径>\0<原路径>\0`：原路径那一段没有状态码前缀，
      // 不单独处理就会被 slice(3) 截成半截路径，门禁点错一个不存在的文件。
      // 这一段必须先于长度检查处理——源路径可能短于 4 个字符。
      if (renameSource) {
        renameSource = false;
        if (entry !== '') report(entry, '重命名/复制的源路径');
        continue;
      }
      if (entry.length <= 3) continue;
      const code = entry.slice(0, 2);
      if (code.includes('R') || code.includes('C')) renameSource = true;
      // 其余形如 ` M path` / `?? path`：前两列是状态码，第三列起是路径。
      report(entry.slice(3), code.trim());
    }
  }

  function report(filePath, state) {
    problems.push({
      code: HANDOFF_CODES.DIRTY_CHANGE_DIR,
      path: filePath,
      message: `${filePath}（${state}）未提交：change 产物必须是 git 里的已提交事实，`
        + '写手不能拿到只存在于本地工作树的契约',
    });
  }

  // --- tasks.md：必须能从集成基点读到 ---
  // 只查 git 对象，不看工作树：工作树可能被未提交改动污染，读它等于让被检查对象自己作证。
  // 读的是 `effectiveBase`：集成分支还没建时它退回 HEAD（见上），否则与 `base` 相同。
  if (baseCheckable) {
    const tasksPath = `${changeDir}/tasks.md`;
    const exists = git(root, ['cat-file', '-e', `${effectiveBase}:${tasksPath}`]);
    if (exists.status !== 0) {
      problems.push({
        code: HANDOFF_CODES.TASKS_NOT_AT_BASE,
        path: tasksPath,
        message: `${tasksPath} 在基点 ${effectiveBase} 上读不到（${effectiveBase}:${tasksPath} 不存在）：`
          + 'task-runner 派发时读不到任务契约，合流阶段才暴露就是返工',
      });
    }
  }

  const deferred = notes.some((note) => note.code === HANDOFF_NOTES.BRANCH_DEFERRED);
  return { ok: problems.length === 0, branch, base, effectiveBase, deferred, change, problems, notes };
}
