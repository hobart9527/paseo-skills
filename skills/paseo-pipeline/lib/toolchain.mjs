// Distinguishing "the worktree has no dependencies" from "the test failed".
//
// A Paseo worktree is a git checkout, not a clone: `node_modules/`, `.venv/` and the
// rest of the ignored tree stay behind in the main checkout. A frozen Verify run there
// therefore dies before any test executes, and `merge-task` used to report that as a
// failing test — blaming the task for an environment fault, with no hint about the fix.
//
// The classifier is deliberately narrow. It only fires when the output names a module
// that is not a path (`tsx`, `pytest`) or a bare command that is not found. A relative
// import (`Cannot find module './missing.js'`) is the task's own bug and stays a test
// failure.

import fs from 'node:fs';
import path from 'node:path';

// `node --import tsx` → "Cannot find package 'tsx'"; `python -m pytest` → "No module
// named 'pytest'". `ERR_MODULE_NOT_FOUND` alone is ambiguous (it also covers relative
// paths), so the quoted name is required.
const MISSING_MODULE = /Cannot find (?:package|module) ['"]([^'"]+)['"]|No module named ['"]?([\w.]+)['"]?/i;
// Real shells word this differently:
//   dash   `sh: 1: tsx: not found`
//   bash   `run.sh: line 2: tsx: command not found`
//   zsh    `zsh:1: command not found: vitest`
// zsh puts the name after the message, the others before it; the "before" form also
// has line-number segments, so a pure number is never the command.
const MISSING_COMMAND_AFTER = /command not found: ([\w@/.-]+)/i;
const MISSING_COMMAND_BEFORE = /([\w@/.-]+): (?:command )?not found/i;
// A Verify that calls a dependency-local binary fails differently:
//   `sh: node_modules/.bin/vitest: No such file or directory`
//   `zsh: no such file or directory: ./node_modules/.bin/vitest`
//   `sh: .venv/bin/python: No such file or directory`
// The path itself is fine; the directory that holds it was never installed. Only
// dependency directories qualify — `./scripts/check.sh` missing is the task's problem.
const MISSING_FILE_BEFORE = /([\w@./-]+): No such file or directory/i;
const MISSING_FILE_AFTER = /no such file or directory: ([\w@./-]+)/i;
const DEPENDENCY_DIR = /(?:^|\/)(?:node_modules|\.venv|venv|\.tox|\.bun|vendor\/bundle)(?:\/|$)/i;

/**
 * The dependency a failed Verify could not resolve, or null when the failure is not
 * an environment fault.
 * @param {string} output
 * @returns {string|null}
 */
export function missingDependency(output, cwd = process.cwd()) {
  const text = String(output || '');
  const mod = text.match(MISSING_MODULE);
  if (mod) {
    const name = mod[1] || mod[2];
    // A relative/absolute path is a missing file in the task, not a missing toolchain.
    // A scoped package (`@scope/pkg`) is a real dependency name and stays.
    const isPath = /^[./]/.test(name) && !name.startsWith('@');
    if (name && !isPath && !isFirstParty(name, cwd)) return name;
    return null;
  }
  const after = text.match(MISSING_COMMAND_AFTER);
  if (after) return after[1].includes('/') ? null : after[1];
  const before = text.match(MISSING_COMMAND_BEFORE);
  // A bare tool name is the missing runner; a path is a bad Verify command, and a
  // line-number segment is not a command.
  if (before && !before[1].includes('/') && !/^\d+$/.test(before[1])) return before[1];
  // `zsh: no such file or directory: ./node_modules/.bin/vitest`
  const afterFile = text.match(MISSING_FILE_AFTER)?.[1];
  if (afterFile && DEPENDENCY_DIR.test(afterFile)) return dependencyDir(afterFile);
  // `sh: node_modules/.bin/vitest: No such file or directory`
  return dependencyDir(text.match(MISSING_FILE_BEFORE)?.[1]);
}

// The canonical TDD Red is a test importing code that does not exist yet
// (`No module named 'app.feature'`). That module is the task's own work, not a missing
// install, and must stay a Red-proof failure. A name whose top-level segment already
// exists in the repository is first-party.
const SOURCE_ROOTS = ['', 'src', 'lib', 'app'];
const SOURCE_EXT = ['', '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx'];
function isFirstParty(name, cwd) {
  if (name.startsWith('@')) return false;
  const top = name.split('.')[0];
  return SOURCE_ROOTS.some((root) => SOURCE_EXT.some((ext) => fs.existsSync(path.join(cwd, root, top + ext))));
}

/** The dependency directory a path lives under, or null when it is not a dependency path. */
function dependencyDir(file) {
  if (!file || !DEPENDENCY_DIR.test(file)) return null;
  return file.match(DEPENDENCY_DIR)[0].replace(/\/$/, '').replace(/^\//, '');
}

const BOOTSTRAP = {
  npm: 'npm ci',
  pnpm: 'pnpm install --frozen-lockfile',
  yarn: 'yarn install --immutable',
  bun: 'bun install --frozen-lockfile',
  python: 'python3 -m venv .venv && .venv/bin/pip install -r requirements.txt && export PATH="$PWD/.venv/bin:$PATH"',
  go: 'go mod download',
  cargo: 'cargo fetch',
};

/** The install command this repository appears to use, judged from lockfiles/manifests. */
export function dependencyHint(cwd = process.cwd()) {
  const has = (file) => fs.existsSync(path.join(cwd, file));
  if (has('pnpm-lock.yaml')) return BOOTSTRAP.pnpm;
  if (has('yarn.lock')) return BOOTSTRAP.yarn;
  if (has('bun.lockb') || has('bun.lock')) return BOOTSTRAP.bun;
  if (has('package-lock.json') || has('package.json')) return BOOTSTRAP.npm;
  if (has('pyproject.toml') || has('requirements.txt')) return BOOTSTRAP.python;
  if (has('go.mod')) return BOOTSTRAP.go;
  if (has('Cargo.toml')) return BOOTSTRAP.cargo;
  return "the repository's documented install command";
}

/**
 * Full operator-facing explanation for exit 36.
 * @param {string} name
 * @param {string} [cwd]
 */
export function dependencyMessage(name, cwd) {
  return [
    `cannot resolve "${name}"; this worktree has no installed dependencies.`,
    'This is an environment fault, not a test failure: a linked worktree does not inherit node_modules/.venv from the main checkout.',
    `Install once in this worktree: ${dependencyHint(cwd)} — or configure a Paseo workspace script so new worktrees bootstrap automatically.`,
    'Do not edit tests or the frozen Verify to work around it.',
  ].join(' ');
}
