import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../r0-hotspots.mjs', import.meta.url));
function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r0-hotspots-'));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return dir;
}
const run = (dir) => spawnSync(process.execPath, [script, dir], { encoding: 'utf8' });
const tasks = `- [ ] T-1 contract\n  - Write scope: src/a\n  - Interface: src/a#foo\n  - Risk surface: security, persistence\n  - Verify with: touch SHOULD_NOT_EXIST\n- [ ] T-2 consumer\n  - Write scope: src/b\n  - Uses: T-1\n  - Verify with: node test.mjs\n`;

test('summarizes declared metadata deterministically without executing commands', () => {
  const dir = fixture({ 'tasks.md': tasks, 'specs/z/spec.md': '## REMOVED Requirements\n### Requirement: Old\n', 'specs/a/spec.md': '## MODIFIED Requirements\n### Requirement: New\n```md\n### Requirement: Example\n## REMOVED Requirements\n```\n### Requirement: Other\n## ADDED Requirements\n### Requirement: Added\n' });
  fs.writeFileSync(path.join(dir, 'tasks.md'), tasks.replace('touch SHOULD_NOT_EXIST', `touch ${path.join(dir, 'SHOULD_NOT_EXIST')}`));
  const result = run(dir);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, run(dir).stdout);
  const report = JSON.parse(result.stdout);
  assert.match(report.notice, /unbound worktree draft/i);
  assert.deepEqual(report.tasks[0].interface, ['src/a#foo']);
  assert.deepEqual(report.tasks[0].riskSurface, ['security', 'persistence']);
  assert.equal(report.tasks[0].verify, `touch ${path.join(dir, 'SHOULD_NOT_EXIST')}`);
  assert.deepEqual(report.tasks[1].uses, ['T-1']);
  assert.deepEqual(report.requirements.map(({ change, requirement }) => [change, requirement]), [['MODIFIED', 'New'], ['MODIFIED', 'Other'], ['REMOVED', 'Old']]);
  assert.equal(fs.existsSync(path.join(dir, 'SHOULD_NOT_EXIST')), false);
});

test('reports parse errors and refuses missing specs and symlinks', () => {
  const dir = fixture({ 'tasks.md': tasks.replace('Uses: T-1', 'Uses: T-99'), 'specs/a/spec.md': '## ADDED Requirements\n' });
  const result = run(dir);
  assert.equal(result.status, 1);
  assert.ok(JSON.parse(result.stdout).errors.some((error) => error.code === 'USES_UNKNOWN'));
  assert.equal(run(fixture({ 'tasks.md': tasks })).status, 2);
  fs.symlinkSync(path.join(dir, 'tasks.md'), path.join(dir, 'specs/a/link'));
  assert.equal(run(dir).status, 2);
});

function git(dir, ...args) {
  const result = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function finalRepo(integratedTasks) {
  const dir = fixture({ 'openspec/changes/demo/tasks.md': tasks });
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'base');
  const main = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-b', 'integration/demo');
  fs.writeFileSync(path.join(dir, 'openspec/changes/demo/tasks.md'), integratedTasks);
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'integrated');
  const sha = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', 'main');
  return { dir, sha, main, change: path.join(dir, 'openspec/changes/demo') };
}
function runFinal(repo, sha = repo.sha, change = repo.change) {
  return spawnSync(process.execPath, [script, change, '--final', sha], { cwd: repo.dir, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
}

test('FINAL reads exact integration commit despite divergent and dirty checkout', () => {
  const integrated = tasks.replace('- [ ] T-1 contract', '- [x] T-1 integrated').replace('  - Verify with: touch SHOULD_NOT_EXIST', '  - Verify with: touch SHOULD_NOT_EXIST\n  - Done: source=abcdef1 review=pass(abcdef1@abcdef1/abcdef2)').replace('  - Uses: T-1', '  - Uses: T-1\n  - Scenarios: SCEN-UI-01\n  - Reads: src/shared\n  - Review: mechanical');
  const repo = finalRepo(integrated);
  fs.writeFileSync(path.join(repo.change, 'tasks.md'), 'dirty counterfeit');
  const result = runFinal(repo);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, runFinal(repo).stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.sha, repo.sha);
  assert.equal(report.source, 'openspec/changes/demo/tasks.md');
  assert.equal(report.tasks[0].checked, true);
  assert.deepEqual(report.tasks[0].done, { source: 'abcdef1', review: 'pass(abcdef1@abcdef1/abcdef2)' });
  assert.equal(report.tasks[0].title, 'integrated');
  assert.equal(report.tasks[1].line, 7);
  assert.deepEqual(report.tasks[1].scenarios, ['SCEN-UI-01']);
  assert.deepEqual(report.tasks[1].scope, ['src/b']);
  assert.deepEqual(report.tasks[1].reads, ['src/shared']);
  assert.deepEqual(report.tasks[1].uses, ['T-1']);
  assert.equal(report.tasks[1].review, 'mechanical');
  assert.deepEqual(report.tasks[0].riskSurface, ['security', 'persistence']);
  assert.deepEqual(report.tasks[0].interface, ['src/a#foo']);
  assert.match(report.notice, /cross-task/i);
  assert.match(report.notice, /undeclared/i);
  assert.match(report.notice, /mechanical/i);
  assert.equal(Object.hasOwn(report.tasks[1], 'ui'), false);
  assert.equal(fs.existsSync(path.join(repo.dir, 'SHOULD_NOT_EXIST')), false);
});

test('FINAL rejects wrong or abbreviated SHA and unsafe paths; exposes parser errors', () => {
  const repo = finalRepo(tasks.replace('Uses: T-1', 'Uses: T-99'));
  const result = runFinal(repo);
  assert.equal(result.status, 1, result.stderr);
  assert.ok(JSON.parse(result.stdout).errors.some((error) => error.code === 'USES_UNKNOWN'));
  assert.equal(runFinal(repo, repo.main).status, 2);
  assert.equal(runFinal(repo, repo.sha.slice(0, 7)).status, 2);
  assert.equal(runFinal(repo, 'a'.repeat(40)).status, 2);
  assert.equal(runFinal(repo, repo.sha, repo.dir).status, 2);
});

test('FINAL writes complete large output through a pipe', () => {
  const many = Array.from({ length: 5000 }, (_, i) => `- [ ] T-${i + 1} task ${i}\n  - Write scope: src/${i}\n  - Verify with: true\n`).join('');
  const repo = finalRepo(many);
  const result = runFinal(repo);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.length > 1024 * 1024);
  assert.equal(JSON.parse(result.stdout).tasks.length, 5000);
});

test('FINAL rejects a changed integration ref and a committed symlink tasks file', () => {
  const repo = finalRepo(tasks.replace('T-1 contract', 'T-1 integrated'));
  git(repo.dir, 'branch', '-f', 'integration/demo', repo.main);
  assert.equal(runFinal(repo).status, 2);
  git(repo.dir, 'checkout', '-b', 'integration/linked');
  fs.mkdirSync(path.join(repo.dir, 'openspec/changes/linked'), { recursive: true });
  fs.symlinkSync('../demo/tasks.md', path.join(repo.dir, 'openspec/changes/linked/tasks.md'));
  git(repo.dir, 'add', '.');
  git(repo.dir, 'commit', '-m', 'symlink');
  const sha = git(repo.dir, 'rev-parse', 'HEAD');
  assert.equal(runFinal(repo, sha, path.join(repo.dir, 'openspec/changes/linked')).status, 2);
});

test('FINAL names a missing integration branch instead of leaking raw Git output', () => {
  const repo = finalRepo(tasks.replace('T-1 contract', 'T-1 integrated'));
  git(repo.dir, 'branch', '-D', 'integration/demo');
  const result = runFinal(repo);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /does not exist/);
});
