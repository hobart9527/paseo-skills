import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../merge-task.mjs', import.meta.url));
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const AGENTS = JSON.stringify([
  { id: 'testagent123', provider: 'codex/gpt' },
  { id: 'abc12345', provider: 'claude/flash' },
  { id: '12345678', provider: 'claude/cc' },
]);
function installPaseo(cwd, agents = AGENTS) {
  const bin = path.join(os.tmpdir(), `merge-bin-${path.basename(cwd)}`); fs.mkdirSync(bin, { recursive: true });
  const exe = path.join(bin, 'paseo'); fs.writeFileSync(exe, `#!/bin/sh\nprintf '%s' '${Buffer.from(typeof agents === 'string' ? agents : JSON.stringify(agents)).toString('base64')}' | base64 -d\nprintf '\\n'\n`); fs.chmodSync(exe, 0o755);
  return { ...env, PATH: `${bin}:${process.env.PATH}` };
}
function git(cwd, ...args) { const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); }
function write(cwd, file, text) { const p = path.join(cwd, file); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); }
let seq = 0;
const GREEN = `node -e "process.exit(require('fs').existsSync('src/a.txt')?0:1)"`;
function fixture({ outside = false, verify = GREEN } = {}) {
  const change = `c${++seq}`;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-'));
  git(cwd, 'init', '-q', '-b', 'main');
  write(cwd, `openspec/changes/${change}/tasks.md`, `- [ ] 1.1 T-01 task\n  - Write scope: src,test\n  - Verify with: ${verify}\n`);
  write(cwd, `openspec/changes/${change}/proposal.md`, 'p\n');
  write(cwd, `openspec/changes/${change}/acceptance.md`, 'a\n');
  git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'base'); git(cwd, 'switch', '-qc', `integration/${change}`);
  const base = git(cwd, 'rev-parse', 'HEAD'); git(cwd, 'switch', '-qc', `task/${change}/T-01`);
  write(cwd, 'test/a.test.js', 'assert behavior\n'); git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'red tests\n\nPipeline-Role: ceshi\nPipeline-Author: testagent123');
  write(cwd, outside ? 'outside.txt' : 'src/a.txt', 'a'); git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'work\n\nPipeline-Role: gongbu\nPipeline-Author: abc12345');
  const tip = git(cwd, 'rev-parse', 'HEAD'); git(cwd, 'switch', '-q', `integration/${change}`); installPaseo(cwd); return { cwd, change, base, tip };
}
function invoke(cwd, args, agents) { const r = spawnSync('node', [script, ...args], { cwd, env: installPaseo(cwd, agents), encoding: 'utf8' }); return { status: r.status, out: `${r.stdout}${r.stderr}` }; }
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
  if (!tasks.includes('Review: mechanical')) {
    write(cwd, 'test/a.test.js', 'assert behavior\n'); git(cwd, 'add', 'test');
    git(cwd, 'commit', '-qm', 'red tests\n\nPipeline-Role: ceshi\nPipeline-Author: testagent123');
  }
  installPaseo(cwd);
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

test('rejects test author and implementer using same Paseo model', () => {
  const f = fixture();
  const sameModel = [
    { id: 'testagent123', provider: 'codex/gpt' },
    { id: 'abc12345', provider: 'codex/gpt' },
    { id: '12345678', provider: 'claude/cc' },
  ];
  const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', tag(f)], sameModel);
  assert.equal(r.status, 32, r.out);
  assert.match(r.out, /different models/);
});

test('rejects unresolved author identity/model', () => {
  const f = fixture();
  const missing = [{ id: 'testagent123', provider: 'codex/gpt' }, { id: '12345678', provider: 'claude/cc' }];
  const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', tag(f)], missing);
  assert.equal(r.status, 32, r.out);
  assert.match(r.out, /cannot resolve test-author\/implementer model/);
});
test('rejects failed frozen verify', () => {
  const f = fixture({ verify: 'node -e "process.exit(1)"' }); const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', tag(f)]);
  assert.equal(r.status, 20, r.out);
});

test('failed verify leaves integration clean and allows retry', () => {
  const tasks = `- [ ] T-01 work\n  - Write scope: src,test\n  - Verify with: node -e "process.exit(require('fs').existsSync('src/a.txt')&&require('fs').readFileSync('src/a.txt','utf8')==='fixed'?0:1)"\n`;
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
  write(f.cwd, `openspec/changes/${f.change}/proposal.md`, 'p2\n');
  git(f.cwd, 'add', '.'); git(f.cwd, 'commit', '-qm', 'contract fix');
  const retryBase = git(f.cwd, 'rev-parse', 'HEAD');
  git(f.cwd, 'switch', '-q', `task/${f.change}/T-01`);
  git(f.cwd, 'rebase', '-q', `integration/${f.change}`);
  const retryTip = git(f.cwd, 'rev-parse', 'HEAD'); git(f.cwd, 'switch', '-q', `integration/${f.change}`);
  const retry = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', `pass(12345678@${retryTip.slice(0, 7)}/${retryBase.slice(0, 7)})`]);
  assert.equal(retry.status, 0, retry.out);
  assert.match(fs.readFileSync(path.join(f.cwd, `openspec/changes/${f.change}/tasks.md`), 'utf8'), /- \[x\].*T-01/);
});
test('marks exact task ID, not substring ID', () => {
  const tasks = `- [ ] T-010 other\n  - Write scope: other\n  - Review: mechanical\n  - Verify with: true\n- [ ] T-01 target\n  - Write scope: src,test\n  - Verify with: ${GREEN}\n`;
  const f = taggedFixture(tasks);
  write(f.cwd, 'test/target.test.js', 'assert target\n'); git(f.cwd, 'add', 'test'); git(f.cwd, 'commit', '-qm', 'red\n\nPipeline-Role: ceshi\nPipeline-Author: testagent123');
  write(f.cwd, 'src/a.txt', 'target');
  git(f.cwd, 'add', 'src/a.txt'); git(f.cwd, 'commit', '-qm', 'target\n\nPipeline-Role: gongbu\nPipeline-Author: abc12345');
  const tip = git(f.cwd, 'rev-parse', 'HEAD'); git(f.cwd, 'switch', '-q', `integration/${f.change}`);
  const result = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', `pass(12345678@${tip.slice(0, 7)}/${f.base.slice(0, 7)})`]);
  assert.equal(result.status, 0, result.out);
  const text = fs.readFileSync(path.join(f.cwd, `openspec/changes/${f.change}/tasks.md`), 'utf8');
  assert.match(text, /^- \[ \] T-010 other[\s\S]*?- \[x\] T-01 target/m);
  assert.doesNotMatch(text, /- \[x\] T-010/);
});
test('accepts unquoted review tag as a shell argument', () => {
  const f = fixture();
  const unquoted = `pass(12345678@${f.tip.slice(0, 7)}/${f.base.slice(0, 7)})`;
  const direct = spawnSync('node', [script, `task/${f.change}/T-01`, 'T-01', unquoted], { cwd: f.cwd, env: installPaseo(f.cwd), encoding: 'utf8' });
  assert.equal(direct.status, 0, direct.stdout + direct.stderr);
});

function build(commits, { review } = {}) {
  const tasks = `- [ ] T-01 task\n  - Write scope: src,test\n${review ? `  - Review: ${review}\n` : ''}  - Verify with: ${review ? 'true' : GREEN}\n`;
  const f = taggedFixture(tasks);
  if (!review) git(f.cwd, 'reset', '-q', '--hard', f.base); // drop default tester commit; commits define history
  for (const [file, text, role, author] of commits) {
    write(f.cwd, file, text); git(f.cwd, 'add', '.');
    git(f.cwd, 'commit', '-qm', `c\n\nPipeline-Role: ${role}\nPipeline-Author: ${author}`);
  }
  const tip = git(f.cwd, 'rev-parse', 'HEAD'); git(f.cwd, 'switch', '-q', `integration/${f.change}`);
  return { ...f, tip };
}
const run3 = (f, reviewer = '12345678') => invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', `pass(${reviewer}@${f.tip.slice(0, 7)}/${f.base.slice(0, 7)})`]);

test('rejects when test author and implementer are the same agent', () => {
  const agents = [{ id: 'abc12345', provider: 'codex/gpt' }, { id: '12345678', provider: 'claude/cc' }];
  const f = build([['test/a.test.js', 't', 'ceshi', 'abc12345'], ['src/a.txt', 'a', 'gongbu', 'abc12345']]);
  const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', `pass(12345678@${f.tip.slice(0, 7)}/${f.base.slice(0, 7)})`], agents);
  assert.equal(r.status, 32, r.out); assert.match(r.out, /different agents/);
});
test('rejects implementer modifying test-author files', () => {
  const f = build([['test/a.test.js', 't', 'ceshi', 'testagent123'], ['test/a.test.js', 'edited', 'gongbu', 'abc12345']]);
  const r = run3(f); assert.equal(r.status, 30, r.out); assert.match(r.out, /modifies test-author files/);
});
test('rejects test author changing non-test paths', () => {
  const f = build([['src/a.txt', 'a', 'ceshi', 'testagent123'], ['src/b.txt', 'b', 'gongbu', 'abc12345']]);
  const r = run3(f); assert.equal(r.status, 30, r.out); assert.match(r.out, /non-test files/);
});
test('rejects reviewer sharing implementer model', () => {
  const agents = [{ id: 'testagent123', provider: 'codex/gpt' }, { id: 'abc12345', provider: 'claude/flash' }, { id: '12345678', provider: 'claude/flash' }];
  const f = build([['test/a.test.js', 't', 'ceshi', 'testagent123'], ['src/a.txt', 'a', 'gongbu', 'abc12345']]);
  const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', `pass(12345678@${f.tip.slice(0, 7)}/${f.base.slice(0, 7)})`], agents);
  assert.equal(r.status, 32, r.out); assert.match(r.out, /reviewer and implementer must use different models/);
});
test('rejects behavior task lacking ceshi commit', () => {
  const f = build([['src/a.txt', 'a', 'gongbu', 'abc12345']]);
  const r = run3(f); assert.equal(r.status, 31, r.out);
});
test('mechanical task is exempt from tester and model checks', () => {
  const f = build([['src/a.txt', 'a', 'gongbu', 'abc12345']], { review: 'mechanical' });
  const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', `pass(mechanical@${f.tip.slice(0, 7)}/${f.base.slice(0, 7)})`], []);
  assert.equal(r.status, 0, r.out);
});

test('warns when reviewer shares model with test author but still merges', () => {
  const agents = [{ id: 'testagent123', provider: 'codex/gpt' }, { id: 'abc12345', provider: 'claude/flash' }, { id: '12345678', provider: 'codex/gpt' }];
  const f = build([['test/a.test.js', 't', 'ceshi', 'testagent123'], ['src/a.txt', 'a', 'gongbu', 'abc12345']]);
  const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', `pass(12345678@${f.tip.slice(0, 7)}/${f.base.slice(0, 7)})`], agents);
  assert.equal(r.status, 0, r.out); assert.match(r.out, /WARN reviewer shares model/);
});

test('rejects merge that regresses an already-Done task (exit 21) and leaves tree clean', () => {
  const tasks = '- [x] T-00 prior\n  - Write scope: src\n  - Review: mechanical\n  - Verify with: node -e "process.exit(require(\'fs\').existsSync(\'src/poison.txt\')?1:0)"\n  - Done: source=abcdef1 review=pass(mechanical@abcdef1/abcdef1)\n- [ ] T-01 target\n  - Write scope: src,test\n  - Verify with: node -e "process.exit(require(\'fs\').existsSync(\'src/poison.txt\')?0:1)"\n';
  const f = taggedFixture(tasks);
  write(f.cwd, 'test/a.test.js', 'assert behavior\n'); git(f.cwd, 'add', 'test'); git(f.cwd, 'commit', '-qm', 'red\n\nPipeline-Role: ceshi\nPipeline-Author: testagent123');
  write(f.cwd, 'src/poison.txt', 'x'); git(f.cwd, 'add', 'src'); git(f.cwd, 'commit', '-qm', 'w\n\nPipeline-Role: gongbu\nPipeline-Author: abc12345');
  const tip = git(f.cwd, 'rev-parse', 'HEAD'); git(f.cwd, 'switch', '-q', `integration/${f.change}`);
  const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', `pass(12345678@${tip.slice(0, 7)}/${f.base.slice(0, 7)})`]);
  assert.equal(r.status, 21, r.out); assert.match(r.out, /regress already-Done T-00/);
  assert.equal(git(f.cwd, 'status', '--porcelain'), '');
});

test('rejects when Verify already passes on the test-author commit (no Red)', () => {
  const f = build([['test/a.test.js', 't', 'ceshi', 'testagent123'], ['src/a.txt', 'a', 'gongbu', 'abc12345']]);
  git(f.cwd, 'switch', '-q', 'main');
  const tasksPath = `openspec/changes/${f.change}/tasks.md`;
  git(f.cwd, 'switch', '-q', `integration/${f.change}`);
  fs.writeFileSync(path.join(f.cwd, tasksPath), fs.readFileSync(path.join(f.cwd, tasksPath), 'utf8').replace(/Verify with: .*/, 'Verify with: true'));
  git(f.cwd, 'add', '.'); git(f.cwd, 'commit', '-qm', 'always-green verify');
  git(f.cwd, 'switch', '-q', `task/${f.change}/T-01`); git(f.cwd, 'rebase', '-q', `integration/${f.change}`);
  const tip = git(f.cwd, 'rev-parse', 'HEAD'); git(f.cwd, 'switch', '-q', `integration/${f.change}`);
  const base = git(f.cwd, 'rev-parse', 'HEAD');
  const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', `pass(12345678@${tip.slice(0, 7)}/${base.slice(0, 7)})`]);
  assert.equal(r.status, 33, r.out); assert.match(r.out, /Red check/);
  assert.equal(git(f.cwd, 'status', '--porcelain'), '');
});
test('rejects when implementation commit precedes test-author commit', () => {
  const f = build([['src/a.txt', 'a', 'gongbu', 'abc12345'], ['test/a.test.js', 't', 'ceshi', 'testagent123']]);
  const r = run3(f); assert.equal(r.status, 31, r.out); assert.match(r.out, /must precede/);
});
