// 任务账本验证的单一属主：Done 验收判定与依赖释放。
//
// 为什么必须抽出来：`reconcile.mjs` 用 first-parent 合流提交验证「已勾选 = 真合流」，
// 而 `merge-task.mjs` 过去只看 tasks.md 的 `[x]` 与 `Done:` 行文本。两条路径各自推导同一语义，
// 结果是合流入口可以被绕过——直接调用 merge-task 合一个依赖尚未验收的任务，
// 或者在一个没有被 first-parent 合流证明过的 Done 行上继续叠加。
//
// 本模块只做一件有确定性答案的事：**给定 HEAD，一个任务的 Done 行是否被 first-parent
// 合流提交证明**。判定依据是合流提交的第二父提交（= 任务分支 tip）与该合流提交的
// `Pipeline-Task:` trailer 同时成立。两者缺一即无效——这正是 D4 的定义。
//
// 无 git 依赖之外的副作用；不读写任何文件。

/**
 * @typedef {(args: string[]) => string|null} GitReader
 *   返回 stdout（已 trim），失败返回 null。调用方决定 null 的语义（有的是 fatal，有的跳过）。
 */

/** Done 行里的 7 位 source 唯一展开为 commit；歧义（多个候选）或无法展开返回 null。 */
export function expandDoneSource(read, abbrev) {
  const listed = read(['rev-parse', `--disambiguate=${abbrev}`]);
  if (listed === null) return null;
  const candidates = listed
    .split('\n')
    .filter(Boolean)
    .filter((sha) => read(['cat-file', '-t', sha]) === 'commit');
  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * 建立 first-parent 合流索引：second-parent-sha -> Set<task id>。
 *
 * 只扫 first-parent 上的 --merges：侧分支上的合流、cherry-pick、普通提交都不产生验收。
 * 每个合流提交的 Pipeline-Task trailer 声明它验收了哪些任务。
 *
 * @param {GitReader} read
 * @param {string} [head] 默认 HEAD
 * @returns {Map<string, Set<string>>}
 */
export function buildMergeAcceptance(read, head = 'HEAD') {
  const acceptance = new Map();
  const log = read(['log', '--first-parent', '--merges', '--format=%H', head]) ?? '';
  for (const commit of log.split('\n').filter(Boolean)) {
    const second = read(['rev-parse', `${commit}^2`]);
    if (!second) continue;
    const body = read(['log', '-1', '--format=%B', commit]) ?? '';
    const accepted = new Set();
    for (const line of body.split('\n')) {
      const trailer = line.match(/^Pipeline-Task:\s*(.+)$/);
      if (!trailer) continue;
      for (const token of trailer[1].split(/[,\s]+/).filter(Boolean)) accepted.add(token);
    }
    acceptance.set(second, accepted);
  }
  return acceptance;
}

/**
 * 任务是否被 first-parent 合流提交证明为 Done。
 *
 * @param {{id: string, done: boolean, doneLine: {source: string}|null}} task
 * @param {Map<string, Set<string>>} acceptance buildMergeAcceptance 的结果
 * @param {GitReader} read
 */
export function doneVerified(task, acceptance, read) {
  if (!task.done || !task.doneLine) return false;
  const source = expandDoneSource(read, task.doneLine.source);
  if (!source) return false;
  return acceptance.get(source)?.has(task.id) === true;
}

/**
 * 一次性算出一组任务的 Done 状态。
 *
 * @returns {{doneSet: Set<string>, unverified: Array<{id: string, reason: string}>}}
 */
export function verifyDone(tasks, read, head = 'HEAD') {
  const acceptance = buildMergeAcceptance(read, head);
  const doneSet = new Set();
  const unverified = [];
  for (const task of tasks) {
    if (!task.done) continue;
    if (doneVerified(task, acceptance, read)) {
      doneSet.add(task.id);
    } else {
      unverified.push({
        id: task.id,
        reason: task.doneLine
          ? `Done 行 source=${task.doneLine.source} 无对应的 first-parent 合流提交（账本失配）`
          : '已勾选但没有 Done 行',
      });
    }
  }
  return { doneSet, unverified };
}
