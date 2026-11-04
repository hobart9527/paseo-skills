// Task state lives on the integration branch. `merge-task` writes Done lines there; the
// default branch keeps the frozen contract. Reading the local copy after the first merge
// makes a Done task look unstarted, so `plan` re-dispatches it and its consumers wait
// forever. One reader, used by both `plan` and `status`.
import fs from 'node:fs';
import path from 'node:path';
import { runGit } from './git.mjs';

function diskCopy(changeDir) {
  const file = path.join(changeDir, 'tasks.md');
  if (!fs.existsSync(file)) throw new Error(`no tasks.md in ${changeDir}`);
  return { markdown: fs.readFileSync(file, 'utf8'), source: 'worktree' };
}

/**
 * Read the authoritative tasks.md for a change.
 * @returns {{markdown: string, source: 'integration'|'worktree'}}
 * Throws when the integration branch exists but cannot supply the file: that is unreadable
 * state, not an empty DAG, and guessing would dispatch duplicates.
 */
export function readTasksMarkdown(changeDir, change) {
  const top = runGit(changeDir, ['rev-parse', '--show-toplevel']);
  if (top.error || top.status !== 0) return diskCopy(changeDir);
  const root = top.stdout.trim();
  const ref = `refs/heads/integration/${change}`;
  const resolved = runGit(changeDir, ['rev-parse', '--verify', '--quiet', ref]);
  if (resolved.status === 1) return diskCopy(changeDir);
  if (resolved.status !== 0 || resolved.error) throw new Error(`cannot resolve ${ref}`);
  // macOS reports /private/var for a repo opened through the /var symlink; compare real paths.
  let realDir;
  try { realDir = fs.realpathSync(path.resolve(changeDir)); } catch { realDir = path.resolve(changeDir); }
  const rel = path.relative(root, realDir);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`${changeDir} is outside repository ${root}; cannot locate its tasks.md on ${ref}`);
  }
  const spec = `${ref}:${rel.split(path.sep).join('/')}/tasks.md`;
  const shown = runGit(changeDir, ['show', spec]);
  if (shown.status !== 0) {
    throw new Error(`${ref} has no ${rel}/tasks.md; commit the frozen contract to integration/${change} before planning`);
  }
  return { markdown: shown.stdout, source: 'integration' };
}
