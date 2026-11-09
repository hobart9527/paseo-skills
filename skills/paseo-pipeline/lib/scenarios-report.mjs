#!/usr/bin/env node
// Read-only derived view of a change's scenario/task/acceptance relations.
//
// The author keeps three sets consistent by hand today: declared SCEN ids (specs/), the task
// claims (`Scenarios:` in tasks.md) and the acceptance rows. This reports whether they agree
// right now, in one read of the content, so the author fixes a gap instead of re-deriving the
// sets from memory. It derives; it never decides.
//
// It never executes Verify, writes a file, renumbers an id, changes a claim, invents scope or a
// dependency, or generates Entry / business expectation / Required. Those stay judgements.
// Candidates are the safe default (an empty `Tasks` cell, whose owners the gate derives from
// tasks.md) and are not a freezable acceptance row: structural freeze and R0 still decide.
//
// Any parse or read error is fatal for the whole report: a partial report could be mistaken for a
// complete one, and a candidate derived from a half-read table could look valid. Exit: 0 ok,
// 1 unparseable input, 2 usage.
import fs from 'node:fs';
import path from 'node:path';
import { runGit } from './git.mjs';
import { parseTasks, isTaskId } from './tasks.mjs';
import { loadSpecTree, scanScenarios } from './spec-scan.mjs';
import { parseAcceptanceTable } from './acceptance.mjs';

const errorOf = (code, message, extra = {}) => ({ code, message, ...extra });
const failure = (errors) => ({ scenarios: undefined, undeclaredClaims: undefined, undeclaredRows: undefined, errors });

function repoRootOf(changeDir) {
  let dir = changeDir;
  while (!fs.existsSync(dir)) {
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  const result = runGit(dir, ['rev-parse', '--show-toplevel']);
  return result.status === 0 ? result.stdout.trim() : null;
}

/**
 * Build the report from exactly one read of each input. `change` is the change directory.
 * Returned shape:
 *   { scenarios: [{ id, file, section, identity, claimants, acceptanceRows, gaps, candidate }],
 *     undeclaredClaims: [{ task, scen }], undeclaredRows: [{ line, scen }],
 *     acceptance: { present, headerOk }, errors: [] }
 * `scenarios` is undefined whenever `errors` is non-empty.
 */
export function buildScenariosReport(changeDir) {
  const errors = [];
  const repoRoot = repoRootOf(changeDir);

  // tasks.md: the local draft, because that is what the author is about to commit. A missing
  // file is not a parse error — the specs stage precedes tasks.md — it means "no claims yet".
  const tasksFile = path.join(changeDir, 'tasks.md');
  let tasksMarkdown = null;
  if (fs.existsSync(tasksFile)) {
    try { tasksMarkdown = fs.readFileSync(tasksFile, 'utf8'); }
    catch (error) { errors.push(errorOf('UNREADABLE_TASKS', `${tasksFile}: ${error.message}`)); }
  }
  const parsedTasks = tasksMarkdown === null ? { tasks: [], errors: [] } : parseTasks(tasksMarkdown);
  for (const error of parsedTasks.errors) {
    errors.push(errorOf(error.code, error.message, { task: error.task, line: error.line }));
  }

  // specs/: reuse the gate's own scenario discovery — a second Markdown scanner would drift.
  const specTree = loadSpecTree({ repoRoot, changeDir });
  for (const problem of specTree.problems) errors.push(errorOf('UNREADABLE_SPEC', problem.reason, { file: problem.path }));

  const declared = [];
  const declaredById = new Map();
  for (const { file, text } of specTree.current) {
    for (const found of scanScenarios(text)) {
      if (declaredById.has(found.id)) {
        errors.push(errorOf('DUPLICATE_SCEN', `${found.id} is declared twice in this change`, { file: path.relative(changeDir, file) }));
        continue;
      }
      const entry = { id: found.id, title: found.title, section: found.section, body: found.body, file: path.relative(changeDir, file) };
      declaredById.set(found.id, entry);
      declared.push(entry);
    }
  }

  // Acceptance table. `parseAcceptanceTable` is the gate's own reader, so a row this helper shows
  // is a row freeze-check will judge. A wrong header is a parse error; an absent table is not.
  const acceptanceFile = path.join(changeDir, 'acceptance.md');
  let acceptanceMarkdown = null;
  if (fs.existsSync(acceptanceFile)) {
    try { acceptanceMarkdown = fs.readFileSync(acceptanceFile, 'utf8'); }
    catch (error) { errors.push(errorOf('UNREADABLE_ACCEPTANCE', `${acceptanceFile}: ${error.message}`)); }
  }
  const acceptancePresent = acceptanceMarkdown !== null;
  const table = acceptancePresent ? parseAcceptanceTable(acceptanceMarkdown) : { rows: [], malformed: [], headerOk: false };
  for (const malformed of table.malformed) {
    errors.push(errorOf('MALFORMED_ACCEPTANCE_ROW', `${malformed.cells} cells, header has ${malformed.expectedColumns}`, { file: 'acceptance.md', line: malformed.line }));
  }
  if (acceptancePresent && !table.headerOk) {
    // Same rule as the gate: an acceptance.md that exists must carry the documented header. Rows
    // alone are still recognisable, so a header-less file previously produced a complete report
    // with plausible candidates for a package freeze-check rejects outright.
    errors.push(errorOf('BAD_ACCEPTANCE_HEADER', 'acceptance.md needs exactly Scenario, Entry, Tasks, Verify, Required, Result, Evidence in that order', { file: 'acceptance.md' }));
  }

  if (errors.length) return failure(errors);

  // Cross-source relations. Claim maps are keyed by upper-case id, as the gate keys them.
  const claimsByScen = new Map();
  for (const task of parsedTasks.tasks) {
    for (const scen of task.scenarios) {
      const id = scen.toUpperCase();
      if (!claimsByScen.has(id)) claimsByScen.set(id, new Set());
      claimsByScen.get(id).add(task.id);
    }
  }
  const taskIds = new Set(parsedTasks.tasks.map((task) => task.id));
  const rowsByScen = new Map();
  for (const row of table.rows) {
    if (!rowsByScen.has(row.scen)) rowsByScen.set(row.scen, []);
    const listed = row.tasksRaw.split(',').map((item) => item.trim()).filter(Boolean);
    rowsByScen.get(row.scen).push({ ...row, listed, ids: listed.filter((item) => isTaskId(item)) });
  }

  const scenarios = declared.map((entry) => {
    const claimants = [...(claimsByScen.get(entry.id) ?? [])].sort();
    const rows = rowsByScen.get(entry.id) ?? [];
    const gaps = [];
    if (!claimants.length) gaps.push('NO_CLAIMANT_TASK');
    if (!rows.length) gaps.push('NO_ACCEPTANCE_ROW');
    const union = new Set();
    for (const row of rows) {
      // An empty cell derives its owners from tasks.md; that is the recommended default and can
      // never be missing a claimant. A filled cell is a per-row subset the union must complete.
      const owners = row.tasksRaw ? row.ids : claimants;
      owners.forEach((id) => union.add(id));
      for (const id of row.ids) {
        if (!taskIds.has(id)) gaps.push(`ROW_NAMES_UNKNOWN_TASK ${id}`);
        else if (!claimants.includes(id)) gaps.push(`ROW_NAMES_NON_CLAIMANT ${id}`);
      }
    }
    // A missing row is already the whole gap; the union only says something once rows exist.
    if (rows.length) for (const id of claimants) if (!union.has(id)) gaps.push(`ROW_UNION_MISSING ${id}`);
    return {
      id: entry.id,
      title: entry.title,
      file: entry.file,
      section: entry.section,
      identity: identityOf(entry, specTree, repoRoot),
      claimants,
      acceptanceRows: rows.map((row) => ({
        line: row.line,
        tasks: row.ids,
        tasksCell: row.tasksRaw,
        entry: row.entry,
        verify: row.verify,
        required: row.required,
        result: row.result,
      })),
      gaps,
      // The safe default only: an empty Tasks cell. Entry, business expectation and Required are
      // authored judgements and are deliberately absent.
      candidate: { Scenario: entry.id, Tasks: '' },
    };
  });

  const declaredIds = new Set(declared.map((entry) => entry.id));
  const undeclaredClaims = parsedTasks.tasks.flatMap((task) => task.scenarios
    .map((scen) => scen.toUpperCase())
    .filter((id) => !declaredIds.has(id))
    .map((id) => ({ task: task.id, scen: id })));
  const undeclaredRows = table.rows.filter((row) => !declaredIds.has(row.scen)).map((row) => ({ line: row.line, scen: row.scen }));
  return { scenarios, undeclaredClaims, undeclaredRows, acceptance: { present: acceptancePresent, headerOk: table.headerOk }, errors: [] };
}

// Why a declared id is safe or not, without changing collision semantics or scanning archives:
//   new                     no baseline or active-change declaration exists
//   baseline-reuse          the id already exists in baseline and this change re-declares it
//                           under MODIFIED/REMOVED Requirements
//   baseline-id-unreused    a baseline id re-declared under ADDED — the gate reports a collision
//   shared-identical        another active change declares byte-identical text (legal, order matters)
//   conflict                another active change declares a different text for the same id
function identityOf(entry, specTree, repoRoot) {
  const same = (hit) => hit.title === entry.title && hit.body === entry.body;
  const baseline = specTree.baseline.flatMap((source) => scanScenarios(source.text)
    .filter((found) => found.id === entry.id)
    .map((found) => ({ file: source.file, ...found })));
  const others = specTree.others.flatMap((source) => scanScenarios(source.text)
    .filter((found) => found.id === entry.id)
    .map((found) => ({ file: source.file, change: source.change, ...found })));
  const files = [...baseline, ...others]
    .map((hit) => (repoRoot ? path.relative(repoRoot, hit.file) : hit.file).split(path.sep).join('/'));
  if (!baseline.length && !others.length) return { kind: 'new', files: [] };
  if (baseline.length) {
    const allowed = /^(?:MODIFIED|REMOVED) Requirements$/i.test(entry.section || '');
    return { kind: allowed ? 'baseline-reuse' : 'baseline-id-unreused', files };
  }
  return { kind: others.every(same) ? 'shared-identical' : 'conflict', files };
}
