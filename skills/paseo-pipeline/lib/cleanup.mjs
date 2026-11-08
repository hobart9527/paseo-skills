// Approval-gated, re-entrant cleanup for a finished change.
//
// Discovery is read-only: it lists the Paseo workspaces, Git worktrees and branches this
// change owns, with the exact command that would touch each. `--execute` runs an object only
// when its own `Approval:` block of run-log.md carries one `Object:` line equal to the object's
// identifier and one `Command:` line equal to its command, compared literally, and records
// every attempt so a re-run skips what is already done.
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

const USAGE = 'usage: pipeline-run.mjs cleanup <change-dir> [--dry-run] [--execute] [--json] [--base <ref>] [--merged-at <sha>] [--change <name>]';
const CHANGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TASK_ID = String.raw`[A-Za-z][A-Za-z0-9]*-\d+`;
// A `@<sha>` suffix records the deleted branch tip, so a later run can prove which commit
// the integration branch pointed at when this command removed it.
const RECORD = /^Cleanup:\s+(\S+)\s+(\S+)\s+(.+)\s+(done|failed|skipped)(?:\s+@([0-9a-f]{40,64}))?$/;

function escapeRe(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// macOS reports /private/var for a repo opened through the /var symlink; compare real paths,
// falling back to the literal path when the target is already gone.
function realOrResolved(value) {
  try { return fs.realpathSync(path.resolve(value)); } catch { return path.resolve(value); }
}

/**
 * Exactly two directory shapes name a change: the live `.../<change>` directory, or its
 * archived copy `.../archive/<YYYY-MM-DD>-<change>`. Nothing else does — in particular a
 * date prefix is never stripped to guess the name, because a strip would let a `--change`
 * naming one change run cleanup against another change's directory.
 * @returns {'live'|'archived'|null}
 */
function changeDirShape(changeDir, change) {
  // The parent decides, never the basename alone: inside `archive/`, a dated basename is a
  // directory name and never a change name, even when some later change is literally named
  // `2026-11-08-chg`. Treating it as live there would run that other change's cleanup from
  // this one's approvals and Done tasks.
  if (path.basename(path.dirname(changeDir)) === 'archive') {
    return new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${escapeRe(change)}$`).test(path.basename(changeDir)) ? 'archived' : null;
  }
  return path.basename(changeDir) === change ? 'live' : null;
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

/**
 * The Paseo workspace that owns a worktree path, if any. A stale registration's directory is
 * gone, so `realpath` cannot identify it; only a literal path match against the workspace cwd
 * can, and a workspace whose cwd string differs from the registration path stays unrecognized.
 */
function ownedWorkspace(byPath, target) {
  const direct = byPath.get(path.resolve(target));
  if (direct) return direct;
  try { return byPath.get(fs.realpathSync(target)); } catch { return undefined; }
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
 * A stale registration (path gone) is an ordinary `git-worktree` object: `git worktree remove
 * <path>` clears just that registration without force, so it needs its own approval like any
 * other object. A registration owned by another change is never offered.
 */
export function discoverObjects({ cwd, changeDir, change }) {
  const paseo = listPaseoWorkspaces();
  if (paseo.error) throw Object.assign(new Error(paseo.error), { code: 3 });
  const byPath = new Map();
  for (const workspace of paseo.workspaces) {
    if (typeof workspace?.cwd !== 'string' || typeof workspace?.workspaceId !== 'string') continue;
    byPath.set(path.resolve(workspace.cwd), workspace);
    byPath.set(realOrResolved(workspace.cwd), workspace);
  }
  const objects = [];
  const seen = new Set();
  const trees = listWorktrees(cwd);
  const prunable = trees.filter((tree) => tree.prunable);
  if (prunable.length && !prunable.every((tree) => ownedBranch(tree.branch, change))) {
    const foreign = prunable.filter((tree) => !ownedBranch(tree.branch, change)).map((tree) => tree.path);
    console.warn(`[pipeline-run] not touching stale registrations owned by other changes: ${foreign.join(', ')}`);
  }
  for (const tree of trees) {
    if (!ownedBranch(tree.branch, change)) continue;
    const key = realOrResolved(tree.path);
    if (seen.has(key)) continue;
    seen.add(key);
    const workspace = ownedWorkspace(byPath, tree.path);
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
        id: tree.path,
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

const FIELD_LINE = /^\s*(Object|Command)\s*:(.*)$/;

/**
 * The literal value of one field line, or null when it is unparseable. Only whitespace around
 * the value is trimmed; backticks are removed only when they wrap the whole value. Everything
 * else stays byte-for-byte: no tokenizing, no punctuation stripping, no case folding.
 */
function literalValue(raw) {
  const value = raw.trim();
  if (!value) return null;
  if (value.startsWith('`') || value.endsWith('`')) {
    if (value.length < 2 || !value.startsWith('`') || !value.endsWith('`')) return null;
    return value.slice(1, -1) || null;
  }
  return value;
}

/**
 * Parse one block into its `Object:` and `Command:` values. Anything ambiguous is fail-closed:
 * a field line is matched by its prefix, so an empty, whitespace-only, backtick-only or
 * unmatched-backtick value is malformed rather than skipped, and any malformed field, a missing
 * field, or a duplicate `Object:`/`Command:` line makes the whole block authorize nothing.
 * @returns {{objects: string[], commands: string[]}}
 */
export function parseApprovalBlock(block) {
  const objects = [];
  const commands = [];
  let malformed = false;
  for (const line of String(block || '').split(/\r?\n/)) {
    const field = line.match(FIELD_LINE);
    if (!field) continue;
    const value = literalValue(field[2]);
    if (value === null) { malformed = true; continue; }
    if (field[1] === 'Object') objects.push(value);
    else commands.push(value);
  }
  if (malformed || objects.length !== 1 || commands.length !== 1) return { objects: [], commands: [] };
  return { objects, commands };
}

/**
 * A block covers an object only when it names exactly one object and one command, and both
 * equal this object's own values under `===`. There is no tokenizing or substring matching:
 * `integration/chg,` and `integration/chg` are different names, and one block authorizes one
 * object. A free-text block of the old shape has no `Object:`/`Command:` lines, so it matches
 * nothing.
 */
export function approvalCovers(block, object) {
  if (!block || !object?.command) return false;
  const { objects, commands } = parseApprovalBlock(block);
  if (objects.length !== 1 || commands.length !== 1) return false;
  // The id alone is the identity: workspace id, worktree path or branch name. Accepting any
  // alias would let a path or branch line authorize a Paseo archive.
  if (objects[0] !== object.id) return false;
  return commands[0] === object.command;
}

// ---- Re-entrancy records (worktree run-log; never committed) ----

function recordKey(kind, id) { return `${kind} ${id}`; }

/** Map of `kind id` -> recorded command (and tip SHA for branches) of every `done` attempt. */
export function doneRecords(text) {
  const done = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(RECORD);
    if (match && match[4] === 'done') done.set(recordKey(match[1], match[2]), { kind: match[1], id: match[2], command: match[3], sha: match[5] ?? null });
  }
  return done;
}

function readWorktreeRunLog(changeDir) {
  const file = path.join(changeDir, 'run-log.md');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

function appendRecord(changeDir, object, outcome, sha = null) {
  const file = path.join(changeDir, 'run-log.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `Cleanup: ${object.kind} ${object.id} ${object.command} ${outcome}${sha ? ` @${sha}` : ''}\n`);
}

function applyApprovalState(objects, blocks, done) {
  for (const object of objects) {
    if (object.status === 'already-done') continue;
    object.approved = blocks.some((block) => approvalCovers(block, object));
    object.status = done.has(recordKey(object.kind, object.id)) ? 'already-done' : object.approved ? 'planned' : 'unapproved';
  }
}

/** True when execution may not proceed: live objects exist and none of them is approved. */
function nothingApproved(objects) {
  return objects.some((object) => object.status !== 'already-done') && !objects.some((object) => object.approved);
}

// ---- Execution ----

function paseoArchive(object) {
  const result = spawnSync('paseo', ['workspace', 'archive', object.id], { encoding: 'utf8', timeout: 120_000 });
  if (result.error) return { status: 'failed', detail: result.error.message };
  if (result.status !== 0) return { status: 'failed', detail: (result.stderr || result.stdout || '').trim() || 'paseo workspace archive failed' };
  if (fs.existsSync(object.path)) return { status: 'failed', detail: `worktree still exists after archive: ${object.path}` };
  return { status: 'done', detail: '' };
}

/**
 * Execute one approved object. A branch already gone is done; a stale registration is removed
 * individually, and a missing Paseo workspace is still archived so its record does not linger.
 */
export function executeObject(object, { cwd = process.cwd() } = {}) {
  if (object.kind === 'branch') {
    const ref = `refs/heads/${object.branch}`;
    const tip = runGit(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    if (tip.status !== 0) return { status: 'done', detail: 'branch already gone', sha: null };
    const sha = tip.stdout.trim();
    const result = runGit(cwd, ['branch', '-d', object.branch]);
    if (result.status !== 0) return { status: 'failed', detail: (result.stderr || result.stdout || '').trim() || 'git branch -d refused' };
    // The recorded tip is what proves a later `--merged-at` is this change's merge.
    return { status: 'done', detail: '', sha };
  }
  // A stale registration is the normal case where its path is gone, and a missing Paseo
  // workspace still needs its archive record cleared.
  if (object.kind === 'paseo-workspace') return paseoArchive(object);
  if (object.kind === 'git-worktree') {
    if (!fs.existsSync(object.path) && !runGit(cwd, ['worktree', 'list', '--porcelain']).stdout.includes(`worktree ${object.path}\n`)) {
      return { status: 'done', detail: 'registration already gone' };
    }
    const result = runGit(cwd, ['worktree', 'remove', object.path]);
    if (result.status !== 0) return { status: 'failed', detail: (result.stderr || result.stdout || '').trim() || 'git worktree remove refused' };
    return { status: 'done', detail: '' };
  }
  return { status: 'failed', detail: `unknown object kind: ${object.kind}` };
}

/**
 * Every `--execute` precondition. Returns null when they all hold, or `{ code, message }`.
 * The pending-merge marker is the existing shared ref written by merge-task, read through
 * `readMergeState`; no new marker is invented.
 */
export function checkPreconditions({ cwd, changeDir, change, objects, base, mergedAt, done = new Map() }) {
  let markdown;
  let source;
  try { ({ markdown, source } = readTasksMarkdown(changeDir, change)); }
  catch (error) {
    // After `openspec archive` the directory lives under `archive/`, a path the integration
    // branch never had. The frozen contract still sits at its pre-archive location there,
    // which the operator-supplied change name reconstructs without guessing at the date prefix.
    // Unlike runCleanup's binding check, this only sees a directory already archived (a live
    // one was read above), and it must hold the same invariant: the basename is exactly
    // `<YYYY-MM-DD>-<change>`. Anything else would map one change's directory onto another's.
    if (changeDirShape(changeDir, change) !== 'archived') return { code: 4, message: `cannot read tasks.md: ${error.message}` };
    const preArchive = path.join(path.dirname(path.dirname(changeDir)), change);
    const top = runGit(cwd, ['rev-parse', '--show-toplevel']);
    if (top.status !== 0) return { code: 4, message: `cannot read tasks.md: ${error.message}` };
    // The pre-archive path itself is gone, so resolve its existing parent and rejoin the name;
    // that also settles the /var vs /private/var difference on macOS.
    const resolved = path.join(realOrResolved(path.dirname(preArchive)), path.basename(preArchive));
    const rel = path.relative(realOrResolved(top.stdout.trim()), resolved);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return { code: 4, message: `cannot read tasks.md: ${error.message}` };
    const shown = runGit(cwd, ['show', `refs/heads/integration/${change}:${rel.split(path.sep).join('/')}/tasks.md`]);
    if (shown.status !== 0) return { code: 4, message: `cannot read tasks.md: ${error.message}` };
    markdown = shown.stdout;
    source = 'integration';
  }
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
  // CP-2 must really have landed. An absent integration branch proves nothing on its own, so
  // `--merged-at` must equal the tip recorded when this command deleted the branch: any
  // ancestor would accept `main` itself or an unrelated commit. Without that record the merge
  // cannot be proven at all.
  if (runGit(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${integration}`]).status === 0) {
    if (runGit(cwd, ['merge-base', '--is-ancestor', integration, base]).status !== 0) {
      return { code: 4, message: `${integration} is not an ancestor of ${base}; CP-2 has not landed` };
    }
  } else {
    const recorded = done.get(recordKey('branch', integration))?.sha;
    if (!recorded) {
      return { code: 4, message: `${integration} is absent and no Cleanup record holds its tip; the merge cannot be proven — restore the branch or delete it through this command first` };
    }
    if (!mergedAt) {
      return { code: 4, message: `${integration} is absent; pass --merged-at <sha> with the recorded tip ${recorded} to prove CP-2 landed` };
    }
    const resolved = runGit(cwd, ['rev-parse', '--verify', '--quiet', `${mergedAt}^{commit}`]);
    if (resolved.status !== 0) return { code: 4, message: `--merged-at ${mergedAt} does not resolve` };
    if (resolved.stdout.trim() !== recorded) {
      return { code: 4, message: `--merged-at ${mergedAt} is not the recorded ${integration} tip ${recorded}` };
    }
    if (runGit(cwd, ['merge-base', '--is-ancestor', `${mergedAt}^{commit}`, base]).status !== 0) {
      return { code: 4, message: `--merged-at ${mergedAt} is not an ancestor of ${base}; CP-2 has not landed` };
    }
  }
  for (const object of objects) {
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
  try { parsed = parseOptions(argv, { 'dry-run': 'boolean', execute: 'boolean', json: 'boolean', base: 'value', 'merged-at': 'value', change: 'value' }); }
  catch (error) { stderr(`[pipeline-run] ${error.message}`); return 2; }
  if (parsed.positional.length !== 1) { stderr(`[pipeline-run] cleanup needs <change-dir>\n${USAGE}`); return 2; }
  if (parsed.options['dry-run'] && parsed.options.execute) { stderr('[pipeline-run] --dry-run and --execute are mutually exclusive'); return 2; }
  const changeDir = path.resolve(parsed.positional[0]);
  if (!fs.existsSync(path.join(changeDir, 'tasks.md'))) { stderr(`[pipeline-run] no tasks.md in ${changeDir}`); return 3; }
  let change = parsed.options.change;
  if (change !== undefined && !CHANGE_NAME.test(change)) {
    stderr(`[pipeline-run] --change ${change} is not a valid change name`);
    return 2;
  }
  // `openspec archive` moves the change to `openspec/changes/archive/<date>-<change>/`, so a
  // basename there is not the change name. Never strip that prefix: require the operator.
  if (change === undefined) {
    const archived = path.basename(path.dirname(changeDir)) === 'archive'
      && /^\d{4}-\d{2}-\d{2}-.+$/.test(path.basename(changeDir));
    if (archived) {
      stderr(`[pipeline-run] ${changeDir} looks archived; run cleanup before \`openspec archive\`, or pass --change <name>`);
      return 3;
    }
    change = path.basename(changeDir);
  }
  // A name that does not name this directory would plan one change's cleanup against another
  // change's approvals and branches. Accept only the two shapes the archive step can produce.
  if (!changeDirShape(changeDir, change)) {
    stderr(`[pipeline-run] --change ${change} does not name ${changeDir}; expected a live \`<change-dir>\` whose basename is \`${change}\`, or an archived \`<archive>/<YYYY-MM-DD>-${change}\`\n${USAGE}`);
    return 2;
  }
  const base = parsed.options.base ?? 'main';
  const execute = !!parsed.options.execute;
  const json = !!parsed.options.json;

  let objects;
  try { objects = discoverObjects({ cwd, changeDir, change }).objects; }
  catch (error) { stderr(`[pipeline-run] ${error.message}`); return error.code ?? 3; }

  const approvals = readApprovalText(cwd, changeDir, change);
  let blocks = parseApprovalBlocks(approvals.text);
  const done = doneRecords(readWorktreeRunLog(changeDir));
  applyApprovalState(objects, blocks, done);
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
    refusal = checkPreconditions({ cwd, changeDir, change, objects, base, mergedAt: parsed.options['merged-at'], done });
    if (refusal) {
      exit = refusal.code;
      stderr(`[pipeline-run] cleanup refused: ${refusal.message}`);
    } else if (nothingApproved(objects)) {
      exit = 5;
      refusal = { message: 'no object has a matching recorded Approval; nothing may be executed' };
      stderr(`[pipeline-run] cleanup refused: ${refusal.message}`);
    } else {
      // Approvals read from the integration branch exist only there, but the first run's own
      // `Cleanup:` records create the worktree file, which then becomes the primary source and
      // hides them. Seed it before executing so a retry sees the same approvals.
      if (approvals.source === 'integration') {
        try { fs.writeFileSync(path.join(changeDir, 'run-log.md'), approvals.text, { flag: 'wx' }); }
        catch (error) {
          if (error.code !== 'EEXIST') {
            stderr(`[pipeline-run] cannot seed the worktree run-log from integration: ${error.message}`);
            return 3;
          }
          const seeded = readApprovalText(cwd, changeDir, change);
          approvals.text = seeded.text;
          approvals.source = seeded.source;
          // The file that won the race is now the only source, and it may hold no approval at
          // all. Re-derive approval and re-entrancy state from it before executing anything:
          // the decisions above were made from the integration text that is no longer in force.
          blocks = parseApprovalBlocks(approvals.text);
          applyApprovalState(objects, blocks, doneRecords(approvals.text));
        }
      }
      // A reseeded file can leave everything unapproved; that is the same refusal as before
      // seeding, checked again against the text actually in force.
      if (nothingApproved(objects)) {
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
          appendRecord(changeDir, object, result.status, result.sha);
          if (result.status === 'failed' && exit !== 5) exit = 1;
        }
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
