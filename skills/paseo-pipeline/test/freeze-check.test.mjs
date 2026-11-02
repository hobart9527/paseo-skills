import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
// Signer lookup needs a live Paseo; fixtures that only exercise the contract rules skip it.
function run(dir, flags = ['--skip-signer-check'], env = process.env) {
  try { execFileSync('node', [path.join(root, 'freeze-check.mjs'), dir, '--json', ...flags], { encoding: 'utf8', env }); return { status: 0 }; }
  catch (error) { return { status: error.status, stdout: error.stdout, stderr: error.stderr }; }
}
function change(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freeze-'));
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
  return dir;
}
const contract = `- [ ] 1.1 T-01 shared
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
  - Scen: SCEN-1`;
const design = '## Impact Inventory\nnone\n';
// A valid R0 sign-off written by hanlin after independent review.
const REVIEW = 'R0: pass(9b2f4c1e-aaaa-4a2b-8c3d-000000000099@abcdef1)\n';
test('accepts narrow non-sink tasks and reports concurrency', () => {
  const dir = change({ 'tasks.md': contract, 'proposal.md': 'x', 'design.md': design, 'acceptance.md': table('| SCEN-1 | CLI | T-04 | node -e "0" | yes | PENDING | pending |'), 'specs/a/spec.md': '### Scenario: SCEN-1\n', 'review.md': REVIEW });
  const result = run(dir);
  assert.equal(result.status, 0);
});
test('rejects full-suite non-sink verify', () => {
  const bad = contract.replace('node --test test/alpha.test.mjs', 'npm test');
  const dir = change({ 'tasks.md': bad, 'proposal.md': 'x', 'design.md': design, 'acceptance.md': 'x', 'specs/a/spec.md': '### Scenario: SCEN-1\n' });
  const result = run(dir);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /VERIFY_NOT_NARROW T-02/);
});
test('accepts scoped non-node runners and rejects unscoped ones', () => {
  const files = { 'proposal.md': 'x', 'design.md': design, 'acceptance.md': acceptance, 'specs/a/spec.md': '### Scenario: SCEN-1\n', 'review.md': REVIEW };
  const scoped = contract
    .replace('Write scope: src/alpha,test/alpha.test.mjs', 'Write scope: pkg/alpha')
    .replace('node --test test/alpha.test.mjs', 'go test ./pkg/alpha')
    .replace('Write scope: src/beta,test/beta.test.mjs', 'Write scope: app/beta')
    .replace('node --test test/beta.test.mjs', 'PYTHONPATH=runtime python3 -m pytest app/beta/test_b.py');
  assert.equal(run(change({ ...files, 'tasks.md': scoped })).status, 0);
  const unscoped = scoped.replace('go test ./pkg/alpha', 'go test ./...');
  const result = run(change({ ...files, 'tasks.md': unscoped }));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /VERIFY_FULL_SUITE_NON_SINK T-02/);
});
test('rejects non-sink verify legs that prove nothing', () => {
  for (const verify of ['true', 'echo ok', 'node src/alpha/a.mjs', 'node --test test/alpha.test.mjs && true']) {
    const bad = contract.replace('node --test test/alpha.test.mjs', verify);
    const dir = change({ 'tasks.md': bad, 'proposal.md': 'x', 'design.md': design, 'acceptance.md': 'x', 'specs/a/spec.md': '### Scenario: SCEN-1\n' });
    const result = run(dir);
    assert.equal(result.status, 1, verify);
    assert.match(result.stdout, /VERIFY_NOT_NARROW T-02/, verify);
  }
});
test('rejects verify paths that fall outside the task Write scope', () => {
  const bad = contract.replace('node --test test/alpha.test.mjs', 'node --test test/beta.test.mjs');
  const dir = change({ 'tasks.md': bad, 'proposal.md': 'x', 'design.md': design, 'acceptance.md': 'x', 'specs/a/spec.md': '### Scenario: SCEN-1\n' });
  const result = run(dir);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /VERIFY_NOT_NARROW T-02/);
});
test('rejects wave scope conflict', () => {
  const bad = contract.replace('src/beta,test/beta.test.mjs', 'src/alpha,test/beta.test.mjs');
  const dir = change({ 'tasks.md': bad, 'proposal.md': 'x', 'design.md': design, 'acceptance.md': 'x', 'specs/a/spec.md': '### Scenario: SCEN-1\n' });
  const result = run(dir);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /SCOPE_CONFLICT/);
});

const table = (rows) => `| Scenario | Entry | Tasks | Verify | Required | Result | Evidence |\n| --- | --- | --- | --- | --- | --- | --- |\n${rows}`;
const acceptance = table('| SCEN-1 | CLI | T-02 | node -e "0" | yes | PENDING | pending |');
test('accepts schema scenario headings with descriptions and rejects hidden full-suite legs', () => {
  const bad = contract.replace('node --test test/alpha.test.mjs', 'npm test && node --test test/alpha.test.mjs');
  const dir = change({ 'tasks.md': bad, 'proposal.md': 'x', 'design.md': design, 'acceptance.md': acceptance, 'specs/a/spec.md': '### Scenario: SCEN-1 successful alpha\n' });
  const result = run(dir);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /VERIFY_FULL_SUITE_NON_SINK T-02/);
});
test('rejects zero parsed tasks and multiple full-suite sinks', () => {
  const empty = change({ 'tasks.md': '# Tasks\n- [ ] 1.1 missing ID\n', 'proposal.md': 'x', 'design.md': design, 'acceptance.md': acceptance, 'specs/a/spec.md': '### Scenario: SCEN-1\n' });
  assert.match(run(empty).stdout, /EMPTY_TASKS/);
  const twoSinks = contract.replace('npm test', 'npm test').replace('  - Verify with: npm test', '  - Verify with: npm test').replace('- [ ] 1.3 T-03 beta\n  - Depends on: T-01\n  - Write scope: src/beta,test/beta.test.mjs\n  - Verify with: node --test test/beta.test.mjs', '- [ ] 1.3 T-03 beta\n  - Write scope: src/beta,test/beta.test.mjs\n  - Verify with: npm test');
  const dir = change({ 'tasks.md': twoSinks, 'proposal.md': 'x', 'design.md': design, 'acceptance.md': acceptance, 'specs/a/spec.md': '### Scenario: SCEN-1\n' });
  const result = run(dir);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /TOO_MANY_FULL_SUITE_SINKS/);
  assert.match(result.stdout, /VERIFY_FULL_SUITE_NON_SINK T-03/);
});
test('validates required acceptance scenarios and frozen state', () => {
  const good = change({ 'tasks.md': contract, 'proposal.md': 'x', 'design.md': design, 'acceptance.md': acceptance, 'specs/a/spec.md': '### Scenario: SCEN-1 alpha works\n', 'review.md': REVIEW });
  assert.equal(run(good).status, 0);
  const unknown = change({ 'tasks.md': contract, 'proposal.md': 'x', 'design.md': design, 'acceptance.md': table('| SCEN-X | CLI | T-02 | node -e "0" | yes | PENDING | pending |'), 'specs/a/spec.md': '### Scenario: SCEN-1\n' });
  assert.match(run(unknown).stdout, /UNKNOWN_ACCEPTANCE_SCEN/);
  const notPending = change({ 'tasks.md': contract, 'proposal.md': 'x', 'design.md': design, 'acceptance.md': table('| SCEN-1 | CLI | T-02 | node -e "0" | yes | PASS | pending |'), 'specs/a/spec.md': '### Scenario: SCEN-1\n' });
  assert.match(run(notPending).stdout, /ACCEPTANCE_NOT_FROZEN/);
  const noRequired = change({ 'tasks.md': contract, 'proposal.md': 'x', 'design.md': design, 'acceptance.md': table('| SCEN-1 | CLI | T-02 | node -e "0" | no | PENDING | pending |'), 'specs/a/spec.md': '### Scenario: SCEN-1\n' });
  assert.match(run(noRequired).stdout, /MISSING_REQUIRED_ACCEPTANCE/);
});

test('rejects missing impact inventory, scenario-less and fixture-only tasks', () => {
  const files = { 'proposal.md': 'x', 'acceptance.md': acceptance, 'specs/a/spec.md': '### Scenario: SCEN-1\n', 'review.md': REVIEW };
  const noImpact = change({ ...files, 'tasks.md': contract, 'design.md': '## Context\n' });
  assert.match(run(noImpact).stdout, /MISSING_IMPACT_INVENTORY/);
  const noScen = change({ ...files, 'design.md': design, 'tasks.md': contract.replace('  - Verify with: node --test test/alpha.test.mjs\n', '  - Verify with: node --test test/alpha.test.mjs\n  - Review: standard\n').replace(/(T-03 beta[\s\S]*?)  - Scen: SCEN-1\n/, '$1') });
  assert.match(run(noScen).stdout, /NO_SCEN T-03/);
  const fixtureOnly = change({ ...files, 'design.md': design, 'tasks.md': contract.replace('src/beta,test/beta.test.mjs', 'test/beta.test.mjs') });
  assert.match(run(fixtureOnly).stdout, /FIXTURE_ONLY_TASK T-03/);
  const mech = change({ ...files, 'design.md': design, 'tasks.md': contract.replace(/(T-03 beta[\s\S]*?)  - Scen: SCEN-1\n/, '$1  - Review: mechanical\n').replace('src/beta,test/beta.test.mjs', 'test/beta.test.mjs') });
  assert.equal(run(mech).status, 0);
});

test('rejects scope overlap between tasks in different waves with no dependency path', () => {
  const files = { 'proposal.md': 'x', 'design.md': design, 'acceptance.md': acceptance, 'specs/a/spec.md': '### Scenario: SCEN-1\n', 'review.md': REVIEW };
  const bad = contract.replace('src/beta,test/beta.test.mjs', 'src/shared/x,test/beta.test.mjs').replace('Write scope: src/alpha,test/alpha.test.mjs', 'Write scope: src/shared,test/alpha.test.mjs');
  assert.match(run(change({ ...files, 'tasks.md': bad })).stdout, /SCOPE_CONFLICT/);
  // ordered by dependency is fine: T-02 depends on T-01 which owns src/shared
  const ok = contract.replace('Write scope: src/alpha,test/alpha.test.mjs', 'Write scope: src/shared/alpha,test/alpha.test.mjs');
  assert.equal(run(change({ ...files, 'tasks.md': ok })).status, 0);
});

test('rejects Impact Inventory naming unknown tasks', () => {
  const files = { 'proposal.md': 'x', 'acceptance.md': acceptance, 'specs/a/spec.md': '### Scenario: SCEN-1\n', 'tasks.md': contract, 'review.md': REVIEW };
  assert.match(run(change({ ...files, 'design.md': '## Impact Inventory\nfoo() -> fixtures -> T-99\n' })).stdout, /IMPACT_UNKNOWN_TASK T-99/);
  assert.equal(run(change({ ...files, 'design.md': '## Impact Inventory\nfoo() -> fixtures -> T-02\n' })).status, 0);
});

test('rejects missing R0 sign-off (no review.md)', () => {
  const dir = change({ 'tasks.md': contract, 'proposal.md': 'x', 'design.md': design, 'acceptance.md': acceptance, 'specs/a/spec.md': '### Scenario: SCEN-1\n' });
  const result = run(dir);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /MISSING_R0_SIGNOFF/);
});

test('rejects malformed R0 sign-off (wrong format)', () => {
  for (const bad of ['R0: approved by hanlin', 'R0: pass(no-at-sign)', 'signed off']) {
    const dir = change({ 'tasks.md': contract, 'proposal.md': 'x', 'design.md': design, 'acceptance.md': acceptance, 'specs/a/spec.md': '### Scenario: SCEN-1\n', 'review.md': bad });
    assert.equal(run(dir).status, 1, `should reject: ${bad}`);
    assert.match(run(dir).stdout, /MISSING_R0_SIGNOFF/, `should name error: ${bad}`);
  }
});

test('accepts valid R0 sign-off with full UUID or short SHA', () => {
  const withFullUuid = change({ 'tasks.md': contract, 'proposal.md': 'x', 'design.md': design, 'acceptance.md': acceptance, 'specs/a/spec.md': '### Scenario: SCEN-1\n', 'review.md': 'R0: pass(9b2f4c1e-aaaa-4a2b-8c3d-000000000099@abcdef1)\n\nFindings: none.\n' });
  assert.equal(run(withFullUuid).status, 0);
  const withLongSha = change({ 'tasks.md': contract, 'proposal.md': 'x', 'design.md': design, 'acceptance.md': acceptance, 'specs/a/spec.md': '### Scenario: SCEN-1\n', 'review.md': 'R0: pass(hanlin-agent-uuid@abcdef1234567890abcdef1234567890abcdef12)\n' });
  assert.equal(run(withLongSha).status, 0);
});

test('--structural passes without review.md; default mode still blocks', () => {
  const dir = change({ 'tasks.md': contract, 'proposal.md': 'x', 'design.md': design, 'acceptance.md': acceptance, 'specs/a/spec.md': '### Scenario: SCEN-1\n' });
  assert.equal(run(dir, ['--structural']).status, 0);
  assert.equal(run(dir).status, 1);
});

test('R0 sign-off is bound to the reviewed commit: unknown sha and later edits are rejected', () => {
  const dir = change({ 'tasks.md': contract, 'proposal.md': 'x', 'design.md': design, 'acceptance.md': acceptance, 'specs/a/spec.md': '### Scenario: SCEN-1\n' });
  const sh = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();
  sh('init', '-q'); sh('config', 'user.email', 't@t'); sh('config', 'user.name', 't');
  sh('add', '.'); sh('commit', '-qm', 'draft');
  const sha = sh('rev-parse', '--short', 'HEAD');
  const sign = (s) => fs.writeFileSync(path.join(dir, 'review.md'), `R0: pass(hanlin-uuid@${s})\n`);

  sign(sha);
  assert.equal(run(dir).status, 0, 'review.md itself is not contract drift');

  sign('deadbee');
  assert.match(run(dir).stdout, /STALE_R0_SIGNOFF.*does not exist/);

  sign(sha);
  fs.appendFileSync(path.join(dir, 'tasks.md'), '\n');
  assert.match(run(dir).stdout, /STALE_R0_SIGNOFF.*tasks\.md/);
});

// ---- R0 signer must be a real Paseo agent ----
function fakePaseo(agents, { inspect = false } = {}) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'freeze-bin-'));
  const payload = Buffer.from(JSON.stringify(agents)).toString('base64');
  const inspectBranch = inspect ? `printf '{"Id":"%s","Name":"[Pipeline] hanlin R0","Provider":"claude","Model":"cc"}' "$2"` : 'exit 1';
  fs.writeFileSync(path.join(bin, 'paseo'), `#!/bin/sh\nif [ "$1" = inspect ]; then ${inspectBranch}; else printf '%s' '${payload}' | base64 -d; fi\n`);
  fs.chmodSync(path.join(bin, 'paseo'), 0o755);
  return { ...process.env, PATH: `${bin}:${process.env.PATH}` };
}
const SIGNER = '9b2f4c1e-aaaa-4a2b-8c3d-000000000099';
const signed = () => change({ 'tasks.md': contract, 'proposal.md': 'x', 'design.md': design, 'acceptance.md': acceptance, 'specs/a/spec.md': '### Scenario: SCEN-1\n', 'review.md': `R0: pass(${SIGNER}@abcdef1)\n` });

test('R0 signer: a uuid that is not a Paseo agent blocks, a hanlin agent passes', () => {
  const unknown = run(signed(), [], fakePaseo([{ id: 'ffffffff-0000-4000-8000-000000000000', shortId: 'fffffff', name: 'other', provider: 'codex/gpt' }]));
  assert.equal(unknown.status, 1);
  assert.match(unknown.stdout, /R0_SIGNER_UNKNOWN/);
  const known = run(signed(), [], fakePaseo([{ id: SIGNER, shortId: '9b2f4c1', name: '[Pipeline] hanlin R0', provider: 'claude/cc' }]));
  assert.equal(known.status, 0);
});

test('R0 signer: archived agent missing from `ls` is resolved through inspect', () => {
  assert.equal(run(signed(), [], fakePaseo([], { inspect: true })).status, 0);
});

test('R0 signer: non-hanlin name is an advisory, not a block', () => {
  const dir = signed();
  const env = fakePaseo([{ id: SIGNER, shortId: '9b2f4c1', name: 'random chat', provider: 'claude/cc' }]);
  const out = execFileSync('node', [path.join(root, 'freeze-check.mjs'), dir, '--json'], { encoding: 'utf8', env });
  assert.match(JSON.parse(out).advisories.join('\n'), /R0_SIGNER_NOT_HANLIN/);
});

test('R0 signer: an unreachable Paseo is an advisory, a reachable one still blocks an unknown signer', () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'freeze-bin-'));
  fs.writeFileSync(path.join(bin, 'paseo'), '#!/bin/sh\nexit 1\n');
  fs.chmodSync(path.join(bin, 'paseo'), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  const out = execFileSync('node', [path.join(root, 'freeze-check.mjs'), signed(), '--json'], { encoding: 'utf8', env });
  const report = JSON.parse(out);
  assert.match(report.advisories.join('\n'), /R0_SIGNER_UNVERIFIED/);
  assert.ok(!(report.blocking || []).some((item) => /R0_SIGNER/.test(item)));
});

// ---- Tier 3 admission advisory ----
const diamond = (n) => Array.from({ length: n }, (_, i) => i).map((i) => `- [ ] 1.${i} T-0${i + 1} t${i}\n  - Write scope: src/t${i}.mjs,test/t${i}.test.mjs\n  - Verify with: node --test test/t${i}.test.mjs\n  - Scen: SCEN-1${i === 0 ? '' : `\n  - Depends on: T-01`}`).join('\n');

test('low speedup advisory fires on a near-serial DAG and stays silent on a wide one', () => {
  const files = { 'proposal.md': 'x', 'design.md': design, 'acceptance.md': acceptance, 'specs/a/spec.md': '### Scenario: SCEN-1\n', 'review.md': REVIEW };
  const adv = (tasks) => JSON.parse(execFileSync('node', [path.join(root, 'freeze-check.mjs'), change({ ...files, 'tasks.md': tasks }), '--json', '--skip-signer-check'], { encoding: 'utf8' }));
  const wide = adv(diamond(6)); // T-01 then 5 parallel: 6 tasks / 2 waves = 3x
  assert.equal(wide.route, 'pipeline');
  assert.deepEqual(wide.advisories, []);
  const chain = adv(`- [ ] 1.1 T-01 a\n  - Write scope: src/a.mjs,test/a.test.mjs\n  - Verify with: node --test test/a.test.mjs\n  - Scen: SCEN-1\n- [ ] 1.2 T-02 b\n  - Depends on: T-01\n  - Write scope: src/b.mjs,test/b.test.mjs\n  - Verify with: node --test test/b.test.mjs\n  - Scen: SCEN-1\n- [ ] 1.3 T-03 c\n  - Depends on: T-01\n  - Write scope: src/c.mjs,test/c.test.mjs\n  - Verify with: node --test test/c.test.mjs\n  - Scen: SCEN-1\n- [ ] 1.4 T-04 d\n  - Depends on: T-02,T-03\n  - Write scope: src/d.mjs,test/d.test.mjs\n  - Verify with: node --test test/d.test.mjs\n  - Scen: SCEN-1`);
  assert.equal(chain.speedup, 1.33);
  assert.match(chain.advisories.join('\n'), /ADVISORY_LOW_SPEEDUP/);
});

function sinkContract(verify, extra = '') {
  return contract.replace('Verify with: npm test', `Verify with: ${verify}`).replace('  - Scen: SCEN-1\n', '  - Scen: SCEN-1\n').replace(/(1\.4 T-04 sink\n)/, `$1${extra}`);
}
function freezeOf(tasks) {
  return run(change({ 'tasks.md': tasks, 'proposal.md': 'x', 'design.md': design, 'acceptance.md': table('| SCEN-1 | CLI | T-04 | node -e "0" | yes | PENDING | pending |'), 'specs/a/spec.md': '### Scenario: SCEN-1\n', 'review.md': REVIEW }));
}
test('sink without a full-suite leg must still have a narrow Verify', () => {
  const result = freezeOf(sinkContract('echo ok'));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /VERIFY_NOT_NARROW T-04/);
});
test('mechanical sink may run a non-test check', () => {
  const result = freezeOf(sinkContract('rg -c done docs/x.md', '  - Review: mechanical\n'));
  assert.equal(result.status, 0, result.stdout);
});
