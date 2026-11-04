// Shared Git refs survive process restarts and are visible to every linked worktree.
import { runGit } from './git.mjs';

function checked(cwd, args, options) {
  const result = runGit(cwd, args, options);
  if (result.error || result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr || result.error?.message || 'failed'}`);
  return result.stdout.trim();
}
function ref(change, task) { return `refs/pipeline/merge-failures/${change}/${task}`; }
export function readMergeState(cwd, change, task) {
  const name = ref(change, task);
  const result = runGit(cwd, ['show-ref', '--verify', '--quiet', name]);
  if (result.status === 1) return null;
  if (result.status !== 0 || result.error) throw new Error(`cannot read ${name}`);
  const value = JSON.parse(checked(cwd, ['cat-file', 'blob', name]));
  if (!value || typeof value.tip !== 'string' || !/^[0-9a-f]{40,64}$/.test(value.tip) || !['pending', 'failed'].includes(value.status)) throw new Error(`invalid ${name}`);
  return value;
}
export function writeMergeState(cwd, change, task, value) {
  const blob = checked(cwd, ['hash-object', '-w', '--stdin'], { input: JSON.stringify(value) });
  checked(cwd, ['update-ref', ref(change, task), blob]);
}
export function clearMergeState(cwd, change, task) {
  checked(cwd, ['update-ref', '-d', ref(change, task)]);
}
