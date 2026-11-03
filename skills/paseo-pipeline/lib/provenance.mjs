// Cherry-pick provenance: a hand-recreated commit has the same patch as the commit it copies but
// a fresh author, so `merge-task` compares patch-ids. This module owns that lookup; the caller owns
// the trailers and the exit code.
import { runGit } from './git.mjs';

// git log -p over the touched paths is buffered whole. Above this the scan is refused rather than
// silently skipped: an unverified commit must not merge.
export const PATCH_LOG_LIMIT = 256 * 1024 * 1024;

export function patchIdOf(commit, { git = runGit, cwd = undefined } = {}) {
  const shown = git(cwd, ['show', '--no-color', '--format=commit %H', commit]);
  if (shown.status !== 0) return null;
  const result = git(cwd, ['patch-id', '--stable'], { input: shown.stdout });
  if (result.status !== 0) return null;
  return String(result.stdout || '').trim().split(/\r?\n/)[0]?.split(/\s+/)[0] || null;
}

/**
 * Commits that share `commit`'s patch-id, excluding itself. Two commits with the same patch-id
 * necessarily touch the same paths, so the path-filtered log is exact and its size follows the
 * file's history instead of the repository's.
 *
 * Returns `null` when the scan cannot be trusted (git error, missing patch-id, or the log exceeds
 * `limit` bytes); callers must treat null as "unknown" and refuse the merge.
 */
export function samePatchCommits(commit, { git = runGit, cwd = undefined, limit = PATCH_LOG_LIMIT } = {}) {
  const files = git(cwd, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', commit]);
  if (files.status !== 0) return null;
  const paths = String(files.stdout || '').split('\0').filter(Boolean);
  if (!paths.length) return [];
  const target = patchIdOf(commit, { git, cwd });
  if (!target) return null;
  const log = git(cwd, ['log', '--all', '--no-merges', '--no-color', '-p', '--', ...paths], { maxBuffer: limit });
  if (log.error || log.status !== 0) return null;
  if (Buffer.byteLength(log.stdout || '') >= limit) return null;
  const ids = git(cwd, ['patch-id', '--stable'], { input: log.stdout, maxBuffer: limit });
  if (ids.error || ids.status !== 0) return null;
  const out = [];
  for (const line of String(ids.stdout || '').split(/\r?\n/)) {
    const match = line.trim().match(/^([0-9a-f]{7,64})\s+([0-9a-f]{7,64})$/);
    if (match && match[1] === target && match[2] !== commit) out.push(match[2]);
  }
  return out;
}
