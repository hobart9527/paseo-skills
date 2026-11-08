import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { dispatchDeps, mergeDeps } from '../lib/schedule.mjs';
import { parseTasks } from '../lib/tasks.mjs';

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
  - Write scope: src/sink.mjs,test/sink.test.mjs
  - Verify with: npm test
  - Scen: SCEN-1`;
const design = '## Impact Inventory\nnone\n';
// A valid R0 sign-off written by hanlin after independent review.
const REVIEW = 'R0: pass(9b2f4c1e-aaaa-4a2b-8c3d-000000000099@abcdef1)\n';
test('accepts narrow non-sink tasks and reports concurrency', () => {
  const dir = change({ 'tasks.md': contract, 'proposal.md': 'x', 'design.md': design, 'acceptance.md': table('| SCEN-1 | CLI | T-01,T-02,T-03,T-04 | node -e "0" | yes | PENDING | pending |'), 'specs/a/spec.md': '### Scenario: SCEN-1\n', 'review.md': REVIEW });
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
const acceptance = table('| SCEN-1 | CLI | T-01,T-02,T-03,T-04 | node -e "0" | yes | PENDING | pending |');
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

test('rejects scenario-less and fixture-only tasks; design.md is optional', () => {
  const files = { 'proposal.md': 'x', 'acceptance.md': acceptance, 'specs/a/spec.md': '### Scenario: SCEN-1\n', 'review.md': REVIEW };
  // design.md absent is legitimate now: the minimal package is proposal + specs + tasks + acceptance.
  const noScen = change({ ...files, 'tasks.md': contract.replace('  - Verify with: node --test test/alpha.test.mjs\n', '  - Verify with: node --test test/alpha.test.mjs\n  - Review: standard\n').replace(/(T-03 beta[\s\S]*?)  - Scen: SCEN-1\n/, '$1') });
  assert.match(run(noScen).stdout, /NO_SCEN T-03/);
  const fixtureOnly = change({ ...files, 'tasks.md': contract.replace('src/beta,test/beta.test.mjs', 'test/beta.test.mjs') });
  assert.match(run(fixtureOnly).stdout, /FIXTURE_ONLY_TASK T-03/);
  const mech = change({ ...files, 'tasks.md': contract.replace(/(T-03 beta[\s\S]*?)  - Scen: SCEN-1\n/, '$1  - Review: mechanical\n').replace('src/beta,test/beta.test.mjs', 'test/beta.test.mjs') });
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

test('design.md prose is free-form but must not name task ids; decisions are named, not tasks', () => {
  const files = { 'proposal.md': 'x', 'acceptance.md': acceptance, 'specs/a/spec.md': '### Scenario: SCEN-1\n', 'tasks.md': contract, 'review.md': REVIEW };
  // Unrelated prose numbering and ids that are not tasks stay free-form.
  assert.equal(run(change({ ...files, 'design.md': '# Design\nfoo() -> fixtures -> T-99, step T-1\n' })).status, 0);
  const named = run(change({ ...files, 'design.md': '# Design\n## Decisions\n- **D-01 local draft**\n  - Owner: T-02\n' }));
  assert.equal(named.status, 1);
  assert.match(named.stdout, /DESIGN_NAMES_TASK T-02: design\.md must not name task ids/);
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
  const adv = (tasks, acc = acceptance) => JSON.parse(execFileSync('node', [path.join(root, 'freeze-check.mjs'), change({ ...files, 'acceptance.md': acc, 'tasks.md': tasks }), '--json', '--skip-signer-check'], { encoding: 'utf8' }));
  const wide = adv(diamond(6), table('| SCEN-1 | CLI | T-01,T-02,T-03,T-04,T-05,T-06 | node -e "0" | yes | PENDING | pending |')); // T-01 then 5 parallel: 6 tasks / 2 waves = 3x
  assert.equal(wide.route, 'pipeline');
  assert.deepEqual(wide.advisories, []);
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
    'acceptance.md': table('| SCEN-1 | CLI | T-00,T-01,T-02,T-03 | npm test | yes | PENDING | pending |'),
    'specs/a/spec.md': '### Scenario: SCEN-1\n',
    'review.md': REVIEW,
  }), '--json', '--skip-signer-check'], { encoding: 'utf8' }));
  assert.deepEqual(report.criticalChain.map((step) => [step.id, step.via]),    [['T-00', null], ['T-01', 'uses'], ['T-02', 'logical'], ['T-03', 'logical']]);
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
    '  - Write scope: src/sink.mjs,test/sink.test.mjs',
    '  - Verify with: npm test',
    '  - Scen: SCEN-1',
    '',
  ].join('\n');
  const report = JSON.parse(execFileSync('node', [path.join(root, 'freeze-check.mjs'), change({
    'tasks.md': tasks,
    'proposal.md': 'x',
    'design.md': design,
    'acceptance.md': table('| SCEN-1 | CLI | T-01,T-02,T-03 | npm test | yes | PENDING | pending |'),
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
    '  - Write scope: src/sink.mjs,test/sink.test.mjs',
    '  - Verify with: npm test',
    '  - Scen: SCEN-1',
    '',
  ].join('\n');
  const report = JSON.parse(execFileSync('node', [path.join(root, 'freeze-check.mjs'), change({
    'tasks.md': tasks,
    'proposal.md': 'x',
    'design.md': design,
    'acceptance.md': table('| SCEN-1 | CLI | T-01,T-02,T-03 | npm test | yes | PENDING | pending |'),
    'specs/a/spec.md': '### Scenario: SCEN-1\n',
    'review.md': REVIEW,
  }), '--json', '--skip-signer-check'], { encoding: 'utf8' }));
  assert.doesNotMatch(report.advisories.join('\n'), /ADVISORY_READS_ONLY_EDGE/);
});

function sinkContract(verify, extra = '') {
  return contract.replace('Verify with: npm test', `Verify with: ${verify}`).replace('  - Scen: SCEN-1\n', '  - Scen: SCEN-1\n').replace(/(1\.4 T-04 sink\n)/, `$1${extra}`);
}
function freezeOf(tasks) {
  return run(change({ 'tasks.md': tasks, 'proposal.md': 'x', 'design.md': design, 'acceptance.md': table('| SCEN-1 | CLI | T-01,T-02,T-03,T-04 | node -e "0" | yes | PENDING | pending |'), 'specs/a/spec.md': '### Scenario: SCEN-1\n', 'review.md': REVIEW }));
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
test('mechanical non-sink still needs narrow Verify', () => {
  const tasks = contract.replace('  - Verify with: node --test test/alpha.test.mjs', '  - Review: mechanical\n  - Verify with: rg -c done src/alpha');
  assert.match(freezeOf(tasks).stdout, /VERIFY_NOT_NARROW T-02/);
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

// ---- R0 closure: a recorded human exception instead of a forged pass ----
const report = (dir) => {
  const result = spawnSync('node', [path.join(root, 'freeze-check.mjs'), dir, '--json', '--skip-signer-check'], { encoding: 'utf8' });
  return JSON.parse(result.stdout);
};

test('R0 human-accept: requires approval for that SHA, not unrelated run-log approvals', () => {
  const { dir, sha } = signedRepo((commit) => `R0: human-accept(@${commit})\n`);
  assert.match(report(dir).blocking.join('\n'), /R0_HUMAN_ACCEPT_UNRECORDED/);

  fs.writeFileSync(path.join(dir, 'run-log.md'), 'Approval: 2026-11-05T08:00:00Z deploy production\n');
  assert.match(report(dir).blocking.join('\n'), /R0_HUMAN_ACCEPT_UNRECORDED/);

  fs.writeFileSync(path.join(dir, 'run-log.md'), `Approval: R0 residual risk accepted for deadbee — accepted\n`);
  assert.match(report(dir).blocking.join('\n'), /R0_HUMAN_ACCEPT_UNRECORDED/);

  fs.writeFileSync(path.join(dir, 'run-log.md'), `Approval: R0 residual risk accepted for ${sha.slice(0, 7)} — accepted after reviewing blockers\n`);
  const recorded = report(dir);
  assert.deepEqual(recorded.blocking, []);
  assert.match(recorded.advisories.join('\n'), /R0_HUMAN_EXCEPTION/);
});

test('R0 human-accept: a later hanlin pass wins; a later human-accept without approval blocks', () => {
  const passed = signedRepo((sha) => `R0: human-accept(@deadbee)\nR0: pass(hanlin-uuid@${sha})\n`);
  assert.equal(run(passed.dir).status, 0, 'the pass supersedes the exception');
  const reverted = signedRepo((sha) => `R0: pass(hanlin-uuid@${sha})\nR0: human-accept(@${sha})\n`);
  assert.match(run(reverted.dir).stdout, /R0_HUMAN_ACCEPT_UNRECORDED/);
});

test('R0 human-accept: run-log.md is not contract drift', () => {
  const { dir, sha } = signedRepo((sha) => `R0: human-accept(@${sha})\n`);
  fs.writeFileSync(path.join(dir, 'run-log.md'), `Approval: R0 residual risk accepted for ${sha.slice(0, 7)} — accepted\n`);
  assert.deepEqual(report(dir).blocking, []);
});

test('R0 human-accept: a malformed line still blocks as MISSING_R0_SIGNOFF', () => {
  const { dir } = signedRepo(() => 'R0: human-accept\n');
  assert.match(run(dir).stdout, /MISSING_R0_SIGNOFF/);
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
  - Write scope: src/sink.ts,test/sink.test.mjs
  - Verify with: npm test
  - Scen: SCEN-1`;
const scheduleFiles = (tasks) => ({
  'tasks.md': tasks,
  'proposal.md': 'x',
  'design.md': design,
  'acceptance.md': table('| SCEN-1 | CLI | T-01,T-02,T-03 | node -e "0" | yes | PENDING | pending |'),
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

test('Uses blocks when interface owner is disconnected from actual dispatch', () => {
  const tasks = scheduleContract
    .replace('  - Uses: T-00\n  - Write scope: src/alpha', '  - Interface: src/iface/form.ts#useDraft\n  - Write scope: src/alpha')
    .replace('  - Uses: T-00\n  - Write scope: src/beta', '  - Uses: T-01\n  - Write scope: src/beta');
  const result = freezeStructural(tasks);
  const parsed = parseTasks(tasks).tasks;
  const consumer = parsed.find((task) => task.id === 'T-02');
  assert.deepEqual(dispatchDeps(consumer, parsed), []);
  assert.deepEqual(mergeDeps(consumer), ['T-01']);
  assert.match(result.stdout, /INTERFACE_NOT_READY T-02/);
});

test('Uses accepts a target skeleton and a transitively ready skeleton owner', () => {
  assert.equal(freezeStructural(scheduleContract).status, 0);
  const transitive = scheduleContract
    .replace('  - Uses: T-00\n  - Write scope: src/alpha', '  - Depends on: T-00\n  - Interface: src/iface/form.ts#useDraft\n  - Write scope: src/alpha')
    .replace('  - Uses: T-00\n  - Write scope: src/beta', '  - Uses: T-01\n  - Write scope: src/beta');
  const parsed = parseTasks(transitive).tasks;
  const consumer = parsed.find((task) => task.id === 'T-02');
  assert.deepEqual(dispatchDeps(consumer, parsed), ['T-00']);
  assert.deepEqual(mergeDeps(consumer), ['T-01']);
  assert.equal(freezeStructural(transitive).status, 0);
});

test('Uses accepts a skeleton reached through another dispatch dependency', () => {
  const tasks = scheduleContract
    .replace('  - Uses: T-00\n  - Write scope: src/alpha', '  - Interface: src/iface/form.ts#useDraft\n  - Write scope: src/alpha')
    .replace('  - Uses: T-00\n  - Write scope: src/beta', '  - Uses: T-01\n  - Depends on: T-04\n  - Write scope: src/beta')
    .concat('\n- [ ] 1.5 T-04 intermediary\n  - Depends on: T-00\n  - Write scope: src/mid,test/mid.test.mjs\n  - Review: mechanical\n  - Verify with: node --test test/mid.test.mjs\n');
  const parsed = parseTasks(tasks).tasks;
  assert.deepEqual(dispatchDeps(parsed.find((task) => task.id === 'T-02'), parsed), ['T-04']);
  assert.equal(freezeStructural(tasks).status, 0);
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
  - Write scope: src/sink.ts,test/sink.test.mjs
  - Verify with: npm test
  - Scen: SCEN-1`;
  const result = freezeStructural(tasks);
  assert.equal(result.status, 0, result.stdout);
});

test('DEFERRED_NOT_STANDARD blocks the sink and persistence/security surfaces, but not public-api', () => {
  const sink = scheduleContract.replace('  - Verify with: npm test\n', '  - Verify with: npm test\n  - Review: deferred\n');
  assert.match(freezeStructural(sink).stdout, /DEFERRED_NOT_STANDARD T-03/);

  const persistence = scheduleContract.replace('  - Review: deferred\n  - Verify with: node --test test/alpha.test.mjs', '  - Review: deferred\n  - Risk-surface: [persistence]\n  - Verify with: node --test test/alpha.test.mjs');
  const persistenceResult = freezeStructural(persistence);
  assert.match(persistenceResult.stdout, /DEFERRED_NOT_STANDARD T-01/);
  assert.match(persistenceResult.stdout, /FINAL attention/);
  assert.doesNotMatch(persistenceResult.stdout, /reviewed inline/);

  const security = scheduleContract.replace('  - Review: deferred\n  - Verify with: node --test test/alpha.test.mjs', '  - Review: deferred\n  - Risk-surface: security\n  - Verify with: node --test test/alpha.test.mjs');
  assert.match(freezeStructural(security).stdout, /DEFERRED_NOT_STANDARD T-01/);

  const publicApi = scheduleContract.replace('  - Review: deferred\n  - Verify with: node --test test/alpha.test.mjs', '  - Review: deferred\n  - Risk-surface: public-api\n  - Verify with: node --test test/alpha.test.mjs');
  assert.equal(freezeStructural(publicApi).status, 0, freezeStructural(publicApi).stdout);
  for (const mode of ['standard', 'mechanical']) {
    const risk = scheduleContract.replace('  - Review: deferred\n  - Verify with: node --test test/alpha.test.mjs', `  - Review: ${mode}\n  - Risk-surface: security\n  - Verify with: node --test test/alpha.test.mjs`);
    assert.equal(freezeStructural(risk).status, 0, freezeStructural(risk).stdout);
  }
});

test('skeleton Write-scope overlap is exempt against transitive dependents', () => {
  // T-03 depends on T-01, which Uses the skeleton: it cannot start before the skeleton merged.
  const transitive = scheduleContract
    .replace('  - Depends on: T-00,T-01,T-02\n  - Write scope: src/sink.ts,test/sink.test.mjs', '  - Depends on: T-01,T-02\n  - Write scope: src/iface/sink.ts,test/sink.test.mjs');
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
  const row = '| SCEN-1 | CLI | T-01,T-02,T-03,T-04 | echo "a | b" | yes | PENDING | pending |';
  const dir = change({ 'tasks.md': contract, 'proposal.md': 'x', 'design.md': design, 'acceptance.md': table(row), 'specs/a/spec.md': '### Scenario: SCEN-1\n' });
  const result = run(dir);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /MALFORMED_ACCEPTANCE_ROW/);
  // An escaped pipe keeps the column count and is accepted.
  const escaped = change({ 'tasks.md': contract, 'proposal.md': 'x', 'design.md': design, 'acceptance.md': table('| SCEN-1 | CLI | T-01,T-02,T-03,T-04 | echo "a \\| b" | yes | PENDING | pending |'), 'specs/a/spec.md': '### Scenario: SCEN-1\n', 'review.md': REVIEW });
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
    .replace('Write scope: src/sink.mjs,test/sink.test.mjs', 'Write scope: src/sink.mjs,test/sink.test.mjs,scripts/specs/probe.mjs')
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
  // The task owns this future file; scope permits the reference, not proof it will exist.
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

test('future sibling Verify input is structurally allowed, not proven ready', () => {
  const tasks = scheduleContract
    .replace('Write scope: src/alpha,test/alpha.test.mjs', 'Write scope: src/alpha,test/alpha.test.mjs,test/future.test.mjs')
    .replace('  - Review: deferred\n  - Verify with: node --test test/beta.test.mjs', '  - Reads: test/future.test.mjs\n  - Review: deferred\n  - Verify with: node --test test/future.test.mjs');
  const dir = change(scheduleFiles(tasks));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  const parsed = parseTasks(tasks).tasks;
  assert.deepEqual(dispatchDeps(parsed.find((task) => task.id === 'T-02'), parsed), ['T-00']);
  assert.equal(run(dir, ['--structural', '--skip-signer-check']).status, 0);
  assert.equal(fs.existsSync(path.join(dir, 'test/future.test.mjs')), false);
});

test('no digest artifact is required and none is checked', () => {
  const files = { 'proposal.md': 'x', 'acceptance.md': acceptance, 'specs/a/spec.md': '### Scenario: SCEN-1\n', 'tasks.md': contract, 'review.md': REVIEW };
  const report = JSON.parse(execFileSync('node', [path.join(root, 'freeze-check.mjs'), change(files), '--json', '--skip-signer-check'], { encoding: 'utf8' }));
  assert.equal(report.route, 'pipeline');
  assert.ok(!report.advisories.some((item) => item.startsWith('ADVISORY_BASELINE_ALIGNMENT')));
});

test('routing wave width follows runtime Uses skeleton dependencies', () => {
  const serial = scheduleContract
    .replace('  - Uses: T-00\n  - Write scope: src/beta', '  - Depends on: T-01\n  - Write scope: src/beta')
    .replace('  - Depends on: T-00,T-01,T-02', '  - Depends on: T-02');
  const report = JSON.parse(freezeStructural(serial).stdout);
  assert.equal(report.maxWidth, 1);
  assert.equal(report.route, 'handoff');
  assert.match(report.maxWidthMeaning, /heuristic/);
  assert.match(report.weightedSpeedupMeaning, /unmeasured/);
  const parallel = JSON.parse(freezeStructural(scheduleContract).stdout);
  assert.equal(parallel.maxWidth, 2);
  assert.equal(parallel.route, 'pipeline');
});

test('freeze rejects mixed Uses and Depends on deadlock', () => {
  const deadlock = scheduleContract.replace('  - Kind: skeleton', '  - Depends on: T-01\n  - Kind: skeleton');
  const result = freezeStructural(deadlock);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /CYCLE/);
});

test('invalid Uses emits one diagnostic and suppresses route', () => {
  for (const target of ['T-99', 'T-01']) {
    const report = JSON.parse(freezeStructural(scheduleContract.replace('  - Uses: T-00', `  - Uses: ${target}`)).stdout);
    assert.equal(report.blocking.filter((item) => item.startsWith('USES_UNKNOWN T-01:')).length, 1);
    assert.equal(report.blocking.filter((item) => item.startsWith('CYCLE')).length, 0);
    assert.equal(report.route, null);
  }
});

test('invalid graphs never report actionable routing or modeled estimates', () => {
  const cases = [
    scheduleContract.replace('  - Kind: skeleton', '  - Depends on: T-01\n  - Kind: skeleton'),
    scheduleContract.replace('  - Uses: T-00', '  - Uses: T-99'),
    scheduleContract.replace('  - Depends on: T-00,T-01,T-02', '  - Depends on: T-99'),
    scheduleContract + '\n- [ ] T-01 duplicate\n',
    '# Tasks\n',
  ];
  for (const tasks of cases) {
    const dir = change(scheduleFiles(tasks));
    const result = run(dir, ['--structural', '--skip-signer-check']);
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.route, null);
    assert.equal(report.weightedSpeedup, null);
    assert.equal(report.speedup, null);
    assert.equal(report.maxWidth, null);
    assert.equal(report.criticalPath, null);
    assert.deepEqual(report.waves, []);
    assert.deepEqual(report.criticalChain, []);
    const text = spawnSync('node', [path.join(root, 'freeze-check.mjs'), dir, '--structural', '--skip-signer-check'], { encoding: 'utf8' });
    assert.equal(text.status, 1);
    assert.match(text.stdout, /\[ROUTE\] invalid/);
    assert.doesNotMatch(text.stdout, /\[ROUTE\] (pipeline|handoff)\b|^WAVE |^CRITICAL /m);
  }
});

test('non-graph blocks retain advisory route needed before R0', () => {
  const result = run(change(scheduleFiles(scheduleContract)), ['--skip-signer-check']);
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.ok(report.blocking.some((item) => item.startsWith('MISSING_R0_SIGNOFF')));
  assert.equal(report.route, 'pipeline');
  assert.equal(typeof report.weightedSpeedup, 'number');
});

test('acceptance Required accepts yes/no case-insensitively and rejects invalid values even beside yes', () => {
  const files = { 'tasks.md': contract, 'proposal.md': 'x', 'design.md': design, 'specs/a/spec.md': '### Scenario: SCEN-1\n', 'review.md': REVIEW };
  for (const required of ['yes', 'YES', 'Yes', 'no', 'NO', 'No', '`yes`', '`no`']) {
    const rows = `${acceptance}\n| SCEN-1 | CLI | T-02 | node -e "0" | ${required} | PENDING | pending |`;
    const result = run(change({ ...files, 'acceptance.md': rows }));
    assert.equal(result.status, 0, `${required}: ${result.stdout}`);
  }
  for (const required of ['', 'maybe', 'y', 'true', 'nope', 'yes please']) {
    const rows = `${acceptance}\n| SCEN-1 | CLI | T-02 | node -e "0" | ${required} | PENDING | pending |`;
    const result = run(change({ ...files, 'acceptance.md': rows }));
    assert.equal(result.status, 1, required);
    assert.match(result.stdout, /BAD_ACCEPTANCE_REQUIRED/);
    assert.match(result.stdout, /acceptance\.md:4/);
  }
});

test('acceptance requires the same seven-column header as runner', () => {
  const files = { 'tasks.md': contract, 'proposal.md': 'x', 'design.md': design, 'specs/a/spec.md': '### Scenario: SCEN-1\n', 'review.md': REVIEW };
  const original = '| Scenario | Entry | Tasks | Verify | Required | Result | Evidence |';
  for (const [header, row] of [
    ['| Scenario | Entry | Tasks | Verify | Required | Result | Evidence | Extra |', '| SCEN-1 | CLI | T-02 | node -e "0" | yes | PENDING | pending | extra |'],
    ['| Scenario | Entry | Tasks | Verify | Required | Outcome | Evidence |', '| SCEN-1 | CLI | T-02 | node -e "0" | yes | PENDING | pending |'],
    ['| Scenario | Entry | Tasks | Verify | Required | Evidence | Result |', '| SCEN-1 | CLI | T-02 | node -e "0" | yes | PENDING | pending |'],
  ]) {
    const content = table(row).replace(original, header);
    const result = run(change({ ...files, 'acceptance.md': content }));
    assert.equal(result.status, 1, header);
    assert.match(result.stdout, /BAD_ACCEPTANCE_HEADER/);
  }
  for (const header of ['| scenario | ENTRY | tasks | verify | required | result | evidence |', '| `Scenario` | `Entry` | `Tasks` | `Verify` | `Required` | `Result` | `Evidence` |']) {
    const result = run(change({ ...files, 'acceptance.md': acceptance.replace(original, header) }));
    assert.equal(result.status, 0, result.stdout);
  }
  const missing = run(change({ ...files, 'acceptance.md': '| SCEN-1 | CLI | T-02 | node -e "0" | yes | PENDING | pending |' }));
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /BAD_ACCEPTANCE_HEADER/);
});

// ---- acceptance <-> tasks alignment, cross-change ids, sink assembly, design decisions ----
function aligned(files = {}) {
  const tasks = `- [ ] 1.1 T-01 shared
  - Write scope: src/shared,test/shared.test.mjs
  - Verify with: node --test test/shared.test.mjs
  - Scen: SCEN-1
  - Implements: D-01
- [ ] 1.2 T-02 sink
  - Depends on: T-01
  - Write scope: src/app.mjs,test/sink.test.mjs
  - Verify with: npm test
  - Scen: SCEN-1
  - Implements: D-01, D-02`;
  return change({
    'tasks.md': tasks,
    'proposal.md': 'x',
    'design.md': '## Decisions\n- **D-01 shared helper** 影响模块/路径: src/shared\n- **D-02 wiring** 影响模块/路径: src/app.mjs\n',
    'acceptance.md': table('| SCEN-1 | CLI | T-01,T-02 | node -e "0" | yes | PENDING | pending |'),
    'specs/a/spec.md': '### Scenario: SCEN-1\n',
    'review.md': REVIEW,
    ...files,
  });
}
const codes = (result) => {
  try { return JSON.parse(result.stdout).blocking; } catch { return []; }
};

test('BAD_ACCEPTANCE_TASKS: a Required=yes row with no task id is rejected', () => {
  const result = run(change({
    'tasks.md': contract, 'proposal.md': 'x', 'design.md': design, 'specs/a/spec.md': '### Scenario: SCEN-1\n', 'review.md': REVIEW,
    'acceptance.md': table('| SCEN-1 | CLI |  | node -e "0" | yes | PENDING | pending |'),
  }));
  assert.equal(result.status, 1);
  assert.match(codes(result).join('\n'), /^BAD_ACCEPTANCE_TASKS acceptance\.md:3 SCEN-1: Tasks must list at least one task id$/m);
});

test('UNKNOWN_ACCEPTANCE_TASK: a Tasks cell naming a task absent from tasks.md is rejected', () => {
  const result = run(change({
    'tasks.md': contract, 'proposal.md': 'x', 'design.md': design, 'specs/a/spec.md': '### Scenario: SCEN-1\n', 'review.md': REVIEW,
    'acceptance.md': table('| SCEN-1 | CLI | T-01,T-02,T-03,T-04,T-99 | node -e "0" | yes | PENDING | pending |'),
  }));
  assert.equal(result.status, 1);
  assert.match(codes(result).join('\n'), /^UNKNOWN_ACCEPTANCE_TASK SCEN-1: T-99 is not a task in tasks\.md$/m);
});

test('UNOWNED_ACCEPTANCE_SCEN: the Tasks cell must name at least one task claiming the SCEN', () => {
  // T-01 carries only SCEN-1; the SCEN-2 row naming it therefore has no real owner.
  const tasks = `- [ ] 1.1 T-01 shared
  - Write scope: src/shared,test/shared.test.mjs
  - Verify with: node --test test/shared.test.mjs
  - Scen: SCEN-1
- [ ] 1.2 T-02 other
  - Write scope: src/other,test/other.test.mjs
  - Verify with: node --test test/other.test.mjs
  - Scen: SCEN-2`;
  const result = run(change({
    'tasks.md': tasks, 'proposal.md': 'x', 'design.md': design, 'review.md': REVIEW,
    'acceptance.md': table('| SCEN-1 | CLI | T-02 | node -e "0" | yes | PENDING | pending |\n| SCEN-2 | CLI | T-01 | node -e "0" | yes | PENDING | pending |'),
    'specs/a/spec.md': '### Scenario: SCEN-1\n### Scenario: SCEN-2\n',
  }));
  assert.equal(result.status, 1);
  assert.match(codes(result).join('\n'), /^UNOWNED_ACCEPTANCE_SCEN SCEN-1: none of T-02 claims it in tasks\.md Scenarios$/m);
});

test('UNACCEPTED_SCEN: every declared SCEN needs an acceptance row', () => {
  const dir = change({
    'tasks.md': `${contract}\n- [ ] 1.5 T-05 other\n  - Write scope: src/other,test/other.test.mjs\n  - Verify with: node --test test/other.test.mjs\n  - Scen: SCEN-2`,
    'proposal.md': 'x', 'design.md': design, 'review.md': REVIEW,
    'acceptance.md': acceptance,
    'specs/a/spec.md': '### Scenario: SCEN-1\n### Scenario: SCEN-2\n',
  });
  const result = run(dir);
  assert.equal(result.status, 1);
  assert.match(codes(result).join('\n'), /^UNACCEPTED_SCEN SCEN-2 \(specs\/a\/spec\.md\): every declared SCEN needs an acceptance row$/m);
});

test('UNACCEPTED_TASK_SCEN: every claiming task must appear in that SCEN\'s Tasks cell', () => {
  const result = run(change({
    'tasks.md': contract, 'proposal.md': 'x', 'design.md': design, 'specs/a/spec.md': '### Scenario: SCEN-1\n', 'review.md': REVIEW,
    'acceptance.md': table('| SCEN-1 | CLI | T-02,T-03,T-04 | node -e "0" | yes | PENDING | pending |'),
  }));
  assert.equal(result.status, 1);
  assert.match(codes(result).join('\n'), /^UNACCEPTED_TASK_SCEN T-01: SCEN-1 is claimed but no acceptance row lists T-01$/m);
});

test('COLLIDING_SCEN: another change declaring the id blocks; MODIFIED/REMOVED re-declaration is allowed', () => {
  const colliding = aligned();
  const sh = (...args) => execFileSync('git', ['-C', colliding, ...args], { encoding: 'utf8' }).trim();
  sh('init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(colliding, 'openspec/changes/other/specs/cap'), { recursive: true });
  fs.writeFileSync(path.join(colliding, 'openspec/changes/other/specs/cap/spec.md'), '## ADDED Requirements\n### Scenario: SCEN-1 other\n');
  const blocked = run(colliding, ['--structural', '--skip-signer-check']);
  assert.equal(blocked.status, 1);
  assert.match(codes(blocked).join('\n'), /^COLLIDING_SCEN SCEN-1: already declared in openspec\/changes\/other\/specs\/cap\/spec\.md$/m);
  // A MODIFIED re-declaration updates the same requirement, so it is not a collision.
  fs.writeFileSync(path.join(colliding, 'openspec/changes/other/specs/cap/spec.md'), '## MODIFIED Requirements\n### Scenario: SCEN-1 other\n');
  const allowed = run(colliding, ['--structural', '--skip-signer-check']);
  assert.equal(allowed.status, 0, JSON.stringify(codes(allowed)));
});

test('SINK_TEST_ONLY: a sink whose whole Write scope is tests is rejected', () => {
  const result = run(change({
    'tasks.md': contract.replace('Write scope: src/sink.mjs,test/sink.test.mjs', 'Write scope: test/sink.test.mjs'),
    'proposal.md': 'x', 'design.md': design, 'specs/a/spec.md': '### Scenario: SCEN-1\n', 'review.md': REVIEW,
    'acceptance.md': acceptance,
  }));
  assert.equal(result.status, 1);
  assert.match(codes(result).join('\n'), /^SINK_TEST_ONLY T-04: sink Write scope has only test paths; the sink must own the assembly\/wiring file$/m);
});

test('DESIGN_NAMES_TASK: design.md naming a declared task id is rejected', () => {
  const result = run(aligned({ 'design.md': '## Decisions\n- **D-01 shared helper**\n  - Owner: T-01\n- **D-02 wiring**\n' }));
  assert.equal(result.status, 1);
  assert.match(codes(result).join('\n'), /^DESIGN_NAMES_TASK T-01: design\.md must not name task ids; name decisions and let tasks\.md declare Implements:$/m);
});

test('UNKNOWN_DECISION: Implements must name a decision heading in design.md', () => {
  const result = run(aligned({ 'design.md': '## Decisions\n- **D-01 shared helper**\n' }));
  assert.equal(result.status, 1);
  assert.match(codes(result).join('\n'), /^UNKNOWN_DECISION T-02: Implements D-02 is not a decision heading in design\.md$/m);
});

test('a fully aligned package with a production-owning sink, Implements ids and no design task ids passes', () => {
  const dir = aligned();
  const result = run(dir);
  assert.equal(result.status, 0, result.stdout);
  assert.deepEqual(codes(result), []);
});
