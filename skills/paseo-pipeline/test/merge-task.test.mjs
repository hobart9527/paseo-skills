import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../merge-task.mjs', import.meta.url));
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
function git(cwd, ...args) { const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); }
function write(cwd, file, text) { const p = path.join(cwd, file); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); }
let seq = 0;
function fixture({ outside = false, verify = 'node -e "0"' } = {}) {
  const change = `c${++seq}`;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-'));
  git(cwd, 'init', '-q', '-b', 'main');
  write(cwd, `openspec/changes/${change}/tasks.md`, `- [ ] 1.1 T-01 task\n  - Write scope: src,test\n  - Verify with: ${verify}\n`);
  write(cwd, `openspec/changes/${change}/proposal.md`, 'p\n');
  write(cwd, `openspec/changes/${change}/acceptance.md`, 'a\n');
  git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'base'); git(cwd, 'switch', '-qc', `integration/${change}`);
  const base = git(cwd, 'rev-parse', 'HEAD'); git(cwd, 'switch', '-qc', `task/${change}/T-01`);
  write(cwd, outside ? 'outside.txt' : 'src/a.txt', 'a'); git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'work\n\nPipeline-Role: gongbu\nPipeline-Author: abc12345');
  const tip = git(cwd, 'rev-parse', 'HEAD'); git(cwd, 'switch', '-q', `integration/${change}`); return { cwd, change, base, tip };
}
function invoke(cwd, args) { const r = spawnSync('node', [script, ...args], { cwd, env, encoding: 'utf8' }); return { status: r.status, out: `${r.stdout}${r.stderr}` }; }
const tag = (f) => `pass(12345678@${f.tip.slice(0, 7)}/${f.base.slice(0, 7)})`;
function taggedFixture(tasks) {
  const change = `c${++seq}`;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-'));
  git(cwd, 'init', '-q', '-b', 'main');
  write(cwd, `openspec/changes/${change}/tasks.md`, tasks);
  write(cwd, `openspec/changes/${change}/proposal.md`, 'p');
  write(cwd, `openspec/changes/${change}/acceptance.md`, 'a');
  git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'base'); git(cwd, 'switch', '-qc', `integration/${change}`);
  const base = git(cwd, 'rev-parse', 'HEAD'); git(cwd, 'switch', '-qc', `task/${change}/T-01`);
  return { cwd, change, base };
}
test('merges valid task and records Done', () => {
  const f = fixture(); const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', tag(f)]);
  assert.equal(r.status, 0, r.out);
  assert.match(fs.readFileSync(path.join(f.cwd, `openspec/changes/${f.change}/tasks.md`), 'utf8'), /\[x\][^\n]*T-01[^\n]*\n\s*- Done:/);
});
test('rejects scope violation', () => {
  const f = fixture({ outside: true }); const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', tag(f)]);
  assert.equal(r.status, 30, r.out);
});
test('rejects reviewer equals author', () => {
  const f = fixture(); const bad = `pass(abc12345@${f.tip.slice(0, 7)}/${f.base.slice(0, 7)})`;
  const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', bad]); assert.equal(r.status, 32, r.out);
});
test('rejects failed frozen verify', () => {
  const f = fixture({ verify: 'node -e "process.exit(1)"' }); const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', tag(f)]);
  assert.equal(r.status, 20, r.out);
});

test('failed verify leaves integration clean and allows retry', () => {
  const tasks = '- [ ] T-01 work\n  - Write scope: src\n  - Verify with: node -e "process.exit(1)"\n';
  const f = taggedFixture(tasks);
  fs.mkdirSync(path.join(f.cwd, 'src'), { recursive: true }); write(f.cwd, 'src/a.txt', 'a');
  git(f.cwd, 'add', 'src/a.txt'); git(f.cwd, 'commit', '-qm', 'work\n\nPipeline-Role: gongbu\nPipeline-Author: abc12345');
  const tip = git(f.cwd, 'rev-parse', 'HEAD'); git(f.cwd, 'switch', '-q', `integration/${f.change}`);
  const first = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', `pass(12345678@${tip.slice(0, 7)}/${f.base.slice(0, 7)})`]);
  assert.equal(first.status, 20, first.out);
  assert.equal(git(f.cwd, 'status', '--porcelain'), '');
  git(f.cwd, 'switch', '-q', `task/${f.change}/T-01`);
  write(f.cwd, 'src/a.txt', 'fixed'); git(f.cwd, 'add', 'src/a.txt'); git(f.cwd, 'commit', '-qm', 'fix\n\nPipeline-Role: gongbu\nPipeline-Author: abc12345');
  // Controlled contract amendment lands on integration and becomes the new review base.
  git(f.cwd, 'switch', '-q', `integration/${f.change}`);
  fs.writeFileSync(path.join(f.cwd, `openspec/changes/${f.change}/tasks.md`), tasks.replace('process.exit(1)', '0'));
  git(f.cwd, 'add', `openspec/changes/${f.change}/tasks.md`); git(f.cwd, 'commit', '-qm', 'contract fix');
  const retryBase = git(f.cwd, 'rev-parse', 'HEAD');
  git(f.cwd, 'switch', '-q', `task/${f.change}/T-01`);
  git(f.cwd, 'rebase', '-q', `integration/${f.change}`);
  const retryTip = git(f.cwd, 'rev-parse', 'HEAD'); git(f.cwd, 'switch', '-q', `integration/${f.change}`);
  const retry = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', `pass(12345678@${retryTip.slice(0, 7)}/${retryBase.slice(0, 7)})`]);
  assert.equal(retry.status, 0, retry.out);
  assert.match(fs.readFileSync(path.join(f.cwd, `openspec/changes/${f.change}/tasks.md`), 'utf8'), /- \[x\].*T-01/);
});
test('marks exact task ID, not substring ID', () => {
  const tasks = '- [ ] T-010 other\n  - Write scope: other\n  - Verify with: true\n- [ ] T-01 target\n  - Write scope: src\n  - Verify with: true\n';
  const f = taggedFixture(tasks);
  write(f.cwd, 'src/a.txt', 'target');
  git(f.cwd, 'add', 'src/a.txt'); git(f.cwd, 'commit', '-qm', 'target\n\nPipeline-Role: gongbu\nPipeline-Author: abc12345');
  const tip = git(f.cwd, 'rev-parse', 'HEAD'); git(f.cwd, 'switch', '-q', `integration/${f.change}`);
  const result = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', `pass(12345678@${tip.slice(0, 7)}/${f.base.slice(0, 7)})`]);
  assert.equal(result.status, 0, result.out);
  const text = fs.readFileSync(path.join(f.cwd, `openspec/changes/${f.change}/tasks.md`), 'utf8');
  assert.match(text, /^- \[ \] T-010 other\n  - Write scope: other\n  - Verify with: true\n- \[x\] T-01 target/m);
  assert.doesNotMatch(text, /- \[x\] T-010/);
});
test('accepts unquoted review tag as a shell argument', () => {
  const f = fixture();
  const unquoted = `pass(12345678@${f.tip.slice(0, 7)}/${f.base.slice(0, 7)})`;
  const direct = spawnSync('node', [script, `task/${f.change}/T-01`, 'T-01', unquoted], { cwd: f.cwd, env, encoding: 'utf8' });
  assert.equal(direct.status, 0, direct.stdout + direct.stderr);
});
