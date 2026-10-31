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
//   - 当前分支必须是 integration/<name> —— 不假定、不推导，直接问 `rev-parse`。
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
 * @returns {{ ok: boolean, branch: string|null, base: string, change: string,
 *             problems: Array<{ code: string, message: string, path?: string }> }}
 *
 * `problems` 为空才 `ok`。每个 DIRTY_CHANGE_DIR 一条、`path` 精确到违规文件，
 * 供 CLI 逐行输出，也供 task-runner 直接引用而不必重算。
 */
export function checkHandoff({ root = process.cwd(), change, base = 'HEAD' } = {}) {
  const problems = [];
  const changeDir = path.posix.join('openspec', 'changes', change);

  const badChange = changeIdProblem(change);
  if (badChange !== null) {
    return {
      ok: false,
      branch: null,
      base,
      change: change ?? null,
      problems: [{ code: HANDOFF_CODES.BAD_CHANGE, message: badChange }],
    };
  }

  const inside = git(root, ['rev-parse', '--git-dir']);
  if (inside.status !== 0) {
    return {
      ok: false,
      branch: null,
      base,
      change,
      problems: [{
        code: HANDOFF_CODES.NOT_A_REPO,
        message: `${root} 不是 git 仓库：交接门禁只能核对已提交事实，无法在非仓库目录判断`,
      }],
    };
  }

  // --- 基点：必须能解析成一个 commit ---
  // 解析不到时后续 cat-file 只报「对象不存在」，会把「基点写错了」误报成「tasks.md 没提交」。
  const baseSha = git(root, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]);
  const baseOk = baseSha.status === 0 && /^[0-9a-f]{40}$/.test(baseSha.stdout.trim());
  if (!baseOk) {
    problems.push({
      code: HANDOFF_CODES.BASE_UNREADABLE,
      message: `集成基点 ${base} 解析不到 commit：无法判断 change 产物是否已提交在基点上`,
    });
  }

  // --- 分支：必须是 integration/<name> ---
  const branchResult = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const rawBranch = branchResult.status === 0 ? branchResult.stdout.trim() : '';
  const branch = rawBranch === '' || rawBranch === 'HEAD' ? null : rawBranch;
  if (branch === null) {
    problems.push({
      code: HANDOFF_CODES.BRANCH_UNREADABLE,
      message: `读不到当前分支（git rev-parse --abbrev-ref HEAD 返回 ${JSON.stringify(rawBranch)}）：`
        + `交接必须在 integration/${change} 上进行，detached HEAD 或空仓库都不满足`,
    });
  } else if (branch !== `integration/${change}`) {
    problems.push({
      code: HANDOFF_CODES.WRONG_BRANCH,
      message: `当前分支是 ${branch}，交接门禁要求 integration/${change}：`
        + '在别的分支上核对 change 产物与 tasks.md 基点，核对的是另一份历史',
    });
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
  if (baseOk) {
    const tasksPath = `${changeDir}/tasks.md`;
    const exists = git(root, ['cat-file', '-e', `${base}:${tasksPath}`]);
    if (exists.status !== 0) {
      problems.push({
        code: HANDOFF_CODES.TASKS_NOT_AT_BASE,
        path: tasksPath,
        message: `${tasksPath} 在基点 ${base} 上读不到（${base}:${tasksPath} 不存在）：`
          + 'task-runner 派发时读不到任务契约，合流阶段才暴露就是返工',
      });
    }
  }

  return { ok: problems.length === 0, branch, base, change, problems };
}
