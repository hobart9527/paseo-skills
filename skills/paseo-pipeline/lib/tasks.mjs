// Minimal tasks.md parser for the converged pipeline.
// State lives in git; this module only validates the frozen contract.

const TASK_LINE = /^\s*[-*]\s*\[([ xX])\]\s+(?:(?:\d+(?:\.\d+)*)\s+)?([A-Za-z][A-Za-z0-9]*-\d+)(?::\s*|\s+)(.*)$/;
const FIELD_LINE = /^\s+[-*]\s+([^:]+):\s*(.*)$/;
const CHECKBOX_LINE = /^\s*[-*]\s*\[([ xX])\]\s*(.*)$/;
const TASK_ID = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
const DONE_LINE = /^source=([0-9a-f]{7,40})\s+review=(\S+)$/;
// Reviewer may be a full UUID or any hex prefix of it. Paseo's own `shortId` is 7
// characters, so accepting only 8 (or 36 without prefixes) made every real shortId
// unusable.
const REVIEWER_ID = String.raw`mechanical|[0-9a-f]{7,40}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`;
const REVIEW_TAG = new RegExp(String.raw`^pass\((${REVIEWER_ID})@([0-9a-f]{7,40})\/([0-9a-f]{7,40})\)$`);


export function isTaskId(value) {
  return typeof value === 'string' && TASK_ID.test(value);
}

export function isReviewTag(value) {
  return typeof value === 'string' && REVIEW_TAG.test(value);
}

export function parseReviewTag(value) {
  const match = String(value || '').match(REVIEW_TAG);
  if (!match) return null;
  return { reviewer: match[1], tip: match[2], base: match[3] };
}

export function normalizeScope(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw || raw.startsWith('/') || raw.includes('..')) return null;
  return raw.split('/').filter(Boolean).join('/');
}

function splitList(value) {
  return String(value || '')
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter((item) => item && item.toLowerCase() !== 'none');
}

function normalizeCommand(value) {
  const raw = String(value || '').trim();
  if (raw.length >= 2 && raw.startsWith('`') && raw.endsWith('`')) return raw.slice(1, -1).trim();
  return raw;
}

export function parseTaskLine(line) {
  const match = String(line || '').match(TASK_LINE);
  if (!match) return null;
  return {
    checked: match[1].toLowerCase() === 'x',
    id: match[2],
    title: match[3].trim(),
  };
}

export function parseTasks(markdown) {
  const errors = [];
  const tasks = [];
  const byId = new Map();
  let current = null;

  const lines = String(markdown || '').split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const taskMatch = line.match(TASK_LINE);
    if (taskMatch) {
      const [, checked, id, title] = taskMatch;
      if (!isTaskId(id)) {
        errors.push({ code: 'MALFORMED_LINE', message: `bad task id: ${id}`, line: index + 1 });
        current = null;
        continue;
      }
      if (byId.has(id)) errors.push({ code: 'DUPLICATE_ID', task: id, message: `duplicate task ${id}` });
      current = {
        id,
        title: title.trim(),
        checked: checked.toLowerCase() === 'x',
        depends: [],
        scope: [],
        verify: '',
        scenarios: [],
        review: 'standard',
        done: null,
        line: index + 1,
      };
      tasks.push(current);
      byId.set(id, current);
      continue;
    }

    if (!taskMatch && CHECKBOX_LINE.test(line)) {
      errors.push({ code: 'MALFORMED_LINE', message: 'checkbox task line lacks a valid <letters>-<digits> ID', line: index + 1 });
      current = null;
      continue;
    }

    const field = line.match(FIELD_LINE);
    if (!field) {
      if (current && /^\s*[^#\s]/.test(line)) current = null;
      continue;
    }
    const [, keyRaw, value] = field;
    const key = keyRaw.trim().toLowerCase();
    if (!current) continue;
    if (key === 'depends on') current.depends.push(...splitList(value));
    else if (key === 'write scope') current.scope.push(...splitList(value).map(normalizeScope).filter(Boolean));
    else if (key === 'verify with') current.verify = (current.verify ? `${current.verify} ${normalizeCommand(value)}` : normalizeCommand(value)).trim();
    else if (key === 'scen' || key === 'scenarios') current.scenarios.push(...splitList(value));
    else if (key === 'review') current.review = value.trim().toLowerCase() || 'standard';
    else if (key === 'done') {
      const done = value.trim().match(DONE_LINE);
      if (!done) errors.push({ code: 'BAD_DONE_LINE', task: current.id, message: `bad Done line: ${value}` });
      else current.done = { source: done[1], review: done[2] };
    }
  }

  const ids = new Set(tasks.map((task) => task.id));
  for (const task of tasks) {
    if (task.scope.length === 0) errors.push({ code: 'MISSING_SCOPE', task: task.id, message: `${task.id} has no Write scope` });
    if (!task.verify) errors.push({ code: 'MISSING_VERIFY', task: task.id, message: `${task.id} has no Verify with` });
    if (!['standard', 'strict', 'mechanical'].includes(task.review)) {
      errors.push({ code: 'UNKNOWN_REVIEW', task: task.id, message: `${task.id} has unknown Review: ${task.review}` });
    }
    for (const dep of task.depends) {
      if (!ids.has(dep)) errors.push({ code: 'UNKNOWN_DEP', task: task.id, message: `${task.id} depends on unknown ${dep}` });
      if (dep === task.id) errors.push({ code: 'SELF_DEP', task: task.id, message: `${task.id} depends on itself` });
    }
  }

  const graph = new Map(tasks.map((task) => [task.id, task.depends.filter(ids.has.bind(ids))]));
  const state = new Map([...ids].map((id) => [id, 0]));
  const visit = (id, trail = []) => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) {
      const cycle = [...trail.slice(trail.indexOf(id)), id].join(' -> ');
      errors.push({ code: 'CYCLE', task: id, message: `dependency cycle: ${cycle}` });
      return;
    }
    state.set(id, 1);
    for (const dep of graph.get(id) || []) visit(dep, [...trail, id]);
    state.set(id, 2);
  };
  for (const id of ids) visit(id);

  return { tasks, errors };
}

export function graphErrors(errors) {
  const graphCodes = new Set(['MALFORMED_LINE', 'DUPLICATE_ID', 'UNKNOWN_DEP', 'SELF_DEP', 'CYCLE']);
  return errors.filter((error) => graphCodes.has(error.code));
}

export function taskErrorsFor(errors, taskId) {
  return errors.filter((error) => error.task === taskId && !['UNKNOWN_DEP', 'SELF_DEP', 'CYCLE'].includes(error.code));
}

// Test assets include the common conventions that are not named `*.test.*`:
// pytest's `test_*.py` / `*_test.py`, Go's `*_test.go`, e2e specs, fixtures,
// `testdata/` (Go) and `__snapshots__/`. Missing these made `ceshi` commits of
// legitimate test assets fail the provenance gate (exit 30).
export function isTestPath(file) {
  const value = String(file || '');
  return /(^|\/)(test|tests|__tests__|spec|e2e|fixtures?|testdata|__snapshots__)(\/|$)/i.test(value)
    || /(?:^|\/)test_[^/]*\.py$/i.test(value)
    || /(?:\.|_)(test|spec|e2e)\.[^.]+$/i.test(value);
}

export function isFileWithinScopes(filePath, scopes) {
  const normalized = normalizeScope(filePath);
  if (!normalized) return false;
  return scopes.some((scope) => normalized === scope || normalized.startsWith(`${scope}/`));
}

// ---- Verify parsing (single owner for freeze-check and merge-task) ----
//
// A leg is "broad" when it can run the whole suite: a known test runner with no
// path named. Paths win over runner names, so `npm test -- src/a.test.ts`,
// `pnpm test src/b/b.test.ts` and `go test ./pkg/a` are scoped runs. `go test
// ./...`, bare `pytest` and bare `npm test` are broad.
export const FULL_SUITE_LEG = /(?:^|[\s;&|])(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|(?:^|[\s;&|])(?:node\s+--test|pytest|py\.test|vitest|jest|mocha|ava|phpunit|tox|nox|cargo\s+test|go\s+test|make\s+(?:test|check)|dotnet\s+test)(?=\s|$)/i;

export function commandParts(value) {
  return String(value || '').split(/&&|\|\||;|\|/).map((part) => part.trim()).filter(Boolean);
}

/** Path-ish tokens in one leg, normalized to repo-relative form. */
export function legPaths(part) {
  return String(part || '').split(/\s+/)
    .map((token) => token.replace(/^['"]|['"]$/g, ''))
    .filter((token) => token && !token.startsWith('-') && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token))
    .map((token) => token.replace(/^\.\//, '').replace(/(?:\/\.\.\.|\/)$/, ''))
    // A bare runner subcommand (`npm test`, `pnpm run test`) is not a path: require
    // either a path separator or a file extension so `test`/`spec` words are skipped.
    .filter((token) => token && token !== '.' && token !== '...' && (token.includes('/') || /\.[A-Za-z0-9]+$/.test(token)));
}

/**
 * Parse `Verify with` into legs. `broad` marks a leg that may run the whole suite;
 * `paths` are the scoped anchors it names (repo-relative).
 */
export function verifyLegs(value) {
  return commandParts(value).map((command) => {
    const paths = [...new Set(legPaths(command))];
    return { command, paths, broad: paths.length === 0 && FULL_SUITE_LEG.test(command) };
  });
}

export function computeWaves(tasks) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const cache = new Map();
  const visit = (task) => {
    if (cache.has(task.id)) return cache.get(task.id);
    cache.set(task.id, 0);
    const wave = task.depends.length === 0
      ? 1
      : 1 + Math.max(...task.depends.filter((id) => byId.has(id)).map((id) => visit(byId.get(id))));
    cache.set(task.id, wave);
    return wave;
  };
  const waves = new Map();
  for (const task of tasks) {
    const wave = visit(task);
    waves.set(wave, [...(waves.get(wave) || []), task.id]);
  }
  return waves;
}
