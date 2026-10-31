import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assessTierGate } from '../lib/tier-gate.mjs';
import { shouldRemind, REMINDER } from '../hooks/tier-reminder-hook.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const GUARD_HOOK = path.join(here, '..', 'hooks', 'scope-guard-hook.mjs');
const REMINDER_HOOK = path.join(here, '..', 'hooks', 'tier-reminder-hook.mjs');

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function makeRepo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tier-gate-')));
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tier-state-'));
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

const write = (root, name, sessionId = 's1') => assessTierGate({ target: path.join(root, 'src', name), sessionId });

test('主 checkout 的 main：前 3 个不同文件放行，第 4 个拒绝并指向 Tier 2/3', () => withState(() => {
  const root = makeRepo();
  for (const n of ['a', 'b', 'c']) assert.equal(write(root, n).verdict, 'allow', n);
  const d = write(root, 'd');
  assert.equal(d.verdict, 'deny');
  assert.match(d.reason, /\/paseo-handoff/);
  assert.match(d.reason, /\/paseo-pipeline/);
  assert.match(d.reason, /a、.*b、.*c|src\/a/);
}));

test('同一文件反复写只计一次', () => withState(() => {
  const root = makeRepo();
  for (let i = 0; i < 10; i += 1) assert.equal(write(root, 'a').verdict, 'allow');
  for (const n of ['b', 'c']) assert.equal(write(root, n).verdict, 'allow');
  assert.equal(write(root, 'd').verdict, 'deny');
}));

test('已有的脏文件不计入：只数本会话写过的', () => withState(() => {
  const root = makeRepo();
  for (let i = 0; i < 8; i += 1) fs.writeFileSync(path.join(root, `dirty${i}.txt`), 'x');
  for (const n of ['a', 'b', 'c']) assert.equal(write(root, n).verdict, 'allow');
}));

test('不同会话各自独立计数', () => withState(() => {
  const root = makeRepo();
  for (const n of ['a', 'b', 'c']) write(root, n, 's1');
  assert.equal(write(root, 'x', 's2').verdict, 'allow');
  assert.equal(write(root, 'd', 's1').verdict, 'deny');
}));

test('linked worktree 内不受限（Tier 2/3 写手的落点）', () => withState(() => {
  const root = makeRepo();
  const wt = path.join(path.dirname(root), `${path.basename(root)}-wt`);
  sh(root, 'worktree', 'add', '-q', '-b', 'task/x', wt);
  const real = fs.realpathSync(wt);
  for (const n of ['a', 'b', 'c', 'd', 'e', 'f']) {
    assert.equal(assessTierGate({ target: path.join(real, 'src', n), sessionId: 's1' }).verdict, 'allow', n);
  }
}));

test('主 checkout 上的功能分支不受限', () => withState(() => {
  const root = makeRepo();
  sh(root, 'checkout', '-q', '-b', 'feat/x');
  for (const n of ['a', 'b', 'c', 'd', 'e']) assert.equal(write(root, n).verdict, 'allow', n);
}));

test('openspec/ 产物不计数也不拦（Tier 3 的主会话要写 spec）', () => withState(() => {
  const root = makeRepo();
  for (const n of ['a', 'b', 'c']) write(root, n);
  const r = assessTierGate({ target: path.join(root, 'openspec', 'changes', 'x', 'proposal.md'), sessionId: 's1' });
  assert.equal(r.verdict, 'allow');
}));

test('仓库之外、非 git 目录、缺 session_id 一律放行', () => withState(() => {
  const root = makeRepo();
  for (const n of ['a', 'b', 'c']) write(root, n);
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'plain-'));
  assert.equal(assessTierGate({ target: path.join(plain, 'f.txt'), sessionId: 's1' }).verdict, 'allow');
  assert.equal(assessTierGate({ target: path.join(root, 'src', 'z'), sessionId: '' }).verdict, 'allow');
  assert.equal(assessTierGate({ target: path.join(root, 'src', 'z') }).verdict, 'allow');
}));

test('状态文件损坏时放行，并在下一次写入时重建', () => withState((dir) => {
  const root = makeRepo();
  write(root, 'a');
  for (const f of fs.readdirSync(dir)) fs.writeFileSync(path.join(dir, f), '{not json');
  assert.equal(write(root, 'b').verdict, 'allow');
}));

test('PIPELINE_TIER_GATE=off 与自定义上限', () => withState(() => {
  const root = makeRepo();
  process.env.PIPELINE_TIER_GATE_LIMIT = '1';
  assert.equal(write(root, 'a').verdict, 'allow');
  assert.equal(write(root, 'b').verdict, 'deny');
  process.env.PIPELINE_TIER_GATE = 'off';
  assert.equal(write(root, 'c').verdict, 'allow');
}));

test('新建文件（目标尚不存在）也能判定', () => withState(() => {
  const root = makeRepo();
  for (const n of ['deep/new/a', 'deep/new/b', 'deep/new/c']) assert.equal(write(root, n).verdict, 'allow', n);
  assert.equal(write(root, 'deep/new/d').verdict, 'deny');
}));

// ---- hook 进程级：从 stdin 读事件、按契约输出 ----

function runGuardHook(payload, env = {}) {
  return spawnSync('node', [GUARD_HOOK], { input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, ...env } });
}

test('scope-guard-hook 进程：第 4 个文件输出 deny JSON，其前不输出', () => withState((dir) => {
  const root = makeRepo();
  const env = { PIPELINE_TIER_GATE_STATE: dir };
  const call = (n) => runGuardHook({ session_id: 'proc1', tool_name: 'Edit', tool_input: { file_path: path.join(root, 'src', n) } }, env);
  for (const n of ['a', 'b', 'c']) {
    const r = call(n);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '', `${n} 应放行`);
  }
  const r = call('d');
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /tier-gate/);
}));

test('scope-guard-hook 进程：非写入工具与坏输入不干预', () => {
  assert.equal(runGuardHook({ session_id: 's', tool_name: 'Read', tool_input: { file_path: '/x' } }).stdout.trim(), '');
  const bad = spawnSync('node', [GUARD_HOOK], { input: 'not json', encoding: 'utf8' });
  assert.equal(bad.status, 0);
  assert.equal(bad.stdout.trim(), '');
});

// ---- 提醒 hook ----

test('提醒触发：用户当天两句真实的"执行"指令都会命中', () => {
  assert.equal(shouldRemind('完全没问题，执行上面的3步整体的优化。'), true);
  assert.equal(shouldRemind('按照目前的整个方案，执行上面的所有的整个优化。'), true);
  assert.equal(shouldRemind('fix the login bug'), true);
  assert.equal(shouldRemind('go ahead and implement it'), true);
});

test('提醒不触发：纯评估长问句、斜杠命令、空串', () => {
  assert.equal(shouldRemind('评估一下整个的Pipeline的整个Skill，整个的DAG和Wave的整个并发策略到底是否其实真正被彻底的执行了的？'), false);
  assert.equal(shouldRemind('/paseo-pipeline 做字典优化'), false);
  assert.equal(shouldRemind(''), false);
  assert.equal(shouldRemind(undefined), false);
  assert.equal(shouldRemind('你确定这14类的字典是完整的吗？'), false);
});

test('tier-reminder-hook 进程：命中时输出 additionalContext，未命中与坏输入无输出', () => {
  const run = (input, env = {}) => spawnSync('node', [REMINDER_HOOK], { input, encoding: 'utf8', env: { ...process.env, ...env } });
  const hit = run(JSON.stringify({ prompt: '执行上面的优化' }));
  assert.equal(hit.status, 0);
  const out = JSON.parse(hit.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.equal(out.hookSpecificOutput.additionalContext, REMINDER);
  assert.match(REMINDER, /\/paseo-handoff/);
  assert.match(REMINDER, /\/paseo-pipeline/);
  assert.equal(run(JSON.stringify({ prompt: '你好' })).stdout.trim(), '');
  assert.equal(run('garbage').stdout.trim(), '');
  assert.equal(run(JSON.stringify({ prompt: '执行' }), { PIPELINE_TIER_REMINDER: 'off' }).stdout.trim(), '');
});
