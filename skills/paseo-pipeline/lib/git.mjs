// One git invocation, no policy. Every script used to wrap `spawnSync('git', ...)` itself with
// the same options object and a different failure convention; this keeps the invocation here and
// leaves the convention where it belongs — with the script that knows its exit codes.
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
