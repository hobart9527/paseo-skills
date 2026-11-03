import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
// Signer lookup needs a live Paseo; fixtures that only exercise the contract rules skip it.
function run(dir, flags = ['--skip-signer-check'], env = process.env) {
  const result = spawnSync('node', [path.join(root, 'freeze-check.mjs'), dir, '--json', ...flags], { encoding: 'utf8', env });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
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
  // Baseline Alignment is an unrelated advisory (its content is the author's job, not the DAG's).
  assert.deepEqual(wide.advisories.filter((item) => !item.startsWith('ADVISORY_BASELINE_ALIGNMENT')), []);
  const chain = adv(`- [ ] 1.1 T-01 a\n  - Write scope: src/a.mjs,test/a.test.mjs\n  - Verify with: node --test test/a.test.mjs\n  - Scen: SCEN-1\n- [ ] 1.2 T-02 b\n  - Depends on: T-01\n  - Write scope: src/b.mjs,test/b.test.mjs\n  - Verify with: node --test test/b.test.mjs\n  - Scen: SCEN-1\n- [ ] 1.3 T-03 c\n  - Depends on: T-01\n  - Write scope: src/c.mjs,test/c.test.mjs\n  - Verify with: node --test test/c.test.mjs\n  - Scen: SCEN-1\n- [ ] 1.4 T-04 d\n  - Depends on: T-02,T-03\n  - Write scope: src/d.mjs,test/d.test.mjs\n  - Verify with: node --test test/d.test.mjs\n  - Scen: SCEN-1`);
  assert.equal(chain.speedup, 1.33);
  assert.match(chain.advisories.join('\n'), /ADVISORY_LOW_SPEEDUP/);
  // Disjoint scopes: every critical edge is an author choice, so all are removable candidates.
  assert.deepEqual(chain.criticalChain.map((step) => [step.id, step.via]), [['T-01', null], ['T-02', 'logical'], ['T-04', 'logical']]);
  // Shared file forces the edge: tag it `scope`, not `logical`.
  const shared = adv(`- [ ] 1.1 T-01 a\n  - Write scope: src/a.mjs,test/a.test.mjs\n  - Verify with: node --test test/a.test.mjs\n  - Scen: SCEN-1\n- [ ] 1.2 T-02 b\n  - Depends on: T-01\n  - Write scope: src/a.mjs,test/b.test.mjs\n  - Verify with: node --test test/b.test.mjs\n  - Scen: SCEN-1\n- [ ] 1.3 T-03 c\n  - Write scope: src/c.mjs,test/c.test.mjs\n  - Verify with: node --test test/c.test.mjs\n  - Scen: SCEN-1\n- [ ] 1.4 T-04 d\n  - Depends on: T-02,T-03\n  - Write scope: src/d.mjs,test/d.test.mjs\n  - Verify with: node --test test/d.test.mjs\n  - Scen: SCEN-1`);
  assert.deepEqual(shared.criticalChain.map((step) => [step.id, step.via]), [['T-01', null], ['T-02', 'scope'], ['T-04', 'logical']]);
});

test('critical chain follows the weighted dispatch graph, not wave depth', () => {
  // The skeleton costs only 15 minutes, so the wave chain (which ignores Uses edges)
  // starts at T-01 and reports 168 minutes. The weighted chain includes the skeleton
  // dispatch edge that actually bounds the makespan, and tags it `uses`.
  const tasks = [
    '- [ ] 1.1 T-00 iface',
    '  - Write scope: src/iface.mjs,test/iface.test.mjs',
    '  - Kind: skeleton',
    '  - Interface: src/iface.mjs#run',
    '  - Review: mechanical',
    '  - Verify with: node --test test/iface.test.mjs',
    '  - Scen: SCEN-1',
    '- [ ] 1.2 T-01 consumer',
    '  - Uses: T-00',
    '  - Write scope: src/a.mjs,test/a.test.mjs',
    '  - Est: L',
    '  - Verify with: node --test test/a.test.mjs',
    '  - Scen: SCEN-1',
    '- [ ] 1.3 T-02 follower',
    '  - Depends on: T-01',
    '  - Write scope: src/b.mjs,test/b.test.mjs',
    '  - Verify with: node --test test/b.test.mjs',
    '  - Scen: SCEN-1',
    '- [ ] 1.4 T-03 sink',
    '  - Depends on: T-02',
    '  - Write scope: src/sink.mjs',
    '  - Review: mechanical',
    '  - Verify with: npm test',
    '  - Scen: SCEN-1',
  ].join('\n');
  const report = JSON.parse(execFileSync('node', [path.join(root, 'freeze-check.mjs'), change({
    'tasks.md': tasks,
    'proposal.md': 'x',
    'design.md': design,
    'acceptance.md': table('| SCEN-1 | CLI | T-03 | npm test | yes | PENDING | pending |'),
    'specs/a/spec.md': '### Scenario: SCEN-1\n',
    'review.md': REVIEW,
  }), '--json', '--skip-signer-check'], { encoding: 'utf8' }));
  assert.deepEqual(report.criticalChain.map((step) => [step.id, step.via]),
    [['T-00', null], ['T-01', 'uses'], ['T-02', 'logical'], ['T-03', 'logical']]);
});

test('a dependency carried only by a shared read-only fixture is advisory, not blocking', () => {
  const tasks = [
    '- [ ] 1.1 T-01 a',
    '  - Write scope: src/a.mjs,test/a.test.mjs',
    '  - Reads: scripts/specs/fixture.mjs',
    '  - Verify with: node scripts/specs/fixture.mjs',
    '  - Scen: SCEN-1',
    '- [ ] 1.2 T-02 b',
    '  - Depends on: T-01',
    '  - Write scope: src/b.mjs,test/b.test.mjs',
    '  - Reads: scripts/specs/fixture.mjs',
    '  - Verify with: node scripts/specs/fixture.mjs',
    '  - Scen: SCEN-1',
    '- [ ] 1.3 T-03 sink',
    '  - Depends on: T-02',
    '  - Write scope: test/sink.test.mjs',
    '  - Verify with: npm test',
    '  - Scen: SCEN-1',
    '',
  ].join('\n');
  const report = JSON.parse(execFileSync('node', [path.join(root, 'freeze-check.mjs'), change({
    'tasks.md': tasks,
    'proposal.md': 'x',
    'design.md': design,
    'acceptance.md': table('| SCEN-1 | CLI | T-03 | npm test | yes | PENDING | pending |'),
    'specs/a/spec.md': '### Scenario: SCEN-1\n',
    'review.md': REVIEW,
  }), '--json', '--skip-signer-check'], { encoding: 'utf8' }));
  assert.deepEqual(report.blocking, []);
  assert.match(report.advisories.join('\n'), /ADVISORY_READS_ONLY_EDGE T-02 -> T-01/);
  // Chain membership is rendered on the advisory itself: the removed `CRITICAL_LOGICAL_EDGES`
  // line used to be the only place that said the edge was the bottleneck.
  assert.match(report.advisories.join('\n'), /T-02 -> T-01 \(scripts\/specs\/fixture\.mjs\) on the critical chain/);
});

test('a dependency between two writers of the same files is not reported as reads-only', () => {
  const tasks = [
    '- [ ] 1.1 T-01 a',
    '  - Write scope: src/shared.mjs,test/a.test.mjs',
    '  - Reads: scripts/specs/fixture.mjs',
    '  - Verify with: node --test test/a.test.mjs',
    '  - Scen: SCEN-1',
    '- [ ] 1.2 T-02 b',
    '  - Depends on: T-01',
    '  - Write scope: src/shared.mjs,test/b.test.mjs',
    '  - Reads: scripts/specs/fixture.mjs',
    '  - Verify with: node --test test/b.test.mjs',
    '  - Scen: SCEN-1',
    '- [ ] 1.3 T-03 sink',
    '  - Depends on: T-02',
    '  - Write scope: test/sink.test.mjs',
    '  - Verify with: npm test',
    '  - Scen: SCEN-1',
    '',
  ].join('\n');
  const report = JSON.parse(execFileSync('node', [path.join(root, 'freeze-check.mjs'), change({
    'tasks.md': tasks,
    'proposal.md': 'x',
    'design.md': design,
    'acceptance.md': table('| SCEN-1 | CLI | T-03 | npm test | yes | PENDING | pending |'),
    'specs/a/spec.md': '### Scenario: SCEN-1\n',
    'review.md': REVIEW,
  }), '--json', '--skip-signer-check'], { encoding: 'utf8' }));
  assert.doesNotMatch(report.advisories.join('\n'), /ADVISORY_READS_ONLY_EDGE/);
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

// ---- R0: the last sign-off line wins ----
function signedRepo(review) {
  const dir = change({ 'tasks.md': contract, 'proposal.md': 'x', 'design.md': design, 'acceptance.md': acceptance, 'specs/a/spec.md': '### Scenario: SCEN-1\n' });
  const sh = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();
  sh('init', '-q', '-b', 'main'); sh('config', 'user.email', 't@t'); sh('config', 'user.name', 't');
  sh('add', '.'); sh('commit', '-qm', 'draft');
  const sha = sh('rev-parse', '--short', 'HEAD');
  fs.writeFileSync(path.join(dir, 'review.md'), review(sha));
  return { dir, sh, sha };
}
test('R0 sign-off: last line wins — a stale first line plus a valid appended one passes', () => {
  const { dir } = signedRepo((sha) => `R0: pass(hanlin-uuid@deadbee)\n\nDelta re-review:\nR0: pass(hanlin-uuid@${sha})\n`);
  assert.equal(run(dir).status, 0);
});
test('R0 sign-off: a stale LAST line is STALE_R0_SIGNOFF even when an earlier one is valid', () => {
  const { dir } = signedRepo((sha) => `R0: pass(hanlin-uuid@${sha})\nR0: pass(hanlin-uuid@deadbee)\n`);
  assert.match(run(dir).stdout, /STALE_R0_SIGNOFF.*deadbee.*does not exist/);
});

// ---- cross-change scope overlap is advisory only ----
test('CROSS_CHANGE_SCOPE_OVERLAP: another integration branch touching this Write scope is advisory, exit stays 0', () => {
  const { dir, sh, sha } = signedRepo((s) => `R0: pass(hanlin-uuid@${s})\n`);
  const other = (name, file) => {
    sh('switch', '-q', '-c', name); fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), 'x'); sh('add', file); sh('commit', '-qm', `touch ${file}`); sh('switch', '-q', 'main');
  };
  other('integration/other-change', 'src/shared/x.mjs');
  other('integration/unrelated', 'docs/y.md');
  other(`integration/${path.basename(dir)}`, 'src/shared/own.mjs'); // own branch is never reported
  fs.writeFileSync(path.join(dir, 'review.md'), `R0: pass(hanlin-uuid@${sha})\n`);
  for (const flags of [['--skip-signer-check'], ['--skip-signer-check', '--structural']]) {
    const out = execFileSync('node', [path.join(root, 'freeze-check.mjs'), dir, '--json', ...flags], { encoding: 'utf8' });
    const report = JSON.parse(out);
    assert.deepEqual(report.blocking, []);
    const hits = report.advisories.filter((a) => a.startsWith('CROSS_CHANGE_SCOPE_OVERLAP'));
    assert.equal(hits.length, 1, hits.join('\n'));
    assert.match(hits[0], /^CROSS_CHANGE_SCOPE_OVERLAP T-01 vs integration\/other-change: src\/shared\/x\.mjs$/);
  }
});
test('CROSS_CHANGE_SCOPE_OVERLAP: outside a git repo it is silently skipped', () => {
  const dir = change({ 'tasks.md': contract, 'proposal.md': 'x', 'design.md': design, 'acceptance.md': acceptance, 'specs/a/spec.md': '### Scenario: SCEN-1\n' });
  const report = JSON.parse(execFileSync('node', [path.join(root, 'freeze-check.mjs'), dir, '--json', '--structural'], { encoding: 'utf8' }));
  assert.ok(!report.advisories.some((a) => /CROSS_CHANGE/.test(a)));
});

// ---- Uses / Reads / skeleton / deferred contract ----
const scheduleContract = `- [ ] 1.1 T-00 skeleton
  - Write scope: src/iface,test/iface.test.mjs
  - Est: S
  - Kind: skeleton
  - Interface: src/iface/form.ts#useDraft
  - Review: mechanical
  - Verify with: node --test test/iface.test.mjs
- [ ] 1.2 T-01 alpha
  - Uses: T-00
  - Write scope: src/alpha,test/alpha.test.mjs
  - Reads: src/iface/form.ts
  - Review: deferred
  - Verify with: node --test test/alpha.test.mjs
  - Scen: SCEN-1
- [ ] 1.3 T-02 beta
  - Uses: T-00
  - Write scope: src/beta,test/beta.test.mjs
  - Review: deferred
  - Verify with: node --test test/beta.test.mjs
  - Scen: SCEN-1
- [ ] 1.4 T-03 sink
  - Depends on: T-00,T-01,T-02
  - Write scope: test/sink.test.mjs
  - Verify with: npm test
  - Scen: SCEN-1`;
const scheduleFiles = (tasks) => ({
  'tasks.md': tasks,
  'proposal.md': 'x',
  'design.md': design,
  'acceptance.md': table('| SCEN-1 | CLI | T-03 | node -e "0" | yes | PENDING | pending |'),
  'specs/a/spec.md': '### Scenario: SCEN-1\n',
});
const freezeStructural = (tasks) => run(change(scheduleFiles(tasks)), ['--structural', '--skip-signer-check']);

test('accepts Uses/Reads/skeleton/deferred and reports the weighted model', () => {
  const dir = change(scheduleFiles(scheduleContract));
  const result = run(dir, ['--structural', '--skip-signer-check']);
  assert.equal(result.status, 0, result.stdout);
  const report = JSON.parse(execFileSync('node', [path.join(root, 'freeze-check.mjs'), dir, '--json', '--structural', '--skip-signer-check'], { encoding: 'utf8' }));
  assert.equal(typeof report.weightedSpeedup, 'number');
  assert.equal(typeof report.speedup, 'number');
});

test('USES_UNKNOWN blocks a Uses target that is not a task', () => {
  const bad = scheduleContract.replace('  - Uses: T-00\n', '  - Uses: T-99\n');
  const result = freezeStructural(bad);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /USES_UNKNOWN T-01/);
});

test('USES_WITHOUT_INTERFACE blocks a producer with no frozen interface', () => {
  const bad = scheduleContract.replace('  - Interface: src/iface/form.ts#useDraft\n', '');
  const result = freezeStructural(bad);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /USES_WITHOUT_INTERFACE T-01/);
});

test('USES_SCOPE_OVERLAP blocks overlapping writers without Depends on', () => {
  const bad = scheduleContract.replace('Write scope: src/alpha,test/alpha.test.mjs', 'Write scope: src/iface,test/alpha.test.mjs');
  const result = freezeStructural(bad);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /USES_SCOPE_OVERLAP T-01 and T-00/);
});

test('INTERFACE_UNOWNED blocks an Interface outside every skeleton scope', () => {
  const bad = scheduleContract.replace('  - Review: deferred\n', '  - Interface: src/alpha/api.ts#Handler\n  - Review: deferred\n');
  const result = freezeStructural(bad);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /INTERFACE_UNOWNED T-01/);
});

test('SKELETON_NOT_MECHANICAL blocks a skeleton that needs per-task review', () => {
  const bad = scheduleContract.replace('  - Review: mechanical\n  - Verify with: node --test test/iface.test.mjs', '  - Review: standard\n  - Verify with: node --test test/iface.test.mjs');
  const result = freezeStructural(bad);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /SKELETON_NOT_MECHANICAL T-00/);
});

test('a producer consumed only through Uses is not a sink and may defer review', () => {
  // T-01 is consumed by T-02 via Uses only; nothing lists it in Depends on. Counting
  // Depends alone made T-01 look like a sink, so DEFERRED_NOT_STANDARD rejected it.
  const tasks = `- [ ] 1.1 T-00 skeleton
  - Write scope: src/iface/form.ts,src/alpha/api.ts,test/iface.test.mjs
  - Kind: skeleton
  - Interface: src/iface/form.ts#useDraft,src/alpha/api.ts#handler
  - Review: mechanical
  - Verify with: node --test test/iface.test.mjs
- [ ] 1.2 T-01 producer
  - Uses: T-00
  - Depends on: T-00
  - Write scope: src/alpha/api.ts,test/alpha.test.mjs
  - Interface: src/alpha/api.ts#handler
  - Review: deferred
  - Verify with: node --test test/alpha.test.mjs
  - Scen: SCEN-1
- [ ] 1.3 T-02 consumer
  - Uses: T-01
  - Write scope: src/beta,test/beta.test.mjs
  - Review: deferred
  - Verify with: node --test test/beta.test.mjs
  - Scen: SCEN-1
- [ ] 1.4 T-03 sink
  - Depends on: T-00,T-02
  - Write scope: test/sink.test.mjs
  - Verify with: npm test
  - Scen: SCEN-1`;
  const result = freezeStructural(tasks);
  assert.equal(result.status, 0, result.stdout);
});

test('DEFERRED_NOT_STANDARD blocks the sink and persistence/security surfaces, but not public-api', () => {
  const sink = scheduleContract.replace('  - Verify with: npm test\n', '  - Verify with: npm test\n  - Review: deferred\n');
  assert.match(freezeStructural(sink).stdout, /DEFERRED_NOT_STANDARD T-03/);

  const persistence = scheduleContract.replace('  - Review: deferred\n  - Verify with: node --test test/alpha.test.mjs', '  - Review: deferred\n  - Risk-surface: [persistence]\n  - Verify with: node --test test/alpha.test.mjs');
  assert.match(freezeStructural(persistence).stdout, /DEFERRED_NOT_STANDARD T-01/);

  const security = scheduleContract.replace('  - Review: deferred\n  - Verify with: node --test test/alpha.test.mjs', '  - Review: deferred\n  - Risk-surface: security\n  - Verify with: node --test test/alpha.test.mjs');
  assert.match(freezeStructural(security).stdout, /DEFERRED_NOT_STANDARD T-01/);

  const publicApi = scheduleContract.replace('  - Review: deferred\n  - Verify with: node --test test/alpha.test.mjs', '  - Review: deferred\n  - Risk-surface: public-api\n  - Verify with: node --test test/alpha.test.mjs');
  assert.equal(freezeStructural(publicApi).status, 0, freezeStructural(publicApi).stdout);
});

test('skeleton Write-scope overlap is exempt against transitive dependents', () => {
  // T-03 depends on T-01, which Uses the skeleton: it cannot start before the skeleton merged.
  const transitive = scheduleContract
    .replace('  - Depends on: T-00,T-01,T-02\n  - Write scope: test/sink.test.mjs', '  - Depends on: T-01,T-02\n  - Write scope: src/iface/sink.ts,test/sink.test.mjs');
  assert.equal(freezeStructural(transitive).status, 0, freezeStructural(transitive).stdout);
  // An independent task with no path to the skeleton is a real writer race.
  const race = scheduleContract.replace('  - Scen: SCEN-1', '  - Scen: SCEN-1\n- [ ] 1.5 T-04 race\n  - Write scope: src/iface/race.ts,test/race.test.mjs\n  - Verify with: node --test test/race.test.mjs\n  - Scen: SCEN-1');
  assert.match(freezeStructural(race).stdout, /SCOPE_CONFLICT T-00 and T-04/);
});

test('Reads anchors a narrow Verify without joining scope conflicts', () => {
  const anchored = scheduleContract
    .replace('Write scope: src/alpha,test/alpha.test.mjs', 'Write scope: src/alpha')
    .replace('Reads: src/iface/form.ts', 'Reads: src/iface/form.ts,test/alpha.test.mjs');
  assert.equal(freezeStructural(anchored).status, 0, freezeStructural(anchored).stdout);
  const sharedRead = scheduleContract.replace('  - Review: deferred\n  - Verify with: node --test test/beta.test.mjs', '  - Reads: src/iface/form.ts\n  - Review: deferred\n  - Verify with: node --test test/beta.test.mjs');
  assert.equal(freezeStructural(sharedRead).status, 0, freezeStructural(sharedRead).stdout);
});

test('rulings.md is not contract drift; any other new file is', () => {
  const dir = change({ 'tasks.md': contract, 'proposal.md': 'x', 'design.md': design, 'acceptance.md': acceptance, 'specs/a/spec.md': '### Scenario: SCEN-1\n' });
  const sh = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();
  sh('init', '-q'); sh('config', 'user.email', 't@t'); sh('config', 'user.name', 't');
  sh('add', '.'); sh('commit', '-qm', 'draft');
  fs.writeFileSync(path.join(dir, 'review.md'), `R0: pass(hanlin-uuid@${sh('rev-parse', '--short', 'HEAD')})\n`);
  fs.writeFileSync(path.join(dir, 'rulings.md'), '# Rulings\n');
  assert.equal(run(dir).status, 0, run(dir).stdout);
  fs.writeFileSync(path.join(dir, 'extra.md'), 'x');
  assert.match(run(dir).stdout, /STALE_R0_SIGNOFF.*extra\.md/);
});

test('--explain prints a rule, reason and fix for every block', () => {
  const dir = change(scheduleFiles(scheduleContract.replace('  - Uses: T-00\n', '  - Uses: T-99\n')));
  let error;
  try { execFileSync('node', [path.join(root, 'freeze-check.mjs'), dir, '--explain', '--structural', '--skip-signer-check'], { encoding: 'utf8', stdio: 'pipe' }); }
  catch (caught) { error = caught; }
  assert.ok(error, 'expected a non-zero exit');
  assert.match(error.stderr, /BLOCK USES_UNKNOWN T-01/);
  assert.match(error.stderr, /EXPLAIN USES_UNKNOWN: .*Uses T-99/);
  assert.match(error.stderr, /fix: point Uses at an existing task id/);
});

// ---- contract lint: silent failure modes ----
test('an acceptance row split by an unescaped pipe is a named block, not a silent skip', () => {
  const row = '| SCEN-1 | CLI | T-02 | echo "a | b" | yes | PENDING | pending |';
  const dir = change({ 'tasks.md': contract, 'proposal.md': 'x', 'design.md': design, 'acceptance.md': table(row), 'specs/a/spec.md': '### Scenario: SCEN-1\n' });
  const result = run(dir);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /MALFORMED_ACCEPTANCE_ROW/);
  // An escaped pipe keeps the column count and is accepted.
  const escaped = change({ 'tasks.md': contract, 'proposal.md': 'x', 'design.md': design, 'acceptance.md': table('| SCEN-1 | CLI | T-02 | echo "a \\| b" | yes | PENDING | pending |'), 'specs/a/spec.md': '### Scenario: SCEN-1\n', 'review.md': REVIEW });
  assert.equal(run(escaped).status, 0);
});

test('shell setup is not a verify leg: set -e and || are named blocks', () => {
  const sinkSet = contract.replace('  - Verify with: npm test', '  - Verify with: set -e; npm test');
  const setResult = run(change({ 'tasks.md': sinkSet, 'proposal.md': 'x', 'design.md': design, 'acceptance.md': acceptance, 'specs/a/spec.md': '### Scenario: SCEN-1\n' }));
  assert.match(setResult.stdout, /VERIFY_JUNK_LEG T-04/);
  assert.match(setResult.stdout, /shell setup, not a verify leg/);
  const sinkOr = contract.replace('  - Verify with: npm test', '  - Verify with: npm test || true');
  const orResult = run(change({ 'tasks.md': sinkOr, 'proposal.md': 'x', 'design.md': design, 'acceptance.md': acceptance, 'specs/a/spec.md': '### Scenario: SCEN-1\n' }));
  assert.match(orResult.stdout, /VERIFY_JUNK_LEG T-04/);
  assert.match(orResult.stdout, /mandatory legs/);
});

test('a shell loop is an advisory, not invented legs', () => {
  const loop = contract
    .replace('Write scope: test/sink.test.mjs', 'Write scope: test/sink.test.mjs,scripts/specs/probe.mjs')
    .replace('  - Verify with: npm test', '  - Review: mechanical\n  - Verify with: for f in scripts/specs/probe.mjs; do node "$f"; done');
  const dir = change({ 'tasks.md': loop, 'proposal.md': 'x', 'design.md': design, 'acceptance.md': acceptance, 'specs/a/spec.md': '### Scenario: SCEN-1\n', 'review.md': REVIEW });
  const result = run(dir);
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /ADVISORY_SHELL_VERIFY T-04/);
});

test('Reads must name a path that already exists in the repository', () => {
  const dir = change({ 'tasks.md': contract.replace('  - Scen: SCEN-1\n- [ ] 1.2', '  - Reads: docs/contract.md\n  - Scen: SCEN-1\n- [ ] 1.2'), 'proposal.md': 'x', 'design.md': design, 'acceptance.md': acceptance, 'specs/a/spec.md': '### Scenario: SCEN-1\n' });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  assert.match(run(dir, ['--structural', '--skip-signer-check']).stdout, /MISSING_READS_PATH T-01/);
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs/contract.md'), 'x');
  assert.equal(run(dir, ['--structural', '--skip-signer-check']).status, 0);
});

test('Reads may forward-reference a path another task writes, but not a typo', () => {
  // T-01 reads src/poison.txt before T-02 has written it: legal, because T-02 owns it.
  const forward = contract
    .replace('Write scope: src/shared,test/shared.test.mjs', 'Write scope: src/shared,test/shared.test.mjs,src/poison.txt')
    .replace('  - Scen: SCEN-1\n- [ ] 1.2', '  - Reads: src/poison.txt\n  - Scen: SCEN-1\n- [ ] 1.2');
  const ok = change({ 'tasks.md': forward, 'proposal.md': 'x', 'design.md': design, 'acceptance.md': acceptance, 'specs/a/spec.md': '### Scenario: SCEN-1\n' });
  execFileSync('git', ['init', '-q'], { cwd: ok });
  assert.doesNotMatch(run(ok, ['--structural', '--skip-signer-check']).stdout, /MISSING_READS_PATH/);
  const typo = change({ 'tasks.md': forward.replace('Reads: src/poison.txt', 'Reads: src/posion.txt'), 'proposal.md': 'x', 'design.md': design, 'acceptance.md': acceptance, 'specs/a/spec.md': '### Scenario: SCEN-1\n' });
  execFileSync('git', ['init', '-q'], { cwd: typo });
  assert.match(run(typo, ['--structural', '--skip-signer-check']).stdout, /MISSING_READS_PATH T-01/);
});

test('baseline alignment is an advisory that names the missing section, never a block', () => {
  const files = { 'proposal.md': 'x', 'design.md': design, 'acceptance.md': acceptance, 'specs/a/spec.md': '### Scenario: SCEN-1\n', 'tasks.md': contract, 'review.md': REVIEW };
  const missing = JSON.parse(execFileSync('node', [path.join(root, 'freeze-check.mjs'), change(files), '--json', '--skip-signer-check'], { encoding: 'utf8' }));
  assert.equal(missing.route, 'pipeline');
  assert.ok(missing.advisories.some((item) => item.startsWith('ADVISORY_BASELINE_ALIGNMENT: design.md')));
  const aligned = { ...files, 'design.md': '## Baseline Alignment\n| Rule | Baseline | Verdict | Evidence |\n| --- | --- | --- | --- |\n| none | n/a | reuse | `rg status src/` |\n\n## Impact Inventory\nnone\n', 'digest.md': '## Baseline Alignment\nnone: `rg status src/`\n' };
  const ok = JSON.parse(execFileSync('node', [path.join(root, 'freeze-check.mjs'), change(aligned), '--json', '--skip-signer-check'], { encoding: 'utf8' }));
  assert.deepEqual(ok.advisories.filter((item) => item.startsWith('ADVISORY_BASELINE_ALIGNMENT')), []);
  // One author fills the record once: `design.md` is the file R0 reads, so a missing digest
  // section is not a second advisory. A digest-only package still warns.
  const designOnly = { ...files, 'design.md': aligned['design.md'] };
  const one = JSON.parse(execFileSync('node', [path.join(root, 'freeze-check.mjs'), change(designOnly), '--json', '--skip-signer-check'], { encoding: 'utf8' }));
  assert.deepEqual(one.advisories.filter((item) => item.startsWith('ADVISORY_BASELINE_ALIGNMENT')), []);
  const digestOnly = { ...files, 'digest.md': aligned['digest.md'] };
  const none = JSON.parse(execFileSync('node', [path.join(root, 'freeze-check.mjs'), change(digestOnly), '--json', '--skip-signer-check'], { encoding: 'utf8' }));
  assert.ok(none.advisories.some((item) => item.startsWith('ADVISORY_BASELINE_ALIGNMENT: design.md')));
  // A section written as `###` subsections is still a section: they must not truncate the body.
  const subsectioned = { ...files, 'design.md': `${design}\n## Baseline Alignment\n\n### Read\n- specs/a/spec.md:12 (reuse)\n\n### Command\n\`rg status src/\`\n`, 'digest.md': '## Baseline Alignment\n\n### Read\n- `rg status src/`\n' };
  const sub = JSON.parse(execFileSync('node', [path.join(root, 'freeze-check.mjs'), change(subsectioned), '--json', '--skip-signer-check'], { encoding: 'utf8' }));
  assert.deepEqual(sub.advisories.filter((item) => item.startsWith('ADVISORY_BASELINE_ALIGNMENT')), []);
});
