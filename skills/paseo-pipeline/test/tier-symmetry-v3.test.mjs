import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assessTierGate, assessStop, takeSnapshot } from '../lib/tier-gate.mjs';
import { detectActiveAuthorChange, recordAuthorRead } from '../lib/author-guard.mjs';
import { recordEvent, summarizeTelemetry, telemetryFile } from '../lib/telemetry.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PIPELINE_DIR = path.resolve(here, '..');
const PIPELINE_RUN = path.join(PIPELINE_DIR, 'pipeline-run.mjs');
const TIER2_VERIFY = path.join(PIPELINE_DIR, 'tier2-verify.mjs');
const FREEZE_CHECK = path.join(PIPELINE_DIR, 'freeze-check.mjs');
const BRIEF = path.join(PIPELINE_DIR, 'brief.mjs');
const TOOL_GUARD = path.join(PIPELINE_DIR, 'hooks', 'tool-guard-hook.mjs');
const SESSION_HOOK = path.join(PIPELINE_DIR, 'hooks', 'tier-session-hook.mjs');

const git = (cwd, ...args) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'tester',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 'tester',
      GIT_COMMITTER_EMAIL: 't@example.com',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

const runNode = (script, cwd, args = [], extraEnv = {}) => {
  const env = { ...process.env, ...extraEnv };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: 'utf8',
    env,
  });
};

function makeRepo(t, { withPassingTest = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sym-v3-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'tester@example.com');
  git(root, 'config', 'user.name', 'Tester');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'test'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'sym-fixture', type: 'module' }, null, 2));
  fs.writeFileSync(path.join(root, 'src/a.mjs'), 'export const val = () => 1;\n');
  fs.writeFileSync(
    path.join(root, 'test/a.test.mjs'),
    withPassingTest
      ? "import test from 'node:test'; import assert from 'node:assert/strict'; import { val } from '../src/a.mjs'; test('ok', () => assert.ok(val() >= 1));\n"
      : "import test from 'node:test'; import assert from 'node:assert/strict'; test('fail', () => assert.equal(1, 2));\n",
  );
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'seed');
  return root;
}

function makeTier2Change(root, changeDir, { tasksMd, specMd } = {}) {
  fs.mkdirSync(path.join(changeDir, 'specs', 'core'), { recursive: true });
  fs.writeFileSync(path.join(changeDir, '.openspec.yaml'), 'schema: paseo-tier2\ncreated: 2026-11-22\n');
  fs.writeFileSync(
    path.join(changeDir, 'specs', 'core', 'spec.md'),
    specMd ?? [
      '## ADDED Requirements',
      '### Requirement: Core val',
      'The system SHALL return a positive number.',
      '#### Scenario: SCEN-CORE-01 returns positive',
      '- **WHEN** val() is called',
      '- **THEN** it returns >= 1',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(changeDir, 'tasks.md'),
    tasksMd ?? [
      '# Tasks',
      '',
      '- [x] 1.1 T-01 Update core value',
      '  - Write scope: src/a.mjs, test/a.test.mjs',
      '  - Entry: src/a.mjs#val',
      '  - Risk-surface: [error-handling]',
      '  - Verify with: node --test test/a.test.mjs',
      '  - Scenarios: SCEN-CORE-01',
    ].join('\n'),
  );
}

test('P0 cp2-merge re-runs Verify after main drift sync and refuses ff-only push to main when Verify fails', (t) => {
  const root = makeRepo(t);
  const chg = path.join(root, 'openspec', 'changes', 'c1');
  fs.mkdirSync(path.join(chg, 'specs', 'core'), { recursive: true });
  fs.writeFileSync(path.join(chg, '.openspec.yaml'), 'schema: paseo-pipeline\n');
  fs.writeFileSync(path.join(chg, 'proposal.md'), '## What Changes\n- R1: core\n');
  fs.writeFileSync(path.join(chg, 'specs', 'core', 'spec.md'), '### Requirement: Core\nThe system SHALL work.\n#### Scenario: SCEN-CORE-01 ok\n- **WHEN** called\n- **THEN** returns 1\n');
  fs.writeFileSync(path.join(chg, 'tasks.md'), '- [x] 1.1 T-01 core\n  - Write scope: src/a.mjs\n  - Entry: CLI\n  - Verify with: node --test test/a.test.mjs\n  - Scenarios: SCEN-CORE-01\n');
  fs.writeFileSync(path.join(chg, 'acceptance.md'), '| Scenario | Entry | Tasks | Verify | Required | Result | Evidence |\n| --- | --- | --- | --- | --- | --- | --- |\n| SCEN-CORE-01 | CLI | T-01 | node --test test/a.test.mjs | yes | PENDING | pending |\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'contract');
  git(root, 'branch', 'integration/c1');

  const intWt = `${root}-int`;
  git(root, 'worktree', 'add', '-q', intWt, 'integration/c1');
  t.after(() => fs.rmSync(intWt, { recursive: true, force: true }));
  fs.writeFileSync(path.join(intWt, 'src/a.js'), 'export const helper = () => 1;\n');
  git(intWt, 'add', 'src/a.js');
  git(intWt, 'commit', '-qm', 'int change');
  const srcSha = git(intWt, 'rev-parse', '--short=7', 'HEAD');
  fs.writeFileSync(path.join(intWt, 'openspec/changes/c1/tasks.md'), `- [x] 1.1 T-01 core\n  - Write scope: src/a.mjs\n  - Entry: CLI\n  - Verify with: node --test test/a.test.mjs\n  - Scenarios: SCEN-CORE-01\n  - Done: source=${srcSha} review=mechanical\n`);
  git(intWt, 'add', 'openspec/changes/c1/tasks.md');
  git(intWt, 'commit', '-qm', 'mark T-01 done');
  const preSyncTip = git(intWt, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(intWt, 'openspec/changes/c1/review.md'), `FINAL: pass(anchasi-1@${preSyncTip})\n`);
  git(intWt, 'add', 'openspec/changes/c1/review.md');
  git(intWt, 'commit', '-qm', 'record FINAL signoff');

  // Main drifts by adding a failing requirement check into test/a.test.mjs
  fs.writeFileSync(path.join(root, 'test/a.test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; test('drift break', () => assert.equal(1, 2));\n");
  git(root, 'add', 'test/a.test.mjs');
  git(root, 'commit', '-qm', 'main drifted with stricter broken check');
  const mainShaBefore = git(root, 'rev-parse', 'main');

  const telFile = path.join(path.dirname(root), 'metrics.jsonl');
  const failedCp2 = runNode(PIPELINE_RUN, root, ['cp2-merge', 'openspec/changes/c1', '--json'], { PIPELINE_TELEMETRY_FILE: telFile });
  assert.equal(failedCp2.status, 20, failedCp2.stderr + failedCp2.stdout);
  assert.equal(git(root, 'rev-parse', 'main'), mainShaBefore, 'main must stay untouched at rollback SHA when post-drift Verify fails');

  // Fix test on drifted main or override with explicit passing --verify -> cp2-merge still validates Verify command
  const passCp2 = runNode(PIPELINE_RUN, root, ['cp2-merge', 'openspec/changes/c1', '--verify', "node -e \"console.log('ok')\""], { PIPELINE_TELEMETRY_FILE: telFile });
  // node -e is rejected by F-1..F-7 verify-policy prover! Main stays untouched again (exit 20).
  assert.equal(passCp2.status, 20, passCp2.stderr + passCp2.stdout);
  assert.equal(git(root, 'rev-parse', 'main'), mainShaBefore);

  // Pending retry with dirty integration worktree -> refuses exit 3 and keeps main untouched
  const dirtyTemp = path.join(intWt, 'uncommitted-fix.txt');
  fs.writeFileSync(dirtyTemp, 'wip\n');
  const dirtyRetry = runNode(PIPELINE_RUN, root, ['cp2-merge', 'openspec/changes/c1', '--verify', 'node --test test/a.test.mjs'], { PIPELINE_TELEMETRY_FILE: telFile });
  assert.equal(dirtyRetry.status, 3, dirtyRetry.stderr + dirtyRetry.stdout);
  assert.equal(git(root, 'rev-parse', 'main'), mainShaBefore);
  fs.rmSync(dirtyTemp);

  // Pending retry without any checked-out integration worktree -> refuses exit 3 and keeps main untouched
  git(root, 'worktree', 'remove', intWt);
  const missingWtRetry = runNode(PIPELINE_RUN, root, ['cp2-merge', 'openspec/changes/c1', '--verify', 'node --test test/a.test.mjs'], { PIPELINE_TELEMETRY_FILE: telFile });
  assert.equal(missingWtRetry.status, 3, missingWtRetry.stderr + missingWtRetry.stdout);
  assert.equal(git(root, 'rev-parse', 'main'), mainShaBefore);

  // Re-attach clean integration worktree, commit passing verify test, and retry -> completes with driftVerified=true
  git(root, 'worktree', 'add', '-q', intWt, 'integration/c1');
  fs.writeFileSync(path.join(intWt, 'test/pass.test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; test('ok', () => assert.equal(1, 1));\n");
  git(intWt, 'add', 'test/pass.test.mjs');
  git(intWt, 'commit', '-qm', 'add passing verify test');
  const okCp2 = runNode(PIPELINE_RUN, root, ['cp2-merge', 'openspec/changes/c1', '--verify', 'node --test test/pass.test.mjs', '--json'], { PIPELINE_TELEMETRY_FILE: telFile });
  assert.equal(okCp2.status, 0, okCp2.stderr + okCp2.stdout);
  const payload = JSON.parse(okCp2.stdout);
  assert.equal(payload.driftedSynced, true);
  assert.equal(payload.driftVerified, true);
  assert.equal(payload.driftVerifyResults.length, 1);
  assert.notEqual(git(root, 'rev-parse', 'main'), mainShaBefore);
});

test('P0 tier2-verify fail-fast skips Verify on dirty tree, flags Write scope drift, and advises on stale changes', (t) => {
  const root = makeRepo(t);
  const wt = `${root}-wt`;
  git(root, 'worktree', 'add', '-q', '-b', 'feat/t2-sym', wt);
  t.after(() => fs.rmSync(wt, { recursive: true, force: true }));

  const chg = path.join(wt, 'openspec', 'changes', 'feat-cur');
  makeTier2Change(wt, chg);
  // Create 4 sibling unarchived changes to trip stale threshold (>3)
  for (const name of ['old-1', 'old-2', 'old-3', 'old-4']) {
    fs.mkdirSync(path.join(wt, 'openspec', 'changes', name), { recursive: true });
  }
  // Modify file outside T-01 Write scope (src/extra.mjs)
  fs.writeFileSync(path.join(wt, 'src/a.mjs'), 'export const val = () => 2;\n');
  fs.writeFileSync(path.join(wt, 'src/extra.mjs'), 'export const extra = 1;\n');
  git(wt, 'add', '.');
  git(wt, 'commit', '-qm', 'feat + extra file');

  // Dirty untracked marker; if tier2-verify fails fast BEFORE running Verify, markerScript is never executed.
  const ranFlag = path.join(wt, 'RAN_VERIFY_FLAG');
  const dirtyScript = path.join(wt, 'test/dirty.test.mjs');
  fs.writeFileSync(dirtyScript, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(ranFlag)}, 'yes');\n`);
  const dirtyRes = runNode(TIER2_VERIFY, wt, ['main', '--verify', 'node --test test/dirty.test.mjs', '--json']);
  assert.equal(dirtyRes.status, 1);
  const dirtyReport = JSON.parse(dirtyRes.stdout);
  assert.equal(dirtyReport.clean, false);
  assert.deepEqual(dirtyReport.verifyResults, [], 'Verify command must NOT run when dirty precheck already fails');
  assert.equal(fs.existsSync(ranFlag), false);
  fs.rmSync(dirtyScript);

  // Clean commit: emits ADVISORY_SCOPE_DRIFT & ADVISE_ARCHIVE_STALE, still passes without --strict-scope
  const advRes = runNode(TIER2_VERIFY, wt, ['main', '--change-dir', chg, '--json']);
  assert.equal(advRes.status, 0, advRes.stderr + advRes.stdout);
  const advReport = JSON.parse(advRes.stdout);
  assert.deepEqual(advReport.scopeDrift, ['src/extra.mjs']);
  assert.ok(advReport.advisories.some((a) => a.startsWith('ADVISORY_SCOPE_DRIFT:')));
  assert.ok(advReport.advisories.some((a) => a.startsWith('ADVISE_ARCHIVE_STALE:')));

  // With --strict-scope, out-of-scope edits fail FAIL without running Verify
  const strictRes = runNode(TIER2_VERIFY, wt, ['main', '--change-dir', chg, '--strict-scope', '--json']);
  assert.equal(strictRes.status, 1);
  const strictReport = JSON.parse(strictRes.stdout);
  assert.equal(strictReport.verdict, 'FAIL');
  assert.deepEqual(strictReport.verifyResults, []);

  // prepare-author also reports stale changes
  const prep = runNode(PIPELINE_RUN, wt, ['prepare-author', chg, '--schema', 'paseo-tier2', '--json']);
  assert.equal(prep.status, 0, prep.stderr + prep.stdout);
  const prepJson = JSON.parse(prep.stdout);
  assert.match(prepJson.staleAdvisory, /ADVISE_ARCHIVE_STALE: 4 other unarchived/);
});

test('P1 record-review, hydrate, and brief tier2 --task slice relay integrate cleanly', (t) => {
  const root = makeRepo(t);
  const wt = `${root}-slice`;
  git(root, 'worktree', 'add', '-q', '-b', 'feat/slice', wt);
  t.after(() => fs.rmSync(wt, { recursive: true, force: true }));

  const chg = path.join(wt, 'openspec', 'changes', 'heavy-chg');
  makeTier2Change(wt, chg, {
    tasksMd: [
      '# Tasks',
      '',
      '- [x] 1.1 T-01 Done upstream slice',
      '  - Write scope: src/a.mjs',
      '  - Interface: src/a.mjs#val',
      '  - Entry: src/a.mjs#val',
      '  - Verify with: node --test test/a.test.mjs',
      '  - Scenarios: SCEN-CORE-01',
      '- [ ] 1.2 T-02 Active auth slice',
      '  - Depends on: T-01',
      '  - Write scope: src/auth/token.mjs, test/a.test.mjs',
      '  - Entry: src/auth/token.mjs#check',
      '  - Risk-surface: [auth]',
      '  - Verify with: node --test test/a.test.mjs',
      '  - Scenarios: SCEN-CORE-01',
    ].join('\n'),
  });
  fs.writeFileSync(path.join(chg, 'baseline-facts.md'), '# Baseline Facts\n- Fact: src/a.mjs:1 exports val()\n');
  fs.mkdirSync(path.join(wt, 'src/auth'), { recursive: true });
  fs.writeFileSync(path.join(wt, 'src/auth/token.mjs'), 'export const verifyToken = (x) => Boolean(x);\n');
  git(wt, 'add', '.');
  git(wt, 'commit', '-qm', 'heavy tier2 auth change');

  // Record handoff-progress.md in gitDir
  const gitDir = git(wt, 'rev-parse', '--path-format=absolute', '--git-dir');
  fs.writeFileSync(path.join(gitDir, 'handoff-progress.md'), 'Done: T-01 completed.\nNext: T-02 token check.\n');

  // Render Tier 2 single-slice relay prompt
  const briefRes = runNode(BRIEF, wt, ['tier2', '--change', 'heavy-chg', '--repo', wt, '--task', 'T-02', '--base', 'main', '--json']);
  assert.equal(briefRes.status, 0, briefRes.stderr + briefRes.stdout);
  const prompt = JSON.parse(briefRes.stdout).prompt;
  assert.match(prompt, /## Active Tier 2 Slice \(from tasks\.md\)/);
  assert.match(prompt, /Slice Task: T-02/);
  assert.match(prompt, /## Adversarial cases \(required, Risk-surface: \[auth\]\)/);
  assert.match(prompt, /## Claimed scenarios \(inlined from specs\/\)/);
  assert.match(prompt, /SCEN-CORE-01/);
  assert.match(prompt, /## Slice Progress \(from tasks\.md\)/);
  assert.match(prompt, /\[x\] S1 \(T-01\)/);
  assert.match(prompt, /\[ \] S2 \(T-02\)/);
  assert.match(prompt, /## Prior Progress \(handoff-progress\.md\)/);
  assert.match(prompt, /Done: T-01 completed/);
  assert.match(prompt, /## Baseline Facts \(Stage 0\/1 — JIT inlined\)/);
  assert.doesNotMatch(prompt, /task\/heavy-chg\/T-02/);

  // hydrate subcommand works standalone
  const hyd = runNode(PIPELINE_RUN, wt, ['hydrate', wt, '--json']);
  assert.equal(hyd.status, 0, hyd.stderr + hyd.stdout);
  assert.equal(JSON.parse(hyd.stdout).skippedReason, 'no-lockfile');

  // record-review --mode tier2 writes git-local ledger without dirtying worktree, and tier2-verify detects it
  const telFile = path.join(path.dirname(root), 'metrics.jsonl');
  const rec = runNode(PIPELINE_RUN, wt, ['record-review', '--mode', 'tier2', '--verdict', 'PASS', '--reviewer', 'anchasi-123', '--change-dir', chg, '--json'], { PIPELINE_TELEMETRY_FILE: telFile });
  // Wait: passing --change-dir writes review.md (which dirties wt if not committed), so test git-ledger mode WITHOUT --change-dir first!
  assert.equal(rec.status, 0, rec.stderr + rec.stdout);
  git(wt, 'add', path.join(chg, 'review.md'));
  git(wt, 'commit', '-qm', 'record review');

  const recGitOnly = runNode(PIPELINE_RUN, wt, ['record-review', '--mode', 'tier2', '--verdict', 'PASS', '--reviewer', 'anchasi-uuid-999', '--json'], { PIPELINE_TELEMETRY_FILE: telFile });
  assert.equal(recGitOnly.status, 0, recGitOnly.stderr + recGitOnly.stdout);
  assert.equal(git(wt, 'status', '--porcelain=v1'), '', 'git-local review ledger must keep worktree clean');

  const verifyOut = runNode(TIER2_VERIFY, wt, ['main', '--change-dir', chg, '--json'], { PIPELINE_TELEMETRY_FILE: telFile });
  assert.equal(verifyOut.status, 0, verifyOut.stderr + verifyOut.stdout);
  const vData = JSON.parse(verifyOut.stdout);
  assert.equal(vData.verdict, 'PASS');
  assert.equal(vData.reviewSignoff?.verdict, 'PASS');
  assert.equal(vData.reviewSignoff?.reviewer, 'anchasi-uuid-999');
  assert.equal(vData.reviewSignoff?.sha, git(wt, 'rev-parse', 'HEAD'));
});

test('P1 author-guard detects paseo-tier2 without proposal.md and tier-session-hook emits worktree compact redline', (t) => {
  const root = makeRepo(t);
  const wt = `${root}-t2ag`;
  git(root, 'worktree', 'add', '-q', '-b', 'feat/t2-ag', wt);
  t.after(() => fs.rmSync(wt, { recursive: true, force: true }));

  const chg = path.join(wt, 'openspec', 'changes', 't2-only');
  fs.mkdirSync(chg, { recursive: true });
  // NO proposal.md — only .openspec.yaml schema: paseo-tier2!
  fs.writeFileSync(path.join(chg, '.openspec.yaml'), 'schema: paseo-tier2\ncreated: 2026-11-22\n');

  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 't2-ag-state-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const telFile = path.join(stateDir, 'metrics.jsonl');
  const env = {
    ...process.env,
    PIPELINE_TIER_GATE_STATE: stateDir,
    PIPELINE_TELEMETRY_FILE: telFile,
    PIPELINE_AUTHOR_WARN_READS: '2',
    PIPELINE_AUTHOR_STOP_READS: '3',
  };

  const r1 = spawnSync(process.execPath, [TOOL_GUARD], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'rg val src/' }, cwd: wt, session_id: 's-t2-ag' }),
    encoding: 'utf8',
    env,
  });
  assert.equal(r1.status, 0);
  assert.equal(r1.stdout.trim(), '');

  const r2 = spawnSync(process.execPath, [TOOL_GUARD], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'cat package.json' }, cwd: wt, session_id: 's-t2-ag' }),
    encoding: 'utf8',
    env,
  });
  assert.match(r2.stdout, /specs\/<cap>\/spec\.md/);

  // Compact in linked worktree triggers BOTH author-guard empty-specs notice AND worktree compact redline
  const compact = spawnSync(process.execPath, [SESSION_HOOK], {
    input: JSON.stringify({ source: 'compact', cwd: wt, session_id: 's-t2-ag' }),
    encoding: 'utf8',
    env,
  });
  assert.equal(compact.status, 0);
  assert.match(compact.stdout, /\[author-guard\] Context compacted/);
  assert.match(compact.stdout, /\[worktree-compact\]/);
  assert.match(compact.stdout, /git commit -m\/-F/);
  assert.match(compact.stdout, /2 次压缩/);
  assert.doesNotMatch(compact.stdout, /分级规则·会话级/);
});

test('P1 tier-gate blocks giant >=800-line files, >5 test blast files, and linked-worktree zero-write stalls', (t) => {
  const root = makeRepo(t);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-v3-state-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const prevState = process.env.PIPELINE_TIER_GATE_STATE;
  const prevZero = process.env.PIPELINE_TIER_GATE_ZERO_WRITE_TURNS;
  process.env.PIPELINE_TIER_GATE_STATE = stateDir;
  process.env.PIPELINE_TIER_GATE_ZERO_WRITE_TURNS = '4';
  t.after(() => {
    if (prevState === undefined) delete process.env.PIPELINE_TIER_GATE_STATE; else process.env.PIPELINE_TIER_GATE_STATE = prevState;
    if (prevZero === undefined) delete process.env.PIPELINE_TIER_GATE_ZERO_WRITE_TURNS; else process.env.PIPELINE_TIER_GATE_ZERO_WRITE_TURNS = prevZero;
  });

  // Giant existing file >= 800 lines -> ask (large_file)
  const giant = path.join(root, 'src', 'huge.mjs');
  fs.writeFileSync(giant, Array.from({ length: 820 }, (_, i) => `export const x${i} = ${i};`).join('\n'));
  const vGiant = assessTierGate({ target: giant, sessionId: 's-giant' });
  assert.equal(vGiant.verdict, 'ask');
  assert.equal(vGiant.reasonCode, 'large_file');
  assert.match(vGiant.reason, /≥800 行/);

  // Test blast: 5 test files allowed, 6th triggers ask (test_blast)
  for (let i = 1; i <= 5; i += 1) {
    const vTest = assessTierGate({ target: path.join(root, 'test', `f${i}.test.mjs`), sessionId: 's-tests' });
    assert.equal(vTest.verdict, 'allow', `test ${i} should allow`);
  }
  const vBlast = assessTierGate({ target: path.join(root, 'test', 'f6.test.mjs'), sessionId: 's-tests' });
  assert.equal(vBlast.verdict, 'ask');
  assert.equal(vBlast.reasonCode, 'test_blast');

  // Linked worktree zero-write stall with active change: 3 zero-write turns ok, 4th blocks; write resets counter
  const wt = `${root}-zw`;
  git(root, 'worktree', 'add', '-q', '-b', 'feat/zw', wt);
  t.after(() => fs.rmSync(wt, { recursive: true, force: true }));
  const wtReal = fs.realpathSync(wt);
  fs.mkdirSync(path.join(wtReal, 'openspec/changes/zw-chg'), { recursive: true });
  for (let turn = 1; turn <= 3; turn += 1) {
    takeSnapshot({ cwd: wtReal, sessionId: 's-zw' });
    assert.equal(assessStop({ cwd: wtReal, sessionId: 's-zw' }).verdict, 'ok', `turn ${turn}`);
  }
  takeSnapshot({ cwd: wtReal, sessionId: 's-zw' });
  const vStall = assessStop({ cwd: wtReal, sessionId: 's-zw' });
  assert.equal(vStall.verdict, 'block');
  assert.equal(vStall.reasonCode, 'zero_write_stall');
  assert.match(vStall.reason, /handoff-progress\.md/);
});

test('P0 telemetry prevents default-file writes in test runner context and report summarizes cross-tier north-star metrics', (t) => {
  // Test with PIPELINE_TELEMETRY_FILE unset to verify NODE_TEST_CONTEXT blocks writes to the default global metrics file
  const savedEnvFile = process.env.PIPELINE_TELEMETRY_FILE;
  delete process.env.PIPELINE_TELEMETRY_FILE;
  t.after(() => {
    if (savedEnvFile !== undefined) process.env.PIPELINE_TELEMETRY_FILE = savedEnvFile;
  });
  const defaultFile = telemetryFile();
  const beforeSize = fs.existsSync(defaultFile) ? fs.statSync(defaultFile).size : 0;
  const written = recordEvent('tier_write', { action: 'ask', reasonCode: 'large_file' });
  assert.equal(written, false);
  const afterSize = fs.existsSync(defaultFile) ? fs.statSync(defaultFile).size : 0;
  assert.equal(afterSize, beforeSize, 'NODE_TEST_CONTEXT must not write to default harness-metrics.jsonl');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tel-v3-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const mf = path.join(tmp, 'metrics.jsonl');
  recordEvent('freeze_check', { tier: '3', ok: true, verdict: 'pipeline', count: 5 }, { file: mf });
  recordEvent('freeze_check', { tier: '3', ok: true, verdict: 'handoff', count: 3 }, { file: mf });
  recordEvent('merge_task', { tier: '3', ok: true, exit: 0, durationMs: 1200 }, { file: mf });
  recordEvent('cp2_merge', { tier: '3', ok: true, verdict: 'drift_synced', count: 1 }, { file: mf });
  recordEvent('review_verdict', { tier: '2', verdict: 'pass', role: 'tier2' }, { file: mf });

  const sum = summarizeTelemetry({ days: 30, file: mf });
  assert.equal(sum.freezeCheck.total, 2);
  assert.equal(sum.northStar.tier3HandoffRate, 50);
  assert.equal(sum.northStar.mergePassRate, 100);
  assert.ok(sum.pruneCandidates.includes('worktree_cd_primary'));

  const rep = runNode(PIPELINE_RUN, tmp, ['report', '--days', '30'], { PIPELINE_TELEMETRY_FILE: mf });
  assert.equal(rep.status, 0);
  assert.match(rep.stdout, /- freeze_check: total=2 pipeline=1 handoff=1/);
  assert.match(rep.stdout, /- north_star:/);
  assert.match(rep.stdout, /- prune_candidates \(30d 0-hit\):/);
});

test('M3 prepare-author --schema paseo-tier2 --scaffold creates collision-free skeleton idempotently without proposal.md', (t) => {
  const root = makeRepo(t);
  const existing = path.join(root, 'openspec', 'changes', 'old-billing');
  fs.mkdirSync(path.join(existing, 'specs', 'billing-ui'), { recursive: true });
  fs.writeFileSync(
    path.join(existing, 'specs', 'billing-ui', 'spec.md'),
    '### Requirement: Legacy\nThe system SHALL work.\n#### Scenario: SCEN-BIUI-04 existing\n- **WHEN** x\n- **THEN** y\n',
  );
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'existing change with SCEN-BIUI-04');

  const wt = `${root}-scaff`;
  git(root, 'worktree', 'add', '-q', '-b', 'feat/scaff', wt);
  t.after(() => fs.rmSync(wt, { recursive: true, force: true }));

  const chg = path.join(wt, 'openspec', 'changes', 'new-billing-flow');
  fs.mkdirSync(chg, { recursive: true });
  fs.writeFileSync(path.join(chg, 'baseline-facts.md'), '# Baseline Facts\n\n- Manual verified fact: src/a.mjs:1\n');
  const first = runNode(PIPELINE_RUN, wt, [
    'prepare-author', chg, '--schema', 'paseo-tier2', '--scaffold', '--capability', 'billing-ui', '--json',
  ]);
  assert.equal(first.status, 0, first.stderr + first.stdout);
  const firstJson = JSON.parse(first.stdout);
  assert.deepEqual(firstJson.suggestedScenarios, ['SCEN-BIUI-05', 'SCEN-BIUI-06']);
  assert.ok(firstJson.scaffolded.includes('specs/billing-ui/spec.md'));
  assert.ok(firstJson.scaffolded.includes('tasks.md'));
  assert.equal(firstJson.nextCommands.length, 3);
  assert.equal(fs.existsSync(path.join(chg, 'proposal.md')), false);
  assert.equal(fs.existsSync(path.join(chg, 'acceptance.md')), false);
  assert.match(fs.readFileSync(path.join(chg, 'baseline-facts.md'), 'utf8'), /Manual verified fact: src\/a\.mjs:1/);

  const specPath = path.join(chg, 'specs', 'billing-ui', 'spec.md');
  const tasksPath = path.join(chg, 'tasks.md');
  assert.match(fs.readFileSync(specPath, 'utf8'), /SCEN-BIUI-05/);
  assert.match(fs.readFileSync(specPath, 'utf8'), /SCEN-BIUI-06/);
  assert.match(fs.readFileSync(tasksPath, 'utf8'), /SCEN-BIUI-05/);
  assert.match(fs.readFileSync(tasksPath, 'utf8'), /SCEN-BIUI-06/);

  // Sequential scaffold with same derived prefix avoids same-change collisions
  const siblingCap = runNode(PIPELINE_RUN, wt, [
    'prepare-author', chg, '--schema', 'paseo-tier2', '--scaffold', '--capability', 'billing-uikit', '--json',
  ]);
  assert.equal(siblingCap.status, 0, siblingCap.stderr + siblingCap.stdout);
  const siblingJson = JSON.parse(siblingCap.stdout);
  assert.deepEqual(siblingJson.suggestedScenarios, ['SCEN-BIUI-07', 'SCEN-BIUI-08']);
  assert.match(fs.readFileSync(path.join(chg, 'specs', 'billing-uikit', 'spec.md'), 'utf8'), /SCEN-BIUI-07/);

  // Idempotent on second run: preserves user edits to spec.md and tasks.md
  fs.writeFileSync(specPath, '# customized spec\n');
  fs.writeFileSync(tasksPath, '# customized tasks\n');
  const second = runNode(PIPELINE_RUN, wt, [
    'prepare-author', chg, '--schema', 'paseo-tier2', '--scaffold', '--capability', 'billing-ui',
  ]);
  assert.equal(second.status, 0, second.stderr + second.stdout);
  assert.match(second.stdout, /Next commands:/);
  assert.match(second.stdout, /tier2-verify/);
  assert.equal(fs.readFileSync(specPath, 'utf8'), '# customized spec\n');
  assert.equal(fs.readFileSync(tasksPath, 'utf8'), '# customized tasks\n');

  const reviewBrief = runNode(BRIEF, wt, ['tier2-review', '--change', 'new-billing-flow', '--repo', wt, '--base', 'main', '--json']);
  assert.equal(reviewBrief.status, 0, reviewBrief.stderr + reviewBrief.stdout);
  const reviewPrompt = JSON.parse(reviewBrief.stdout).prompt;
  assert.match(reviewPrompt, /Never use the built-in `Agent` tool/);
  assert.doesNotMatch(reviewPrompt, /\b(?:sonnet|opus|haiku|gpt-[\w.]+|claude-[\w.]+|codex\/)/i);
});

test('P0-2 tier2-verify handles BLOCKED/INCOMPLETE/HUMAN_ACCEPT and signoffOnlyCommit ancestor tolerance', (t) => {
  const root = makeRepo(t);
  const wt = `${root}-signoff`;
  git(root, 'worktree', 'add', '-q', '-b', 'feat/t2-signoff', wt);
  t.after(() => fs.rmSync(wt, { recursive: true, force: true }));

  const chg = path.join(wt, 'openspec', 'changes', 'sig-chg');
  makeTier2Change(wt, chg);
  fs.mkdirSync(path.join(wt, 'src/auth'), { recursive: true });
  fs.writeFileSync(path.join(wt, 'src/auth/token.mjs'), 'export const token = () => 1;\n');
  git(wt, 'add', '.');
  git(wt, 'commit', '-qm', 'auth change');

  const telFile = path.join(path.dirname(root), 'metrics-signoff.jsonl');
  // INCOMPLETE leaves REVIEW_REQUIRED
  assert.equal(runNode(PIPELINE_RUN, wt, ['record-review', '--mode', 'tier2', '--verdict', 'INCOMPLETE', '--reviewer', 'anchasi-1', '--json'], { PIPELINE_TELEMETRY_FILE: telFile }).status, 0);
  const incRes = runNode(TIER2_VERIFY, wt, ['main', '--change-dir', chg, '--json'], { PIPELINE_TELEMETRY_FILE: telFile });
  assert.equal(incRes.status, 0);
  assert.equal(JSON.parse(incRes.stdout).verdict, 'REVIEW_REQUIRED');

  // BLOCKED forces FAIL (exit 1)
  assert.equal(runNode(PIPELINE_RUN, wt, ['record-review', '--mode', 'tier2', '--verdict', 'BLOCKED', '--reviewer', 'anchasi-1', '--reason', 'missing check', '--json'], { PIPELINE_TELEMETRY_FILE: telFile }).status, 0);
  const blkRes = runNode(TIER2_VERIFY, wt, ['main', '--change-dir', chg, '--json'], { PIPELINE_TELEMETRY_FILE: telFile });
  assert.equal(blkRes.status, 1);
  assert.equal(JSON.parse(blkRes.stdout).verdict, 'FAIL');

  // HUMAN_ACCEPT written to review.md + committed together with rulings.md / evidence/* still satisfies PASS via signoffOnlyCommit
  assert.equal(runNode(PIPELINE_RUN, wt, ['record-review', '--mode', 'tier2', '--verdict', 'HUMAN_ACCEPT', '--reviewer', 'human', '--change-dir', chg, '--reason', 'accepted', '--json'], { PIPELINE_TELEMETRY_FILE: telFile }).status, 0);
  fs.writeFileSync(path.join(chg, 'rulings.md'), '- accepted\n');
  fs.mkdirSync(path.join(chg, 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(chg, 'evidence', 'note.txt'), 'ok\n');
  git(wt, 'add', '.');
  git(wt, 'commit', '-qm', 'commit review, rulings, and evidence');

  const okRes = runNode(TIER2_VERIFY, wt, ['main', '--change-dir', chg, '--json'], { PIPELINE_TELEMETRY_FILE: telFile });
  assert.equal(okRes.status, 0, okRes.stderr + okRes.stdout);
  const okJson = JSON.parse(okRes.stdout);
  assert.equal(okJson.verdict, 'PASS');
  assert.equal(okJson.reviewSignoff?.verdict, 'HUMAN_ACCEPT');
});

test('P1-4 & P1-5 author-guard ignores unfilled scaffold tasks.md and cp2-merge enforces Done tasks and FINAL signoff', (t) => {
  const root = makeRepo(t);
  const wt = `${root}-ag`;
  git(root, 'worktree', 'add', '-q', '-b', 'feat/ag-scaffold', wt);
  t.after(() => fs.rmSync(wt, { recursive: true, force: true }));

  const telFile = path.join(path.dirname(root), 'metrics-cp2.jsonl');
  const chg = path.join(wt, 'openspec', 'changes', 'scaf-chg');
  const prep = runNode(PIPELINE_RUN, wt, ['prepare-author', chg, '--schema', 'paseo-tier2', '--scaffold', '--capability', 'pay', '--json'], { PIPELINE_TELEMETRY_FILE: telFile });
  assert.equal(prep.status, 0, prep.stderr + prep.stdout);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-scaf-state-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const prevState = process.env.PIPELINE_TIER_GATE_STATE;
  process.env.PIPELINE_TIER_GATE_STATE = stateDir;
  try {
    assert.equal(detectActiveAuthorChange(wt)?.change, 'scaf-chg');
    const res = recordAuthorRead({ cwd: wt, sessionId: 'ag-scaf-1', command: 'rg val src/' });
    assert.equal(res.readCount, 1, 'unfilled scaffold tasks.md should keep change in authoring mode');
    const tasksFile = path.join(chg, 'tasks.md');
    fs.writeFileSync(
      tasksFile,
      fs.readFileSync(tasksFile, 'utf8')
        .replaceAll('path/to/file.mjs', 'src/a.mjs')
        .replaceAll('<一句话目标>', 'Pay flow'),
    );
    assert.equal(detectActiveAuthorChange(wt), null, 'filled tasks.md closes authoring mode');
  } finally {
    if (prevState === undefined) delete process.env.PIPELINE_TIER_GATE_STATE;
    else process.env.PIPELINE_TIER_GATE_STATE = prevState;
  }

  // cp2-merge gate checks Done tasks & FINAL signoff
  const cRoot = makeRepo(t);
  const cDir = path.join(cRoot, 'openspec/changes/gate-chg');
  fs.mkdirSync(path.join(cDir, 'specs/core'), { recursive: true });
  fs.writeFileSync(path.join(cDir, '.openspec.yaml'), 'schema: paseo-pipeline\n');
  fs.writeFileSync(path.join(cDir, 'specs/core/spec.md'), '### Requirement: R1\nThe system SHALL work.\n#### Scenario: SCEN-G-01 ok\n- **WHEN** x\n- **THEN** y\n');
  fs.writeFileSync(path.join(cDir, 'tasks.md'), '- [ ] 1.1 T-01 pending\n  - Write scope: src/a.mjs\n  - Verify with: node --test test/a.test.mjs\n  - Scenarios: SCEN-G-01\n');
  git(cRoot, 'add', '.');
  git(cRoot, 'commit', '-qm', 'seed cp2');
  git(cRoot, 'branch', 'integration/gate-chg');
  const intWt = `${cRoot}-gate-int`;
  git(cRoot, 'worktree', 'add', '-q', intWt, 'integration/gate-chg');
  t.after(() => fs.rmSync(intWt, { recursive: true, force: true }));

  const incomplete = runNode(PIPELINE_RUN, cRoot, ['cp2-merge', 'openspec/changes/gate-chg', '--json'], { PIPELINE_TELEMETRY_FILE: telFile });
  assert.equal(incomplete.status, 3);
  assert.match(incomplete.stderr, /incomplete tasks|Done before CP-2/);

  const sha = git(intWt, 'rev-parse', '--short=7', 'HEAD');
  fs.writeFileSync(path.join(intWt, 'openspec/changes/gate-chg/tasks.md'), `- [x] 1.1 T-01 done\n  - Write scope: src/a.mjs\n  - Verify with: node --test test/a.test.mjs\n  - Scenarios: SCEN-G-01\n  - Done: source=${sha} review=mechanical\n`);
  git(intWt, 'add', 'openspec/changes/gate-chg/tasks.md');
  git(intWt, 'commit', '-qm', 'done T-01');

  const noFinal = runNode(PIPELINE_RUN, cRoot, ['cp2-merge', 'openspec/changes/gate-chg', '--json'], { PIPELINE_TELEMETRY_FILE: telFile });
  assert.equal(noFinal.status, 3);
  assert.match(noFinal.stderr, /missing valid FINAL signoff/);

  const tip = git(intWt, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(intWt, 'openspec/changes/gate-chg/review.md'), `FINAL: blocked(anchasi-1@${tip}) — fix bug\n`);
  git(intWt, 'add', 'openspec/changes/gate-chg/review.md');
  git(intWt, 'commit', '-qm', 'final blocked');
  const blockedFinal = runNode(PIPELINE_RUN, cRoot, ['cp2-merge', 'openspec/changes/gate-chg', '--json'], { PIPELINE_TELEMETRY_FILE: telFile });
  assert.equal(blockedFinal.status, 3);
  assert.match(blockedFinal.stderr, /FINAL review is BLOCKED/);
});
