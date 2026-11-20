import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assessTierGate, assessStop, takeSnapshot, scopeKey } from '../lib/tier-gate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const GUARD_HOOK = path.join(here, '..', 'hooks', 'tier-write-hook.mjs');

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function makeRepo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tier-friction-')));
  sh(root, 'init', '-q', '-b', 'main');
  sh(root, 'config', 'user.email', 't@t');
  sh(root, 'config', 'user.name', 't');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'seed.txt'), 'seed');
  sh(root, 'add', '.');
  sh(root, 'commit', '-q', '-m', 'seed');
  return root;
}

function withState(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tier-friction-state-'));
  const prev = {
    state: process.env.PIPELINE_TIER_GATE_STATE,
    off: process.env.PIPELINE_TIER_GATE,
    limit: process.env.PIPELINE_TIER_GATE_LIMIT,
  };
  process.env.PIPELINE_TIER_GATE_STATE = dir;
  delete process.env.PIPELINE_TIER_GATE;
  delete process.env.PIPELINE_TIER_GATE_LIMIT;
  try {
    return fn(dir);
  } finally {
    for (const [k, v] of [['PIPELINE_TIER_GATE_STATE', prev.state], ['PIPELINE_TIER_GATE', prev.off], ['PIPELINE_TIER_GATE_LIMIT', prev.limit]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

// ---- (2a)-(2d) scope normalization for src/ + test/ splits ----

test('declared src/ + test/ files are one scope when a workspace layout exists', () => withState((dir) => {
  const root = makeRepo();
  fs.mkdirSync(path.join(root, 'packages'), { recursive: true });
  fs.mkdirSync(path.join(root, 'skills'));
  const transcript = path.join(dir, 'scope.jsonl');
  const declared = { tier: 1, files: ['src/a.ts', 'test/y.ts'] };
  const verdict = assessTierGate({ target: path.join(root, 'src/a.ts'), sessionId: 'scope', declared });
  assert.equal(verdict.verdict, 'allow');
  // A genuine cross-package split still denies.
  const cross = assessTierGate({
    target: path.join(root, 'packages/x/a.ts'),
    sessionId: 'scope2',
    declared: { tier: 1, files: ['packages/x/a.ts', 'packages/y/b.ts'] },
  });
  assert.equal(cross.verdict, 'deny');
  assert.match(cross.reason, /2 个作用域/);
  assert.ok(transcript);
}));

test('src/ + test/ are one scope even in a flat repository', () => withState(() => {
  const root = makeRepo();
  const verdict = assessTierGate({
    target: path.join(root, 'src/a.ts'),
    sessionId: 'flat',
    declared: { tier: 1, files: ['src/a.ts', 'test/y.ts'] },
  });
  // A top-level src/test split is a naming artefact, not two packages; denying it taught
  // agents to rewrite plans instead of work. Real package splits still deny (above).
  assert.equal(verdict.verdict, 'allow');
}));

test('src/ + docs/ are one source scope because docs do not count', () => withState(() => {
  const root = makeRepo();
  const verdict = assessTierGate({
    target: path.join(root, 'src/a.ts'),
    sessionId: 'mixed',
    declared: { tier: 1, files: ['src/a.ts', 'docs/guide.md'] },
  });
  assert.equal(verdict.verdict, 'allow');
}));

test('scopeKey keeps genuine package separation', () => {
  assert.equal(scopeKey('packages/x/src/a.ts'), 'packages/x');
  assert.equal(scopeKey('packages/y/src/b.ts'), 'packages/y');
  assert.notEqual(scopeKey('packages/x/src/a.ts'), scopeKey('packages/y/src/b.ts'));
});

// ---- (2f) Stop churn exempts docs/ diff artifacts ----

test('Stop churn does not fire for repeated edits under docs/prototypes and docs/specs', () => withState(() => {
  const root = makeRepo();
  const put = (rel) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), `x ${Math.random()}`);
  };
  for (let round = 1; round <= 4; round += 1) {
    takeSnapshot({ cwd: root, sessionId: 'docs' });
    put('docs/prototypes/p/index.html');
    put('docs/specs/s.md');
    const verdict = assessStop({ cwd: root, sessionId: 'docs' });
    assert.equal(verdict.verdict, 'ok', `round ${round}`);
  }
}));

test('Stop assessment ignores test and doc files', () => withState(() => {
  const root = makeRepo();
  takeSnapshot({ cwd: root, sessionId: 'ignored' });
  fs.mkdirSync(path.join(root, 'other', 'tests'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'other', 'tests', 'a.test.ts'), 'test');
  fs.writeFileSync(path.join(root, 'docs', 'guide.md'), 'doc');
  assert.equal(assessStop({ cwd: root, sessionId: 'ignored' }).verdict, 'ok');
}));

test('Stop churn still fires for repeated business-file edits', () => withState(() => {
  const root = makeRepo();
  for (let round = 1; round <= 3; round += 1) {
    takeSnapshot({ cwd: root, sessionId: 'code' });
    fs.writeFileSync(path.join(root, 'src', 'a'), `x ${Math.random()}`);
    const verdict = assessStop({ cwd: root, sessionId: 'code' });
    if (round === 3) {
      assert.equal(verdict.verdict, 'block');
      assert.match(verdict.reason, /\/paseo-advisor/);
      assert.match(verdict.reason, /\/paseo-committee/);
    } else assert.equal(verdict.verdict, 'ok');
  }
}));

// ---- (2g) Tier 2 deny carries a handoff invocation sample ----

test('the Tier 2 denial shows linked worktree, tier2-verify, and /paseo-handoff', () => withState(() => {
  const root = makeRepo();
  const verdict = assessTierGate({
    target: path.join(root, 'src/a.ts'),
    sessionId: 'tier2',
    declared: { tier: 2, files: ['src/a.ts'] },
  });
  assert.equal(verdict.verdict, 'deny');
  assert.match(verdict.reason, /\/paseo-handoff/);
  assert.match(verdict.reason, /tier2-verify/);
  assert.match(verdict.reason, /linked worktree/);
}));

test('tier-write-hook counts primary-checkout edits without transcript dependency and keeps churn guidance', () => withState((dir) => {
  const root = makeRepo();
  const call = (rel) => spawnSync('node', [GUARD_HOOK], {
    input: JSON.stringify({ session_id: 'no-transcript', tool_name: 'Edit', tool_input: { file_path: path.join(root, rel) } }),
    encoding: 'utf8',
    env: { ...process.env, PIPELINE_TIER_GATE_STATE: dir },
  }).stdout.trim();
  assert.equal(call('packages/x/a.ts'), '');
  assert.equal(JSON.parse(call('packages/y/b.ts')).hookSpecificOutput.permissionDecision, 'ask');
}));
