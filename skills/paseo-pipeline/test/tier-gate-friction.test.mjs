import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assessTierGate, assessStop, takeSnapshot, readDeclaredPlanStatus, readDeclaredPlanStatusWithRetry, scopeKey } from '../lib/tier-gate.mjs';

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

const entry = (type, content, extra = {}) => JSON.stringify({ type, ...extra, message: { role: type, content: [{ type: 'text', text: content }] } });
const plan = (files = 'packages/a/src/x.ts') => entry('assistant', `TIER-PLAN: tier=1 files=${files} scope=packages/a`);

// ---- (2a) compaction summaries and skill injections are not human prompts ----

test('a compaction summary does not clear the declaration', () => withState((dir) => {
  const file = path.join(dir, 'compact.jsonl');
  fs.writeFileSync(file, [
    entry('user', 'implement the change'),
    plan(),
    // Shape observed in ~/.claude/projects/*/*.jsonl: user role, isCompactSummary, no isMeta.
    entry('user', 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion…', { isCompactSummary: true, isVisibleInTranscriptOnly: true }),
    entry('assistant', 'continuing'),
  ].join('\n'));
  const result = readDeclaredPlanStatus(file);
  assert.equal(result.status, 'found');
  assert.deepEqual(result.plan.files, ['packages/a/src/x.ts']);
}));

test('a skill injection body does not clear the declaration', () => withState((dir) => {
  const file = path.join(dir, 'skill.jsonl');
  fs.writeFileSync(file, [
    entry('user', 'implement the change'),
    plan(),
    entry('user', 'Base directory for this skill: /Users/h/.claude/skills/paseo-handoff\n\n# Handoff Skill\n\nTransfer the current task — context, decisions, failed attempts…', { isMeta: true }),
    entry('assistant', 'continuing'),
  ].join('\n'));
  assert.equal(readDeclaredPlanStatus(file).status, 'found');
  // Even without isMeta (a provider that does not mark it), the body prefix is still not a human turn.
  fs.writeFileSync(file, [
    entry('user', 'implement the change'),
    plan(),
    entry('user', 'Base directory for this skill: /Users/h/.claude/skills/paseo\n\n# Paseo\n'),
  ].join('\n'));
  assert.equal(readDeclaredPlanStatus(file).status, 'found');
}));

test('a real new human message still clears the declaration', () => withState((dir) => {
  const file = path.join(dir, 'human.jsonl');
  fs.writeFileSync(file, [entry('user', 'task'), plan(), entry('user', '继续，把验证也跑了')].join('\n'));
  assert.equal(readDeclaredPlanStatus(file).status, 'missing');
}));

// ---- (2b) short read retry ----

test('a short read retry finds a declaration written between the two reads', () => withState(() => {
  const root = makeRepo();
  // First read launches the retry path; the retry finds the declaration the flush delivered.
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'late-')), 'late.jsonl');
  fs.writeFileSync(file, entry('user', 'task'));
  let reads = 0;
  const result = readDeclaredPlanStatusWithRetry(file, {
    attempts: 2,
    intervalMs: 0,
    onRead: () => {
      reads += 1;
      if (reads === 1) fs.appendFileSync(file, `\n${plan()}`);
    },
  });
  assert.equal(result.status, 'found');
  assert.equal(reads, 2);
  const verdict = assessTierGate({ target: path.join(root, 'src/a.ts'), sessionId: 'retry', declared: { tier: 1, files: ['src/a.ts'] } });
  assert.equal(verdict.verdict, 'allow');
}));

// ---- (2c) missing declarations are logged with a redacted transcript tail ----

test('a final missing denial logs the transcript tail, redacted', () => withState((dir) => {
  const root = makeRepo();
  const file = path.join(dir, 'tail.jsonl');
  const secret = 'sk-abcdefghijklmnopqrstuvwxyz012345';
  const lines = Array.from({ length: 30 }, (_, i) => entry('user', `tail line ${i} ${'x'.repeat(200)}`));
  lines.push(entry('assistant', `using ${secret} for the request`));
  fs.writeFileSync(file, lines.join('\n'));
  const verdict = assessTierGate({
    target: path.join(root, 'packages/a/src/x.ts'),
    sessionId: 'tail',
    transcriptPath: file,
    loadDeclaration: () => readDeclaredPlanStatus(file),
  });
  assert.equal(verdict.verdict, 'deny');
  const log = fs.readFileSync(path.join(dir, 'errors.log'), 'utf8');
  assert.match(log, /declaration missing/);
  // The tail is bounded and clipped: no full line body, no unbounded write.
  assert.match(log, /tail line \d+/);
  assert.doesNotMatch(log, new RegExp(`x{200}`));
  // A credential in the tail is redacted, never persisted.
  assert.doesNotMatch(log, new RegExp(secret));
  assert.match(log, /\[redacted\]/);
}));

// ---- (2d) scope normalization for src/ + test/ splits ----

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

test('src/ + docs/ is still a cross-scope split', () => withState(() => {
  const root = makeRepo();
  const verdict = assessTierGate({
    target: path.join(root, 'src/a.ts'),
    sessionId: 'mixed',
    declared: { tier: 1, files: ['src/a.ts', 'docs/guide.md'] },
  });
  assert.equal(verdict.verdict, 'deny');
  assert.match(verdict.reason, /2 个作用域/);
}));

test('scopeKey keeps genuine package separation', () => {
  assert.equal(scopeKey('packages/x/src/a.ts'), 'packages/x');
  assert.equal(scopeKey('packages/y/src/b.ts'), 'packages/y');
  assert.notEqual(scopeKey('packages/x/src/a.ts'), scopeKey('packages/y/src/b.ts'));
});

// ---- (2e) one judgement per tool_use batch ----

test('a sibling read of a shorter partial flush reuses the declaration a parallel read found', () => withState((dir) => {
  const root = makeRepo();
  const file = path.join(dir, 'batch.jsonl');
  fs.writeFileSync(file, [entry('user', 'task'), plan('src/a.ts')].join('\n'));
  const payload = (n) => ({
    session_id: 'batch',
    transcript_path: file,
    tool_name: 'Edit',
    tool_input: { file_path: path.join(root, 'src', n) },
  });
  const run = (p) => spawnSync('node', [GUARD_HOOK], { input: JSON.stringify(p), encoding: 'utf8', env: { ...process.env, PIPELINE_TIER_GATE_STATE: dir } }).stdout.trim();
  // First hook of the batch reads the complete file and records the plan.
  assert.equal(run(payload('a')), '');
  // A parallel hook of the same batch reads a shorter prefix (the flush had not completed for
  // it). Re-parsing that prefix alone says "missing"; the batch record says what it found.
  const full = fs.readFileSync(file, 'utf8');
  const lines = full.split('\n');
  fs.writeFileSync(file, lines.slice(0, 1).join('\n'));
  const rescued = run(payload('b'));
  assert.equal(JSON.parse(rescued || '{}')?.hookSpecificOutput?.permissionDecision ?? 'allow', 'allow');
  // A genuinely new human message still invalidates the batch record.
  fs.appendFileSync(file, `\n${entry('user', '新任务')}`);
  const denied = run(payload('c'));
  assert.equal(JSON.parse(denied).hookSpecificOutput.permissionDecision, 'deny');
}));

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

test('Stop churn still fires for repeated business-file edits', () => withState(() => {
  const root = makeRepo();
  for (let round = 1; round <= 3; round += 1) {
    takeSnapshot({ cwd: root, sessionId: 'code' });
    fs.writeFileSync(path.join(root, 'src', 'a'), `x ${Math.random()}`);
    const verdict = assessStop({ cwd: root, sessionId: 'code' });
    if (round === 3) assert.equal(verdict.verdict, 'block');
    else assert.equal(verdict.verdict, 'ok');
  }
}));

// ---- (2g) Tier 2 deny carries a handoff invocation sample ----

test('the Tier 2 denial shows the handoff call and the tried section reminder', () => withState(() => {
  const root = makeRepo();
  const verdict = assessTierGate({
    target: path.join(root, 'src/a.ts'),
    sessionId: 'tier2',
    declared: { tier: 2, files: ['src/a.ts'] },
  });
  assert.equal(verdict.verdict, 'deny');
  assert.match(verdict.reason, /\/paseo-handoff/);
  assert.match(verdict.reason, /What was tried/i);
  assert.match(verdict.reason, /## What was tried/);
}));
