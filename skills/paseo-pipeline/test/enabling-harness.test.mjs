import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isTestPath } from '../lib/paths.mjs';
import { scanChanges } from '../lib/risk-scan.mjs';
import { assessStop, takeSnapshot } from '../lib/tier-gate.mjs';
import { proveVerifyCommand } from '../lib/verify-policy.mjs';
import { listWorktrees } from '../lib/git.mjs';
import { recordEvent, summarizeTelemetry } from '../lib/telemetry.mjs';
import * as paseo from '../lib/paseo.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PIPELINE_DIR = path.resolve(here, '..');
const PIPELINE_RUN = path.join(PIPELINE_DIR, 'pipeline-run.mjs');
const TIER2_VERIFY = path.join(PIPELINE_DIR, 'tier2-verify.mjs');
const TOOL_GUARD = path.join(PIPELINE_DIR, 'hooks', 'tool-guard-hook.mjs');
const BRIEF = path.join(PIPELINE_DIR, 'brief.mjs');

const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const runNode = (script, cwd, args = [], extraEnv = {}) =>
  spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...extraEnv } });

function makeRepo(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'enabling-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  fs.mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test User');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'test'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/a.js'), 'export const a = () => 1;\n');
  fs.writeFileSync(path.join(root, 'test/a.test.js'), 'import test from "node:test"; import assert from "node:assert/strict"; test("ok", () => assert.equal(1, 1));\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'seed');
  return root;
}

function makeContractRepo(t) {
  const root = makeRepo(t);
  const seedSha = git(root, 'rev-parse', 'HEAD').slice(0, 7);
  fs.mkdirSync(path.join(root, 'openspec'), { recursive: true });
  fs.writeFileSync(path.join(root, 'openspec/config.yaml'), 'schema: spec-driven\n');
  const chg = path.join(root, 'openspec/changes/c1');
  fs.mkdirSync(path.join(chg, 'specs/core'), { recursive: true });
  fs.writeFileSync(path.join(chg, 'proposal.md'), '## Why\nFix behavior.\n\n## What Changes\n- Update core.\n');
  fs.writeFileSync(
    path.join(chg, 'specs/core/spec.md'),
    [
      '## ADDED Requirements',
      '',
      '### Requirement: R1 Core invariant',
      'The system SHALL preserve the invariant.',
      '#### Scenario: SCEN-C1-01 Basic check',
      '- **GIVEN** seeded repo',
      '- **WHEN** invoked',
      '- **THEN** returns 42 cleanly',
      '- **Verify:** `node --test test/a.test.js`',
      '',
      '#### Scenario: SCEN-C1-02 Dependent check',
      '- **GIVEN** upstream T-01 is merged',
      '- **WHEN** consumer runs',
      '- **THEN** uses upstream interface',
      '- **Verify:** `node --test test/a.test.js`',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(chg, 'tasks.md'),
    [
      '# Tasks',
      '',
      '- [x] 1.1 T-01 Upstream core',
      '  - Scen: SCEN-C1-01',
      '  - Write scope: src/a.js',
      '  - Interface: src/a.js#a',
      '  - Verify with: node --test test/a.test.js',
      `  - Done: source=${seedSha} review=pass(0000000@${seedSha}/${seedSha})`,
      '',
      '- [ ] 1.2 T-02 Downstream consumer',
      '  - Depends on: T-01',
      '  - Uses: T-01',
      '  - Scen: SCEN-C1-02',
      '  - Write scope: src/b.js,test/b.test.js',
      '  - Verify with: node --test test/b.test.js',
      '',
    ].join('\n'),
  );
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'contract');
  git(root, 'branch', 'integration/c1');
  return { root, chg };
}

test('lib/paths + risk-scan catch snapshot, fixture, python skip, and scripts/specs oracle edits', () => {
  assert.equal(isTestPath('src/__snapshots__/card.snap'), true);
  assert.equal(isTestPath('pkg/testdata/golden.json'), true);
  assert.equal(isTestPath('pkg/test_auth.py'), true);
  assert.equal(isTestPath('scripts/specs/check.mjs'), true);
  assert.equal(isTestPath('docs/specs/design.md'), false);

  const snapEdit = scanChanges({
    entries: [{ status: 'M', file: 'src/__snapshots__/card.snap' }],
    diffText: 'diff --git a/src/__snapshots__/card.snap b/src/__snapshots__/card.snap\n--- a/src/__snapshots__/card.snap\n+++ b/src/__snapshots__/card.snap\n@@ -1 +1 @@\n-old snapshot\n+new snapshot',
  });
  assert.equal(snapEdit.reviewRequired, true);
  assert.equal(snapEdit.testMutations.length, 1);

  const pySkip = scanChanges({
    entries: [{ status: 'M', file: 'pkg/test_auth.py' }],
    diffText: 'diff --git a/pkg/test_auth.py b/pkg/test_auth.py\n--- a/pkg/test_auth.py\n+++ b/pkg/test_auth.py\n@@ -1 +1 @@\n def test_login():\n+@pytest.mark.skip\n+    pass',
  });
  assert.equal(pySkip.reviewRequired, true);
  assert.equal(pySkip.testMutations.length, 1);

  const specScriptDel = scanChanges({
    entries: [{ status: 'D', file: 'scripts/specs/check.mjs' }],
  });
  assert.equal(specScriptDel.reviewRequired, true);
  assert.match(specScriptDel.testMutations[0].reason, /deleted/);
});

test('tier-gate Stop catches Tier 1 risky edits once while ignoring pre-existing dirty files, and retains churn in linked worktrees', (t) => {
  const root = makeRepo(t);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tier-sentinel-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const prev = process.env.PIPELINE_TIER_GATE_STATE;
  const prevTel = process.env.PIPELINE_TELEMETRY;
  process.env.PIPELINE_TIER_GATE_STATE = stateDir;
  process.env.PIPELINE_TELEMETRY = 'off';
  t.after(() => {
    if (prev === undefined) delete process.env.PIPELINE_TIER_GATE_STATE; else process.env.PIPELINE_TIER_GATE_STATE = prev;
    if (prevTel === undefined) delete process.env.PIPELINE_TELEMETRY; else process.env.PIPELINE_TELEMETRY = prevTel;
  });

  // Pre-existing dirty auth file created before snapshot must NOT false-positive when untouched this turn.
  fs.mkdirSync(path.join(root, 'src/auth'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/auth/preexisting.js'), 'export const old = 1;\n');
  takeSnapshot({ cwd: root, sessionId: 't1' });
  fs.writeFileSync(path.join(root, 'src/a.js'), 'export const a = () => 2;\n');
  const cleanTurn = assessStop({ cwd: root, sessionId: 't1' });
  assert.equal(cleanTurn.verdict, 'ok');

  // New turn modifying risky file triggers sentinel once.
  takeSnapshot({ cwd: root, sessionId: 't1' });
  fs.writeFileSync(path.join(root, 'src/auth/new_token.js'), 'export const check = () => true;\n');
  const riskyTurn = assessStop({ cwd: root, sessionId: 't1' });
  assert.equal(riskyTurn.verdict, 'block');
  assert.match(riskyTurn.reason, /risk-scan|风险类别/);
  assert.match(riskyTurn.reason, /auth/);

  // After user turn snapshot with no new edits (or clean edit elsewhere), untouched risky file does not re-trigger.
  takeSnapshot({ cwd: root, sessionId: 't1' });
  assert.equal(assessStop({ cwd: root, sessionId: 't1' }).verdict, 'ok');
  takeSnapshot({ cwd: root, sessionId: 't1' });
  fs.writeFileSync(path.join(root, 'src/other.js'), 'export const o = 1;\n');
  assert.equal(assessStop({ cwd: root, sessionId: 't1' }).verdict, 'ok');

  // Linked worktree skips file-count/scope caps, keeps 3-turn churn detection.
  const wt = `${root}-wt`;
  git(root, 'worktree', 'add', '-q', '-b', 'feat/wt', wt);
  const wtReal = fs.realpathSync(wt);
  takeSnapshot({ cwd: wtReal, sessionId: 'w1' });
  for (const name of ['f1.js', 'f2.js', 'f3.js', 'f4.js', 'f5.js']) {
    fs.writeFileSync(path.join(wtReal, 'src', name), 'export const x = 1;\n');
  }
  assert.equal(assessStop({ cwd: wtReal, sessionId: 'w1' }).verdict, 'ok');

  // Repeat edits solely to existing src/a.js across 3 turns -> round 2 ok, round 3 blocks on churn.
  for (let round = 1; round <= 3; round += 1) {
    takeSnapshot({ cwd: wtReal, sessionId: 'w-churn' });
    fs.writeFileSync(path.join(wtReal, 'src/a.js'), `export const a = () => ${round + 10};\n`);
    const v = assessStop({ cwd: wtReal, sessionId: 'w-churn' });
    if (round < 3) assert.equal(v.verdict, 'ok', `round ${round}`);
    else {
      assert.equal(v.verdict, 'block');
      assert.match(v.reason, /连续 3 轮/);
    }
  }
});

test('tool-guard-hook incremental cache stays exact across appends/rewrites and warns on cd into primary checkout from worktree', (t) => {
  const root = makeRepo(t);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cache-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const wt = path.join(path.dirname(root), 'wt with space');
  git(root, 'worktree', 'add', '-q', '-b', 'feat/cd-warn', wt);
  const wtReal = fs.realpathSync(wt);

  const guard = (payload) => {
    const out = spawnSync(process.execPath, [TOOL_GUARD], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      env: { ...process.env, PIPELINE_TIER_GATE_STATE: stateDir, PIPELINE_TELEMETRY: 'off' },
    });
    assert.equal(out.status, 0, out.stderr);
    return out.stdout ? JSON.parse(out.stdout).hookSpecificOutput : {};
  };

  // Worktree Bash cd / git -C to primary checkout triggers ExitWorktree advisory without denying; inside worktree does not.
  const warn = guard({ cwd: wtReal, tool_name: 'Bash', tool_input: { command: `cd ${JSON.stringify(root)} && git status` } });
  assert.match(warn.additionalContext, /avoid `cd` into the shared primary checkout/);
  assert.match(warn.additionalContext, /ExitWorktree/);
  assert.doesNotMatch(warn.additionalContext, /Use `git -C <abs-path>`/);
  assert.equal(warn.permissionDecision, undefined);

  const gitCWarn = guard({ cwd: wtReal, tool_name: 'Bash', tool_input: { command: `git -C ${JSON.stringify(root)} status --short` } });
  assert.match(gitCWarn.additionalContext, /ExitWorktree/);
  assert.equal(gitCWarn.permissionDecision, undefined);

  const safeInside = guard({ cwd: wtReal, tool_name: 'Bash', tool_input: { command: `cd ${JSON.stringify(path.join(wtReal, 'src'))} && pwd` } });
  assert.deepEqual(safeInside, {});

  const safeOwnGitC = guard({ cwd: wtReal, tool_name: 'Bash', tool_input: { command: `git -C ${JSON.stringify(wtReal)} status --short` } });
  assert.deepEqual(safeOwnGitC, {});

  // Incremental cache correctness on append and rewrite.
  const transcript = path.join(stateDir, 'transcript.jsonl');
  const pair = (id, isError) => [
    JSON.stringify({ message: { content: [{ type: 'tool_use', id, name: 'mcp__example__x', input: { k: 1 } }] } }),
    JSON.stringify({ message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError }] } }),
  ];
  fs.writeFileSync(transcript, [...pair('1', true), ...pair('2', true)].join('\n'));
  assert.deepEqual(guard({ tool_name: 'mcp__example__x', tool_input: { k: 1 }, transcript_path: transcript }), {});

  // Append 3rd failure incrementally -> triggers deny.
  fs.appendFileSync(transcript, `\n${pair('3', true).join('\n')}`);
  assert.equal(guard({ tool_name: 'mcp__example__x', tool_input: { k: 1 }, transcript_path: transcript }).permissionDecision, 'deny');

  // Rewriting transcript with success at the start clears denial even when cached earlier.
  fs.writeFileSync(transcript, pair('4', false).join('\n'));
  assert.deepEqual(guard({ tool_name: 'mcp__example__x', tool_input: { k: 1 }, transcript_path: transcript }), {});

  // Boundary case: cache snapshot lands between tool_use and its tool_result across reloads.
  const splitTranscript = path.join(stateDir, 'split-transcript.jsonl');
  const useLine = (id) => JSON.stringify({ message: { content: [{ type: 'tool_use', id, name: 'mcp__example__split', input: { k: 9 } }] } });
  const resLine = (id, isError) => JSON.stringify({ message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError }] } });
  fs.writeFileSync(splitTranscript, `${useLine('s1')}\n`);
  assert.deepEqual(guard({ tool_name: 'mcp__example__split', tool_input: { k: 9 }, transcript_path: splitTranscript }), {});
  fs.appendFileSync(splitTranscript, `${resLine('s1', true)}\n${useLine('s2')}\n`);
  assert.deepEqual(guard({ tool_name: 'mcp__example__split', tool_input: { k: 9 }, transcript_path: splitTranscript }), {});
  fs.appendFileSync(splitTranscript, `${resLine('s2', true)}\n${useLine('s3')}\n`);
  assert.deepEqual(guard({ tool_name: 'mcp__example__split', tool_input: { k: 9 }, transcript_path: splitTranscript }), {});
  fs.appendFileSync(splitTranscript, `${resLine('s3', true)}\n`);
  assert.equal(guard({ tool_name: 'mcp__example__split', tool_input: { k: 9 }, transcript_path: splitTranscript }).permissionDecision, 'deny');
});

test('lib/verify-policy + tier2-verify reject spoofed Verify commands without executing them', (t) => {
  for (const okCmd of ['node --test test/a.test.js', 'bash test/run-all.sh', 'npm test', 'npm run typecheck', 'npm run test:expense', 'npm run web:test', 'pnpm run web:test', 'npx tsc --noEmit', 'node --test test/a.test.js && npm test']) {
    assert.equal(proveVerifyCommand(okCmd).ok, true, okCmd);
  }
  for (const badCmd of ['true', 'echo ok || true', 'node -e "process.exit(0)"', 'bash -c "true"', 'eval "npm test"', 'node --test test/a.test.js | tail', 'npm run noop', 'npm run', 'pnpm run dev', 'yarn run hello', 'bun run start']) {
    assert.equal(proveVerifyCommand(badCmd).ok, false, badCmd);
  }

  const root = makeRepo(t);
  const wt = `${root}-wt-verify`;
  git(root, 'worktree', 'add', '-q', '-b', 'feat/spoof', wt);
  fs.writeFileSync(path.join(wt, 'src/a.js'), 'export const a = () => 2;\n');
  git(wt, 'add', 'src/a.js');
  git(wt, 'commit', '-q', '-m', 'update');

  const marker = path.join(wt, 'SHOULD_NOT_RUN');
  const res = runNode(TIER2_VERIFY, wt, ['main', '--verify', `node -e "require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')"`, '--json'], { PIPELINE_TELEMETRY: 'off' });
  assert.equal(res.status, 1, res.stderr + res.stdout);
  const data = JSON.parse(res.stdout);
  assert.equal(data.verdict, 'FAIL');
  assert.equal(data.unprovableVerify.length, 1);
  assert.equal(fs.existsSync(marker), false, 'unprovable Verify command must never execute');
});

test('lib/git listWorktrees handles spaces via -z and lib/paseo exports Paseo helpers', (t) => {
  const root = makeRepo(t);
  const spacedWt = path.join(path.dirname(root), 'wt spaced dir');
  git(root, 'worktree', 'add', '-q', '-b', 'feat/space', spacedWt);
  const trees = listWorktrees(root);
  assert.ok(trees.some((tree) => fs.realpathSync(tree.path) === fs.realpathSync(spacedWt) && tree.branch === 'feat/space'));

  assert.equal(typeof paseo.listAgents, 'function');
  assert.equal(typeof paseo.inspectAgent, 'function');
  assert.equal(typeof paseo.listPaseoAgents, 'function');
  assert.equal(typeof paseo.inspectPaseoAgent, 'function');
});

test('pipeline-run facade supports inspect, prepare-task --workspace-dir / --hydrate, and brief JIT compiles SCEN + diffstat safely', (t) => {
  const { root, chg } = makeContractRepo(t);

  // Unified inspect facade
  const ins = runNode(PIPELINE_RUN, root, ['inspect', chg, '--json']);
  assert.equal(ins.status, 0, ins.stderr + ins.stdout);
  const insData = JSON.parse(ins.stdout);
  assert.equal(insData.ok, true);
  assert.equal(insData.scenarios.scenarios.length, 2);
  assert.equal(insData.hotspots.tasks.length, 2);

  // prepare-task with pre-created --workspace-dir and --hydrate
  const wt = path.join(path.dirname(root), 'premade-wt');
  git(root, 'worktree', 'add', '-q', '--detach', wt, 'HEAD');
  const prep = runNode(PIPELINE_RUN, root, ['prepare-task', chg, 'T-02', '--workspace-dir', wt, '--hydrate', '--json']);
  assert.equal(prep.status, 0, prep.stderr + prep.stdout);
  const prepData = JSON.parse(prep.stdout);
  assert.equal(fs.realpathSync(prepData.worktree), fs.realpathSync(wt));
  assert.equal(git(wt, 'branch', '--show-current'), 'task/c1/T-02');
  assert.equal(prepData.hydration.attempted, false);
  assert.equal(prepData.hydration.skippedReason, 'no-package-json');
  // JIT inlined SCEN-C1-02 body and upstream T-01 interface metadata
  assert.match(prepData.prompt, /## Claimed scenarios \(inlined from specs\/\)/);
  assert.match(prepData.prompt, /SCEN-C1-02 Dependent check/);
  assert.match(prepData.prompt, /returns? 42|uses upstream interface/);
  assert.match(prepData.prompt, /## Upstream interfaces \(Depends \/ Uses\)/);
  assert.match(prepData.prompt, /T-01 Interface: src\/a\.js#a/);

  // Reviewer JIT diffstat does not trip model-id guard even when claude/CLAUDE.md is changed
  const baseSha = git(root, 'rev-parse', 'HEAD');
  const rw = `${root}-rev`;
  git(root, 'worktree', 'add', '-q', '-b', 'feat/claude-doc', rw);
  fs.mkdirSync(path.join(rw, 'claude'), { recursive: true });
  fs.writeFileSync(path.join(rw, 'claude/CLAUDE.md'), '# Rules\n');
  git(rw, 'add', 'claude/CLAUDE.md');
  git(rw, 'commit', '-q', '-m', 'docs: update claude/CLAUDE.md');
  const revBrief = runNode(BRIEF, rw, ['tier2-review', '--repo', rw, '--base', baseSha, '--json']);
  assert.equal(revBrief.status, 0, revBrief.stderr + revBrief.stdout);
  const revPrompt = JSON.parse(revBrief.stdout).prompt;
  assert.match(revPrompt, /## Diff summary \(git diff --stat/);
  assert.match(revPrompt, /claude\/CLAUDE\.md/);
});

test('lib/telemetry records bounded fail-open events and pipeline-run report summarizes them', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const metricsFile = path.join(dir, 'metrics.jsonl');

  assert.equal(recordEvent('tier2_verify', { verdict: 'PASS', durationMs: 120, riskClasses: ['auth', 'concurrency', 'money', 'persistence', 'external-write'], reasonCode: 'x'.repeat(60) }, { file: metricsFile }), true);
  assert.equal(recordEvent('tier2_verify', { verdict: 'FAIL', unprovableCount: 2, reasonCode: 'unprovable_verify' }, { file: metricsFile }), true);
  assert.equal(recordEvent('tool_guard', { action: 'rewrite', reasonCode: 'sanitize_workspace' }, { file: metricsFile }), true);
  assert.equal(recordEvent('tier_stop', { verdict: 'block', reasonCode: 'risk_sentinel' }, { file: metricsFile }), true);

  for (const line of fs.readFileSync(metricsFile, 'utf8').trim().split('\n')) {
    assert.ok(Buffer.byteLength(line, 'utf8') < 200, `line exceeded 200B: ${line}`);
  }

  // PIPELINE_TELEMETRY=off disables writing
  const prevOff = process.env.PIPELINE_TELEMETRY;
  process.env.PIPELINE_TELEMETRY = 'off';
  assert.equal(recordEvent('tool_guard', { action: 'deny' }, { file: metricsFile }), false);
  if (prevOff === undefined) delete process.env.PIPELINE_TELEMETRY; else process.env.PIPELINE_TELEMETRY = prevOff;

  // Fail-open when parent path is a file
  const blockerFile = path.join(dir, 'not-a-dir');
  fs.writeFileSync(blockerFile, 'x');
  assert.equal(recordEvent('worker_check', { ok: true }, { file: path.join(blockerFile, 'm.jsonl') }), false);

  const summary = summarizeTelemetry({ days: 7, file: metricsFile });
  assert.equal(summary.totalEvents, 4);
  assert.equal(summary.verify.pass, 1);
  assert.equal(summary.verify.fail, 1);
  assert.equal(summary.verify.unprovableRejections, 2);
  assert.equal(summary.hookActions.rewrite, 1);
  assert.equal(summary.stopBlocks.byReason.risk_sentinel, 1);

  const cliReport = runNode(PIPELINE_RUN, dir, ['report', '--days', '7', '--json'], { PIPELINE_TELEMETRY_FILE: metricsFile });
  assert.equal(cliReport.status, 0, cliReport.stderr + cliReport.stdout);
  assert.equal(JSON.parse(cliReport.stdout).totalEvents, 4);
});
