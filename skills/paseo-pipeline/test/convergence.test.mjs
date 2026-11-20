import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PIPELINE_DIR = path.resolve(here, '..');
const NEXT_ACTIONS = path.join(PIPELINE_DIR, 'next-actions.mjs');
const FREEZE_CHECK = path.join(PIPELINE_DIR, 'freeze-check.mjs');
const MERGE_TASK = path.join(PIPELINE_DIR, 'merge-task.mjs');
const WORKER_CHECK = path.join(PIPELINE_DIR, 'worker-check.mjs');
const TIER2_VERIFY = path.join(PIPELINE_DIR, 'tier2-verify.mjs');
const ACCEPTANCE_SYNC = path.join(PIPELINE_DIR, 'acceptance-sync.mjs');
const BRIEF = path.join(PIPELINE_DIR, 'brief.mjs');

const runNode = (script, cwd, args = [], extraEnv = {}) =>
  spawnSync('node', [script, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...extraEnv } });

const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function fakePaseoBin(agents = []) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-paseo-'));
  const paseo = path.join(bin, 'paseo');
  fs.writeFileSync(
    paseo,
    `#!/bin/sh
if [ "$1" = "ls" ]; then
  printf '%s' '${JSON.stringify(agents)}'
elif [ "$1" = "inspect" ]; then
  printf '%s' '${JSON.stringify({ Id: agents[0]?.id ?? 'a1', Name: agents[0]?.name ?? '', Status: 'running', PendingPermissions: [] })}'
fi
`,
  );
  fs.chmodSync(paseo, 0o755);
  return { PATH: `${bin}:${process.env.PATH}`, PASEO_AGENT_ID: '00000000-0000-4000-8000-000000000099' };
}

function makePipelineRepo({ tasksMd, withIntegration = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'paseo-conv-')));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test User');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'ui'), { recursive: true });
  fs.mkdirSync(path.join(root, 'test'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'conv-fixture', type: 'module' }, null, 2));
  fs.writeFileSync(path.join(root, 'src/a.js'), 'export const a = () => 1;\n');
  fs.writeFileSync(path.join(root, 'ui/view.js'), 'export const v = () => 1;\n');
  fs.writeFileSync(path.join(root, 'test/a.test.js'), 'import test from "node:test"; import assert from "node:assert/strict"; test("ok", () => assert.equal(1, 1));\n');

  fs.mkdirSync(path.join(root, 'openspec'), { recursive: true });
  fs.writeFileSync(path.join(root, 'openspec/config.yaml'), 'schema: spec-driven\n');
  const chg = path.join(root, 'openspec/changes/c1');
  fs.mkdirSync(path.join(chg, 'specs/core'), { recursive: true });
  fs.writeFileSync(path.join(chg, 'proposal.md'), '## Why\nFix behavior.\n\n## What Changes\n- Update core behavior.\n');
  fs.writeFileSync(path.join(chg, 'design.md'), '# Design\nSingle path.\n');
  fs.writeFileSync(path.join(chg, 'review.md'), 'R0: pass(00000000-0000-4000-8000-000000000010@HEAD)\n');
  fs.writeFileSync(
    path.join(chg, 'specs/core/spec.md'),
    [
      '## ADDED Requirements',
      '',
      '### Requirement: R1 Core invariant',
      'The system SHALL preserve the core invariant.',
      '#### Scenario: SCEN-001 Basic check',
      '- **GIVEN** fixture',
      '- **WHEN** invoked',
      '- **THEN** succeeds',
      '- **Verify:** `node --test test/a.test.js`',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(chg, 'tasks.md'),
    tasksMd ?? [
      '# Tasks',
      '',
      '- [ ] 1.1 T-01 Core backend task',
      '  - Scen: SCEN-001',
      '  - Write scope: src/a.js',
      '  - Read scope: test/a.test.js',
      '  - Est: L',
      '  - Risk-surface: auth',
      '  - Verify with: node --test test/a.test.js',
      '',
      '- [ ] 1.2 T-02 UI view tweak',
      '  - Depends on: T-01',
      '  - Scen: SCEN-001',
      '  - Write scope: ui/view.js',
      '  - Est: S',
      '  - Verify with: node --test test/a.test.js',
      '',
    ].join('\n'),
  );
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');
  if (withIntegration) {
    git(root, 'branch', 'integration/c1');
  }
  return root;
}

test('lib/roles + next-actions recognize neon R0 and route UI to jiangzuo, L/risk to gaogong', () => {
  const root = makePipelineRepo();
  const env = fakePaseoBin([{ id: 'neon-1', name: '[Pipeline] neon R0', status: 'running', cwd: root, labels: { 'pipeline.change': 'c1' } }]);
  const res = runNode(NEXT_ACTIONS, root, ['openspec/changes/c1', '--json'], env);
  assert.equal(res.status, 0, res.stderr + res.stdout);
  const data = JSON.parse(res.stdout);
  assert.equal(data.dispatch.length, 1);
  assert.equal(data.dispatch[0].task, 'T-01');
  assert.match(data.dispatch[0].title, /^\[Pipeline\] gaogong T-01/);

  // Remove Depends on: T-01 to make T-02 (ui/view.js) ready and verify jiangzuo routing
  const tasksPath = path.join(root, 'openspec/changes/c1/tasks.md');
  fs.writeFileSync(tasksPath, fs.readFileSync(tasksPath, 'utf8').replace('  - Depends on: T-01\n', ''));
  git(root, 'checkout', '-q', 'integration/c1');
  git(root, 'add', 'openspec/changes/c1/tasks.md');
  git(root, 'commit', '-q', '-m', 'unblock T-02');
  git(root, 'checkout', '-q', 'main');
  const res2 = runNode(NEXT_ACTIONS, root, ['openspec/changes/c1', '--json'], env);
  assert.equal(res2.status, 0, res2.stderr + res2.stdout);
  const data2 = JSON.parse(res2.stdout);
  const t02 = data2.dispatch.find((d) => d.task === 'T-02');
  assert.ok(t02);
  assert.match(t02.title, /^\[Pipeline\] jiangzuo T-02/);
});

test('freeze-check accepts neon as R0 signer without R0_SIGNER_NOT_HANLIN or R0_SIGNER_NOT_R0', () => {
  const root = makePipelineRepo({ withIntegration: false });
  const env = fakePaseoBin([{ id: '00000000-0000-4000-8000-000000000010', shortId: '0000000', name: '[Pipeline] neon R0', provider: 'claude/cc' }]);
  const res = runNode(FREEZE_CHECK, root, ['openspec/changes/c1', '--json'], env);
  const parsed = JSON.parse(res.stdout);
  const codes = (parsed.advisories ?? []).concat(parsed.blocking ?? []).map((x) => x.split(':')[0]);
  assert.equal(codes.includes('R0_SIGNER_NOT_HANLIN'), false);
  assert.equal(codes.includes('R0_SIGNER_NOT_R0'), false);
});

test('merge-task and worker-check reject non-ceshi modification of ceshi-authored Red file (exit 38) unless --allow-test-infra', () => {
  const tasksMd = [
    '# Tasks',
    '',
    '- [ ] 1.1 T-01 Feature with strict Red test',
    '  - Scen: SCEN-001',
    '  - Review: strict',
    '  - Write scope: src/a.js,test/red.test.js',
    '  - Verify with: node --test test/red.test.js',
    '',
  ].join('\n');
  const root = makePipelineRepo({ tasksMd });
  git(root, 'checkout', '-q', '-b', 'task/c1/T-01', 'integration/c1');

  // Step 1: ceshi adds Red test
  fs.writeFileSync(path.join(root, 'test/red.test.js'), 'import test from "node:test"; import assert from "node:assert/strict"; test("red", () => assert.equal(2, 2));\n');
  git(root, 'add', 'test/red.test.js');
  git(root, 'commit', '-q', '-m', '[Pipeline] T-01: red test\n\nPipeline-Role: ceshi\nPipeline-Author: 00000000-0000-4000-8000-000000000001');

  // Step 2: gongbu implements src/a.js AND weakens ceshi Red file test/red.test.js
  fs.writeFileSync(path.join(root, 'src/a.js'), 'export const a = () => 2;\n');
  fs.writeFileSync(path.join(root, 'test/red.test.js'), 'import test from "node:test"; test("weakened", () => {});\n');
  git(root, 'add', 'src/a.js', 'test/red.test.js');
  git(root, 'commit', '-q', '-m', '[Pipeline] T-01: impl + tamper\n\nPipeline-Role: gongbu\nPipeline-Author: 00000000-0000-4000-8000-000000000002');

  const wcFail = runNode(WORKER_CHECK, root, ['openspec/changes/c1', 'T-01']);
  assert.equal(wcFail.status, 38, wcFail.stderr + wcFail.stdout);
  assert.match(wcFail.stderr, /TEST_ORACLE_TAMPERING/);

  git(root, 'checkout', '-q', 'integration/c1');
  const mFail = runNode(MERGE_TASK, root, ['task/c1/T-01', 'T-01']);
  assert.equal(mFail.status, 38, `expected exit 38, got ${mFail.status}: ${mFail.stderr}\n${mFail.stdout}`);
  assert.match(mFail.stderr, /ceshi Red/i);

  // Explicit --allow-test-infra permits intentional infra repair
  const mAllowed = runNode(MERGE_TASK, root, ['task/c1/T-01', 'T-01', '--allow-test-infra']);
  assert.equal(mAllowed.status, 0, mAllowed.stderr + mAllowed.stdout);
});

test('worker-check validates scope (30), trailer (31), and verify (0)', () => {
  const root = makePipelineRepo();
  git(root, 'checkout', '-q', '-b', 'task/c1/T-01', 'integration/c1');
  fs.writeFileSync(path.join(root, 'src/a.js'), 'export const a = () => 42;\n');
  git(root, 'add', 'src/a.js');
  git(root, 'commit', '-q', '-m', '[Pipeline] T-01: implement\n\nPipeline-Role: gongbu\nPipeline-Author: 00000000-0000-4000-8000-000000000002');

  const ok = runNode(WORKER_CHECK, root, ['openspec/changes/c1', 'T-01']);
  assert.equal(ok.status, 0, ok.stderr + ok.stdout);

  // Out-of-scope file -> 30
  fs.writeFileSync(path.join(root, 'ui/view.js'), 'export const v = () => 99;\n');
  git(root, 'add', 'ui/view.js');
  git(root, 'commit', '-q', '-m', '[Pipeline] T-01: oops\n\nPipeline-Role: gongbu\nPipeline-Author: 00000000-0000-4000-8000-000000000002');
  const scopeFail = runNode(WORKER_CHECK, root, ['openspec/changes/c1', 'T-01']);
  assert.equal(scopeFail.status, 30, scopeFail.stderr + scopeFail.stdout);
});

test('tier2-verify enforces linked worktree, verifies SCEN, and gates risky diffs', () => {
  const root = makePipelineRepo();
  // On primary checkout -> FAIL
  const prim = runNode(TIER2_VERIFY, root, ['main', '--verify', 'node --test test/a.test.js', '--json']);
  assert.equal(prim.status, 1);
  assert.equal(JSON.parse(prim.stdout).verdict, 'FAIL');

  // Inside clean linked worktree with passing verify (from --verify or --change-dir SCEN) and non-risky change -> PASS
  const wt = `${root}-wt`;
  git(root, 'worktree', 'add', '-q', '-b', 'feat/t2', wt);
  fs.writeFileSync(path.join(wt, 'src/a.js'), 'export const a = () => 2;\n');
  git(wt, 'add', 'src/a.js');
  git(wt, 'commit', '-q', '-m', 'feat: simple update');
  const pass = runNode(TIER2_VERIFY, wt, ['main', '--change-dir', 'openspec/changes/c1', '--json']);
  assert.equal(pass.status, 0, pass.stderr + pass.stdout);
  assert.equal(JSON.parse(pass.stdout).verdict, 'PASS');

  // Missing openspec validator when --change-dir is supplied MUST FAIL (B2 regression)
  const nodeOnlyBin = fs.mkdtempSync(path.join(os.tmpdir(), 'node-only-'));
  fs.symlinkSync(process.execPath, path.join(nodeOnlyBin, 'node'));
  const noOpenSpec = runNode(TIER2_VERIFY, wt, ['main', '--change-dir', 'openspec/changes/c1', '--json'], { PATH: `${nodeOnlyBin}:/usr/bin:/bin` });
  assert.equal(noOpenSpec.status, 1, `${noOpenSpec.stderr ?? ''}${noOpenSpec.stdout ?? ''}`);
  const noOsData = JSON.parse(noOpenSpec.stdout);
  assert.equal(noOsData.verdict, 'FAIL');
  assert.ok(noOsData.openSpecStrictError);

  // Adding an auth/security file triggers REVIEW_REQUIRED (Contract: none without --change-dir still works)
  fs.mkdirSync(path.join(wt, 'src/auth'), { recursive: true });
  fs.writeFileSync(path.join(wt, 'src/auth/token.js'), 'export const verify = (t) => Boolean(t);\n');
  git(wt, 'add', 'src/auth/token.js');
  git(wt, 'commit', '-q', '-m', 'feat: add auth token check');
  const review = runNode(TIER2_VERIFY, wt, ['main', '--verify', 'node --test test/a.test.js', '--json']);
  assert.equal(review.status, 0, review.stderr + review.stdout);
  const rData = JSON.parse(review.stdout);
  assert.equal(rData.verdict, 'REVIEW_REQUIRED');
  assert.ok(rData.risk.reviewRequired);
});

test('merge-task executes Verify under set -o pipefail so false | cat fails exit 20 (B3 regression)', () => {
  const tasksMd = [
    '# Tasks',
    '',
    '- [ ] 1.1 T-01 Pipeline verify task',
    '  - Scen: SCEN-001',
    '  - Write scope: src/a.js',
    '  - Verify with: false | cat',
    '',
  ].join('\n');
  const root = makePipelineRepo({ tasksMd });
  git(root, 'checkout', '-q', '-b', 'task/c1/T-01', 'integration/c1');
  fs.writeFileSync(path.join(root, 'src/a.js'), 'export const a = () => 99;\n');
  git(root, 'add', 'src/a.js');
  git(root, 'commit', '-q', '-m', '[Pipeline] T-01: impl\n\nPipeline-Role: gongbu\nPipeline-Author: 00000000-0000-4000-8000-000000000002');
  git(root, 'checkout', '-q', 'integration/c1');

  const merged = runNode(MERGE_TASK, root, ['task/c1/T-01', 'T-01']);
  assert.equal(merged.status, 20, `expected exit 20 under pipefail, got ${merged.status}: ${merged.stderr}\n${merged.stdout}`);
});

test('acceptance-sync generates acceptance.md from specs + tasks and preserves Entry/Required', () => {
  const root = makePipelineRepo();
  const accPath = path.join(root, 'openspec/changes/c1/acceptance.md');
  fs.writeFileSync(
    accPath,
    [
      '# Acceptance',
      '',
      '| Scenario | Entry | Tasks | Verify | Required | Result | Evidence |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      '| SCEN-001 | manual-entry | T-01 | `node custom.test.js` | yes | PENDING | pending |',
      '',
    ].join('\n'),
  );
  const res = runNode(ACCEPTANCE_SYNC, root, ['openspec/changes/c1']);
  assert.equal(res.status, 0, res.stderr + res.stdout);
  const content = fs.readFileSync(accPath, 'utf8');
  assert.match(content, /SCEN-001/);
  assert.match(content, /manual-entry/);
});

test('brief.mjs renders recon, r0, final, tier2, tier2-review prompts (and allows omitting --change on tier2/tier2-review)', () => {
  const root = makePipelineRepo();
  for (const kind of ['recon', 'r0', 'final', 'tier2', 'tier2-review']) {
    const args = [kind, '--repo', root, '--change', 'c1'];
    if (kind === 'recon') args.push('--goal', 'Investigate core module');
    const res = runNode(BRIEF, root, args);
    assert.equal(res.status, 0, `${kind} failed: ${res.stderr}`);
    assert.ok(res.stdout.length > 100, `${kind} output unexpectedly short`);
  }
  for (const kind of ['tier2', 'tier2-review']) {
    const res = runNode(BRIEF, root, [kind, '--repo', root, '--base', 'HEAD']);
    assert.equal(res.status, 0, `${kind} without --change failed: ${res.stderr}`);
    assert.ok(res.stdout.length > 100, `${kind} output without --change unexpectedly short`);
  }
});
