// Approval-gated, re-entrant cleanup for a finished change.
//
// Discovery is read-only: it lists the Paseo workspaces, Git worktrees and branches this
// change owns, with the exact command that would touch each. `--execute` runs an object only
// when one `Approval:` block of run-log.md contains both its identifier and its exact command,
// and records every attempt so a re-run skips what is already done.
//
// Nothing here force-deletes: Paseo archives its own worktrees, manual worktrees use
// `git worktree remove` without --force, and branches use `-d`. A refusal is a safe failure,
// not something to escalate.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseOptions } from './cli.mjs';
import { runGit } from './git.mjs';
import { parseTasks } from './tasks.mjs';
import { readTasksMarkdown } from './tasks-source.mjs';
import { readMergeState } from './merge-state.mjs';

const USAGE = 'usage: pipeline-run.mjs cleanup <change-dir> [--dry-run] [--execute] [--json] [--base <ref>] [--merged-at <sha>]';
const TASK_ID = String.raw`[A-Za-z][A-Za-z0-9]*-\d+`;
const RECORD = /^Cleanup:\s+(\S+)\s+(\S+)\s+(.+)\s+(done|failed|skipped)$/;

function escapeRe(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// macOS reports /private/var for a repo opened through the /var symlink; compare real paths,
// falling back to the literal path when the target is already gone.
function realOrResolved(value) {
  try { return fs.realpathSync(path.resolve(value)); } catch { return path.resolve(value); }
}

function ownedBranch(branch, change) {
  if (!branch) return false;
  if (branch === `integration/${change}`) return true;
  return new RegExp(`^task/${escapeRe(change)}/${TASK_ID}(?:-a\\d+)?$`).test(branch);
}

function listWorktrees(cwd) {
  const result = runGit(cwd, ['worktree', 'list', '--porcelain']);
  if (result.error || result.status !== 0) throw new Error(`git worktree list failed: ${(result.stderr || result.error?.message || '').trim()}`);
  const trees = [];
  let current = null;
  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('worktree ')) { current = { path: line.slice('worktree '.length), branch: null, prunable: false }; trees.push(current); }
    else if (current && line.startsWith('branch ')) current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    else if (current && (line === 'prunable' || line.startsWith('prunable '))) current.prunable = true;
  }
  return trees;
}

function listBranches(cwd, change) {
  const result = runGit(cwd, ['for-each-ref', '--format=%(refname:short)', `refs/heads/integration/${change}`, `refs/heads/task/${change}/`]);
  if (result.error || result.status !== 0) throw new Error(`git for-each-ref failed: ${(result.stderr || result.error?.message || '').trim()}`);
  return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean).filter((branch) => ownedBranch(branch, change));
}

// `--background` is required: the active list hides background workspaces, and a hidden but
// owning workspace would make its worktree look manual — then `git worktree remove` would run
// on a Paseo-owned path instead of `paseo workspace archive`.
function listPaseoWorkspaces() {
  const result = spawnSync('paseo', ['workspace', 'ls', '--background', '--json'], { encoding: 'utf8', timeout: 10_000 });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || (result.stderr || '').trim();
    return { error: `cannot read Paseo workspaces (\`paseo workspace ls --background --json\`${detail ? `: ${detail}` : ''})` };
  }
  let listed;
  try { listed = JSON.parse(result.stdout); } catch { return { error: 'invalid JSON from `paseo workspace ls --background --json`' }; }
  if (!Array.isArray(listed)) return { error: 'invalid Paseo workspace list' };
  return { workspaces: listed };
}

/**
 * Read-only deterministic discovery. Returns worktree objects first (in `git worktree list`
 * order), then branch objects. A worktree owned by a Paseo workspace yields exactly one
 * `paseo-workspace` object and never an extra `git-worktree` object for the same path.
 *
 * A stale registration (path gone) is not touched implicitly: `git worktree prune` would also
 * prune other changes' registrations. It becomes its own `worktree-prune` object, and only
 * when every prunable registration belongs to this change.
 */
export function discoverObjects({ cwd, changeDir }) {
  const change = path.basename(changeDir);
  const paseo = listPaseoWorkspaces();
  if (paseo.error) throw Object.assign(new Error(paseo.error), { code: 3 });
  const byPath = new Map();
  for (const workspace of paseo.workspaces) {
    if (typeof workspace?.cwd !== 'string' || typeof workspace?.workspaceId !== 'string') continue;
    byPath.set(realOrResolved(workspace.cwd), workspace);
  }
  const objects = [];
  const seen = new Set();
  const trees = listWorktrees(cwd);
  const prunable = trees.filter((tree) => tree.prunable);
  if (prunable.length && prunable.every((tree) => ownedBranch(tree.branch, change))) {
    objects.push({
      kind: 'worktree-prune',
      id: prunable[0].path,
      branch: null,
      path: prunable[0].path,
      command: 'git worktree prune',
    });
  } else if (prunable.length) {
    const foreign = prunable.filter((tree) => !ownedBranch(tree.branch, change)).map((tree) => tree.path);
    console.warn(`[pipeline-run] not pruning stale registrations owned by other changes: ${foreign.join(', ')}`);
  }
  for (const tree of trees) {
    if (tree.prunable) continue;
    if (!ownedBranch(tree.branch, change)) continue;
    const key = realOrResolved(tree.path);
    if (seen.has(key)) continue;
    seen.add(key);
    const workspace = byPath.get(key);
    if (workspace) {
      objects.push({
        kind: 'paseo-workspace',
        id: workspace.workspaceId,
        branch: tree.branch,
        path: tree.path,
        command: `paseo workspace archive ${workspace.workspaceId}`,
      });
    } else {
      objects.push({
        kind: 'git-worktree',
        id: tree.branch,
        branch: tree.branch,
        path: tree.path,
        command: `git worktree remove ${tree.path}`,
      });
    }
  }
  for (const branch of listBranches(cwd, change)) {
    objects.push({ kind: 'branch', id: branch, branch, path: null, command: `git branch -d ${branch}` });
  }
  return { change, objects };
}

// ---- Approval gate ----

function relativeInRepo(cwd, changeDir) {
  const top = runGit(cwd, ['rev-parse', '--show-toplevel']);
  if (top.error || top.status !== 0) return null;
  const rel = path.relative(realOrResolved(top.stdout.trim()), realOrResolved(changeDir));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

/**
 * One source, chosen deterministically. Cleanup runs after CP-2, so the human records the
 * approval in the worktree run-log; committing it to integration would break the ancestry
 * precondition. The worktree file is therefore primary and the integration copy is only the
 * fallback when that file does not exist. Never a union.
 * @returns {{text: string, source: 'worktree'|'integration'|'none'}}
 */
export function readApprovalText(cwd, changeDir, change) {
  const file = path.join(changeDir, 'run-log.md');
  if (fs.existsSync(file)) return { text: fs.readFileSync(file, 'utf8'), source: 'worktree' };
  const ref = `refs/heads/integration/${change}`;
  if (runGit(cwd, ['rev-parse', '--verify', '--quiet', ref]).status === 0) {
    const rel = relativeInRepo(cwd, changeDir);
    if (rel) {
      const shown = runGit(cwd, ['show', `${ref}:${rel}/run-log.md`]);
      if (shown.status === 0) return { text: shown.stdout, source: 'integration' };
    }
  }
  return { text: '', source: 'none' };
}

/** One block per `Approval:` line, ending at the next Approval line or a blank line. */
export function parseApprovalBlocks(text) {
  const blocks = [];
  let current = null;
  const flush = () => { if (current) blocks.push(current.join('\n')); current = null; };
  for (const line of String(text || '').split(/\r?\n/)) {
    if (/^\s*Approval:/.test(line)) { flush(); current = [line]; continue; }
    if (!current) continue;
    if (line.trim() === '') flush();
    else current.push(line);
  }
  flush();
  return blocks;
}

function containsToken(text, token) {
  const escaped = escapeRe(token);
  return new RegExp(`(^|[^A-Za-z0-9_./-])${escaped}($|[^A-Za-z0-9_./-])`).test(text);
}

/** Command lines of a block (`Command: <cmd>`, backticks and trailing punctuation stripped). */
export function blockCommands(block) {
  const commands = [];
  for (const line of String(block || '').split(/\r?\n/)) {
    const match = line.match(/^\s*[-*]?\s*Command:\s*(.+)$/i);
    if (!match) continue;
    // Strip surrounding backticks and trailing punctuation in either order: `` `cmd`. ``
    // and `cmd.` both mean the same command.
    let value = match[1].trim().replace(/[.,;:]+$/, '').trim();
    if (value.length >= 2 && value.startsWith('`') && value.endsWith('`')) value = value.slice(1, -1);
    value = value.trim().replace(/[.,;:]+$/, '').trim();
    if (value) commands.push(value);
  }
  return commands;
}

/**
 * A block covers an object only with both an identifier token and an exactly equal command
 * line in that same block. Substring matching would let `git branch -d integration/chg-old`
 * authorize `git branch -d integration/chg`.
 */
export function approvalCovers(block, object) {
  if (!block || !object?.command) return false;
  const identifiers = [object.id, object.branch, object.path].filter((value) => typeof value === 'string' && value);
  if (!identifiers.some((id) => containsToken(block, id))) return false;
  return blockCommands(block).some((command) => command === object.command.trim());
}

// ---- Re-entrancy records (worktree run-log; never committed) ----

function recordKey(kind, id) { return `${kind} ${id}`; }

/** Map of `kind id` -> recorded command for every attempt with outcome `done`. */
export function doneRecords(text) {
  const done = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(RECORD);
    if (match && match[4] === 'done') done.set(recordKey(match[1], match[2]), { kind: match[1], id: match[2], command: match[3] });
  }
  return done;
}

function readWorktreeRunLog(changeDir) {
  const file = path.join(changeDir, 'run-log.md');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

function appendRecord(changeDir, object, outcome) {
  const file = path.join(changeDir, 'run-log.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `Cleanup: ${object.kind} ${object.id} ${object.command} ${outcome}\n`);
}

// ---- Execution ----

function paseoArchive(object) {
  const result = spawnSync('paseo', ['workspace', 'archive', object.id], { encoding: 'utf8', timeout: 120_000 });
  if (result.error) return { status: 'failed', detail: result.error.message };
  if (result.status !== 0) return { status: 'failed', detail: (result.stderr || result.stdout || '').trim() || 'paseo workspace archive failed' };
  if (fs.existsSync(object.path)) return { status: 'failed', detail: `worktree still exists after archive: ${object.path}` };
  return { status: 'done', detail: '' };
}

/** Execute one approved object. A missing object counts as done, not an error. */
export function executeObject(object, { cwd = process.cwd() } = {}) {
  if (object.kind === 'worktree-prune') {
    const result = runGit(cwd, ['worktree', 'prune']);
    if (result.status !== 0) return { status: 'failed', detail: (result.stderr || result.stdout || '').trim() || 'git worktree prune failed' };
    return { status: 'done', detail: '' };
  }
  if (object.kind === 'branch') {
    const ref = `refs/heads/${object.branch}`;
    if (runGit(cwd, ['rev-parse', '--verify', '--quiet', ref]).status !== 0) return { status: 'done', detail: 'branch already gone' };
    const result = runGit(cwd, ['branch', '-d', object.branch]);
    if (result.status !== 0) return { status: 'failed', detail: (result.stderr || result.stdout || '').trim() || 'git branch -d refused' };
    return { status: 'done', detail: '' };
  }
  if (!fs.existsSync(object.path)) return { status: 'done', detail: 'already gone' };
  if (object.kind === 'git-worktree') {
    const result = runGit(cwd, ['worktree', 'remove', object.path]);
    if (result.status !== 0) return { status: 'failed', detail: (result.stderr || result.stdout || '').trim() || 'git worktree remove refused' };
    return { status: 'done', detail: '' };
  }
  if (object.kind === 'paseo-workspace') return paseoArchive(object);
  return { status: 'failed', detail: `unknown object kind: ${object.kind}` };
}

/**
 * Every `--execute` precondition. Returns null when they all hold, or `{ code, message }`.
 * The pending-merge marker is the existing shared ref written by merge-task, read through
 * `readMergeState`; no new marker is invented.
 */
export function checkPreconditions({ cwd, changeDir, change, objects, base, mergedAt }) {
  let markdown;
  let source;
  try { ({ markdown, source } = readTasksMarkdown(changeDir, change)); }
  catch (error) { return { code: 4, message: `cannot read tasks.md: ${error.message}` }; }
  const { tasks, errors } = parseTasks(markdown);
  if (!tasks.length) errors.push({ code: 'EMPTY_TASKS', message: 'tasks.md parsed to zero tasks' });
  if (errors.length) {
    return { code: 4, message: `tasks.md does not parse (${source}): ${errors.map((error) => `${error.code}${error.task ? ` ${error.task}` : ''}: ${error.message}`).join('; ')}` };
  }
  const open = tasks.filter((task) => !task.done);
  if (open.length) return { code: 4, message: `tasks are not Done: ${open.map((task) => task.id).join(', ')}` };
  const integration = `integration/${change}`;
  if (runGit(cwd, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]).status !== 0) {
    return { code: 4, message: `base ${base} does not resolve` };
  }
  // CP-2 must really have landed. An absent integration branch proves nothing — it may have
  // been deleted before the merge — so it is a refusal unless the human names the merged SHA.
  // A prior `Cleanup:` record does not substitute: it proves this command ran, not the merge.
  if (runGit(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${integration}`]).status === 0) {
    if (runGit(cwd, ['merge-base', '--is-ancestor', integration, base]).status !== 0) {
      return { code: 4, message: `${integration} is not an ancestor of ${base}; CP-2 has not landed` };
    }
  } else if (!mergedAt) {
    return { code: 4, message: `${integration} is absent; pass --merged-at <sha> with a commit that is an ancestor of ${base} to prove CP-2 landed` };
  } else if (runGit(cwd, ['rev-parse', '--verify', '--quiet', `${mergedAt}^{commit}`]).status !== 0) {
    return { code: 4, message: `--merged-at ${mergedAt} does not resolve` };
  } else if (runGit(cwd, ['merge-base', '--is-ancestor', `${mergedAt}^{commit}`, base]).status !== 0) {
    return { code: 4, message: `--merged-at ${mergedAt} is not an ancestor of ${base}; CP-2 has not landed` };
  }
  for (const object of objects) {
    if (object.kind === 'worktree-prune') continue;
    if (!object.path || !fs.existsSync(object.path)) continue;
    const status = runGit(object.path, ['status', '--porcelain']);
    if (status.error || status.status !== 0) return { code: 4, message: `cannot check ${object.path}: ${(status.stderr || status.error?.message || '').trim()}` };
    if (status.stdout.trim() !== '') return { code: 4, message: `worktree is not clean: ${object.path}` };
  }
  for (const task of tasks) {
    let state;
    try { state = readMergeState(cwd, change, task.id); }
    catch (error) { return { code: 3, message: `cannot read merge state for ${task.id}: ${error.message}` }; }
    if (state?.status === 'pending') {
      return { code: 4, message: `pending merge marker for ${task.id} (${state.tip.slice(0, 7)}); finish or inspect that merge first` };
    }
  }
  return null;
}

// ---- CLI ----

function shape(object) {
  return {
    kind: object.kind,
    id: object.id,
    path: object.path,
    command: object.command,
    approved: !!object.approved,
    status: object.status,
  };
}

/**
 * CLI entry point. Lists objects by default (same as --dry-run) and executes only approved
 * ones with --execute. Returns the process exit code; the caller forwards it.
 * Exit: 0 ok; 2 usage; 3 unreadable state; 4 precondition refused; 5 approval incomplete.
 */
export function runCleanup(argv, { cwd = process.cwd(), stdout = (line) => console.log(line), stderr = (line) => console.error(line) } = {}) {
  let parsed;
  try { parsed = parseOptions(argv, { 'dry-run': 'boolean', execute: 'boolean', json: 'boolean', base: 'value', 'merged-at': 'value' }); }
  catch (error) { stderr(`[pipeline-run] ${error.message}`); return 2; }
  if (parsed.positional.length !== 1) { stderr(`[pipeline-run] cleanup needs <change-dir>\n${USAGE}`); return 2; }
  if (parsed.options['dry-run'] && parsed.options.execute) { stderr('[pipeline-run] --dry-run and --execute are mutually exclusive'); return 2; }
  const changeDir = path.resolve(parsed.positional[0]);
  if (!fs.existsSync(path.join(changeDir, 'tasks.md'))) { stderr(`[pipeline-run] no tasks.md in ${changeDir}`); return 3; }
  const change = path.basename(changeDir);
  const base = parsed.options.base ?? 'main';
  const execute = !!parsed.options.execute;
  const json = !!parsed.options.json;

  let objects;
  try { objects = discoverObjects({ cwd, changeDir }).objects; }
  catch (error) { stderr(`[pipeline-run] ${error.message}`); return error.code ?? 3; }

  const approvals = readApprovalText(cwd, changeDir, change);
  const blocks = parseApprovalBlocks(approvals.text);
  const done = doneRecords(readWorktreeRunLog(changeDir));
  for (const object of objects) {
    object.approved = blocks.some((block) => approvalCovers(block, object));
    object.status = done.has(recordKey(object.kind, object.id)) ? 'already-done' : object.approved ? 'planned' : 'unapproved';
  }
  // A finished object disappears from discovery, so a re-run would report nothing at all.
  // Surface the recorded outcome instead: still listed, still skipped.
  const discovered = new Set(objects.map((object) => recordKey(object.kind, object.id)));
  for (const [key, record] of done) {
    if (discovered.has(key)) continue;
    objects.push({ kind: record.kind, id: record.id, branch: record.kind === 'branch' ? record.id : null, path: null, command: record.command, approved: true, status: 'already-done', recorded: true });
  }

  let exit = 0;
  let refusal = null;
  if (execute) {
    refusal = checkPreconditions({ cwd, changeDir, change, objects, base, mergedAt: parsed.options['merged-at'] });
    if (refusal) {
      exit = refusal.code;
      stderr(`[pipeline-run] cleanup refused: ${refusal.message}`);
    } else if (objects.some((object) => object.status !== 'already-done') && !objects.some((object) => object.approved)) {
      exit = 5;
      refusal = { message: 'no object has a matching recorded Approval; nothing may be executed' };
      stderr(`[pipeline-run] cleanup refused: ${refusal.message}`);
    } else {
      for (const object of objects) {
        if (object.status === 'already-done') continue;
        if (!object.approved) { object.status = 'unapproved'; if (!exit) exit = 5; continue; }
        const result = executeObject(object, { cwd });
        object.status = result.status;
        object.detail = result.detail;
        appendRecord(changeDir, object, result.status);
        if (result.status === 'failed' && exit !== 5) exit = 1;
      }
    }
  }

  if (json) {
    // The specified object fields stay; approvalSource is additive and a refusal is visible
    // through `exit` and stderr.
    stdout(JSON.stringify({ change, base, objects: objects.map(shape), exit, approvalSource: approvals.source }, null, 2));
  } else {
    stdout(`${change} (base ${base}, approvals from ${approvals.source})`);
    for (const object of objects) {
      const location = object.path ? ` ${object.path}` : '';
      const detail = object.detail ? ` (${object.detail})` : '';
      stdout(`[${object.status}] ${object.kind} ${object.id}${location} -> ${object.command}${detail}`);
    }
    if (execute && !refusal) stdout(`cleanup exit ${exit}`);
  }
  return exit;
}
