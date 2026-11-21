import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseTasks, entryForScenario, requiredForScenario } from '../lib/tasks.mjs';
import { isReadOnlyBash, recordAuthorRead } from '../lib/author-guard.mjs';
import { parseAcceptanceTable } from '../lib/acceptance.mjs';
import { summarizeTelemetry } from '../lib/telemetry.mjs';

const skillRoot = path.resolve(import.meta.dirname, '..');
const script = (name) => path.join(skillRoot, name);

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'tester',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 'tester',
      GIT_COMMITTER_EMAIL: 't@example.com',
    },
  }).trim();
}

function initRepo({ branch = 'main', withPackage = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-v2-'));
  git(dir, 'init', '-q', '-b', branch);
  if (withPackage) {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture', type: 'module' }));
    fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({ name: 'fixture', lockfileVersion: 3 }));
    fs.writeFileSync(path.join(dir, 'README.md'), 'fixture\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'init');
  }
  return dir;
}

test('Stage 0 prepare-author scaffolds baseline-facts.md, preserves Stage 1 body, and detects split entropy', () => {
  const repo = initRepo();
  const changeDir = path.join(repo, 'openspec', 'changes', 'demo');
  fs.mkdirSync(path.join(changeDir, 'specs', 'cap1', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(changeDir, 'proposal.md'), [
    '## Capabilities',
    '- `cap-one`',
    '## What Changes',
    ...Array.from({ length: 11 }, (_, i) => `- R${i + 1}: rule ${i + 1}`),
  ].join('\n'));
  fs.writeFileSync(path.join(changeDir, 'specs', 'cap1', 'spec.md'), '### Scenario: SCEN-CAP-01 a\n');
  fs.writeFileSync(path.join(changeDir, 'specs', 'cap1', 'nested', 'spec.md'), '### Scenario: SCEN-CAP-02 b\n');

  const res1 = spawnSync(process.execPath, [script('pipeline-run.mjs'), 'prepare-author', changeDir, '--json'], {
    cwd: repo,
    encoding: 'utf8',
  });
  assert.equal(res1.status, 0, res1.stderr + res1.stdout);
  const out1 = JSON.parse(res1.stdout);
  assert.equal(out1.splitRecommended, true);
  assert.ok(out1.splitReasons.some((r) => r.startsWith('rules=11>10')));
  assert.ok(!out1.splitReasons.some((r) => r.startsWith('capabilities=')), 'nested spec.md stays in 1 top-level capability');
  assert.ok(fs.existsSync(path.join(changeDir, '.openspec.yaml')));
  const factsPath = path.join(changeDir, 'baseline-facts.md');
  assert.ok(fs.existsSync(factsPath));

  // Add Stage 1 custom notes after STAGE0:END and re-run prepare-author: custom body must survive.
  const firstFacts = fs.readFileSync(factsPath, 'utf8');
  fs.writeFileSync(factsPath, firstFacts.replace('## Affected Existing Tests', '## Affected Existing Tests\n- custom Stage 1 note: src/a.mjs:10'));
  fs.mkdirSync(path.join(changeDir, 'specs', 'cap2'), { recursive: true });
  fs.mkdirSync(path.join(changeDir, 'specs', 'cap3'), { recursive: true });
  fs.writeFileSync(path.join(changeDir, 'specs', 'cap2', 'spec.md'), '### Scenario: SCEN-B-01 x\n');
  fs.writeFileSync(path.join(changeDir, 'specs', 'cap3', 'spec.md'), '### Scenario: SCEN-C-01 y\n');

  const res2 = spawnSync(process.execPath, [script('pipeline-run.mjs'), 'prepare-author', changeDir, '--json'], {
    cwd: repo,
    encoding: 'utf8',
  });
  assert.equal(res2.status, 0, res2.stderr + res2.stdout);
  const out2 = JSON.parse(res2.stdout);
  assert.ok(out2.splitReasons.includes('capabilities=3>2'), JSON.stringify(out2.splitReasons));
  assert.match(fs.readFileSync(factsPath, 'utf8'), /custom Stage 1 note: src\/a\.mjs:10/);
});

test('brief.mjs author JIT-inlines baseline-facts.md and truncates cleanly at 15KB budget', () => {
  const repo = initRepo();
  const changeDir = path.join(repo, 'openspec', 'changes', 'jit-demo');
  fs.mkdirSync(changeDir, { recursive: true });
  fs.writeFileSync(path.join(changeDir, 'proposal.md'), '# Proposal\n');
  const hugeFacts = `# Baseline Facts\n\n${'A'.repeat(20 * 1024)}\n`;
  fs.writeFileSync(path.join(changeDir, 'baseline-facts.md'), hugeFacts);

  const res = spawnSync(process.execPath, [script('brief.mjs'), 'author', '--change', 'jit-demo', '--repo', repo], {
    cwd: repo,
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stderr + res.stdout);
  assert.match(res.stdout, /## Baseline Facts \(Stage 0\/1 — JIT inlined\)/);
  assert.match(res.stdout, /\.\.\. \[truncated at 15KB budget\]/);
  const section = res.stdout.split('## Baseline Facts (Stage 0/1 — JIT inlined)\n')[1];
  assert.ok(Buffer.byteLength(section, 'utf8') <= 15 * 1024 + 5, `inlined section too large: ${Buffer.byteLength(section, 'utf8')}`);
});

test('tasks.mjs & acceptance-sync.mjs own Entry/Verify/Required with SCEN-ID mapping and BAD_REQUIRED', () => {
  const tasksMd = `# Tasks
- [ ] 1.1 T-01 api
  - Write scope: src/api.mjs,test/api.test.mjs
  - Entry: SCEN-API-01=POST /login; SCEN-API-02=GET /me
  - Required: no
  - Verify with: node --test test/api.test.mjs
  - Scenarios: SCEN-API-01, SCEN-API-02
- [ ] 1.2 T-02 bad-req
  - Write scope: src/bad.mjs,test/bad.test.mjs
  - Entry: CLI
  - Required: maybe
  - Verify with: node --test test/bad.test.mjs
  - Scenarios: SCEN-BAD-01
- [ ] 1.3 T-03 default-req
  - Write scope: src/def.mjs,test/def.test.mjs
  - Entry: CLI
  - Verify with: node --test test/def.test.mjs
  - Scenarios: SCEN-DEF-01
`;
  const parsed = parseTasks(tasksMd);
  assert.equal(parsed.errors.some((e) => e.code === 'BAD_REQUIRED' && e.task === 'T-02'), true);
  const t1 = parsed.tasks.find((t) => t.id === 'T-01');
  const t3 = parsed.tasks.find((t) => t.id === 'T-03');
  assert.equal(entryForScenario(t1, 'SCEN-API-01'), 'POST /login');
  assert.equal(entryForScenario(t1, 'SCEN-API-02'), 'GET /me');
  assert.equal(requiredForScenario(t1), 'no');
  assert.equal(requiredForScenario(t3), null);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-sync-v2-'));
  fs.mkdirSync(path.join(dir, 'specs', 'auth'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'specs', 'auth', 'spec.md'), [
    '## ADDED Requirements',
    '### Requirement: login',
    '#### Scenario: SCEN-API-01 user login',
    'WHEN valid creds',
    'THEN token issued',
    '#### Scenario: SCEN-API-02 optional legacy',
    'WHEN GET /me',
    'THEN profile returned',
    '- **Verify:** node --test test/legacy.test.mjs',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'tasks.md'), [
    '- [ ] 1.1 T-01 login',
    '  - Write scope: src/auth.mjs,test/auth.test.mjs',
    '  - Entry: POST /login',
    '  - Verify with: node --test test/auth.test.mjs',
    '  - Scenarios: SCEN-API-01',
    '- [ ] 1.2 T-02 profile',
    '  - Write scope: src/me.mjs,test/auth.test.mjs',
    '  - Entry: GET /me',
    '  - Required: no',
    '  - Verify with: node --test test/auth.test.mjs',
    '  - Scenarios: SCEN-API-02',
  ].join('\n'));

  const syncRes = spawnSync(process.execPath, [script('acceptance-sync.mjs'), dir], { encoding: 'utf8' });
  assert.equal(syncRes.status, 0, syncRes.stderr + syncRes.stdout);
  const acceptance = fs.readFileSync(path.join(dir, 'acceptance.md'), 'utf8');
  assert.match(acceptance, /\| SCEN-API-01 \| POST \/login \| T-01 \| node --test test\/auth\.test\.mjs \| yes \| PENDING \| pending \|/);
  assert.match(acceptance, /\| SCEN-API-02 \| GET \/me \| T-02 \| node --test test\/auth\.test\.mjs \| no \| PENDING \| pending \|/);

  // Legacy spec **Verify:** fallback when scenario is not claimed by a task carrying Verify with:
  fs.rmSync(path.join(dir, 'acceptance.md'), { force: true });
  fs.writeFileSync(path.join(dir, 'tasks.md'), [
    '- [ ] 1.1 T-01 auth',
    '  - Write scope: src/auth.mjs,test/auth.test.mjs',
    '  - Entry: POST /login',
    '  - Verify with: node --test test/auth.test.mjs',
    '  - Scenarios: SCEN-API-01',
  ].join('\n'));
  const syncLegacy = spawnSync(process.execPath, [script('acceptance-sync.mjs'), dir], { encoding: 'utf8' });
  assert.equal(syncLegacy.status, 0, syncLegacy.stderr + syncLegacy.stdout);
  assert.match(fs.readFileSync(path.join(dir, 'acceptance.md'), 'utf8'), /\| SCEN-API-02 \| [^|]+ \| <unclaimed> \| node --test test\/legacy\.test\.mjs \| yes \|/);
});

test('tier2-verify resolves Verify from tasks.md first, falls back to specs Verify, and fails closed when absent', () => {
  const repo = initRepo();
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'test'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'app.mjs'), 'export const v = 1;\n');
  fs.writeFileSync(path.join(repo, 'test', 'app.test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; import { v } from '../src/app.mjs'; test('v', () => assert.equal(v, 1));\n");
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'base');

  const wt = path.join(os.tmpdir(), `ca-v2-t2-${process.pid}-${Date.now()}`);
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/t2', wt, 'main');
  try {
    const changeDir = path.join(wt, 'openspec', 'changes', 't2-single-src');
    fs.mkdirSync(path.join(changeDir, 'specs', 'cap'), { recursive: true });
    fs.writeFileSync(path.join(changeDir, 'specs', 'cap', 'spec.md'), [
      '## ADDED Requirements',
      '### Requirement: App runs',
      'The system SHALL return v.',
      '#### Scenario: SCEN-APP-01 returns value',
      '- **WHEN** invoked',
      '- **THEN** returns 1',
    ].join('\n'));
    fs.writeFileSync(path.join(changeDir, 'tasks.md'), [
      '- [ ] 1.1 T-01 app',
      '  - Write scope: src/app.mjs,test/app.test.mjs',
      '  - Entry: CLI',
      '  - Verify with: node --test test/app.test.mjs',
      '  - Scenarios: SCEN-APP-01',
    ].join('\n'));
    git(wt, 'add', '.');
    git(wt, 'commit', '-qm', 'contract + impl');

    const okTaskVerify = spawnSync(process.execPath, [script('tier2-verify.mjs'), 'main', '--change-dir', changeDir, '--json'], {
      cwd: wt,
      encoding: 'utf8',
    });
    assert.equal(okTaskVerify.status, 0, okTaskVerify.stderr + okTaskVerify.stdout);
    const okData = JSON.parse(okTaskVerify.stdout);
    assert.deepEqual(okData.missingVerify, []);
    assert.equal(okData.verifyResults.length, 1);
    assert.equal(okData.verifyResults[0].command, 'node --test test/app.test.mjs');

    // Legacy fallback: tasks.md omits Verify with:, spec.md carries - **Verify:**
    fs.writeFileSync(path.join(changeDir, 'specs', 'cap', 'spec.md'), [
      '## ADDED Requirements',
      '### Requirement: App runs',
      'The system SHALL return v.',
      '#### Scenario: SCEN-APP-01 returns value',
      '- **WHEN** invoked',
      '- **THEN** returns 1',
      '- **Verify:** node --test test/app.test.mjs',
    ].join('\n'));
    fs.writeFileSync(path.join(changeDir, 'tasks.md'), '- [ ] 1.1 T-01 app\n  - Write scope: src/app.mjs,test/app.test.mjs\n  - Scenarios: SCEN-APP-01\n');
    git(wt, 'add', '.');
    git(wt, 'commit', '-qm', 'legacy fallback');
    const okLegacy = spawnSync(process.execPath, [script('tier2-verify.mjs'), 'main', '--change-dir', changeDir, '--json'], {
      cwd: wt,
      encoding: 'utf8',
    });
    assert.equal(okLegacy.status, 0, okLegacy.stderr + okLegacy.stdout);

    // Neither has Verify -> fail closed
    fs.writeFileSync(path.join(changeDir, 'specs', 'cap', 'spec.md'), [
      '## ADDED Requirements',
      '### Requirement: App runs',
      'The system SHALL return v.',
      '#### Scenario: SCEN-APP-01 returns value',
      '- **WHEN** invoked',
      '- **THEN** returns 1',
    ].join('\n'));
    git(wt, 'add', '.');
    git(wt, 'commit', '-qm', 'missing verify');
    const failMissing = spawnSync(process.execPath, [script('tier2-verify.mjs'), 'main', '--change-dir', changeDir, '--json'], {
      cwd: wt,
      encoding: 'utf8',
    });
    assert.notEqual(failMissing.status, 0);
    const failData = JSON.parse(failMissing.stdout);
    assert.ok(failData.missingVerify.some((item) => item.includes('SCEN-APP-01')));
  } finally {
    fs.rmSync(wt, { recursive: true, force: true });
  }
});

test('freeze-check: baseline-facts R0 exemption, ROI 1.8x threshold at maxWidth=2, and entropy split advisory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-v2-'));
  const table = '| Scenario | Entry | Tasks | Verify | Required | Result | Evidence |\n| --- | --- | --- | --- | --- | --- | --- |\n| SCEN-1 | CLI | T-01,T-02,T-03,T-04,T-05,T-06 | node --test test/t1.test.mjs | yes | PENDING | pending |\n';
  // Two independent 3-task chains: 6 substantive tasks, maxWidth=2, criticalPath=3, weightedSpeedup=2.0 >= 1.8 -> pipeline!
  const dualChainTasks = [
    '- [ ] 1.1 T-01 a1\n  - Write scope: src/a1.mjs,test/t1.test.mjs\n  - Verify with: node --test test/t1.test.mjs\n  - Scen: SCEN-1',
    '- [ ] 2.1 T-02 a2\n  - Depends on: T-01\n  - Write scope: src/a2.mjs,test/t2.test.mjs\n  - Verify with: node --test test/t2.test.mjs\n  - Scen: SCEN-1',
    '- [ ] 3.1 T-03 a3\n  - Depends on: T-02\n  - Write scope: src/a3.mjs,test/t3.test.mjs\n  - Verify with: node --test test/t3.test.mjs\n  - Scen: SCEN-1',
    '- [ ] 1.2 T-04 b1\n  - Write scope: src/b1.mjs,test/t4.test.mjs\n  - Verify with: node --test test/t4.test.mjs\n  - Scen: SCEN-1',
    '- [ ] 2.2 T-05 b2\n  - Depends on: T-04\n  - Write scope: src/b2.mjs,test/t5.test.mjs\n  - Verify with: node --test test/t5.test.mjs\n  - Scen: SCEN-1',
    '- [ ] 3.2 T-06 b3\n  - Depends on: T-05\n  - Write scope: src/b3.mjs,test/t6.test.mjs\n  - Verify with: node --test test/t6.test.mjs\n  - Scen: SCEN-1',
  ].join('\n');

  const changeDir = path.join(dir, 'openspec', 'changes', 'roi');
  fs.mkdirSync(path.join(changeDir, 'specs', 'a'), { recursive: true });
  fs.writeFileSync(path.join(changeDir, 'proposal.md'), '## What Changes\n- R1: demo\n');
  fs.writeFileSync(path.join(changeDir, 'specs', 'a', 'spec.md'), '### Scenario: SCEN-1 ok\nWHEN a\nTHEN b\n');
  fs.writeFileSync(path.join(changeDir, 'tasks.md'), dualChainTasks);
  fs.writeFileSync(path.join(changeDir, 'acceptance.md'), table);
  fs.writeFileSync(path.join(changeDir, 'baseline-facts.md'), '# Baseline Facts\ninitial facts\n');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'contract');
  const sha = git(dir, 'rev-parse', '--short', 'HEAD');
  fs.writeFileSync(path.join(changeDir, 'review.md'), `R0: pass(9b2f4c1e-aaaa-4a2b-8c3d-000000000099@${sha})\n`);
  // Dirtying baseline-facts.md AFTER R0 sign-off must NOT trigger STALE_R0_SIGNOFF!
  fs.writeFileSync(path.join(changeDir, 'baseline-facts.md'), '# Baseline Facts\nupdated after R0\n');

  const r1 = spawnSync(process.execPath, [script('freeze-check.mjs'), changeDir, '--json', '--skip-signer-check'], {
    cwd: dir,
    encoding: 'utf8',
  });
  assert.equal(r1.status, 0, r1.stderr + r1.stdout);
  const report1 = JSON.parse(r1.stdout);
  assert.equal(report1.maxWidth, 2);
  assert.ok(report1.weightedSpeedup >= 1.8, `expected speedup >= 1.8, got ${report1.weightedSpeedup}`);
  assert.equal(report1.route, 'pipeline');
  assert.ok(!report1.advisories.some((a) => a.startsWith('ADVISORY_LOW_ROI_HANDOFF')));

  // Exceeding 2 top-level capabilities emits ADVISORY_ENTROPY_SPLIT
  fs.mkdirSync(path.join(changeDir, 'specs', 'b'), { recursive: true });
  fs.mkdirSync(path.join(changeDir, 'specs', 'c'), { recursive: true });
  fs.writeFileSync(path.join(changeDir, 'specs', 'b', 'spec.md'), '### Scenario: SCEN-2 b\nWHEN a\nTHEN b\n');
  fs.writeFileSync(path.join(changeDir, 'specs', 'c', 'spec.md'), '### Scenario: SCEN-3 c\nWHEN a\nTHEN b\n');
  fs.writeFileSync(path.join(changeDir, 'tasks.md'), dualChainTasks.replace('- Scen: SCEN-1', '- Scen: SCEN-1, SCEN-2, SCEN-3'));
  fs.writeFileSync(path.join(changeDir, 'acceptance.md'), `${table}| SCEN-2 | CLI | T-01 | node --test test/t1.test.mjs | yes | PENDING | pending |\n| SCEN-3 | CLI | T-01 | node --test test/t1.test.mjs | yes | PENDING | pending |\n`);
  const r2 = spawnSync(process.execPath, [script('freeze-check.mjs'), changeDir, '--structural', '--skip-signer-check', '--json'], {
    cwd: dir,
    encoding: 'utf8',
  });
  assert.equal(r2.status, 0, r2.stderr + r2.stdout);
  const report2 = JSON.parse(r2.stdout);
  assert.ok(report2.advisories.some((a) => a.startsWith('ADVISORY_ENTROPY_SPLIT:')), JSON.stringify(report2.advisories));
});

test('author-guard hooks: read thrashing warn/stop, git -C allowance, write reset, linked-worktree compact stop, and telemetry report', () => {
  assert.equal(isReadOnlyBash('rg foo src/'), true);
  assert.equal(isReadOnlyBash('git -C /tmp/wt log --oneline -n 5 | wc -l'), true);
  assert.equal(isReadOnlyBash('node scripts/run.mjs > out.txt'), false);
  assert.equal(isReadOnlyBash('mkdir -p specs/cap'), false);

  const primary = initRepo();
  const wt = path.join(os.tmpdir(), `ca-v2-wt-${process.pid}-${Date.now()}`);
  git(primary, 'worktree', 'add', '-q', '-b', 'feat/author', wt, 'main');
  try {
    const changeDir = path.join(wt, 'openspec', 'changes', 'big-change');
    fs.mkdirSync(changeDir, { recursive: true });
    fs.writeFileSync(path.join(changeDir, 'proposal.md'), '## What Changes\n- R1: x\n');

    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-state-'));
    const telemetryFile = path.join(stateDir, 'metrics.jsonl');
    const hookEnv = {
      ...process.env,
      PIPELINE_TIER_GATE_STATE: stateDir,
      PIPELINE_TELEMETRY_FILE: telemetryFile,
      PIPELINE_AUTHOR_WARN_READS: '2',
      PIPELINE_AUTHOR_STOP_READS: '4',
    };
    const sid = 'sess-author-v2';
    const runBashHook = (cmd) => spawnSync(process.execPath, [script('hooks/tool-guard-hook.mjs')], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: cmd }, cwd: wt, session_id: sid }),
      encoding: 'utf8',
      env: hookEnv,
    });

    const r1 = runBashHook('rg foo src/');
    assert.equal(r1.status, 0);
    assert.equal(r1.stdout.trim(), '');

    const r2 = runBashHook('git -C . log --oneline -n 3');
    assert.equal(r2.status, 0);
    assert.match(r2.stdout, /write openspec\/changes\/big-change\/specs/i);

    // Non-read-only command does not increment read counter
    const rMut = runBashHook('mkdir -p tmp');
    assert.equal(rMut.status, 0);
    assert.equal(rMut.stdout.trim(), '');

    const r3 = runBashHook('cat README.md');
    assert.equal(r3.status, 0);
    assert.equal(r3.stdout.trim(), '');

    const r4 = runBashHook('ls -la');
    assert.equal(r4.status, 0);
    assert.match(r4.stdout, /INCOMPLETE/);

    // Compact event in linked worktree (even though skipInjection=true!) emits empty-specs stop notice
    const compactRes = spawnSync(process.execPath, [script('hooks/tier-session-hook.mjs')], {
      input: JSON.stringify({ source: 'compact', cwd: wt, session_id: sid }),
      encoding: 'utf8',
      env: hookEnv,
    });
    assert.equal(compactRes.status, 0);
    assert.match(compactRes.stdout, /\[author-guard\] Context compacted/);
    assert.doesNotMatch(compactRes.stdout, /分级规则·会话级/);

    // Writing a spec file resets read count
    const writeRes = spawnSync(process.execPath, [script('hooks/tier-write-hook.mjs')], {
      input: JSON.stringify({
        tool_name: 'Write',
        tool_input: { file_path: path.join(changeDir, 'specs', 'cap', 'spec.md'), content: '### Scenario: SCEN-1 a\n' },
        session_id: sid,
      }),
      encoding: 'utf8',
      env: hookEnv,
    });
    assert.equal(writeRes.status, 0);

    // Write spec to disk so after-reset test simulates ongoing authoring with tasks.md still absent
    fs.mkdirSync(path.join(changeDir, 'specs', 'cap'), { recursive: true });
    fs.writeFileSync(path.join(changeDir, 'specs', 'cap', 'spec.md'), '### Scenario: SCEN-1 a\n');
    const afterReset1 = runBashHook('cat README.md');
    assert.equal(afterReset1.stdout.trim(), '', 'reset readCount=1 must not immediately fire warn');

    const summary = summarizeTelemetry({ days: 7, file: telemetryFile });
    assert.deepEqual(summary.authorGuard, { warn: 1, stop: 1, compactEmptySpecs: 1 });

    const rep = spawnSync(process.execPath, [script('pipeline-run.mjs'), 'report'], {
      encoding: 'utf8',
      env: hookEnv,
    });
    assert.equal(rep.status, 0);
    assert.match(rep.stdout, /- author_guard: warn=1 stop=1 compact_empty_specs=1/);
  } finally {
    fs.rmSync(wt, { recursive: true, force: true });
  }
});

test('acceptance-sync preserves multi-claimant shell-loop Verify commands, passes freeze-check, and fails closed on unsupported loops', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-sync-loop-'));
  fs.mkdirSync(path.join(dir, 'specs', 'loopcap'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'proposal.md'), '## What Changes\n- R1: loop compose\n');
  fs.writeFileSync(path.join(dir, 'specs', 'loopcap', 'spec.md'), [
    '## ADDED Requirements',
    '### Requirement: multi claimant verify',
    '#### Scenario: SCEN-LOOP-01 runs all claimants',
    'WHEN triggered',
    'THEN all checks run',
  ].join('\n'));

  // Plain Verify + fail-fast for-loop claiming same SCEN -> BOTH preserved & escaped cleanly
  fs.writeFileSync(path.join(dir, 'tasks.md'), [
    '- [ ] 1.1 T-01 alpha',
    '  - Write scope: src/a.mjs,test/a.test.mjs',
    '  - Entry: CLI',
    '  - Verify with: node --test test/a.test.mjs',
    '  - Scenarios: SCEN-LOOP-01',
    '- [ ] 1.2 T-02 beta',
    '  - Write scope: src/b.mjs,test/b.test.mjs',
    '  - Entry: CLI',
    '  - Verify with: for f in test/b.test.mjs; do node --test $f || exit 1; done',
    '  - Scenarios: SCEN-LOOP-01',
  ].join('\n'));
  const res1 = spawnSync(process.execPath, [script('acceptance-sync.mjs'), dir], { encoding: 'utf8' });
  assert.equal(res1.status, 0, res1.stderr + res1.stdout);
  const accText1 = fs.readFileSync(path.join(dir, 'acceptance.md'), 'utf8');
  assert.match(accText1, /node --test test\/a\.test\.mjs && for f in test\/b\.test\.mjs; do node --test \$f \\\|\\\| exit 1; done/);
  const parsed1 = parseAcceptanceTable(accText1);
  assert.equal(parsed1.malformed.length, 0);
  assert.equal(parsed1.rows[0].verify, 'node --test test/a.test.mjs && for f in test/b.test.mjs; do node --test $f || exit 1; done');
  const fc1 = spawnSync(process.execPath, [script('freeze-check.mjs'), dir, '--structural', '--skip-signer-check', '--json'], { encoding: 'utf8' });
  assert.equal(fc1.status, 0, fc1.stderr + fc1.stdout);

  // Two fail-fast loops claiming same SCEN -> both preserved (Review: mechanical on both sinks satisfies task-level broad/narrow gate while acceptance-check validates composed loops)
  fs.writeFileSync(path.join(dir, 'tasks.md'), [
    '- [ ] 1.1 T-01 alpha',
    '  - Write scope: src/a.mjs,test/a.test.mjs',
    '  - Entry: CLI',
    '  - Review: mechanical',
    '  - Verify with: for f in test/a.test.mjs; do node "$f" || exit 1; done',
    '  - Scenarios: SCEN-LOOP-01',
    '- [ ] 1.2 T-02 beta',
    '  - Write scope: src/b.mjs,test/b.test.mjs',
    '  - Entry: CLI',
    '  - Review: mechanical',
    '  - Verify with: for f in test/b.test.mjs; do node "$f" || exit 1; done',
    '  - Scenarios: SCEN-LOOP-01',
  ].join('\n'));
  const res2 = spawnSync(process.execPath, [script('acceptance-sync.mjs'), dir], { encoding: 'utf8' });
  assert.equal(res2.status, 0, res2.stderr + res2.stdout);
  const parsed2 = parseAcceptanceTable(fs.readFileSync(path.join(dir, 'acceptance.md'), 'utf8'));
  assert.equal(parsed2.rows[0].verify, 'for f in test/a.test.mjs; do node "$f" || exit 1; done && for f in test/b.test.mjs; do node "$f" || exit 1; done');
  const fc2 = spawnSync(process.execPath, [script('freeze-check.mjs'), dir, '--structural', '--skip-signer-check', '--json'], { encoding: 'utf8' });
  assert.equal(fc2.status, 0, fc2.stderr + fc2.stdout);

  // Unsupported control structure fails explicitly instead of omitting claimant
  fs.writeFileSync(path.join(dir, 'tasks.md'), [
    '- [ ] 1.1 T-01 alpha',
    '  - Write scope: src/a.mjs,test/a.test.mjs',
    '  - Entry: CLI',
    '  - Verify with: node --test test/a.test.mjs',
    '  - Scenarios: SCEN-LOOP-01',
    '- [ ] 1.2 T-02 bad',
    '  - Write scope: src/b.mjs,test/b.test.mjs',
    '  - Entry: CLI',
    '  - Verify with: if true; then node --test test/b.test.mjs; fi',
    '  - Scenarios: SCEN-LOOP-01',
  ].join('\n'));
  const res3 = spawnSync(process.execPath, [script('acceptance-sync.mjs'), dir], { encoding: 'utf8' });
  assert.equal(res3.status, 1);
  assert.match(res3.stderr, /cannot compose Verify for SCEN-LOOP-01/);
});

test('author-guard recordAuthorRead uses O(1) session state cache with negative TTL and tasks.md invalidation', () => {
  const prevState = process.env.PIPELINE_TIER_GATE_STATE;
  const prevTel = process.env.PIPELINE_TELEMETRY_FILE;
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-cache-'));
  process.env.PIPELINE_TIER_GATE_STATE = stateDir;
  process.env.PIPELINE_TELEMETRY_FILE = path.join(stateDir, 'metrics.jsonl');
  try {
    // 1) Repo with no active authoring change -> Read 1 misses, Read 2 hits negative cache
    const cleanRepo = initRepo();
    const neg1 = recordAuthorRead({ cwd: cleanRepo, sessionId: 's-neg', command: 'rg foo src/', now: 1000 });
    assert.equal(neg1.action, 'none');
    assert.equal(neg1.cacheHit, false);
    const neg2 = recordAuthorRead({ cwd: cleanRepo, sessionId: 's-neg', command: 'rg foo src/', now: 2000 });
    assert.equal(neg2.action, 'none');
    assert.equal(neg2.cacheHit, true);
    const negExpired = recordAuthorRead({ cwd: cleanRepo, sessionId: 's-neg', command: 'rg foo src/', now: 65_000 });
    assert.equal(negExpired.cacheHit, false);

    // 2) Active authoring repo with 50 sibling changes -> Read 1 populates cache, Reads 2+ stay cacheHit=true
    const repo = initRepo();
    for (let i = 0; i < 50; i += 1) {
      const sibling = path.join(repo, 'openspec', 'changes', `done-${i}`);
      fs.mkdirSync(sibling, { recursive: true });
      fs.writeFileSync(path.join(sibling, 'proposal.md'), '# Done\n');
      fs.writeFileSync(path.join(sibling, 'tasks.md'), '- [x] 1.1 T-01 d\n');
    }
    const activeDir = path.join(repo, 'openspec', 'changes', 'zzz-active');
    fs.mkdirSync(activeDir, { recursive: true });
    fs.writeFileSync(path.join(activeDir, 'proposal.md'), '# Active\n');

    const r1 = recordAuthorRead({ cwd: repo, sessionId: 's-act', command: 'rg foo src/', now: 1000 });
    assert.equal(r1.cacheHit, false);
    assert.equal(r1.readCount, 1);

    const r2 = recordAuthorRead({ cwd: repo, sessionId: 's-act', command: 'cat README.md', now: 2000 });
    assert.equal(r2.cacheHit, true);
    assert.equal(r2.readCount, 2);

    // Creating tasks.md invalidates active cache immediately on next read
    fs.writeFileSync(path.join(activeDir, 'tasks.md'), '- [ ] 1.1 T-01 x\n');
    const rAfterTasks = recordAuthorRead({ cwd: repo, sessionId: 's-act', command: 'cat README.md', now: 3000 });
    assert.equal(rAfterTasks.action, 'none');
    assert.equal(rAfterTasks.cacheHit, false);
    assert.equal(rAfterTasks.readCount, undefined);
  } finally {
    if (prevState === undefined) delete process.env.PIPELINE_TIER_GATE_STATE;
    else process.env.PIPELINE_TIER_GATE_STATE = prevState;
    if (prevTel === undefined) delete process.env.PIPELINE_TELEMETRY_FILE;
    else process.env.PIPELINE_TELEMETRY_FILE = prevTel;
  }
});
