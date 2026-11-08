// Minimal tasks.md parser for the converged pipeline.
// State lives in git; this module only validates the frozen contract.
import { dispatchDeps, mergeDeps } from './schedule.mjs';

const TASK_LINE = /^\s*[-*]\s*\[([ xX])\]\s+(?:(?:\d+(?:\.\d+)*)\s+)?([A-Za-z][A-Za-z0-9]*-\d+)(?::\s*|\s+)(.*)$/;
const FIELD_LINE = /^\s+[-*]\s+([^:]+):\s*(.*)$/;
const CHECKBOX_LINE = /^\s*[-*]\s*\[([ xX])\]\s*(.*)$/;
const TASK_ID = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
const DONE_LINE = /^source=([0-9a-f]{7,40})\s+review=(\S+)$/;
// Reviewer may be a full UUID or any hex prefix of it. Paseo's own `shortId` is 7
// characters, so accepting only 8 (or 36 without prefixes) made every real shortId
// unusable.
const REVIEWER_ID = String.raw`mechanical|deferred|[0-9a-f]{7,40}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`;
const REVIEW_TAG = new RegExp(String.raw`^pass\((${REVIEWER_ID})@([0-9a-f]{7,40})\/([0-9a-f]{7,40})\)$`);
export const REVIEW_MODES = ['standard', 'strict', 'mechanical', 'deferred'];
const INTERFACE_SYMBOL = /^[^\s#]+$/;
const DECISION_ID = /^D-\d+$/;


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
        uses: [],
        scope: [],
        reads: [],
        est: 'M',
        kind: null,
        interface: [],
        implements: [],
        riskSurface: [],
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
    else if (key === 'uses') current.uses.push(...splitList(value));
    else if (key === 'write scope') current.scope.push(...splitList(value).map(normalizeScope).filter(Boolean));
    else if (key === 'reads') {
      for (const item of splitList(value)) {
        const normalized = normalizeScope(item);
        if (!normalized) errors.push({ code: 'BAD_READS', task: current.id, message: `bad Reads path: ${item}` });
        else current.reads.push(normalized);
      }
    } else if (key === 'est') {
      const est = value.trim().toUpperCase();
      if (est && !['S', 'M', 'L'].includes(est)) errors.push({ code: 'BAD_EST', task: current.id, message: `Est must be S, M or L: ${value}` });
      else if (est) current.est = est;
    } else if (key === 'kind') {
      const kind = value.trim().toLowerCase();
      if (kind && kind !== 'none' && kind !== 'skeleton') errors.push({ code: 'BAD_KIND', task: current.id, message: `Kind must be skeleton or none: ${value}` });
      else if (kind === 'skeleton') current.kind = 'skeleton';
    } else if (key === 'interface') {
      for (const entry of splitList(value)) {
        const parts = entry.split('#');
        const normalized = normalizeScope(parts[0]);
        const symbol = parts[1] ?? '';
        if (!normalized || parts.length > 2 || (parts.length === 2 && !INTERFACE_SYMBOL.test(symbol))) {
          errors.push({ code: 'BAD_INTERFACE', task: current.id, message: `bad Interface entry: ${entry}` });
        } else current.interface.push(symbol ? `${normalized}#${symbol}` : normalized);
      }
    } else if (key === 'implements') {
      for (const entry of splitList(value)) {
        if (!DECISION_ID.test(entry)) errors.push({ code: 'BAD_IMPLEMENTS', task: current.id, message: `bad Implements entry: ${entry}` });
        else current.implements.push(entry);
      }
    } else if (key === 'risk-surface' || key === 'risk surface') {
      current.riskSurface.push(...splitList(value.replace(/[\[\]]/g, '')).map((item) => item.toLowerCase()));
    } else if (key === 'verify with') current.verify = (current.verify ? `${current.verify} ${normalizeCommand(value)}` : normalizeCommand(value)).trim();
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
    if (!REVIEW_MODES.includes(task.review)) {
      errors.push({ code: 'UNKNOWN_REVIEW', task: task.id, message: `${task.id} has unknown Review: ${task.review}` });
    }
    for (const dep of task.depends) {
      if (!ids.has(dep)) errors.push({ code: 'UNKNOWN_DEP', task: task.id, message: `${task.id} depends on unknown ${dep}` });
      if (dep === task.id) errors.push({ code: 'SELF_DEP', task: task.id, message: `${task.id} depends on itself` });
    }
    for (const used of new Set(task.uses)) {
      if (used === task.id || !ids.has(used)) errors.push({ code: 'USES_UNKNOWN', task: task.id, message: `Uses ${used} must name another task in this file` });
    }
  }

  // Every dispatch dependency is reachable through merge edges. Checking their union
  // catches both dispatch deadlocks and cycles that only block completed merges.
  const graph = new Map(tasks.map((task) => [task.id, mergeDeps(task).filter((id) => ids.has(id) && id !== task.id)]));
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
  const graphCodes = new Set(['MALFORMED_LINE', 'DUPLICATE_ID', 'UNKNOWN_DEP', 'SELF_DEP', 'USES_UNKNOWN', 'CYCLE']);
  return errors.filter((error) => graphCodes.has(error.code));
}

export function taskErrorsFor(errors, taskId) {
  return errors.filter((error) => error.task === taskId && !['UNKNOWN_DEP', 'SELF_DEP', 'CYCLE'].includes(error.code));
}

// Test assets include the common conventions that are not named `*.test.*`:
// pytest's `test_*.py` / `*_test.py`, Go's `*_test.go`, e2e specs, fixtures,
// `testdata/` (Go) and `__snapshots__/`. Missing these made `ceshi` commits of
// legitimate test assets fail the provenance gate (exit 30).
// Repos may also keep assertion scripts under `scripts/specs/` (plural); match
// that exact prefix only, so contract files under `openspec/**/specs/*.md`
// stay outside the test-author allowance.
export function isTestPath(file) {
  const value = String(file || '');
  return /(^|\/)(test|tests|__tests__|spec|e2e|fixtures?|testdata|__snapshots__)(\/|$)/i.test(value)
    || /(?:^|\/)scripts\/specs\//i.test(value)
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

// A working-directory option (`npm --prefix packages/server test`, `pnpm -C dir test`,
// `yarn --cwd dir test`) moves the runner into a package; its value names where the suite
// runs, not a test path. Resolve the leg's own paths against it so a scoped run stays narrow
// and a bare runner becomes broad. Bounded to these options; no general shell parsing.
const CWD_OPTION = /^(?:--prefix|-C|--dir|--cwd)(?:=(\S+))?$/;

/** Segment-wise `./`, `dir/` and `a/../b` normalization; null when absolute or escapes the root. */
function normalizeRelativeDir(value) {
  const raw = String(value || '').replace(/^['"]|['"]$/g, '');
  if (raw.startsWith('/')) return null;
  const segments = [];
  for (const segment of raw.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (!segments.length) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join('/');
}

/** Resolve a leg path against its working directory; an escaping or absolute path stays as written. */
function resolveLegPath(cwd, path) {
  if (!cwd || path.startsWith('/')) return path;
  return normalizeRelativeDir(`${cwd}/${path}`) ?? path;
}

function legWorkingDirectory(part) {
  const tokens = String(part || '').split(/\s+/).map((token) => token.replace(/^['"]|['"]$/g, ''));
  for (let i = 0; i < tokens.length; i += 1) {
    const match = CWD_OPTION.exec(tokens[i]);
    if (!match) continue;
    const value = match[1] ?? tokens[i + 1];
    const cwd = value && !value.startsWith('-') ? normalizeRelativeDir(value) : null;
    // Strip the option's value token only when it resolves; otherwise leave the leg as it was.
    // `cwd === ''` is the repo root and still strips the option.
    return { cwd, strip: cwd !== null ? (match[1] ? [i] : [i, i + 1]) : [] };
  }
  return { cwd: null, strip: [] };
}

/**
 * Parse `Verify with` into legs. `broad` marks a leg that may run the whole suite;
 * `paths` are the scoped anchors it names (repo-relative).
 */
export function verifyLegs(value) {
  return commandParts(value).map((command) => {
    const { cwd, strip } = legWorkingDirectory(command);
    // Drop the working-directory option and its value before reading paths, so the package
    // directory is not mistaken for the target of the run.
    const tokens = command.split(/\s+/);
    const scoped = strip.length ? tokens.filter((_, i) => !strip.includes(i)).join(' ') : command;
    const paths = [...new Set(legPaths(scoped).map((path) => (cwd === null ? path : resolveLegPath(cwd, path))))];
    return { command, paths, broad: paths.length === 0 && FULL_SUITE_LEG.test(scoped) };
  });
}

export function computeWaves(tasks) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const cache = new Map();
  const visit = (task) => {
    if (cache.has(task.id)) return cache.get(task.id);
    cache.set(task.id, 0);
    const deps = dispatchDeps(task, tasks).filter((id) => byId.has(id));
    const wave = deps.length === 0
      ? 1
      : 1 + Math.max(...deps.map((id) => visit(byId.get(id))));
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
