import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTasks, normalizeScope, isFileWithinScopes, isTaskId } from '../lib/tasks.mjs';

function taskMarkdown({
  id = 'T-01',
  num = '1.1',
  depends = 'none',
  scope = 'src/task.mjs',
  done = false,
  review = null,
  doneLine = null,
} = {}) {
  return [
    `- [${done ? 'x' : ' '}] ${num} ${id} Task ${id}`,
    `  - Depends on: ${depends}`,
    ...(scope === null ? [] : [`  - Write scope: ${scope}`]),
    ...(review === null ? [] : [`  - Review: ${review}`]),
    ...(doneLine === null ? [] : [`  - Done: ${doneLine}`]),
  ].join('\n');
}

function assertError(result, code) {
  assert.ok(Array.isArray(result.tasks));
  assert.ok(Array.isArray(result.errors));
  const error = result.errors.find((entry) => entry.code === code);
  assert.ok(error, `Expected ${code}, received ${JSON.stringify(result.errors)}`);
  assert.ok(Object.hasOwn(error, 'task'));
  assert.equal(typeof error.message, 'string');
  assert.ok(error.message.length > 0);
}

test('parses task fields, a dependency chain, multiple dependencies and Done evidence', () => {
  const result = parseTasks(`# Tasks: parser-contract

## 1. Delivery

- [x] 1.1 T-01 Shared parser
  - Depends on: none
  - Write scope: src/tasks.mjs , test/tasks.test.mjs
  - Risk-surface: [error-handling]
  - Review: strict
  - Done: source=a1b2c3d review=pass(12345678@a1b2c3d/7654321)

- [ ] 1.2 T-02 Reconcile task graph
  - Depends on: T-01
  - Write scope: src/reconcile.mjs
  - Review: mechanical

- [ ] 1.3 T-03 Verify delivery
  - Depends on: T-01 , T-02
  - Write scope: test/delivery.test.mjs , docs/delivery.md
`);

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.tasks, [
    {
      id: 'T-01',
      num: '1.1',
      title: 'Shared parser',
      done: true,
      depends: [],
      scope: ['src/tasks.mjs', 'test/tasks.test.mjs'],
      review: 'strict',
      requiredReview: 'strict',
      risk: ['error-handling'],
      verify: null,
      scenarios: [],
      doneLine: { source: 'a1b2c3d', review: 'pass(12345678@a1b2c3d/7654321)' },
    },
    {
      id: 'T-02',
      num: '1.2',
      title: 'Reconcile task graph',
      done: false,
      depends: ['T-01'],
      scope: ['src/reconcile.mjs'],
      review: 'mechanical',
      requiredReview: 'mechanical',
      risk: [],
      verify: null,
      scenarios: [],
      doneLine: null,
    },
    {
      id: 'T-03',
      num: '1.3',
      title: 'Verify delivery',
      done: false,
      depends: ['T-01', 'T-02'],
      scope: ['test/delivery.test.mjs', 'docs/delivery.md'],
      review: null,
      requiredReview: null,
      risk: [],
      verify: null,
      scenarios: [],
      doneLine: null,
    },
  ]);
});

test('an unchecked task without a Done line is valid', () => {
  const result = parseTasks(taskMarkdown());

  assert.deepEqual(result.errors, []);
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].done, false);
  assert.equal(result.tasks[0].doneLine, null);
});

test('T-1 and T-10 remain distinct IDs and dependencies', () => {
  const result = parseTasks([
    taskMarkdown({ id: 'T-1' }),
    taskMarkdown({ id: 'T-10', num: '1.2', depends: 'T-1' }),
    taskMarkdown({ id: 'T-11', num: '1.3', depends: 'T-10' }),
  ].join('\n\n'));

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.tasks.map(({ id, depends }) => ({ id, depends })), [
    { id: 'T-1', depends: [] },
    { id: 'T-10', depends: ['T-1'] },
    { id: 'T-11', depends: ['T-10'] },
  ]);
});

test('a checkbox task line without an ID reports MALFORMED_LINE', () => {
  const result = parseTasks(`- [ ] 1.1 Missing task ID
  - Depends on: none
  - Write scope: src/task.mjs
`);

  assertError(result, 'MALFORMED_LINE');
});

test('the colon form `T-01: 标题` parses identically to the space form', () => {
  // 真实兼容性回归：仓库内已归档 change 与 contract-check 夹具都写 `T-01: 标题`。
  // 只认空格形式会让整份 tasks.md 解析成 0 条任务（2026-10-25 实测 malformed=5~8），
  // 对账与合流一起失效。
  const colon = parseTasks(`- [ ] 1.1 T-01: Alpha title
  - Depends on: none
  - Write scope: src/a.mjs, src/shared.mjs
  - Verify with: \`node --test src/a.test.mjs\`
`);
  assert.deepEqual(colon.errors, []);
  assert.equal(colon.tasks.length, 1);
  assert.equal(colon.tasks[0].id, 'T-01');
  assert.equal(colon.tasks[0].num, '1.1');
  assert.equal(colon.tasks[0].title, 'Alpha title');
  assert.deepEqual(colon.tasks[0].scope, ['src/a.mjs', 'src/shared.mjs']);
  assert.deepEqual(colon.tasks[0].verify.tests, ['src/a.test.mjs']);

  const space = parseTasks(`- [ ] 1.1 T-01 Alpha title
  - Depends on: none
  - Write scope: src/a.mjs, src/shared.mjs
  - Verify with: \`node --test src/a.test.mjs\`
`);
  assert.deepEqual(colon.tasks, space.tasks);
});

test('the colon form still supports a Done line and dependency chain', () => {
  const result = parseTasks(`- [x] 1.1 T-01: Alpha
  - Depends on: none
  - Write scope: [src/a.mjs]
  - Done: source=abc1234 review=pass(deadbeef@abc1234/def5678)

- [ ] 1.2 T-02: Beta
  - Depends on: T-01
  - Write scope: [src/b.mjs]
`);
  assert.deepEqual(result.errors, []);
  assert.equal(result.tasks[0].done, true);
  assert.equal(result.tasks[0].doneLine.source, 'abc1234');
  assert.deepEqual(result.tasks[1].depends, ['T-01']);
});

test('a colon glued to the ID (`T-01:Alpha`) stays MALFORMED_LINE', () => {
  // 只有 `T-01: 标题`（冒号后跟空白或行尾）是合法形式；`T-01:Alpha` 不是真实写法，
  // 让它静默通过会把 ID 解析成 `T-01:Alpha`，依赖引用全部对不上。
  const result = parseTasks(`- [ ] 1.1 T-01:Alpha
  - Depends on: none
  - Write scope: src/task.mjs
`);
  assertError(result, 'MALFORMED_LINE');
});

test('repeated task IDs report DUPLICATE_ID', () => {
  const result = parseTasks([
    taskMarkdown(),
    taskMarkdown({ num: '1.2', scope: 'src/other.mjs' }),
  ].join('\n\n'));

  assertError(result, 'DUPLICATE_ID');
});

test('SCEN-REC-01: an unknown dependency reports UNKNOWN_DEP and retains tasks', () => {
  const result = parseTasks(taskMarkdown({ id: 'T-02', depends: 'T-99' }));

  assertError(result, 'UNKNOWN_DEP');
  assert.deepEqual(result.tasks.map(({ id }) => id), ['T-02']);
  assert.deepEqual(result.tasks[0].depends, ['T-99']);
});

test('SCEN-REC-01: T-10 cannot satisfy an unknown T-1 dependency', () => {
  const result = parseTasks([
    taskMarkdown({ id: 'T-10' }),
    taskMarkdown({ id: 'T-20', num: '1.2', depends: 'T-1' }),
  ].join('\n\n'));

  assertError(result, 'UNKNOWN_DEP');
  assert.deepEqual(result.tasks.map(({ id }) => id), ['T-10', 'T-20']);
});

test('a task depending on itself reports SELF_DEP and retains the task', () => {
  const result = parseTasks(taskMarkdown({ depends: 'T-01' }));

  assertError(result, 'SELF_DEP');
  assert.deepEqual(result.tasks.map(({ id }) => id), ['T-01']);
  assert.deepEqual(result.tasks[0].depends, ['T-01']);
});

for (const [name, markdown, ids] of [
  [
    'two-node cycle',
    [
      taskMarkdown({ depends: 'T-02' }),
      taskMarkdown({ id: 'T-02', num: '1.2', depends: 'T-01' }),
    ].join('\n\n'),
    ['T-01', 'T-02'],
  ],
  [
    'three-node cycle alongside an independent task',
    [
      taskMarkdown({ depends: 'T-02' }),
      taskMarkdown({ id: 'T-02', num: '1.2', depends: 'T-03' }),
      taskMarkdown({ id: 'T-03', num: '1.3', depends: 'T-01' }),
      taskMarkdown({ id: 'T-04', num: '1.4' }),
    ].join('\n\n'),
    ['T-01', 'T-02', 'T-03', 'T-04'],
  ],
]) {
  test(`SCEN-REC-02: ${name} reports CYCLE and retains all tasks`, () => {
    const result = parseTasks(markdown);

    assertError(result, 'CYCLE');
    assert.deepEqual(result.tasks.map(({ id }) => id), ids);
  });
}

for (const [name, scope] of [['missing', null], ['empty', '   ']]) {
  test(`${name} Write scope reports MISSING_SCOPE`, () => {
    assertError(parseTasks(taskMarkdown({ scope })), 'MISSING_SCOPE');
  });
}

for (const [name, doneLine] of [
  ['missing Done line', null],
  ['empty Done line', ''],
  ['six-digit source', 'source=a1b2c3 review=pass(tag)'],
  ['eight-digit source', 'source=a1b2c3d4 review=pass(tag)'],
  ['non-hex source', 'source=a1b2c3z review=pass(tag)'],
  ['missing source field', 'review=pass(tag)'],
  ['missing review field', 'source=a1b2c3d'],
  ['empty review field', 'source=a1b2c3d review='],
  ['reversed fields', 'review=pass(tag) source=a1b2c3d'],
  ['legacy Done representation', 'a1b2c3d pass(tag)'],
]) {
  test(`a checked task with ${name} reports BAD_DONE_LINE`, () => {
    const result = parseTasks(taskMarkdown({ done: true, doneLine }));

    assertError(result, 'BAD_DONE_LINE');
  });
}

test('normalizeScope normalizes valid relative paths and rejects invalid paths', () => {
  assert.deepEqual(normalizeScope('src/services/'), ['src', 'services']);
  assert.deepEqual(normalizeScope('src/services/approval.ts'), ['src', 'services', 'approval.ts']);
  assert.deepEqual(normalizeScope('.'), []);
  assert.deepEqual(normalizeScope('./src/services/'), ['src', 'services']);
  assert.deepEqual(normalizeScope('src/../src/services/'), ['src', 'services']);
  assert.equal(normalizeScope('/absolute/path'), null);
  assert.equal(normalizeScope('C:\\windows\\path'), null);
  assert.equal(normalizeScope('../escaping/root'), null);
  assert.equal(normalizeScope(''), null);
  assert.equal(normalizeScope(null), null);
});

test('isFileWithinScopes checks path prefix containment', () => {
  const scopes = ['packages/server/src/services/approval-service.ts', 'packages/server/src/db/'];

  assert.equal(isFileWithinScopes('packages/server/src/services/approval-service.ts', scopes), true);
  assert.equal(isFileWithinScopes('packages/server/src/db/index.ts', scopes), true);
  assert.equal(isFileWithinScopes('packages/server/src/db/sub/extra.ts', scopes), true);
  assert.equal(isFileWithinScopes('packages/server/src/db_other/index.ts', scopes), false);
  assert.equal(isFileWithinScopes('packages/server/src/services/other.ts', scopes), false);
  assert.equal(isFileWithinScopes('packages/server/test/approval.test.ts', scopes), false);

  // 根范围放行一切
  assert.equal(isFileWithinScopes('any/file.ts', ['.']), true);
  assert.equal(isFileWithinScopes('any/file.ts', [[]]), true);
});


// --- 风险面与 Review 档位（L1-04） ---
// 真实缺口：治理 change 的 7 个任务全部高风险，但旧解析器不消费 Risk-surface，
// 于是「Review 缺省」被当成低风险，mechanical 快轨的实际风险无人拦截。

test('Risk-surface non-none derives strict review even when Review is omitted', () => {
  const result = parseTasks(`- [ ] 1.1 T-01 Governance seam
  - Depends on: none
  - Write scope: packages/server/src/routes/api.ts
  - Risk-surface: [crypto/auth, concurrency, irreversible]
`);
  assert.deepEqual(result.errors, []);
  assert.equal(result.tasks[0].review, null);
  assert.equal(result.tasks[0].requiredReview, 'strict');
  assert.deepEqual(result.tasks[0].risk, ['concurrency', 'crypto/auth', 'irreversible']);
});

test('Risk-surface none with no Review stays undetermined instead of becoming mechanical', () => {
  const result = parseTasks(`- [ ] 1.1 T-01 Docs only
  - Depends on: none
  - Write scope: docs/
  - Risk-surface: [none]
`);
  assert.deepEqual(result.errors, []);
  assert.equal(result.tasks[0].review, null);
  assert.equal(result.tasks[0].requiredReview, null);
});

test('explicit Review strict stays strict and a repeated Risk-surface line merges', () => {
  const result = parseTasks(`- [ ] 1.1 T-01 Repeated risk
  - Depends on: none
  - Write scope: src/
  - Review: Strict
  - Risk-surface: error-handling
  - Risk-surface: numerical, error-handling
`);
  assert.deepEqual(result.errors, []);
  assert.equal(result.tasks[0].review, 'strict');
  assert.equal(result.tasks[0].requiredReview, 'strict');
  assert.deepEqual(result.tasks[0].risk, ['error-handling', 'numerical']);
});

test('unknown Risk-surface token is an error, not silently treated as low risk', () => {
  const result = parseTasks(`- [ ] 1.1 T-01 Typo risk
  - Depends on: none
  - Write scope: src/
  - Risk-surface: [errorhandling]
`);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].code, 'UNKNOWN_RISK');
  assert.equal(result.errors[0].task, 'T-01');
});

test('mechanical review conflicting with a non-none Risk-surface is rejected', () => {
  const result = parseTasks(`- [ ] 1.1 T-01 Risky mechanical
  - Depends on: none
  - Write scope: src/
  - Review: mechanical
  - Risk-surface: [crypto/auth]
`);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].code, 'REVIEW_RISK_CONFLICT');
});

test('unknown Review value is an error', () => {
  const result = parseTasks(`- [ ] 1.1 T-01 Bad review
  - Depends on: none
  - Write scope: src/
  - Review: lenient
`);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].code, 'UNKNOWN_REVIEW');
});

// --- Verify with 可执行性（L1-04） ---
// 实测：治理 change 的 7 条 Verify with 全是自然语言描述，没有一条是可执行命令。
// 解析器必须能区分二者，调用方才能拒绝「把描述当测试命令」。

test('Verify with separates an executable command from a natural-language description', () => {
  const result = parseTasks(`- [ ] 1.1 T-01 Command form
  - Depends on: none
  - Write scope: src/
  - Verify with: NODE_ENV=test node --test --import tsx packages/server/test/loan-offset.test.ts

- [ ] 1.2 T-02 Description form
  - Depends on: none
  - Write scope: src/
  - Verify with: 单元与集成测试验证流转动作落盘 Saga 账本、超时置为 UNKNOWN
`);
  assert.deepEqual(result.errors, []);
  const [command, description] = result.tasks;
  assert.equal(command.verify.command, 'NODE_ENV=test node --test --import tsx packages/server/test/loan-offset.test.ts');
  assert.deepEqual(command.verify.tests, ['packages/server/test/loan-offset.test.ts']);
  assert.equal(description.verify.command, null);
  assert.equal(description.verify.raw, '单元与集成测试验证流转动作落盘 Saga 账本、超时置为 UNKNOWN');
  assert.deepEqual(description.verify.tests, []);
});

test('Verify with accepts a plain command without env assignment and ignores prose after a command', () => {
  const result = parseTasks(`- [ ] 1.1 T-01 Plain
  - Depends on: none
  - Write scope: src/
  - Verify with: npm test

- [ ] 1.2 T-02 Prose first
  - Depends on: none
  - Write scope: src/
  - Verify with: 运行 node --test test/a.test.ts 验证
`);
  const [plain, prose] = result.tasks;
  assert.equal(plain.verify.command, 'npm test');
  assert.equal(prose.verify.command, null, '以自然语言开头的行不是可执行命令');
});

test('Verify with rejects natural-language English head words as commands', () => {
  // 第三档形状（小写 ASCII 命令名）会把 `run the test suite` 的首词 `run` 当命令放行；
  // 这些是高频自然语言动词，必须排他（fail closed：真实验证缺口在合流前暴露）。
  for (const [head, rest] of [
    ['run', 'the test suite'],
    ['use', 'npm test to verify'],
    ['see', 'the audit report'],
    ['check', 'that all scenarios pass'],
    ['verify', 'all scenarios manually'],
    ['ensure', 'the ledger is written'],
    ['manually', 'confirm the rollout'],
  ]) {
    const result = parseTasks(`- [ ] 1.1 T-01 Prose
  - Depends on: none
  - Write scope: src/
  - Verify with: ${head} ${rest}
`);
    assert.equal(result.tasks[0].verify.command, null, `自然语言首词 ${head} 不得被当成可执行命令`);
  }
  // 真实命令名形态不受影响。
  const result = parseTasks(`- [ ] 1.1 T-01 Command
  - Depends on: none
  - Write scope: src/
  - Verify with: pytest tests/ -q
`);
  assert.equal(result.tasks[0].verify.command, 'pytest tests/ -q', 'pytest 是真实命令头，必须放行');
});

test('Scenarios field collects scenario ids across repeated lines', () => {
  const result = parseTasks(`- [ ] 1.1 T-01 Scenarios
  - Depends on: none
  - Write scope: src/
  - Scenarios: SCEN-A-01, SCEN-A-02
  - Scenario: SCEN-A-03
`);
  assert.deepEqual(result.tasks[0].scenarios, ['SCEN-A-01', 'SCEN-A-02', 'SCEN-A-03']);
});

test('isTaskId accepts any <prefix>-<number> id, matching what parseTasks itself accepts', () => {
  // reconcile 曾自带 /^T-\d+$/，比解析器更严：tasks.md 里合法的 `TASK-01` 会在 agent 标签
  // 比对时被判「不在 tasks.md」，任务永远进不了 ACTIVE。两处规则必须来自同一属主。
  for (const id of ['T-01', 'TASK-01', 'BUG-3', 'scen-12']) assert.equal(isTaskId(id), true, id);
  for (const id of ['T01', 'T-', '-1', 'T-01x', '', null, undefined, 7]) assert.equal(isTaskId(id), false, String(id));
});

// --- Done 行 review 语法、未知字段、注释不参与解析（2026-10-27 包 4） ---

test('SCEN-CON-02 a Done line whose review value is not a merge-task tag is rejected', () => {
  // `pipeline-gate-slimming` 归档时 19 条 Done 行全是 `review=main-session`：手写记账
  // 冒充合流收据。语法合法不证明审查发生过，但语法非法一定不是 merge-task 写的。
  for (const review of ['main-session', 'mechanical', 'pass(mechanical)', 'pass(tag)', 'pass(1234@a1b2c3d/7654321)']) {
    const result = parseTasks(taskMarkdown({ done: true, doneLine: `source=a1b2c3d review=${review}` }));
    assertError(result, 'BAD_DONE_LINE');
  }
  // 两个合法形态都必须继续通过。
  for (const review of ['pass(12345678@a1b2c3d/7654321)', 'pass(mechanical@a1b2c3d/7654321)',
    'pass(12345678-90ab-cdef-1234-567890abcdef@a1b2c3d/7654321)']) {
    const result = parseTasks(taskMarkdown({ done: true, doneLine: `source=a1b2c3d review=${review}` }));
    assert.deepEqual(result.errors, [], review);
  }
});

test('SCEN-CON-03 an unknown metadata field is reported instead of silently ignored', () => {
  // 拼错的 `Verfy with:` 过去被静默丢弃：冻结时看着有验证命令，合流时那一条凭空消失。
  const result = parseTasks(`- [ ] 1.1 T-01 Unknown field
  - Depends on: none
  - Write scope: src/
  - Verfy with: \`node --test src/a.test.mjs\`
`);
  assertError(result, 'UNKNOWN_FIELD');
  const error = result.errors.find((entry) => entry.code === 'UNKNOWN_FIELD');
  assert.equal(error.task, 'T-01');
  assert.match(error.message, /Verfy with/);
  // 任务本身仍被解析出来：未知字段是 task 级错误，不该抹掉图。
  assert.deepEqual(result.tasks.map((task) => task.id), ['T-01']);
});

test('SCEN-CON-03 UNKNOWN_FIELD is a task-level error and stays out of the graph axis', () => {
  const result = parseTasks([
    taskMarkdown({ id: 'T-01' }),
    `- [ ] 1.2 T-02 has a typo
  - Depends on: T-01
  - Write scope: src/
  - Scenaro: SCEN-A-01`,
    taskMarkdown({ id: 'T-03', num: '1.3' }),
  ].join('\n\n'));
  const unknown = result.errors.filter((entry) => entry.code === 'UNKNOWN_FIELD');
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].task, 'T-02');
  assert.deepEqual(result.tasks.map((task) => task.id), ['T-01', 'T-02', 'T-03']);
});

test('SCEN-CON-03 HTML comments do not participate in parsing', () => {
  // 模板与真实 tasks.md 都用注释写字段规则，注释里的 `- Foo: bar` 不该被当成字段。
  const result = parseTasks(`<!--
  - Review: mechanical
  - Done: source=a1b2c3d review=pass(tag)
-->

- [ ] 1.1 T-01 Commented rules
  - Depends on: none
  - Write scope: src/
  - Review: strict
`);
  assert.deepEqual(result.errors, []);
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].review, 'strict', '注释里的 Review 不得覆盖真实值');
});

test('SCEN-CON-15 a same-line HTML comment does not swallow the task it annotates', () => {
  // 实测反例（2026-10-27 复核）：旧实现对含 `<!--` 的行整行 `continue`，
  // `- [ ] 1.2 T-02 b <!-- note -->` 这条任务凭空消失，紧随其后的
  // `Write scope: b.mjs` 还被并进 T-01——解析零报错，任务数与写范围双双错位。
  const result = parseTasks(`- [ ] 1.1 T-01 First
  - Write scope: a.mjs

- [ ] 1.2 T-02 Second <!-- 待定，别删 -->
  - Write scope: b.mjs
  - Verify with: node --test b.test.mjs
`);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.tasks.map((task) => task.id), ['T-01', 'T-02'],
    '行尾注释不得让任务消失');
  assert.deepEqual(result.tasks[0].scope, ['a.mjs'], 'T-01 不得吞掉 T-02 的写范围');
  assert.deepEqual(result.tasks[1].scope, ['b.mjs']);
  assert.equal(result.tasks[1].verify.command, 'node --test b.test.mjs');
});

test('SCEN-CON-15 a same-line comment on a field keeps the field value', () => {
  // 行内注释是噪声，剥掉之后字段值必须照常生效；缺了 scope 的失败模式是
  // MISSING_SCOPE——报错本身正确，但让一条合法的 tasks.md 变红是解析缺陷。
  const result = parseTasks(`- [ ] 1.1 T-01 Commented field
  - Write scope: a.mjs <!-- 只写这一个文件 -->
  - Review: strict <!-- 见 spec --> <!-- 第二个注释也无害 -->
`);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.tasks[0].scope, ['a.mjs']);
  assert.equal(result.tasks[0].review, 'strict');
});

test('SCEN-CON-15 a multi-line comment keeps the text before and after it', () => {
  // 跨行注释：开注释前的文字与闭注释后的文字都保留，只有注释区间被剥掉。
  const result = parseTasks(`- [ ] 1.1 T-01 Multi
  - Write scope: a.mjs
  - Depends on: <!-- 这里开始
  T-00 被提到但应忽略
  --> none
`);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.tasks[0].depends, []);
});

// --- Verify with 的 Markdown 包裹必须剥掉再交给 shell ---
// 实测（本 change 自己的 pod 合流）：tasks.md 里写 `` `node --test x.mjs` ``，
// 解析器判定为可执行并把**原文**交给 /bin/sh -c。反引号在 shell 里是命令替换，
// 整行先跑一遍测试，再把测试输出（`✔ ...`）当命令执行 → `/bin/sh: ✔: command not found`，
// 合流 exit 20。判定对了、执行错了，等于白跑。
test('SCEN-CON-16 Verify with strips the Markdown wrapper before handing the command to a shell', () => {
  const { tasks } = parseTasks(`- [ ] 1.1 T-01 Backticked
  - Depends on: none
  - Write scope: src/a.mjs
  - Verify with: \`node --test src/a.test.mjs\`

- [ ] 1.2 T-02 Double-quoted
  - Depends on: none
  - Write scope: src/b.mjs
  - Verify with: "node --test src/b.test.mjs"
`);
  assert.equal(tasks[0].verify.command, 'node --test src/a.test.mjs');
  assert.equal(tasks[1].verify.command, 'node --test src/b.test.mjs');
  // raw 保留原文：文档读者看到的仍是他们写下的内容。
  assert.match(tasks[0].verify.raw, /^`node/);
});

test('SCEN-CON-16 Verify with does not rewrite shell structure', () => {
  // 剥包裹只针对 **Markdown 代码段/引号**，不针对 shell 语法字符。
  // 旧实现还剥 `(` `[` `{`：`(cd sub && make)` 被改写成 `cd sub && make`，
  // 子 shell 语义消失（cd 会污染后续命令的 cwd），而 `[ -f x ]` 被剥成无效命令。
  // 冻结命令是任务契约，解析器不改写它的 shell 结构。
  const { tasks } = parseTasks(`- [ ] 1.1 T-01 Subshell
  - Write scope: src/a.mjs
  - Verify with: (cd sub && make)

- [ ] 1.2 T-02 Test-bracket
  - Write scope: src/b.mjs
  - Verify with: node --test b.mjs
`);
  assert.equal(tasks[0].verify.command, '(cd sub && make)', '子 shell 包裹必须原样保留');

  // 命令里的反引号是 shell 命令替换，只有**整行被一对反引号包裹**时才剥。
  // `` `a` && `b` `` 有三个反引号，不是一对包裹：原样保留才能让 shell 执行两条命令。
  const substitution = parseTasks('- [ ] 1.1 T-01 Sub\n  - Write scope: src/a.mjs\n'
    + '  - Verify with: ' + '`a` && `b`' + '\n').tasks[0].verify.command;
  assert.equal(substitution, '`a` && `b`', '未成对包裹的反引号不得被剥');
});

test('SCEN-CON-03 Verify with keeps inner quotes that carry shell meaning', () => {
  // 只有包裹整行的一对定界符被剥；`node -e "..."` 的内部引号是命令语义，剥掉就破了。
  const { tasks } = parseTasks(`- [ ] 1.1 T-01 Inner
  - Depends on: none
  - Write scope: src/a.mjs
  - Verify with: \`node -e "process.exit(0)"\`
`);
  assert.equal(tasks[0].verify.command, 'node -e "process.exit(0)"');
});
