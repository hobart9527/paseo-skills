import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPreconditions, executeObject } from '../lib/cleanup.mjs';

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

// A fake `paseo` so discovery/archive never touches the real daemon. `workspace ls` returns
// the fixture list; `workspace archive` removes the owned worktree through git, exactly the
// ownership path the cleanup driver must use instead of `git worktree remove`.
const FAKE_PASEO = `#!/usr/bin/env node
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const cfg = JSON.parse(fs.readFileSync(process.env.FAKE_PASEO_CFG, 'utf8'));
const [a, b, ...rest] = process.argv.slice(2);
if (a === 'workspace' && b === 'ls') { process.stdout.write(JSON.stringify(cfg.workspaces)); process.exit(0); }
if (a === 'workspace' && b === 'archive') {
  const found = cfg.workspaces.find((w) => w.workspaceId === rest[0]);
  if (!found) process.exit(2);
  const r = spawnSync('git', ['-C', cfg.root, 'worktree', 'remove', found.cwd], { encoding: 'utf8' });
  if (r.status !== 0) { process.stderr.write(r.stderr || ''); process.exit(r.status || 1); }
  process.exit(0);
}
process.exit(1);
`;

function fakePaseo(dir, root, workspaces = []) {
  const bin = path.join(dir, '.fake-bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'paseo'), FAKE_PASEO);
  fs.chmodSync(path.join(bin, 'paseo'), 0o755);
  const cfg = path.join(dir, '.fake-paseo.json');
  fs.writeFileSync(cfg, JSON.stringify({ root, workspaces }));
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

/** Simulate a branch deleted before CP-2 without ever using `git branch -D`. */
function dropBranch(f, branch) { git(f.root, 'update-ref', '-d', `refs/heads/${branch}`); }

/** Append the `Cleanup:` record this command writes when it deletes the integration branch. */
function recordBranchCleanup(f, sha) {
  fs.appendFileSync(path.join(f.changeDir, 'run-log.md'), `Cleanup: branch integration/${CHANGE} git branch -d integration/${CHANGE} done @${sha}\n`);
}

function run(f, args) {
  const r = spawnSync('node', [script, ...args], { cwd: f.root, env: f.localEnv, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, out: `${r.stdout}${r.stderr}` };
}

const cleanup = (f, ...flags) => run(f, ['cleanup', f.changeDir, ...flags]);

/**
 * Record approvals the way a human does after CP-2: in the worktree run-log, uncommitted,
 * one literal `Approval:` block per object. `onIntegration` writes only to the
 * integration-branch copy instead (fallback path).
 */
function approve(f, objects, filter = () => true, { onIntegration = false } = {}) {
  const block = objects.filter(filter)
    .map((object) => `Approval: 2026-11-07T00:00:00Z clean up ${object.id}\nObject: ${object.id}\nCommand: ${object.command}\n`)
    .join('\n');
  const file = path.join(f.changeDir, 'run-log.md');
  if (!onIntegration) {
    fs.writeFileSync(file, `${fs.readFileSync(file, 'utf8')}\n${block}`);
    return;
  }
  git(f.root, 'switch', '-q', `integration/${CHANGE}`);
  fs.writeFileSync(file, `${fs.readFileSync(file, 'utf8')}\n${block}`);
  git(f.root, 'add', `openspec/changes/${CHANGE}/run-log.md`);
  git(f.root, 'commit', '-qm', 'approve cleanup');
  // Landing main again keeps integration an ancestor of base; switching back drops the
  // uncommitted worktree copy, so the approval exists only on the branch.
  git(f.root, 'switch', '-q', 'main');
  if (f.integrated) git(f.root, 'merge', '-q', '--ff-only', `integration/${CHANGE}`);
}

/** Append one approval block to the worktree run-log with raw field lines. */
function approveRaw(f, lines) {
  const file = path.join(f.changeDir, 'run-log.md');
  fs.writeFileSync(file, `${fs.readFileSync(file, 'utf8')}\nApproval: 2026-11-07T00:00:00Z cleanup\n${lines.join('\n')}\n`);
}

/** True when git still has a registration for `targetPath`. */
function registered(f, targetPath) {
  return git(f.root, 'worktree', 'list', '--porcelain').split('\n').includes(`worktree ${targetPath}`);
}

function discover(f) {
  const r = cleanup(f, '--json');
  return JSON.parse(r.stdout);
}

test('cleanup lists objects read-only by default and with --dry-run', () => {
  const f = fixture();
  const defaultRun = cleanup(f);
  const dryRun = cleanup(f, '--dry-run');
  assert.equal(defaultRun.status, 0, defaultRun.out);
  assert.equal(dryRun.status, 0, dryRun.out);
  assert.equal(defaultRun.stdout, dryRun.stdout);
  assert.match(defaultRun.stdout, new RegExp(`git-worktree ${f.worktrees['T-01'].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(defaultRun.stdout, new RegExp(`git-worktree ${f.worktrees['T-02'].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(defaultRun.stdout, /branch integration\/chg -> git branch -d integration\/chg/);
  // Listing never touches anything.
  for (const id of ['T-01', 'T-02']) assert.ok(fs.existsSync(f.worktrees[id]), id);
});

test('cleanup rejects conflicting flags and unknown flags with exit 2', () => {
  const f = fixture();
  assert.equal(cleanup(f, '--dry-run', '--execute').status, 2);
  assert.equal(cleanup(f, '--bogus').status, 2);
});

test('--execute refuses when a task is not Done', () => {
  const f = fixture({ tasks: TASKS_OPEN });
  const report = discover(f);
  approve(f, report.objects);
  const r = cleanup(f, '--execute');
  assert.equal(r.status, 4, r.out);
  assert.match(r.stderr, /not Done: T-02/);
  assert.ok(fs.existsSync(f.worktrees['T-01']));
});

test('--execute refuses when integration is not an ancestor of base', () => {
  const f = fixture({ integrated: false });
  const report = discover(f);
  approve(f, report.objects);
  const r = cleanup(f, '--execute');
  assert.equal(r.status, 4, r.out);
  assert.match(r.stderr, /not an ancestor of main/);
  assert.ok(fs.existsSync(f.worktrees['T-01']));
});

test('--execute refuses a dirty worktree and names it', () => {
  const f = fixture();
  write(f.worktrees['T-02'], 'dirty.txt', 'x');
  const report = discover(f);
  approve(f, report.objects);
  const r = cleanup(f, '--execute');
  assert.equal(r.status, 4, r.out);
  assert.match(r.stderr, new RegExp(`worktree is not clean: ${fs.realpathSync(f.worktrees['T-02']).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.ok(fs.existsSync(f.worktrees['T-01']));
});

test('--execute refuses an object whose approval block lacks its exact command', () => {
  const f = fixture();
  const report = discover(f);
  approve(f, report.objects, (object) => object.kind === 'git-worktree');
  const r = cleanup(f, '--execute');
  assert.equal(r.status, 5, r.out);
  assert.match(r.out, /\[unapproved\] branch integration\/chg/);
  // Approved worktrees were executed; the unapproved branch was left alone.
  assert.ok(!fs.existsSync(f.worktrees['T-01']));
  assert.ok(git(f.root, 'rev-parse', '--verify', 'refs/heads/integration/chg'));
});

test('an approval covering one object never covers another object of the same kind', () => {
  const f = fixture();
  const report = discover(f);
  const onlyFirst = report.objects.filter((object) => object.id === f.worktrees['T-01']);
  approve(f, onlyFirst);
  const r = cleanup(f, '--execute');
  assert.equal(r.status, 5, r.out);
  assert.match(r.out, new RegExp(`\\[unapproved\\] git-worktree ${f.worktrees['T-02'].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.ok(fs.existsSync(f.worktrees['T-02']));
});

test('a Paseo-owned worktree yields only the archive command, never worktree remove', () => {
  const f = fixture({ paseoWorkspaceFor: 'T-01' });
  const report = discover(f);
  const owned = report.objects.filter((object) => object.kind === 'paseo-workspace');
  assert.equal(owned.length, 1);
  assert.match(owned[0].command, /^paseo workspace archive wks_t01$/);
  assert.equal(fs.realpathSync(owned[0].path), fs.realpathSync(f.worktrees['T-01']));
  assert.ok(!report.objects.some((object) => object.kind === 'git-worktree' && object.path === f.worktrees['T-01']));

  approve(f, report.objects);
  const r = cleanup(f, '--execute', '--json');
  assert.equal(r.status, 0, r.out);
  const done = JSON.parse(r.stdout);
  const executed = done.objects.find((object) => object.kind === 'paseo-workspace');
  assert.equal(executed.status, 'done');
  assert.ok(!fs.existsSync(f.worktrees['T-01']));
});

test('approved execution removes worktrees and deletes branches with -d', () => {
  const f = fixture();
  const report = discover(f);
  approve(f, report.objects);
  const r = cleanup(f, '--execute', '--json');
  assert.equal(r.status, 0, r.out);
  const done = JSON.parse(r.stdout);
  const branch = done.objects.find((object) => object.kind === 'branch' && object.id === 'task/chg/T-01');
  assert.equal(branch.command, 'git branch -d task/chg/T-01');
  assert.equal(branch.status, 'done');
  assert.equal(done.exit, 0);
  for (const id of ['T-01', 'T-02']) assert.ok(!fs.existsSync(f.worktrees[id]), id);
  const remaining = git(f.root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/task/chg/');
  assert.equal(remaining, '');
  // Integration is merged into main, so -d is safe and succeeds.
  assert.throws(() => git(f.root, 'rev-parse', '--verify', 'refs/heads/integration/chg'));
});

test('branch deletion uses -d: an unmerged branch is reported, not force-deleted', () => {
  const f = fixture();
  const report = discover(f);
  // T-02 branch moved past the integration tip, so it is not merged.
  git(f.worktrees['T-02'], 'commit', '-q', '--allow-empty', '-m', 'unmerged work');
  const unmergedTip = git(f.root, 'rev-parse', 'task/chg/T-02');
  approve(f, report.objects);
  const r = cleanup(f, '--execute', '--json');
  const reportJson = JSON.parse(r.stdout);
  const branch = reportJson.objects.find((object) => object.kind === 'branch' && object.id === 'task/chg/T-02');
  assert.equal(branch.status, 'failed');
  assert.match(branch.command, /^git branch -d /);
  // `-d` refused: the unmerged branch is still there, and nothing escalated to `-D`.
  assert.equal(git(f.root, 'rev-parse', '--verify', 'refs/heads/task/chg/T-02'), unmergedTip);
  assert.equal(JSON.parse(r.stdout).exit, 1);
});

test('a re-run skips objects already recorded done', () => {
  const f = fixture();
  const report = discover(f);
  approve(f, report.objects);
  const mergedAt = git(f.root, 'rev-parse', 'main');
  assert.equal(cleanup(f, '--execute').status, 0);
  // The first run deleted integration/chg, so CP-2 is proven by the landed SHA, never by the
  // earlier Cleanup record.
  const again = cleanup(f, '--execute', '--merged-at', mergedAt, '--json');
  assert.equal(again.status, 0, again.out);
  const objects = JSON.parse(again.stdout).objects;
  assert.ok(objects.length > 0);
  for (const object of objects) assert.equal(object.status, 'already-done', `${object.kind} ${object.id}`);
  // Nothing was appended twice.
  const log = fs.readFileSync(path.join(f.changeDir, 'run-log.md'), 'utf8');
  assert.equal(log.match(/^Cleanup: .* done(?: @[0-9a-f]+)?$/gm).length, report.objects.length);
});

test('a missing registration is done, not an error', () => {
  const f = fixture();
  const report = discover(f);
  approve(f, report.objects);
  const object = report.objects.find((item) => item.kind === 'git-worktree' && item.id === f.worktrees['T-01']);
  // The first call removes the registration; the second finds it gone and still reports done.
  assert.equal(executeObject(object, { cwd: f.root }).status, 'done');
  const again = executeObject(object, { cwd: f.root });
  assert.equal(again.status, 'done');
  assert.equal(again.detail, 'registration already gone');
});

test('approvals in the worktree run-log are the live authority after CP-2', () => {
  const f = fixture();
  const report = discover(f);
  // The integration branch exists and is an ancestor; only the worktree copy is approved.
  approve(f, report.objects);
  const listing = discover(f);
  assert.equal(listing.approvalSource, 'worktree');
  const r = cleanup(f, '--execute', '--json');
  assert.equal(r.status, 0, r.out);
  assert.equal(JSON.parse(r.stdout).approvalSource, 'worktree');
  assert.ok(!fs.existsSync(f.worktrees['T-01']));
});

test('the integration copy is the fallback only when the worktree run-log is absent', () => {
  const f = fixture();
  const report = discover(f);
  approve(f, report.objects, () => true, { onIntegration: true });
  fs.rmSync(path.join(f.changeDir, 'run-log.md'));
  const listing = discover(f);
  assert.equal(listing.approvalSource, 'integration');
  const r = cleanup(f, '--execute');
  assert.equal(r.status, 0, r.out);
  assert.ok(!fs.existsSync(f.worktrees['T-01']));
});

test('integration-fallback approvals survive a partial failure that creates the worktree file', () => {
  const f = fixture();
  const report = discover(f);
  approve(f, report.objects, () => true, { onIntegration: true });
  fs.rmSync(path.join(f.changeDir, 'run-log.md'));
  // T-02's branch moves past integration, so `git branch -d` refuses and the run is partial.
  git(f.worktrees['T-02'], 'commit', '-q', '--allow-empty', '-m', 'unmerged work');
  const first = cleanup(f, '--execute', '--json');
  assert.equal(first.status, 1, first.out);
  // The first run created the worktree run-log; the integration approvals were seeded into it.
  assert.ok(fs.existsSync(path.join(f.changeDir, 'run-log.md')));
  const recorded = fs.readFileSync(path.join(f.changeDir, 'run-log.md'), 'utf8')
    .match(new RegExp(`^Cleanup: branch integration/${CHANGE} .* done @([0-9a-f]+)$`, 'm'))[1];
  const second = cleanup(f, '--execute', '--merged-at', recorded, '--json');
  // The retry still sees the branch approval instead of exiting 5 with everything unapproved.
  assert.equal(second.status, 1, second.out);
  const listed = JSON.parse(second.stdout);
  assert.equal(listed.approvalSource, 'worktree');
  const branch = listed.objects.find((object) => object.kind === 'branch' && object.id === 'task/chg/T-02');
  assert.notEqual(branch.status, 'unapproved');
  assert.equal(JSON.parse(second.stdout).exit, 1);
});

test('a command with a trailing comma authorizes nothing, quoted or not', () => {
  const f = fixture();
  const report = discover(f);
  const branch = report.objects.find((object) => object.kind === 'branch' && object.id === 'integration/chg');
  assert.equal(branch.command, 'git branch -d integration/chg');
  for (const value of [`${branch.command},`, `\`${branch.command},\``]) {
    approveRaw(f, [`Object: integration/chg`, `Command: ${value}`]);
    const listing = discover(f);
    assert.equal(listing.objects.find((object) => object.id === 'integration/chg').approved, false, value);
    const r = cleanup(f, '--execute', '--json');
    assert.equal(r.status, 5, r.out);
    const listedAfter = JSON.parse(r.stdout).objects.find((object) => object.id === 'integration/chg');
    assert.equal(listedAfter.status, 'unapproved', value);
    assert.equal(listedAfter.approved, false, value);
    assert.ok(git(f.root, 'rev-parse', '--verify', 'refs/heads/integration/chg'));
  }
});

test('an exact Object and Command line authorizes the object', () => {
  const f = fixture();
  const report = discover(f);
  const branch = report.objects.find((object) => object.kind === 'branch' && object.id === 'integration/chg');
  approveRaw(f, ['Object: integration/chg', `Command: ${branch.command}`]);
  const listing = discover(f);
  assert.equal(listing.objects.find((object) => object.id === 'integration/chg').approved, true);
  // A fully quoted pair is the same value.
  approveRaw(f, ['Object: `integration/chg`', `Command: \`${branch.command}\``]);
  assert.equal(discover(f).objects.find((object) => object.id === 'integration/chg').approved, true);
});

test('stale paths that differ by a trailing comma are distinct objects', () => {
  const f = fixture({ staleFor: ['T-03', 'T-04'] });
  const report = discover(f);
  const staleObjects = report.objects.filter((object) => object.kind === 'git-worktree' && !fs.existsSync(object.path));
  assert.equal(staleObjects.length, 2);
  const first = staleObjects[0];
  const commaPath = `${first.path},`;
  // Approve a path that differs from the real one only by a trailing comma: nothing.
  approveRaw(f, [`Object: ${commaPath}`, `Command: ${first.command}`]);
  assert.equal(discover(f).objects.find((object) => object.id === first.id).approved, false);
  // Approving one of the two leaves the other unapproved and untouched.
  approve(f, [first]);
  const r = cleanup(f, '--execute', '--json');
  assert.equal(r.status, 5, r.out);
  const listed = JSON.parse(r.stdout).objects.filter((object) => staleObjects.some((stale) => stale.id === object.id));
  assert.equal(listed.length, 2);
  assert.equal(listed.find((object) => object.id === first.id).status, 'done');
  assert.equal(listed.find((object) => object.id !== first.id).status, 'unapproved');
  assert.ok(!registered(f, first.path));
  assert.equal((git(f.root, 'worktree', 'list', '--porcelain').match(/prunable /g) || []).length, 1);
});

test('an approval block with two Object lines or two Command lines authorizes nothing', () => {
  const f = fixture();
  const report = discover(f);
  const branch = report.objects.find((object) => object.id === 'integration/chg');
  approveRaw(f, ['Object: integration/chg', 'Object: integration/chg', `Command: ${branch.command}`]);
  assert.equal(discover(f).objects.find((object) => object.id === 'integration/chg').approved, false);
  approveRaw(f, ['Object: integration/chg', `Command: ${branch.command}`, `Command: ${branch.command}`]);
  assert.equal(discover(f).objects.find((object) => object.id === 'integration/chg').approved, false);
});

test('an approval block missing Object or Command authorizes nothing', () => {
  const f = fixture();
  const report = discover(f);
  const branch = report.objects.find((object) => object.id === 'integration/chg');
  approveRaw(f, [`Command: ${branch.command}`]);
  assert.equal(discover(f).objects.find((object) => object.id === 'integration/chg').approved, false);
  approveRaw(f, ['Object: integration/chg']);
  assert.equal(discover(f).objects.find((object) => object.id === 'integration/chg').approved, false);
});

test('an empty, whitespace-only or backtick-only field authorizes nothing', () => {
  const f = fixture();
  const report = discover(f);
  const branch = report.objects.find((object) => object.id === 'integration/chg');
  const cases = [
    ['Object: integration/chg', 'Object:', `Command: ${branch.command}`],
    ['Object: integration/chg', 'Object:    ', `Command: ${branch.command}`],
    ['Object: integration/chg', 'Object: ``', `Command: ${branch.command}`],
    ['Object: integration/chg', `Command: ${branch.command}`, 'Command:'],
  ];
  for (const lines of cases) {
    approveRaw(f, lines);
    const listed = discover(f).objects.find((object) => object.id === 'integration/chg');
    assert.equal(listed.approved, false, lines.join(' | '));
    const r = cleanup(f, '--execute', '--json');
    assert.equal(r.status, 5, r.out);
    assert.equal(JSON.parse(r.stdout).objects.find((object) => object.id === 'integration/chg').status, 'unapproved');
    assert.ok(git(f.root, 'rev-parse', '--verify', 'refs/heads/integration/chg'));
  }
});

test('a workspace object is authorized by its workspace id alone', () => {
  const f = fixture({ paseoWorkspaceFor: 'T-01' });
  const report = discover(f);
  const workspace = report.objects.find((object) => object.kind === 'paseo-workspace');
  assert.equal(workspace.id, 'wks_t01');
  // Its branch and its path are not aliases for the archive.
  for (const alias of [workspace.branch, workspace.path]) {
    approveRaw(f, [`Object: ${alias}`, `Command: ${workspace.command}`]);
    assert.equal(discover(f).objects.find((object) => object.id === 'wks_t01').approved, false, alias);
  }
  approveRaw(f, [`Object: ${workspace.id}`, `Command: ${workspace.command}`]);
  assert.equal(discover(f).objects.find((object) => object.id === 'wks_t01').approved, true);
});

test('the old free-text approval form authorizes nothing', () => {
  const f = fixture();
  const report = discover(f);
  const branch = report.objects.find((object) => object.id === 'integration/chg');
  approveRaw(f, ['Objects: integration/chg', `Command: ${branch.command}`]);
  assert.equal(discover(f).objects.find((object) => object.id === 'integration/chg').approved, false);
  // Prose naming the object and command in one line is not a literal block either.
  approveRaw(f, [`Object: please delete integration/chg with ${branch.command}`, `Command: ${branch.command}`]);
  assert.equal(discover(f).objects.find((object) => object.id === 'integration/chg').approved, false);
  const r = cleanup(f, '--execute');
  assert.equal(r.status, 5, r.out);
  assert.ok(git(f.root, 'rev-parse', '--verify', 'refs/heads/integration/chg'));
});

test('a stale registration is an ordinary git-worktree object with a per-path command', () => {
  const f = fixture({ staleFor: ['T-03', 'T-04'] });
  const report = discover(f);
  const stale = report.objects.filter((object) => object.kind === 'git-worktree' && !fs.existsSync(object.path));
  assert.equal(stale.length, 2);
  for (const object of stale) {
    assert.equal(object.command, `git worktree remove ${object.path}`);
    assert.ok(!fs.existsSync(object.path));
  }
  // No global operation is ever offered: every command is scoped to one object.
  assert.ok(!report.objects.some((object) => !/^(git worktree remove |paseo workspace archive |git branch -d )/.test(object.command)));
});

test('an approved stale registration is removed individually', () => {
  const f = fixture({ staleFor: 'T-03' });
  const report = discover(f);
  const stale = report.objects.find((object) => object.kind === 'git-worktree' && !fs.existsSync(object.path));
  approve(f, report.objects);
  const r = cleanup(f, '--execute', '--json');
  assert.equal(r.status, 0, r.out);
  const listed = JSON.parse(r.stdout).objects.find((object) => object.id === stale.id);
  assert.equal(listed.status, 'done');
  assert.ok(!registered(f, stale.path));
  assert.match(fs.readFileSync(path.join(f.changeDir, 'run-log.md'), 'utf8'), /^Cleanup: git-worktree .* done$/m);
});

test('two stale registrations: only the approved one is removed', () => {
  const f = fixture({ staleFor: ['T-03', 'T-04'] });
  const report = discover(f);
  const stale = report.objects.filter((object) => object.kind === 'git-worktree' && !fs.existsSync(object.path));
  approve(f, report.objects, (object) => object.id !== stale[1].id);
  const r = cleanup(f, '--execute', '--json');
  assert.equal(r.status, 5, r.out);
  const listed = JSON.parse(r.stdout).objects.filter((object) => object.kind === 'git-worktree');
  assert.equal(listed.find((object) => object.id === stale[0].id).status, 'done');
  assert.equal(listed.find((object) => object.id === stale[1].id).status, 'unapproved');
  assert.ok(!registered(f, stale[0].path));
  assert.ok(registered(f, stale[1].path));
});

test('a dirty worktree refuses without force', () => {
  const f = fixture();
  write(f.worktrees['T-02'], 'dirty.txt', 'x');
  const report = discover(f);
  const object = report.objects.find((item) => item.id === f.worktrees['T-02']);
  // Executed directly, the object fails; the command never carries --force.
  const result = executeObject(object, { cwd: f.root });
  assert.equal(result.status, 'failed');
  assert.doesNotMatch(object.command, /--force/);
  assert.ok(fs.existsSync(f.worktrees['T-02']));
  // End to end, the precondition refuses before anything runs and names the worktree.
  approve(f, report.objects);
  const r = cleanup(f, '--execute');
  assert.equal(r.status, 4, r.out);
  assert.match(r.stderr, /worktree is not clean/);
  assert.ok(fs.existsSync(f.worktrees['T-02']));
});

test('a stale registration owned by a Paseo workspace is archived, never removed by git', () => {
  const f = fixture({ staleFor: 'T-03', paseoWorkspaceFor: 'T-03' });
  const report = discover(f);
  const owned = report.objects.filter((object) => object.kind === 'paseo-workspace');
  assert.equal(owned.length, 1);
  assert.equal(owned[0].id, 'wks_t03');
  assert.equal(owned[0].command, 'paseo workspace archive wks_t03');
  assert.equal(owned[0].path, f.worktrees['T-03']);
  assert.ok(!report.objects.some((object) => object.path === owned[0].path && object.kind === 'git-worktree'));
  // The directory is gone, but the Paseo record must still be archived.
  approve(f, report.objects);
  const r = cleanup(f, '--execute', '--json');
  const listed = JSON.parse(r.stdout).objects.find((object) => object.kind === 'paseo-workspace');
  assert.equal(listed.status, 'done', r.out);
  assert.ok(!registered(f, owned[0].path));
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
  const stale = report.objects.filter((object) => object.kind === 'git-worktree' && !fs.existsSync(object.path));
  assert.deepEqual(stale.map((object) => object.id).sort(), [first, second].sort());
  assert.equal(new Set(stale.map((object) => object.command)).size, 2);
  // Approving one removes only that registration; the other stays.
  approve(f, report.objects, (object) => object.id !== first);
  const r = cleanup(f, '--execute', '--json');
  assert.equal(r.status, 5, r.out);
  const listed = JSON.parse(r.stdout).objects.filter((object) => stale.some((item) => item.id === object.id));
  assert.equal(listed.find((object) => object.id === second).status, 'done');
  assert.equal(listed.find((object) => object.id === first).status, 'unapproved');
  assert.ok(!registered(f, second));
  assert.ok(registered(f, first));
});

test('a stale registration owned by another change is never offered', () => {
  const f = fixture();
  const foreign = path.join(f.root, '..', `${path.basename(f.root)}-foreign`);
  git(f.root, 'worktree', 'add', '-q', '-b', 'feature/other', foreign);
  fs.rmSync(foreign, { recursive: true, force: true });
  const report = discover(f);
  assert.ok(!report.objects.some((object) => object.path === foreign));
  assert.ok(!report.objects.some((object) => !/^(git worktree remove |paseo workspace archive |git branch -d )/.test(object.command)));
});

test('a background Paseo workspace still owns its worktree', () => {
  const f = fixture({ paseoWorkspaceFor: 'T-01', background: true });
  const report = discover(f);
  const owned = report.objects.filter((object) => object.kind === 'paseo-workspace');
  assert.equal(owned.length, 1);
  assert.equal(fs.realpathSync(owned[0].path), fs.realpathSync(f.worktrees['T-01']));
  assert.ok(!report.objects.some((object) => object.kind === 'git-worktree' && fs.realpathSync(object.path) === fs.realpathSync(f.worktrees['T-01'])));
});

test('backtick-wrapped and unquoted values are the same literal command', () => {
  const f = fixture();
  const report = discover(f);
  const branch = report.objects.find((object) => object.kind === 'branch' && object.id === 'integration/chg');
  for (const value of [branch.command, `\`${branch.command}\``]) {
    approveRaw(f, ['Object: integration/chg', `Command: ${value}`]);
    assert.equal(discover(f).objects.find((object) => object.id === 'integration/chg').approved, true, value);
  }
});

test('an unmatched backtick makes the field unparseable', () => {
  const f = fixture();
  const report = discover(f);
  const branch = report.objects.find((object) => object.kind === 'branch' && object.id === 'integration/chg');
  for (const value of [`\`${branch.command}`, `${branch.command}\``]) {
    approveRaw(f, ['Object: integration/chg', `Command: ${value}`]);
    assert.equal(discover(f).objects.find((object) => object.id === 'integration/chg').approved, false, value);
    // An unmatched backtick on the Object line is just as unparseable.
    approveRaw(f, [`Object: \`integration/chg`, `Command: ${branch.command}`]);
    assert.equal(discover(f).objects.find((object) => object.id === 'integration/chg').approved, false, value);
  }
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
  const r = run(f, ['cleanup', archived, '--execute']);
  assert.equal(r.status, 3, r.out);
  assert.match(r.stderr, /looks archived/);
  assert.match(r.stderr, /openspec archive/);
  assert.match(r.stderr, /--change <name>/);
  // Nothing ran.
  assert.ok(fs.existsSync(f.worktrees['T-01']));
});

test('--change <name> lets cleanup run from the archived directory', () => {
  const f = fixture();
  const archived = archiveChange(f);
  assert.equal(run(f, ['cleanup', archived, '--change', CHANGE, '--json']).status, 0);
  // The approval was written before archiving; the archived file still holds it.
  approve({ ...f, changeDir: archived }, JSON.parse(run(f, ['cleanup', archived, '--change', CHANGE, '--json']).stdout).objects);
  const r = run(f, ['cleanup', archived, '--change', CHANGE, '--execute', '--json']);
  assert.equal(r.status, 0, r.out);
  assert.ok(!fs.existsSync(f.worktrees['T-01']));
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

test('an archived directory cannot authorize a different change name', () => {
  const f = fixture();
  const report = discover(f);
  approve(f, report.objects);
  // An archive of another change, carrying a run-log that still approves this change's objects.
  const foreign = path.join(f.root, 'openspec', 'changes', 'archive', `2026-11-08-other`);
  fs.mkdirSync(path.dirname(foreign), { recursive: true });
  fs.cpSync(f.changeDir, foreign, { recursive: true });
  const r = run(f, ['cleanup', foreign, '--change', CHANGE, '--execute']);
  assert.equal(r.status, 2, r.out);
  assert.match(r.stderr, /does not name/);
  // Nothing ran: not one worktree, not one branch.
  assert.ok(fs.existsSync(f.worktrees['T-01']));
  assert.ok(fs.existsSync(f.worktrees['T-02']));
  assert.ok(git(f.root, 'rev-parse', '--verify', 'refs/heads/integration/chg'));
  assert.ok(git(f.root, 'rev-parse', '--verify', 'refs/heads/task/chg/T-01'));
  // The pre-archive reconstruction used by checkPreconditions holds the same invariant.
  const refusal = checkPreconditions({ cwd: f.root, changeDir: foreign, change: CHANGE, objects: [], base: 'main' });
  assert.equal(refusal.code, 4);
  assert.match(refusal.message, /cannot read tasks.md/);
});

test('a dated basename inside archive/ is never a live change name', () => {
  const f = fixture();
  const archived = archiveChange(f);
  // A later, unrelated change is literally named like the archived directory. Its integration
  // branch points at a commit holding the archived Done contract at this same path, so the
  // misbinding below would pass every precondition and delete that change's branch.
  const later = `2026-11-08-${CHANGE}`;
  git(f.root, 'add', 'openspec/changes/archive');
  git(f.root, 'commit', '-qm', 'archive chg');
  git(f.root, 'branch', `integration/${later}`, git(f.root, 'rev-parse', 'HEAD'));
  git(f.root, 'branch', `task/${later}/T-01`, git(f.root, 'rev-parse', 'HEAD'));
  // The archived chg run-log approves the later change's own task branch.
  fs.appendFileSync(path.join(archived, 'run-log.md'),
    `Approval: 2026-11-07T00:00:00Z clean up\nObject: task/${later}/T-01\nCommand: git branch -d task/${later}/T-01\n`);
  const r = run(f, ['cleanup', archived, '--change', later, '--execute', '--json']);
  assert.equal(r.status, 2, r.out);
  assert.match(r.stderr, /does not name/);
  // Neither of the later change's branches, nor chg's own worktrees, was touched.
  assert.ok(git(f.root, 'rev-parse', '--verify', `refs/heads/task/${later}/T-01`));
  assert.ok(git(f.root, 'rev-parse', '--verify', `refs/heads/integration/${later}`));
  assert.ok(fs.existsSync(f.worktrees['T-01']));
  assert.ok(fs.existsSync(f.worktrees['T-02']));
  assert.ok(git(f.root, 'rev-parse', '--verify', 'refs/heads/integration/chg'));
});

/**
 * Write a repository whose `chg` contract is Done and whose run-log approves deleting
 * `task/chg/T-01` — an object that only exists in the fixture's repository.
 */
function approvingOtherRepo(dir) {
  write(dir, `openspec/changes/${CHANGE}/tasks.md`, TASKS_DONE);
  write(dir, `openspec/changes/${CHANGE}/run-log.md`,
    `Approval: 2026-11-07T00:00:00Z clean up\nObject: task/${CHANGE}/T-01\nCommand: git branch -d task/${CHANGE}/T-01\n`);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'contract');
  return path.join(dir, 'openspec', 'changes', CHANGE);
}

test('cleanup never acts on a repository other than the one it was run from', () => {
  // Repo A: an open task and its own task/chg/T-01 branch.
  const f = fixture({ tasks: TASKS_OPEN });
  // Repo B: same change name, all Done, and an approval for `task/chg/T-01`, which only exists
  // in A. Reading B's contract and approval to delete A's branch is the failure this guards.
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-other-'));
  const otherDir = approvingOtherRepo(other);
  const r = run(f, ['cleanup', otherDir, '--execute', '--json']);
  assert.equal(r.status, 2, r.out);
  assert.match(r.stderr, /belongs to a different repository/);
  // The message names both directories and both identities, so the operator sees the refusal.
  assert.ok(r.stderr.includes(otherDir), r.stderr);
  assert.ok(r.stderr.includes(f.root), r.stderr);
  // Nothing from either repository ran.
  assert.ok(git(f.root, 'rev-parse', '--verify', `refs/heads/task/${CHANGE}/T-01`));
  assert.ok(fs.existsSync(f.worktrees['T-01']));
});

test('a nested repository is a different repository, not a directory inside this one', () => {
  // Repo A: an open task and its own task/chg/T-01 branch.
  const f = fixture({ tasks: TASKS_OPEN });
  // Repo B nested inside A: same change name, all Done, approving A's `task/chg/T-01`. Its
  // path is inside A's toplevel, so only repository identity can tell them apart.
  const nested = path.join(f.root, 'vendor', 'nested');
  fs.mkdirSync(nested, { recursive: true });
  const nestedDir = approvingOtherRepo(nested);
  assert.notEqual(git(nested, 'rev-parse', '--path-format=absolute', '--git-common-dir'),
    git(f.root, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
  const r = run(f, ['cleanup', nestedDir, '--execute', '--json']);
  assert.equal(r.status, 2, r.out);
  assert.match(r.stderr, /belongs to a different repository/);
  assert.ok(git(f.root, 'rev-parse', '--verify', `refs/heads/task/${CHANGE}/T-01`));
  assert.ok(fs.existsSync(f.worktrees['T-01']));
  // From its own repository the nested change directory is legitimate.
  const nestedRun = spawnSync('node', [script, 'cleanup', nestedDir, '--json'], { cwd: nested, env: f.localEnv, encoding: 'utf8' });
  assert.equal(nestedRun.status, 0, `${nestedRun.stdout}${nestedRun.stderr}`);
  assert.equal(JSON.parse(nestedRun.stdout).change, CHANGE);
});

test('an EEXIST race at seeding re-derives approval state before executing', () => {
  const f = fixture();
  const report = discover(f);
  approve(f, report.objects, () => true, { onIntegration: true });
  fs.rmSync(path.join(f.changeDir, 'run-log.md'));
  assert.equal(discover(f).approvalSource, 'integration');
  // Make the worktree run-log appear only after the integration fallback was read: a git
  // fsmonitor hook runs during the precondition `git status` and creates it empty of approvals.
  const runLog = path.join(f.changeDir, 'run-log.md');
  const hook = path.join(os.tmpdir(), `cleanup-fsmonitor-${process.pid}-${Date.now()}.sh`);
  fs.writeFileSync(hook, `#!/bin/sh\n[ -e '${runLog}' ] || printf '# log\\n' > '${runLog}'\nexit 1\n`);
  fs.chmodSync(hook, 0o755);
  git(f.root, 'config', 'core.fsmonitor', hook);
  let r;
  try { r = cleanup(f, '--execute', '--json'); }
  finally { git(f.root, 'config', '--unset', 'core.fsmonitor'); }
  // The file that won the race holds no approval, so the run refuses instead of executing
  // the integration approvals it no longer sat on.
  assert.equal(r.status, 5, r.out);
  assert.match(r.stderr, /no object has a matching recorded Approval/);
  const listed = JSON.parse(r.stdout);
  assert.equal(listed.exit, 5);
  assert.equal(listed.approvalSource, 'worktree');
  for (const object of listed.objects) {
    assert.equal(object.approved, false, object.id);
    assert.equal(object.status, 'unapproved', object.id);
  }
  assert.equal(fs.readFileSync(runLog, 'utf8'), '# log\n');
  assert.ok(fs.existsSync(f.worktrees['T-01']));
  assert.ok(fs.existsSync(f.worktrees['T-02']));
  assert.ok(git(f.root, 'rev-parse', '--verify', 'refs/heads/integration/chg'));
});

test('an absent integration branch with no recorded tip refuses even with --merged-at', () => {
  const f = fixture();
  const report = discover(f);
  approve(f, report.objects);
  dropBranch(f, `integration/${CHANGE}`);
  const r = cleanup(f, '--execute', '--merged-at', git(f.root, 'rev-parse', 'main'));
  assert.equal(r.status, 4, r.out);
  assert.match(r.stderr, /no Cleanup record holds its tip/);
  assert.ok(fs.existsSync(f.worktrees['T-01']));
});

test('an absent integration branch refuses --merged-at main even when a tip was recorded', () => {
  const f = fixture();
  const report = discover(f);
  approve(f, report.objects);
  const tip = git(f.root, 'rev-parse', `integration/${CHANGE}`);
  const earlier = git(f.root, 'rev-parse', 'HEAD~1');
  dropBranch(f, `integration/${CHANGE}`);
  recordBranchCleanup(f, tip);
  const r = cleanup(f, '--execute', '--merged-at', earlier);
  assert.equal(r.status, 4, r.out);
  assert.match(r.stderr, /is not the recorded integration\/chg tip/);
  assert.ok(fs.existsSync(f.worktrees['T-01']));
});

test('an absent integration branch refuses a recorded tip that is not an ancestor of base', () => {
  const f = fixture();
  const report = discover(f);
  approve(f, report.objects);
  const unlanded = git(f.root, 'commit-tree', git(f.root, 'rev-parse', 'HEAD^{tree}'), '-p', 'HEAD', '-m', 'unlanded');
  dropBranch(f, `integration/${CHANGE}`);
  recordBranchCleanup(f, unlanded);
  const r = cleanup(f, '--execute', '--merged-at', unlanded);
  assert.equal(r.status, 4, r.out);
  assert.match(r.stderr, /is not an ancestor of main/);
  assert.ok(fs.existsSync(f.worktrees['T-01']));
});

test('an absent integration branch proceeds with the recorded tip that is an ancestor', () => {
  const f = fixture();
  const report = discover(f);
  approve(f, report.objects);
  const tip = git(f.root, 'rev-parse', `integration/${CHANGE}`);
  dropBranch(f, `integration/${CHANGE}`);
  recordBranchCleanup(f, tip);
  const r = cleanup(f, '--execute', '--merged-at', tip, '--json');
  assert.equal(r.status, 0, r.out);
  assert.ok(!fs.existsSync(f.worktrees['T-01']));
});

test('deleting the integration branch records its tip for the next run', () => {
  const f = fixture();
  const report = discover(f);
  approve(f, report.objects);
  const tip = git(f.root, 'rev-parse', `integration/${CHANGE}`);
  assert.equal(cleanup(f, '--execute').status, 0);
  const log = fs.readFileSync(path.join(f.changeDir, 'run-log.md'), 'utf8');
  assert.match(log, new RegExp(`^Cleanup: branch integration/${CHANGE} git branch -d integration/${CHANGE} done @${tip}$`, 'm'));
});
