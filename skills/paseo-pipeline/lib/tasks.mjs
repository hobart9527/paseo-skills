// tasks.md 单一解析器（零依赖）。
// reconcile 与 merge-task 共用，避免各自正则漂移。
//
// 任务行：- [ ] 1.1 T-01 Title
// 子字段（缩进）：Depends on / Write scope / Review / Risk-surface / Verify with /
//                Scenarios / Done ...
// Done 行：source=<tip7> review=<tag>，仅当任务已勾选时校验。
//
// parseTasks(markdown) => { tasks, errors }
// error: { code, message, task }，task 为任务 ID（未知时回落到原始任务行号/文本）。
//
// 校验：MALFORMED_LINE、DUPLICATE_ID、UNKNOWN_DEP、SELF_DEP、CYCLE（Kahn）、
//      MISSING_SCOPE、BAD_DONE_LINE、UNKNOWN_RISK、REVIEW_RISK_CONFLICT。
// 只报错，不吞任务：任务数组始终保留可解析部分。
//
// 风险与验证等级（L1-04）：`Review` 只有显式声明才生效，缺省**不**等于 mechanical；
// 任一非 `none` 的 Risk-surface 会推导为 strict。推导只上调不下调，因此不存在
// 「漏写 Review 被当成低风险机械放行」的通路。

// 任务行：`- [ ] 1.1 T-01 标题` 与 `- [ ] 1.1 T-01: 标题` 两种写法都合法。
// 冒号形式是既有历史产物（早期 pipeline 一律这么写，见仓库内已归档 change 与
// contract-check 的 `--tasks` 夹具）；只认空格形式会让这些 tasks.md 整份解析成 0 条任务，
// 对账与合流一起失效。冒号后面的内容一律当标题，不再参与 ID 识别。
/**
 * 错误码的严重度归属——**唯一属主**。
 *
 * 同一份 tasks.md 原本有四种判法：reconcile.mjs 只看 5 个码、contract-check.mjs 只看 2 个、
 * merge-task.mjs 对任意错误全拒、hotfix.sh 单独放过 MISSING_SCOPE。后果是两个方向都错：
 *   - merge-task 因一条无关任务的 MISSING_SCOPE 挡住整批合流，与「单个任务的问题只压住
 *     被点名的任务」直接矛盾；
 *   - hotfix 放过 MISSING_SCOPE 没有任何理由记录在案。
 *
 * 因此按「这个错误的破坏范围」分两类，不再按调用方的宽松程度各写一份：
 *   graph  任务图本身不可信（行错、ID 重复、依赖缺失/自环/成环）。任何依赖 DAG 的判断
 *          都可能错，整份文件不可用。
 *   task   只影响被点名的那个任务。其它任务照常可派发、可合流。
 */
export const ERROR_SCOPE = {
  MALFORMED_LINE: 'graph',
  DUPLICATE_ID: 'graph',
  UNKNOWN_DEP: 'graph',
  SELF_DEP: 'graph',
  CYCLE: 'graph',
  MISSING_SCOPE: 'task',
  BAD_DONE_LINE: 'task',
  UNKNOWN_REVIEW: 'task',
  UNKNOWN_RISK: 'task',
  UNKNOWN_FIELD: 'task',
  REVIEW_RISK_CONFLICT: 'task',
};

/** 该错误是否让整份 tasks.md 不可用。未知错误码按 graph 处理（fail closed）。 */
export function isGraphError(code) {
  return (ERROR_SCOPE[code] ?? 'graph') === 'graph';
}

/** 只保留让整份文件不可用的错误。 */
export function graphErrors(errors) {
  return errors.filter((error) => isGraphError(error.code));
}

/**
 * 让「任务集合与字段归属」不可信的码。
 *
 * 这是与 graph/task 正交的第二个轴，只服务一个刻意的窄用途：contract-check 从 tasks.md
 * 抽取测试路径时，只要任务集合与每个任务的字段归属是对的，抽取结果就可信；依赖成环、
 * Done 行格式这类错误不影响抽取，重复判一遍只会把合流门禁的规则误用到规划期。
 * 轴归解析器所有，调用方不再自带集合。
 */
export const IDENTITY_CODES = new Set(['MALFORMED_LINE', 'DUPLICATE_ID']);

/** 只保留改变任务集合或字段归属的错误。 */
export function identityErrors(errors) {
  return errors.filter((error) => IDENTITY_CODES.has(error.code));
}

/**
 * 某个任务是否带 task 级错误。
 * 用于合流入口：只压住被合流的任务及其依赖，不因无关任务的问题挡住整批。
 */
export function taskErrorsFor(errors, taskId) {
  return errors.filter((error) => !isGraphError(error.code) && error.task === taskId);
}

const TASK_LINE = /^\s*[-*]\s*\[([ xX])\]\s+(\d+(?:\.\d+)*)\s+(\S+?)(?::(?=\s|$))?(?:\s+(.*))?$/;
const CHECKBOX_LINE = /^\s*[-*]\s*\[[ xX]\]/;
const FIELD_LINE = /^\s+[-*]\s+([^:]+):\s*(.*)$/;
const TASK_ID = /^[A-Za-z]+-\d+$/;

/**
 * 任务 ID 是否形如 `<前缀>-<数字>`。
 *
 * 单一属主：reconcile 曾自带 `/^T-\d+$/`，比本解析器更严——`TASK-01`、`BUG-3` 这类
 * tasks.md 合法的 ID 在 agent 标签里会被判成「task 不在 tasks.md」，任务永远 ACTIVE 不了。
 * 实际仓库里 57 条任务行全是 `T-NN`，但两处规则不同步本身就是漂移源，故统一由这里导出。
 */
export function isTaskId(value) {
  return typeof value === 'string' && TASK_ID.test(value);
}
const DONE_LINE = /^source=([0-9a-f]{7}) review=(\S+)$/;

/**
 * 合流 review 标签的语法：`pass(<mechanical|8 位 id|完整 UUID>@<tip7>/<base7>)`。
 *
 * 单一属主。原本这条正则只在 `merge-task.mjs` 里，于是 Done 行的 review 值可以是任何
 * 非空字符串——`pipeline-gate-slimming` 的 19 条 Done 行全写着 `review=main-session`，
 * 主会话自审在账本上毫无痕迹，读账本的人却会以为审查发生过。
 * 解析期用它校验 Done 行，合流期用同一份正则校验传入标签，两处不可能漂移。
 */
export const REVIEW_TAG = /^pass\((mechanical|[0-9a-f]{8}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})@([0-9a-f]{7})\/([0-9a-f]{7})\)$/;

/** Done 行的 review 值是否是合法标签。 */
export function isReviewTag(value) {
  return typeof value === 'string' && REVIEW_TAG.test(value);
}

/**
 * 已知风险面词表。实测取值（2026-10-25 两业务 change 的 15 个任务）：
 *   error-handling 11, concurrency 5, crypto/auth 4, irreversible 4, public-api 4,
 *   persistence 3, numerical 2, none 2
 * 未知词一律报错而不是静默降级：拼错的 `errorhandling` 若被当成未知风险，
 * 就会绕过 strict 推导，正是 L1-04 要堵的口子。
 */
export const RISK_TOKENS = new Set([
  'none', 'error-handling', 'numerical', 'concurrency', 'crypto/auth',
  'irreversible', 'persistence', 'public-api',
]);

/**
 * 可执行命令的识别词表：`Verify with` 只有以此开头才被视为可执行命令，否则是自然语言描述。
 * 命令头允许被引号或反引号包裹（实测两种写法都存在：`"<node>" verify.mjs` 与
 * `` `node --test …` ``）——不去壳会把真实可执行命令误判成自然语言，合流时被拒。
 */
const COMMAND_HEADS = new Set([
  'node', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'deno', 'python', 'python3',
  'bash', 'sh', 'zsh', 'make', 'cargo', 'go', 'rustc', 'tsx', 'vitest', 'jest',
]);
// 认的测试文件名形状。`.test.sh` 也是测试：本仓库的 `contract-check.test.sh` 是 bash 用例表，
// 用 `bash contract-check.test.sh` 跑。只认 JS 扩展名时，`Verify with: bash x.test.sh`
// 的 verify.tests 是空数组，下游 contract-check 退回 Write scope 猜测试文件——它分不清
// 实现与测试，会把实现文件当语料（本 change 实测 produced undeclared 误报）。
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$|\.test\.sh$/i;
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * 命令头是否可执行。
 *
 * 词表不可能穷举：实测见过 `true`（shell 内建，hotfix 占位命令）、`pytest`、`mvn`、
 * `dotnet` 以及被引号包裹的绝对路径。因此判定分三档：
 *   1. 已知命令名（COMMAND_HEADS）；
 *   2. 明确的路径/变量调用（`/abs/node`、`./run.sh`、`$NODE`）；
 *   3. 小写 ASCII 命令名形状（`^[a-z][a-z0-9_.+-]*$`），但排除自然语言高频动词。
 * 自然语言描述在实测样本里都以中文或大写字母开头（`运行 … 验证`、`See the …`），
 * 但小写英文描述（`run the test suite`、`verify all scenarios`）的首词会撞上第 3 档
 * 形状，被误当成命令名放行。这些词不是可执行命令头，必须排他；误拦真实命令的代价
 * 只是合流时以「命令不存在」失败（exit 20），误放行自然语言才是要堵的口子。
 */
const PROSE_HEADS = new Set(['run', 'use', 'see', 'check', 'verify', 'ensure', 'manually']);
function isExecutableHead(token) {
  if (COMMAND_HEADS.has(token)) return true;
  if (/^(?:[./~]|\$)[^\s]*$/.test(token)) return true;
  if (PROSE_HEADS.has(token)) return false;
  return /^[a-z][a-z0-9_.+-]*$/.test(token);
}

function parseScope(value) {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseDepends(value) {
  const trimmed = value.trim();
  if (trimmed === '' || /^none$/i.test(trimmed)) return [];
  return trimmed
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** `[a, b]` 或 `a, b` 两种写法都接受；同一任务多行 Risk-surface 取并集（去重后排序，保证输出确定）。 */
function parseRisk(value, into) {
  for (const token of value.replace(/[[\]]/g, ' ').split(',')) {
    const key = token.trim().toLowerCase();
    if (key !== '' && !into.includes(key)) into.push(key);
  }
  into.sort();
  return into;
}

/** 逗号或空白分隔的场景编号（SCEN-*）。 */
function parseScenarios(value) {
  return value
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * 把 `Verify with` 拆成 { raw, command, tests }。
 * command 仅在整行是一个可执行调用时给出（允许前置 `KEY=VALUE` 环境赋值）；
 * 纯自然语言描述（实测治理 change 的 7 条全是）保留在 raw 里，command 为 null，
 * 调用方必须据此拒绝「用描述当测试命令」。
 *
 * 导出给 acceptance-run.mjs 复用：验收矩阵的 Verify 单元格与 tasks.md 的 Verify with
 * 是同一类判据（是不是可执行命令），必须共用一份识别逻辑，否则两处对「什么算命令」
 * 的判定会漂移（冻结时能过、收尾真跑时判成自然语言，或反之）。
 */
export function parseVerify(raw) {
  const text = raw.trim();
  const tests = text
    .split(/\s+/)
    .map((token) => token.replace(/^[([{`'"]+|[)\]},;:`'"]+$/g, ''))
    .filter((token) => TEST_FILE.test(token));
  const tokens = text.split(/\s+/).filter(Boolean);
  const unwrap = (token) => token.replace(/^[([{`'"]+/, '').replace(/[)\]}`'"]+$/, '');
  let head = 0;
  while (head < tokens.length && ENV_ASSIGNMENT.test(unwrap(tokens[head]))) head += 1;
  const executable = head < tokens.length && isExecutableHead(unwrap(tokens[head]));
  if (!executable) return { raw: text, command: null, tests };
  // command 必须是**给 shell 执行**的字符串，因此要剥掉 Markdown 包裹。
  //
  // 旧实现只在「判断是不是命令」时 unwrap，返回值仍是原文：`` `node --test x.mjs` ``
  // 被判定为可执行，然后原样交给 `/bin/sh -c`。反引号在 shell 里是**命令替换**，
  // 整行会先执行 `node --test x.mjs`，再把它的输出当成命令名执行——实测报
  // `/bin/sh: ✔: command not found`，合流以 exit 20 失败。这正是「验过」变自报的
  // 反面：以为在跑冻结命令，实际跑的是命令的输出。
  //
  // 只剥包裹整行的定界符：`"$(a) $(b)"` 这类内部引号是命令语义的一部分，不能动。
  const stripped = stripWrappingQuote(text).trim();
  return { raw: text, command: stripped, tests };
}

/**
 * 剥掉包裹整个字符串的一对**引号**定界符（反引号、单/双引号）。内部内容原样保留。
 *
 * 只收引号类，不收 `(` `[` `{`：那三种在 shell 里是语法结构而不是 Markdown 包裹。
 * 实测 `("a" || "b")` 会被剥成 `"a" || "b"`、`(cd sub && make)` 会被剥成 `cd sub && make`——
 * 前者无害、后者改变子 shell 语义。冻结命令是任务契约，解析器没有理由改写它的 shell 结构；
 * 真正要治的只是「Markdown 把命令包成代码段」这一种（反引号与引号）。
 */
function stripWrappingQuote(text) {
  const pairs = [['`', '`'], ['"', '"'], ["'", "'"]];
  for (const [open, close] of pairs) {
    if (text.length >= 2 && text.startsWith(open) && text.endsWith(close)) {
      // 只有当开头那个定界符就是结尾那个的配对时才算包裹：
      // `"a" && "b"` 首尾都是 `"` 却不是包裹，剥掉会破坏命令。
      const inner = text.slice(1, -1);
      if (!containsUnbalanced(inner, open, close)) return inner;
    }
  }
  return text;
}

/** 内层是否已经出现了未配对的定界符（出现即说明首尾不构成整体包裹）。 */
function containsUnbalanced(text, open, close) {
  let depth = 0;
  for (const char of text) {
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth < 0) return true;
    }
  }
  return depth !== 0;
}

function newTask(fields) {
  return {
    id: fields.id,
    num: fields.num,
    title: fields.title,
    done: fields.done,
    depends: fields.depends,
    scope: fields.scope,
    review: fields.review,
    requiredReview: fields.requiredReview,
    risk: fields.risk,
    verify: fields.verify,
    scenarios: fields.scenarios,
    doneLine: fields.doneLine,
  };
}

/**
 * 解析后的风险等级：显式 `Review` 优先（`mechanical` 与高风险冲突时由 parseTasks 报错），
 * 否则任一非 `none` 风险面 ⇒ `strict`；无风险面且未声明 ⇒ null（缺省，调用方 fail closed）。
 */
function resolveReview(declared, risk) {
  if (declared !== null) return declared;
  const risky = risk.some((token) => token !== 'none');
  return risky ? 'strict' : null;
}

export function parseTasks(markdown) {
  const lines = String(markdown).split(/\r?\n/);
  const tasks = [];
  const errors = [];
  let current = null;
  let sawScopeField = false;
  let sawDoneField = false;
  let inComment = false;

  function fail(code, message, task) {
    errors.push({ code, message, task: task ?? null });
  }

  function finish(task) {
    if (!task) return;
    task.requiredReview = resolveReview(task.review, task.risk);
    if (!sawScopeField || task.scope.length === 0) {
      fail('MISSING_SCOPE', `${task.id} 缺少非空的 Write scope`, task.id);
    }
    if (task.review !== null && !['strict', 'standard', 'mechanical'].includes(task.review)) {
      fail('UNKNOWN_REVIEW', `${task.id} 的 Review 取值未知：${task.review}（须为 strict/standard/mechanical）`, task.id);
    }
    const unknownRisk = task.risk.filter((token) => !RISK_TOKENS.has(token));
    if (unknownRisk.length > 0) {
      fail('UNKNOWN_RISK', `${task.id} 的 Risk-surface 含未知取值：${unknownRisk.join(', ')}`
        + `（已知：${[...RISK_TOKENS].join(', ')}）；未知风险不得静默按低风险处理`, task.id);
    }
    if (task.review === 'mechanical' && task.risk.some((token) => token !== 'none')) {
      fail('REVIEW_RISK_CONFLICT', `${task.id} 声明 Review: mechanical 但 Risk-surface 非 none `
        + `(${task.risk.join(', ')})；mechanical 只用于无风险面的可客观完整验证改动`, task.id);
    }
    if (task.done) {
      if (!sawDoneField || task.doneLine === null) {
        fail('BAD_DONE_LINE', `${task.id} 已勾选但缺少合法的 Done 行`, task.id);
      } else if (!isReviewTag(task.doneLine.review)) {
        // 语法合法不等于审查发生过，但语法非法一定不是 `merge-task.mjs` 写的。
        // `pipeline-gate-slimming` 的 19 条 Done 行全是 `review=main-session`——
        // 手写记账冒充合流收据，账本看起来完整，实际没有一条经过合流门禁。
        fail('BAD_DONE_LINE', `${task.id} 的 Done 行 review 值不是合法标签：${task.doneLine.review}`
          + '（须为 pass(<reviewer>@<tip7>/<base7>) 或 pass(mechanical@<tip7>/<base7>)；'
          + '该行只能由 merge-task.mjs 生成）', task.id);
      }
    }
  }

  for (const source of lines) {
    // HTML 注释里的内容不是任务契约。模板与大量 tasks.md 用注释写规则说明，
    // 里面的 `- Foo: bar` 形态本来不该参与解析（否则模板自己就解析不过）。
    //
    // **只剥注释本身，不剥整行**：旧实现对「含开闭标记」的行直接 `continue`，
    // 于是 `- [ ] 1.2 T-02 标题 <!-- 待定 -->` 整条任务凭空消失，后一行的
    // `Write scope` 还被并进前一条任务——解析零报错，任务与写范围双双错位。
    // 注释是行内噪声，剥掉之后剩下的内容必须照常参与解析。
    let line = source;
    if (inComment) {
      const end = line.indexOf('-->');
      if (end === -1) continue;
      line = line.slice(end + 3);
      inComment = false;
    }
    for (;;) {
      const start = line.indexOf('<!--');
      if (start === -1) break;
      const end = line.indexOf('-->', start + 4);
      if (end === -1) {
        // 注释延续到后续行：本行只保留注释之前的内容，其余交给下一轮。
        inComment = true;
        line = line.slice(0, start);
        break;
      }
      line = line.slice(0, start) + line.slice(end + 3);
    }
    if (line.trim() === '') continue;

    const taskMatch = line.match(TASK_LINE);
    if (taskMatch) {
      finish(current);
      const [, box, num, candidateId, title = ''] = taskMatch;
      if (!TASK_ID.test(candidateId)) {
        fail('MALFORMED_LINE', `任务行缺少合法 ID：${line.trim()}`, candidateId);
        current = null;
        sawScopeField = false;
        sawDoneField = false;
        continue;
      }
      current = newTask({
        id: candidateId,
        num,
        title: title.trim(),
        done: box !== ' ',
        depends: [],
        scope: [],
        review: null,
        requiredReview: null,
        risk: [],
        verify: null,
        scenarios: [],
        doneLine: null,
      });
      sawScopeField = false;
      sawDoneField = false;
      tasks.push(current);
      continue;
    }

    if (CHECKBOX_LINE.test(line)) {
      fail('MALFORMED_LINE', `无法解析的任务行：${line.trim()}`, line.trim());
      continue;
    }

    if (current === null) continue;

    const fieldMatch = line.match(FIELD_LINE);
    if (!fieldMatch) continue;

    const rawKey = fieldMatch[1].trim();
    const key = rawKey.toLowerCase();
    const value = fieldMatch[2];

    if (key === 'depends on') {
      current.depends = parseDepends(value);
    } else if (key === 'write scope') {
      sawScopeField = true;
      current.scope = parseScope(value);
    } else if (key === 'review') {
      const review = value.trim();
      current.review = review === '' ? null : review.toLowerCase();
    } else if (key === 'risk-surface') {
      parseRisk(value, current.risk);
    } else if (key === 'verify with') {
      current.verify = parseVerify(value);
    } else if (key === 'scenarios' || key === 'scenario') {
      current.scenarios.push(...parseScenarios(value));
    } else if (key === 'done') {
      sawDoneField = true;
      const doneMatch = value.trim().match(DONE_LINE);
      current.doneLine = doneMatch
        ? { source: doneMatch[1], review: doneMatch[2] }
        : null;
    } else if (/^[a-z][a-z .-]*$/.test(key)) {
      // 未知字段：拼错的 `Verfy with` 过去被静默忽略，于是「冻结时看着有验证命令、
      // 合流时却没有」——那一条任务的 Verify 源在解析后凭空消失。只对 ASCII 字段名形态报错，
      // 中文短句是说明性文字，不是字段。task 级：只压住被点名的任务。
      fail('UNKNOWN_FIELD', `${current.id} 含未知字段 "${rawKey}"：`
        + '解析器会静默忽略它，导致该字段的约束在冻结后消失。'
        + `已知字段：Depends on / Write scope / Review / Risk-surface / Verify with / Scenarios / Done`, current.id);
    }
  }
  finish(current);

  const byId = new Map();
  for (const task of tasks) {
    if (byId.has(task.id)) {
      fail('DUPLICATE_ID', `任务 ID 重复：${task.id}`, task.id);
    } else {
      byId.set(task.id, task);
    }
  }

  for (const task of tasks) {
    for (const dep of task.depends) {
      if (dep === task.id) {
        fail('SELF_DEP', `${task.id} 依赖自身`, task.id);
      } else if (!byId.has(dep)) {
        fail('UNKNOWN_DEP', `${task.id} 依赖不存在的任务 ${dep}`, task.id);
      }
    }
  }

  // Kahn 拓扑排序；只统计存在于文件中的依赖边，自依赖与未知依赖已单独报告。
  const indegree = new Map();
  const dependents = new Map();
  for (const id of byId.keys()) {
    indegree.set(id, 0);
    dependents.set(id, []);
  }
  for (const task of tasks) {
    if (byId.get(task.id) !== task) continue; // 重复 ID 只取首个定义建图
    for (const dep of new Set(task.depends)) {
      if (dep === task.id || !byId.has(dep)) continue;
      indegree.set(task.id, indegree.get(task.id) + 1);
      dependents.get(dep).push(task.id);
    }
  }
  const queue = [...indegree.entries()]
    .filter(([, degree]) => degree === 0)
    .map(([id]) => id);
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift();
    visited += 1;
    for (const next of dependents.get(id)) {
      const degree = indegree.get(next) - 1;
      indegree.set(next, degree);
      if (degree === 0) queue.push(next);
    }
  }
  if (visited !== indegree.size) {
    const cyclic = [...indegree.entries()]
      .filter(([, degree]) => degree > 0)
      .map(([id]) => id);
    fail('CYCLE', `依赖存在环：${cyclic.join(', ')}`, cyclic[0] ?? null);
  }

  return { tasks, errors };
}

// 路径规范化：返回段数组（根 scope 为 []），非法时返回 null。
export function normalizeScope(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  if (/[\\\0-\x1f]/.test(raw)) return null;
  if (raw.startsWith('/')) return null;
  if (/^[A-Za-z]:/.test(raw)) return null;
  const parts = [];
  for (const seg of raw.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts;
}

// 判断文件路径是否落在允许的 scopes 集合内（按段前缀匹配）。
export function isFileWithinScopes(filePath, scopes) {
  const fileParts = normalizeScope(filePath);
  if (!fileParts) return false;

  for (const scope of scopes) {
    const scopeParts = Array.isArray(scope) ? scope : normalizeScope(scope);
    if (!scopeParts) continue;
    if (scopeParts.length === 0) return true; // 根范围允许一切
    if (fileParts.length < scopeParts.length) continue;
    let match = true;
    for (let i = 0; i < scopeParts.length; i++) {
      if (fileParts[i] !== scopeParts[i]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}
