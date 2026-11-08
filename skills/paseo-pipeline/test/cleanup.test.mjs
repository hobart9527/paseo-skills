import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeMergeState } from '../lib/merge-state.mjs';

const script = fileURLToPath(new URL('../pipeline-run.mjs', import.meta.url));
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
};
delete env.NODE_TEST_CONTEXT;

const CHANGE = 'chg';

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${args.join(' ')}\n${r.stderr}`);
  return r.stdout.trim();
}
function write(cwd, file, text) {
  const p = path.join(cwd, file);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

// A fake `paseo` so discovery never touches the real daemon. `workspace ls` returns the
// fixture list; nothing in this command archives, so the shim implements only `ls`.
const FAKE_PASEO = `#!/usr/bin/env node
const fs = require('node:fs');
const cfg = JSON.parse(fs.readFileSync(process.env.FAKE_PASEO_CFG, 'utf8'));
const [a, b] = process.argv.slice(2);
if (a === 'workspace' && b === 'ls') { process.stdout.write(JSON.stringify(cfg.workspaces)); process.exit(0); }
if (a === 'workspace' && b === 'archive') {
  // Records the argument it received and removes the workspace from later listings, the way
  // the real archive does. It archives one id and nothing else.
  fs.appendFileSync(cfg.archived, JSON.stringify(process.argv.slice(3)) + '\\n');
  process.exit(0);
}
if (a === 'workspace' && b === 'unarchive') process.exit(0);
process.exit(1);
`;

function fakePaseo(dir, root, workspaces = []) {
  const bin = path.join(dir, '.fake-bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'paseo'), FAKE_PASEO);
  fs.chmodSync(path.join(bin, 'paseo'), 0o755);
  const cfg = path.join(dir, '.fake-paseo.json');
  fs.writeFileSync(cfg, JSON.stringify({ root, workspaces, archived: path.join(dir, '.fake-paseo-archived') }));
  return { ...env, PATH: `${bin}:${process.env.PATH}`, FAKE_PASEO_CFG: cfg };
}

const TASKS_DONE = `- [x] 1.1 T-01 task\n  - Write scope: src,test\n  - Verify with: node --test test/a.test.mjs\n  - Done: source=abcdef1 review=worker\n`
  + `- [x] 1.2 T-02 task\n  - Write scope: src/b,test/b\n  - Verify with: node --test test/b.test.mjs\n  - Done: source=abcdef2 review=worker\n`;
const TASKS_OPEN = `- [x] 1.1 T-01 task\n  - Write scope: src,test\n  - Verify with: node --test test/a.test.mjs\n  - Done: source=abcdef1 review=worker\n`
  + `- [ ] 1.2 T-02 task\n  - Write scope: src/b,test/b\n  - Verify with: node --test test/b.test.mjs\n`;

/**
 * root stays on `main`; integration/chg is only a branch (plus its task worktrees), so the
 * main checkout is never itself a cleanup object. `integrated: true` fast-forwards main to
 * integration, which is what CP-2 landing looks like.
 */
function fixture({ tasks = TASKS_DONE, integrated = true, paseoWorkspaceFor = null, background = false, staleFor = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-'));
  const changeDir = path.join(root, 'openspec', 'changes', CHANGE);
  write(root, `openspec/changes/${CHANGE}/proposal.md`, 'p\n');
  write(root, `openspec/changes/${CHANGE}/acceptance.md`, 'a\n');
  write(root, `openspec/changes/${CHANGE}/tasks.md`, tasks);
  write(root, `openspec/changes/${CHANGE}/run-log.md`, '# log\n');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'contract');
  const contract = git(root, 'rev-parse', 'HEAD');
  git(root, 'branch', 'other', contract);
  git(root, 'switch', '-qc', `integration/${CHANGE}`);
  git(root, 'commit', '-q', '--allow-empty', '-m', 'integration tip');
  const integrationTip = git(root, 'rev-parse', 'HEAD');
  const worktrees = {};
  // git prints real paths (/private/var on macOS); objects use exactly what git prints.
  const registeredPath = (dir) => spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { env, encoding: 'utf8' }).stdout.trim();
  for (const id of ['T-01', 'T-02']) {
    const dir = path.join(root, '..', `${path.basename(root)}-${id}`);
    git(root, 'worktree', 'add', '-q', '-b', `task/${CHANGE}/${id}`, dir, integrationTip);
    worktrees[id] = registeredPath(dir);
  }
  for (const id of [staleFor].flat().filter(Boolean)) {
    // A registration whose directory is gone: stale, and only this change owns it.
    const dir = path.join(root, '..', `${path.basename(root)}-${id}`);
    git(root, 'worktree', 'add', '-q', '-b', `task/${CHANGE}/${id}`, dir, integrationTip);
    worktrees[id] = registeredPath(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  git(root, 'switch', '-q', 'main');
  if (integrated) git(root, 'merge', '-q', '--ff-only', `integration/${CHANGE}`);
  const workspaces = [];
  if (paseoWorkspaceFor) {
    // Paseo reports the path it created; matching is literal, so use the path git prints for
    // the registration. A removed directory can only be matched by that literal string.
    workspaces.push({ workspaceId: `wks_${paseoWorkspaceFor.toLowerCase().replace('-', '')}`, isolation: 'worktree', background, cwd: worktrees[paseoWorkspaceFor] });
  }
  return { root, changeDir, worktrees, integrationTip, integrated, localEnv: fakePaseo(root, root, workspaces) };
}

function run(f, args) {
  const r = spawnSync('node', [script, ...args], { cwd: f.root, env: f.localEnv, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, out: `${r.stdout}${r.stderr}` };
}

const cleanup = (f, ...flags) => run(f, ['cleanup', f.changeDir, ...flags]);

/** True when git still has a registration for `targetPath`. */
function registered(f, targetPath) {
  return git(f.root, 'worktree', 'list', '--porcelain').split('\n').includes(`worktree ${targetPath}`);
}

function discover(f) {
  const r = cleanup(f, '--json');
  assert.equal(r.status, 0, r.out);
  return JSON.parse(r.stdout);
}

test('cleanup lists objects read-only and touches nothing', () => {
  const f = fixture();
  const listing = cleanup(f);
  assert.equal(listing.status, 0, listing.out);
  assert.match(listing.stdout, new RegExp(`\\[git-worktree\\] ${f.worktrees['T-01'].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(listing.stdout, new RegExp(`\\[git-worktree\\] ${f.worktrees['T-02'].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(listing.stdout, /\[branch\] integration\/chg -> git branch -d integration\/chg/);
  assert.match(listing.stdout, /read-only: nothing was executed/);
  // Listing never touches anything.
  for (const id of ['T-01', 'T-02']) assert.ok(fs.existsSync(f.worktrees[id]), id);
  assert.ok(git(f.root, 'rev-parse', '--verify', 'refs/heads/integration/chg'));
});

test('cleanup rejects unknown flags with exit 2', () => {
  const f = fixture();
  assert.equal(cleanup(f, '--bogus').status, 2);
  assert.equal(run(f, ['cleanup']).status, 2);
});

test('the JSON listing has the documented shape', () => {
  const f = fixture();
  const report = discover(f);
  assert.equal(report.change, CHANGE);
  assert.equal(report.base, 'main');
  assert.ok(path.isAbsolute(report.repository));
  assert.deepEqual(report.tasks.open, []);
  assert.deepEqual(report.pendingMerges, []);
  assert.equal(report.exit, 0);
  const kinds = report.objects.map((object) => object.kind);
  assert.deepEqual(kinds.slice(-3), ['branch', 'branch', 'branch']);
  for (const object of report.objects) {
    assert.ok(typeof object.id === 'string' && object.id);
    assert.ok(/^(paseo workspace archive |git worktree remove |git branch -d )/.test(object.command));
    assert.ok(!('status' in object) && !('approved' in object));
  }
});

test('an open task is reported, not refused', () => {
  const f = fixture({ tasks: TASKS_OPEN });
  const r = cleanup(f, '--json');
  assert.equal(r.status, 0, r.out);
  const report = JSON.parse(r.stdout);
  assert.deepEqual(report.tasks.open, ['T-02']);
  // The objects are still listed in full: the operator decides, the command does not.
  assert.equal(report.objects.filter((object) => object.kind === 'git-worktree').length, 2);
  assert.ok(fs.existsSync(f.worktrees['T-01']));
});

test('a pending merge marker is reported, not refused', () => {
  const f = fixture();
  writeMergeState(f.root, CHANGE, 'T-02', { status: 'pending', tip: git(f.root, 'rev-parse', 'task/chg/T-02') });
  const report = discover(f);
  assert.deepEqual(report.pendingMerges.map((marker) => marker.task), ['T-02']);
  assert.match(cleanup(f).stdout, /pending merge marker: T-02 @ [0-9a-f]{40}/);
});

test('a branch not merged into the checked ref is listed with its pointer and annotated', () => {
  const f = fixture({ integrated: false });
  git(f.worktrees['T-02'], 'commit', '-q', '--allow-empty', '-m', 'unmerged work');
  const tip = git(f.root, 'rev-parse', 'task/chg/T-02');
  const report = discover(f);
  const branch = report.objects.find((object) => object.kind === 'branch' && object.id === 'task/chg/T-02');
  assert.equal(branch.tip, tip);
  // No upstream is configured, so `git branch -d` checks HEAD — never `--base`.
  assert.deepEqual(branch.deleteCheck, { ref: 'HEAD', merged: false });
  assert.equal(branch.command, 'git branch -d task/chg/T-02');
  assert.match(cleanup(f).stdout, /tip is not merged into HEAD; branch -d will refuse/);
  // The branch is still there: `-d` is what the listing says, and nothing was run.
  assert.equal(git(f.root, 'rev-parse', '--verify', 'refs/heads/task/chg/T-02'), tip);
});

test('a dirty worktree is listed and annotated, never removed', () => {
  const f = fixture();
  write(f.worktrees['T-02'], 'dirty.txt', 'x');
  const report = discover(f);
  const object = report.objects.find((item) => item.id === f.worktrees['T-02']);
  assert.equal(object.dirty, true);
  assert.doesNotMatch(object.command, /--force/);
  assert.match(cleanup(f).stdout, /worktree has uncommitted changes; removal will refuse/);
  assert.ok(fs.existsSync(f.worktrees['T-02']));
});

/** Run an emitted command literally, the way a human pastes it. */
function shell(cwd, command) {
  return spawnSync('sh', ['-c', command], { cwd, env, encoding: 'utf8' });
}

/** What the real `git branch -d` decides for `branch`, in the fixture's repository. */
function branchDelete(f, branch) {
  const r = spawnSync('git', ['-C', f.root, 'branch', '-d', branch], { env, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

/** The worktree's index file bytes: any optional-lock refresh rewrites this file. */
function indexBytes(cwd) {
  return fs.readFileSync(git(cwd, 'rev-parse', '--path-format=absolute', '--git-path', 'index'));
}

/** A worktree at exactly `dir`; returns the path git registered for it. */
function addWorktree(f, branch, dir) {
  git(f.root, 'worktree', 'add', '-q', '-b', branch, dir, f.integrationTip);
  return spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { env, encoding: 'utf8' }).stdout.trim();
}

test('cleanup never writes the index of the worktree it inspects', () => {
  const f = fixture();
  const worktree = f.worktrees['T-01'];
  // A stat-dirty tracked file whose content is unchanged is what makes plain `git status`
  // refresh and rewrite the index through an optional lock.
  const statDirty = path.join(worktree, 'openspec', 'changes', CHANGE, 'proposal.md');
  const future = new Date('2030-12-31T00:00:00Z');
  fs.utimesSync(statDirty, future, future);
  fs.appendFileSync(path.join(worktree, 'openspec', 'changes', CHANGE, 'acceptance.md'), 'changed\n');
  const before = indexBytes(worktree);
  const report = discover(f);
  assert.deepEqual(indexBytes(worktree), before);
  // The probe still reports the dirty state correctly; it just does it without writing.
  const object = report.objects.find((item) => item.id === worktree);
  assert.equal(object.dirty, true);
});

test('a worktree path with a space yields a command that removes only that worktree', () => {
  const f = fixture();
  const dir = path.join(f.root, '..', `${path.basename(f.root)}-wt space`);
  const registeredPath = addWorktree(f, 'task/chg/T-03', dir);
  const object = discover(f).objects.find((item) => item.id === registeredPath);
  assert.equal(object.command, `git worktree remove '${registeredPath}'`);
  // The path is displayed as it is; only the command text is quoted.
  assert.equal(object.path, registeredPath);
  const r = shell(f.root, object.command);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!registered(f, registeredPath));
  assert.ok(registered(f, f.worktrees['T-01']));
});

test('a worktree path with a semicolon yields a command with no shell side effect', () => {
  const f = fixture();
  const dir = path.join(f.root, '..', `${path.basename(f.root)}-wt;touch>PWNED`);
  const registeredPath = addWorktree(f, 'task/chg/T-03', dir);
  const object = discover(f).objects.find((item) => item.id === registeredPath);
  assert.equal(object.command, `git worktree remove '${registeredPath}'`);
  const r = shell(f.root, object.command);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!registered(f, registeredPath));
  // Unquoted, the `;` would have run `touch>PWNED` in the current directory.
  assert.ok(!fs.existsSync(path.join(f.root, 'PWNED')));
});

test('a branch name containing $ yields a command that deletes only that branch', () => {
  const f = fixture();
  // A live change directory's basename is the change name with no charset check, and
  // `integration/<change>` is legal; `$` is exactly the shell-active character at issue.
  const change = 'chg$(id>PWNED)';
  const dir = path.join(f.root, 'openspec', 'changes', change);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'tasks.md'), TASKS_DONE);
  git(f.root, 'branch', `integration/${change}`, 'main');
  const r = run(f, ['cleanup', dir, '--json']);
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  const branch = JSON.parse(r.stdout).objects.find((object) => object.kind === 'branch' && object.id === `integration/${change}`);
  assert.ok(branch, r.stdout);
  assert.equal(branch.command, `git branch -d 'integration/${change}'`);
  const out = shell(f.root, branch.command);
  assert.equal(out.status, 0, out.stderr);
  assert.ok(!fs.existsSync(path.join(f.root, 'PWNED')));
  const gone = spawnSync('git', ['-C', f.root, 'rev-parse', '--verify', '--quiet', `refs/heads/integration/${change}`], { env, encoding: 'utf8' });
  assert.notEqual(gone.status, 0);
  // No other branch was touched.
  assert.ok(git(f.root, 'rev-parse', '--verify', 'refs/heads/integration/chg'));
});

test('the listing predicts git branch -d: merged into HEAD with no upstream deletes', () => {
  const f = fixture();
  git(f.root, 'branch', 'task/chg/T-09', 'main');
  const report = discover(f);
  const branch = report.objects.find((object) => object.id === 'task/chg/T-09');
  assert.deepEqual(branch.deleteCheck, { ref: 'HEAD', merged: true });
  assert.equal(branch.heldBy, undefined);
  assert.doesNotMatch(cleanup(f).stdout, /T-09[^\n]*will refuse/);
  // The listing agreed with the real decision.
  assert.equal(branchDelete(f, 'task/chg/T-09').status, 0);
});

test('the listing predicts git branch -d: an upstream that lacks the tip refuses though base has it', () => {
  const f = fixture();
  const emptyTree = git(f.root, 'hash-object', '-t', 'tree', '/dev/null');
  const unrelated = git(f.root, 'commit-tree', emptyTree, '-m', 'unrelated root');
  git(f.root, 'update-ref', 'refs/heads/upstream-lacking', unrelated);
  git(f.root, 'branch', 'task/chg/T-10', 'main');
  git(f.root, 'branch', '--set-upstream-to=upstream-lacking', 'task/chg/T-10');
  // The old annotation asked about `main` and would have promised a successful delete.
  const againstBase = spawnSync('git', ['-C', f.root, 'merge-base', '--is-ancestor', 'task/chg/T-10', 'main'], { env, encoding: 'utf8' });
  assert.equal(againstBase.status, 0);
  const branch = discover(f).objects.find((object) => object.id === 'task/chg/T-10');
  assert.deepEqual(branch.deleteCheck, { ref: 'refs/heads/upstream-lacking', merged: false });
  assert.match(cleanup(f).stdout, /tip is not merged into refs\/heads\/upstream-lacking; branch -d will refuse/);
  assert.notEqual(branchDelete(f, 'task/chg/T-10').status, 0);
});

test('the listing predicts git branch -d: a worktree registration blocks it and is named', () => {
  const f = fixture();
  const heldPath = f.worktrees['T-01'];
  const report = discover(f);
  const branch = report.objects.find((object) => object.id === 'task/chg/T-01');
  assert.deepEqual(branch.heldBy, [{ path: heldPath, stale: false, listed: true }]);
  assert.notEqual(branchDelete(f, 'task/chg/T-01').status, 0);
  const listing = cleanup(f);
  assert.equal(listing.status, 0, listing.out);
  assert.ok(listing.stdout.includes(`held by worktree ${heldPath}; run that worktree's listed command first`), listing.stdout);
  // The holding worktree is listed before the branch it blocks.
  assert.ok(listing.stdout.indexOf(heldPath) < listing.stdout.indexOf(`[branch] task/chg/T-01`), listing.stdout);
});

test('a stale registration blocks branch -d until its own command runs', () => {
  const f = fixture({ staleFor: 'T-03' });
  const stalePath = f.worktrees['T-03'];
  const report = discover(f);
  const branch = report.objects.find((object) => object.id === 'task/chg/T-03');
  assert.deepEqual(branch.heldBy, [{ path: stalePath, stale: true, listed: true }]);
  assert.match(cleanup(f).stdout, /held by worktree .*, stale registration/);
  assert.notEqual(branchDelete(f, 'task/chg/T-03').status, 0);
  // `git worktree remove <missing-path>` is exactly the command the listing emits for it.
  const stale = report.objects.find((object) => object.kind === 'git-worktree' && object.path === stalePath);
  const removed = shell(f.root, stale.command);
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(branchDelete(f, 'task/chg/T-03').status, 0);
});

test('an unreadable merge marker is reported and exits 3, never a clean pass', () => {
  const f = fixture();
  const blob = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: f.root, env, encoding: 'utf8', input: '{"status":"bogus"}' });
  git(f.root, 'update-ref', 'refs/pipeline/merge-failures/chg/T-01', blob.stdout.trim());
  const r = cleanup(f, '--json');
  assert.equal(r.status, 3, r.out);
  const report = JSON.parse(r.stdout);
  assert.equal(report.exit, 3);
  assert.deepEqual(report.pendingMerges, []);
  assert.equal(report.pendingMergeErrors.length, 1);
  assert.equal(report.pendingMergeErrors[0].task, 'T-01');
  assert.match(report.pendingMergeErrors[0].error, /invalid refs\/pipeline\/merge-failures\/chg\/T-01/);
  // The objects the human needs are still listed; the error sits beside them.
  assert.equal(report.objects.filter((object) => object.kind === 'branch').length, 3);
  assert.equal(report.objects.filter((object) => object.kind === 'git-worktree').length, 2);
  const text = cleanup(f);
  assert.equal(text.status, 3, text.out);
  assert.match(text.stdout, /unreadable merge marker: T-01: .*cannot be determined/);
  assert.match(text.stdout, /\[branch\] integration\/chg/);
});

test('a Paseo-owned worktree yields only the archive command, never worktree remove', () => {
  const f = fixture({ paseoWorkspaceFor: 'T-01' });
  const report = discover(f);
  const owned = report.objects.filter((object) => object.kind === 'paseo-workspace');
  assert.equal(owned.length, 1);
  assert.match(owned[0].command, /^paseo workspace archive wks_t01$/);
  assert.equal(fs.realpathSync(owned[0].path), fs.realpathSync(f.worktrees['T-01']));
  assert.ok(!report.objects.some((object) => object.kind === 'git-worktree' && object.path === f.worktrees['T-01']));
});

test('a background Paseo workspace still owns its worktree', () => {
  const f = fixture({ paseoWorkspaceFor: 'T-01', background: true });
  const report = discover(f);
  const owned = report.objects.filter((object) => object.kind === 'paseo-workspace');
  assert.equal(owned.length, 1);
  assert.equal(fs.realpathSync(owned[0].path), fs.realpathSync(f.worktrees['T-01']));
  assert.ok(!report.objects.some((object) => object.kind === 'git-worktree' && fs.realpathSync(object.path) === fs.realpathSync(f.worktrees['T-01'])));
});

test('a stale registration is an ordinary git-worktree object with a per-path command', () => {
  const f = fixture({ staleFor: ['T-03', 'T-04'] });
  const report = discover(f);
  const stale = report.objects.filter((object) => object.kind === 'git-worktree' && object.stale);
  assert.equal(stale.length, 2);
  for (const object of stale) {
    assert.equal(object.command, `git worktree remove ${object.path}`);
    assert.ok(!fs.existsSync(object.path));
  }
  // No global operation is ever offered: every command is scoped to one object.
  assert.ok(!report.objects.some((object) => !/^(git worktree remove |paseo workspace archive |git branch -d )/.test(object.command)));
});

test('stale paths that differ by a trailing comma are distinct objects', () => {
  const f = fixture({ staleFor: ['T-03', 'T-04'] });
  const report = discover(f);
  const stale = report.objects.filter((object) => object.kind === 'git-worktree' && object.stale);
  assert.equal(stale.length, 2);
  assert.notEqual(`${stale[0].path},`, stale[1].path);
  assert.equal(new Set(stale.map((object) => object.command)).size, 2);
});

test('a stale registration owned by a Paseo workspace is listed as its workspace, never as git', () => {
  const f = fixture({ staleFor: 'T-03', paseoWorkspaceFor: 'T-03' });
  const report = discover(f);
  const owned = report.objects.filter((object) => object.kind === 'paseo-workspace');
  assert.equal(owned.length, 1);
  assert.equal(owned[0].id, 'wks_t03');
  assert.equal(owned[0].command, 'paseo workspace archive wks_t03');
  assert.equal(owned[0].path, f.worktrees['T-03']);
  assert.equal(owned[0].stale, true);
  assert.ok(!report.objects.some((object) => object.path === owned[0].path && object.kind === 'git-worktree'));
});

test('two stale registrations on one branch are two distinct objects', () => {
  const f = fixture();
  const secondDir = path.join(f.root, '..', `${path.basename(f.root)}-T-01b`);
  git(f.root, 'worktree', 'add', '-q', '-f', secondDir, 'task/chg/T-01');
  const second = spawnSync('git', ['-C', secondDir, 'rev-parse', '--show-toplevel'], { env, encoding: 'utf8' }).stdout.trim();
  fs.rmSync(secondDir, { recursive: true, force: true });
  const first = f.worktrees['T-01'];
  fs.rmSync(first, { recursive: true, force: true });
  const report = discover(f);
  const stale = report.objects.filter((object) => object.kind === 'git-worktree' && object.stale);
  assert.deepEqual(stale.map((object) => object.id).sort(), [first, second].sort());
  assert.equal(new Set(stale.map((object) => object.command)).size, 2);
  // Listing never clears a registration.
  assert.ok(registered(f, first));
  assert.ok(registered(f, second));
});

test('a stale registration owned by another change is never offered', () => {
  const f = fixture();
  const foreignDir = path.join(f.root, '..', `${path.basename(f.root)}-foreign`);
  git(f.root, 'worktree', 'add', '-q', '-b', 'task/other/T-01', foreignDir, f.integrationTip);
  const foreignPath = spawnSync('git', ['-C', foreignDir, 'rev-parse', '--show-toplevel'], { env, encoding: 'utf8' }).stdout.trim();
  fs.rmSync(foreignDir, { recursive: true, force: true });
  const report = discover(f);
  assert.ok(!report.objects.some((object) => object.id === foreignPath));
  assert.match(cleanup(f).stderr, /not listing stale registrations owned by other changes/);
});

/** Move the change directory the way `openspec archive` does, without touching git history. */
function archiveChange(f) {
  const archived = path.join(f.root, 'openspec', 'changes', 'archive', `2026-11-08-${CHANGE}`);
  fs.mkdirSync(path.dirname(archived), { recursive: true });
  fs.renameSync(f.changeDir, archived);
  return archived;
}

test('an archived change directory exits 3 and names both remedies', () => {
  const f = fixture();
  const archived = archiveChange(f);
  const r = run(f, ['cleanup', archived]);
  assert.equal(r.status, 3, r.out);
  assert.match(r.stderr, /looks archived/);
  assert.match(r.stderr, /openspec archive/);
  assert.match(r.stderr, /--change <name>/);
});

test('--change <name> lets cleanup list the archived directory', () => {
  const f = fixture();
  const archived = archiveChange(f);
  const r = run(f, ['cleanup', archived, '--change', CHANGE, '--json']);
  assert.equal(r.status, 0, r.out);
  const report = JSON.parse(r.stdout);
  assert.equal(report.change, CHANGE);
  // The archived copy still holds the contract, so task state is reported from it.
  assert.deepEqual(report.tasks.open, []);
  assert.equal(report.objects.filter((object) => object.kind === 'branch').length, 3);
});

test('--change is validated and rejects a name that is not a bare change name', () => {
  const f = fixture();
  for (const value of ['../chg', '2026-11-08-chg/../x', ' bad', '']) {
    const r = run(f, ['cleanup', f.changeDir, '--change', value, '--json']);
    assert.equal(r.status, 2, `${value}: ${r.out}`);
  }
});

test('--change must name the change directory: live basename or archive/<YYYY-MM-DD>-<name>', () => {
  const f = fixture();
  // Live directory: the basename is the only accepted name.
  assert.equal(run(f, ['cleanup', f.changeDir, '--change', CHANGE, '--json']).status, 0);
  let r = run(f, ['cleanup', f.changeDir, '--change', 'other', '--json']);
  assert.equal(r.status, 2, r.out);
  // A correctly named directory in another repository is still refused: both gates must hold.
  const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-other-'));
  write(otherRoot, `openspec/changes/${CHANGE}/tasks.md`, TASKS_DONE);
  git(otherRoot, 'init', '-q', '-b', 'main');
  git(otherRoot, 'add', '.');
  git(otherRoot, 'commit', '-qm', 'contract');
  r = run(f, ['cleanup', path.join(otherRoot, 'openspec', 'changes', CHANGE), '--change', CHANGE, '--json']);
  assert.equal(r.status, 2, r.out);
  assert.match(r.stderr, /belongs to a different repository/);
  const archived = archiveChange(f);
  // Archived directory: `<YYYY-MM-DD>-<name>`, and nothing else.
  assert.equal(run(f, ['cleanup', archived, '--change', CHANGE, '--json']).status, 0);
  r = run(f, ['cleanup', archived, '--change', 'other', '--json']);
  assert.equal(r.status, 2, r.out);
  assert.match(r.stderr, /does not name/);
  // The parent decides the shape: inside `archive/` a dated basename is a directory name, so
  // it is not a change name even though the live shape would otherwise accept it.
  r = run(f, ['cleanup', archived, '--change', `2026-11-08-${CHANGE}`, '--json']);
  assert.equal(r.status, 2, r.out);
  assert.match(r.stderr, /does not name/);
  // A date that is not a date is not the archived shape either.
  fs.renameSync(archived, path.join(path.dirname(archived), `notadate-${CHANGE}`));
  const notADate = path.join(path.dirname(archived), `notadate-${CHANGE}`);
  r = run(f, ['cleanup', notADate, '--change', CHANGE, '--json']);
  assert.equal(r.status, 2, r.out);
});

test('an archived directory cannot list another change name', () => {
  const f = fixture();
  const foreign = path.join(f.root, 'openspec', 'changes', 'archive', `2026-11-08-other`);
  fs.mkdirSync(path.dirname(foreign), { recursive: true });
  fs.cpSync(f.changeDir, foreign, { recursive: true });
  const r = run(f, ['cleanup', foreign, '--change', CHANGE, '--json']);
  assert.equal(r.status, 2, r.out);
  assert.match(r.stderr, /does not name/);
});

test('a dated basename inside archive/ is never a live change name', () => {
  const f = fixture();
  const archived = archiveChange(f);
  // A later, unrelated change is literally named like the archived directory; the dated
  // basename must not become its name.
  const later = `2026-11-08-${CHANGE}`;
  const r = run(f, ['cleanup', archived, '--change', later, '--json']);
  assert.equal(r.status, 2, r.out);
  assert.match(r.stderr, /does not name/);
});

test('cleanup never lists a repository other than the one it was run from', () => {
  const f = fixture();
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-other-'));
  write(other, `openspec/changes/${CHANGE}/tasks.md`, TASKS_DONE);
  git(other, 'init', '-q', '-b', 'main');
  git(other, 'add', '.');
  git(other, 'commit', '-qm', 'contract');
  const otherDir = path.join(other, 'openspec', 'changes', CHANGE);
  const r = run(f, ['cleanup', otherDir, '--json']);
  assert.equal(r.status, 2, r.out);
  assert.match(r.stderr, /belongs to a different repository/);
  // The message names both directories and both identities.
  assert.ok(r.stderr.includes(otherDir), r.stderr);
  assert.ok(r.stderr.includes(f.root), r.stderr);
});

test('a nested repository is a different repository, not a directory inside this one', () => {
  const f = fixture();
  // Repo B nested inside A, with the same change name. Its path is inside A's toplevel, so
  // only repository identity can tell them apart.
  const nested = path.join(f.root, 'vendor', 'nested');
  fs.mkdirSync(nested, { recursive: true });
  write(nested, `openspec/changes/${CHANGE}/tasks.md`, TASKS_DONE);
  git(nested, 'init', '-q', '-b', 'main');
  git(nested, 'add', '.');
  git(nested, 'commit', '-qm', 'contract');
  const nestedDir = path.join(nested, 'openspec', 'changes', CHANGE);
  assert.notEqual(git(nested, 'rev-parse', '--path-format=absolute', '--git-common-dir'),
    git(f.root, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
  const r = run(f, ['cleanup', nestedDir, '--json']);
  assert.equal(r.status, 2, r.out);
  assert.match(r.stderr, /belongs to a different repository/);
  // From its own repository the nested change directory is legitimate.
  const nestedRun = spawnSync('node', [script, 'cleanup', nestedDir, '--json'], { cwd: nested, env: f.localEnv, encoding: 'utf8' });
  assert.equal(nestedRun.status, 0, `${nestedRun.stdout}${nestedRun.stderr}`);
  assert.equal(JSON.parse(nestedRun.stdout).change, CHANGE);
});
