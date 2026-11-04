import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../pipeline-run.mjs', import.meta.url));
function fixture(command = 'printf hello', extra = '') {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-test-'));
  const repo = path.join(base, 'repo'); fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'integration/demo');
  git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test');
  const dir = path.join(repo, 'openspec/changes/demo'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'tasks.md'), 'fixture\n');
  fs.writeFileSync(path.join(dir, 'acceptance.md'), `# Acceptance\n| Scenario | Entry | Tasks | Verify | Required | Result | Evidence |\n| --- | --- | --- | --- | --- | --- | --- |\n| SCEN-1 | CLI | T-01 | ${command} | yes | PENDING | pending |\n${extra}`);
  git('add', '.'); git('commit', '-qm', 'contract');
  return { base, repo, dir, git, sha: git('rev-parse', 'HEAD') };
}
function invoke(f, action, evidence, options = []) {
  return spawnSync(process.execPath, [cli, 'acceptance', action, f.dir, '--evidence', evidence, ...options], { cwd: f.repo, encoding: 'utf8', timeout: 10000 });
}
const execute = (f, evidence, options = []) => invoke(f, 'run', evidence, ['--source', f.sha, '--execute', ...options]);

test('success, provenance, non-executing check, no overwrite, and rerun', () => {
  const f = fixture('printf hello', '| SCEN-2 | CLI | T-02 | touch should-not-run | no | PENDING | pending |\n');
  const evidence = path.join(f.base, 'first.json');
  assert.equal(execute(f, evidence).status, 0);
  const data = JSON.parse(fs.readFileSync(evidence));
  assert.equal(data.sourceSha, f.sha); assert.equal(data.timeoutMs, 120000); assert.equal(data.rows[0].stdout, 'hello');
  assert.match(data.matrix, /SCEN-2/); assert.equal(data.rows.length, 1);
  assert.equal(fs.existsSync(path.join(f.repo, 'should-not-run')), false);
  assert.equal(invoke(f, 'check', evidence).status, 0);
  assert.notEqual(execute(f, evidence).status, 0);
  assert.equal(execute(f, path.join(f.base, 'second.json')).status, 0);
  fs.writeFileSync(path.join(f.repo, 'dirty'), 'x');
  assert.notEqual(invoke(f, 'check', evidence).status, 0);
});

test('failure, timeout, missing executable and recovery are not PASS', () => {
  for (const command of ['exit 1', 'sleep 3', 'not-a-real-acceptance-command-482']) {
    const f = fixture(command), evidence = path.join(f.base, 'result.json');
    assert.notEqual(execute(f, evidence, ['--timeout', '100']).status, 0);
    const record = JSON.parse(fs.readFileSync(evidence));
    assert.equal(record.timeoutMs, 100);
    assert.equal(record.rows[0].result, 'FAIL');
    assert.notEqual(invoke(f, 'check', evidence).status, 0);
    record.valid = true; record.rows[0].result = 'BLOCKED';
    fs.writeFileSync(evidence, JSON.stringify(record));
    assert.notEqual(invoke(f, 'check', evidence).status, 0);
  }
});

test('drift invalidates execution for worktree and HEAD changes', () => {
  for (const command of ['touch dirty', 'git commit --allow-empty -qm drift']) {
    const f = fixture(command), evidence = path.join(f.base, 'result.json');
    assert.notEqual(execute(f, evidence).status, 0);
    assert.equal(JSON.parse(fs.readFileSync(evidence)).valid, false);
    assert.notEqual(invoke(f, 'check', evidence).status, 0);
  }
});

test('operator opt-in, external path, frozen and well-formed matrix required', () => {
  const f = fixture('touch dangerous');
  const ev = path.join(f.base, 'result.json');
  assert.notEqual(invoke(f, 'run', ev, ['--source', f.sha]).status, 0);
  assert.equal(fs.existsSync(path.join(f.repo, 'dangerous')), false);
  assert.notEqual(execute(f, path.join(f.repo, 'inside')).status, 0);
  assert.equal(fs.existsSync(path.join(f.repo, 'dangerous')), false);
  const malformed = fixture('echo a | b');
  assert.notEqual(execute(malformed, path.join(malformed.base, 'bad')).status, 0);
  const bad = fixture('! true');
  assert.notEqual(execute(bad, path.join(bad.base, 'bad')).status, 0);
});

test('record tampering and source change fail consistency checks', () => {
  const f = fixture(); const ev = path.join(f.base, 'result.json');
  assert.equal(execute(f, ev).status, 0);
  const record = JSON.parse(fs.readFileSync(ev)); record.rows[0].command = 'true';
  fs.writeFileSync(ev, JSON.stringify(record));
  assert.notEqual(invoke(f, 'check', ev).status, 0);
  f.git('commit', '--allow-empty', '-qm', 'new SHA');
  assert.notEqual(invoke(f, 'check', ev).status, 0);
});

test('check never executes commands, even when record is invalid', () => {
  const f = fixture(); const ev = path.join(f.base, 'result.json');
  assert.equal(execute(f, ev).status, 0);
  const record = JSON.parse(fs.readFileSync(ev));
  record.rows[0].command = `touch ${path.join(f.base, 'marker')}`;
  fs.writeFileSync(ev, JSON.stringify(record));
  assert.notEqual(invoke(f, 'check', ev).status, 0);
  assert.equal(fs.existsSync(path.join(f.base, 'marker')), false);
});

test('escaped pipe passes through and output overflow fails closed', () => {
  const f = fixture('printf "a \\| b"'); const ev = path.join(f.base, 'result.json');
  assert.equal(execute(f, ev).status, 0);
  assert.equal(JSON.parse(fs.readFileSync(ev)).rows[0].stdout, 'a | b');
  const large = fixture('yes x'); const tooBig = path.join(large.base, 'large.json');
  assert.notEqual(execute(large, tooBig).status, 0);
  assert.equal(JSON.parse(fs.readFileSync(tooBig)).rows[0].overflow, true);
});

test('legacy CP-1 accepted matrix executes and checks at committed integration HEAD', () => {
  const f = fixture('printf hello', '| SCEN-1 | CLI | T-02 | touch should-not-run | no | BLOCKED | legacy evidence |\n');
  const matrix = path.join(f.dir, 'acceptance.md');
  fs.writeFileSync(matrix, fs.readFileSync(matrix, 'utf8').replace('yes | PENDING | pending', 'yes | PENDING | legacy evidence'));
  fs.writeFileSync(path.join(f.dir, 'tasks.md'), `- [ ] 1.1 T-01 shared
  - Write scope: src/shared,test/shared.test.mjs
  - Verify with: node --test test/shared.test.mjs
  - Scen: SCEN-1
- [ ] 1.2 T-02 alpha
  - Depends on: T-01
  - Write scope: src/alpha,test/alpha.test.mjs
  - Verify with: node --test test/alpha.test.mjs
  - Scen: SCEN-1
- [ ] 1.3 T-03 beta
  - Depends on: T-01
  - Write scope: src/beta,test/beta.test.mjs
  - Verify with: node --test test/beta.test.mjs
  - Scen: SCEN-1
- [ ] 1.4 T-04 sink
  - Depends on: T-02,T-03
  - Write scope: test/sink.test.mjs
  - Verify with: npm test
  - Scen: SCEN-1\n`);
  fs.writeFileSync(path.join(f.dir, 'proposal.md'), 'x\n');
  fs.writeFileSync(path.join(f.dir, 'design.md'), '## Impact Inventory\nnone\n');
  fs.mkdirSync(path.join(f.dir, 'specs/a'), { recursive: true });
  fs.writeFileSync(path.join(f.dir, 'specs/a/spec.md'), '### Scenario: SCEN-1\n');
  f.git('add', '.'); f.git('commit', '-qm', 'reviewed contract');
  fs.writeFileSync(path.join(f.dir, 'review.md'), `R0: pass(9b2f4c1e-aaaa-4a2b-8c3d-000000000099@${f.git('rev-parse', 'HEAD')})\n`);
  f.git('add', '.'); f.git('commit', '-qm', 'review'); f.sha = f.git('rev-parse', 'HEAD');
  const freeze = spawnSync(process.execPath, [fileURLToPath(new URL('../freeze-check.mjs', import.meta.url)), f.dir, '--json', '--skip-signer-check'], { cwd: f.repo, encoding: 'utf8' });
  assert.equal(freeze.status, 0, freeze.stdout + freeze.stderr);
  const ev = path.join(f.base, 'legacy.json');
  const result = execute(f, ev);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(invoke(f, 'check', ev).status, 0);
  const record = JSON.parse(fs.readFileSync(ev));
  assert.equal(record.rows.length, 1);
  assert.match(record.matrix, /BLOCKED \| legacy evidence/);
  assert.equal(fs.existsSync(path.join(f.repo, 'should-not-run')), false);
});

test('external dependency failure remains FAIL until fixed and rerun with new evidence', () => {
  const f = fixture('test -f "$ACCEPTANCE_TEST_DEPENDENCY"');
  const dependency = path.join(f.base, 'dependency');
  const runWithEnv = (file) => spawnSync(process.execPath, [cli, 'acceptance', 'run', f.dir, '--evidence', file, '--source', f.sha, '--execute'], {
    cwd: f.repo, encoding: 'utf8', timeout: 10000, env: { ...process.env, ACCEPTANCE_TEST_DEPENDENCY: dependency },
  });
  const failed = path.join(f.base, 'failed.json'), recovered = path.join(f.base, 'recovered.json');
  assert.notEqual(runWithEnv(failed).status, 0);
  assert.equal(JSON.parse(fs.readFileSync(failed)).rows[0].result, 'FAIL');
  assert.notEqual(invoke(f, 'check', failed).status, 0);
  fs.writeFileSync(dependency, 'ready');
  assert.equal(runWithEnv(recovered).status, 0);
  assert.equal(invoke(f, 'check', recovered).status, 0);
  assert.notEqual(invoke(f, 'check', failed).status, 0);
});

test('Required values match freeze-check normalization and fail closed for typos', () => {
  for (const required of ['NO', 'No', '`no`']) {
    const f = fixture('printf ok', `| SCEN-1 | CLI | T-02 | touch ignored | ${required} | PENDING | pending |\n`);
    assert.equal(execute(f, path.join(f.base, 'record.json')).status, 0, required);
    assert.equal(fs.existsSync(path.join(f.repo, 'ignored')), false);
  }
  for (const required of ['', 'maybe', 'y', 'true', 'nope', 'yes please']) {
    const f = fixture('printf ok', `| SCEN-1 | CLI | T-02 | touch ignored | ${required} | PENDING | pending |\n`);
    assert.notEqual(execute(f, path.join(f.base, 'record.json')).status, 0, required);
    assert.equal(fs.existsSync(path.join(f.repo, 'ignored')), false);
  }
});

test('runner rejects nonstandard acceptance headers and accepts case and backtick variants', () => {
  const standard = '| Scenario | Entry | Tasks | Verify | Required | Result | Evidence |';
  for (const [header, expected] of [
    ['| Scenario | Entry | Tasks | Verify | Required | Result | Evidence | Extra |', false],
    ['| Scenario | Entry | Tasks | Verify | Required | Outcome | Evidence |', false],
    ['| Scenario | Entry | Tasks | Verify | Required | Evidence | Result |', false],
    ['| scenario | ENTRY | tasks | verify | required | result | evidence |', true],
    ['| `Scenario` | `Entry` | `Tasks` | `Verify` | `Required` | `Result` | `Evidence` |', true],
  ]) {
    const f = fixture();
    const matrix = path.join(f.dir, 'acceptance.md');
    let text = fs.readFileSync(matrix, 'utf8').replace(standard, header);
    if (header.includes('Extra')) text = text.replace('| yes | PENDING | pending |', '| yes | PENDING | pending | x |');
    fs.writeFileSync(matrix, text);
    f.git('add', '.'); f.git('commit', '-qm', 'header'); f.sha = f.git('rev-parse', 'HEAD');
    const result = execute(f, path.join(f.base, 'evidence.json'));
    assert.equal(result.status === 0, expected, `${header}: ${result.stderr}`);
  }
});
