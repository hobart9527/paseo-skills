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
 * 同批合流内的依赖闭包：判定「这批任务一起合入时，哪些依赖算作已满足」。
 *
 * 为什么需要它：Pod 模式（`SKILL.md` §2.1）是**单次整体合流**，成员之间的依赖边在
 * 合流前不可能被 first-parent 证明——那个合流提交本身就是它们被证明的唯一机会。
 * 旧实现只认 first-parent 账本，于是「Pod 成员之间存在任何依赖」都会在合流口
 * exit 35 死锁，而冻结检查不看这条，报告仍说「0 阻断项」——门禁发现得太晚。
 *
 * 语义边界（不得放宽）：
 *   - 只有**本次请求合入的任务集合**内部才算满足；集合外的一概不豁免。
 *   - 依赖必须真的在集合里。集合里没声明这个依赖任务 → 不豁免，仍按 first-parent 判。
 *
 * 环不在本函数处理：`lib/tasks.mjs` 的 Kahn 检测把环判为 graph 级错误，
 * 整份账本在到达依赖门禁前就已被拒绝。这里再判一次是不可达的死代码。
 *
 * @param {{id: string, depends: string[]}} task 被检查的任务
 * @param {string[]} batchIds 本次一并合入的任务 id 集合
 * @param {Map<string, {id: string, depends: string[]}>} byId 全量任务索引，用于递归
 * @returns {{satisfied: string[], outside: string[]}}
 *   satisfied = 由本批次满足的依赖（传递闭包）；outside = 仍需 first-parent 证明的依赖
 */
export function batchDependencyClosure(task, batchIds, byId) {
  const batch = new Set(batchIds);
  const satisfied = new Set();
  const outside = new Set();
  // 显式栈而不是递归：依赖图在真实 change 里是两位数深度，但显式栈让『同批满足』
  // 这一条判据的传播路径一眼可读，不必在脑子里展开调用栈。
  const stack = [...task.depends];
  while (stack.length > 0) {
    const id = stack.pop();
    if (!batch.has(id)) { outside.add(id); continue; }
    if (satisfied.has(id)) continue;
    satisfied.add(id);
    const next = byId.get(id);
    if (next === undefined) continue;
    for (const dep of next.depends) stack.push(dep);
  }
  return { satisfied: [...satisfied], outside: [...outside] };
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
