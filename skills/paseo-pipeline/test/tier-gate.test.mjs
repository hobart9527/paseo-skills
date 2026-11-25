import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assessTierGate, assessStop, takeSnapshot, repoContext, logHookError, scopeKey, TIER_RULES, DEFAULT_LIMIT } from '../lib/tier-gate.mjs';
import { recordReview } from '../lib/review-record.mjs';
import { shouldRemind, isReadOnlyPrompt, isSystemNotification, REMINDER } from '../hooks/tier-reminder-hook.mjs';

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

test('段级单次确认：file_limit / scope_cross 实际放行落盘后，同段后续同类越界不再重复弹窗', () => withState((dir) => {
  const root = makeRepo();
  const touch = (rel, body = 'export const x = 1;\n') => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
    return p;
  };
  for (const n of ['src/a.js', 'src/b.js', 'src/c.js']) {
    const p = touch(n);
    assert.equal(assessTierGate({ target: p, sessionId: 'seg-limit' }).verdict, 'allow');
  }
  const dPath = path.join(root, 'src/d.js');
  const dAsk = assessTierGate({ target: dPath, sessionId: 'seg-limit' });
  assert.equal(dAsk.verdict, 'ask');
  assert.equal(dAsk.reasonCode, 'file_limit');
  // 拒绝落盘（未写入 d）时，第 5 个文件仍 ask
  const eAsk = assessTierGate({ target: path.join(root, 'src/e.js'), sessionId: 'seg-limit' });
  assert.equal(eAsk.verdict, 'ask');
  assert.equal(eAsk.reasonCode, 'file_limit');
  // 用户放行第 4 个文件并落盘后，第 5、6 个文件直接 allow
  touch('src/d.js', 'export const d = 1;\n');
  assert.equal(assessTierGate({ target: path.join(root, 'src/e.js'), sessionId: 'seg-limit' }).verdict, 'allow');
  assert.equal(assessTierGate({ target: path.join(root, 'src/f.js'), sessionId: 'seg-limit' }).verdict, 'allow');

  // scope_cross 同理：放行第 2 个包后，第 3 个包不再重复弹窗，直到空闲超时重置
  const aPath = touch('packages/server/a.ts');
  assert.equal(assessTierGate({ target: aPath, sessionId: 'seg-scope' }).verdict, 'allow');
  const bAsk = assessTierGate({ target: path.join(root, 'packages/web/b.tsx'), sessionId: 'seg-scope' });
  assert.equal(bAsk.verdict, 'ask');
  assert.equal(bAsk.reasonCode, 'scope_cross');
  touch('packages/web/b.tsx', 'export const b = 1;\n');
  assert.equal(assessTierGate({ target: path.join(root, 'packages/shared/c.ts'), sessionId: 'seg-scope' }).verdict, 'allow');

  // 空闲超过阈值重置任务段与 approvedRules
  for (const f of fs.readdirSync(dir)) {
    const st = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const k of Object.keys(st)) st[k].at = Date.now() - 31 * 60 * 1000;
    fs.writeFileSync(path.join(dir, f), JSON.stringify(st));
  }
  assert.equal(assessTierGate({ target: path.join(root, 'packages/core/d.ts'), sessionId: 'seg-scope' }).verdict, 'allow');
  assert.equal(assessTierGate({ target: path.join(root, 'packages/ui/e.ts'), sessionId: 'seg-scope' }).reasonCode, 'scope_cross');
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
  assert.equal(assessTierGate({ target: path.join(root, 'package.json'), sessionId: 's1' }).verdict, 'ask');
}));

test('根目录 Markdown 属于文档，不计数也不算第二个作用域', () => withState(() => {
  const root = makeRepo();
  assert.equal(write(root, 'a').verdict, 'allow'); // src/a
  assert.equal(assessTierGate({ target: path.join(root, 'README.md'), sessionId: 's1' }).verdict, 'allow');
  assert.equal(assessTierGate({ target: path.join(root, 'CLAUDE.md'), sessionId: 's1' }).verdict, 'allow');
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
  const transcript = path.join(dir, 'transcript');
  fs.writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { content: 'TIER-PLAN: tier=1 files=src/a' } }));
  const env = { PIPELINE_TIER_GATE_STATE: dir };
  const call = (n) => runGuardHook({ session_id: 'proc1', transcript_path: transcript, tool_name: 'Edit', tool_input: { file_path: path.join(root, 'src', n) } }, env);
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

test('tier-write-hook 进程：豁免路径与 worktree 放行，不再依赖 transcript 声明', () => withState((dir) => {
  const root = makeRepo();
  const payload = { session_id: 'exempt1', tool_name: 'Write', tool_input: { file_path: path.join(root, 'src/a') } };
  const call = (p, env = {}) => runGuardHook(p, { PIPELINE_TIER_GATE_STATE: dir, ...env });
  // 缺少 transcript_path 仍放行第 1..3 个源文件（不再解析 TIER-PLAN）
  assert.equal(call(payload).stdout.trim(), '');
  assert.equal(call({ ...payload, tool_input: { file_path: path.join(root, 'src/a') } }, { PIPELINE_TIER_GATE: 'off' }).stdout.trim(), '');
  assert.equal(call({ ...payload, session_id: '' }).stdout.trim(), '');
  assert.equal(call({ ...payload, tool_input: { file_path: path.join(root, 'openspec/x') } }).stdout.trim(), '');
  assert.equal(call({ ...payload, tool_input: { file_path: path.join(root, '.superpowers/x') } }).stdout.trim(), '');
  const wt = `${root}-wt`;
  sh(root, 'worktree', 'add', '-q', '-b', 'task/exempt', wt);
  assert.equal(call({ ...payload, tool_input: { file_path: path.join(wt, 'src/a') } }).stdout.trim(), '');
  assert.equal(call({ ...payload, tool_input: { file_path: path.join(wt, 'src/d') } }).stdout.trim(), '');
  // 测试和文档在主 checkout 同样豁免计数
  assert.equal(call({ ...payload, tool_input: { file_path: path.join(root, 'test/x.test.js') } }).stdout.trim(), '');
  assert.equal(call({ ...payload, tool_input: { file_path: path.join(root, 'docs/guide.md') } }).stdout.trim(), '');
}));

test('tier gate exempt paths never touch declaration loaders', () => withState(() => {
  const root = makeRepo();
  const unavailable = () => { throw new Error('must not call loader'); };
  for (const target of [path.join(root, 'openspec/x'), path.join(root, '.superpowers/x')]) {
    assert.equal(assessTierGate({ target, sessionId: 'lazy', loadDeclaration: unavailable }).verdict, 'allow');
  }
  const wt = `${root}-lazy-wt`;
  sh(root, 'worktree', 'add', '-q', '-b', 'task/lazy', wt);
  assert.equal(assessTierGate({ target: path.join(wt, 'src/a'), sessionId: 'lazy', loadDeclaration: unavailable }).verdict, 'allow');
}));

test('tier-write-hook 进程：非写入工具与坏输入不干预', () => {
  assert.equal(runGuardHook({ session_id: 's', tool_name: 'Read', tool_input: { file_path: '/x' } }).stdout.trim(), '');
  const bad = spawnSync('node', [GUARD_HOOK], { input: 'not json', encoding: 'utf8' });
  assert.equal(bad.status, 0);
  assert.equal(bad.stdout.trim(), '');
});

test('TIER_RULES：isolation is not delegation; risky operations and risky code are separate checkpoints', () => {
  assert.match(TIER_RULES, /先只读探查/);
  assert.match(TIER_RULES, /进 linked worktree/);
  assert.match(TIER_RULES, /tier2-verify/);
  assert.match(TIER_RULES, /风险操作[^\n]*用户原话授权与回滚方案/);
  assert.match(TIER_RULES, /风险代码[^\n]*risk-scan \+ 1 个独立 reviewer（1\+1 上限）[^\n]*不升档、不需授权/);
  assert.match(TIER_RULES, /~\/\.claude\/CLAUDE\.md/);
  assert.doesNotMatch(TIER_RULES, /风险[^\n]*→ \/paseo-handoff/);
});

test('TIER_RULES：hooks share compact recon-first tier criteria without TIER-PLAN', () => {
  for (const token of ['先只读探查', 'Tier 1', 'Tier 2', 'Tier 3', 'tier2-verify', 'risk-scan', '/paseo-pipeline']) {
    assert.ok(TIER_RULES.includes(token), token);
    assert.ok(REMINDER.includes(token), token);
  }
  assert.doesNotMatch(TIER_RULES, /TIER-PLAN:/);
  assert.equal(TIER_RULES.split('\n').length, 2);
  assert.ok(TIER_RULES.length < 600, `TIER_RULES is ${TIER_RULES.length} chars`);
});

// 规则副本只许指向正本，不许出现与正本不同的阈值。正本在仓库外（~/.claude/CLAUDE.md），
// 不存在时（CI、他人机器）只核对仓库内副本之间一致。
test('阈值不发散：TIER_RULES、SKILL、author 模板与正本的 Tier 1 上限和 Tier 3 门槛一致', () => {
  const repo = path.join(here, '..', '..', '..');
  const copies = {
    TIER_RULES,
    'SKILL.md': fs.readFileSync(path.join(here, '..', 'SKILL.md'), 'utf8'),
    'templates/author.md': fs.readFileSync(path.join(here, '..', 'templates', 'author.md'), 'utf8'),
  };
  const canon = path.join(os.homedir(), '.claude', 'CLAUDE.md');
  if (fs.existsSync(canon)) copies['~/.claude/CLAUDE.md'] = fs.readFileSync(canon, 'utf8');
  const routing = path.join(os.homedir(), '.paseo', 'task-routing.md');
  if (fs.existsSync(routing)) copies['~/.paseo/task-routing.md'] = fs.readFileSync(routing, 'utf8');
  const tier3 = /(?:≥\s*|>=\s*|at least |tasks >= )(\d+)[^\n]{0,40}?(?:实质?任务|substantive tasks|tasks)?[^\n]{0,40}?maxWidth\s*(?:≥|>=)\s*(\d+)/g;
  for (const [name, text] of Object.entries(copies)) {
    for (const m of text.matchAll(/Tier 1[^\n]{0,8}?(?:≤|<=)\s*(\d+)/g)) assert.equal(Number(m[1]), DEFAULT_LIMIT, `${name}: Tier 1 上限 ${m[0]}`);
    for (const m of text.matchAll(tier3)) {
      const tasks = Number(m[1]);
      const width = Number(m[2]);
      assert.deepEqual([tasks, width], [4, 3], `${name}: Tier 3 门槛 ${m[0]}`);
    }
    if (name !== '~/.paseo/task-routing.md') {
      assert.match(text, /maxWidth\s*(?:≥|>=)\s*2[^\n]{0,36}1\.8/, `${name}: maxWidth>=2 ROI fallback`);
    }
  }
  assert.ok(fs.existsSync(path.join(repo, 'docs', 'tier2-handoff-brief.md')));
});

test('3 个源文件加 2 个测试和 1 个文档仍在 Tier 1；第 4 个源文件询问', () => withState(() => {
  const root = makeRepo();
  const paths = [
    'packages/server/src/a.ts', 'packages/server/src/b.ts', 'packages/server/src/c.ts',
    'packages/server/test/a.test.ts', 'packages/server/tests/extra.ts', 'packages/server/README.md',
    'packages/server/src/a.test.ts', 'packages/server/src/b.spec.ts', 'packages/server/src/c_test.ts',
  ];
  const declared = { tier: 1, files: paths };
  assert.equal(assessTierGate({ target: path.join(root, paths[0]), sessionId: 'tier-count', declared }).verdict, 'allow');
  assert.equal(assessTierGate({ target: path.join(root, paths[1]), sessionId: 'tier-count' }).verdict, 'allow');
  assert.equal(assessTierGate({ target: path.join(root, paths[2]), sessionId: 'tier-count' }).verdict, 'allow');
  for (const file of paths.slice(3)) assert.equal(assessTierGate({ target: path.join(root, file), sessionId: 'tier-count' }).verdict, 'allow', file);
  assert.equal(assessTierGate({ target: path.join(root, 'packages/server/src/d.ts'), sessionId: 'tier-count' }).verdict, 'ask');
}));

test('测试文件在另一顶层目录不触发跨作用域询问', () => withState(() => {
  const root = makeRepo();
  assert.equal(assessTierGate({ target: path.join(root, 'src', 'a.ts'), sessionId: 'cross-test' }).verdict, 'allow');
  assert.equal(assessTierGate({ target: path.join(root, 'elsewhere', 'tests', 'b.test.ts'), sessionId: 'cross-test' }).verdict, 'allow');
}));

test('开工前声明：3 个源文件加测试文件通过', () => withState(() => {
  const root = makeRepo();
  const files = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'elsewhere/tests/a.test.ts', 'docs/guide.md'];
  const declared = { tier: 1, files };
  assert.equal(assessTierGate({ target: path.join(root, files[0]), sessionId: 'plan-count', declared }).verdict, 'allow');
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
  assert.match(REMINDER, /tier2-verify/);
  assert.match(REMINDER, /\/paseo-pipeline/);
  assert.match(REMINDER, /risk-scan/);
  assert.match(REMINDER, /≤3 个源文件/);
  assert.match(REMINDER, /先只读探查/);
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

test('tier-session-hook 进程：startup/clear 不重复注入（首条用户消息会注入），resume/compact 仍注入', () => {
  const run = (source) => spawnSync('node', [SESSION_HOOK], { input: JSON.stringify({ source }), encoding: 'utf8', env: cleanEnv() }).stdout.trim();
  assert.equal(run('startup'), '');
  assert.equal(run('clear'), '');
  assert.match(run('resume'), /分级规则/);
  assert.match(run('compact'), /分级规则/);
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

test('Stop 核对：本地提交重命名计入旧路径和新路径', () => withState(() => {
  const root = makeRepo();
  snap(root, 'rename');
  fs.renameSync(path.join(root, 'src/seed.txt'), path.join(root, 'src/renamed.txt'));
  sh(root, 'add', '-A'); sh(root, 'commit', '-q', '-m', 'rename');
  const result = stop(root, 'rename');
  assert.equal(result.verdict, 'ok');
  assert.deepEqual(result.files, ['src/renamed.txt', 'src/seed.txt']);
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

test('只提交、不改内容的一轮不推进 churn 计数', () => withState(() => {
  const root = makeRepo();
  for (let round = 1; round <= 2; round += 1) {
    snap(root, 'commit-only');
    bashWrite(root, ['a']);
    assert.equal(stop(root, 'commit-only').verdict, 'ok');
  }
  // 第 3 轮：只把前两轮已改的文件提交掉，没有新内容。
  snap(root, 'commit-only');
  sh(root, 'add', '.'); sh(root, 'commit', '-q', '-m', 'wip');
  assert.equal(stop(root, 'commit-only').verdict, 'ok');
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

const TOOL_GUARD = path.join(here, '..', 'hooks', 'tool-guard-hook.mjs');
function toolGuard(payload) {
  const result = spawnSync('node', [TOOL_GUARD], { input: JSON.stringify(payload), encoding: 'utf8', env: cleanEnv() });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout ? JSON.parse(result.stdout).hookSpecificOutput : {};
}

test('tool guard reminds only for CLI dispatch without a wait', () => {
  const bash = (command) => toolGuard({ tool_name: 'Bash', tool_input: { command } });
  assert.match(bash('paseo run x').additionalContext, /no completion callback/);
  for (const command of ['paseo run --wait x', 'paseo ls', 'paseo send x; paseo wait x --timeout 540']) {
    assert.deepEqual(bash(command), {});
  }
});

test('tool guard strips invalid local server IDs instead of denying the call', () => {
  // Denying lost the call and the model repeated it; stripping means "use the calling daemon".
  for (const serverId of ['self', 'local', ' LOCALHOST ', '']) {
    const out = toolGuard({ tool_name: 'mcp__paseo__list_agents', tool_input: { serverId } });
    assert.equal(out.permissionDecision, 'allow');
    assert.deepEqual(out.updatedInput, {});
  }
  for (const tool_input of [{ serverId: 'srv_AdzDXaf59gwG' }, {}]) {
    assert.deepEqual(toolGuard({ tool_name: 'mcp__paseo__list_agents', tool_input }), {});
  }
});

test('tool guard breaks consecutive identical MCP failures', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-guard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const transcript_path = path.join(dir, 'transcript.jsonl');
  const name = 'mcp__example__call';
  const pair = (id, input, is_error) => [
    { message: { content: [{ type: 'tool_use', id, name, input }] } },
    { message: { content: [{ type: 'tool_result', tool_use_id: id, is_error }] } },
  ];
  const run = (records, input = { a: 1, nested: { x: 1, y: 2 } }) => {
    fs.writeFileSync(transcript_path, records.map(JSON.stringify).join('\n'));
    return toolGuard({ tool_name: name, tool_input: input, transcript_path });
  };
  const input = { nested: { y: 2, x: 1 }, a: 1 };
  const failures = [1, 2, 3].flatMap((id) => pair(String(id), input, true));
  assert.equal(run(failures).permissionDecision, 'deny');
  assert.deepEqual(run(failures, { a: 2 }), {});
  assert.deepEqual(run([...failures, ...pair('4', input, false)]), {});
  assert.deepEqual(run([...failures, ...pair('4', { a: 2 }, true)]), {});
  assert.deepEqual(toolGuard({ tool_name: name, tool_input: input, transcript_path: path.join(dir, 'missing') }), {});
});

test('P1-1 large_file asks once, promotes via askedSigs after disk change, preserves churn, and Stop catches Bash large/test blast + tier1 signoff', () => withState(() => {
  const prevTel = process.env.PIPELINE_TELEMETRY;
  process.env.PIPELINE_TELEMETRY = 'off';
  try {
    const root = makeRepo();
    const big = path.join(root, 'src', 'big.js');
    fs.writeFileSync(big, Array.from({ length: 820 }, (_, i) => `export const v${i} = ${i};`).join('\n'));
    sh(root, 'add', 'src/big.js');
    sh(root, 'commit', '-qm', 'add big file');

    // First write to large file -> ask; repeating without disk mutation still asks
    assert.equal(assessTierGate({ target: big, sessionId: 'lf1' }).verdict, 'ask');
    assert.equal(assessTierGate({ target: big, sessionId: 'lf1' }).verdict, 'ask');

    // Simulate user click Allow -> file actually changed on disk -> subsequent edit promotes to allow
    fs.appendFileSync(big, '\nexport const extra = 1;\n');
    const afterAllow = assessTierGate({ target: big, sessionId: 'lf1' });
    assert.equal(afterAllow.verdict, 'allow');

    // Churn still fires across turns on the promoted large file
    for (let turn = 0; turn < 3; turn += 1) {
      takeSnapshot({ cwd: root, sessionId: 'lf1' });
      fs.appendFileSync(big, `\n// edit ${turn}\n`);
      const res = assessStop({ cwd: root, sessionId: 'lf1' });
      if (turn < 2) assert.equal(res.verdict, 'ok');
      else {
        assert.equal(res.verdict, 'block');
        assert.equal(res.reasonCode, 'churn');
      }
    }

    // Stop catches Bash edits to large file and >5 test files
    const bashRoot = makeRepo();
    const bashBig = path.join(bashRoot, 'src', 'huge.js');
    fs.writeFileSync(bashBig, Array.from({ length: 820 }, (_, i) => `export const h${i} = ${i};`).join('\n'));
    sh(bashRoot, 'add', 'src/huge.js');
    sh(bashRoot, 'commit', '-qm', 'add huge');
    takeSnapshot({ cwd: bashRoot, sessionId: 'bash-lf' });
    fs.appendFileSync(bashBig, '\n// bash edit\n');
    const lfStop = assessStop({ cwd: bashRoot, sessionId: 'bash-lf' });
    assert.equal(lfStop.verdict, 'block');
    assert.equal(lfStop.reasonCode, 'large_file');

    fs.mkdirSync(path.join(bashRoot, 'test'), { recursive: true });
    takeSnapshot({ cwd: bashRoot, sessionId: 'bash-tb' });
    for (let i = 1; i <= 6; i += 1) {
      fs.writeFileSync(path.join(bashRoot, 'test', `f${i}.test.mjs`), `// test ${i}\n`);
    }
    const tbStop = assessStop({ cwd: bashRoot, sessionId: 'bash-tb' });
    assert.equal(tbStop.verdict, 'block');
    assert.equal(tbStop.reasonCode, 'test_blast');

    // riskStopReason emits snap.head SHA, and recorded tier1 signoff on committed HEAD clears Stop block
    const riskRoot = makeRepo();
    const baseSha = sh(riskRoot, 'rev-parse', 'HEAD').trim();
    fs.mkdirSync(path.join(riskRoot, 'src', 'auth'), { recursive: true });
    fs.writeFileSync(path.join(riskRoot, 'src', 'auth', 'gate.js'), 'export const auth = true;\n');
    takeSnapshot({ cwd: riskRoot, sessionId: 't1sig' });
    fs.appendFileSync(path.join(riskRoot, 'src', 'auth', 'gate.js'), 'export const token = true;\n');
    const riskBlock = assessStop({ cwd: riskRoot, sessionId: 't1sig' });
    assert.equal(riskBlock.verdict, 'block');
    assert.equal(riskBlock.reasonCode, 'risk_sentinel');
    assert.ok(riskBlock.reason.includes(`pipeline-run.mjs risk-scan ${baseSha}`), riskBlock.reason);

    sh(riskRoot, 'add', '.');
    sh(riskRoot, 'commit', '-qm', 'commit auth fix');
    recordReview({ cwd: riskRoot, mode: 'tier1', verdict: 'PASS', reviewer: 'anchasi-1', sha: 'HEAD' });
    takeSnapshot({ cwd: riskRoot, sessionId: 't1sig', isHumanTurn: true });
    fs.writeFileSync(path.join(riskRoot, 'src', 'auth', 'gate.js'), 'export const auth = true;\nexport const token = 2;\n');
    sh(riskRoot, 'add', '.');
    sh(riskRoot, 'commit', '-qm', 'next commit reviewed');
    recordReview({ cwd: riskRoot, mode: 'tier1', verdict: 'PASS', reviewer: 'anchasi-1', sha: 'HEAD' });
    // Note: takeSnapshot saw clean tree -> commit made head !== snap.head and clean -> signoff clears risk_sentinel
    assert.equal(assessStop({ cwd: riskRoot, sessionId: 't1sig' }).verdict, 'ok');
  } finally {
    if (prevTel === undefined) delete process.env.PIPELINE_TELEMETRY;
    else process.env.PIPELINE_TELEMETRY = prevTel;
  }
}));

test('TIER_RULES 与 REMINDER 限定仅代码改动适用，且只读诊断默认放开', () => {
  assert.match(TIER_RULES, /仅代码改动/);
  assert.match(TIER_RULES, /只读诊断默认放开/);
  assert.match(REMINDER, /仅代码改动适用/);
});

test('tier-reminder-hook 进程：纯问答/调研跳过注入；同会话只注入一次；新会话或超空闲后可再注入', () => withState((dir) => {
  const root = makeRepo();
  const subdir = path.join(root, 'src');
  fs.mkdirSync(subdir, { recursive: true });
  const env = cleanEnv({ PIPELINE_TIER_GATE_STATE: dir, PIPELINE_TELEMETRY: 'off' });
  const run = (payload, extraEnv = env) => spawnSync('node', [REMINDER_HOOK], { input: JSON.stringify(payload), encoding: 'utf8', env: extraEnv });

  // Read-only / analytical questions skip context injection while still taking Stop snapshot.
  for (const q of [
    '分析一下为什么响应这么慢？',
    '调研一下一键校验功能的可用性',
    '为什么这里报错了？',
    '你觉得呢？',
    '为什么 merge 失败了？',
    '为什么 build 报错？',
    '帮我分析一下日志',
    'Explain auth flow',
  ]) {
    assert.equal(isReadOnlyPrompt(q), true, q);
    assert.equal(shouldRemind(q), false, q);
    assert.equal(run({ prompt: q, cwd: root, session_id: 'qa-then-edit' }).stdout.trim(), '', q);
  }

  for (const w of [
    '把这段删了，可以吗？',
    '能不能把按钮改一下？',
    '合并到 main',
  ]) {
    assert.equal(isReadOnlyPrompt(w), false, w);
    assert.equal(shouldRemind(w), true, w);
  }

  // First actionable / implementation turn in that session gets reminded once.
  assert.match(run({ prompt: '好的，按方案 B 修改吧', cwd: root, session_id: 'qa-then-edit' }).stdout, /分级提醒/);
  // Subsequent turns in the same session + repo root (including a subdirectory) do not repeat the reminder.
  assert.equal(run({ prompt: '继续', cwd: root, session_id: 'qa-then-edit' }).stdout.trim(), '');
  assert.equal(run({ prompt: '把第2点也改了', cwd: subdir, session_id: 'qa-then-edit' }).stdout.trim(), '');
  // A different session still gets its initial reminder; idle expiry resets and re-reminds.
  assert.match(run({ prompt: '把这段删了，可以吗？', cwd: root, session_id: 'qa-other' }).stdout, /分级提醒/);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  const expiredEnv = cleanEnv({ PIPELINE_TIER_GATE_STATE: dir, PIPELINE_TIER_GATE_IDLE_MS: '0', PIPELINE_TELEMETRY: 'off' });
  assert.match(run({ prompt: '能不能把按钮改一下？', cwd: root, session_id: 'qa-then-edit' }, expiredEnv).stdout, /分级提醒/);
}));

test('repoContext resolves unborn primary, committed primary, detached HEAD, and linked worktree', () => {
  const unborn = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tier-gate-unborn-')));
  const wt = path.join(os.tmpdir(), `tier-gate-wt-${process.pid}-${Date.now()}`);
  try {
    sh(unborn, 'init', '-q', '-b', 'main');
    sh(unborn, 'config', 'user.email', 't@t');
    sh(unborn, 'config', 'user.name', 't');
    assert.deepEqual(repoContext(unborn), { root: unborn, isPrimary: true, isPrimaryOnProtected: true, branch: 'main' });

    fs.writeFileSync(path.join(unborn, 'a.txt'), 'a\n');
    sh(unborn, 'add', 'a.txt');
    sh(unborn, 'commit', '-qm', 'init');
    assert.deepEqual(repoContext(unborn), { root: unborn, isPrimary: true, isPrimaryOnProtected: true, branch: 'main' });

    sh(unborn, 'worktree', 'add', '-q', '-b', 'feat/ctx', wt, 'main');
    const wtReal = fs.realpathSync(wt);
    assert.deepEqual(repoContext(wtReal), { root: wtReal, isPrimary: false, isPrimaryOnProtected: false, branch: 'feat/ctx' });

    sh(unborn, 'checkout', '--detach', '-q', 'HEAD');
    assert.deepEqual(repoContext(unborn), { root: unborn, isPrimary: true, isPrimaryOnProtected: false, branch: '' });
  } finally {
    fs.rmSync(wt, { recursive: true, force: true });
    fs.rmSync(unborn, { recursive: true, force: true });
  }
});

test('assessTierGate + assessStop: 3 轮依次改不同新文件不误报 churn；同文件连改 3 轮触发且 worktree 提示不误指回 worktree', () => withState(() => {
  const root = makeRepo();
  for (const name of ['f1.js', 'f2.js', 'f3.js', 'retry.js']) {
    fs.writeFileSync(path.join(root, 'src', name), `export const v = '${name}';\n`);
  }
  sh(root, 'add', '.');
  sh(root, 'commit', '-qm', 'add core files');

  // Tier 1: normal progression across 3 new distinct files via assessTierGate + Edit + assessStop must NOT false-block churn.
  for (const name of ['f1.js', 'f2.js', 'f3.js']) {
    snap(root, 't1-distinct');
    const target = path.join(root, 'src', name);
    assert.equal(assessTierGate({ target, sessionId: 't1-distinct' }).verdict, 'allow', name);
    fs.appendFileSync(target, '// edit 1\n');
    assert.equal(assessTierGate({ target, sessionId: 't1-distinct' }).verdict, 'allow', `${name} second edit`);
    fs.appendFileSync(target, '// edit 2\n');
    assert.equal(stop(root, 't1-distinct').verdict, 'ok', `${name} stop should not false-block churn`);
  }

  // Genuine 3-turn same-file thrashing triggers churn block on round 3.
  const retry = path.join(root, 'src', 'retry.js');
  for (let round = 1; round <= 3; round += 1) {
    snap(root, 't1-repeat');
    assert.equal(assessTierGate({ target: retry, sessionId: 't1-repeat' }).verdict, 'allow');
    fs.appendFileSync(retry, `// retry ${round}\n`);
    const v = stop(root, 't1-repeat');
    if (round < 3) assert.equal(v.verdict, 'ok', `round ${round}`);
    else {
      assert.equal(v.verdict, 'block');
      assert.equal(v.reasonCode, 'churn');
      assert.match(v.reason, /进 linked worktree/);
    }
  }

  // Linked worktree: new files reset streak, genuine 3-turn revisit warns with handoff-progress.md instead of "enter linked worktree".
  const wt = path.join(os.tmpdir(), `tier-gate-churn-wt-${process.pid}-${Date.now()}`);
  sh(root, 'worktree', 'add', '-q', '-b', 'feat/churn-msg', wt, 'main');
  try {
    const wtReal = fs.realpathSync(wt);
    for (const name of ['f1.js', 'f2.js']) {
      snap(wtReal, 'wt-churn');
      fs.appendFileSync(path.join(wtReal, 'src', name), '// wt new\n');
      assert.equal(stop(wtReal, 'wt-churn').verdict, 'ok');
    }
    for (let round = 1; round <= 3; round += 1) {
      snap(wtReal, 'wt-churn');
      fs.appendFileSync(path.join(wtReal, 'src', 'f1.js'), `// wt revisit ${round}\n`);
      const v = stop(wtReal, 'wt-churn');
      if (round < 2) assert.equal(v.verdict, 'ok', `wt revisit round ${round}`);
      else if (round === 2) {
        // After fresh f2.js reset streak to 1, revisit rounds 1->2 hit turns 2->3 and block on round 2.
        assert.equal(v.verdict, 'block');
        assert.equal(v.reasonCode, 'churn');
        assert.match(v.reason, /handoff-progress\.md/);
        assert.doesNotMatch(v.reason, /进 linked worktree/);
        break;
      }
    }
  } finally {
    fs.rmSync(wt, { recursive: true, force: true });
  }
}));

test('Tier 1 risk_sentinel suppresses async-wait commit self-lock and cross-session claim honors snap.at and selfOwned', () => withState((dir) => {
  const prevTel = process.env.PIPELINE_TELEMETRY;
  process.env.PIPELINE_TELEMETRY = 'off';
  try {
    // 1) risk_sentinel async commit wait: Turn 1 edits risky file -> block; Turn 2 commits while waiting for async review -> ok; Turn 3 brand-new risky edit -> block again
    const rRoot = makeRepo();
    fs.mkdirSync(path.join(rRoot, 'src', 'auth'), { recursive: true });
    fs.writeFileSync(path.join(rRoot, 'src', 'auth', 'session.js'), 'export const s = 1;\n');
    sh(rRoot, 'add', '.');
    sh(rRoot, 'commit', '-qm', 'seed auth');

    snap(rRoot, 'async-risk');
    fs.writeFileSync(path.join(rRoot, 'src', 'auth', 'session.js'), 'export const s = 2;\n');
    const b1 = stop(rRoot, 'async-risk');
    assert.equal(b1.verdict, 'block');
    assert.equal(b1.reasonCode, 'risk_sentinel');

    // Turn 2 human turn: agent commits already-reported dirty file while waiting for async anchasi
    snap(rRoot, 'async-risk');
    sh(rRoot, 'add', 'src/auth/session.js');
    sh(rRoot, 'commit', '-qm', 'wip await review');
    const b2 = stop(rRoot, 'async-risk');
    assert.equal(b2.verdict, 'ok', 'committing already-reported risky file while awaiting async review must not self-lock');

    // Turn 2 with an additional NEW unreviewed risky file must still block
    fs.writeFileSync(path.join(rRoot, 'src', 'auth', 'other.js'), 'export const o = 1;\n');
    const b3 = stop(rRoot, 'async-risk');
    assert.equal(b3.verdict, 'block');
    assert.equal(b3.reasonCode, 'risk_sentinel');

    // 2) cross-session claims: stale session before snap.at does NOT exempt Bash edits; own files in seg.files are never exempted; concurrent edits after snap.at ARE exempted
    const cRoot = makeRepo();
    for (const n of ['a.js', 'b.js', 'c.js', 'stale.js', 'peer.js']) {
      fs.writeFileSync(path.join(cRoot, 'src', n), `export const ${n.replace(/\W/g, '_')} = 1;\n`);
    }
    sh(cRoot, 'add', '.');
    sh(cRoot, 'commit', '-qm', 'seed cross-session files');

    // Write stale claim from session-other with timestamp well before session-cur's snapshot
    const staleAt = Date.now() - 10_000;
    fs.writeFileSync(path.join(dir, 'session-other.json'), JSON.stringify({
      [cRoot]: { files: ['src/stale.js', 'src/a.js'], asked: [], at: staleAt },
    }));

    snap(cRoot, 'session-cur');
    assert.equal(assessTierGate({ target: path.join(cRoot, 'src', 'a.js'), sessionId: 'session-cur' }).verdict, 'allow');
    assert.equal(assessTierGate({ target: path.join(cRoot, 'src', 'b.js'), sessionId: 'session-cur' }).verdict, 'allow');
    assert.equal(assessTierGate({ target: path.join(cRoot, 'src', 'c.js'), sessionId: 'session-cur' }).verdict, 'allow');

    // Active concurrent session writes AFTER snap.at -> exempted from session-cur's Stop count
    fs.writeFileSync(path.join(dir, 'session-other.json'), JSON.stringify({
      [cRoot]: { files: ['src/peer.js', 'src/a.js'], asked: [], at: Date.now() + 50 },
    }));
    fs.appendFileSync(path.join(cRoot, 'src', 'peer.js'), '// edit by peer\n');
    assert.equal(stop(cRoot, 'session-cur').verdict, 'ok', 'concurrent active claim after snap.at should be exempted');

    // Reset session-other to stale timestamp before a new snap, then session-cur touches src/stale.js via Bash -> exceeds limit 3 (4th file) and MUST block!
    fs.writeFileSync(path.join(dir, 'session-other.json'), JSON.stringify({
      [cRoot]: { files: ['src/stale.js'], asked: [], at: Date.now() - 10_000 },
    }));
    snap(cRoot, 'session-cur');
    fs.appendFileSync(path.join(cRoot, 'src', 'stale.js'), '// bash write by cur\n');
    const cBlock = stop(cRoot, 'session-cur');
    assert.equal(cBlock.verdict, 'block');
    assert.equal(cBlock.reasonCode, 'file_limit');
  } finally {
    if (prevTel === undefined) delete process.env.PIPELINE_TELEMETRY;
    else process.env.PIPELINE_TELEMETRY = prevTel;
  }
}));
