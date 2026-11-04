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

// One worker per task; these are distinct agents, not distinct process roles.
const GONGBU_1 = '11111111-0002-4000-8000-000000000002';
const GONGBU_2 = '22222222-0002-4000-8000-000000000002';
const GONGBU_3 = '33333333-0002-4000-8000-000000000002';
const GONGBU_4 = '44444444-0002-4000-8000-000000000002';
// Independent R0 package reviewer; must differ from the author.
const HANLIN_1 = '11111111-0004-4000-8000-000000000004';

const AGENTS = [
  { id: GONGBU_1, shortId: '1111002', provider: 'claude/sonnet' },
  { id: GONGBU_2, shortId: '2222002', provider: 'claude/haiku' },
  { id: GONGBU_3, shortId: '3333002', provider: 'claude/sonnet' },
  { id: GONGBU_4, shortId: '4444002', provider: 'claude/haiku' },
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

const workerCommit = (cwd, git, message, author, files) => {
  for (const [file, text] of Object.entries(files)) {
    const p = path.join(cwd, file);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  }
  git('add', '-A');
  git('commit', '-qm', `${message}\n\nPipeline-Role: gongbu\nPipeline-Author: ${author}`);
};

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
  // 4. Task T-01: Core Module (Wave 1) — one worker owns tests + implementation
  // ------------------------------------------------------------------------
  git('switch', '-qc', `task/${change}/T-01`);
  const t1Base = baseSHA;

  // 4.1 Fault Injection: Worktree lacking dependencies (exit 36)
  // The worker imports a third-party package not installed in the worktree.
  write('test/core.test.mjs', `import 'supertest';
import test from 'node:test';
test('dummy', () => {});
`);
  write('src/core.mjs', 'export const dummy = 1;\n');
  git('add', '.');
  git('commit', '-qm', `work(T-01): missing deps\n\nPipeline-Role: gongbu\nPipeline-Author: ${GONGBU_1}`);

  const t1MissingTip = git('rev-parse', 'HEAD');
  git('switch', '-q', `integration/${change}`);

  const rMissingDep = runMergeTask([`task/${change}/T-01`, 'T-01']);
  assert.equal(rMissingDep.status, 36, rMissingDep.stdout + rMissingDep.stderr);
  assert.match(rMissingDep.stderr, /cannot resolve "supertest"/);
  assert.match(rMissingDep.stderr, /Install once in this worktree: npm ci/);
  assert.equal(git('status', '--porcelain'), ''); // Integration must remain clean!

  // 4.2 Legitimate T-01: one worker commit carries the behavior test and the implementation.
  git('switch', '-q', `task/${change}/T-01`);
  git('reset', '--hard', t1Base);
  workerCommit(cwd, git, 'feat(T-01): implement core', GONGBU_1, {
    'test/core.test.mjs': `import test from 'node:test';
import assert from 'node:assert/strict';
import { isNumber } from '../src/core.mjs';
test('isNumber validates numbers', () => {
  assert.equal(typeof isNumber, 'function');
  assert.equal(isNumber(100), true);
  assert.equal(isNumber('100'), false);
});
`,
    'src/core.mjs': 'export function isNumber(n) { return typeof n === "number"; }\n',
  });

  const t1Tip = git('rev-parse', 'HEAD');
  git('switch', '-q', `integration/${change}`);

  const rMergeT1 = runMergeTask([`task/${change}/T-01`, 'T-01']);
  assert.equal(rMergeT1.status, 0, rMergeT1.stdout + rMergeT1.stderr);
  assert.match(rMergeT1.stdout, /merged T-01/);

  const t1MergedHead = git('rev-parse', 'HEAD');

  // Verify tasks.md on integration branch
  const tasksAfterT1 = fs.readFileSync(path.join(cwd, `openspec/changes/${change}/tasks.md`), 'utf8');
  assert.match(tasksAfterT1, /\[x\] 1\.1 T-01 core\n\s+- Done: source=/);
  assert.match(tasksAfterT1, /review=worker/);

  // ------------------------------------------------------------------------
  // 5. Concurrent Wave 2: Task T-02 (Add) and Task T-03 (Mul)
  // ------------------------------------------------------------------------
  // Both branch concurrently from T-01 merged head
  git('switch', '-qc', `task/${change}/T-02`);
  const t2Base = t1MergedHead;

  workerCommit(cwd, git, 'feat(T-02): implement addition', GONGBU_2, {
    'test/add.test.mjs': `import test from 'node:test';
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
`,
    'src/add.mjs': 'export function add(a, b) { return a + b; }\n',
  });

  const t2Tip = git('rev-parse', 'HEAD');

  // Now branch T-03 from t1MergedHead (concurrently!)
  git('switch', '-q', `integration/${change}`);
  git('switch', '-qc', `task/${change}/T-03`);
  const t3Base = t1MergedHead;

  // 5.1 Merge T-02 first into integration
  git('switch', '-q', `integration/${change}`);
  const rMergeT2 = runMergeTask([`task/${change}/T-02`, 'T-02']);
  assert.equal(rMergeT2.status, 0, rMergeT2.stdout + rMergeT2.stderr);
  assert.match(rMergeT2.stdout, /merged T-02/);

  // Integration head advanced!
  const integrationHeadAfterT2 = git('rev-parse', 'HEAD');
  assert.notEqual(integrationHeadAfterT2, t1MergedHead);

  // 5.2 Fault Injection: T-03 causes regression in already-Done T-02 (exit 21)
  git('switch', '-q', `task/${change}/T-03`);

  // Worker commit for T-03 intentionally regresses T-02 via the imported status.
  workerCommit(cwd, git, 'feat(T-03): implementation with regression', GONGBU_3, {
    'test/mul.test.mjs': `import test from 'node:test';
import assert from 'node:assert/strict';
import { mul } from '../src/mul.mjs';

test('multiply numbers', () => {
  assert.equal(typeof mul, 'function');
  assert.equal(mul(3, 4), 12);
});
`,
    'src/mul.mjs': `export const status = 'corrupted';
export function mul(a, b) { return a * b; }
`,
  });

  const t3RegressionTip = git('rev-parse', 'HEAD');
  git('switch', '-q', `integration/${change}`);

  const rRegression = runMergeTask([`task/${change}/T-03`, 'T-03']);
  assert.equal(rRegression.status, 21, rRegression.stdout + rRegression.stderr);
  assert.match(rRegression.stderr, /merge would regress already-Done T-02/);
  assert.equal(git('status', '--porcelain'), ''); // Integration must remain clean!

  // 5.3 Legitimate T-03: Fix regression and merge
  git('switch', '-q', `task/${change}/T-03`);
  git('reset', '--hard', 'HEAD~1'); // drop corrupted commit

  workerCommit(cwd, git, 'feat(T-03): clean multiplication', GONGBU_3, {
    'test/mul.test.mjs': `import test from 'node:test';
import assert from 'node:assert/strict';
import { mul } from '../src/mul.mjs';

test('multiply numbers', () => {
  assert.equal(typeof mul, 'function');
  assert.equal(mul(3, 4), 12);
});
`,
    'src/mul.mjs': 'export function mul(a, b) { return a * b; }\n',
  });

  const t3Tip = git('rev-parse', 'HEAD');
  git('switch', '-q', `integration/${change}`);

  // Note: T-03 base is still t1MergedHead, which is an ancestor of current integration HEAD (t2MergedHead).
  // Scope of T-03 (src/mul.mjs) is completely disjoint from T-02 (src/add.mjs).
  // Frontier merge should succeed without rebase!
  const rMergeT3 = runMergeTask([`task/${change}/T-03`, 'T-03']);
  assert.equal(rMergeT3.status, 0, rMergeT3.stdout + rMergeT3.stderr);
  assert.match(rMergeT3.stdout, /merged T-03/);

  // ------------------------------------------------------------------------
  // 6. Sink Task T-04: Calculator Facade & Full Suite Integration (Wave 3)
  // ------------------------------------------------------------------------
  const integrationHeadAfterWave2 = git('rev-parse', 'HEAD');
  git('switch', '-qc', `task/${change}/T-04`);
  const t4Base = integrationHeadAfterWave2;

  workerCommit(cwd, git, 'feat(T-04): implement facade', GONGBU_4, {
    'test/calc.test.mjs': `import test from 'node:test';
import assert from 'node:assert/strict';
import { calculate } from '../src/calc.mjs';

test('calculate compound operations', () => {
  assert.equal(typeof calculate, 'function');
  assert.equal(calculate('add', 10, 20), 30);
  assert.equal(calculate('mul', 5, 6), 30);
});
`,
    'src/calc.mjs': `import { add } from './add.mjs';
import { mul } from './mul.mjs';

export function calculate(op, a, b) {
  if (op === 'add') return add(a, b);
  if (op === 'mul') return mul(a, b);
  throw new Error('unknown op');
}
`,
  });

  const t4Tip = git('rev-parse', 'HEAD');
  git('switch', '-q', `integration/${change}`);

  // T-04 verify runs both narrow verify and `npm test`
  const rMergeT4 = runMergeTask([`task/${change}/T-04`, 'T-04']);
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
  assert.equal((finalTasks.match(/review=worker/g) || []).length, 4);

  // 7.2 run-log.md records all merges
  const finalRunLog = fs.readFileSync(path.join(cwd, `openspec/changes/${change}/run-log.md`), 'utf8');
  assert.match(finalRunLog, /merge task=T-01/);
  assert.match(finalRunLog, /merge task=T-02/);
  assert.match(finalRunLog, /merge task=T-03/);
  assert.match(finalRunLog, /merge task=T-04/);
  // Every merge records phase timings; Verify and regression always run.
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
