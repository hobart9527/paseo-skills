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
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/i;
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
 */
function parseVerify(raw) {
  const text = raw.trim();
  const tests = text
    .split(/\s+/)
    .map((token) => token.replace(/^[([{`'"]+|[)\]},;:`'"]+$/g, ''))
    .filter((token) => TEST_FILE.test(token));
  const tokens = text.split(/\s+/).filter(Boolean);
  const unwrap = (token) => token.replace(/^[([{`'"]+/, '').replace(/[)\]}`'"]+$/, '');
  let head = 0;
  while (head < tokens.length && ENV_ASSIGNMENT.test(unwrap(tokens[head]))) head += 1;
  const command = head < tokens.length && isExecutableHead(unwrap(tokens[head])) ? text : null;
  return { raw: text, command, tests };
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
      }
    }
  }

  for (const line of lines) {
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

    const key = fieldMatch[1].trim().toLowerCase();
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
