import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assessTierGate, assessStop, takeSnapshot, logHookError, scopeKey } from '../lib/tier-gate.mjs';
import { shouldRemind, REMINDER } from '../hooks/tier-reminder-hook.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const GUARD_HOOK = path.join(here, '..', 'hooks', 'tier-write-hook.mjs');
const REMINDER_HOOK = path.join(here, '..', 'hooks', 'tier-reminder-hook.mjs');
const SESSION_HOOK = path.join(here, '..', 'hooks', 'tier-session-hook.mjs');
const STOP_HOOK = path.join(here, '..', 'hooks', 'tier-stop-hook.mjs');

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

test('tier-write-hook 进程：非写入工具与坏输入不干预', () => {
  assert.equal(runGuardHook({ session_id: 's', tool_name: 'Read', tool_input: { file_path: '/x' } }).stdout.trim(), '');
  const bad = spawnSync('node', [GUARD_HOOK], { input: 'not json', encoding: 'utf8' });
  assert.equal(bad.status, 0);
  assert.equal(bad.stdout.trim(), '');
});

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
  const run = (input, env = {}) => spawnSync('node', [REMINDER_HOOK], { input, encoding: 'utf8', env: { ...process.env, ...env } });
  const hit = run(JSON.stringify({ prompt: '继续' }));
  assert.equal(hit.status, 0);
  const out = JSON.parse(hit.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.equal(out.hookSpecificOutput.additionalContext, REMINDER);
  assert.match(REMINDER, /\/paseo-handoff/);
  assert.match(REMINDER, /\/paseo-pipeline/);
  assert.match(REMINDER, /Bash/);
  assert.equal(run(JSON.stringify({ prompt: '/tdd' })).stdout.trim(), '');
  assert.equal(run('garbage').stdout.trim(), '');
  assert.equal(run(JSON.stringify({ prompt: '执行' }), { PIPELINE_TIER_REMINDER: 'off' }).stdout.trim(), '');
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
  const r = spawnSync('node', [SESSION_HOOK], { input: '{}', encoding: 'utf8' });
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(out.hookSpecificOutput.additionalContext, /Tier 1/);
  assert.match(out.hookSpecificOutput.additionalContext, /Tier 3/);
  const off = spawnSync('node', [SESSION_HOOK], { input: '{}', encoding: 'utf8', env: { ...process.env, PIPELINE_TIER_REMINDER: 'off' } });
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

test('Stop 核对：worktree、功能分支、无快照、gate off 都放行', () => withState(() => {
  const root = makeRepo();
  assert.equal(stop(root).verdict, 'ok'); // 无快照
  sh(root, 'checkout', '-q', '-b', 'feat/x');
  snap(root);
  bashWrite(root, ['a', 'b', 'c', 'd', 'e']);
  assert.equal(stop(root).verdict, 'ok');
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

test('Stop 核对：跨轮次用 Bash 小步写入，累计超限仍被 block', () => withState(() => {
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
  // 用户答复后没有新改动：同一批文件不再重复打断。
  snap(root, 'multi');
  assert.equal(stop(root, 'multi').verdict, 'ok');
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

// ---- fail-open 留痕 ----

test('hook 异常写入 errors.log，而不是静默吞掉', () => withState((dir) => {
  logHookError('probe', new Error('boom'));
  const log = fs.readFileSync(path.join(dir, 'errors.log'), 'utf8');
  assert.match(log, /probe/);
  assert.match(log, /boom/);
}));
