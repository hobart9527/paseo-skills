import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeObject } from '../lib/cleanup.mjs';

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
function fixture({ tasks = TASKS_DONE, integrated = true, paseoWorkspaceFor = null, background = false, prunableFor = null } = {}) {
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
  for (const id of ['T-01', 'T-02']) {
    const dir = path.join(root, '..', `${path.basename(root)}-${id}`);
    git(root, 'worktree', 'add', '-q', '-b', `task/${CHANGE}/${id}`, dir, integrationTip);
    worktrees[id] = dir;
  }
  if (prunableFor) {
    // A registration whose directory is gone: stale, and only this change owns it.
    const dir = path.join(root, '..', `${path.basename(root)}-${prunableFor}`);
    git(root, 'worktree', 'add', '-q', '-b', `task/${CHANGE}/${prunableFor}`, dir, integrationTip);
    fs.rmSync(dir, { recursive: true, force: true });
    worktrees[prunableFor] = dir;
  }
  git(root, 'switch', '-q', 'main');
  if (integrated) git(root, 'merge', '-q', '--ff-only', `integration/${CHANGE}`);
  const workspaces = [];
  if (paseoWorkspaceFor) {
    workspaces.push({ workspaceId: `wks_${paseoWorkspaceFor.toLowerCase().replace('-', '')}`, isolation: 'worktree', background, cwd: fs.realpathSync(worktrees[paseoWorkspaceFor]) });
  }
  return { root, changeDir, worktrees, integrationTip, integrated, localEnv: fakePaseo(root, root, workspaces) };
}

/** Simulate a branch deleted before CP-2 without ever using `git branch -D`. */
function dropBranch(f, branch) { git(f.root, 'update-ref', '-d', `refs/heads/${branch}`); }

function run(f, args) {
  const r = spawnSync('node', [script, ...args], { cwd: f.root, env: f.localEnv, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, out: `${r.stdout}${r.stderr}` };
}

const cleanup = (f, ...flags) => run(f, ['cleanup', f.changeDir, ...flags]);

/**
 * Record approvals the way a human does after CP-2: in the worktree run-log, uncommitted.
 * `onIntegration` writes only to the integration-branch copy instead (fallback path).
 */
function approve(f, objects, filter = () => true, { onIntegration = false } = {}) {
  const block = objects.filter(filter).map((object) => `Approval: 2026-11-07T00:00:00Z clean up ${object.id}\nObject: ${object.id} ${object.path ?? ''}\nCommand: ${object.command}\n`).join('\n');
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
  assert.match(defaultRun.stdout, /git-worktree task\/chg\/T-01/);
  assert.match(defaultRun.stdout, /git-worktree task\/chg\/T-02/);
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
  const onlyFirst = report.objects.filter((object) => object.id === 'task/chg/T-01');
  approve(f, onlyFirst);
  const r = cleanup(f, '--execute');
  assert.equal(r.status, 5, r.out);
  assert.match(r.out, /\[unapproved\] git-worktree task\/chg\/T-02/);
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
  assert.equal(log.match(/^Cleanup: .* done$/gm).length, report.objects.length);
});

test('an object already missing counts as done, not an error', () => {
  const f = fixture();
  const report = discover(f);
  approve(f, report.objects);
  const object = report.objects.find((item) => item.kind === 'git-worktree' && item.id === 'task/chg/T-01');
  const result = executeObject(object, { cwd: f.root });
  assert.equal(result.status, 'done');
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

test('approval commands must match exactly, not as a substring of a longer branch', () => {
  const f = fixture();
  const report = discover(f);
  const branch = report.objects.find((object) => object.kind === 'branch' && object.id === 'integration/chg');
  assert.equal(branch.command, 'git branch -d integration/chg');
  // A block naming the right branch token but a longer command must not authorize it.
  fs.writeFileSync(path.join(f.changeDir, 'run-log.md'),
    `${fs.readFileSync(path.join(f.changeDir, 'run-log.md'), 'utf8')}\nApproval: 2026-11-07T00:00:00Z cleanup old\nObject: integration/chg integration/chg-old\nCommand: git branch -d integration/chg-old\n`);
  const listing = discover(f);
  const listed = listing.objects.find((object) => object.kind === 'branch' && object.id === 'integration/chg');
  assert.equal(listed.approved, false);
  const r = cleanup(f, '--execute', '--json');
  assert.equal(r.status, 5, r.out);
  const listedAfter = JSON.parse(r.stdout).objects.find((object) => object.kind === 'branch' && object.id === 'integration/chg');
  assert.equal(listedAfter.status, 'unapproved');
  assert.equal(listedAfter.approved, false);
  assert.ok(git(f.root, 'rev-parse', '--verify', 'refs/heads/integration/chg'));
});

test('an exactly matching command line does authorize the object', () => {
  const f = fixture();
  const report = discover(f);
  const branch = report.objects.find((object) => object.kind === 'branch' && object.id === 'integration/chg');
  fs.writeFileSync(path.join(f.changeDir, 'run-log.md'),
    `${fs.readFileSync(path.join(f.changeDir, 'run-log.md'), 'utf8')}\nApproval: 2026-11-07T00:00:00Z cleanup\nObject: integration/chg\nCommand: \`${branch.command}\`.\n`);
  const listing = discover(f);
  assert.equal(listing.objects.find((object) => object.kind === 'branch' && object.id === 'integration/chg').approved, true);
});

test('git worktree prune is never implicit; a stale registration needs its own approval', () => {
  const f = fixture({ prunableFor: 'T-03' });
  const report = discover(f);
  const prune = report.objects.filter((object) => object.kind === 'worktree-prune');
  assert.equal(prune.length, 1);
  assert.equal(prune[0].command, 'git worktree prune');
  assert.equal(prune[0].id, prune[0].path);
  // Approve everything except the prune object: it must not run.
  approve(f, report.objects, (object) => object.kind !== 'worktree-prune');
  const r = cleanup(f, '--execute', '--json');
  assert.equal(r.status, 5, r.out);
  const listed = JSON.parse(r.stdout).objects.find((object) => object.kind === 'worktree-prune');
  assert.equal(listed.status, 'unapproved');
  const registered = git(f.root, 'worktree', 'list', '--porcelain');
  assert.match(registered, /prunable /);
  // Other changes' stale registrations are not even offered.
  assert.ok(!report.objects.some((object) => object.kind === 'worktree-prune' && object.id === '/tmp/not-ours'));
});

test('an approved prune runs once, after its own object is approved', () => {
  const f = fixture({ prunableFor: 'T-03' });
  const report = discover(f);
  approve(f, report.objects);
  const r = cleanup(f, '--execute', '--json');
  assert.equal(r.status, 0, r.out);
  const listed = JSON.parse(r.stdout).objects.find((object) => object.kind === 'worktree-prune');
  assert.equal(listed.status, 'done');
  assert.doesNotMatch(git(f.root, 'worktree', 'list', '--porcelain'), /prunable /);
});

test('a stale registration owned by another change is not offered for prune', () => {
  const f = fixture();
  const foreign = path.join(f.root, '..', `${path.basename(f.root)}-foreign`);
  git(f.root, 'worktree', 'add', '-q', '-b', 'feature/other', foreign);
  fs.rmSync(foreign, { recursive: true, force: true });
  const report = discover(f);
  assert.ok(!report.objects.some((object) => object.kind === 'worktree-prune'));
});

test('a background Paseo workspace still owns its worktree', () => {
  const f = fixture({ paseoWorkspaceFor: 'T-01', background: true });
  const report = discover(f);
  const owned = report.objects.filter((object) => object.kind === 'paseo-workspace');
  assert.equal(owned.length, 1);
  assert.equal(fs.realpathSync(owned[0].path), fs.realpathSync(f.worktrees['T-01']));
  assert.ok(!report.objects.some((object) => object.kind === 'git-worktree' && fs.realpathSync(object.path) === fs.realpathSync(f.worktrees['T-01'])));
});

test('an absent integration branch refuses without --merged-at', () => {
  const f = fixture();
  const report = discover(f);
  approve(f, report.objects);
  dropBranch(f, `integration/${CHANGE}`);
  const r = cleanup(f, '--execute');
  assert.equal(r.status, 4, r.out);
  assert.match(r.stderr, /--merged-at/);
  assert.ok(fs.existsSync(f.worktrees['T-01']));
});

test('an absent integration branch refuses a --merged-at that is not an ancestor of base', () => {
  const f = fixture();
  const report = discover(f);
  approve(f, report.objects);
  dropBranch(f, `integration/${CHANGE}`);
  const rogue = git(f.root, 'commit-tree', git(f.root, 'rev-parse', 'HEAD^{tree}'), '-p', 'HEAD', '-m', 'unlanded');
  const r = cleanup(f, '--execute', '--merged-at', rogue);
  assert.equal(r.status, 4, r.out);
  assert.match(r.stderr, /not an ancestor of main/);
  assert.ok(fs.existsSync(f.worktrees['T-01']));
});

test('an absent integration branch proceeds with an ancestor --merged-at', () => {
  const f = fixture();
  const report = discover(f);
  approve(f, report.objects);
  const landed = git(f.root, 'rev-parse', 'main');
  dropBranch(f, `integration/${CHANGE}`);
  const r = cleanup(f, '--execute', '--merged-at', landed, '--json');
  assert.equal(r.status, 0, r.out);
  assert.ok(!fs.existsSync(f.worktrees['T-01']));
});
