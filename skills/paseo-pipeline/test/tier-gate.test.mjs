import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assessTierGate, assessStop, takeSnapshot, logHookError, scopeKey, readDeclaredPlan } from '../lib/tier-gate.mjs';
import { shouldRemind, isSystemNotification, REMINDER } from '../hooks/tier-reminder-hook.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const GUARD_HOOK = path.join(here, '..', 'hooks', 'tier-write-hook.mjs');
const REMINDER_HOOK = path.join(here, '..', 'hooks', 'tier-reminder-hook.mjs');
const SESSION_HOOK = path.join(here, '..', 'hooks', 'tier-session-hook.mjs');
const STOP_HOOK = path.join(here, '..', 'hooks', 'tier-stop-hook.mjs');

// 测试进程自己可能跑在 Paseo 里（PASEO_AGENT_ID 已设）。注入判定不看这个变量，仍主动清掉以固定前提。
const cleanEnv = (extra = {}) => {
  const env = { ...process.env, ...extra };
  if (!('PASEO_AGENT_ID' in extra)) delete env.PASEO_AGENT_ID;
  return env;
};

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
  assert.equal(d.verdict, 'ask');
  assert.match(d.reason, /Tier 1 上限/);
  assert.match(d.reason, /\/paseo-handoff/);
  assert.match(d.reason, /\/paseo-pipeline/);
  assert.match(d.reason, /a、.*b、.*c|src\/a/);
}));

test('同一文件反复写只计一次', () => withState(() => {
  const root = makeRepo();
  for (let i = 0; i < 10; i += 1) assert.equal(write(root, 'a').verdict, 'allow');
  for (const n of ['b', 'c']) assert.equal(write(root, n).verdict, 'allow');
  assert.equal(write(root, 'd').verdict, 'ask');
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
  assert.equal(write(root, 'd', 's1').verdict, 'ask');
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

test('主 checkout 上的功能分支同样受限（隔离靠 worktree，不靠分支）', () => withState(() => {
  const root = makeRepo();
  sh(root, 'checkout', '-q', '-b', 'feat/x');
  for (const n of ['a', 'b', 'c']) assert.equal(write(root, n).verdict, 'allow', n);
  assert.equal(write(root, 'd').verdict, 'ask');
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
  assert.equal(write(root, 'b').verdict, 'ask');
  process.env.PIPELINE_TIER_GATE = 'off';
  assert.equal(write(root, 'c').verdict, 'allow');
}));

test('新任务段从零计数：空闲超过阈值后不再沿用上一段的写量', () => withState((dir) => {
  const root = makeRepo();
  for (const n of ['a', 'b', 'c']) write(root, n);
  assert.equal(write(root, 'd').verdict, 'ask');
  // Rewind the ledger clock to simulate a finished task followed by a new request.
  for (const f of fs.readdirSync(dir)) {
    const state = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const key of Object.keys(state)) state[key].at = Date.now() - 31 * 60 * 1000;
    fs.writeFileSync(path.join(dir, f), JSON.stringify(state));
  }
  assert.equal(write(root, 'd').verdict, 'allow');
}));

test('空闲阈值可调，且段内不会被自己的间隔重置', () => withState((dir) => {
  const root = makeRepo();
  process.env.PIPELINE_TIER_GATE_IDLE_MS = '0';
  assert.equal(write(root, 'a').verdict, 'allow');
  // idle=0 means every gap counts as a new segment, which is the old pre-fix behaviour opt-in.
  assert.equal(write(root, 'b').verdict, 'allow');
  delete process.env.PIPELINE_TIER_GATE_IDLE_MS;
  const files = fs.readdirSync(dir).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  assert.ok(files.length > 0);
}));

test('legacy array ledger still counts', () => withState((dir) => {
  const root = makeRepo();
  fs.writeFileSync(path.join(dir, 's1.json'), JSON.stringify({ [fs.realpathSync(root)]: ['src/a', 'src/b', 'src/c'] }));
  assert.equal(write(root, 'd').verdict, 'ask');
}));

test('新建文件（目标尚不存在）也能判定', () => withState(() => {
  const root = makeRepo();
  for (const n of ['deep/new/a', 'deep/new/b', 'deep/new/c']) assert.equal(write(root, n).verdict, 'allow', n);
  assert.equal(write(root, 'deep/new/d').verdict, 'ask');
}));

// ---- 跨作用域（「单目录」维度） ----

test('跨包：第 2 个文件就 ask，而不是等到第 4 个', () => withState(() => {
  const root = makeRepo();
  assert.equal(assessTierGate({ target: path.join(root, 'packages', 'server', 'a.ts'), sessionId: 's1' }).verdict, 'allow');
  const web = assessTierGate({ target: path.join(root, 'packages', 'web', 'b.tsx'), sessionId: 's1' });
  assert.equal(web.verdict, 'ask');
  assert.match(web.reason, /2 个作用域/);
  assert.match(web.reason, /packages\/server/);
  assert.match(web.reason, /packages\/web/);
}));

test('跨作用域不产生豁免：被拒绝后重试仍 ask，第三个包仍 ask', () => withState(() => {
  const root = makeRepo();
  const at = (p) => assessTierGate({ target: path.join(root, p), sessionId: 's1' });
  assert.equal(at('packages/server/a.ts').verdict, 'allow');
  assert.equal(at('packages/web/b.tsx').verdict, 'ask');
  assert.equal(at('packages/web/b.tsx').verdict, 'ask');
  // 若 ask 被当成豁免，跨到第三个包会退回「文件数未满」而 allow。
  assert.equal(at('packages/shared/c.ts').verdict, 'ask');
}));

test('同包不同目录不算跨作用域（单目录仍按包根判定）', () => withState(() => {
  const root = makeRepo();
  const at = (p) => assessTierGate({ target: path.join(root, p), sessionId: 's1' });
  assert.equal(at('packages/server/src/routes/a.ts').verdict, 'allow');
  assert.equal(at('packages/server/src/services/b.ts').verdict, 'allow');
  assert.equal(at('packages/server/test/c.test.ts').verdict, 'allow');
}));

test('非工作区布局退化为顶层目录；根目录文件算 "."', () => withState(() => {
  const root = makeRepo();
  assert.equal(write(root, 'a').verdict, 'allow'); // src/a
  assert.equal(assessTierGate({ target: path.join(root, 'README.md'), sessionId: 's1' }).verdict, 'ask');
}));

test('scopeKey：工作区根取前两段，其余取顶层目录', () => {
  assert.equal(scopeKey('packages/web/src/app.tsx'), 'packages/web');
  assert.equal(scopeKey('skills/paseo-ui/SKILL.md'), 'skills/paseo-ui');
  assert.equal(scopeKey('docs/design.md'), 'docs');
  assert.equal(scopeKey('README.md'), '.');
});

test('custom limit 仍生效，且跨作用域判定优先于文件数', () => withState(() => {
  const root = makeRepo();
  process.env.PIPELINE_TIER_GATE_LIMIT = '5';
  assert.equal(assessTierGate({ target: path.join(root, 'packages', 'a', 'x.ts'), sessionId: 's1' }).verdict, 'allow');
  const cross = assessTierGate({ target: path.join(root, 'packages', 'b', 'y.ts'), sessionId: 's1' });
  assert.equal(cross.verdict, 'ask');
}));

// ---- hook 进程级：从 stdin 读事件、按契约输出 ----

function runGuardHook(payload, env = {}) {
  return spawnSync('node', [GUARD_HOOK], { input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, ...env } });
}

test('tier-write-hook 进程：第 4 个文件输出 ask JSON，其前不输出', () => withState((dir) => {
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
  assert.equal(out.hookSpecificOutput.permissionDecision, 'ask');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /tier-gate/);
}));

test('tier-write-hook 进程：声明超限时首次写入直接 deny，不落账', () => withState((dir) => {
  const root = makeRepo();
  const transcript = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'TIER-PLAN: tier=1 files=src/a,src/b,src/c,src/d scope=src' }] } }));
  const payload = {
    session_id: 'proc2',
    transcript_path: transcript,
    tool_name: 'Write',
    tool_input: { file_path: path.join(root, 'src', 'a') },
  };
  const r = runGuardHook(payload, { PIPELINE_TIER_GATE_STATE: dir });
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /4 个文件/);
  // 同会话后续无声明写入不受影响：deny 的那一笔没有进账本。
  assert.equal(runGuardHook({ ...payload, transcript_path: undefined }, { PIPELINE_TIER_GATE_STATE: dir }).stdout.trim(), '');
}));

test('tier-write-hook 进程：非写入工具与坏输入不干预', () => {
  assert.equal(runGuardHook({ session_id: 's', tool_name: 'Read', tool_input: { file_path: '/x' } }).stdout.trim(), '');
  const bad = spawnSync('node', [GUARD_HOOK], { input: 'not json', encoding: 'utf8' });
  assert.equal(bad.status, 0);
  assert.equal(bad.stdout.trim(), '');
});

// ---- 开工前声明（TIER-PLAN）----

test('readDeclaredPlan：取最后一次声明，缺省与坏格式返回 null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tier-transcript-'));
  const file = path.join(dir, 't.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'TIER-PLAN: tier=1 files=src/a.ts scope=src' }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '范围变了\nTIER-PLAN: tier=1 files=src/a.ts,src/b.ts scope=src\n' }] } }),
  ].join('\n'));
  assert.deepEqual(readDeclaredPlan(file), { tier: 1, files: ['src/a.ts', 'src/b.ts'] });
  assert.equal(readDeclaredPlan(path.join(dir, 'missing.jsonl')), null);
  fs.writeFileSync(file, 'no declaration here');
  assert.equal(readDeclaredPlan(file), null);
  fs.writeFileSync(file, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'TIER-PLAN: tier=1 files=none scope=src' }] } }));
  assert.deepEqual(readDeclaredPlan(file), { tier: 1, files: [] });
});

test('readDeclaredPlan：只认 assistant 文本，提醒示例与工具输出不算声明', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tier-transcript-'));
  const file = path.join(dir, 't.jsonl');
  const reminder = '[分级提醒] 动手改任何文件之前……\nTIER-PLAN: tier=1 files=src/a.ts,src/b.ts scope=src';
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: reminder }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'TIER-PLAN: tier=1 files=src/c.ts scope=src' }] } }),
  ].join('\n'));
  assert.deepEqual(readDeclaredPlan(file), { tier: 1, files: ['src/c.ts'] });
  // 只有用户侧 / 提醒里的示例：没有声明。
  fs.writeFileSync(file, JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: reminder }] } }));
  assert.equal(readDeclaredPlan(file), null);
});

test('开工前声明：计划超过 Tier 1 上限 → 首次写入就 deny', () => withState(() => {
  const root = makeRepo();
  const declared = { tier: 1, files: ['src/a', 'src/b', 'src/c', 'src/d'] };
  const v = assessTierGate({ target: path.join(root, 'src', 'a'), sessionId: 's1', declared });
  assert.equal(v.verdict, 'deny');
  assert.match(v.reason, /4 个文件/);
  assert.match(v.reason, /\/paseo-handoff/);
  // 拒绝的写入不占额度，也不会被记进账本。
  assert.equal(assessTierGate({ target: path.join(root, 'src', 'a'), sessionId: 's1' }).verdict, 'allow');
}));

test('开工前声明：跨 2 个作用域 → 首次写入就 deny', () => withState(() => {
  const root = makeRepo();
  const declared = { tier: 1, files: ['packages/server/a.ts', 'packages/web/b.tsx'] };
  const v = assessTierGate({ target: path.join(root, 'packages', 'server', 'a.ts'), sessionId: 's1', declared });
  assert.equal(v.verdict, 'deny');
  assert.match(v.reason, /2 个作用域/);
  assert.match(v.reason, /packages\/server/);
  assert.match(v.reason, /packages\/web/);
}));

test('开工前声明：Tier 2 在主 checkout 原地写 → deny，指向 handoff/worktree', () => withState(() => {
  const root = makeRepo();
  const declared = { tier: 2, files: ['src/a'] };
  const v = assessTierGate({ target: path.join(root, 'src', 'a'), sessionId: 's1', declared });
  assert.equal(v.verdict, 'deny');
  assert.match(v.reason, /Tier 2/);
  assert.match(v.reason, /worktree/);
}));

test('开工前声明：合规计划放行，后续仍按已写文件计数', () => withState(() => {
  const root = makeRepo();
  const declared = { tier: 1, files: ['src/a', 'src/b', 'src/c'] };
  assert.equal(assessTierGate({ target: path.join(root, 'src', 'a'), sessionId: 's1', declared }).verdict, 'allow');
  assert.equal(write(root, 'b').verdict, 'allow');
  assert.equal(write(root, 'c').verdict, 'allow');
  assert.equal(write(root, 'd').verdict, 'ask');
}));

test('开工前声明：openspec/ 与空声明不参与 Tier 1 计数', () => withState(() => {
  const root = makeRepo();
  const declared = { tier: 1, files: ['openspec/changes/x/proposal.md', 'openspec/changes/x/tasks.md'] };
  assert.equal(assessTierGate({ target: path.join(root, 'src', 'a'), sessionId: 's1', declared }).verdict, 'allow');
}));

// ---- 提醒 hook ----

test('提醒触发：续接类短句也命中（长会话里最容易直接动手的时刻）', () => {
  for (const p of ['好的，按方案B来', '继续', '可以，做吧', 'ok go', '把第2点也改了', '执行上面的优化', 'fix the login bug']) {
    assert.equal(shouldRemind(p), true, p);
  }
});

test('提醒不触发：斜杠命令、空串、非字符串', () => {
  assert.equal(shouldRemind('/paseo-pipeline 做字典优化'), false);
  assert.equal(shouldRemind('   '), false);
  assert.equal(shouldRemind(''), false);
  assert.equal(shouldRemind(undefined), false);
});

test('tier-reminder-hook 进程：非斜杠消息输出 additionalContext，斜杠与坏输入无输出', () => {
  const run = (input, env = {}) => spawnSync('node', [REMINDER_HOOK], { input, encoding: 'utf8', env: cleanEnv(env) });
  const hit = run(JSON.stringify({ prompt: '继续' }));
  assert.equal(hit.status, 0);
  const out = JSON.parse(hit.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.equal(out.hookSpecificOutput.additionalContext, REMINDER);
  assert.match(REMINDER, /\/paseo-handoff/);
  assert.match(REMINDER, /\/paseo-pipeline/);
  assert.match(REMINDER, /Bash/);
  assert.match(REMINDER, /TIER-PLAN: tier=1 files=/);
  assert.match(REMINDER, /≤3 个业务文件/);
  assert.equal(run(JSON.stringify({ prompt: '/tdd' })).stdout.trim(), '');
  assert.equal(run('garbage').stdout.trim(), '');
  assert.equal(run(JSON.stringify({ prompt: '执行' }), { PIPELINE_TIER_REMINDER: 'off' }).stdout.trim(), '');
});

const NOTIFICATION = '<paseo-system version="1" kind="agent-message" source-agent-id="a1">\n## Task\ndone\n</paseo-system>';

test('系统通知：不是人的消息，不提醒', () => {
  assert.equal(isSystemNotification(NOTIFICATION), true);
  assert.equal(isSystemNotification('  \n<task-notification id="x">done</task-notification>'), true);
  assert.equal(isSystemNotification('请看 <paseo-system> 这个标签'), false);
  assert.equal(shouldRemind(NOTIFICATION), false);
  assert.equal(shouldRemind('<task-notification>x</task-notification>'), false);
});

test('tier-reminder-hook 进程：系统通知无输出；cwd 非仓库/缺失仍注入；linked worktree 跳过', () => withState((dir) => {
  const run = (payload, env = {}) => spawnSync('node', [REMINDER_HOOK], { input: JSON.stringify(payload), encoding: 'utf8', env: cleanEnv({ PIPELINE_TIER_GATE_STATE: dir, ...env }) });
  const root = makeRepo();
  const plain = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tier-nogit-')));
  assert.equal(run({ prompt: NOTIFICATION, cwd: root, session_id: 'n1' }).stdout.trim(), '');
  assert.match(run({ prompt: '继续', cwd: root, session_id: 'n1' }).stdout, /分级提醒/);
  assert.match(run({ prompt: '继续', cwd: plain, session_id: 'n1' }).stdout, /分级提醒/, 'null repo context 仍注入');
  assert.match(run({ prompt: '继续' }).stdout, /分级提醒/, '无 cwd 仍注入');
  // 人的会话跑在 Paseo 里也带 PASEO_AGENT_ID；只看 cwd，环境变量不参与判定。
  assert.match(run({ prompt: '继续', cwd: root, session_id: 'n1' }, { PASEO_AGENT_ID: 'abc' }).stdout, /分级提醒/, '主 checkout 上 agent 环境变量不抑制');
  const wt = path.join(path.dirname(root), `${path.basename(root)}-wt`);
  sh(root, 'worktree', 'add', '-q', '-b', 'feat/x', wt);
  assert.equal(run({ prompt: '继续', cwd: wt, session_id: 'n1' }).stdout.trim(), '');
}));

test('tier-session-hook 进程：linked worktree 不注入，非仓库 cwd 与 agent 环境变量仍注入', () => {
  const run = (payload, env = {}) => spawnSync('node', [SESSION_HOOK], { input: JSON.stringify(payload), encoding: 'utf8', env: cleanEnv(env) });
  const root = makeRepo();
  const plain = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tier-nogit-')));
  assert.match(run({ cwd: root }).stdout, /分级规则/);
  assert.match(run({ cwd: plain }).stdout, /分级规则/);
  assert.match(run({ cwd: root }, { PASEO_AGENT_ID: 'abc' }).stdout, /分级规则/, '主 checkout 上 agent 环境变量不抑制');
  const wt = path.join(path.dirname(root), `${path.basename(root)}-wt`);
  sh(root, 'worktree', 'add', '-q', '-b', 'feat/y', wt);
  assert.equal(run({ cwd: wt }).stdout.trim(), '');
});

// ---- ask 语义 ----

test('越线写入被拒绝后重试仍然 ask，不会溜过去；放行额度不被占用', () => withState(() => {
  const root = makeRepo();
  for (const n of ['a', 'b', 'c']) write(root, n);
  assert.equal(write(root, 'd').verdict, 'ask');
  assert.equal(write(root, 'd').verdict, 'ask');
  assert.equal(write(root, 'a').verdict, 'allow');
}));

// ---- SessionStart hook ----

test('tier-session-hook 进程：输出 SessionStart additionalContext，含分级规则', () => {
  const r = spawnSync('node', [SESSION_HOOK], { input: '{}', encoding: 'utf8', env: cleanEnv() });
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(out.hookSpecificOutput.additionalContext, /Tier 1/);
  assert.match(out.hookSpecificOutput.additionalContext, /Tier 3/);
  const off = spawnSync('node', [SESSION_HOOK], { input: '{}', encoding: 'utf8', env: cleanEnv({ PIPELINE_TIER_REMINDER: 'off' }) });
  assert.equal(off.stdout.trim(), '');
});

// ---- Stop 核对（补 Bash 写入） ----

const bashWrite = (root, names) => { for (const n of names) fs.writeFileSync(path.join(root, 'src', n), `bash ${Date.now()}`); };
const snap = (root, sid = 'st1') => takeSnapshot({ cwd: root, sessionId: sid });
const stop = (root, sid = 'st1') => assessStop({ cwd: root, sessionId: sid });

test('Stop 核对：Bash 写 4 个文件（PreToolUse 看不到）被 block', () => withState(() => {
  const root = makeRepo();
  snap(root);
  bashWrite(root, ['a', 'b', 'c', 'd']);
  const v = stop(root);
  assert.equal(v.verdict, 'block');
  assert.match(v.reason, /src\/a/);
  assert.match(v.reason, /汇报/);
}));

test('Stop 核对：3 个以内放行；本轮之前的脏文件不算', () => withState(() => {
  const root = makeRepo();
  for (let i = 0; i < 6; i += 1) fs.writeFileSync(path.join(root, `dirty${i}.txt`), 'x');
  snap(root);
  bashWrite(root, ['a', 'b', 'c']);
  assert.equal(stop(root).verdict, 'ok');
}));

test('Stop 核对：本轮内提交掉的改动也算', () => withState(() => {
  const root = makeRepo();
  snap(root);
  bashWrite(root, ['a', 'b', 'c', 'd']);
  sh(root, 'add', '.'); sh(root, 'commit', '-q', '-m', 'sneaky');
  assert.equal(stop(root).verdict, 'block');
}));

test('Stop 核对：openspec/ 不计；经 ask 流程用户确认过的文件不计', () => withState(() => {
  const root = makeRepo();
  snap(root);
  fs.mkdirSync(path.join(root, 'openspec'));
  for (const n of ['1', '2', '3', '4', '5']) fs.writeFileSync(path.join(root, 'openspec', n), 'x');
  assert.equal(stop(root).verdict, 'ok');
  for (const n of ['a', 'b', 'c']) write(root, n, 'st1');
  assert.equal(write(root, 'd', 'st1').verdict, 'ask'); // 用户在确认框放行后 d 才会真的被写
  bashWrite(root, ['a', 'b', 'c', 'd']);
  assert.equal(stop(root).verdict, 'ok');
}));

test('Stop 核对：worktree、无快照、gate off 放行；主 checkout 功能分支仍核对', () => withState(() => {
  const root = makeRepo();
  assert.equal(stop(root).verdict, 'ok'); // 无快照
  sh(root, 'checkout', '-q', '-b', 'feat/x');
  snap(root);
  bashWrite(root, ['a', 'b', 'c', 'd', 'e']);
  assert.equal(stop(root).verdict, 'block');
  sh(root, 'checkout', '-q', 'main');
  snap(root, 'st2');
  bashWrite(root, ['f', 'g', 'h', 'i', 'j']);
  process.env.PIPELINE_TIER_GATE = 'off';
  try { assert.equal(stop(root, 'st2').verdict, 'ok'); } finally { delete process.env.PIPELINE_TIER_GATE; }
}));

test('tier-reminder-hook + tier-stop-hook 进程：快照 → Bash 写 → block；stop_hook_active 时放行', () => withState((dir) => {
  const root = makeRepo();
  const env = { ...process.env, PIPELINE_TIER_GATE_STATE: dir };
  const run = (hook, payload) => spawnSync('node', [hook], { input: JSON.stringify(payload), encoding: 'utf8', env });
  assert.equal(run(REMINDER_HOOK, { prompt: '继续', session_id: 'p1', cwd: root }).status, 0);
  bashWrite(root, ['a', 'b', 'c', 'd']);
  const out = JSON.parse(run(STOP_HOOK, { session_id: 'p1', cwd: root }).stdout);
  assert.equal(out.decision, 'block');
  assert.equal(run(STOP_HOOK, { session_id: 'p1', cwd: root, stop_hook_active: true }).stdout.trim(), '');
}));

test('Stop 核对：CP-2 合流（--no-ff）不算主 checkout 原地写', () => withState(() => {
  const root = makeRepo();
  sh(root, 'checkout', '-q', '-b', 'integration/x');
  for (const n of ['a', 'b', 'c', 'd']) fs.writeFileSync(path.join(root, 'src', n), n);
  sh(root, 'add', '.'); sh(root, 'commit', '-q', '-m', 'branch work');
  sh(root, 'checkout', '-q', 'main');
  snap(root);
  sh(root, 'merge', '-q', '--no-ff', 'integration/x', '-m', 'merge');
  assert.equal(stop(root).verdict, 'ok');
}));

test('Stop 核对：fast-forward 拉取远端提交不算主 checkout 原地写', () => withState(() => {
  const root = makeRepo();
  snap(root);
  // A second worktree stands in for "work that arrived from the remote".
  const wt = path.join(path.dirname(root), `${path.basename(root)}-pull`);
  sh(root, 'worktree', 'add', '-q', '-b', 'incoming', wt);
  for (const n of ['a', 'b', 'c', 'd']) fs.writeFileSync(path.join(fs.realpathSync(wt), 'src', n), n);
  sh(fs.realpathSync(wt), 'add', '.'); sh(fs.realpathSync(wt), 'commit', '-q', '-m', 'remote');
  sh(root, 'update-ref', 'refs/remotes/origin/main', 'incoming');
  sh(root, 'merge', '-q', '--ff-only', 'incoming');
  assert.equal(stop(root).verdict, 'ok');
}));

test('Stop 核对：stash 还原本轮前的脏文件不算改动', () => withState(() => {
  const root = makeRepo();
  // Tracked files that are dirty before the snapshot (the old false positive).
  for (const n of ['a', 'b', 'c', 'd']) {
    fs.writeFileSync(path.join(root, 'src', n), 'before');
    sh(root, 'add', '.');
  }
  sh(root, 'commit', '-q', '-m', 'track');
  for (const n of ['a', 'b', 'c', 'd']) fs.writeFileSync(path.join(root, 'src', n), 'dirty');
  snap(root);
  sh(root, 'stash', '-q');
  assert.equal(stop(root).verdict, 'ok');
}));

test('Stop 核对：不将 Git 脏文件并回 seg.files，PreToolUse 额度不被污染', () => withState(() => {
  const root = makeRepo();
  snap(root, 'clean');
  bashWrite(root, ['a', 'b']);
  assert.equal(stop(root, 'clean').verdict, 'ok');
  // 关键不变式：Bash 造成的 Git 脏文件不回写进入 seg.files
  // 当前会话后续结构化写入（Write/Edit）仍然拥有完整的 3 个额度
  assert.equal(write(root, 'x', 'clean').verdict, 'allow');
  assert.equal(write(root, 'y', 'clean').verdict, 'allow');
  assert.equal(write(root, 'z', 'clean').verdict, 'allow');
  assert.equal(write(root, 'extra', 'clean').verdict, 'ask');
}));

test('Stop 核对：跨轮次用 Bash 小步写入，累计超限仍被 block（累计在 stopFiles，不在 files）', () => withState((dir) => {
  const root = makeRepo();
  snap(root, 'multi');
  bashWrite(root, ['a', 'b']);
  assert.equal(stop(root, 'multi').verdict, 'ok');
  snap(root, 'multi');
  bashWrite(root, ['c', 'd']);
  const blocked = stop(root, 'multi');
  assert.equal(blocked.verdict, 'block');
  assert.match(blocked.reason, /累计/);
  assert.match(blocked.reason, /src\/a/);
  // 累计只进 Stop 私有字段；PreToolUse 的 files 保持为空
  const ledger = JSON.parse(fs.readFileSync(path.join(dir, 'multi.json'), 'utf8'));
  const entry = Object.values(ledger)[0];
  assert.deepEqual(entry.files, []);
  assert.equal(entry.stopFiles.length, 4);
  // 用户答复后没有新改动：同一批文件不再重复打断。
  snap(root, 'multi');
  assert.equal(stop(root, 'multi').verdict, 'ok');
}));

test('Stop 核对：PreToolUse 写入不抹掉 Stop 的 stopFiles 累计', () => withState(() => {
  const root = makeRepo();
  snap(root, 'keep');
  bashWrite(root, ['a', 'b']);
  assert.equal(stop(root, 'keep').verdict, 'ok');
  assert.equal(write(root, 'x', 'keep').verdict, 'allow'); // 写回账本时必须带上 stopFiles
  snap(root, 'keep');
  bashWrite(root, ['c']);
  assert.equal(stop(root, 'keep').verdict, 'block'); // a,b,c + x = 4
}));

test('Stop 核对：并发会话已认领的文件不算进本会话', () => withState(() => {
  const root = makeRepo();
  // s1 经 PreToolUse 认领 p1-p3（计入 files）与 p4（ask，进 asked）
  for (const n of ['p1', 'p2', 'p3']) write(root, n, 's1');
  assert.equal(write(root, 'p4', 's1').verdict, 'ask');
  // s2 先于落盘拍快照；随后工作树出现 p1-p4（并发 agent 的产物）
  snap(root, 's2');
  bashWrite(root, ['p1', 'p2', 'p3', 'p4']);
  const v = stop(root, 's2');
  assert.equal(v.verdict, 'ok');
  assert.deepEqual(v.files, []);
  // 对照：没有任何会话认领时，同样的 4 个文件会被 block
  snap(root, 's3');
  bashWrite(root, ['q1', 'q2', 'q3', 'q4']);
  assert.equal(stop(root, 's3').verdict, 'block');
}));

test('连续多轮原地改：第 3 轮 Stop 汇报一次，用户回话后重新观察', () => withState(() => {
  const root = makeRepo();
  // 真实时序：每条用户消息到达先快照，再动手，再 Stop。
  for (let round = 1; round <= 2; round += 1) {
    snap(root, 'churn');
    bashWrite(root, ['a']);
    assert.equal(stop(root, 'churn').verdict, 'ok', `第 ${round} 轮不该打断`);
  }
  snap(root, 'churn');
  bashWrite(root, ['a']);
  const escalated = stop(root, 'churn');
  assert.equal(escalated.verdict, 'block');
  assert.match(escalated.reason, /连续 3 轮/);
  assert.match(escalated.reason, /diagnosing-bugs/);
  assert.match(escalated.reason, /paseo-handoff/);
  // 逐次写入不再因 churn 弹窗：拦的是「停下来汇报」，不是每次 Edit 的许可。
  assert.equal(write(root, 'b', 'churn').verdict, 'allow');
  // 用户回话 = 报告已看过，轮次清零；但文件账本不清（1 个文件不越界，继续按文件数管）。
  snap(root, 'churn');
  bashWrite(root, ['a']);
  assert.equal(stop(root, 'churn').verdict, 'ok');
  for (let round = 2; round <= 3; round += 1) {
    snap(root, 'churn');
    bashWrite(root, ['a']);
    assert.equal(stop(root, 'churn').verdict, round === 2 ? 'ok' : 'block', `新一轮第 ${round} 轮`);
  }
}));

test('逐轮新增文件的正常增量工作不触发 churn 汇报', () => withState(() => {
  const root = makeRepo();
  process.env.PIPELINE_TIER_GATE_LIMIT = '20';
  try {
    for (let round = 1; round <= 5; round += 1) {
      snap(root, 'growth');
      bashWrite(root, [`g${round}`]);
      assert.equal(stop(root, 'growth').verdict, 'ok', `第 ${round} 轮不该打断`);
    }
  } finally { delete process.env.PIPELINE_TIER_GATE_LIMIT; }
}));

test('系统通知轮：刷新快照，但不重置 churn 计数', () => withState((dir) => {
  const root = makeRepo();
  for (let round = 1; round <= 2; round += 1) {
    snap(root, 'sys');
    bashWrite(root, ['a']);
    assert.equal(stop(root, 'sys').verdict, 'ok');
  }
  // 第 3 轮：先有一条系统通知到达（不是用户答复），Bash 又改了文件。
  takeSnapshot({ cwd: root, sessionId: 'sys', isHumanTurn: false });
  const ledger = () => JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir).find((f) => f === 'sys.json')), 'utf8'))[root];
  assert.equal(ledger().turns, 2, '系统通知不清零');
  bashWrite(root, ['a']);
  const escalated = stop(root, 'sys');
  assert.equal(escalated.verdict, 'block');
  assert.match(escalated.reason, /连续 3 轮/);
  // 汇报后又来一条系统通知：churnReported 不能被清掉，否则同一批会重复打断。
  takeSnapshot({ cwd: root, sessionId: 'sys', isHumanTurn: false });
  assert.equal(ledger().churnReported, true);
  bashWrite(root, ['a']);
  assert.equal(stop(root, 'sys').verdict, 'ok');
  // 真正的用户消息才清零。
  takeSnapshot({ cwd: root, sessionId: 'sys' });
  assert.equal(ledger().turns, 0);
  assert.equal(ledger().churnReported, false);
}));

test('系统通知轮：仍刷新快照基线，遗留脏文件不被算成下一轮的改动', () => withState(() => {
  const root = makeRepo();
  snap(root, 'base');
  bashWrite(root, ['a', 'b']);
  assert.equal(stop(root, 'base').verdict, 'ok');
  takeSnapshot({ cwd: root, sessionId: 'base', isHumanTurn: false });
  // 本轮没有新写入：a、b 已在基线里，不应再被当作改动。
  const r = stop(root, 'base');
  assert.equal(r.verdict, 'ok');
  assert.deepEqual(r.files, []);
}));

test('Stop 核对：Bash 跨 packages/server 与 packages/web 各写 1 个文件 → block；同作用域 2 个不拦', () => withState(() => {
  const root = makeRepo();
  const put = (rel) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), 'x'); };
  snap(root, 'scope');
  put('packages/server/a.ts');
  put('packages/web/b.ts');
  const blocked = stop(root, 'scope');
  assert.equal(blocked.verdict, 'block');
  assert.match(blocked.reason, /跨 2 个作用域/);
  assert.match(blocked.reason, /packages\/server/);
  assert.match(blocked.reason, /packages\/web/);
  // 同一批只汇报一次。
  snap(root, 'scope');
  assert.equal(stop(root, 'scope').verdict, 'ok');

  snap(root, 'same');
  put('packages/server/x.ts');
  put('packages/server/y/z.ts');
  assert.equal(stop(root, 'same').verdict, 'ok');
}));

// ---- fail-open 留痕 ----

test('hook 异常写入 errors.log，而不是静默吞掉', () => withState((dir) => {
  logHookError('probe', new Error('boom'));
  const log = fs.readFileSync(path.join(dir, 'errors.log'), 'utf8');
  assert.match(log, /probe/);
  assert.match(log, /boom/);
}));
