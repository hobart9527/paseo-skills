// Read-only cleanup listing for a finished change.
//
// Discovery is deterministic and read-only: it lists the Paseo workspaces, Git worktrees and
// branches this change owns, with the exact command a human would run by hand. Nothing here
// executes anything, so there is no approval gate to get wrong: the operator reads the list,
// obtains approval for each object, and runs the commands themselves. Objects that look unsafe
// to delete — a dirty worktree, a branch not merged into the base — are annotated so that
// decision is made with the facts in view.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseOptions } from './cli.mjs';
import { runGit } from './git.mjs';
import { parseTasks } from './tasks.mjs';
import { readTasksMarkdown } from './tasks-source.mjs';
import { readMergeState } from './merge-state.mjs';

const USAGE = 'usage: pipeline-run.mjs cleanup <change-dir> [--json] [--base <ref>] [--change <name>]';
const CHANGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TASK_ID = String.raw`[A-Za-z][A-Za-z0-9]*-\d+`;

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
 * naming one change list another change's objects.
 * @returns {'live'|'archived'|null}
 */
function changeDirShape(changeDir, change) {
  // The parent decides, never the basename alone: inside `archive/`, a dated basename is a
  // directory name and never a change name, even when some later change is literally named
  // `2026-11-08-chg`.
  if (path.basename(path.dirname(changeDir)) === 'archive') {
    return new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${escapeRe(change)}$`).test(path.basename(changeDir)) ? 'archived' : null;
  }
  return path.basename(changeDir) === change ? 'live' : null;
}

/**
 * Repository identity for a directory: its realpath-normalized common Git directory, or null.
 * `--git-common-dir` is shared by every worktree of one repository and differs for every other
 * repository. A nested repository or submodule is a different repository even though its path
 * lies inside another one's toplevel, which is why path containment cannot answer this.
 */
function repoIdentity(dir) {
  const absolute = runGit(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!absolute.error && absolute.status === 0 && absolute.stdout.trim()) {
    return realOrResolved(absolute.stdout.trim());
  }
  // Older Git has no `--path-format` and prints the common dir relative to `dir`.
  const relative = runGit(dir, ['rev-parse', '--git-common-dir']);
  if (relative.error || relative.status !== 0 || !relative.stdout.trim()) return null;
  const value = relative.stdout.trim();
  return realOrResolved(path.isAbsolute(value) ? value : path.join(dir, value));
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
// owning workspace would make its worktree look manual — then the listing would suggest
// `git worktree remove` on a Paseo-owned path instead of `paseo workspace archive`.
function listPaseoWorkspaces() {
  const result = spawnSync('paseo', ['workspace', 'ls', '--background', '--json'], { encoding: 'utf8', timeout: 10_000 });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || (result.stderr || '').trim();
    return { error: `cannot read Paseo workspaces (\`paseo workspace ls --background --json\`${detail ? `: ${detail}` : ''})` };
  }
  let listed;
  try { listed = JSON.parse(result.stdout); } catch { return { error: 'invalid JSON from `paseo workspace ls --background --json`' }; }
  if (!Array.isArray(listed)) { return { error: 'invalid Paseo workspace list' }; }
  return { workspaces: listed };
}

/**
 * Read-only deterministic discovery. Returns worktree objects first (in `git worktree list`
 * order), then branch objects. A worktree owned by a Paseo workspace yields exactly one
 * `paseo-workspace` object and never an extra `git-worktree` object for the same path.
 *
 * A stale registration (path gone) is an ordinary `git-worktree` object: `git worktree remove
 * <path>` clears just that registration without force. A registration owned by another change
 * is never offered.
 */
export function discoverObjects({ cwd, change }) {
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
    console.warn(`[pipeline-run] not listing stale registrations owned by other changes: ${foreign.join(', ')}`);
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

/**
 * Annotate each object with what a human needs before deleting it. This is reported status,
 * never a gate: a dirty worktree or an unmerged branch is still listed, with the fact attached.
 * `git branch -d` refuses an unmerged branch, so `mergedIntoBase: false` warns that the printed
 * command will refuse rather than delete.
 */
function annotate(objects, { cwd, base }) {
  for (const object of objects) {
    if (object.kind === 'branch') {
      const tip = runGit(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${object.branch}^{commit}`]);
      if (tip.status === 0) object.tip = tip.stdout.trim();
      object.mergedIntoBase = runGit(cwd, ['merge-base', '--is-ancestor', object.branch, base]).status === 0;
      continue;
    }
    if (!object.path) continue;
    if (!fs.existsSync(object.path)) { object.stale = true; continue; }
    const status = runGit(object.path, ['status', '--porcelain']);
    if (status.error || status.status !== 0) { object.unreadable = true; continue; }
    object.dirty = status.stdout.trim() !== '';
  }
}

/**
 * Task state for the report: which tasks are not Done. The integration copy is authoritative
 * while it exists; after `openspec archive` it no longer holds this path, so fall back to the
 * directory's own copy. Either way this is information, not a precondition.
 */
function taskStatus(changeDir, change) {
  let markdown;
  let source;
  try { ({ markdown, source } = readTasksMarkdown(changeDir, change)); }
  catch (error) {
    const file = path.join(changeDir, 'tasks.md');
    if (!fs.existsSync(file)) return { source: null, ids: [], open: [], errors: [error.message] };
    markdown = fs.readFileSync(file, 'utf8');
    source = 'change-dir';
  }
  const { tasks, errors } = parseTasks(markdown);
  return {
    source,
    ids: tasks.map((task) => task.id),
    open: tasks.filter((task) => !task.done).map((task) => task.id),
    errors: errors.map((error) => `${error.code}${error.task ? ` ${error.task}` : ''}: ${error.message}`),
  };
}

/** Pending merge markers for this change's tasks: inactive refs that block a fresh merge. */
function pendingMerges(cwd, change, taskIds) {
  const pending = [];
  for (const task of taskIds) {
    try {
      const state = readMergeState(cwd, change, task);
      if (state?.status === 'pending') pending.push({ task, tip: state.tip });
    } catch { /* an unreadable marker is reported as absent; nothing acts on it here */ }
  }
  return pending;
}

function shape(object) {
  return {
    kind: object.kind,
    id: object.id,
    branch: object.branch,
    path: object.path,
    command: object.command,
    ...(object.tip ? { tip: object.tip } : {}),
    ...(object.stale ? { stale: true } : {}),
    ...(object.dirty ? { dirty: true } : {}),
    ...(object.unreadable ? { unreadable: true } : {}),
    ...(object.mergedIntoBase === undefined ? {} : { mergedIntoBase: object.mergedIntoBase }),
  };
}

/** Human-readable annotations, appended to one listed object in text output. */
function notes(object) {
  const list = [];
  if (object.stale) list.push('directory is gone');
  if (object.dirty) list.push('worktree has uncommitted changes; removal will refuse');
  if (object.unreadable) list.push('cannot read worktree status');
  if (object.mergedIntoBase === false) list.push('not merged into base; branch -d will refuse');
  return list.length ? ` (${list.join('; ')})` : '';
}

/**
 * CLI entry point. Always read-only: lists what this change owns with the command a human
 * would run for each object, and exits without touching anything.
 * Exit: 0 listed; 2 usage; 3 unreadable state.
 */
export function runCleanup(argv, { cwd = process.cwd(), stdout = (line) => console.log(line), stderr = (line) => console.error(line) } = {}) {
  let parsed;
  try { parsed = parseOptions(argv, { json: 'boolean', base: 'value', change: 'value' }); }
  catch (error) { stderr(`[pipeline-run] ${error.message}`); return 2; }
  if (parsed.positional.length !== 1) { stderr(`[pipeline-run] cleanup needs <change-dir>\n${USAGE}`); return 2; }
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
  // A name that does not name this directory would list one change's objects under another
  // change's identity. Accept only the two shapes the archive step can produce.
  if (!changeDirShape(changeDir, change)) {
    stderr(`[pipeline-run] --change ${change} does not name ${changeDir}; expected a live \`<change-dir>\` whose basename is \`${change}\`, or an archived \`<archive>/<YYYY-MM-DD>-${change}\`\n${USAGE}`);
    return 2;
  }
  // The shape check only compares basenames, so it cannot tell two repositories' `chg`
  // directories apart. Identity, not path containment: a nested repository or submodule sits
  // inside this repository's toplevel yet has its own common Git directory, so a containment
  // check passes it and would list the nested checkout's objects as this repository's — and
  // vice versa. Equality of the common directory is the question that distinguishes them.
  const acting = repoIdentity(cwd);
  if (!acting) { stderr(`[pipeline-run] cannot determine the repository ${cwd} acts on`); return 3; }
  const target = repoIdentity(changeDir);
  if (!target) { stderr(`[pipeline-run] cannot determine the repository for ${changeDir}`); return 3; }
  if (target !== acting) {
    stderr(`[pipeline-run] ${changeDir} (${target}) belongs to a different repository than the one this command acts on, ${cwd} (${acting}); run cleanup from that repository's checkout`);
    return 2;
  }
  const base = parsed.options.base ?? 'main';
  const json = !!parsed.options.json;
  if (runGit(cwd, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]).status !== 0) {
    stderr(`[pipeline-run] base ${base} does not resolve`);
    return 3;
  }

  let objects;
  try { objects = discoverObjects({ cwd, change }).objects; }
  catch (error) { stderr(`[pipeline-run] ${error.message}`); return error.code ?? 3; }

  annotate(objects, { cwd, base });
  const tasks = taskStatus(changeDir, change);
  const pending = pendingMerges(cwd, change, tasks.ids);

  if (json) {
    stdout(JSON.stringify({
      change,
      base,
      repository: acting,
      tasks: { source: tasks.source, open: tasks.open, errors: tasks.errors },
      pendingMerges: pending,
      objects: objects.map(shape),
      exit: 0,
    }, null, 2));
  } else {
    stdout(`${change} (base ${base}, repository ${acting})`);
    stdout(`tasks: ${tasks.source ?? 'unreadable'}${tasks.open.length ? `, open: ${tasks.open.join(', ')}` : ', all Done'}`);
    if (tasks.errors.length) stdout(`tasks errors: ${tasks.errors.join('; ')}`);
    for (const marker of pending) stdout(`pending merge marker: ${marker.task} @ ${marker.tip}`);
    for (const object of objects) {
      const location = object.path ? ` ${object.path}` : '';
      const tip = object.tip ? ` (tip ${object.tip})` : '';
      stdout(`[${object.kind}] ${object.id}${location} -> ${object.command}${tip}${notes(object)}`);
    }
    stdout('read-only: nothing was executed; obtain approval and run each command by hand');
  }
  return 0;
}
