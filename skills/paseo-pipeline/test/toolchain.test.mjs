import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { missingDependency, dependencyHint, dependencyMessage } from '../lib/toolchain.mjs';

// Recorded real output, not invented: each line below was produced by running the
// corresponding command on this machine (node 26, sh/bash/zsh, python3).
const MESSAGES = [
  ["Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'tsx' imported from /private/tmp/x/", 'tsx'],
  ["ModuleNotFoundError: No module named 'pytest'", 'pytest'],
  ['run.sh: line 2: tsx: command not found', 'tsx'],
  ['zsh:1: command not found: vitest', 'vitest'],
  ['sh: 1: go: not found', 'go'],
  ['sh: node_modules/.bin/vitest: No such file or directory', 'node_modules'],
  ['zsh: no such file or directory: ./node_modules/.bin/vitest', 'node_modules'],
  ['sh: .venv/bin/python: No such file or directory', '.venv'],
];

test('missingDependency: names the uninstalled tool the worktree could not find', () => {
  for (const [output, expected] of MESSAGES) assert.equal(missingDependency(output), expected, output);
  assert.equal(missingDependency("Cannot find package '@scope/pkg'"), '@scope/pkg');
});

test('missingDependency: a missing file or a real failure is not an environment fault', () => {
  for (const output of [
    "Error: Cannot find module './missing.js'", // task's own broken import
    "Error: Cannot find module '/abs/path.js'",
    'sh: 1: ./scripts/check.sh: not found', // bad Verify command, not a toolchain
    'sh: ./scripts/check.sh: No such file or directory', // missing task file, not deps
    'AssertionError: expected 1 to equal 2',
    'error: failed to run custom build command',
    '',
  ]) assert.equal(missingDependency(output), null, output);
});

test('missingDependency: a Red test importing code the task has yet to write is not a missing install', () => {
  const repo = fakeRepo(['app']); // the package exists, the submodule does not
  assert.equal(missingDependency("ModuleNotFoundError: No module named 'app.feature'", repo), null);
  assert.equal(missingDependency("Cannot find package 'app' imported from /x/test/a.test.mjs", repo), null);
  assert.equal(missingDependency("ModuleNotFoundError: No module named 'pytest'", repo), 'pytest');
});

function fakeRepo(files) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'toolchain-'));
  for (const file of files) fs.writeFileSync(path.join(cwd, file), '');
  return cwd;
}

test('dependencyHint: reads the repository lockfile, most specific first', () => {
  assert.equal(dependencyHint(fakeRepo(['package.json', 'package-lock.json'])), 'npm ci');
  assert.equal(dependencyHint(fakeRepo(['package.json', 'pnpm-lock.yaml'])), 'pnpm install --frozen-lockfile');
  assert.equal(dependencyHint(fakeRepo(['package.json', 'yarn.lock'])), 'yarn install --immutable');
  assert.equal(dependencyHint(fakeRepo(['package.json', 'bun.lockb'])), 'bun install --frozen-lockfile');
  assert.match(dependencyHint(fakeRepo(['requirements.txt'])), /venv/);
  assert.equal(dependencyHint(fakeRepo(['go.mod'])), 'go mod download');
  assert.equal(dependencyHint(fakeRepo(['Cargo.toml'])), 'cargo fetch');
  assert.match(dependencyHint(fakeRepo([])), /documented install command/);
});

test('dependencyMessage: states the cause, the fix, and the prohibition', () => {
  const message = dependencyMessage('tsx', fakeRepo(['package-lock.json']));
  assert.match(message, /tsx/);
  assert.match(message, /not a test failure/);
  assert.match(message, /npm ci/);
  assert.match(message, /workspace script/);
  assert.match(message, /Do not edit tests/);
});
