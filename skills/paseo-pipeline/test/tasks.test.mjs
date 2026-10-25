import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTasks } from '../lib/tasks.mjs';

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
