// tasks.md 单一解析器（零依赖）。
// reconcile 与 merge-task 共用，避免各自正则漂移。
//
// 任务行：- [ ] 1.1 T-01 Title
// 子字段（缩进）：Depends on / Write scope / Review / Done ...
// Done 行：source=<tip7> review=<tag>，仅当任务已勾选时校验。
//
// parseTasks(markdown) => { tasks, errors }
// error: { code, message, task }，task 为任务 ID（未知时回落到原始任务行号/文本）。
//
// 校验：MALFORMED_LINE、DUPLICATE_ID、UNKNOWN_DEP、SELF_DEP、CYCLE（Kahn）、
//      MISSING_SCOPE、BAD_DONE_LINE。只报错，不吞任务：任务数组始终保留可解析部分。

const TASK_LINE = /^\s*[-*]\s*\[([ xX])\]\s+(\d+(?:\.\d+)*)\s+(\S+)(?:\s+(.*))?$/;
const CHECKBOX_LINE = /^\s*[-*]\s*\[[ xX]\]/;
const FIELD_LINE = /^\s+[-*]\s+([^:]+):\s*(.*)$/;
const TASK_ID = /^[A-Za-z]+-\d+$/;
const DONE_LINE = /^source=([0-9a-f]{7}) review=(\S+)$/;

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

function newTask(fields) {
  return {
    id: fields.id,
    num: fields.num,
    title: fields.title,
    done: fields.done,
    depends: fields.depends,
    scope: fields.scope,
    review: fields.review,
    doneLine: fields.doneLine,
  };
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
    if (!sawScopeField || task.scope.length === 0) {
      fail('MISSING_SCOPE', `${task.id} 缺少非空的 Write scope`, task.id);
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
      current.review = review === '' ? null : review;
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
