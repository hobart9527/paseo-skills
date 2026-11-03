import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mergeTaskScript = fileURLToPath(new URL('../merge-task.mjs', import.meta.url));
const freezeCheckScript = fileURLToPath(new URL('../freeze-check.mjs', import.meta.url));

const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'pipeline-tester',
  GIT_AUTHOR_EMAIL: 'tester@test.local',
  GIT_COMMITTER_NAME: 'pipeline-tester',
  GIT_COMMITTER_EMAIL: 'tester@test.local',
};
delete env.NODE_TEST_CONTEXT;

// Agent IDs and model heterogeneity definition
const CESHI_1 = '11111111-0001-4000-8000-000000000001';
const GONGBU_1 = '11111111-0002-4000-8000-000000000002';
const ANCHASI_1 = '11111111-0003-4000-8000-000000000003';
const ANCHASI_1_SHORT = '1111003';
// Independent R0 package reviewer; must differ from both authors.
const HANLIN_1 = '11111111-0004-4000-8000-000000000004';

const CESHI_2 = '22222222-0001-4000-8000-000000000001';
const GONGBU_2 = '22222222-0002-4000-8000-000000000002';
const ANCHASI_2 = '22222222-0003-4000-8000-000000000003';
const ANCHASI_2_SHORT = '2222003';

const CESHI_3 = '33333333-0001-4000-8000-000000000001';
const GONGBU_3 = '33333333-0002-4000-8000-000000000002';
const ANCHASI_3 = '33333333-0003-4000-8000-000000000003';
const ANCHASI_3_SHORT = '3333003';

const CESHI_4 = '44444444-0001-4000-8000-000000000001';
const GONGBU_4 = '44444444-0002-4000-8000-000000000002';
const ANCHASI_4 = '44444444-0003-4000-8000-000000000003';
const ANCHASI_4_SHORT = '4444003';

const AGENTS = [
  { id: CESHI_1, shortId: '1111001', provider: 'codex/gpt' },
  { id: GONGBU_1, shortId: '1111002', provider: 'claude/sonnet' },
  { id: ANCHASI_1, shortId: ANCHASI_1_SHORT, provider: 'anthropic/opus' },

  { id: CESHI_2, shortId: '2222001', provider: 'codex/gpt' },
  { id: GONGBU_2, shortId: '2222002', provider: 'claude/haiku' },
  { id: ANCHASI_2, shortId: ANCHASI_2_SHORT, provider: 'anthropic/opus' },

  { id: CESHI_3, shortId: '3333001', provider: 'codex/gpt' },
  { id: GONGBU_3, shortId: '3333002', provider: 'claude/sonnet' },
  { id: ANCHASI_3, shortId: ANCHASI_3_SHORT, provider: 'anthropic/opus' },

  { id: CESHI_4, shortId: '4444001', provider: 'codex/gpt' },
  { id: GONGBU_4, shortId: '4444002', provider: 'claude/haiku' },
  { id: ANCHASI_4, shortId: ANCHASI_4_SHORT, provider: 'anthropic/opus' },

  { id: HANLIN_1, shortId: '1111004', name: '[Pipeline] hanlin R0', provider: 'claude/cc' },
];

function setupSandbox() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'paseo-e2e-'));
  const bin = path.join(cwd, '.fake-bin');
  fs.mkdirSync(bin, { recursive: true });

  const payload = Buffer.from(JSON.stringify(AGENTS)).toString('base64');
  const fakePaseo = path.join(bin, 'paseo');
  fs.writeFileSync(fakePaseo, `#!/bin/sh
if [ "$1" = inspect ]; then
  printf '{"Id":"%s","Provider":"anthropic","Model":"opus"}' "$2"
else
  printf '%s' '${payload}' | base64 -d
fi
printf '\\n'
`);
  fs.chmodSync(fakePaseo, 0o755);

  const localEnv = { ...env, PATH: `${bin}:${process.env.PATH}` };

  const git = (...args) => {
    const r = spawnSync('git', args, { cwd, env: localEnv, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    return r.stdout.trim();
  };

  const write = (file, text) => {
    const p = path.join(cwd, file);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  };

  const runFreezeCheck = (changeDir, flags = []) => {
    const r = spawnSync('node', [freezeCheckScript, changeDir, ...flags], { cwd, env: localEnv, encoding: 'utf8' });
    return { ...r, out: `${r.stdout}${r.stderr}` };
  };

  const runMergeTask = (args, customEnv = localEnv) => {
    return spawnSync('node', [mergeTaskScript, ...args], { cwd, env: customEnv, encoding: 'utf8' });
  };

  return { cwd, localEnv, git, write, runFreezeCheck, runMergeTask };
}

test('E2E simulation: full SDD pipeline lifecycle with adversarial fault injection', async () => {
  const { cwd, localEnv, git, write, runFreezeCheck, runMergeTask } = setupSandbox();

  // 1. Initialize Git repository
  git('init', '-q', '-b', 'main');

  write('package.json', JSON.stringify({
    name: 'calc-service',
    type: 'module',
    scripts: { test: 'node --test test/*.test.mjs' },
  }, null, 2) + '\n');
  write('package-lock.json', JSON.stringify({ name: 'calc-service', lockfileVersion: 3 }, null, 2) + '\n');
  git('add', '.');
  git('commit', '-qm', 'chore: initial commit with package manifest');

  // 2. Draft OpenSpec contract for change `calc-v1`
  const change = 'calc-v1';
  const changeDir = path.join(cwd, 'openspec', 'changes', change);

  write(`openspec/changes/${change}/proposal.md`, '# Proposal: Calculator Service\nDeliver modular math service.');
  write(`openspec/changes/${change}/specs/math/spec.md`, `# Math Specification
### Scenario: SCEN-CORE base operations
Validate numeric types.
### Scenario: SCEN-ADD addition
Add numbers.
### Scenario: SCEN-MUL multiplication
Multiply numbers.
### Scenario: SCEN-INTEGRATION calculator facade
Composite arithmetic expressions.
`);

  write(`openspec/changes/${change}/design.md`, `# Design
## Impact Inventory
- T-01: affects src/core.mjs
- T-02: affects src/add.mjs
- T-03: affects src/mul.mjs
- T-04: affects src/calc.mjs
`);

  write(`openspec/changes/${change}/acceptance.md`, `# Acceptance Matrix
| Scenario | Entry | Tasks | Verify | Required | Result | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| SCEN-CORE | CLI | T-01 | node --test test/core.test.mjs | yes | PENDING | pending |
| SCEN-ADD | CLI | T-02 | node --test test/add.test.mjs | yes | PENDING | pending |
| SCEN-MUL | CLI | T-03 | node --test test/mul.test.mjs | yes | PENDING | pending |
| SCEN-INTEGRATION | CLI | T-04 | npm test | yes | PENDING | pending |
`);

  const validTasks = `# Tasks
- [ ] 1.1 T-01 core
  - Write scope: src/core.mjs,test/core.test.mjs
  - Verify with: node --test test/core.test.mjs
  - Scen: SCEN-CORE
- [ ] 2.1 T-02 add
  - Depends on: T-01
  - Write scope: src/add.mjs,test/add.test.mjs
  - Reads: src/core.mjs,src/mul.mjs
  - Verify with: node --test test/add.test.mjs
  - Scen: SCEN-ADD
- [ ] 2.2 T-03 mul
  - Depends on: T-01
  - Write scope: src/mul.mjs,test/mul.test.mjs
  - Verify with: node --test test/mul.test.mjs
  - Scen: SCEN-MUL
- [ ] 3.1 T-04 facade
  - Depends on: T-02,T-03
  - Write scope: src/calc.mjs,test/calc.test.mjs
  - Verify with: node --test test/calc.test.mjs && npm test
  - Scen: SCEN-INTEGRATION
`;

  // Gate Check 1.1: Adversarial Verify (no proof / true)
  write(`openspec/changes/${change}/tasks.md`, validTasks.replace('node --test test/add.test.mjs', 'true'));
  const fcAdversarial1 = runFreezeCheck(changeDir);
  assert.equal(fcAdversarial1.status, 1);
  assert.match(fcAdversarial1.out, /VERIFY_NOT_NARROW T-02/);

  // Gate Check 1.2: Adversarial Verify (non-sink broad full suite)
  write(`openspec/changes/${change}/tasks.md`, validTasks.replace('node --test test/add.test.mjs', 'npm test'));
  const fcAdversarial2 = runFreezeCheck(changeDir);
  assert.equal(fcAdversarial2.status, 1);
  assert.match(fcAdversarial2.out, /VERIFY_FULL_SUITE_NON_SINK T-02/);

  // Gate Check 1.3: Adversarial — R0 sign-off missing (hanlin never ran)
  write(`openspec/changes/${change}/tasks.md`, validTasks);
  const fcNoR0 = runFreezeCheck(changeDir);
  assert.equal(fcNoR0.status, 1);
  assert.match(fcNoR0.out, /MISSING_R0_SIGNOFF/);

  // Gate Check 1.3b: --structural runs before R0 exists and must not demand the sign-off
  const fcStructural = runFreezeCheck(changeDir, ['--structural']);
  assert.equal(fcStructural.status, 0, fcStructural.stdout);

  // Gate Check 1.4: contract is committed, hanlin (read-only) reviews that commit, main session records the sign-off
  git('add', 'openspec');
  git('commit', '-qm', 'docs(openspec): contract draft for calc-v1');
  const reviewedSha = git('rev-parse', '--short', 'HEAD');
  write(`openspec/changes/${change}/review.md`, `R0: pass(${HANLIN_1}@${reviewedSha})

Findings: none. Contract package is coherent; scopes disjoint; Verify narrow.
`);

  // Gate Check 1.4b: editing the contract after R0 voids the sign-off
  write(`openspec/changes/${change}/tasks.md`, `${validTasks}\n`);
  const fcStale = runFreezeCheck(changeDir);
  assert.equal(fcStale.status, 1);
  assert.match(fcStale.out, /STALE_R0_SIGNOFF/);
  git('checkout', '--', `openspec/changes/${change}/tasks.md`);

  // Gate Check 1.5: Valid Contract Freeze
  const fcValid = runFreezeCheck(changeDir, ['--json']);
  assert.equal(fcValid.status, 0, fcValid.stdout);
  const contractSummary = JSON.parse(fcValid.stdout);
  assert.equal(contractSummary.tasks, 4);
  assert.equal(contractSummary.maxWidth, 2);
  assert.equal(contractSummary.route, 'pipeline');
  assert.deepEqual(contractSummary.blocking, []);

  // 3. CP-1 Freeze on main & integration branch creation
  git('add', 'openspec');
  git('commit', '-qm', 'chore(openspec): freeze approved contract for calc-v1');
  const baseSHA = git('rev-parse', 'HEAD');

  git('switch', '-qc', `integration/${change}`);

  // ------------------------------------------------------------------------
  // 4. Task T-01: Core Module (Wave 1)
  // ------------------------------------------------------------------------
  git('switch', '-qc', `task/${change}/T-01`);
  const t1Base = baseSHA;

  // 4.1 Fault Injection: Worktree lacking dependencies (exit 36)
  // Ceshi imports a third-party package not installed in the worktree
  write('test/core.test.mjs', `import 'supertest';
import test from 'node:test';
test('dummy', () => {});
`);
  git('add', 'test/core.test.mjs');
  git('commit', '-qm', `test(T-01): red test missing deps\n\nPipeline-Role: ceshi\nPipeline-Author: ${CESHI_1}`);

  write('src/core.mjs', 'export const dummy = 1;\n');
  git('add', 'src/core.mjs');
  git('commit', '-qm', `feat(T-01): implement dummy\n\nPipeline-Role: gongbu\nPipeline-Author: ${GONGBU_1}`);

  const t1MissingTip = git('rev-parse', 'HEAD');
  git('switch', '-q', `integration/${change}`);

  const rMissingDep = runMergeTask([`task/${change}/T-01`, 'T-01', `pass(${ANCHASI_1_SHORT}@${t1MissingTip.slice(0, 7)}/${t1Base.slice(0, 7)})`]);
  assert.equal(rMissingDep.status, 36, rMissingDep.stdout + rMissingDep.stderr);
  assert.match(rMissingDep.stderr, /cannot resolve "supertest"/);
  assert.match(rMissingDep.stderr, /Install once in this worktree: npm ci/);
  assert.equal(git('status', '--porcelain'), ''); // Integration must remain clean!

  // Return to task branch and restore standard verify
  git('switch', '-q', `task/${change}/T-01`);
  git('reset', '--hard', t1Base);

  // 4.2 Fault Injection: Non-behavioral Red (SyntaxError) (exit 33)
  write('test/core.test.mjs', 'throw new SyntaxError("unexpected token");\n');
  git('add', 'test/core.test.mjs');
  git('commit', '-qm', `test(T-01): broken test\n\nPipeline-Role: ceshi\nPipeline-Author: ${CESHI_1}`);

  write('src/core.mjs', 'export function isNumber(n) { return typeof n === "number"; }\n');
  git('add', 'src/core.mjs');
  git('commit', '-qm', `feat(T-01): implement core\n\nPipeline-Role: gongbu\nPipeline-Author: ${GONGBU_1}`);

  const t1SyntaxTip = git('rev-parse', 'HEAD');
  git('switch', '-q', `integration/${change}`);

  const rSyntax = runMergeTask([`task/${change}/T-01`, 'T-01', `pass(${ANCHASI_1_SHORT}@${t1SyntaxTip.slice(0, 7)}/${t1Base.slice(0, 7)})`]);
  assert.equal(rSyntax.status, 33);
  assert.match(rSyntax.stderr, /Verify failed without a test assertion/);

  // 4.3 Fault Injection: Same agent / same model for tester & writer (exit 32)
  git('switch', '-q', `task/${change}/T-01`);
  git('reset', '--hard', t1Base);

  // Genuine Red test: static import of a module the task has yet to create.
  // This is the canonical greenfield TDD shape — merge-task accepts it as
  // behavioral Red only because the missing module sits inside Write scope.
  write('test/core.test.mjs', `import test from 'node:test';
import assert from 'node:assert/strict';
import { isNumber } from '../src/core.mjs';
test('isNumber validates numbers', () => {
  assert.equal(typeof isNumber, 'function');
  assert.equal(isNumber(100), true);
  assert.equal(isNumber('100'), false);
});
`);
  git('add', 'test/core.test.mjs');
  git('commit', '-qm', `test(T-01): red test\n\nPipeline-Role: ceshi\nPipeline-Author: ${CESHI_1}`);

  // Writer commits using SAME agent ID
  write('src/core.mjs', 'export function isNumber(n) { return typeof n === "number"; }\n');
  git('add', 'src/core.mjs');
  git('commit', '-qm', `feat(T-01): implement core\n\nPipeline-Role: gongbu\nPipeline-Author: ${CESHI_1}`);

  const t1SameAgentTip = git('rev-parse', 'HEAD');
  git('switch', '-q', `integration/${change}`);

  const rSameAgent = runMergeTask([`task/${change}/T-01`, 'T-01', `pass(${ANCHASI_1_SHORT}@${t1SameAgentTip.slice(0, 7)}/${t1Base.slice(0, 7)})`]);
  assert.equal(rSameAgent.status, 32);
  assert.match(rSameAgent.stderr, /test author and implementer must be different agents/);

  // 4.4 Legitimate T-01: Heterogeneous agents and valid Red/Green
  git('switch', '-q', `task/${change}/T-01`);
  git('reset', '--hard', 'HEAD~1'); // drop the wrong writer commit

  // Proper writer commit by GONGBU_1
  write('src/core.mjs', 'export function isNumber(n) { return typeof n === "number"; }\n');
  git('add', 'src/core.mjs');
  git('commit', '-qm', `feat(T-01): implement core\n\nPipeline-Role: gongbu\nPipeline-Author: ${GONGBU_1}`);

  const t1Tip = git('rev-parse', 'HEAD');
  git('switch', '-q', `integration/${change}`);

  // Fault Injection: Reviewer is Writer (exit 32)
  const rSelfReview = runMergeTask([`task/${change}/T-01`, 'T-01', `pass(${GONGBU_1}@${t1Tip.slice(0, 7)}/${t1Base.slice(0, 7)})`]);
  assert.equal(rSelfReview.status, 32);
  assert.match(rSelfReview.stderr, /reviewer matches a task author/);

  // Proper merge of T-01 with ANCHASI_1
  const rMergeT1 = runMergeTask([`task/${change}/T-01`, 'T-01', `pass(${ANCHASI_1_SHORT}@${t1Tip.slice(0, 7)}/${t1Base.slice(0, 7)})`]);
  assert.equal(rMergeT1.status, 0, rMergeT1.stdout + rMergeT1.stderr);
  assert.match(rMergeT1.stdout, /merged T-01/);

  const t1MergedHead = git('rev-parse', 'HEAD');

  // Verify tasks.md on integration branch
  const tasksAfterT1 = fs.readFileSync(path.join(cwd, `openspec/changes/${change}/tasks.md`), 'utf8');
  assert.match(tasksAfterT1, /\[x\] 1\.1 T-01 core\n\s+- Done: source=/);

  // ------------------------------------------------------------------------
  // 5. Concurrent Wave 2: Task T-02 (Add) and Task T-03 (Mul)
  // ------------------------------------------------------------------------
  // Both branch concurrently from T-01 merged head
  git('switch', '-qc', `task/${change}/T-02`);
  const t2Base = t1MergedHead;

  // Implement T-02 — greenfield Red via static import of the module it creates.
  write('test/add.test.mjs', `import test from 'node:test';
import assert from 'node:assert/strict';
import { isNumber } from '../src/core.mjs';
import { add } from '../src/add.mjs';

test('add numbers', async () => {
  assert.equal(typeof add, 'function');
  assert.equal(isNumber(1), true);
  assert.equal(add(2, 3), 5);

  // Cross-module invariant: if mul module exists, it must not be corrupted
  const mulMod = await import('../src/mul.mjs').catch(() => null);
  if (mulMod) {
    assert.notEqual(mulMod.status, 'corrupted');
  }
});
`);
  git('add', 'test/add.test.mjs');
  git('commit', '-qm', `test(T-02): red test for addition\n\nPipeline-Role: ceshi\nPipeline-Author: ${CESHI_2}`);

  write('src/add.mjs', 'export function add(a, b) { return a + b; }\n');
  git('add', 'src/add.mjs');
  git('commit', '-qm', `feat(T-02): implement addition\n\nPipeline-Role: gongbu\nPipeline-Author: ${GONGBU_2}`);

  const t2Tip = git('rev-parse', 'HEAD');

  // Now branch T-03 from t1MergedHead (concurrently!)
  git('switch', '-q', `integration/${change}`);
  git('switch', '-qc', `task/${change}/T-03`);
  const t3Base = t1MergedHead;

  // 5.1 Merge T-02 first into integration
  git('switch', '-q', `integration/${change}`);
  const rMergeT2 = runMergeTask([`task/${change}/T-02`, 'T-02', `pass(${ANCHASI_2_SHORT}@${t2Tip.slice(0, 7)}/${t2Base.slice(0, 7)})`]);
  assert.equal(rMergeT2.status, 0, rMergeT2.stdout + rMergeT2.stderr);
  assert.match(rMergeT2.stdout, /merged T-02/);

  // Integration head advanced!
  const integrationHeadAfterT2 = git('rev-parse', 'HEAD');
  assert.notEqual(integrationHeadAfterT2, t1MergedHead);

  // 5.2 Fault Injection: T-03 causes regression in already-Done T-02 (exit 21)
  git('switch', '-q', `task/${change}/T-03`);

  // Ceshi Red test for T-03 — static import of the module it creates.
  write('test/mul.test.mjs', `import test from 'node:test';
import assert from 'node:assert/strict';
import { mul } from '../src/mul.mjs';

test('multiply numbers', () => {
  assert.equal(typeof mul, 'function');
  assert.equal(mul(3, 4), 12);
});
`);
  git('add', 'test/mul.test.mjs');
  git('commit', '-qm', `test(T-03): red test for multiplication\n\nPipeline-Role: ceshi\nPipeline-Author: ${CESHI_3}`);

  // Gongbu implementation that regresses T-02 by setting status = 'corrupted'
  write('src/mul.mjs', `export const status = 'corrupted';
export function mul(a, b) { return a * b; }
`);
  git('add', 'src/mul.mjs');
  git('commit', '-qm', `feat(T-03): implementation with regression\n\nPipeline-Role: gongbu\nPipeline-Author: ${GONGBU_3}`);

  const t3RegressionTip = git('rev-parse', 'HEAD');
  git('switch', '-q', `integration/${change}`);

  const rRegression = runMergeTask([`task/${change}/T-03`, 'T-03', `pass(${ANCHASI_3_SHORT}@${t3RegressionTip.slice(0, 7)}/${t3Base.slice(0, 7)})`]);
  assert.equal(rRegression.status, 21, rRegression.stdout + rRegression.stderr);
  assert.match(rRegression.stderr, /merge would regress already-Done T-02/);
  assert.equal(git('status', '--porcelain'), ''); // Integration must remain clean!

  // 5.3 Legitimate T-03: Fix regression and merge
  git('switch', '-q', `task/${change}/T-03`);
  git('reset', '--hard', 'HEAD~1'); // drop corrupted commit

  write('src/mul.mjs', 'export function mul(a, b) { return a * b; }\n');
  git('add', 'src/mul.mjs');
  git('commit', '-qm', `feat(T-03): clean multiplication\n\nPipeline-Role: gongbu\nPipeline-Author: ${GONGBU_3}`);

  const t3Tip = git('rev-parse', 'HEAD');
  git('switch', '-q', `integration/${change}`);

  // Note: T-03 base is still t1MergedHead, which is an ancestor of current integration HEAD (t2MergedHead).
  // Scope of T-03 (src/mul.mjs) is completely disjoint from T-02 (src/add.mjs).
  // Frontier merge should succeed without rebase!
  const rMergeT3 = runMergeTask([`task/${change}/T-03`, 'T-03', `pass(${ANCHASI_3_SHORT}@${t3Tip.slice(0, 7)}/${t3Base.slice(0, 7)})`]);
  assert.equal(rMergeT3.status, 0, rMergeT3.stdout + rMergeT3.stderr);
  assert.match(rMergeT3.stdout, /merged T-03/);

  // ------------------------------------------------------------------------
  // 6. Sink Task T-04: Calculator Facade & Full Suite Integration (Wave 3)
  // ------------------------------------------------------------------------
  const integrationHeadAfterWave2 = git('rev-parse', 'HEAD');
  git('switch', '-qc', `task/${change}/T-04`);
  const t4Base = integrationHeadAfterWave2;

  // Ceshi Red test for T-04 — static import of the facade module.
  write('test/calc.test.mjs', `import test from 'node:test';
import assert from 'node:assert/strict';
import { calculate } from '../src/calc.mjs';

test('calculate compound operations', () => {
  assert.equal(typeof calculate, 'function');
  assert.equal(calculate('add', 10, 20), 30);
  assert.equal(calculate('mul', 5, 6), 30);
});
`);
  git('add', 'test/calc.test.mjs');
  git('commit', '-qm', `test(T-04): red test for calculator facade\n\nPipeline-Role: ceshi\nPipeline-Author: ${CESHI_4}`);

  // Gongbu implementation for T-04 integrating add and mul
  write('src/calc.mjs', `import { add } from './add.mjs';
import { mul } from './mul.mjs';

export function calculate(op, a, b) {
  if (op === 'add') return add(a, b);
  if (op === 'mul') return mul(a, b);
  throw new Error('unknown op');
}
`);
  git('add', 'src/calc.mjs');
  git('commit', '-qm', `feat(T-04): implement facade\n\nPipeline-Role: gongbu\nPipeline-Author: ${GONGBU_4}`);

  const t4Tip = git('rev-parse', 'HEAD');
  git('switch', '-q', `integration/${change}`);

  // T-04 verify runs both narrow verify and `npm test`
  const rMergeT4 = runMergeTask([`task/${change}/T-04`, 'T-04', `pass(${ANCHASI_4_SHORT}@${t4Tip.slice(0, 7)}/${t4Base.slice(0, 7)})`]);
  assert.equal(rMergeT4.status, 0, rMergeT4.stdout + rMergeT4.stderr);
  assert.match(rMergeT4.stdout, /merged T-04/);

  // ------------------------------------------------------------------------
  // 7. Post-Delivery Closed-Loop Verification
  // ------------------------------------------------------------------------
  // 7.1 tasks.md reflects all Done tasks with provenance
  const finalTasks = fs.readFileSync(path.join(cwd, `openspec/changes/${change}/tasks.md`), 'utf8');
  assert.match(finalTasks, /\[x\] 1\.1 T-01 core/);
  assert.match(finalTasks, /\[x\] 2\.1 T-02 add/);
  assert.match(finalTasks, /\[x\] 2\.2 T-03 mul/);
  assert.match(finalTasks, /\[x\] 3\.1 T-04 facade/);
  assert.equal((finalTasks.match(/Done: source=/g) || []).length, 4);

  // 7.2 run-log.md records all merges
  const finalRunLog = fs.readFileSync(path.join(cwd, `openspec/changes/${change}/run-log.md`), 'utf8');
  assert.match(finalRunLog, /merge task=T-01/);
  assert.match(finalRunLog, /merge task=T-02/);
  assert.match(finalRunLog, /merge task=T-03/);
  assert.match(finalRunLog, /merge task=T-04/);
  // Every merge records phase timings; red/verify only exist for behavior tasks, total always.
  const timings = [...finalRunLog.matchAll(/timing_ms=(\{[^}]*\})/g)].map((m) => JSON.parse(m[1]));
  assert.equal(timings.length, 4);
  for (const t of timings) assert.ok(t.total >= 0 && t.regression >= 0 && Number.isInteger(t.replayed), JSON.stringify(t));

  // 7.3 Full suite passes completely on integration HEAD
  const finalTestRun = spawnSync('npm', ['test'], { cwd, env: localEnv, encoding: 'utf8' });
  assert.equal(finalTestRun.status, 0, finalTestRun.stdout + finalTestRun.stderr);
  assert.match(finalTestRun.stdout, /pass/);

  // 7.4 Git integration log is clean and linear-ordered merge commits
  const mergeCommits = git('log', '--oneline', '--merges');
  assert.match(mergeCommits, /merge\(T-04\)/);
  assert.match(mergeCommits, /merge\(T-03\)/);
  assert.match(mergeCommits, /merge\(T-02\)/);
  assert.match(mergeCommits, /merge\(T-01\)/);
});
