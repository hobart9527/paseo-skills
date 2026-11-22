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
  const dir = change({ 'tasks.md': contract, 'proposal.md': 'x', 'design.md': design, 'acceptance.md': table('| SCEN-1 | CLI | T-01,T-02,T-03,T-04 | node --test test/shared.test.mjs | yes | PENDING | pending |'), 'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n', 'review.md': REVIEW });
  const result = run(dir);
  assert.equal(result.status, 0);
});
test('rejects full-suite non-sink verify', () => {
  const bad = contract.replace('node --test test/alpha.test.mjs', 'npm test');
  const dir = change({ 'tasks.md': bad, 'proposal.md': 'x', 'design.md': design, 'acceptance.md': 'x', 'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n' });
  const result = run(dir);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /VERIFY_NOT_NARROW T-02/);
});
test('accepts scoped non-node runners and rejects unscoped ones', () => {
  const files = { 'proposal.md': 'x', 'design.md': design, 'acceptance.md': acceptance, 'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n', 'review.md': REVIEW };
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
    const dir = change({ 'tasks.md': bad, 'proposal.md': 'x', 'design.md': design, 'acceptance.md': 'x', 'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n' });
    const result = run(dir);
    assert.equal(result.status, 1, verify);
    assert.match(result.stdout, /VERIFY_NOT_NARROW T-02/, verify);
  }
});
test('rejects verify paths that fall outside the task Write scope', () => {
  const bad = contract.replace('node --test test/alpha.test.mjs', 'node --test test/beta.test.mjs');
  const dir = change({ 'tasks.md': bad, 'proposal.md': 'x', 'design.md': design, 'acceptance.md': 'x', 'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n' });
  const result = run(dir);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /VERIFY_NOT_NARROW T-02/);
});
test('rejects wave scope conflict', () => {
  const bad = contract.replace('src/beta,test/beta.test.mjs', 'src/alpha,test/beta.test.mjs');
  const dir = change({ 'tasks.md': bad, 'proposal.md': 'x', 'design.md': design, 'acceptance.md': 'x', 'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n' });
  const result = run(dir);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /SCOPE_CONFLICT/);
});

const table = (rows) => `| Scenario | Entry | Tasks | Verify | Required | Result | Evidence |\n| --- | --- | --- | --- | --- | --- | --- |\n${rows}`;
const acceptance = table('| SCEN-1 | CLI | T-01,T-02,T-03,T-04 | node --test test/shared.test.mjs | yes | PENDING | pending |');
test('accepts schema scenario headings with descriptions and rejects hidden full-suite legs', () => {
  const bad = contract.replace('node --test test/alpha.test.mjs', 'npm test && node --test test/alpha.test.mjs');
  const dir = change({ 'tasks.md': bad, 'proposal.md': 'x', 'design.md': design, 'acceptance.md': acceptance, 'specs/a/spec.md': '### Scenario: SCEN-1 successful alpha\n- **Verify:** node --test test/shared.test.mjs\n' });
  const result = run(dir);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /VERIFY_FULL_SUITE_NON_SINK T-02/);
});
test('rejects zero parsed tasks and multiple full-suite sinks', () => {
  const empty = change({ 'tasks.md': '# Tasks\n- [ ] 1.1 missing ID\n', 'proposal.md': 'x', 'design.md': design, 'acceptance.md': acceptance, 'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n' });
  assert.match(run(empty).stdout, /EMPTY_TASKS/);
  const twoSinks = contract.replace('npm test', 'npm test').replace('  - Verify with: npm test', '  - Verify with: npm test').replace('- [ ] 1.3 T-03 beta\n  - Depends on: T-01\n  - Write scope: src/beta,test/beta.test.mjs\n  - Verify with: node --test test/beta.test.mjs', '- [ ] 1.3 T-03 beta\n  - Write scope: src/beta,test/beta.test.mjs\n  - Verify with: npm test');
  const dir = change({ 'tasks.md': twoSinks, 'proposal.md': 'x', 'design.md': design, 'acceptance.md': acceptance, 'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n' });
  const result = run(dir);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /TOO_MANY_FULL_SUITE_SINKS/);
  assert.match(result.stdout, /VERIFY_FULL_SUITE_NON_SINK T-03/);
});
test('validates required acceptance scenarios and frozen state', () => {
  const good = change({ 'tasks.md': contract, 'proposal.md': 'x', 'design.md': design, 'acceptance.md': acceptance, 'specs/a/spec.md': '### Scenario: SCEN-1 alpha works\n- **Verify:** node --test test/shared.test.mjs\n', 'review.md': REVIEW });
  assert.equal(run(good).status, 0);
  const unknown = change({ 'tasks.md': contract, 'proposal.md': 'x', 'design.md': design, 'acceptance.md': table('| SCEN-X | CLI | T-02 | node --test test/shared.test.mjs | yes | PENDING | pending |'), 'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n' });
  assert.match(run(unknown).stdout, /UNKNOWN_ACCEPTANCE_SCEN/);
  const notPending = change({ 'tasks.md': contract, 'proposal.md': 'x', 'design.md': design, 'acceptance.md': table('| SCEN-1 | CLI | T-02 | node --test test/shared.test.mjs | yes | PASS | pending |'), 'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n' });
  assert.match(run(notPending).stdout, /ACCEPTANCE_NOT_FROZEN/);
  const noRequired = change({ 'tasks.md': contract, 'proposal.md': 'x', 'design.md': design, 'acceptance.md': table('| SCEN-1 | CLI | T-02 | node -e "0" | no | PENDING | pending |'), 'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n' });
  assert.match(run(noRequired).stdout, /MISSING_REQUIRED_ACCEPTANCE/);
});

test('rejects scenario-less and fixture-only tasks; design.md is optional', () => {
  const files = { 'proposal.md': 'x', 'acceptance.md': acceptance, 'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n', 'review.md': REVIEW };
  // design.md absent is legitimate now: the minimal package is proposal + specs + tasks + acceptance.
  const noScen = change({ ...files, 'tasks.md': contract.replace('  - Verify with: node --test test/alpha.test.mjs\n', '  - Verify with: node --test test/alpha.test.mjs\n  - Review: standard\n').replace(/(T-03 beta[\s\S]*?)  - Scen: SCEN-1\n/, '$1') });
  assert.match(run(noScen).stdout, /NO_SCEN T-03/);
  const fixtureOnly = change({ ...files, 'tasks.md': contract.replace('src/beta,test/beta.test.mjs', 'test/beta.test.mjs') });
  assert.match(run(fixtureOnly).stdout, /FIXTURE_ONLY_TASK T-03/);
  // T-03 drops its SCEN claim when it becomes mechanical, so acceptance must stop listing it.
  const mech = change({
    ...files,
    'acceptance.md': table('| SCEN-1 | CLI | T-01,T-02,T-04 | node --test test/shared.test.mjs | yes | PENDING | pending |'),
    'tasks.md': contract.replace(/(T-03 beta[\s\S]*?)  - Scen: SCEN-1\n/, '$1  - Review: mechanical\n').replace('src/beta,test/beta.test.mjs', 'test/beta.test.mjs'),
  });
  assert.equal(run(mech).status, 0);
});

test('rejects scope overlap between tasks in different waves with no dependency path', () => {
  const files = { 'proposal.md': 'x', 'design.md': design, 'acceptance.md': acceptance, 'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n', 'review.md': REVIEW };
  const bad = contract.replace('src/beta,test/beta.test.mjs', 'src/shared/x,test/beta.test.mjs').replace('Write scope: src/alpha,test/alpha.test.mjs', 'Write scope: src/shared,test/alpha.test.mjs');
  assert.match(run(change({ ...files, 'tasks.md': bad })).stdout, /SCOPE_CONFLICT/);
  // ordered by dependency is fine: T-02 depends on T-01 which owns src/shared
  const ok = contract.replace('Write scope: src/alpha,test/alpha.test.mjs', 'Write scope: src/shared/alpha,test/alpha.test.mjs');
  assert.equal(run(change({ ...files, 'tasks.md': ok })).status, 0);
});

test('design.md prose is free-form but must not name task ids; decisions are named, not tasks', () => {
  const files = { 'proposal.md': 'x', 'acceptance.md': acceptance, 'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n', 'tasks.md': contract, 'review.md': REVIEW };
  // Unrelated prose numbering and ids that are not tasks stay free-form.
  assert.equal(run(change({ ...files, 'design.md': '# Design\nfoo() -> fixtures -> T-99, step T-1\n' })).status, 0);
  const named = run(change({ ...files, 'design.md': '# Design\n## Decisions\n- **D-01 local draft**\n  - Owner: T-02\n' }));
  assert.equal(named.status, 1);
  assert.match(named.stdout, /DESIGN_NAMES_TASK T-02: design\.md must not name task ids/);
});

test('rejects missing R0 sign-off (no review.md)', () => {
  const dir = change({ 'tasks.md': contract, 'proposal.md': 'x', 'design.md': design, 'acceptance.md': acceptance, 'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n' });
  const result = run(dir);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /MISSING_R0_SIGNOFF/);
});

test('rejects malformed R0 sign-off (wrong format)', () => {
  for (const bad of ['R0: approved by hanlin', 'R0: pass(no-at-sign)', 'signed off']) {
    const dir = change({ 'tasks.md': contract, 'proposal.md': 'x', 'design.md': design, 'acceptance.md': acceptance, 'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n', 'review.md': bad });
    assert.equal(run(dir).status, 1, `should reject: ${bad}`);
    assert.match(run(dir).stdout, /MISSING_R0_SIGNOFF/, `should name error: ${bad}`);
  }
});

test('accepts valid R0 sign-off with full UUID or short SHA', () => {
  const withFullUuid = change({ 'tasks.md': contract, 'proposal.md': 'x', 'design.md': design, 'acceptance.md': acceptance, 'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n', 'review.md': 'R0: pass(9b2f4c1e-aaaa-4a2b-8c3d-000000000099@abcdef1)\n\nFindings: none.\n' });
  assert.equal(run(withFullUuid).status, 0);
  const withLongSha = change({ 'tasks.md': contract, 'proposal.md': 'x', 'design.md': design, 'acceptance.md': acceptance, 'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n', 'review.md': 'R0: pass(hanlin-agent-uuid@abcdef1234567890abcdef1234567890abcdef12)\n' });
  assert.equal(run(withLongSha).status, 0);
});

test('--structural passes without review.md; default mode still blocks', () => {
  const dir = change({ 'tasks.md': contract, 'proposal.md': 'x', 'design.md': design, 'acceptance.md': acceptance, 'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n' });
  assert.equal(run(dir, ['--structural']).status, 0);
  assert.equal(run(dir).status, 1);
});

test('R0 sign-off is bound to the reviewed commit: unknown sha and later edits are rejected', () => {
  const dir = change({ 'tasks.md': contract, 'proposal.md': 'x', 'design.md': design, 'acceptance.md': acceptance, 'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n' });
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
const signed = () => change({ 'tasks.md': contract, 'proposal.md': 'x', 'design.md': design, 'acceptance.md': acceptance, 'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n', 'review.md': `R0: pass(${SIGNER}@abcdef1)\n` });

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

test('R0 signer: non-R0 name is an advisory, not a block', () => {
  const dir = signed();
  const env = fakePaseo([{ id: SIGNER, shortId: '9b2f4c1', name: 'random chat', provider: 'claude/cc' }]);
  const out = execFileSync('node', [path.join(root, 'freeze-check.mjs'), dir, '--json'], { encoding: 'utf8', env });
  assert.match(JSON.parse(out).advisories.join('\n'), /R0_SIGNER_NOT_R0/);
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
  const files = { 'proposal.md': 'x', 'design.md': design, 'acceptance.md': acceptance, 'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n', 'review.md': REVIEW };
  const adv = (tasks, acc = acceptance) => JSON.parse(execFileSync('node', [path.join(root, 'freeze-check.mjs'), change({ ...files, 'acceptance.md': acc, 'tasks.md': tasks }), '--json', '--skip-signer-check'], { encoding: 'utf8' }));
  const wide = adv(diamond(6), table('| SCEN-1 | CLI | T-01,T-02,T-03,T-04,T-05,T-06 | node --test test/shared.test.mjs | yes | PENDING | pending |')); // T-01 then 5 parallel: 6 tasks / 2 waves = 3x
  assert.equal(wide.route, 'pipeline');
  assert.deepEqual(wide.advisories, []);
  const chain = adv(`- [ ] 1.1 T-01 a\n  - Write scope: src/a.mjs,test/a.test.mjs\n  - Verify with: node --test test/a.test.mjs\n  - Scen: SCEN-1\n- [ ] 1.2 T-02 b\n  - Depends on: T-01\n  - Write scope: src/b.mjs,test/b.test.mjs\n  - Verify with: node --test test/b.test.mjs\n  - Scen: SCEN-1\n- [ ] 1.3 T-03 c\n  - Depends on: T-01\n  - Write scope: src/c.mjs,test/c.test.mjs\n  - Verify with: node --test test/c.test.mjs\n  - Scen: SCEN-1\n- [ ] 1.4 T-04 d\n  - Depends on: T-02,T-03\n  - Write scope: src/d.mjs,test/d.test.mjs\n  - Verify with: node --test test/d.test.mjs\n  - Scen: SCEN-1`);
  assert.equal(chain.speedup, 1.33);
  assert.ok(!chain.advisories.some((item) => item.startsWith('ADVISORY_LOW_SPEEDUP')));
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
    'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n',
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
    'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n',
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
    'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n',
    'review.md': REVIEW,
  }), '--json', '--skip-signer-check'], { encoding: 'utf8' }));
  assert.doesNotMatch(report.advisories.join('\n'), /ADVISORY_READS_ONLY_EDGE/);
});

function sinkContract(verify, extra = '') {
  return contract.replace('Verify with: npm test', `Verify with: ${verify}`).replace('  - Scen: SCEN-1\n', '  - Scen: SCEN-1\n').replace(/(1\.4 T-04 sink\n)/, `$1${extra}`);
}
function freezeOf(tasks) {
  return run(change({ 'tasks.md': tasks, 'proposal.md': 'x', 'design.md': design, 'acceptance.md': table('| SCEN-1 | CLI | T-01,T-02,T-03,T-04 | node --test test/shared.test.mjs | yes | PENDING | pending |'), 'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n', 'review.md': REVIEW }));
}
test('sink without a full-suite leg must still have a narrow Verify', () => {
  const result = freezeOf(sinkContract('echo ok'));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /VERIFY_NOT_NARROW T-04/);
});
test('sink may run one full suite per package and mix in narrow legs', () => {
  // A monorepo sink regresses each package's whole suite explicitly; neither leg names a
  // test path, so both parse as broad.
  const twoSuites = freezeOf(sinkContract('npm --prefix packages/a test && npm --prefix packages/b test'));
  assert.equal(twoSuites.status, 0, twoSuites.stdout);
  const mixed = freezeOf(sinkContract('npm --prefix packages/a test && node --test test/sink.test.mjs'));
  assert.equal(mixed.status, 0, mixed.stdout);
});
test('a dotted or parent-relative prefix resolves to a narrow leg inside Write scope', () => {
  // `./packages/web` is a working directory, and `test/a.test.ts` resolves under it; the
  // scope gate must see `packages/web/test/a.test.ts`, not an unresolved `./...` path.
  const tasks = contract.replace('Write scope: src/alpha,test/alpha.test.mjs', 'Write scope: packages/web/test,test/alpha.test.mjs')
    .replace('node --test test/alpha.test.mjs', 'npm --prefix ./packages/web test -- test/a.test.ts');
  const result = freezeOf(tasks);
  assert.doesNotMatch(result.stdout, /VERIFY_NOT_NARROW T-02/, result.stdout);
});
test('a repo-root prefix still normalizes its parent-relative target', () => {
  // `--prefix .` is the repo root; `packages/web/../shared/test/a.test.ts` must resolve to
  // `packages/shared/test/a.test.ts` for the scope gate to see it inside Write scope.
  const tasks = contract.replace('Write scope: src/alpha,test/alpha.test.mjs', 'Write scope: packages/shared/test,test/alpha.test.mjs')
    .replace('node --test test/alpha.test.mjs', 'npm --prefix . test -- packages/web/../shared/test/a.test.ts');
  const result = freezeOf(tasks);
  assert.doesNotMatch(result.stdout, /VERIFY_NOT_NARROW T-02/, result.stdout);
});
test('a working-directory option does not hide a package suite from the sink rules', () => {
  // T-02 becomes a second full suite beside the sink's `npm test`.
  const result = freezeOf(contract.replace('node --test test/alpha.test.mjs', 'npm --prefix packages/a test'));
  assert.match(result.stdout, /VERIFY_FULL_SUITE_NON_SINK T-02/);
  assert.match(result.stdout, /TOO_MANY_FULL_SUITE_SINKS: T-02, T-04/);
});
test('mechanical sink may run a non-test check', () => {
  const result = freezeOf(sinkContract('rg -c done docs/x.md', '  - Review: mechanical\n'));
  assert.equal(result.status, 0, result.stdout);
});
test('mechanical non-sink still needs narrow Verify', () => {
  const tasks = contract.replace('  - Verify with: node --test test/alpha.test.mjs', '  - Review: mechanical\n  - Verify with: rg -c done src/alpha');
  assert.match(freezeOf(tasks).stdout, /VERIFY_NOT_NARROW T-02/);
});
test('a repeated working-directory option stays a full-suite leg at the gate', () => {
  // Freeze-check must not accept `npm --prefix a --prefix b test` as a narrow non-sink Verify:
  // npm runs b's whole suite, so classifying it narrow would let an unowned package suite
  // satisfy the gate. The sink accounting sees one broad leg, not zero.
  const nonSink = freezeOf(contract.replace('node --test test/alpha.test.mjs', 'npm --prefix packages/a --prefix packages/b test'));
  assert.equal(nonSink.status, 1);
  assert.match(nonSink.stdout, /VERIFY_FULL_SUITE_NON_SINK T-02/);
  // Two broad legs on the sink stay two explicit legs, so the per-package accounting is unchanged.
  const sink = freezeOf(sinkContract('npm --prefix packages/a --prefix packages/b test'));
  assert.equal(sink.status, 0, sink.stdout);
});

// ---- R0: the last sign-off line wins ----
function signedRepo(review) {
  const dir = change({ 'tasks.md': contract, 'proposal.md': 'x', 'design.md': design, 'acceptance.md': acceptance, 'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n' });
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

// ---- R0 self-review: the contract author cannot sign for itself (F-4) ----
// `hooks/git/commit-msg` stamps Pipeline-Author on contract commits, so the signer's identity can
// be compared with the authors of the commits the sign-off covers. An author who wrote the
// contract and then recorded its own `R0: pass` had the only gate that reads it review itself.
const AUTHOR = '9b2f4c1e-aaaa-4a2b-8c3d-000000000042';
function authoredRepo({ author = AUTHOR, signer = 'hanlin-uuid' } = {}) {
  const dir = change({ 'tasks.md': contract, 'proposal.md': 'x', 'design.md': design, 'acceptance.md': acceptance, 'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n' });
  const sh = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();
  sh('init', '-q', '-b', 'main'); sh('config', 'user.email', 't@t'); sh('config', 'user.name', 't');
  sh('add', '.'); sh('commit', '-qm', `contract\n\nPipeline-Role: hanlin\nPipeline-Author: ${author}`);
  const sha = sh('rev-parse', '--short', 'HEAD');
  fs.writeFileSync(path.join(dir, 'review.md'), `R0: pass(${signer}@${sha})\n`);
  return { dir, sha };
}

test('SCEN-R0-01 the contract author signing its own contract blocks as R0_SELF_REVIEW', () => {
  const { dir, sha } = authoredRepo({ signer: AUTHOR });
  const result = run(dir);
  assert.equal(result.status, 1, result.stdout);
  assert.match(JSON.parse(result.stdout).blocking.join('\n'), /R0_SELF_REVIEW/);
  // The same holds when the signer is a short form of the author's uuid, and under
  // --skip-signer-check (that flag skips the Paseo lookup, not this git-only check).
  fs.writeFileSync(path.join(dir, 'review.md'), `R0: pass(${AUTHOR.slice(0, 8)}@${sha})\n`);
  assert.match(JSON.parse(run(dir).stdout).blocking.join('\n'), /R0_SELF_REVIEW/);
  fs.writeFileSync(path.join(dir, 'review.md'), `R0: pass(${AUTHOR}@${sha})\n`);
  assert.match(JSON.parse(run(dir, ['--skip-signer-check']).stdout).blocking.join('\n'), /R0_SELF_REVIEW/);
});

test('SCEN-R0-02 an independent signer passes', () => {
  const { dir } = authoredRepo({ signer: '9b2f4c1e-aaaa-4a2b-8c3d-000000000099' });
  const report = JSON.parse(run(dir).stdout);
  assert.ok(!report.blocking.some((item) => /R0_SELF_REVIEW/.test(item)), report.blocking.join('\n'));
  // An empty or trailer-less history cannot convict anyone: the check never blocks on absence.
  const { dir: plain } = signedRepo((sha) => `R0: pass(${AUTHOR}@${sha})\n`);
  assert.ok(!JSON.parse(run(plain).stdout).blocking.some((item) => /R0_SELF_REVIEW/.test(item)));
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
test('CROSS_CHANGE_SCOPE_OVERLAP: rename away from scoped path retains both paths', () => {
  const { dir, sh } = signedRepo(() => '');
  fs.mkdirSync(path.join(dir, 'src/shared'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/shared/x.mjs'), 'seed');
  sh('add', '.'); sh('commit', '--amend', '-qm', 'draft');
  const sha = sh('rev-parse', '--short', 'HEAD');
  fs.writeFileSync(path.join(dir, 'review.md'), `R0: pass(hanlin-uuid@${sha})\\n`);
  sh('switch', '-q', '-c', 'integration/other-change');
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.renameSync(path.join(dir, 'src/shared/x.mjs'), path.join(dir, 'docs/renamed.mjs'));
  sh('add', '-A'); sh('commit', '-qm', 'rename scoped file');
  const result = spawnSync('node', [path.join(root, 'freeze-check.mjs'), dir, '--json', '--skip-signer-check'], { encoding: 'utf8' });
  const report = JSON.parse(result.stdout);
  assert.ok(report.advisories.some((item) => item.includes('src/shared/x.mjs')), report.advisories.join('\n'));
});
test('CROSS_CHANGE_SCOPE_OVERLAP: outside a git repo it is silently skipped', () => {
  const dir = change({ 'tasks.md': contract, 'proposal.md': 'x', 'design.md': design, 'acceptance.md': acceptance, 'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n' });
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
  'acceptance.md': table('| SCEN-1 | CLI | T-01,T-02,T-03 | node --test test/shared.test.mjs | yes | PENDING | pending |'),
  'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n',
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
  assert.match(persistenceResult.stdout, /use Review: standard/);
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

test('accepts Reads ordered in either dependency direction', () => {
  const base = `- [ ] 1.1 T-01 reader\n  - Write scope: src/reader.mjs,test/read.test.mjs\n  - Reads: src/generated.mjs\n  - Verify with: node --test test/read.test.mjs\n  - Scenarios: SCEN-1\n- [ ] 1.2 T-02 writer\n  - Write scope: src/generated.mjs,test/write.test.mjs\n  - Verify with: node --test test/write.test.mjs\n  - Scenarios: SCEN-1`;
  for (const tasks of [
    base.replace('  - Reads: src/generated.mjs', '  - Depends on: T-02\n  - Reads: src/generated.mjs'),
    base.replace('  - Write scope: src/generated.mjs,test/write.test.mjs', '  - Depends on: T-01\n  - Write scope: src/generated.mjs,test/write.test.mjs'),
  ]) {
    const dir = change({ ...scheduleFiles(tasks), 'acceptance.md': table('| SCEN-1 | CLI | T-01,T-02 | node --test test/shared.test.mjs | yes | PENDING | pending |') });
    execFileSync('git', ['init', '-q'], { cwd: dir });
    assert.equal(run(dir, ['--structural', '--skip-signer-check']).status, 0, run(dir, ['--structural', '--skip-signer-check']).stdout);
  }
});

test('accepts a task reading a path it writes itself', () => {
  const tasks = `- [ ] 1.1 T-01 self reader\n  - Write scope: src/generated.mjs,test/read.test.mjs\n  - Reads: src/generated.mjs\n  - Verify with: node --test test/read.test.mjs\n  - Scenarios: SCEN-1`;
  const dir = change({ ...scheduleFiles(tasks), 'acceptance.md': table('| SCEN-1 | CLI | T-01 | node --test test/shared.test.mjs | yes | PENDING | pending |') });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  assert.equal(run(dir, ['--structural', '--skip-signer-check']).status, 0, run(dir, ['--structural', '--skip-signer-check']).stdout);
});

test('rejects a concurrent Read of an artifact another task writes', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'freeze-read-write-'));
  const dir = path.join(repo, 'openspec/changes/chg');
  fs.mkdirSync(path.join(dir, 'specs/a'), { recursive: true });
  const tasks = `- [ ] 1.1 T-01 reader\n  - Write scope: test/read.test.mjs\n  - Reads: src/generated.mjs\n  - Verify with: node --test test/read.test.mjs\n  - Scenarios: SCEN-1\n- [ ] 1.2 T-02 writer\n  - Write scope: src/generated.mjs,test/write.test.mjs\n  - Verify with: node --test test/write.test.mjs\n  - Scenarios: SCEN-1`;
  for (const [file, text] of Object.entries({
    'openspec/changes/chg/tasks.md': tasks,
    'openspec/changes/chg/proposal.md': 'x',
    'openspec/changes/chg/acceptance.md': table('| SCEN-1 | CLI | T-01,T-02 | node --test test/read.test.mjs | yes | PENDING | pending |'),
    'openspec/changes/chg/specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n',
  })) { fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true }); fs.writeFileSync(path.join(repo, file), text); }
  execFileSync('git', ['init', '-q', repo]); execFileSync('git', ['-C', repo, 'add', '.']); execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base']);
  const result = run(dir, ['--structural', '--skip-signer-check']);
  assert.equal(result.status, 1, result.stdout);
  assert.ok(result.stdout.includes('READ_BEFORE_WRITE T-01: Reads src/generated.mjs, which is written by concurrent T-02'), result.stdout);
});

test('Reads anchors a narrow Verify without joining scope conflicts', () => {
  const anchored = scheduleContract
    .replace('Write scope: src/alpha,test/alpha.test.mjs', 'Write scope: src/alpha')
    .replace('Reads: src/iface/form.ts', 'Reads: src/iface/form.ts,test/alpha.test.mjs');
  assert.equal(freezeStructural(anchored).status, 0, freezeStructural(anchored).stdout);
  const sharedRead = scheduleContract.replace('  - Review: deferred\n  - Verify with: node --test test/beta.test.mjs', '  - Reads: src/iface/form.ts\n  - Review: deferred\n  - Verify with: node --test test/beta.test.mjs');
  assert.equal(freezeStructural(sharedRead).status, 0, freezeStructural(sharedRead).stdout);
});

test('nested change root R0 records are exempt while nested files and contract edits drift', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'freeze-nested-'));
  const dir = path.join(repo, 'openspec', 'changes', 'c');
  fs.mkdirSync(path.join(dir, 'specs', 'a'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tasks.md'), contract);
  fs.writeFileSync(path.join(dir, 'proposal.md'), 'x');
  fs.writeFileSync(path.join(dir, 'design.md'), design);
  fs.writeFileSync(path.join(dir, 'acceptance.md'), acceptance);
  fs.writeFileSync(path.join(dir, 'specs/a/spec.md'), '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n');
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  git('add', '.'); git('commit', '-qm', 'draft');
  fs.writeFileSync(path.join(dir, 'review.md'), `R0: pass(hanlin-uuid@${git('rev-parse', '--short', 'HEAD')})\n`);
  fs.writeFileSync(path.join(dir, 'rulings.md'), '# Rulings\n');
  fs.writeFileSync(path.join(dir, 'run-log.md'), 'approval log\n');
  assert.equal(run(dir).status, 0, run(dir).stdout);
  fs.writeFileSync(path.join(dir, 'specs/a/review.md'), 'nested record name\n');
  assert.match(run(dir).stdout, /STALE_R0_SIGNOFF.*specs\/a\/review\.md/);
  fs.unlinkSync(path.join(dir, 'specs/a/review.md'));
  fs.writeFileSync(path.join(dir, 'proposal.md'), 'edited after review\n');
  assert.match(run(dir).stdout, /STALE_R0_SIGNOFF.*proposal\.md/);
});

test('rename into a root R0 record name does not hide nested contract drift', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'freeze-rename-'));
  const dir = path.join(repo, 'openspec', 'changes', 'c');
  fs.mkdirSync(path.join(dir, 'specs', 'a'), { recursive: true });
  const sh = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim();
  sh('init', '-q'); sh('config', 'user.email', 't@t'); sh('config', 'user.name', 't');
  for (const [file, text] of Object.entries({ 'tasks.md': contract, 'proposal.md': 'x', 'design.md': design, 'acceptance.md': acceptance, 'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n', 'specs/a/rulings.md': 'nested record\n' })) {
    fs.writeFileSync(path.join(dir, file), text);
  }
  sh('add', '.'); sh('commit', '-qm', 'draft');
  const signoff = `R0: pass(hanlin-uuid@${sh('rev-parse', '--short', 'HEAD')})\n`;
  fs.writeFileSync(path.join(dir, 'review.md'), signoff);
  sh('mv', 'openspec/changes/c/specs/a/rulings.md', 'openspec/changes/c/rulings.md');
  sh('add', '-A');
  assert.match(run(dir).stdout, /STALE_R0_SIGNOFF.*specs\/a\/rulings\.md/);
});

test('only root R0 record files are exempt from contract drift', () => {
  const dir = change({ 'tasks.md': contract, 'proposal.md': 'x', 'design.md': design, 'acceptance.md': acceptance, 'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n' });
  const sh = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();
  sh('init', '-q'); sh('config', 'user.email', 't@t'); sh('config', 'user.name', 't');
  sh('add', '.'); sh('commit', '-qm', 'draft');
  fs.writeFileSync(path.join(dir, 'review.md'), `R0: pass(hanlin-uuid@${sh('rev-parse', '--short', 'HEAD')})\n`);
  fs.writeFileSync(path.join(dir, 'rulings.md'), '# Rulings\n');
  fs.writeFileSync(path.join(dir, 'run-log.md'), 'approval log\n');
  assert.equal(run(dir).status, 0, run(dir).stdout);
  for (const file of ['specs/a/review.md', 'specs/a/run-log.md']) {
    fs.writeFileSync(path.join(dir, file), 'nested record name\n');
    assert.match(run(dir).stdout, /STALE_R0_SIGNOFF.*specs\/a/);
    fs.unlinkSync(path.join(dir, file));
  }
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
  const dir = change({ 'tasks.md': contract, 'proposal.md': 'x', 'design.md': design, 'acceptance.md': table(row), 'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n' });
  const result = run(dir);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /MALFORMED_ACCEPTANCE_ROW/);
  // An escaped pipe keeps the column count and is accepted.
  const escaped = change({ 'tasks.md': contract, 'proposal.md': 'x', 'design.md': design, 'acceptance.md': table('| SCEN-1 | CLI | T-01,T-02,T-03,T-04 | node --test test/shared.test.mjs "a \\| b" | yes | PENDING | pending |'), 'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n', 'review.md': REVIEW });
  assert.equal(run(escaped).status, 0);
});

test('shell setup is not a verify leg: set -e and || are named blocks', () => {
  const sinkSet = contract.replace('  - Verify with: npm test', '  - Verify with: set -e; npm test');
  const setResult = run(change({ 'tasks.md': sinkSet, 'proposal.md': 'x', 'design.md': design, 'acceptance.md': acceptance, 'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n' }));
  assert.match(setResult.stdout, /VERIFY_JUNK_LEG T-04/);
  assert.match(setResult.stdout, /shell setup, not a verify leg/);
  const sinkOr = contract.replace('  - Verify with: npm test', '  - Verify with: npm test || true');
  const orResult = run(change({ 'tasks.md': sinkOr, 'proposal.md': 'x', 'design.md': design, 'acceptance.md': acceptance, 'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n' }));
  assert.match(orResult.stdout, /VERIFY_JUNK_LEG T-04/);
  assert.match(orResult.stdout, /mandatory legs/);
});

// F-5: a Required=yes acceptance command is what the executor's exit status will be read from.
// A pipeline reports only its last leg's status, `||` makes an unreviewed leg mandatory, and a
// command with no test runner or test path cannot fail for a reason the row cares about. All three
// freeze-time rejects reuse the task Verify leg/proves/fixture judgement.
test('SCEN-ACC-01 a Required=yes acceptance command that can hide a failure is rejected at freeze', () => {
  const files = { 'tasks.md': contract, 'proposal.md': 'x', 'design.md': design, 'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n', 'review.md': REVIEW };
  const freezeWith = (verify, required = 'yes') => run(change({ ...files, 'acceptance.md': table(`| SCEN-1 | CLI | T-01,T-02,T-03,T-04 | ${verify} | ${required} | PENDING | pending |`) }));
  const blocked = (verify) => {
    const result = freezeWith(verify);
    assert.equal(result.status, 1, verify);
    const report = JSON.parse(result.stdout);
    assert.ok(report.blocking.some((item) => item.startsWith('BAD_ACCEPTANCE_VERIFY SCEN-1')), verify);
    return report;
  };
  // A literal cell pipe is written `\|`; the gate reads the unescaped command, which is a pipeline.
  const piped = blocked('node --test test/a.test.mjs \\| tail -n 20');
  assert.match(piped.blocking.join('\n'), /BAD_ACCEPTANCE_VERIFY SCEN-1: only one command/);
  assert.match(blocked('node --test test/a.test.mjs \\|\\| true').blocking.join('\n'), /hides which leg/);
  assert.match(blocked('node -e "0"').blocking.join('\n'), /proves nothing/);
  assert.match(blocked('true').blocking.join('\n'), /proves nothing/);  // A quoted pipe is an argument, not a pipeline, and a real runner still passes.
  assert.equal(freezeWith('node --test test/shared.test.mjs "a \\| b"').status, 0);
  assert.equal(freezeWith('node --test test/a.test.mjs').status, 0);
  assert.equal(freezeWith('npm test').status, 0);
  // Commands joined by `&&` still have a provable status: any red leg is the exit status.
  assert.equal(freezeWith('node --test test/a.test.mjs && node --test test/b.test.mjs').status, 0);
  // Required=no rows are recorded only and never execute, so they are not judged this way.
  const withOptional = `${table('| SCEN-1 | CLI | T-01,T-02,T-03,T-04 | npm test | yes | PENDING | pending |')}\n| SCEN-1 | CLI | T-01 | node --test test/a.test.mjs \\| tail -n 20 | no | PENDING | pending |\n`;
  assert.equal(run(change({ ...files, 'acceptance.md': withOptional })).status, 0);
  // A `for` loop is provable when every failing iteration runs the body's own `|| exit <non-zero>`:
  // the shell leaves non-zero instead of continuing. `node "$f"` is judged by the loop list.
  const loopRow = (body) => table(`| SCEN-1 | CLI | T-01,T-02,T-03,T-04 | for f in scripts/specs/*.mjs; do ${body}; done | yes | PENDING | pending |`);
  assert.equal(run(change({ ...files, 'acceptance.md': loopRow('node "$f" \\|\\| exit 1') })).status, 0);
  // Without that propagation the loop continues after a red iteration and can finish at 0.
  const noExit = run(change({ ...files, 'acceptance.md': loopRow('node "$f"') }));
  assert.equal(noExit.status, 1, noExit.stdout);
  assert.match(noExit.stdout, /without a trailing `\|\| exit <1-255>`/);
  // `|| exit 0` reports success and is not propagation.
  assert.equal(run(change({ ...files, 'acceptance.md': loopRow('node "$f" \\|\\| exit 0') })).status, 1);
});

// Rework round 1. The shell-construct exemption was a keyword search over the whole command, so a
// keyword in a filename or argument marked the row as a construct and skipped every pipe and proof
// check — the exact masking F-5 exists to stop. Control syntax is now a command shape, and the pipe
// and `||` checks run before any exemption.
test('SCEN-ACC-01 rework: a keyword in a path or argument is not a shell construct', () => {
  const files = { 'tasks.md': contract, 'proposal.md': 'x', 'design.md': design, 'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n', 'review.md': REVIEW };
  const freezeWith = (verify) => run(change({ ...files, 'acceptance.md': table(`| SCEN-1 | CLI | T-01,T-02,T-03,T-04 | ${verify} | yes | PENDING | pending |`) }));
  const blocking = (verify, pattern) => {
    const result = freezeWith(verify);
    assert.equal(result.status, 1, `${verify}\n${result.stdout}`);
    const report = JSON.parse(result.stdout);
    assert.ok(report.blocking.some((item) => item.startsWith('BAD_ACCEPTANCE_VERIFY SCEN-1')), `${verify}: ${result.stdout}`);
    assert.match(report.blocking.join('\n'), pattern, verify);
  };
  // An argument that happens to be a reserved word is judged, not skipped: `echo if` is a command
  // that proves nothing, and it is no longer misread as a loop and exempted.
  blocking('echo if', /only one command|proves nothing/);
  blocking('echo while', /only one command|proves nothing/);
  // The reserved word is inside a path, so the pipe in the pipeline is still a pipe.
  blocking('node --test test/if.test.mjs \\| tail -n 20', /only one command/);
  blocking('node --test test/while.test.mjs \\| tail -n 20', /only one command/);
});

test('SCEN-ACC-01 rework: `||` is failure propagation only when the right side is `exit`', () => {
  const files = { 'tasks.md': contract, 'proposal.md': 'x', 'design.md': design, 'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n', 'review.md': REVIEW };
  const freezeWith = (verify) => run(change({ ...files, 'acceptance.md': table(`| SCEN-1 | CLI | T-01,T-02,T-03,T-04 | ${verify} | yes | PENDING | pending |`) }));
  for (const right of ['true', 'echo retry', 'node other.mjs']) {
    const result = freezeWith(`node --test test/a.test.mjs \\|\\| ${right}`);
    assert.equal(result.status, 1, `${right}: ${result.stdout}`);
    assert.match(result.stdout, /hides which leg/, right);
  }
  // A red left leg still fails the row through `exit`: nothing is masked, so it is allowed.
  assert.equal(freezeWith('node --test test/a.test.mjs \\|\\| exit 1').status, 0);
  assert.equal(freezeWith('node --test test/a.test.mjs \\|\\| exit 3').status, 0);
  assert.equal(freezeWith('node --test test/a.test.mjs \\|\\| exit').status, 0);
});

// Rework round 4. Rounds 1-3 each taught the gate to recognize another shell shape and each round
// found one more it missed: `... | tail; true`, a nested `bash -c`, `if cmd; then echo ok; fi`.
// A shell body's exit status is not decidable by pattern, so the gate stopped trying. It accepts
// only what it can prove — one command, commands joined by `&&`, plus an optional trailing
// `|| exit <non-zero>` — and every other operator, construct or nested shell is rejected with the
// route that passes: a test script, which returns its own status.
test('SCEN-ACC-01 rework 4: only a provable exit status is accepted', () => {
  const files = { 'tasks.md': contract, 'proposal.md': 'x', 'design.md': design, 'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n', 'review.md': REVIEW };
  const freezeWith = (verify) => run(change({ ...files, 'acceptance.md': table(`| SCEN-1 | CLI | T-01,T-02,T-03,T-04 | ${verify} | yes | PENDING | pending |`) }));
  const blocked = (verify, pattern) => {
    const result = freezeWith(verify);
    assert.equal(result.status, 1, `${verify}\n${result.stdout}`);
    const report = JSON.parse(result.stdout);
    assert.ok(report.blocking.some((item) => item.startsWith('BAD_ACCEPTANCE_VERIFY SCEN-1')), `${verify}: ${result.stdout}`);
    assert.match(report.blocking.join('\n'), pattern, verify);
  };
  // Reviewer round-3 and round-4 repros: every one of these can exit 0 after the test leg failed.
  blocked("bash -c 'set -o pipefail; node --test test/a.test.mjs \\| tail -n 20; true'", /new shell/);
  blocked('bash -c "set -o pipefail; bash -c \'node --test test/a.test.mjs \\| tail -n 20\'"', /new shell/);
  blocked("bash -c 'set -o pipefail; if node --test test/a.test.mjs; then echo ok; fi'", /new shell/);
  blocked("bash -c 'set -o pipefail \\| cat; node --test test/a.test.mjs \\| tail -n 20'", /new shell/);
  blocked("bash -c 'set -o pipefail; { set +o pipefail; }; node --test test/a.test.mjs \\| tail -n 20'", /new shell/);
  blocked('bash -c "bash -c \'node --test test/a.test.mjs \\| tail -n 20\'"', /new shell/);
  // Contexts that can return 0 after a red leg, without a wrapper.
  blocked('node --test test/a.test.mjs ; true', /only one command/);
  blocked('true ; node --test test/a.test.mjs', /only one command/);
  blocked('if node --test test/a.test.mjs; then echo ok; fi', /only one command/);
  blocked('( node --test test/a.test.mjs )', /only one command/);
  blocked('node --test test/a.test.mjs &', /only one command/);
  // The provable forms: a single command, `&&` joins, and a trailing propagated failure.
  assert.equal(freezeWith('node --test test/a.test.mjs').status, 0);
  assert.equal(freezeWith('node --test test/a.test.mjs && node --test test/b.test.mjs').status, 0);
  assert.equal(freezeWith('node --test test/a.test.mjs \\|\\| exit 1').status, 0);
  assert.equal(freezeWith('bash scripts/test-a.sh').status, 0);
  // The route the message names must actually pass the gate.
  const suggestion = freezeWith("bash -c 'true; node --test test/a.test.mjs'").stdout;
  assert.match(suggestion, /a script whose name starts with `test`/);
  assert.equal(freezeWith('bash scripts/test-check.sh').status, 0);
});
test('SCEN-ACC-01 rework 2: a masked failure is rejected in every wrapper shape', () => {
  const files = { 'tasks.md': contract, 'proposal.md': 'x', 'design.md': design, 'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n', 'review.md': REVIEW };
  const freezeWith = (verify) => run(change({ ...files, 'acceptance.md': table(`| SCEN-1 | CLI | T-01,T-02,T-03,T-04 | ${verify} | yes | PENDING | pending |`) }));
  const blocked = (verify, pattern) => {
    const result = freezeWith(verify);
    assert.equal(result.status, 1, `${verify}\n${result.stdout}`);
    const report = JSON.parse(result.stdout);
    assert.ok(report.blocking.some((item) => item.startsWith('BAD_ACCEPTANCE_VERIFY SCEN-1')), `${verify}: ${result.stdout}`);
    assert.match(report.blocking.join('\n'), pattern, verify);
  };
  // `exit 0` reports success for whichever leg failed.
  blocked('node --test test/a.test.mjs \\|\\| exit 0', /1-255/);
  assert.equal(freezeWith('node --test test/a.test.mjs \\|\\| exit 0').status, 1);
  // A `bash -c` body is a new shell whatever it contains; the round-4 rule rejects it outright.
  blocked('bash -c \'for f in test/a.test.mjs; do node --test "$f" \\| tail -n 20 \\|\\| exit 1; done\'', /new shell/);
  blocked("bash -c 'node --test test/a.test.mjs \\| tail -n 20; set -o pipefail'", /new shell/);
  blocked("bash -c 'set -o pipefail; set +o pipefail; node --test test/a.test.mjs \\| tail -n 20'", /new shell/);
  // Still accepted: a single command and a propagated failure status.
  assert.equal(freezeWith('node --test test/a.test.mjs').status, 0);
  assert.equal(freezeWith('node --test test/a.test.mjs \\|\\| exit 1').status, 0);
});

// Rework round 5. The whitelist was right, but the prover itself could be fooled: it read a
// positive integer as a non-zero exit code, expanded a loop list it never inspected, and blanked
// text inside double quotes where `$(...)` still runs. Each repro exits 0 after the test leg is red.
test('SCEN-ACC-01 rework 5: the prover cannot be fooled by masking or shell arithmetic', () => {
  const files = { 'tasks.md': contract, 'proposal.md': 'x', 'design.md': design, 'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n', 'review.md': REVIEW };
  const freezeWith = (verify) => run(change({ ...files, 'acceptance.md': table(`| SCEN-1 | CLI | T-01,T-02,T-03,T-04 | ${verify} | yes | PENDING | pending |`) }));
  const blocked = (verify, pattern) => {
    const result = freezeWith(verify);
    assert.equal(result.status, 1, `${verify}\n${result.stdout}`);
    const report = JSON.parse(result.stdout);
    assert.ok(report.blocking.some((item) => item.startsWith('BAD_ACCEPTANCE_VERIFY SCEN-1')), `${verify}: ${result.stdout}`);
    assert.match(report.blocking.join('\n'), pattern, verify);
  };
  // The shell keeps the low 8 bits, so `exit 256` is `exit 0`.
  blocked('node --test test/a.test.mjs \\|\\| exit 256', /1-255/);
  assert.equal(freezeWith('node --test test/a.test.mjs \\|\\| exit 255').status, 0);
  // A list expanded by the shell can fail on its own, leaving the loop with zero iterations.
  // A command substitution is rejected before the loop is even parsed, which is the same answer.
  blocked('for f in $(node --test test/a.test.mjs); do node "$f" \\|\\| exit 1; done', /loop list|command substitution/);
  // `$(...)` still runs inside double quotes, so the test's status is thrown away by `echo`.
  blocked('echo "$(node --test test/a.test.mjs)"', /command substitution/);
  // A backslash escapes the quote a naive scan reads, so the trailing `true` is a live command.
  blocked('node --test test/a.test.mjs \\"; true test/a.test.mjs # "', /escaped character|only one command/);
  // A newline separates commands exactly like `;`. The table itself rejects a row that spans two
  // lines, so this is rejected one layer earlier; kept as a guard for any other reader.
  const newline = freezeWith('node --test test/a.test.mjs\ntrue test/a.test.mjs');
  assert.equal(newline.status, 1);
  assert.match(newline.stdout, /MALFORMED_ACCEPTANCE_ROW|newline/);
  // Still accepted: a plain single command, its propagated failure, and the real sink loop.
  assert.equal(freezeWith('node --test test/a.test.mjs').status, 0);
  assert.equal(freezeWith('node --test test/a.test.mjs \\|\\| exit 1').status, 0);
  assert.equal(freezeWith('for f in scripts/specs/*.mjs; do node "$f" \\|\\| exit 1; done').status, 0);
});

// Rework round 6. Two more ways the prover read the text wrong: `$"` is locale quoting, not an
// open quote, so the rest of the line was blanked while its `; true` still ran; and `!` inverts a
// leg, so a red test reads as success and a trailing `|| exit` never fires.
test('SCEN-ACC-01 rework 6: a reversed or misquoted leg is not a passed check', () => {
  const files = { 'tasks.md': contract, 'proposal.md': 'x', 'design.md': design, 'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n', 'review.md': REVIEW };
  const freezeWith = (verify) => run(change({ ...files, 'acceptance.md': table(`| SCEN-1 | CLI | T-01,T-02,T-03,T-04 | ${verify} | yes | PENDING | pending |`) }));
  const blocked = (verify, pattern) => {
    const result = freezeWith(verify);
    assert.equal(result.status, 1, `${verify}\n${result.stdout}`);
    const report = JSON.parse(result.stdout);
    assert.ok(report.blocking.some((item) => item.startsWith('BAD_ACCEPTANCE_VERIFY SCEN-1')), `${verify}: ${result.stdout}`);
    assert.match(report.blocking.join('\n'), pattern, verify);
  };
  // The `$"` no longer opens a quote, so the live `; true` is seen; the escaped `"` is rejected
  // first, one layer earlier, which is the same answer.
  blocked('node --test test/a.test.mjs \\"$\\"; true test/a.test.mjs # \\"', /escaped character|only one command/);
  blocked('for f in test/a.test.mjs; do ! node --test "$f" \\|\\| exit 1; done', /only one command/);
  // Still accepted: the real sink loop and a plain command.
  assert.equal(freezeWith('for f in scripts/specs/*.mjs; do node "$f" \\|\\| exit 1; done').status, 0);
  assert.equal(freezeWith('node --test test/a.test.mjs').status, 0);
});

// Rework round 7. A new shell can be reached without the word `bash` at the start of the row, and
// `eval` runs its quoted argument as code. Both keep the body's real status out of reach.
test('SCEN-ACC-01 rework 7: an interpreter reached by path or eval is rejected', () => {
  const files = { 'tasks.md': contract, 'proposal.md': 'x', 'design.md': design, 'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n', 'review.md': REVIEW };
  const freezeWith = (verify) => run(change({ ...files, 'acceptance.md': table(`| SCEN-1 | CLI | T-01,T-02,T-03,T-04 | ${verify} | yes | PENDING | pending |`) }));
  const blocked = (verify, pattern) => {
    const result = freezeWith(verify);
    assert.equal(result.status, 1, `${verify}\n${result.stdout}`);
    const report = JSON.parse(result.stdout);
    assert.ok(report.blocking.some((item) => item.startsWith('BAD_ACCEPTANCE_VERIFY SCEN-1')), `${verify}: ${result.stdout}`);
    assert.match(report.blocking.join('\n'), pattern, verify);
  };
  // `eval 'x || true'` re-interprets the string; the quoted `|| true` runs and masks the failure.
  blocked("eval 'node --test test/a.test.mjs \\|\\| true'", /eval/);
  blocked("for f in test/a.test.mjs; do eval 'node --test test/a.test.mjs \\|\\| true' \\|\\| exit 1; done", /eval/);
  // A shell reached by absolute path or by a wrapper is still a new shell.
  blocked("/bin/bash -c 'node --test test/a.test.mjs \\|\\| true'", /new shell/);
  blocked('/bin/sh -c "node --test test/a.test.mjs \\|\\| true"', /new shell/);
  blocked('env bash -c \'node --test test/a.test.mjs \\|\\| true\'', /new shell/);
  // Still accepted: a plain command and the real sink loop, which runs `node`, not a shell word.
  assert.equal(freezeWith('node --test test/a.test.mjs').status, 0);
  assert.equal(freezeWith('for f in scripts/specs/*.mjs; do node "$f" \\|\\| exit 1; done').status, 0);
});

// Rework round 8. Rounds 7 and 8 each found another spelling for "the row's first word is not a
// test": `e""val`, `busybox sh -c`, `bash -o pipefail -c`. A negative list cannot converge, so the
// first word must now be a known test entry, or a shell running a `test*` script with no options.
test('SCEN-ACC-01 rework 8: the entry word must be a known test, not a spelling of one', () => {
  const files = { 'tasks.md': contract, 'proposal.md': 'x', 'design.md': design, 'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n', 'review.md': REVIEW };
  const freezeWith = (verify) => run(change({ ...files, 'acceptance.md': table(`| SCEN-1 | CLI | T-01,T-02,T-03,T-04 | ${verify} | yes | PENDING | pending |`) }));
  const blocked = (verify, pattern) => {
    const result = freezeWith(verify);
    assert.equal(result.status, 1, `${verify}\n${result.stdout}`);
    const report = JSON.parse(result.stdout);
    assert.ok(report.blocking.some((item) => item.startsWith('BAD_ACCEPTANCE_VERIFY SCEN-1')), `${verify}: ${result.stdout}`);
    if (pattern) assert.match(report.blocking.join('\n'), pattern, verify);
  };
  // Splice the word, change the shell binary's spelling, put an option between the shell and `-c`.
  blocked('e""val \'node --test test/a.test.mjs \\|\\| true\'');
  blocked('for f in test/a.test.mjs; do e""val \'node --test test/a.test.mjs \\|\\| true\' \\|\\| exit 1; done');
  blocked("bash -o pipefail -c 'node --test test/a.test.mjs \\|\\| true'");
  blocked("busybox sh -c 'node --test test/a.test.mjs \\|\\| true'");
  blocked("nohup bash -c 'node --test test/a.test.mjs \\|\\| true'");
  blocked("\\\\eval 'node --test test/a.test.mjs \\|\\| true'");
  // A whitelisted entry can be told to evaluate a string, then exit 0 with the test status
  // discarded; the test path satisfies proof, so only the option is the tell.
  blocked('node -e \'require("node:child_process").spawnSync(process.execPath,["--test",process.argv[1]],{stdio:"inherit"})\' test/a.test.mjs');
  blocked("node --eval 'process.exit(0)' test/a.test.mjs");
  // The route still has to name commands the gate accepts.
  assert.equal(freezeWith('node --test test/a.test.mjs').status, 0);
  assert.equal(freezeWith('npm test').status, 0);
  assert.equal(freezeWith('npx tsc --noEmit').status, 0);
  assert.equal(freezeWith('bash scripts/test-a.sh').status, 0);
  assert.equal(freezeWith('bash test/a.sh').status, 0);
  assert.equal(freezeWith('MOCK_MODE=true NODE_ENV=test node --test test/a.test.mjs').status, 0);
  assert.equal(freezeWith('node --test test/a.test.mjs && npx tsc --noEmit').status, 0);
  assert.equal(freezeWith('for f in scripts/specs/*.mjs; do node "$f" \\|\\| exit 1; done').status, 0);
});

// Rework round 10. The positive list named programs, but a program is not a test: `go run ./x
// test/a.test.mjs` and `python3 -m timeit … test/a.test.mjs` run something else while a test path
// satisfies proof. The entry must be a known *test invocation* — a program together with the
// subcommand that runs its paths.
test('SCEN-ACC-01 rework 10: a known program is not a known test invocation', () => {
  const files = { 'tasks.md': contract, 'proposal.md': 'x', 'design.md': design, 'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n', 'review.md': REVIEW };
  const freezeWith = (verify) => run(change({ ...files, 'acceptance.md': table(`| SCEN-1 | CLI | T-01,T-02,T-03,T-04 | ${verify} | yes | PENDING | pending |`) }));
  const blocked = (verify) => {
    const result = freezeWith(verify);
    assert.equal(result.status, 1, `${verify}\n${result.stdout}`);
    assert.ok(JSON.parse(result.stdout).blocking.some((item) => item.startsWith('BAD_ACCEPTANCE_VERIFY SCEN-1')), verify);
  };
  // The program is known and a test path appears, but the subcommand is not the test runner.
  blocked('go run ./cmd/x test/a.test.mjs');
  blocked('cargo run --bin x test/a.test.mjs');
  blocked('python3 -m timeit pass test/a.test.mjs');
  blocked('make -f /dev/null test/a.test.mjs');
  blocked('gradle -I /tmp/x.gradle test');
  blocked('npx --no-install some-pkg test/a.test.mjs');
  // The real invocations and the real sink chain still pass.
  assert.equal(freezeWith('node --test test/a.test.mjs').status, 0);
  assert.equal(freezeWith('npm test').status, 0);
  assert.equal(freezeWith('npm --prefix packages/server test').status, 0);
  assert.equal(freezeWith('npm --prefix packages/web run build').status, 0);
  assert.equal(freezeWith('npx tsc --noEmit -p packages/web/tsconfig.test.json').status, 0);
  assert.equal(freezeWith('python3 -m pytest').status, 0);
  assert.equal(freezeWith('go test ./pkg/a').status, 0);
  assert.equal(freezeWith('cargo test --lib').status, 0);
  assert.equal(freezeWith('node scripts/specs/a.mjs').status, 0);
  // The whole converged sink row, which is the hardest real constraint.
  assert.equal(freezeWith('npm --prefix packages/server test && npm --prefix packages/web run build && npx tsc --noEmit -p packages/web/tsconfig.test.json && TSX_TSCONFIG_PATH=packages/web/tsconfig.test.json node --test --import=tsx packages/web/test/*.test.tsx packages/web/test/*.test.ts && for f in scripts/specs/*.mjs; do node "$f" \\|\\| exit 1; done').status, 0);
});

test('SCEN-ACC-01 rework: the rejection message names a route the gate accepts', () => {  const files = { 'tasks.md': contract, 'proposal.md': 'x', 'design.md': design, 'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n', 'review.md': REVIEW };
  const freezeWith = (verify) => run(change({ ...files, 'acceptance.md': table(`| SCEN-1 | CLI | T-01,T-02,T-03,T-04 | ${verify} | yes | PENDING | pending |`) }));
  const piped = freezeWith('node --test test/a.test.mjs \\| tail -n 20');
  assert.equal(piped.status, 1);
  // The message must name a script path that this same rule lets through: a `test*` script
  // returns its own status, so no wrapper has to be proven.
  assert.match(JSON.parse(piped.stdout).blocking.join('\n'), /a script whose name starts with `test`/);
  assert.equal(freezeWith('bash scripts/test-a.sh').status, 0);
  assert.equal(freezeWith('bash test/a.sh').status, 0);
});

test('a shell loop is an advisory, not invented legs', () => {
  const loop = contract
    .replace('Write scope: src/sink.mjs,test/sink.test.mjs', 'Write scope: src/sink.mjs,test/sink.test.mjs,scripts/specs/probe.mjs')
    .replace('  - Verify with: npm test', '  - Review: mechanical\n  - Verify with: for f in scripts/specs/probe.mjs; do node "$f"; done');
  const dir = change({ 'tasks.md': loop, 'proposal.md': 'x', 'design.md': design, 'acceptance.md': acceptance, 'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n', 'review.md': REVIEW });
  const result = run(dir);
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /ADVISORY_SHELL_VERIFY T-04/);
});

test('Reads must name a baseline path or a declared writer path', () => {
  const dir = change({ 'tasks.md': contract.replace('  - Scen: SCEN-1\n- [ ] 1.2', '  - Reads: docs/contract.md\n  - Scen: SCEN-1\n- [ ] 1.2'), 'proposal.md': 'x', 'design.md': design, 'acceptance.md': acceptance, 'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n' });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['-C', dir, 'add', '.']);
  execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'baseline']);
  assert.match(run(dir, ['--structural', '--skip-signer-check']).stdout, /MISSING_READS_PATH T-01/);
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs/contract.md'), 'x');
  execFileSync('git', ['-C', dir, 'add', 'docs/contract.md']);
  execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'add baseline read']);
  assert.equal(run(dir, ['--structural', '--skip-signer-check']).status, 0);
});

test('Reads may reference a dependency-ordered generated path, but not a typo', () => {
  const generated = contract
    .replace('  - Write scope: src/shared,test/shared.test.mjs', '  - Write scope: src/shared,test/shared.test.mjs,src/poison.txt')
    .replace('  - Scen: SCEN-1\n- [ ] 1.3', '  - Scen: SCEN-1\n- [ ] 1.3')
    .replace('  - Depends on: T-01\n  - Write scope: src/alpha', '  - Depends on: T-01\n  - Reads: src/poison.txt\n  - Write scope: src/alpha');
  const ok = change({ 'tasks.md': generated, 'proposal.md': 'x', 'design.md': design, 'acceptance.md': acceptance, 'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n' });
  execFileSync('git', ['init', '-q'], { cwd: ok });
  assert.doesNotMatch(run(ok, ['--structural', '--skip-signer-check']).stdout, /MISSING_READS_PATH|READ_BEFORE_WRITE/);
  const typo = change({ 'tasks.md': generated.replace('Reads: src/poison.txt', 'Reads: src/posion.txt'), 'proposal.md': 'x', 'design.md': design, 'acceptance.md': acceptance, 'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n' });
  execFileSync('git', ['init', '-q'], { cwd: typo });
  assert.match(run(typo, ['--structural', '--skip-signer-check']).stdout, /MISSING_READS_PATH T-02/);
});

test('rejects a concurrent Read of a generated path', () => {
  const tasks = scheduleContract
    .replace('Write scope: src/beta,test/beta.test.mjs', 'Write scope: src/beta,test/beta.test.mjs,test/future.test.mjs')
    .replace('  - Uses: T-00\n  - Write scope: src/alpha', '  - Uses: T-00\n  - Reads: test/future.test.mjs\n  - Write scope: src/alpha');
  const dir = change(scheduleFiles(tasks));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  const parsed = parseTasks(tasks).tasks;
  assert.deepEqual(dispatchDeps(parsed.find((task) => task.id === 'T-01'), parsed), ['T-00']);
  assert.equal(run(dir, ['--structural', '--skip-signer-check']).status, 1);
  assert.match(run(dir, ['--structural', '--skip-signer-check']).stdout, /READ_BEFORE_WRITE T-01.*test\/future\.test\.mjs.*T-02/);
  assert.equal(fs.existsSync(path.join(dir, 'test/future.test.mjs')), false);
});

test('no digest artifact is required and none is checked', () => {
  const files = { 'proposal.md': 'x', 'acceptance.md': acceptance, 'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n', 'tasks.md': contract, 'review.md': REVIEW };
  const report = JSON.parse(execFileSync('node', [path.join(root, 'freeze-check.mjs'), change(files), '--json', '--skip-signer-check'], { encoding: 'utf8' }));
  // `contract` is a narrow 4-task diamond (maxWidth=2, weightedSpeedup=1.33 < 1.8), so ROI routes handoff.
  assert.equal(report.route, 'handoff');
  assert.ok(report.advisories.some((item) => item.startsWith('ADVISORY_LOW_ROI_HANDOFF:')));
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
  // maxWidth=2 with weightedSpeedup=1.38 < 1.8 routes handoff; maxWidth=3 qualifies for pipeline.
  const narrowParallel = JSON.parse(freezeStructural(scheduleContract).stdout);
  assert.equal(narrowParallel.maxWidth, 2);
  assert.equal(narrowParallel.route, 'handoff');
  assert.ok(narrowParallel.advisories.some((item) => item.startsWith('ADVISORY_LOW_ROI_HANDOFF:')));
  const wideContract = scheduleContract
    .replace('- [ ] 1.4 T-03 sink\n  - Depends on: T-00,T-01,T-02', `- [ ] 1.3.1 T-04 gamma
  - Uses: T-00
  - Write scope: src/gamma,test/gamma.test.mjs
  - Review: deferred
  - Verify with: node --test test/gamma.test.mjs
  - Scen: SCEN-1
- [ ] 1.4 T-03 sink
  - Depends on: T-00,T-01,T-02,T-04`);
  const wideParallel = JSON.parse(freezeStructural(wideContract).stdout);
  assert.equal(wideParallel.maxWidth, 3);
  assert.equal(wideParallel.route, 'pipeline');
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
  assert.equal(report.route, 'handoff');
  assert.equal(typeof report.weightedSpeedup, 'number');
});

test('acceptance Required accepts yes/no case-insensitively and rejects invalid values even beside yes', () => {
  const files = { 'tasks.md': contract, 'proposal.md': 'x', 'design.md': design, 'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n', 'review.md': REVIEW };
  for (const required of ['yes', 'YES', 'Yes', 'no', 'NO', 'No', '`yes`', '`no`']) {
    const rows = `${acceptance}\n| SCEN-1 | CLI | T-02 | node --test test/shared.test.mjs | ${required} | PENDING | pending |`;
    const result = run(change({ ...files, 'acceptance.md': rows }));
    assert.equal(result.status, 0, `${required}: ${result.stdout}`);
  }
  for (const required of ['', 'maybe', 'y', 'true', 'nope', 'yes please']) {
    const rows = `${acceptance}\n| SCEN-1 | CLI | T-02 | node --test test/shared.test.mjs | ${required} | PENDING | pending |`;
    const result = run(change({ ...files, 'acceptance.md': rows }));
    assert.equal(result.status, 1, required);
    assert.match(result.stdout, /BAD_ACCEPTANCE_REQUIRED/);
    assert.match(result.stdout, /acceptance\.md:4/);
  }
});

test('acceptance requires the same seven-column header as runner', () => {
  const files = { 'tasks.md': contract, 'proposal.md': 'x', 'design.md': design, 'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n', 'review.md': REVIEW };
  const original = '| Scenario | Entry | Tasks | Verify | Required | Result | Evidence |';
  for (const [header, row] of [
    ['| Scenario | Entry | Tasks | Verify | Required | Result | Evidence | Extra |', '| SCEN-1 | CLI | T-02 | node --test test/shared.test.mjs | yes | PENDING | pending | extra |'],
    ['| Scenario | Entry | Tasks | Verify | Required | Outcome | Evidence |', '| SCEN-1 | CLI | T-02 | node --test test/shared.test.mjs | yes | PENDING | pending |'],
    ['| Scenario | Entry | Tasks | Verify | Required | Evidence | Result |', '| SCEN-1 | CLI | T-02 | node --test test/shared.test.mjs | yes | PENDING | pending |'],
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
  const missing = run(change({ ...files, 'acceptance.md': '| SCEN-1 | CLI | T-02 | node --test test/shared.test.mjs | yes | PENDING | pending |' }));
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
    'acceptance.md': table('| SCEN-1 | CLI | T-01,T-02 | node --test test/shared.test.mjs | yes | PENDING | pending |'),
    'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n',
    'review.md': REVIEW,
    ...files,
  });
}
const codes = (result) => {
  try { return JSON.parse(result.stdout).blocking; } catch { return []; }
};

test('BAD_ACCEPTANCE_TASKS: an empty Tasks cell is rejected, as are non-task tokens', () => {
  const files = { 'tasks.md': contract, 'proposal.md': 'x', 'design.md': design, 'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n', 'review.md': REVIEW };
  const derived = run(change({ ...files, 'acceptance.md': table('| SCEN-1 | CLI |  | node --test test/shared.test.mjs | yes | PENDING | pending |') }));
  assert.equal(derived.status, 1, derived.stdout);
  assert.match(codes(derived).join('\n'), /^BAD_ACCEPTANCE_TASKS acceptance\.md:3 SCEN-1: Tasks cell is empty/m);
  const bad = run(change({ ...files, 'acceptance.md': table('| SCEN-1 | CLI | T-01 and T-02 | node --test test/shared.test.mjs | yes | PENDING | pending |') }));
  assert.equal(bad.status, 1);
  assert.match(codes(bad).join('\n'), /^BAD_ACCEPTANCE_TASKS acceptance\.md:3 SCEN-1: Tasks token T-01 and T-02 is not a task id$/m);
  // A placeholder on a Required=no row must not silently derive owners either.
  const placeholder = run(change({ ...files, 'acceptance.md': table('| SCEN-1 | CLI | TBD | node -e "0" | no | PENDING | pending |\n| SCEN-1 | CLI | T-01 | node --test test/shared.test.mjs | yes | PENDING | pending |') }));
  assert.equal(placeholder.status, 1);
  assert.match(codes(placeholder).join('\n'), /^BAD_ACCEPTANCE_TASKS acceptance\.md:3 SCEN-1: Tasks token TBD is not a task id$/m);
});

test('UNKNOWN_ACCEPTANCE_TASK: a Tasks cell naming a task absent from tasks.md is rejected', () => {
  const result = run(change({
    'tasks.md': contract, 'proposal.md': 'x', 'design.md': design, 'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n', 'review.md': REVIEW,
    'acceptance.md': table('| SCEN-1 | CLI | T-01,T-02,T-03,T-04,T-99 | node --test test/shared.test.mjs | yes | PENDING | pending |'),
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
    'acceptance.md': table('| SCEN-1 | CLI | T-02 | node --test test/shared.test.mjs | yes | PENDING | pending |\n| SCEN-2 | CLI | T-01 | node --test test/shared.test.mjs | yes | PENDING | pending |'),
    'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n### Scenario: SCEN-2\n- **Verify:** node --test test/sink.test.mjs\n',
  }));
  assert.equal(result.status, 1);
  assert.match(codes(result).join('\n'), /^UNOWNED_ACCEPTANCE_SCEN SCEN-1: T-02 does not claim it in tasks\.md Scenarios$/m);
});

test('UNACCEPTED_SCEN: every declared SCEN needs an acceptance row', () => {
  const dir = change({
    'tasks.md': `${contract}\n- [ ] 1.5 T-05 other\n  - Write scope: src/other,test/other.test.mjs\n  - Verify with: node --test test/other.test.mjs\n  - Scen: SCEN-2`,
    'proposal.md': 'x', 'design.md': design, 'review.md': REVIEW,
    'acceptance.md': acceptance,
    'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n### Scenario: SCEN-2\n- **Verify:** node --test test/sink.test.mjs\n',
  });
  const result = run(dir);
  assert.equal(result.status, 1);
  assert.match(codes(result).join('\n'), /^UNACCEPTED_SCEN SCEN-2 \(specs\/a\/spec\.md\): every declared SCEN needs an acceptance row$/m);
});

test('UNACCEPTED_TASK_SCEN: every claiming task must appear in that SCEN\'s Tasks cell', () => {
  const result = run(change({
    'tasks.md': contract, 'proposal.md': 'x', 'design.md': design, 'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n', 'review.md': REVIEW,
    'acceptance.md': table('| SCEN-1 | CLI | T-02,T-03,T-04 | node --test test/shared.test.mjs | yes | PENDING | pending |'),
  }));
  assert.equal(result.status, 1);
  assert.match(codes(result).join('\n'), /^UNACCEPTED_TASK_SCEN T-01: SCEN-1 is claimed but no acceptance row lists T-01$/m);
});

// ---- entry ownership: the row owner must write the acceptance Entry, or reach its writer ----
const entryTask = (id, { depends = '', uses = '', scope, scen = '', extra = '' }) => [
  `- [ ] 1.1 ${id} task`,
  ...(depends ? [`  - Depends on: ${depends}`] : []),
  ...(uses ? [`  - Uses: ${uses}`] : []),
  `  - Write scope: ${scope}`,
  ...(extra ? [extra] : []),
  `  - Verify with: node --test test/${id.toLowerCase()}.test.mjs`,
  ...(scen ? [`  - Scen: ${scen}`] : []),
].join('\n');
const entryRun = (tasks, rows, spec = '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n### Scenario: SCEN-2\n- **Verify:** node --test test/sink.test.mjs\n') => run(change({
  'tasks.md': tasks.join('\n'),
  'proposal.md': 'x',
  'design.md': design,
  'review.md': REVIEW,
  'specs/a/spec.md': spec,
  'acceptance.md': table(rows),
}));
// D4 shape: the component owns the SCEN, the entry file belongs to an unrelated assembler.
const splitEntry = [
  entryTask('T-01', { scope: 'src/form/ExpenseLine.tsx,test/t-01.test.mjs', scen: 'SCEN-1' }),
  entryTask('T-02', { scope: 'src/form/ExpenseBillForm.tsx,test/t-02.test.mjs', scen: 'SCEN-2' }),
];
const splitRow = (tasks, entry = 'src/form/ExpenseBillForm.tsx') => `| SCEN-1 | ${entry} | ${tasks} | node --test test/shared.test.mjs | yes | PENDING | pending |
| SCEN-2 | GET /api/other | T-02 | node --test test/shared.test.mjs | yes | PENDING | pending |`;

test('ENTRY_OWNER_UNCLAIMED: a row owner that does not write the Entry and cannot reach its writer blocks', () => {
  const result = entryRun(splitEntry, splitRow('T-01'));
  assert.equal(result.status, 1);
  assert.match(codes(result).join('\n'), /^ENTRY_OWNER_UNCLAIMED SCEN-1 acceptance\.md:3: Entry src\/form\/ExpenseBillForm\.tsx is written by T-02 but no row owner writes it or depends on its writer$/m);
});

test('ENTRY_OWNER_UNCLAIMED: derived empty Tasks combined with the entry check', () => {
  const result = entryRun(splitEntry, splitRow(''));
  assert.equal(result.status, 1);
  assert.match(codes(result).join('\n'), /^ENTRY_OWNER_UNCLAIMED SCEN-1 acceptance\.md:3:/m);
});

test('ENTRY_OWNER_UNCLAIMED: the owner may write the Entry itself', () => {
  const tasks = [
    entryTask('T-01', { scope: 'src/form/ExpenseBillForm.tsx,test/t-01.test.mjs', scen: 'SCEN-1' }),
    entryTask('T-02', { scope: 'src/form/ExpenseLine.tsx,test/t-02.test.mjs', scen: 'SCEN-2' }),
  ];
  assert.equal(entryRun(tasks, splitRow('T-01')).status, 0);
});

test('ENTRY_OWNER_UNCLAIMED: the owner may depend on the writer', () => {
  const tasks = splitEntry.map((task) => (task.includes('T-01 task') ? task.replace('  - Write scope:', '  - Depends on: T-02\n  - Write scope:') : task));
  assert.equal(entryRun(tasks, splitRow('T-01')).status, 0);
});

test('ENTRY_OWNER_UNCLAIMED: a skeleton that pre-wires the Entry satisfies the consumer through Uses', () => {
  const tasks = [
    entryTask('T-00', { scope: 'src/form/ExpenseBillForm.tsx,test/t-00.test.mjs', extra: '  - Kind: skeleton\n  - Interface: src/form/ExpenseBillForm.tsx#Form\n  - Review: mechanical' }),
    entryTask('T-01', { uses: 'T-00', scope: 'src/form/ExpenseLine.tsx,test/t-01.test.mjs', scen: 'SCEN-1' }),
  ];
  // The short name resolves against the skeleton's Write scope.
  assert.equal(entryRun(tasks, '| SCEN-1 | ExpenseBillForm.tsx | T-01 | node --test test/shared.test.mjs | yes | PENDING | pending |', '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n').status, 0);
});

test('ENTRY_OWNER_UNCLAIMED: entries without a file token or without a writer are left to R0', () => {
  assert.equal(entryRun(splitEntry, splitRow('T-01', 'GET /api/expenses')).status, 0);
  assert.equal(entryRun(splitEntry, splitRow('T-01', 'src/legacy/Unchanged.tsx')).status, 0);
  // A version-like number in prose is not a file path.
  assert.equal(entryRun(splitEntry, splitRow('T-01', 'timeout 1.5 s')).status, 0);
});

test('ENTRY_OWNER_UNCLAIMED: one-char and long extensions still resolve', () => {
  const tasks = splitEntry.map((task) => (task.includes('T-02 task')
    ? task.replace('src/form/ExpenseBillForm.tsx', 'src/main.c,config/application.properties')
    : task));
  const short = entryRun(tasks, splitRow('T-01', '`src/main.c`'));
  assert.equal(short.status, 1);
  assert.match(codes(short).join('\n'), /^ENTRY_OWNER_UNCLAIMED SCEN-1 acceptance\.md:3: Entry src\/main\.c is written by T-02/m);
  const long = entryRun(tasks, splitRow('T-01', 'config/application.properties'));
  assert.equal(long.status, 1);
  assert.match(codes(long).join('\n'), /^ENTRY_OWNER_UNCLAIMED SCEN-1 acceptance\.md:3: Entry config\/application\.properties is written by T-02/m);
});

test('ENTRY_OWNER_UNCLAIMED: a leading ./ and a #fragment do not hide the entry file', () => {
  const tasks = splitEntry.map((task) => (task.includes('T-02 task')
    ? task.replace('src/form/ExpenseBillForm.tsx', 'src/main.c')
    : task));
  for (const entry of ['./src/main.c', '././src/main.c', '`./src/main.c`', 'src/main.c#main', './src/main.c#main']) {
    const result = entryRun(tasks, splitRow('T-01', entry));
    assert.equal(result.status, 1, entry);
    assert.match(codes(result).join('\n'), /^ENTRY_OWNER_UNCLAIMED SCEN-1 acceptance\.md:3: Entry (?:\.\/)*src\/main\.c is written by T-02/m, entry);
  }
  // The owner that does write it still passes with the same spellings.
  const owned = [
    entryTask('T-01', { scope: 'src/main.c,test/t-01.test.mjs', scen: 'SCEN-1' }),
    entryTask('T-02', { scope: 'src/form/ExpenseLine.tsx,test/t-02.test.mjs', scen: 'SCEN-2' }),
  ];
  assert.equal(entryRun(owned, splitRow('T-01', './src/main.c#main')).status, 0);
  // Fragments and globs on non-file words stay out of the check.
  assert.equal(entryRun(splitEntry, splitRow('T-01', '#main')).status, 0);
  assert.equal(entryRun(splitEntry, splitRow('T-01', 'src/**/*.ts')).status, 0);
});

// A user entry (UI path or HTTP route) whose owner writes only helper modules: the Verify can
// only exercise isolated logic, so the user path stays untested (D8 F-4 class). Advisory, not a
// block: which code serves an Entry is a judgment the author and R0 share.
const userEntryTasks = [
  entryTask('T-01', { scope: 'src/utils/totals.ts,test/t-01.test.mjs', scen: 'SCEN-1' }),
  entryTask('T-02', { scope: 'src/form/ExpenseBillForm.tsx,test/t-02.test.mjs', scen: 'SCEN-2' }),
  entryTask('T-03', { scope: 'packages/server/src/services/bill-submit-service.ts,test/t-03.test.mjs', scen: 'SCEN-3' }),
];
const userEntryRows = [
  '| SCEN-1 | UI `?view=SUBMIT_HUB&entry=EXPENSE` total | T-01 | node --test test/shared.test.mjs | yes | PENDING | pending |',
  '| SCEN-2 | UI `?view=SUBMIT_HUB&entry=EXPENSE` form | T-02 | node --test test/shared.test.mjs | yes | PENDING | pending |',
  '| SCEN-3 | POST /api/v1/bills/submit | T-03 | node --test test/shared.test.mjs | yes | PENDING | pending |',
].join('\n');

test('ADVISORY_ENTRY_NOT_EXERCISED: a UI entry owned by a helper-only task is advised, not blocked', () => {
  const result = entryRun(userEntryTasks, userEntryRows, '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n### Scenario: SCEN-2\n- **Verify:** node --test test/sink.test.mjs\n### Scenario: SCEN-3\n- **Verify:** node --test test/sink.test.mjs\n');
  assert.equal(result.status, 0, result.stdout);
  const advisories = JSON.parse(result.stdout).advisories;
  const hits = advisories.filter((item) => item.startsWith('ADVISORY_ENTRY_NOT_EXERCISED'));
  assert.equal(hits.length, 1, advisories.join('\n'));
  assert.match(hits[0], /^ADVISORY_ENTRY_NOT_EXERCISED SCEN-1 acceptance\.md:3: Entry UI .* is a user entry, but T-01 writes only src\/utils\/totals\.ts/);
  // The component owner and the service owner reach their entries.
  assert.doesNotMatch(advisories.join('\n'), /ADVISORY_ENTRY_NOT_EXERCISED SCEN-2/);
  assert.doesNotMatch(advisories.join('\n'), /ADVISORY_ENTRY_NOT_EXERCISED SCEN-3/);
});

test('ADVISORY_ENTRY_NOT_EXERCISED: an HTTP entry owned by a helper-only task is advised too', () => {
  const tasks = [
    entryTask('T-01', { scope: 'src/utils/payload.ts,test/t-01.test.mjs', scen: 'SCEN-1' }),
  ];
  const result = entryRun(tasks, '| SCEN-1 | POST /api/v1/bills/submit | T-01 | node --test test/shared.test.mjs | yes | PENDING | pending |', '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n');
  assert.equal(result.status, 0, result.stdout);
  assert.match(JSON.parse(result.stdout).advisories.join('\n'), /^ADVISORY_ENTRY_NOT_EXERCISED SCEN-1 acceptance\.md:3:/m);
});

test('ADVISORY_ENTRY_NOT_EXERCISED: a server package root does not hide helpers or domain modules', () => {
  for (const scope of ['packages/server/src/utils/payload.ts', 'packages/server/src/domain/invoice.ts']) {
    const tasks = [entryTask('T-01', { scope: `${scope},test/t-01.test.mjs`, scen: 'SCEN-1' })];
    const result = entryRun(tasks, '| SCEN-1 | POST /api/v1/bills/submit | T-01 | node --test test/shared.test.mjs | yes | PENDING | pending |', '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n');
    assert.equal(result.status, 0, result.stdout);
    const hits = JSON.parse(result.stdout).advisories.filter((item) => item.startsWith('ADVISORY_ENTRY_NOT_EXERCISED'));
    assert.equal(hits.length, 1, `${scope}: ${result.stdout}`);
    assert.ok(hits[0].includes(scope), hits[0]);
  }
});

test('ADVISORY_ENTRY_NOT_EXERCISED: entries that name no user path are left to the other rules', () => {
  const tasks = [
    entryTask('T-01', { scope: 'src/utils/totals.ts,test/t-01.test.mjs', scen: 'SCEN-1' }),
    entryTask('T-02', { scope: 'src/form/ExpenseBillForm.tsx,test/t-02.test.mjs', scen: 'SCEN-2' }),
  ];
  const cli = entryRun(tasks, '| SCEN-1 | CLI | T-01 | node --test test/shared.test.mjs | yes | PENDING | pending |\n| SCEN-2 | CLI | T-02 | node --test test/shared.test.mjs | yes | PENDING | pending |', '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n### Scenario: SCEN-2\n- **Verify:** node --test test/sink.test.mjs\n');
  assert.equal(cli.status, 0, cli.stdout);
  assert.doesNotMatch(JSON.parse(cli.stdout).advisories.join('\n'), /ADVISORY_ENTRY_NOT_EXERCISED/);
  // A file Entry is judged by ENTRY_OWNER_UNCLAIMED, so it is never reported twice.
  const file = entryRun(tasks, '| SCEN-1 | src/form/ExpenseBillForm.tsx | T-01 | node --test test/shared.test.mjs | yes | PENDING | pending |\n| SCEN-2 | CLI | T-02 | node --test test/shared.test.mjs | yes | PENDING | pending |', '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n### Scenario: SCEN-2\n- **Verify:** node --test test/sink.test.mjs\n');
  assert.equal(file.status, 1);
  assert.match(codes(file).join('\n'), /^ENTRY_OWNER_UNCLAIMED SCEN-1 acceptance\.md:3:/m);
  assert.doesNotMatch(JSON.parse(file.stdout).advisories.join('\n'), /ADVISORY_ENTRY_NOT_EXERCISED/);
});

test('BAD_ACCEPTANCE_TASKS: a comma-only or empty Tasks cell fails', () => {
  const files = { 'tasks.md': contract, 'proposal.md': 'x', 'design.md': design, 'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n', 'review.md': REVIEW };
  for (const cell of [',', ' , ', ',,', 'TBD,', ', ,']) {
    for (const required of ['no', 'yes']) {
      const result = run(change({ ...files, 'acceptance.md': table(`| SCEN-1 | CLI | ${cell} | node --test test/shared.test.mjs | ${required} | PENDING | pending |\n| SCEN-1 | CLI | T-01 | node --test test/shared.test.mjs | yes | PENDING | pending |`) }));
      assert.equal(result.status, 1, `${JSON.stringify(cell)} ${required}`);
      assert.match(codes(result).join('\n'), /^BAD_ACCEPTANCE_TASKS acceptance\.md:3 SCEN-1:/m, `${JSON.stringify(cell)} ${required}`);
    }
  }
  const empty = run(change({ ...files, 'acceptance.md': table('| SCEN-1 | CLI |  | node --test test/shared.test.mjs | yes | PENDING | pending |') }));
  assert.equal(empty.status, 1, empty.stdout);
  assert.match(codes(empty).join('\n'), /^BAD_ACCEPTANCE_TASKS acceptance\.md:3 SCEN-1: Tasks cell is empty/m);
});

// A repo with SCEN ids already declared outside `aligned()`: the baseline spec and one other change.
// `ownBody`/`otherBody` are the scenario lines under the heading, so a test can diverge the body
// while keeping the heading text identical.
function repoWith(id, {
  baselineSection = 'Requirements',
  otherSection = 'MODIFIED Requirements',
  ownSection = 'MODIFIED Requirements',
  ownTitle = 'shared behavior',
  otherTitle = 'other behavior',
  ownBody = 'WHEN a\nTHEN b\n',
  otherBody = 'WHEN a\nTHEN b\n',
  otherFile = null,
} = {}) {
  // A scenario without a Verify line is now a full-run block too, so every fixture declaration
  // carries one; it is appended to both sides identically and never changes what a test diverges.
  // Appended after the last non-empty line, so the blank-line cases stay what they were.
  const withVerify = (body) => (/\*\*Verify:\*\*/.test(body) ? body : `${body.replace(/\n+$/, '')}\n- **Verify:** node --test test/shared.test.mjs${body.match(/\n*$/)[0]}`);
  ownBody = withVerify(ownBody);
  otherBody = withVerify(otherBody);
  if (otherFile !== null) otherFile = withVerify(otherFile);
  const dir = aligned({ 'specs/a/spec.md': `${ownSection === 'none' ? '' : `## ${ownSection}\n`}### Scenario: SCEN-1${ownTitle ? ` ${ownTitle}` : ''}\n${ownBody}` });
  const sh = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  sh('init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(dir, 'openspec/specs/cap'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'openspec/specs/cap/spec.md'), `## ${baselineSection}\n### Scenario: ${id} baseline\n`);
  fs.mkdirSync(path.join(dir, 'openspec/changes/other/specs/cap'), { recursive: true });
  if (otherFile !== null) {
    fs.writeFileSync(path.join(dir, 'openspec/changes/other/specs/cap/spec.md'), otherFile);
  } else {
    fs.writeFileSync(path.join(dir, 'openspec/changes/other/specs/cap/spec.md'), `## ${otherSection}\n### Scenario: ${id}${otherTitle ? ` ${otherTitle}` : ''}\n${otherBody}`);
  }
  return dir;
}

test('COLLIDING_SCEN: another change declaring the id with different heading text blocks whatever section either side uses', () => {
  for (const otherSection of ['MODIFIED Requirements', 'ADDED Requirements']) {
    const dir = repoWith('SCEN-1', { otherSection });
    const result = run(dir, ['--structural', '--skip-signer-check']);
    assert.equal(result.status, 1, otherSection);
    assert.match(codes(result).join('\n'), /^COLLIDING_SCEN SCEN-1: already declared in openspec\/changes\/other\/specs\/cap\/spec\.md$/m, otherSection);
  }
});

test('ADVISORY_SHARED_SCEN: another change re-declaring the same heading text is advisory only', () => {
  // `openspec validate` requires an unchanged MODIFIED scenario to be repeated verbatim, so the
  // author cannot avoid reusing the id. Only the separator after `SCEN-1` is trimmed; the title
  // itself is compared byte for byte.
  const dir = repoWith('SCEN-1', { otherSection: 'MODIFIED Requirements', ownTitle: 'shared behavior', otherTitle: ' shared behavior' });
  const result = run(dir, ['--structural', '--skip-signer-check']);
  assert.equal(result.status, 0, JSON.stringify(codes(result)));
  assert.doesNotMatch(codes(result).join('\n'), /COLLIDING_SCEN/);
  assert.match(JSON.parse(result.stdout).advisories.join('\n'), /^ADVISORY_SHARED_SCEN SCEN-1: openspec\/changes\/other\/specs\/cap\/spec\.md declares the same scenario text; confirm archive\/merge order with that change before CP-1$/m);
});

test('COLLIDING_SCEN: heading text that differs in internal whitespace is not the same declaration', () => {
  // A title is content, not prose to be normalized: collapsing runs of spaces made these two titles
  // compare equal, so a genuinely different heading was exempted from the collision check.
  const dir = repoWith('SCEN-1', { otherSection: 'MODIFIED Requirements', ownTitle: 'shared   behavior', otherTitle: 'shared behavior' });
  const result = run(dir, ['--structural', '--skip-signer-check']);
  assert.equal(result.status, 1, JSON.stringify(codes(result)));
  assert.match(codes(result).join('\n'), /^COLLIDING_SCEN SCEN-1: already declared in openspec\/changes\/other\/specs\/cap\/spec\.md$/m);
  assert.doesNotMatch(JSON.parse(result.stdout).advisories.join('\n'), /ADVISORY_SHARED_SCEN SCEN-1/);
});

test('COLLIDING_SCEN: identical heading but a different body still blocks', () => {
  const dir = repoWith('SCEN-1', {
    otherSection: 'MODIFIED Requirements',
    ownTitle: 'shared behavior',
    otherTitle: 'shared behavior',
    ownBody: 'WHEN a\nTHEN b\n',
    otherBody: 'WHEN a\nTHEN c\n',
  });
  const result = run(dir, ['--structural', '--skip-signer-check']);
  assert.equal(result.status, 1);
  assert.match(codes(result).join('\n'), /^COLLIDING_SCEN SCEN-1: already declared in openspec\/changes\/other\/specs\/cap\/spec\.md$/m);
  assert.doesNotMatch(JSON.parse(result.stdout).advisories.join('\n'), /ADVISORY_SHARED_SCEN SCEN-1/);
});

test('COLLIDING_SCEN: an external declaration inside a fence or comment is not a declaration', () => {
  // The id and a *divergent* title sit only inside a fenced example / a comment: nothing claims the
  // id, so there is no collision. If fences or comments were scanned, the divergent title would block.
  for (const text of [
    '## MODIFIED Requirements\n```markdown\n### Scenario: SCEN-1 old meaning\n```\n',
    '## MODIFIED Requirements\n<!--\n### Scenario: SCEN-1 old meaning\n-->\n',
  ]) {
    const dir = repoWith('SCEN-1', { otherFile: text, ownBody: '', otherTitle: 'shared behavior' });
    const result = run(dir, ['--structural', '--skip-signer-check']);
    assert.equal(result.status, 0, `${text}: ${JSON.stringify(codes(result))}`);
    assert.doesNotMatch(codes(result).join('\n'), /COLLIDING_SCEN/);
  }
  // The same divergent heading outside the fence is a real declaration and blocks.
  const dir = repoWith('SCEN-1', { otherFile: '## MODIFIED Requirements\n```markdown\n### Scenario: SCEN-1 old meaning\n```\n### Scenario: SCEN-1 old meaning\n' });
  const result = run(dir, ['--structural', '--skip-signer-check']);
  assert.equal(result.status, 1);
  assert.match(codes(result).join('\n'), /^COLLIDING_SCEN SCEN-1: already declared in openspec\/changes\/other\/specs\/cap\/spec\.md$/m);
});

test('COLLIDING_SCEN: a differing fenced payload in the body is a collision, not a verbatim share', () => {
  const ownBody = 'WHEN client posts the payload\nTHEN server accepts it\n```json\n{"allowed": true}\n```\n';
  const otherBody = 'WHEN client posts the payload\nTHEN server accepts it\n```json\n{"allowed": false}\n```\n';
  const dir = repoWith('SCEN-1', { otherSection: 'MODIFIED Requirements', ownTitle: 'shared contract', otherTitle: 'shared contract', ownBody, otherBody });
  const result = run(dir, ['--structural', '--skip-signer-check']);
  assert.equal(result.status, 1);
  assert.match(codes(result).join('\n'), /^COLLIDING_SCEN SCEN-1: already declared in openspec\/changes\/other\/specs\/cap\/spec\.md$/m);
});

test('COLLIDING_SCEN: a body does not end at a # line inside a fence', () => {
  // A `#` line inside a fenced payload is content, not a heading: if it ended the body, the
  // differing THEN below it would never be compared.
  const shapes = [
    ['WHEN run the probe\n```bash\n# step one\nprobe --flag\n```\nTHEN exit 0', 'WHEN run the probe\n```bash\n# step one\nprobe --flag\n```\nTHEN exit 7'],
    ['WHEN run the probe\n~~~bash\n# step one\nprobe --flag\n~~~\nTHEN exit 0', 'WHEN run the probe\n~~~bash\n# step one\nprobe --flag\n~~~\nTHEN exit 7'],
    ['WHEN run the probe\n```bash\n## Examples\nprobe --flag\n```\nTHEN exit 0', 'WHEN run the probe\n```bash\n## Examples\nprobe --flag\n```\nTHEN exit 7'],
    // an unclosed fence must not hide the rest of the body either
    ['WHEN run the probe\n```bash\n# stuck\nprobe --flag', 'WHEN run the probe\n```bash\n# stuck\nprobe --other'],
  ];
  for (const [ownBody, otherBody] of shapes) {
    const dir = repoWith('SCEN-1', { otherSection: 'MODIFIED Requirements', ownTitle: 'shared contract', otherTitle: 'shared contract', ownBody, otherBody });
    const result = run(dir, ['--structural', '--skip-signer-check']);
    assert.equal(result.status, 1, `${ownBody}\n---\n${otherBody}`);
    assert.match(codes(result).join('\n'), /^COLLIDING_SCEN SCEN-1: already declared in openspec\/changes\/other\/specs\/cap\/spec\.md$/m, ownBody);
  }
});

test('COLLIDING_SCEN: a body does not end at a # line inside an HTML comment', () => {
  const ownBody = 'WHEN run the probe\n<!--\n### old shape\n-->\nTHEN exit 0';
  const otherBody = 'WHEN run the probe\n<!--\n### old shape\n-->\nTHEN exit 7';
  const dir = repoWith('SCEN-1', { otherSection: 'MODIFIED Requirements', ownTitle: 'shared contract', otherTitle: 'shared contract', ownBody, otherBody });
  const result = run(dir, ['--structural', '--skip-signer-check']);
  assert.equal(result.status, 1);
  assert.match(codes(result).join('\n'), /^COLLIDING_SCEN SCEN-1: already declared in openspec\/changes\/other\/specs\/cap\/spec\.md$/m);
});

test('COLLIDING_SCEN: the fence delimiter style is part of the body', () => {
  // Same prose and payload, backticks in one change and tildes in the other. Delimiter normalization
  // was one more piece of equivalence the checker guessed at; content identity means a reuse copies
  // the authoritative text instead of regenerating it in whatever fence style is handy.
  const dir = repoWith('SCEN-1', {
    otherSection: 'MODIFIED Requirements', ownTitle: 'shared contract', otherTitle: 'shared contract',
    ownBody: 'WHEN a\n```\npayload\n```\nTHEN b\n', otherBody: 'WHEN a\n~~~\npayload\n~~~\nTHEN b\n',
  });
  const result = run(dir, ['--structural', '--skip-signer-check']);
  assert.equal(result.status, 1, JSON.stringify(codes(result)));
  assert.match(codes(result).join('\n'), /^COLLIDING_SCEN SCEN-1: already declared in openspec\/changes\/other\/specs\/cap\/spec\.md$/m);
  assert.doesNotMatch(JSON.parse(result.stdout).advisories.join('\n'), /ADVISORY_SHARED_SCEN SCEN-1/);
});

test('COLLIDING_SCEN: a nested fence with a different inner info string is a collision', () => {
  // The reviewer's final blocker: a 4-backtick outer fence holds a ```json example in one change and
  // a ```yaml example in the other. Both are single delimiter lines by the old rule, so both were
  // reduced to `~~~` and the payload's language marker stopped being compared.
  const ownBody = 'WHEN the example renders\n````markdown\n```json\n{"allowed": true}\n```\n````\nTHEN it is shown\n';
  const otherBody = 'WHEN the example renders\n````markdown\n```yaml\n{"allowed": true}\n```\n````\nTHEN it is shown\n';
  const dir = repoWith('SCEN-1', { otherSection: 'MODIFIED Requirements', ownTitle: 'shared contract', otherTitle: 'shared contract', ownBody, otherBody });
  const result = run(dir, ['--structural', '--skip-signer-check']);
  assert.equal(result.status, 1, JSON.stringify(codes(result)));
  assert.match(codes(result).join('\n'), /^COLLIDING_SCEN SCEN-1: already declared in openspec\/changes\/other\/specs\/cap\/spec\.md$/m);
});

test('ADVISORY_SHARED_SCEN: an exactly identical body with a nested fence stays advisory', () => {
  // Positive control for the test above: identity, not the presence of a nested fence, is what
  // decides. The two sides are byte-identical here.
  const body = 'WHEN the example renders\n````markdown\n```json\n{"allowed": true}\n```\n````\nTHEN it is shown\n';
  const dir = repoWith('SCEN-1', { otherSection: 'MODIFIED Requirements', ownTitle: 'shared contract', otherTitle: 'shared contract', ownBody: body, otherBody: body });
  const result = run(dir, ['--structural', '--skip-signer-check']);
  assert.equal(result.status, 0, JSON.stringify(codes(result)));
  assert.match(JSON.parse(result.stdout).advisories.join('\n'), /^ADVISORY_SHARED_SCEN SCEN-1: openspec\/changes\/other\/specs\/cap\/spec\.md declares the same scenario text/m);
});

test('COLLIDING_SCEN: a body differing only in interior whitespace is a collision', () => {
  // A literal's spacing is meaningful; collapsing it would hide a changed value.
  const dir = repoWith('SCEN-1', {
    otherSection: 'MODIFIED Requirements', ownTitle: 'shared contract', otherTitle: 'shared contract',
    ownBody: 'WHEN POST /api/x?n=a  b\nTHEN ok\n', otherBody: 'WHEN POST /api/x?n=a b\nTHEN ok\n',
  });
  const result = run(dir, ['--structural', '--skip-signer-check']);
  assert.equal(result.status, 1);
  assert.match(codes(result).join('\n'), /^COLLIDING_SCEN SCEN-1: already declared in openspec\/changes\/other\/specs\/cap\/spec\.md$/m);
});

test('COLLIDING_SCEN: per-line trailing whitespace is part of the body', () => {
  // The last normalization removed besides line endings and leading/trailing blank lines. Markdown
  // uses two trailing spaces as a hard line break and a trailing backslash is content too, so
  // stripping them made two different bodies compare equal.
  const dir = repoWith('SCEN-1', {
    otherSection: 'MODIFIED Requirements', ownTitle: 'shared contract', otherTitle: 'shared contract',
    ownBody: 'WHEN a  \nTHEN b\n', otherBody: 'WHEN a\nTHEN b\n',
  });
  const result = run(dir, ['--structural', '--skip-signer-check']);
  assert.equal(result.status, 1, JSON.stringify(codes(result)));
  assert.match(codes(result).join('\n'), /^COLLIDING_SCEN SCEN-1: already declared in openspec\/changes\/other\/specs\/cap\/spec\.md$/m);
});

test('ADVISORY_SHARED_SCEN: leading and trailing blank lines alone are not a difference', () => {
  // The one boundary exception that is safe: blank lines outside the body carry no content.
  const dir = repoWith('SCEN-1', {
    otherSection: 'MODIFIED Requirements', ownTitle: 'shared contract', otherTitle: 'shared contract',
    ownBody: '\n\nWHEN a\nTHEN b\n\n\n', otherBody: 'WHEN a\nTHEN b\n',
  });
  const result = run(dir, ['--structural', '--skip-signer-check']);
  assert.equal(result.status, 0, JSON.stringify(codes(result)));
  assert.match(JSON.parse(result.stdout).advisories.join('\n'), /^ADVISORY_SHARED_SCEN SCEN-1: openspec\/changes\/other\/specs\/cap\/spec\.md declares the same scenario text/m);
});

test('DESIGN_NAMES_TASK: an HTML comment naming a task id is not prose', () => {
  // The scaffold's comment explains the rule with an example id; keeping it must not block.
  const commented = run(aligned({ 'design.md': '## Decisions\n<!-- 绝不写任务 ID（T-01 之类） -->\n- **D-01 shared helper** 影响模块/路径: src/shared\n- **D-02 wiring** 影响模块/路径: src/app.mjs\n' }));
  assert.equal(commented.status, 0, JSON.stringify(codes(commented)));
  assert.doesNotMatch(codes(commented).join('\n'), /DESIGN_NAMES_TASK/);
  // The same id in visible prose still blocks.
  const visible = run(aligned({ 'design.md': '## Decisions\n- **D-01 shared helper**\n  - Owner: T-01\n- **D-02 wiring**\n' }));
  assert.equal(visible.status, 1);
  assert.match(codes(visible).join('\n'), /^DESIGN_NAMES_TASK T-01:/m);
});

test('UNOWNED_ACCEPTANCE_SCEN: a Required=no owner row cannot excuse a wrong Required=yes row', () => {
  // T-01 claims SCEN-1 and T-02 claims SCEN-2. The Required=yes SCEN-1 row names only T-02; a second
  // Required=no SCEN-1 row names the real owner T-01, so a union across rows contained the owner and
  // the old check stayed silent.
  const tasks = `- [ ] 1.1 T-01 shared
  - Write scope: src/shared,test/shared.test.mjs
  - Verify with: node --test test/shared.test.mjs
  - Scen: SCEN-1
- [ ] 1.2 T-02 other
  - Depends on: T-01
  - Write scope: src/app.mjs,test/other.test.mjs
  - Verify with: npm test
  - Scen: SCEN-2`;
  const result = run(change({
    'tasks.md': tasks, 'proposal.md': 'x', 'design.md': design, 'review.md': REVIEW,
    'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n### Scenario: SCEN-2\n- **Verify:** node --test test/sink.test.mjs\n',
    'acceptance.md': table('| SCEN-1 | CLI | T-02 | node --test test/shared.test.mjs | yes | PENDING | pending |\n| SCEN-1 | CLI | T-01 | node -e "0" | no | PENDING | pending |\n| SCEN-2 | CLI | T-02 | node --test test/shared.test.mjs | yes | PENDING | pending |'),
  }));
  assert.equal(result.status, 1);
  const blocking = codes(result).join('\n');
  assert.match(blocking, /^UNOWNED_ACCEPTANCE_SCEN SCEN-1: T-02 does not claim it in tasks\.md Scenarios$/m);
  // The Required=no row naming the real owner is fine, so only the divergent yes row is named.
  assert.doesNotMatch(blocking, /UNOWNED_ACCEPTANCE_SCEN SCEN-1: T-01/);
});

test('COLLIDING_SCEN: a baseline id re-declared under MODIFIED or REMOVED Requirements in this change passes', () => {
  for (const ownSection of ['MODIFIED Requirements', 'REMOVED Requirements']) {
    const dir = repoWith('SCEN-1', { otherSection: 'none', ownSection });
    fs.rmSync(path.join(dir, 'openspec/changes/other'), { recursive: true, force: true });
    const result = run(dir, ['--structural', '--skip-signer-check']);
    assert.equal(result.status, 0, `${ownSection}: ${JSON.stringify(codes(result))}`);
  }
});

test('COLLIDING_SCEN: a baseline id re-declared under ADDED (or no section) is still a collision', () => {
  for (const ownSection of ['ADDED Requirements', 'none']) {
    const dir = repoWith('SCEN-1', { otherSection: 'none', ownSection });
    fs.rmSync(path.join(dir, 'openspec/changes/other'), { recursive: true, force: true });
    const result = run(dir, ['--structural', '--skip-signer-check']);
    assert.equal(result.status, 1, ownSection);
    assert.match(codes(result).join('\n'), /^COLLIDING_SCEN SCEN-1: already declared in openspec\/specs\/cap\/spec\.md$/m, ownSection);
  }
});

test('malformed scenario headings never crash the gate, in this change or the baseline', () => {
  // CommonMark needs whitespace after the hashes: `####Scenario:` is text, not a declaration, so the
  // claiming task gets UNKNOWN_SCEN and the run still produces a verdict and parseable JSON.
  const own = change({
    'tasks.md': contract, 'proposal.md': 'x', 'design.md': design, 'review.md': REVIEW, 'acceptance.md': acceptance,
    'specs/a/spec.md': '## ADDED Requirements\n\n####Scenario: SCEN-1 nospace\nWHEN a\nTHEN b\n',
  });
  const ownResult = run(own, ['--structural', '--skip-signer-check']);
  assert.equal(ownResult.status, 1);
  assert.doesNotMatch(ownResult.stderr, /TypeError|at scenarioBody/);
  const ownJson = JSON.parse(ownResult.stdout);
  assert.ok(Array.isArray(ownJson.blocking) && Array.isArray(ownJson.advisories));
  assert.match(ownJson.blocking.join('\n'), /^UNKNOWN_SCEN T-01: SCEN-1 is not declared$/m);

  // The same typo in the baseline must not take the gate down for an otherwise clean package.
  const repo = aligned();
  execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main'], { encoding: 'utf8' });
  fs.mkdirSync(path.join(repo, 'openspec/specs/cap'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'openspec/specs/cap/spec.md'), '## Requirements\n####Scenario: SCEN-1 nospace\nWHEN a\nTHEN b\n');
  const repoResult = run(repo, ['--structural', '--skip-signer-check']);
  assert.equal(repoResult.status, 0, `${repoResult.stderr}\n${repoResult.stdout}`);
  assert.equal(JSON.parse(repoResult.stdout).blocking.length, 0);
});

test('UNOWNED_ACCEPTANCE_SCEN: every id in the Tasks cell must claim the SCEN', () => {
  // T-01 claims SCEN-1, T-02 claims SCEN-2; a row listing both for SCEN-1 must name T-02.
  const tasks = `- [ ] 1.1 T-01 shared
  - Write scope: src/shared,test/shared.test.mjs
  - Verify with: node --test test/shared.test.mjs
  - Scen: SCEN-1
- [ ] 1.2 T-02 other
  - Depends on: T-01
  - Write scope: src/app.mjs,test/other.test.mjs
  - Verify with: npm test
  - Scen: SCEN-2`;
  const result = run(change({
    'tasks.md': tasks, 'proposal.md': 'x', 'design.md': design, 'review.md': REVIEW,
    'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n### Scenario: SCEN-2\n- **Verify:** node --test test/sink.test.mjs\n',
    'acceptance.md': table('| SCEN-1 | CLI | T-01,T-02 | node --test test/shared.test.mjs | yes | PENDING | pending |\n| SCEN-2 | CLI | T-02 | node --test test/shared.test.mjs | yes | PENDING | pending |'),
  }));
  assert.equal(result.status, 1);
  const blocking = codes(result).join('\n');
  assert.match(blocking, /^UNOWNED_ACCEPTANCE_SCEN SCEN-1: T-02 does not claim it in tasks\.md Scenarios$/m);
  assert.doesNotMatch(blocking, /UNOWNED_ACCEPTANCE_SCEN SCEN-1: T-01/);
});

test('UNKNOWN_DECISION: Implements is unresolved when design.md is absent', () => {
  const tasks = `- [ ] 1.1 T-01 shared
  - Write scope: src/shared,test/shared.test.mjs
  - Verify with: node --test test/shared.test.mjs
  - Scen: SCEN-1
  - Implements: D-01
- [ ] 1.2 T-02 sink
  - Depends on: T-01
  - Write scope: src/app.mjs,test/sink.test.mjs
  - Verify with: npm test
  - Scen: SCEN-1`;
  const result = run(change({
    'tasks.md': tasks, 'proposal.md': 'x', 'review.md': REVIEW,
    'acceptance.md': table('| SCEN-1 | CLI | T-01,T-02 | node --test test/shared.test.mjs | yes | PENDING | pending |'),
    'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n',
  }));
  assert.equal(result.status, 1);
  assert.match(codes(result).join('\n'), /^UNKNOWN_DECISION T-01: Implements D-01 is not a decision heading in design\.md$/m);
});

test('BAD_ACCEPTANCE_TASKS: a non-task token in the Tasks cell is named', () => {
  const result = run(change({
    'tasks.md': contract, 'proposal.md': 'x', 'design.md': design, 'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n', 'review.md': REVIEW,
    'acceptance.md': table('| SCEN-1 | CLI | T-01, T-02 (integration) | node --test test/shared.test.mjs | yes | PENDING | pending |'),
  }));
  assert.equal(result.status, 1);
  assert.match(codes(result).join('\n'), /^BAD_ACCEPTANCE_TASKS acceptance\.md:3 SCEN-1: Tasks token T-02 \(integration\) is not a task id$/m);
});

test('the scaffold templates produce a package that passes its own gate without design.md', () => {
  // A template that its own gate rejects costs the author a round. This is the shape of test that
  // catches that class (it would have caught B1, B7 and B8 before they shipped): copy the real
  // templates, fill in only the placeholders, and require RESULT freeze ok.
  const templates = path.join(root, 'openspec-schema', 'templates');
  const readTemplate = (name) => fs.readFileSync(path.join(templates, name), 'utf8');
  const tasks = readTemplate('tasks.md')
    .replaceAll('path/to/file.mjs', 'src/app.mjs')
    .replaceAll('path/to/file.test.mjs', 'test/app.test.mjs')
    .replaceAll('path/to/a.mjs', 'src/api.mjs')
    .replaceAll('path/to/a.test.mjs', 'test/api.test.mjs');
  const acceptance = readTemplate('acceptance.md')
    .replace('| `<跑一遍该入口的命令或步骤>` |', '| node --test test/app.test.mjs |')
    .replace('| `<命令或步骤>` |', '| node --test test/api.test.mjs |');
  const dir = change({
    'proposal.md': readTemplate('proposal.md'),
    'specs/cap/spec.md': '## ADDED Requirements\n\n### Scenario: SCEN-CAP-01 the app starts\n\nWHEN invoked\nTHEN it runs\n- **Verify:** node --test test/app.test.mjs\n\n### Scenario: SCEN-CAP-02 the api answers\n\nWHEN called\nTHEN it answers\n- **Verify:** node --test test/api.test.mjs\n',
    'tasks.md': tasks,
    'acceptance.md': acceptance,
  });
  const result = run(dir, ['--structural', '--skip-signer-check']);
  assert.equal(result.status, 0, `${codes(result).join('\n')}\n---\n${result.stdout}`);
  assert.equal(JSON.parse(result.stdout).blocking.length, 0);
});

test('ADVISORY_SINK_TEST_ONLY: a test-only sink is an advisory, not proof of a missing owner', () => {
  // The sink is a DAG property (nothing consumes it), not proof that it owns assembly. Here T-01 is
  // an upstream behavior task that owns the real production entry, and T-04 is a final mechanical
  // integration check that legitimately writes only tests. The old check blocked this shape, which
  // pushed authors to invent a production path just to satisfy the gate.
  const tasks = `- [ ] 1.1 T-01 behavior
  - Write scope: src/shared.mjs,test/shared.test.mjs
  - Verify with: node --test test/shared.test.mjs
  - Scen: SCEN-1
- [ ] 1.2 T-04 integration
  - Depends on: T-01
  - Write scope: test/integration.test.mjs
  - Review: mechanical
  - Verify with: npm test`;
  const result = run(change({
    'tasks.md': tasks, 'proposal.md': 'x', 'review.md': REVIEW,
    'acceptance.md': table('| SCEN-1 | CLI | T-01 | node --test test/shared.test.mjs | yes | PENDING | pending |'),
    'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n',
  }));
  assert.equal(result.status, 0, JSON.stringify(codes(result)));
  assert.deepEqual(codes(result), []);
  assert.match(JSON.parse(result.stdout).advisories.join('\n'), /^ADVISORY_SINK_TEST_ONLY T-04: sink Write scope has only test paths; check that an upstream scenario task owns the assembly\/wiring entry and that this sink's integration verification is legitimate test-only work$/m);
});

test('the sink advisory is evidence to check, not a closure proof, and behavior-only-test scopes still block', () => {
  // The advisory text must not claim the shape is safe; and a non-sink behavior task whose whole
  // scope is tests is still a hard block, so the advisory did not weaken the vertical-slice rule.
  const testOnlyBehavior = `- [ ] 1.1 T-01 shared
  - Write scope: test/shared.test.mjs
  - Verify with: node --test test/shared.test.mjs
  - Scen: SCEN-1
- [ ] 1.2 T-02 sink
  - Depends on: T-01
  - Write scope: src/app.mjs,test/sink.test.mjs
  - Verify with: npm test
  - Scen: SCEN-1`;
  const dir = change({
    'tasks.md': testOnlyBehavior, 'proposal.md': 'x', 'review.md': REVIEW,
    'acceptance.md': table('| SCEN-1 | CLI | T-01,T-02 | node --test test/shared.test.mjs | yes | PENDING | pending |'),
    'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n',
  });
  const result = run(dir);
  assert.equal(result.status, 1);
  const blocking = codes(result).join('\n');
  assert.match(blocking, /^FIXTURE_ONLY_TASK T-01:/m);
  assert.doesNotMatch(blocking, /SINK_TEST_ONLY/);
  // And an invalid graph is still rejected regardless of the sink shape.
  const cycle = change({
    'tasks.md': `- [ ] 1.1 T-01 a\n  - Depends on: T-02\n  - Write scope: src/a,test/a.test.mjs\n  - Verify with: node --test test/a.test.mjs\n  - Scen: SCEN-1\n- [ ] 1.2 T-02 b\n  - Depends on: T-01\n  - Write scope: src/b,test/b.test.mjs\n  - Verify with: node --test test/b.test.mjs\n  - Scen: SCEN-1`,
    'proposal.md': 'x', 'review.md': REVIEW,
    'acceptance.md': table('| SCEN-1 | CLI | T-01,T-02 | node --test test/shared.test.mjs | yes | PENDING | pending |'),
    'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n',
  });
  assert.match(codes(run(cycle)).join('\n'), /^CYCLE/m);
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

// The acceptance rules the author brief now documents, exercised through the real templates:
// declared coverage, shared Entry/Verify, per-row owner subset, and union coverage.
test('filled templates: every declared SCEN gets a row, rows may share Entry/Verify, owners split by row', () => {
  const templates = path.join(root, 'openspec-schema', 'templates');
  const readTemplate = (name) => fs.readFileSync(path.join(templates, name), 'utf8');
  const tasks = `${readTemplate('tasks.md')
    .replaceAll('path/to/file.mjs', 'src/app.mjs')
    .replaceAll('path/to/file.test.mjs', 'test/app.test.mjs')
    .replaceAll('path/to/a.mjs', 'src/api.mjs')
    .replaceAll('path/to/a.test.mjs', 'test/api.test.mjs')}
- [ ] 2.2 T-03 <second carrier of the same journey>
  - Depends on: T-01
  - Write scope: src/extra.mjs, test/extra.test.mjs
  - Verify with: node --test test/extra.test.mjs
  - Scenarios: SCEN-CAP-01
`;
  const row = (scen, owner) => `| ${scen} | CLI \`node src/app.mjs\` | ${owner} | node --test test/app.test.mjs | yes | PENDING | pending |`;
  const header = '| Scenario | Entry | Tasks | Verify | Required | Result | Evidence |\n| --- | --- | --- | --- | --- | --- | --- |\n';
  const table = (...rows) => header + rows.join('\n');
  const files = {
    'proposal.md': readTemplate('proposal.md'),
    'specs/cap/spec.md': '## ADDED Requirements\n\n### Scenario: SCEN-CAP-01 the app starts\n\nWHEN invoked\nTHEN it runs\n- **Verify:** node --test test/app.test.mjs\n\n### Scenario: SCEN-CAP-02 the api answers\n\nWHEN called\nTHEN it answers\n- **Verify:** node --test test/api.test.mjs\n',
    'tasks.md': tasks,
    // Same Entry and Verify on every row: a scenario needs no new test of its own, and the two
    // SCEN-CAP-01 rows split T-01 and T-03 between them.
    'acceptance.md': table(row('SCEN-CAP-01', 'T-01'), row('SCEN-CAP-01', 'T-03'), row('SCEN-CAP-02', 'T-02')),
  };
  const ok = run(change(files), ['--structural', '--skip-signer-check']);
  assert.equal(ok.status, 0, `${ok.stdout}${ok.stderr}`);
  assert.deepEqual(JSON.parse(ok.stdout).blocking, []);

  // Minimal variants of the same fixture: each still blocks for its own named reason.
  const missing = run(change({ ...files, 'acceptance.md': table(row('SCEN-CAP-01', 'T-01'), row('SCEN-CAP-01', 'T-03')) }), ['--structural', '--skip-signer-check']);
  assert.equal(missing.status, 1);
  assert.match(JSON.parse(missing.stdout).blocking.join('\n'), /^UNACCEPTED_SCEN SCEN-CAP-02 \(specs\/cap\/spec\.md\): every declared SCEN needs an acceptance row$/m);

  const extraOwner = run(change({ ...files, 'acceptance.md': table(row('SCEN-CAP-01', 'T-01,T-02'), row('SCEN-CAP-01', 'T-03'), row('SCEN-CAP-02', 'T-02')) }), ['--structural', '--skip-signer-check']);
  assert.equal(extraOwner.status, 1);
  // T-02 claims only SCEN-CAP-02, so naming it on a SCEN-CAP-01 row blocks even though the union
  // still contains every real claimant: ownership is row-local.
  assert.match(JSON.parse(extraOwner.stdout).blocking.join('\n'), /^UNOWNED_ACCEPTANCE_SCEN SCEN-CAP-01: T-02 does not claim it in tasks\.md Scenarios$/m);

  const unionGap = run(change({ ...files, 'acceptance.md': table(row('SCEN-CAP-01', 'T-01'), row('SCEN-CAP-02', 'T-02')) }), ['--structural', '--skip-signer-check']);
  assert.equal(unionGap.status, 1);
  assert.match(JSON.parse(unionGap.stdout).blocking.join('\n'), /^UNACCEPTED_TASK_SCEN T-03: SCEN-CAP-01 is claimed but no acceptance row lists T-03$/m);
});

test('structural result: blocking rejects with non-zero, advisories keep exit 0 and stay separate', () => {
  const templates = path.join(root, 'openspec-schema', 'templates');
  const readTemplate = (name) => fs.readFileSync(path.join(templates, name), 'utf8');
  // The real scaffold yields an advisory (its DAG sink writes only tests) with zero blocking; exit
  // stays 0 and the two arrays are disjoint, so a caller must read `blocking`, not output presence.
  const tasks = readTemplate('tasks.md')
    .replaceAll('path/to/file.mjs', 'src/app.mjs')
    .replaceAll('path/to/file.test.mjs', 'test/app.test.mjs')
    .replaceAll('path/to/a.mjs', 'src/api.mjs')
    .replaceAll('path/to/a.test.mjs', 'test/api.test.mjs')
    // The second task is the DAG sink and is test-only, which freeze-check reports as an advisory.
    .replace('  - Write scope: src/api.mjs, test/api.test.mjs', '  - Write scope: test/api.test.mjs')
    .replace('  - Review: standard', '  - Review: mechanical')
    .replace('  - Verify with: node --test test/api.test.mjs', '  - Verify with: npm test');
  const acceptance = readTemplate('acceptance.md')
    .replace('| `<跑一遍该入口的命令或步骤>` |', '| node --test test/app.test.mjs |')
    .replace('| `<命令或步骤>` |', '| node --test test/api.test.mjs |');
  const base = {
    'proposal.md': readTemplate('proposal.md'),
    'specs/cap/spec.md': '## ADDED Requirements\n\n### Scenario: SCEN-CAP-01 the app starts\n\nWHEN invoked\nTHEN it runs\n- **Verify:** node --test test/app.test.mjs\n\n### Scenario: SCEN-CAP-02 the api answers\n\nWHEN called\nTHEN it answers\n- **Verify:** node --test test/api.test.mjs\n',
    'tasks.md': tasks,
    'acceptance.md': acceptance,
  };
  const clean = run(change(base), ['--structural', '--skip-signer-check']);
  assert.equal(clean.status, 0, clean.stderr);
  const report = JSON.parse(clean.stdout);
  assert.deepEqual(report.blocking, []);
  assert.ok(report.advisories.length > 0, 'fixture must produce at least one advisory');
  for (const advisory of report.advisories) assert.ok(!report.blocking.includes(advisory));
  // A real block in the same shape flips the process status without throwing away the JSON.
  const blocked = run(change({ ...base, 'acceptance.md': acceptance.replace(/\| SCEN-CAP-02[^\n]*\n/, '') }), ['--structural', '--skip-signer-check']);
  assert.equal(blocked.status, 1);
  assert.ok(JSON.parse(blocked.stdout).blocking.length > 0);
});

// ---- staged specs check: --structural --stage specs ----
// A change that has specs but no tasks.md yet. `runStage` passes the stage flags explicitly; a
// passing case must not be what the full run happens to allow.
const runStage = (dir, extra = []) => run(dir, ['--structural', '--skip-signer-check', '--stage', 'specs', ...extra]);
const stageReport = (result) => { try { return JSON.parse(result.stdout); } catch { return { blocking: [], advisories: [] }; } };
// `ownId` is unique per fixture because a baseline id re-declared under ADDED is a collision too;
// each test can then decide which external declaration it is exercising.
function stageRepo({
  ownSection = 'ADDED Requirements',
  ownRequirement = '收款人档案',
  ownId = 'SCEN-CAP-01',
  ownText = 'WHEN a\nTHEN b\n',
  ownTitle = 'own',
  otherTitle = 'other',
  otherSection = 'MODIFIED Requirements',
  otherRequirement = '收款人入口',
  otherId = 'SCEN-CAP-91',
  otherText = 'WHEN c\nTHEN d\n',
  baselineId = 'SCEN-CAP-81',
} = {}) {
  const dir = change({
    'proposal.md': 'x',
    'specs/cap/spec.md': `## ${ownSection}\n### Requirement: ${ownRequirement}\n#### Scenario: ${ownId} ${ownTitle}\n${ownText}- **Verify:** node --test test/cap.test.mjs\n`,
  });
  const sh = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  sh('init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(dir, 'openspec/specs/cap'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'openspec/specs/cap/spec.md'), `## Requirements\n#### Scenario: ${baselineId} baseline\n`);
  fs.mkdirSync(path.join(dir, 'openspec/changes/other/specs/cap'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'openspec/changes/other/specs/cap/spec.md'), `## ${otherSection}\n### Requirement: ${otherRequirement}\n#### Scenario: ${otherId} ${otherTitle}\n${otherText}- **Verify:** node --test test/cap.test.mjs\n`);
  return dir;
}

test('stage specs passes with specs present and no tasks.md', () => {
  const dir = stageRepo();
  const result = runStage(dir);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stderr, /tasks\.md not found/);
  const report = stageReport(runStage(dir, ['--json']));
  assert.equal(report.stage, 'specs');
  assert.deepEqual(report.blocking, []);
  assert.ok(Array.isArray(report.advisories));
});

test('stage specs blocks with the same code as the full run for another change\'s id', () => {
  // Same id, different heading text: the full run's collision classification, not a reimplementation.
  const dir = stageRepo({ ownId: 'SCEN-CAP-91' });
  const stage = runStage(dir);
  assert.equal(stage.status, 1);
  assert.match(stageReport(stage).blocking.join('\n'), /^COLLIDING_SCEN SCEN-CAP-91: already declared in openspec\/changes\/other\/specs\/cap\/spec\.md$/m);
  const human = spawnSync('node', [path.join(root, 'freeze-check.mjs'), dir, '--structural', '--skip-signer-check', '--stage', 'specs'], { encoding: 'utf8' });
  assert.equal(human.status, 1);
  assert.match(human.stdout, /RESULT specs rejected/);
});

test('stage specs allows a baseline id re-declared under MODIFIED/REMOVED Requirements, and blocks it under ADDED', () => {
  for (const section of ['MODIFIED Requirements', 'REMOVED Requirements']) {
    const dir = stageRepo({ ownSection: section, ownId: 'SCEN-CAP-81' });
    const pass = runStage(dir);
    assert.equal(pass.status, 0, `${section}: ${pass.stdout}${pass.stderr}`);
  }
  const blocked = stageRepo({ ownSection: 'ADDED Requirements', ownId: 'SCEN-CAP-81' });
  const fail = runStage(blocked);
  assert.equal(fail.status, 1);
  assert.match(stageReport(fail).blocking.join('\n'), /^COLLIDING_SCEN SCEN-CAP-81: already declared in openspec\/specs\/cap\/spec\.md$/m);
});

test('stage specs keeps an identical body from another change advisory-only', () => {
  const dir = stageRepo({ ownSection: 'MODIFIED Requirements', ownId: 'SCEN-CAP-91', ownRequirement: '收款人入口', ownTitle: 'shared', otherTitle: 'shared', otherRequirement: '收款人入口', otherText: 'WHEN c\nTHEN d\n', ownText: 'WHEN c\nTHEN d\n' });
  const result = runStage(dir);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = stageReport(result);
  assert.match(report.advisories.join('\n'), /^ADVISORY_SHARED_SCEN SCEN-CAP-91: openspec\/changes\/other\/specs\/cap\/spec\.md declares the same scenario text/m);
  assert.deepEqual(report.blocking, []);
});

test('stage specs blocks duplicate ids inside this change', () => {
  const dir = stageRepo();
  fs.mkdirSync(path.join(dir, 'specs/other'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'specs/other/spec.md'), '## ADDED Requirements\n#### Scenario: SCEN-CAP-01 second declaration\n');
  const result = runStage(dir);
  assert.equal(result.status, 1);
  assert.match(stageReport(result).blocking.join('\n'), /^DUPLICATE_SCEN SCEN-CAP-01: declared in specs\/cap\/spec\.md and specs\/other\/spec\.md$/m);
});

test('stage specs blocks a specs tree with no scenario at all', () => {
  const dir = change({ 'proposal.md': 'x', 'specs/cap/spec.md': '## ADDED Requirements\n### Requirement: no scenarios here\n\nWHEN x\nTHEN y\n' });
  const result = runStage(dir);
  assert.equal(result.status, 1);
  assert.match(stageReport(result).blocking.join('\n'), /^NO_SPEC_SCEN: specs\/ declares no SCEN scenario/m);
  // The full run still fails on its own terms (tasks.md absent); NO_SPEC_SCEN is stage-only.
  const full = run(change({ 'proposal.md': 'x', 'specs/cap/spec.md': '## ADDED Requirements\n### Requirement: r\n' }), ['--structural', '--skip-signer-check']);
  assert.equal(full.status, 1);
  assert.doesNotMatch(full.stdout, /NO_SPEC_SCEN/);
});

test('ADVISORY_REQ_OVERLAP names a requirement both this and another change modify/remove, and stays exit 0', () => {
  const dir = stageRepo({ ownSection: 'MODIFIED Requirements', ownRequirement: '收款人名录与报销单双向数据沉淀', ownId: 'SCEN-CAP-02', otherSection: 'REMOVED Requirements', otherRequirement: '收款人名录与报销单双向数据沉淀', otherId: 'SCEN-CAP-92' });
  const result = runStage(dir);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = stageReport(result);
  assert.deepEqual(report.blocking, []);
  assert.match(report.advisories.join('\n'), /^ADVISORY_REQ_OVERLAP 收款人名录与报销单双向数据沉淀: this change MODIFIED it, and other also REMOVED it$/m);
  // Before F-1 the full run never emitted this. It now must, for the same package the staged run
  // judged: the two rules are one helper each, not two implementations (SCEN-FULL-02).
  const fullDir = fullRepo({ scen: 'SCEN-CAP-02', ownSection: 'MODIFIED Requirements', ownRequirement: '收款人名录与报销单双向数据沉淀', otherSection: 'REMOVED Requirements', otherRequirement: '收款人名录与报销单双向数据沉淀', otherId: 'SCEN-CAP-92' });
  const full = run(fullDir, ['--structural', '--skip-signer-check']);
  assert.match(stageReport(full).advisories.join('\n'), /^ADVISORY_REQ_OVERLAP 收款人名录与报销单双向数据沉淀: this change MODIFIED it, and other also REMOVED it$/m);
  // The unrelated package still does not emit it, so the rule is about the overlap, not a blanket line.
  const unrelated = run(change({ 'tasks.md': contract, 'proposal.md': 'x', 'design.md': design, 'acceptance.md': 'x', 'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n' }), ['--structural', '--skip-signer-check']);
  assert.doesNotMatch(stageReport(unrelated).advisories.join('\n'), /ADVISORY_REQ_OVERLAP/);
});

// ---- full run parity with the staged specs rules (F-1) ----
// `stageRepo` plus the artifacts the full run needs; the spec is the same file the staged run reads.
function fullRepo({ scen = 'SCEN-CAP-01', verify = true, ...overrides } = {}) {
  const dir = stageRepo({ ownId: scen, ...overrides });
  if (!verify) {
    // Drop the Verify line `stageRepo` writes, leaving the scenario exactly as declared.
    const file = path.join(dir, 'specs/cap/spec.md');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^- \*\*Verify:\*\*.*\n/m, ''));
  }
  fs.writeFileSync(path.join(dir, 'tasks.md'), `- [ ] 1.1 T-01 sink
  - Write scope: src/app.mjs,test/sink.test.mjs
  - Verify with: npm test
  - Scen: ${scen}
`);
  fs.writeFileSync(path.join(dir, 'design.md'), design);
  fs.writeFileSync(path.join(dir, 'acceptance.md'), table(`| ${scen} | CLI | T-01 | node --test test/shared.test.mjs | yes | PENDING | pending |`));
  const sh = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  sh('add', '-A');
  sh('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'fixture');
  return dir;
}

test('SCEN-FULL-01 pure-behavior specs without Verify pass both staged and full runs (ADR-0006)', () => {
  const dir = fullRepo({ verify: false });
  const full = run(dir, ['--structural', '--skip-signer-check']);
  assert.equal(full.status, 0, full.stdout + full.stderr);
  assert.doesNotMatch(stageReport(full).blocking.join('\n'), /MISSING_SCEN_VERIFY/);
  const stage = runStage(dir);
  assert.equal(stage.status, 0, stage.stdout + stage.stderr);
  assert.doesNotMatch(stageReport(stage).blocking.join('\n'), /MISSING_SCEN_VERIFY/);
  // Legacy specs with inline - **Verify:** also remain green in both modes.
  for (const flags of [['--structural', '--skip-signer-check'], ['--structural', '--skip-signer-check', '--stage', 'specs']]) {
    const ok = run(fullRepo(), flags);
    assert.equal(ok.status, 0, `${flags.join(' ')}: ${ok.stdout}${ok.stderr}`);
  }
});

test('--stage is valid only with --structural and the value specs; anything else is a usage error', () => {
  const dir = stageRepo();
  const check = spawnSync('node', [path.join(root, 'freeze-check.mjs'), dir, '--stage', 'specs'], { encoding: 'utf8' });
  assert.equal(check.status, 2, check.stdout + check.stderr);
  for (const args of [['--structural', '--stage', 'tasks'], ['--structural', '--stage'], ['--structural', '--stage', '--json']]) {
    const result = spawnSync('node', [path.join(root, 'freeze-check.mjs'), dir, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 2, args.join(' '));
    assert.match(result.stderr, /Usage:/);
  }
});

test('the full run without --stage is byte-identical to main on a complete package', () => {
  // `test/fixtures/freeze-check-golden.json` was captured by running the base revision's
  // freeze-check.mjs against this exact fixture; regenerate it only when main's output changes
  // deliberately. This pins "existing modes are unchanged", not a hand-written expectation.
  const dir = change({
    'tasks.md': `- [ ] 1.1 T-01 shared
  - Write scope: src/shared,test/shared.test.mjs
  - Verify with: node --test test/shared.test.mjs
  - Scen: SCEN-1
- [ ] 1.2 T-02 sink
  - Depends on: T-01
  - Write scope: src/app.mjs,test/sink.test.mjs
  - Verify with: npm test
  - Scen: SCEN-1,SCEN-2
`,
    'proposal.md': 'x\n',
    'acceptance.md': table('| SCEN-1 | CLI | T-01,T-02 | node --test test/shared.test.mjs | yes | PENDING | pending |\n| SCEN-2 | CLI | T-02 | node -e "0" | no | PENDING | pending |'),
    'specs/cap/spec.md': '## ADDED Requirements\n### Requirement: Added one\n#### Scenario: SCEN-1 one\nWHEN a\nTHEN b\n- **Verify:** node --test test/sink.test.mjs\n',
    'specs/other/spec.md': '## MODIFIED Requirements\n### Requirement: Changed\n#### Scenario: SCEN-2 two\nWHEN c\nTHEN d\n- **Verify:** node --test test/sink.test.mjs\n',
  });
  const sh = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  sh('init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(dir, 'openspec/specs/cap'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'openspec/specs/cap/spec.md'), '## Requirements\n### Scenario: SCEN-9 base\n');
  fs.mkdirSync(path.join(dir, 'openspec/changes/other/specs/cap'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'openspec/changes/other/specs/cap/spec.md'), '## MODIFIED Requirements\n### Requirement: Added one\n#### Scenario: SCEN-3 foreign\n');
  const golden = JSON.parse(fs.readFileSync(path.join(root, 'test/fixtures/freeze-check-golden.json'), 'utf8'));
  for (const flags of [[], ['--json'], ['--structural', '--skip-signer-check'], ['--strict', '--json']]) {
    // Raw flags, not `run`: the golden includes the human (non-JSON) mode too.
    const result = spawnSync('node', [path.join(root, 'freeze-check.mjs'), dir, ...flags], { encoding: 'utf8' });
    const rendered = {
      status: result.status,
      stdout: result.stdout.split(dir).join('<dir>'),
      stderr: result.stderr.split(dir).join('<dir>'),
    };
    assert.deepEqual(rendered, golden[flags.join(' ') || '(none)'], flags.join(' ') || '(none)');
  }
});

// ---- unreadable external specs and repeated --stage ----
// An unreadable baseline or other-change spec must not be scanned as an empty declaration set.
// Base freeze-check threw on it (exit 1); the fix must keep that outcome, so the base script is
// the oracle here, not a hand-written expectation. The base script imports ./lib/*, so the whole
// base `skills/paseo-pipeline` tree is extracted and run from its own directory; a lone script file
// cannot resolve those imports and would fail for the wrong reason.
function baseFreezeCheck() {
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'freeze-base-'));
  // `root` is the skill directory, not the repo root, and `git archive` resolves its pathspec from
  // the repository root, so ask git where that is first.
  const toplevel = execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const archive = execFileSync('git', ['-C', toplevel, 'archive', 'ab13b9d', 'skills/paseo-pipeline'], { maxBuffer: 64 << 20 });
  execFileSync('tar', ['-x', '-C', tree], { input: archive });
  return path.join(tree, 'skills', 'paseo-pipeline', 'freeze-check.mjs');
}
// `where` selects which scanned input is broken: a dangling link in a baseline spec, a dangling
// link in another change's spec, or a baseline directory that cannot be listed.
function unreadableFixture(where) {
  const dir = change({
    'tasks.md': contract,
    'proposal.md': 'x',
    'design.md': design,
    'acceptance.md': table('| SCEN-1 | CLI | T-01,T-02 | node --test test/shared.test.mjs | yes | PENDING | pending |'),
    'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n',
  });
  const sh = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  sh('init', '-q', '-b', 'main');
  if (where === 'dir') {
    const locked = path.join(dir, 'openspec/specs/locked');
    fs.mkdirSync(locked, { recursive: true });
    fs.writeFileSync(path.join(locked, 'spec.md'), '## Requirements\n#### Scenario: SCEN-7 locked\n');
    fs.chmodSync(locked, 0o000);
    return { dir, locked };
  }
  const dirOf = where === 'baseline' ? path.join(dir, 'openspec/specs/cap') : path.join(dir, 'openspec/changes/other/specs/cap');
  fs.mkdirSync(dirOf, { recursive: true });
  fs.writeFileSync(path.join(dirOf, 'spec.md'), '## ADDED Requirements\n#### Scenario: SCEN-8 foreign\n');
  fs.symlinkSync(path.join(dir, 'missing-target.md'), path.join(dirOf, 'dangling.md'));
  return { dir, locked: null };
}

test('an unreadable baseline or other-change spec keeps base behavior (exit 1) and never scans as empty', () => {
  const base = baseFreezeCheck();
  for (const where of ['baseline', 'other']) {
    const { dir } = unreadableFixture(where);
    const baseRun = spawnSync('node', [base, dir, '--structural', '--skip-signer-check'], { encoding: 'utf8' });
    const tipRun = spawnSync('node', [path.join(root, 'freeze-check.mjs'), dir, '--structural', '--skip-signer-check'], { encoding: 'utf8' });
    // The real base tree is the oracle: it fails with an uncaught TypeError on the dangling link.
    assert.equal(baseRun.status, 1, `${where}: base must fail loudly: ${baseRun.stderr}`);
    assert.equal(tipRun.status, baseRun.status, `${where}: same exit code as base`);
    assert.notEqual(tipRun.stdout.includes('RESULT freeze ok'), true, `${where}: never a pass`);
    assert.match(tipRun.stderr, /unreadable spec .*dangling\.md/, where);
    // Stage mode is not a weaker pass either.
    const stage = spawnSync('node', [path.join(root, 'freeze-check.mjs'), dir, '--structural', '--skip-signer-check', '--stage', 'specs'], { encoding: 'utf8' });
    assert.equal(stage.status, 1, `${where}: stage specs must not pass`);
    assert.doesNotMatch(stage.stdout, /RESULT specs ok/);
  }
});

// Both run modes must keep the normal JSON object on stdout when a scanned input is unreadable.
// Base printed nothing at all under --json (the uncaught TypeError escaped), so an empty stdout here
// is the regression this pins; `stage` and `blocking[UNREADABLE_SPEC]` are the contract.
test('an unreadable scanned input is a blocking UNREADABLE_SPEC in JSON, never empty stdout', () => {
  const expectBlock = (where, result) => {
    assert.equal(result.status, 1, `${where}: ${result.stdout}${result.stderr}`);
    let report;
    try { report = JSON.parse(result.stdout); }
    catch { assert.fail(`${where}: stdout is not JSON: ${JSON.stringify(result.stdout.slice(0, 200))}`); }
    assert.ok(report.blocking.some((item) => item.startsWith('UNREADABLE_SPEC ')), `${where}: ${report.blocking.join(' | ')}`);
    return report;
  };
  for (const where of ['baseline', 'other', 'dir']) {
    const { dir, locked } = unreadableFixture(where);
    try {
      // Stage mode: specs exist, tasks.md does not need to (it does here, which must not matter).
      const stage = expectBlock(`${where} stage`, run(dir, ['--structural', '--skip-signer-check', '--stage', 'specs']));
      assert.equal(stage.stage, 'specs');
      assert.ok(stage.blocking.some((item) => /UNREADABLE_SPEC .*(dangling\.md|locked\/):/.test(item)), where);
      // Full mode: the same input is still reported as a block, not silently skipped.
      const full = expectBlock(`${where} full`, run(dir, ['--structural', '--skip-signer-check']));
      assert.equal(full.stage, undefined);
      assert.ok(full.blocking.some((item) => /UNREADABLE_SPEC .*(dangling\.md|locked\/):/.test(item)), where);
      // Non-JSON mode stays readable and nonzero.
      const human = spawnSync('node', [path.join(root, 'freeze-check.mjs'), dir, '--structural', '--skip-signer-check', '--stage', 'specs'], { encoding: 'utf8' });
      assert.equal(human.status, 1, where);
      assert.match(human.stderr, /unreadable spec/, where);
      assert.doesNotMatch(human.stdout, /RESULT specs ok/, where);
    } finally {
      if (locked) fs.chmodSync(locked, 0o755);
    }
  }
});

test('--stage alone is not the last arg and repeated --stage is a usage error', () => {
  const dir = stageRepo();
  const script = path.join(root, 'freeze-check.mjs');
  const cases = [
    ['--structural', '--stage', 'specs', '--stage', 'tasks'],
    ['--structural', '--stage', 'specs', '--stage', 'specs'],
    ['--structural', '--stage'],
    ['--stage', 'specs'],
  ];
  for (const args of cases) {
    const result = spawnSync('node', [script, dir, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 2, args.join(' '));
    assert.match(result.stderr, /Usage:/, args.join(' '));
  }
});

test('invalid acceptance diagnostics keep base order and spelling, not a grouped or uppercased variant', () => {
  // The shared acceptance reader must not reorder diagnostics or normalise the spelling the
  // author sees: base walked the table line by line and echoed the SCEN id as written. The base
  // tree is the oracle for both, because the reviewer compared its output with the tip's.
  const base = baseFreezeCheck();
  const tasks = `- [ ] 1.1 T-01 shared
  - Write scope: src/shared,test/shared.test.mjs
  - Verify with: node --test test/shared.test.mjs
  - Scen: SCEN-1
`;
  const cases = {
    // A valid-looking row followed by a short one: grouping malformed rows first would flip them.
    'required error before malformed row': table([
      '| SCEN-1 | CLI | T-01 | node -e "0" | maybe | PENDING | pending |',
      '| SCEN-1 | CLI | T-01 | node -e "0" |',
    ].join('\n')),
    // Mixed case ids: messages must echo the row's own spelling, keys stay case-insensitive.
    'mixed-case scenario ids': table([
      '| SCEN-1 | CLI | T-01 | node -e "0" | maybe | PENDING | pending |',
      '| SCEN-aB | CLI | T-01 | node -e "0" | maybe | PENDING | pending |',
    ].join('\n')),
    'tasks token in mixed case': table([
      '| SCEN-1 | CLI | t-99 | node --test test/shared.test.mjs | yes | PENDING | pending |',
      '| SCEN-1 | CLI | T-01 | node -e "0" |',
    ].join('\n')),
  };
  for (const [name, acceptanceMarkdown] of Object.entries(cases)) {
    const dir = change({
      'tasks.md': tasks, 'proposal.md': 'x', 'acceptance.md': acceptanceMarkdown, 'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n',
    });
    const render = (script) => {
      const result = spawnSync('node', [script, dir, '--json', '--skip-signer-check'], { encoding: 'utf8' });
      const report = JSON.parse(result.stdout);
      return {
        status: result.status,
        blocking: report.blocking.map((item) => item.split(dir).join('<dir>').replace(/run (?:hanlin|anchasi) R0 review/, 'run <r0> R0 review')),
      };
    };
    const oracle = render(base);
    assert.deepEqual(render(path.join(root, 'freeze-check.mjs')), oracle, name);
  }
});

test('short acceptance headers preserve base JSON diagnostics and never crash', () => {
  const base = baseFreezeCheck();
  const tasks = '- [ ] 1.1 T-01 shared\n  - Write scope: src/shared,test/shared.test.mjs\n  - Verify with: node --test test/shared.test.mjs\n  - Scen: SCEN-X\n';
  const headers = [
    '| Scenario |',
    '| Scenario | Entry |',
    '| Scenario | Entry | Tasks |',
    '| Scenario | Entry | Tasks | Verify |',
    '| Scenario | Entry | Tasks | Verify | Required |',
    '| Scenario | Entry | Tasks | Verify | Required | Result |',
    '| Scenario | Entry | Tasks | Verify | Required | Result | Evidence | Extra |',
  ];
  const rows = headers.map((header, index) => {
    const width = header.split('|').length - 2;
    const cells = ['SCEN-X', 'x', 'T-01', 'node --test test/shared.test.mjs', 'yes', 'PENDING', 'pending', 'extra'].slice(0, width);
    return [header, `| ${Array(width).fill('---').join(' | ')} |`, `| ${cells.join(' | ')} |`].join('\n');
  });
  rows.push('| Scenario | Entry |\n| --- | --- |\n| SCEN-X | x |');
  rows.push('| SCEN-X |'); // SCEN-id only, no recognized header
  for (const [index, acceptance] of rows.entries()) {
    const dir = change({ 'tasks.md': tasks, 'proposal.md': 'x', 'acceptance.md': acceptance, 'specs/a/spec.md': '### Scenario: SCEN-X\n- **Verify:** node --test test/shared.test.mjs\n' });
    const invoke = (script) => {
      const result = spawnSync('node', [script, dir, '--json', '--structural', '--skip-signer-check'], { encoding: 'utf8' });
      return { status: result.status, stdout: result.stdout.replace(dir, '<dir>'), stderr: result.stderr.replace(dir, '<dir>') };
    };
    assert.deepEqual(invoke(path.join(root, 'freeze-check.mjs')), invoke(base), `case ${index + 1}`);
  }
});

function freezeCheckAtD4Base() {
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'freeze-d4-base-'));
  const toplevel = execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const archive = execFileSync('git', ['-C', toplevel, 'archive', '9b82233a7aca1868035cf8221a448c10a13228a1', 'skills/paseo-pipeline'], { maxBuffer: 64 << 20 });
  execFileSync('tar', ['-x', '-C', tree], { input: archive });
  return path.join(tree, 'skills', 'paseo-pipeline', 'freeze-check.mjs');
}

test('short and malformed acceptance tables match D4 base JSON output without throwing', () => {
  const base = freezeCheckAtD4Base();
  const tasks = '- [ ] 1.1 T-01 shared\n  - Write scope: src/shared,test/shared.test.mjs\n  - Verify with: node --test test/shared.test.mjs\n  - Scen: SCEN-X\n';
  const headers = [
    '| Scenario |',
    '| Scenario | Entry |',
    '| Scenario | Entry | Tasks |',
    '| Scenario | Entry | Tasks | Verify |',
    '| Scenario | Entry | Tasks | Verify | Required |',
    '| Scenario | Entry | Tasks | Verify | Required | Result |',
    '| Scenario | Entry | Tasks | Verify | Required | Result | Evidence | Extra |',
  ];
  const cases = headers.map((header) => {
    const width = header.split('|').length - 2;
    const cells = ['SCEN-X', 'x', 'T-01', 'node --test test/shared.test.mjs', 'yes', 'PENDING', 'pending', 'extra'].slice(0, width);
    return `${header}\n| ${Array(width).fill('---').join(' | ')} |\n| ${cells.join(' | ')} |`;
  });
  cases.push('| Scenario | Entry |\n| --- | --- |\n| SCEN-X | x |');
  cases.push('| SCEN-X |');
  for (const [index, acceptanceMarkdown] of cases.entries()) {
    const dir = change({ 'tasks.md': tasks, 'proposal.md': 'x', 'acceptance.md': acceptanceMarkdown, 'specs/a/spec.md': '### Scenario: SCEN-X\n- **Verify:** node --test test/shared.test.mjs\n' });
    const runJson = (script) => {
      const result = spawnSync('node', [script, dir, '--json', '--structural', '--skip-signer-check'], { encoding: 'utf8' });
      assert.doesNotMatch(result.stderr, /TypeError|ReferenceError|SyntaxError/, `case ${index + 1}: ${result.stderr}`);
      assert.doesNotThrow(() => JSON.parse(result.stdout), `case ${index + 1}: ${result.stdout} ${result.stderr}`);
      return { status: result.status, stdout: result.stdout.replace(dir, '<dir>'), stderr: result.stderr.replace(dir, '<dir>') };
    };
    assert.deepEqual(runJson(path.join(root, 'freeze-check.mjs')), runJson(base), `case ${index + 1}`);
  }
});

// ---- design decisions declare the modules they touch: every declared path needs a writer ----
// D9 shape: D-03 named the payee route as affected, no task claimed it, and R0 found a live
// 越权 read path with no owner. The advisory points at the decision; it never blocks.
const affectsRun = (designMarkdown, scope = 'src/shared,test/t-01.test.mjs') => run(change({
  'tasks.md': entryTask('T-01', { scope, scen: 'SCEN-1' }),
  'proposal.md': 'x',
  'design.md': designMarkdown,
  'review.md': REVIEW,
  'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n',
  'acceptance.md': table('| SCEN-1 | CLI | T-01 | node --test test/shared.test.mjs | yes | PENDING | pending |'),
}));

test('ADVISORY_DECISION_UNOWNED: a module named in design.md but written by no task is advised', () => {
  const result = affectsRun('## Decisions\n- **D-01 lease state** 影响模块/路径: src/shared/lease.ts, src/routes/payees.ts\n');
  assert.equal(result.status, 0, result.stdout);
  const advisories = JSON.parse(result.stdout).advisories;
  const hits = advisories.filter((item) => item.startsWith('ADVISORY_DECISION_UNOWNED'));
  assert.equal(hits.length, 1, advisories.join('\n'));
  assert.match(hits[0], /^ADVISORY_DECISION_UNOWNED D-01 design\.md: "src\/routes\/payees\.ts" is named as affected/);
});

test('ADVISORY_DECISION_UNOWNED: inline-code paths have the same ownership result as bare paths', () => {
  for (const wrap of [(value) => value, (value) => `\`${value}\``]) {
    const result = affectsRun(`## Decisions\n- **D-01 lease state** 影响模块/路径: ${wrap('src/shared/lease.ts')}, ${wrap('src/routes/payees.ts')}\n`);
    assert.equal(result.status, 0, result.stdout);
    const hits = JSON.parse(result.stdout).advisories.filter((item) => item.startsWith('ADVISORY_DECISION_UNOWNED'));
    assert.equal(hits.length, 1, result.stdout);
    assert.match(hits[0], /"src\/routes\/payees\.ts" is named as affected/);
  }
});

test('ADVISORY_DECISION_UNOWNED: a directory decision is covered by any task writing inside it', () => {
  const result = affectsRun('## Decisions\n- **D-01 components** 影响模块/路径: packages/web/src/form/ticket/\n', 'packages/web/src/form/ticket/Panel.tsx,test/t-01.test.mjs');
  assert.equal(result.status, 0, result.stdout);
  assert.doesNotMatch(JSON.parse(result.stdout).advisories.join('\n'), /ADVISORY_DECISION_UNOWNED/);
});

test('ADVISORY_DECISION_UNOWNED: a decision declaring no affected path stays silent', () => {
  const result = affectsRun('## Decisions\n- **D-01 pure behavior** no file is touched by this rule\n');
  assert.equal(result.status, 0, result.stdout);
  assert.doesNotMatch(JSON.parse(result.stdout).advisories.join('\n'), /ADVISORY_DECISION_UNOWNED/);
});


test('a referenced open hard decision blocks routing', () => {
  const proposal = '## OPEN-DECISION\n- **OD-1 billing provider**: options A | B; consequences A costs more, B delays launch; Class: money; Status: open\n';
  const tasks = contract.replace('  - Scen: SCEN-1\n', '  - Scen: SCEN-1\n  - Decision: OD-1\n');
  const dir = change({
    'tasks.md': tasks,
    'proposal.md': proposal,
    'design.md': design,
    'acceptance.md': table('| SCEN-1 | CLI | T-01,T-02,T-03,T-04 | node --test test/shared.test.mjs | yes | PENDING | pending |'),
    'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n',
    'review.md': REVIEW,
  });
  const result = run(dir, ['--structural', '--skip-signer-check']);
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.route, null);
  assert.ok(report.blocking.some((item) => item.startsWith('UNDECIDED_HARD_DECISION OD-1:')));
  assert.doesNotMatch(report.advisories.join('\n'), /ADVISORY_OPEN_DECISION/);
});

test('decided, unreferenced and product decisions do not lose the graph route', () => {
  const cases = [
    ['decided hard', '## OPEN-DECISION\n- **OD-1 billing provider**: options A | B; consequences A costs more, B delays launch; Class: money; Decided: user chose B, 2026-11-19\n', '  - Decision: OD-1\n'],
    ['unreferenced hard', '## OPEN-DECISION\n- **OD-1 billing provider**: options A | B; consequences A costs more, B delays launch; Class: money; Status: open\n', ''],
    ['referenced product', '## OPEN-DECISION\n- **OD-1 label wording**: options A | B; consequences different clarity; Class: product; Status: open\n', '  - Decision: OD-1\n'],
  ];
  for (const [name, proposal, decisionLine] of cases) {
    const tasks = contract.replace('  - Scen: SCEN-1\n', `  - Scen: SCEN-1\n${decisionLine}`);
    const dir = change({
      'tasks.md': tasks,
      'proposal.md': proposal,
      'design.md': design,
      'acceptance.md': table('| SCEN-1 | CLI | T-01,T-02,T-03,T-04 | node --test test/shared.test.mjs | yes | PENDING | pending |'),
      'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n',
      'review.md': REVIEW,
    });
    const result = run(dir, ['--structural', '--skip-signer-check']);
    assert.equal(result.status, 0, `${name}: ${result.stdout}`);
    const report = JSON.parse(result.stdout);
    assert.equal(report.route, 'handoff', name);
    assert.doesNotMatch(report.blocking.join('\n'), /UNDECIDED_HARD_DECISION/, name);
    if (name === 'decided hard') assert.doesNotMatch(report.advisories.join('\n'), /ADVISORY_OPEN_DECISION OD-1/, name);
    else assert.match(report.advisories.join('\n'), /ADVISORY_OPEN_DECISION OD-1/, name);
  }
});


test('a referenced open decision missing Class counts as hard', () => {
  const proposal = '## OPEN-DECISION\n- **OD-1 billing provider**: options A | B; consequences A costs more, B delays launch; Status: open\n';
  const tasks = contract.replace('  - Scen: SCEN-1\n', '  - Scen: SCEN-1\n  - Decision: OD-1\n');
  const dir = change({
    'tasks.md': tasks,
    'proposal.md': proposal,
    'design.md': design,
    'acceptance.md': table('| SCEN-1 | CLI | T-01,T-02,T-03,T-04 | node --test test/shared.test.mjs | yes | PENDING | pending |'),
    'specs/a/spec.md': '### Scenario: SCEN-1\n- **Verify:** node --test test/shared.test.mjs\n',
    'review.md': REVIEW,
  });
  const result = run(dir, ['--structural', '--skip-signer-check']);
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.route, null);
  assert.ok(report.blocking.some((item) => item.startsWith('UNDECIDED_HARD_DECISION OD-1:')));
});


test('unmarked D10 decision referenced in requirement text blocks routing', () => {
  const fixture = path.join(root, 'test', 'fixtures', 'd10-open-decision');
  const files = Object.fromEntries(fs.readdirSync(fixture, { recursive: true })
    .filter((file) => fs.statSync(path.join(fixture, file)).isFile())
    .map((file) => [file, fs.readFileSync(path.join(fixture, file), 'utf8')]));
  const dir = change(files);
  const result = run(dir, ['--structural', '--skip-signer-check']);
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.route, null);
  assert.ok(report.blocking.some((item) => item.startsWith('UNDECIDED_HARD_DECISION OD-2:')), result.stdout);
});

// ---- staged specs check: undecided hard decisions gate the first package ----
// The D10 first package is proposal + specs with no tasks.md, so the staged branch is the only
// check that can run. It must apply the same OPEN-DECISION rule the full run applies.
test('stage specs blocks the D10 first package while its referenced hard decisions are open', () => {
  const fixture = path.join(root, 'test', 'fixtures', 'd10-first-package');
  const result = runStage(fixture);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const blocking = stageReport(result).blocking;
  const hard = blocking.filter((item) => item.startsWith('UNDECIDED_HARD_DECISION OD-'));
  assert.ok(hard.length > 0, blocking.join(' | '));
  assert.doesNotMatch(result.stdout, /RESULT specs ok/);
});

test('stage specs: a decided, unreferenced or product-class decision does not block', () => {
  const spec = '## ADDED Requirements\n### Requirement: r\n#### Scenario: SCEN-CAP-01 own\nWHEN a\nTHEN b\n- **Verify:** node --test test/cap.test.mjs\n';
  const cases = [
    ['decided hard', '## OPEN-DECISION\n- **OD-1 billing provider**: options A | B; Class: money; Decided: user chose B, 2026-11-19\n', false],
    ['unreferenced hard', '## OPEN-DECISION\n- **OD-1 billing provider**: options A | B; Class: money; Status: open\n', true],
    ['referenced product', '## OPEN-DECISION\n- **OD-1 label wording**: options A | B; Class: product; Status: open\n', true],
  ];
  for (const [name, proposal, advisory] of cases) {
    // "Referenced" means the id appears in this change's spec text; each case names or omits OD-1.
    const ownSpec = name === 'unreferenced hard' ? spec : spec.replace('WHEN a', 'WHEN a (OD-1)');
    const dir = change({ 'proposal.md': proposal, 'specs/cap/spec.md': ownSpec });
    const result = runStage(dir);
    assert.equal(result.status, 0, `${name}: ${result.stdout}${result.stderr}`);
    const report = stageReport(result);
    assert.doesNotMatch(report.blocking.join('\n'), /UNDECIDED_HARD_DECISION/, name);
    if (advisory) assert.match(report.advisories.join('\n'), /ADVISORY_OPEN_DECISION OD-1/, name);
  }
});

// ---- staged specs check: pure observable specs without inline Verify pass --stage specs ----
test('stage specs allows pure-behavior scenarios without Verify lines (ADR-0006)', () => {
  const without = '## ADDED Requirements\n### Requirement: r\n#### Scenario: SCEN-CAP-01 own\nWHEN a\nTHEN b\n';
  const dir = change({ 'proposal.md': 'x', 'specs/cap/spec.md': without });
  const result = runStage(dir);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(stageReport(result).blocking.join('\n'), /MISSING_SCEN_VERIFY/);
  const multi = '## ADDED Requirements\n### Requirement: r\n#### Scenario: SCEN-CAP-01 own\nWHEN a\nTHEN b\n### Requirement: r2\n#### Scenario: SCEN-CAP-02 two\nWHEN c\nTHEN d\n';
  const okMulti = runStage(change({ 'proposal.md': 'x', 'specs/cap/spec.md': multi }));
  assert.equal(okMulti.status, 0, okMulti.stdout);
  assert.doesNotMatch(stageReport(okMulti).blocking.join('\n'), /MISSING_SCEN_VERIFY/);
});

test('stage specs passes when every scenario carries one Verify line', () => {
  const spec = '## ADDED Requirements\n### Requirement: r\n#### Scenario: SCEN-CAP-01 own\nWHEN a\nTHEN b\n- **Verify:** node --test test/cap.test.mjs\n';
  const result = runStage(change({ 'proposal.md': 'x', 'specs/cap/spec.md': spec }));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(stageReport(result).blocking.join('\n'), /MISSING_SCEN_VERIFY/);
});

test('R0 human-accept: bulleted R0-<round>-<n> entries in rulings.md satisfy R0_HUMAN_EXCEPTION_UNRULED', () => {
  const { dir, sha } = signedRepo((s) => `R0: human-accept(@${s})\n`);
  fs.writeFileSync(path.join(dir, 'run-log.md'), `Approval: R0 residual risk accepted for ${sha.slice(0, 7)} — benchmark CP-1\n`);
  fs.writeFileSync(path.join(dir, 'rulings.md'), '- R0-2-1: Accepted pure policy ordering residual.\n');
  const out = report(dir);
  assert.deepEqual(out.blocking, []);
  assert.match(out.advisories.join('\n'), /R0_HUMAN_EXCEPTION/);
  assert.doesNotMatch(out.advisories.join('\n'), /R0_HUMAN_EXCEPTION_UNRULED/);
});
