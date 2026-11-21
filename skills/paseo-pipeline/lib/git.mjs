// Shared Git helpers: single invocation wrapper + NUL-delimited worktree discovery.
import { spawnSync } from 'node:child_process';

/**
 * Run git and return the raw result (`status`, `stdout`, `stderr`, `error`).
 * `cwd` may be undefined to inherit the current directory.
 */
export function runGit(cwd, args, { input, maxBuffer, encoding = 'utf8' } = {}) {
  return spawnSync('git', args, { cwd, encoding, ...(input === undefined ? {} : { input }), ...(maxBuffer === undefined ? {} : { maxBuffer }) });
}

/** Trimmed stdout on success, `null` on any failure. For read-only probes. */
export function gitMaybe(cwd, args) {
  const result = runGit(cwd, args);
  return result.status === 0 ? result.stdout.trim() : null;
}

/**
 * Parse `git worktree list --porcelain -z` into `{ path, branch, prunable }` records.
 * Uses NUL-delimited records so worktree paths containing spaces or newlines never truncate.
 */
export function listWorktrees(cwd) {
  const result = runGit(cwd, ['worktree', 'list', '--porcelain', '-z']);
  if (result.error || result.status !== 0) {
    throw new Error(`git worktree list failed: ${(result.stderr || result.error?.message || '').trim()}`);
  }
  const trees = [];
  let current = null;
  for (const field of result.stdout.split('\0')) {
    if (field === '') { current = null; continue; }
    if (field.startsWith('worktree ')) {
      current = { path: field.slice('worktree '.length), branch: null, prunable: false };
      trees.push(current);
    } else if (current && field.startsWith('branch ')) {
      current.branch = field.slice('branch '.length).replace(/^refs\/heads\//, '');
    } else if (current && (field === 'prunable' || field.startsWith('prunable '))) {
      current.prunable = true;
    }
  }
  return trees;
}

export function listWorktreesMaybe(cwd) {
  try { return listWorktrees(cwd); } catch { return []; }
}

export function worktreeForBranch(cwd, branch) {
  return listWorktreesMaybe(cwd).find((tree) => tree.branch === branch)?.path ?? null;
}
