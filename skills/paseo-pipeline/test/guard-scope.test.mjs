import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessAnyWrite } from '../lib/scope-guard.mjs';

// guard-scope 是 PreToolUse 侧的减速带：有编排租约期间，命中任务 Write scope 的写入必须
// 能对上一个在途写手意图。它与 reconcile 的脏树检测共用 `isFileWithinScopes` 与
// `WRITER_ROLES` 两个属主，所以判据不会在两侧漂移。
//
// 刻意保守的边界同样要测：无租约放行、scope 外放行、读不到 tasks.md 放行（fail-open）。
// 守卫是减速带不是沙箱——锁死工作区的代价远大于漏拦一次。
const script = fileURLToPath(new URL('../guard-scope.mjs', import.meta.url));
const change = 'guard-demo';

function fixture(context, { tasks = null, lease = null, intents = [], rawLedger = null } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'pipeline-guard-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  const changeDir = path.join(repo, 'openspec', 'changes', change);
  mkdirSync(changeDir, { recursive: true });
  if (tasks !== null) writeFileSync(path.join(changeDir, 'tasks.md'), tasks);
  mkdirSync(path.join(repo, 'src'), { recursive: true });
  const stateDir = path.join(root, 'run-state');
  const env = {
    ...process.env,
    PIPELINE_RUN_STATE_DIR: stateDir,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  if (rawLedger !== null) {
    // 损坏账本：原样落盘，不经 JSON.stringify（测试要的正是「不是合法 JSON」）。
    const dir = path.join(stateDir, change);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'run-state.json'), rawLedger);
  } else if (lease !== null || intents.length > 0) {
    const dir = path.join(stateDir, change);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'run-state.json'), `${JSON.stringify({
      version: 1, run: 'local', lease, intents, heartbeats: [],
    }, null, 2)}\n`);
  }
  execFileSync('git', ['init', '-q', '-b', 'integration'], { cwd: repo, env, stdio: 'ignore' });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repo, env, stdio: 'ignore' });
  const run = (file, extra = []) => spawnSync(process.execPath, [script, change, '--path', file, '--json', ...extra], {
    cwd: repo, env, encoding: 'utf8', timeout: 30_000,
  });
  return { root, repo, env, run };
}

const TASKS = `- [ ] 1.1 T-01 Demo task
  - Depends on: none
  - Write scope: src/T-01.mjs
  - Verify with: \`true\`
`;

const validLease = () => ({
  owner: 'lead-a', generation: 1, acquiredAt: new Date().toISOString(), renewedAt: null,
  expiresAt: new Date(Date.now() + 1_800_000).toISOString(), ttlMs: 1_800_000,
});

const writerIntent = (overrides = {}) => ({
  key: 'local:T-01:1:impl:gongbu:dispatch',
  task: 'T-01', attempt: 1, phase: 'impl', role: 'gongbu', action: 'dispatch',
  createdAt: new Date().toISOString(), resolvedAt: new Date().toISOString(),
  agentId: '11111111-1111-1111-1111-111111111111', workspaceId: null,
  ...overrides,
});

function verdictOf(result) {
  assert.equal(result.status === 0 || result.status === 2, true,
    `unexpected exit ${result.status}: ${result.stderr}`);
  assert.equal(typeof result.stdout === 'string' && result.stdout.trim() !== '', true,
    `guard must always print a verdict (empty stdout would silently allow): ${result.stderr}`);
  return JSON.parse(result.stdout);
}

// 写手在自己的 linked worktree 里工作（SKILL §8）；主 checkout 属于编排者。
// worktree 从已提交的 HEAD 拉出，所以 tasks.md 必须先提交——真实流程里它在 integration 分支上。
function linkedWorktree(subject) {
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
    cwd: subject.repo, env: subject.env, stdio: 'ignore',
  });
  git('add', '-A');
  git('commit', '-q', '--allow-empty', '-m', 'freeze');
  const dir = path.join(subject.root, 'writer-wt');
  git('worktree', 'add', '-q', '-b', 'task/guard-demo/T-01', dir);
  const run = (file) => spawnSync(process.execPath, [script, change, '--path', file, '--json'], {
    cwd: dir, env: subject.env, encoding: 'utf8', timeout: 30_000,
  });
  return { dir, run };
}

test('SCEN-GRD-01 no lease means the guard does not apply (daily edits are not a pipeline run)', (context) => {
  const subject = fixture(context, { tasks: TASKS });
  const result = verdictOf(subject.run('src/T-01.mjs'));
  assert.equal(result.verdict, 'allow');
  assert.match(result.reason, /无编排租约/);
});

test('SCEN-GRD-01 an expired lease also does not apply', (context) => {
  const subject = fixture(context, {
    tasks: TASKS,
    lease: { ...validLease(), expiresAt: new Date(Date.now() - 60_000).toISOString() },
  });
  const result = verdictOf(subject.run('src/T-01.mjs'));
  assert.equal(result.verdict, 'allow');
  assert.match(result.reason, /租约已过期/);
});

test('SCEN-GRD-02 a pending writer intent for the scope owner allows the write', (context) => {
  const subject = fixture(context, {
    tasks: TASKS, lease: validLease(), intents: [writerIntent({ resolvedAt: null, agentId: null })],
  });
  const result = verdictOf(linkedWorktree(subject).run('src/T-01.mjs'));
  assert.equal(result.verdict, 'allow');
  assert.deepEqual(result.covered, ['T-01']);
  assert.match(result.reason, /含在途未回执/);
});

test('SCEN-GRD-02 a recorded writer intent (real agent) also allows the write', (context) => {
  const subject = fixture(context, { tasks: TASKS, lease: validLease(), intents: [writerIntent()] });
  const result = verdictOf(linkedWorktree(subject).run('src/T-01.mjs'));
  assert.equal(result.verdict, 'allow');
  assert.deepEqual(result.scopeOwners, ['T-01']);
});

test('SCEN-GRD-02 the same recorded writer intent does NOT authorise a write from the main checkout', (context) => {
  // 评审发现：只要账本有一条未作废的写手意图就放行，写手回执之后编排者在主 checkout 代写
  // 同一 scope 照样通过（LESSONS §13 的形状）。record 紧随 create_agent，所以不能用「未回执」
  // 区分；能区分的是位置：写手在 linked worktree，主 checkout 属于编排者。
  for (const intents of [[writerIntent()], [writerIntent({ resolvedAt: null, agentId: null })]]) {
    const subject = fixture(context, { tasks: TASKS, lease: validLease(), intents });
    const raw = subject.run('src/T-01.mjs');
    assert.equal(raw.status, 2, `${raw.stdout}${raw.stderr}`);
    const result = verdictOf(raw);
    assert.equal(result.verdict, 'deny');
    assert.match(result.reason, /主 checkout/);
    assert.deepEqual(result.covered, ['T-01']);
  }
});

test('SCEN-GRD-02 a scope-external path in the main checkout is still allowed', (context) => {
  const subject = fixture(context, { tasks: TASKS, lease: validLease(), intents: [writerIntent()] });
  assert.equal(verdictOf(subject.run('src/other.mjs')).verdict, 'allow');
});

test('SCEN-GRD-03 the exact LESSONS §13 shape is denied: lease active, scope hit, no writer intent', (context) => {
  // 2026-10-27：总控在主 checkout 直接写了 T-02 的 Write scope 文件并跑通单测。
  // 那时没有任何写手意图，租约却在生效。
  const subject = fixture(context, { tasks: TASKS, lease: validLease() });
  const raw = subject.run('src/T-01.mjs');
  assert.equal(raw.status, 2, 'must exit 2 so a hook can deny');
  const result = verdictOf(raw);
  assert.equal(result.verdict, 'deny');
  assert.match(result.reason, /没有这些任务的写手意图/);
  assert.match(result.reason, /总控不得直接改业务代码/);
  assert.deepEqual(result.scopeOwners, ['T-01']);
});

test('SCEN-GRD-03 a voided (failed) writer intent authorises nothing', (context) => {
  const subject = fixture(context, {
    tasks: TASKS, lease: validLease(),
    intents: [writerIntent({ failedAt: new Date().toISOString(), reason: '创建失败' })],
  });
  const raw = subject.run('src/T-01.mjs');
  assert.equal(raw.status, 2);
  assert.equal(verdictOf(raw).verdict, 'deny');
});

test('SCEN-GRD-03 a reviewer intent does not authorise a write', (context) => {
  const subject = fixture(context, {
    tasks: TASKS, lease: validLease(),
    intents: [writerIntent({ role: 'anchasi', phase: 'audit' })],
  });
  const result = subject.run('src/T-01.mjs');
  assert.equal(result.status, 2, '只读角色意图不构成写授权');
});

test('SCEN-GRD-04 a path outside every Write scope is allowed (merge exit 30 owns that judgement)', (context) => {
  const subject = fixture(context, { tasks: TASKS, lease: validLease() });
  const result = verdictOf(subject.run('src/other.mjs'));
  assert.equal(result.verdict, 'allow');
  assert.match(result.reason, /不在任何任务的 Write scope 内/);
});

test('SCEN-GRD-04 openspec/ is the flow\'s own writing range, not a task scope', (context) => {
  const subject = fixture(context, { tasks: TASKS, lease: validLease() });
  const result = verdictOf(subject.run('openspec/changes/guard-demo/tasks.md'));
  assert.equal(result.verdict, 'allow');
  assert.match(result.reason, /openspec\//);
});

test('SCEN-GRD-04 an unreadable tasks.md fails open, never locking the workspace', (context) => {
  const subject = fixture(context, { tasks: null, lease: validLease() });
  const result = verdictOf(subject.run('src/T-01.mjs'));
  assert.equal(result.verdict, 'allow');
  assert.match(result.reason, /fail-open/);
});

test('SCEN-GRD-05 PIPELINE_GUARD_SCOPE=off is an explicit escape hatch', (context) => {
  const subject = fixture(context, { tasks: TASKS, lease: validLease() });
  const result = spawnSync(process.execPath, [script, change, '--path', 'src/T-01.mjs', '--json'], {
    cwd: subject.repo, env: { ...subject.env, PIPELINE_GUARD_SCOPE: 'off' }, encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  assert.match(JSON.parse(result.stdout).reason, /PIPELINE_GUARD_SCOPE=off/);
});

test('SCEN-GRD-06 without a change name the guard scans every active lease (hook shape)', (context) => {
  const subject = fixture(context, { tasks: TASKS, lease: validLease() });
  const result = spawnSync(process.execPath, [script, '--path', 'src/T-01.mjs', '--json'], {
    cwd: subject.repo, env: subject.env, encoding: 'utf8',
  });
  assert.equal(result.status, 2, '扫描形态同样要拦住');
  const verdict = JSON.parse(result.stdout);
  assert.equal(verdict.verdict, 'deny');
  assert.equal(verdict.change, change);
});

test('SCEN-GRD-06 the scan ignores ledger directories named like flags', (context) => {
  const subject = fixture(context, { tasks: TASKS, lease: validLease() });
  const stray = path.join(subject.root, 'run-state', '--change');
  mkdirSync(stray, { recursive: true });
  writeFileSync(path.join(stray, 'run-state.json'), JSON.stringify({
    version: 1, run: 'local', intents: [], heartbeats: [], lease: validLease(),
  }));
  const result = spawnSync(process.execPath, [script, '--path', 'src/T-01.mjs', '--json'], {
    cwd: subject.repo, env: subject.env, encoding: 'utf8',
  });
  const verdict = JSON.parse(result.stdout);
  assert.equal(verdict.change, change, '历史遗留的旗标形态目录不得被当成 change');
});

test('SCEN-GRD-05 a flag-shaped change name is a usage error, never a stray ledger', (context) => {
  const subject = fixture(context, { tasks: TASKS, lease: validLease() });
  const result = spawnSync(process.execPath, [script, '--change', 'guard-demo', '--path', 'src/T-01.mjs'], {
    cwd: subject.repo, env: subject.env, encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /change 必须作为位置参数给出/);
  assert.match(result.stderr, /正确写法：node guard-scope\.mjs <change>/);
});

// --- SCEN-LED-03 账本损坏时守卫不得静默失效 ---
//
// 守卫所有的放行路径都从「没有有效租约」开始。损坏账本给出的同样是空 state、同样没有租约，
// 所以只靠 leaseStatus 无法区分「真的没有 run」与「账本读不了」。旧实现在这里输出
// `无编排租约（未在 run 内）` 并 exit 0：一次 deny 就这样静默退化成 allow，且输出里
// 没有任何可以事后追查的信号。判据是 readRunState 的 corrupt 标志（T-02 提供），
// 消费端必须**先看它**再决定放行。
const CORRUPT_LEDGER = '{ "version": 1, "intents": [ { "key": "local:T-01:1:impl:gongbu:dispatch" ';

test('SCEN-LED-03 a corrupt ledger denies a scoped write instead of reporting no active lease', (context) => {
  const subject = fixture(context, { tasks: TASKS, rawLedger: CORRUPT_LEDGER });
  const raw = subject.run('src/T-01.mjs');
  assert.equal(raw.status, 2, `损坏账本上的 scope 写入必须拒绝：${raw.stdout}${raw.stderr}`);
  const result = verdictOf(raw);
  assert.equal(result.verdict, 'deny');
  // 关键回归：不得再出现「无编排租约」这条把损坏读成缺席的理由。
  assert.doesNotMatch(result.reason, /无编排租约|未在 run 内/);
  assert.match(result.reason, /账本已损坏/);
  assert.match(result.reason, /不是合法 JSON/, '拒绝必须点名解析错误本身');
  // 结构化标记：调用方不必解析中文理由即可判断「读不出来」而不是「没有 run」。
  assert.ok(result.corrupt, 'verdict must carry the corrupt marker');
  assert.match(result.corrupt.file, /run-state\.json$/);
  assert.match(result.corrupt.error, /不是合法 JSON/);
  assert.deepEqual(result.scopeOwners, ['T-01']);
});

test('SCEN-LED-03 a corrupt ledger still marks the verdict corrupt on an out-of-scope path', (context) => {
  // scope 外的写入照常放行（损坏账本不该冻结整个仓库），但输出必须带上损坏标记：
  // 否则调用方看到的就是一句「不在任何 scope 内」，与健康账本的输出无法区分。
  const subject = fixture(context, { tasks: TASKS, rawLedger: CORRUPT_LEDGER });
  const result = verdictOf(subject.run('src/other.mjs'));
  assert.equal(result.verdict, 'allow');
  assert.match(result.reason, /不在任何任务的 Write scope 内/);
  assert.ok(result.corrupt, '即便放行也必须报告账本损坏');
  assert.match(result.corrupt.error, /不是合法 JSON/);
});

test('SCEN-LED-03 a corrupt ledger without a readable tasks.md is still corruption, never a plain allow', (context) => {
  // R1 审计 SPEC_VIOLATION：损坏 + 读不到 scope 判据时放行，等于用「读不出」当「不在 scope 内」
  // 的证据——scope 未知时根本没有「确证在 scope 外」这个结论。损坏账本本身就是必须处置的
  // 现场，收窄成 hold 也不会把健康仓库锁死：账本健康时这条路径照旧 fail-open（见 GRD-04）。
  const subject = fixture(context, { tasks: null, rawLedger: CORRUPT_LEDGER });
  const raw = subject.run('src/T-01.mjs');
  assert.equal(raw.status, 2, `scope 未知 + 账本损坏必须拒绝：${raw.stdout}${raw.stderr}`);
  const result = verdictOf(raw);
  assert.equal(result.verdict, 'deny');
  assert.match(result.reason, /账本已损坏/);
  assert.match(result.reason, /无法判定 scope/, '理由必须写明是 scope 未知，不是「不在 scope 内」');
  assert.ok(result.corrupt);
  assert.deepEqual(result.scopeOwners, [], 'scope 未知时不得编造 owner');
});

test('SCEN-LED-03 a corrupt ledger with a broken tasks.md is corruption too', (context) => {
  // 第二种「scope 未知」形状：tasks.md 在，但解析失败（缺 Write scope）。与缺席同等处置。
  const subject = fixture(context, {
    tasks: '- [ ] 1.1 T-01 Demo task\n  - Depends on: none\n  - Verify with: `true`\n',
    rawLedger: CORRUPT_LEDGER,
  });
  const raw = subject.run('src/T-01.mjs');
  assert.equal(raw.status, 2, `${raw.stdout}${raw.stderr}`);
  const result = verdictOf(raw);
  assert.equal(result.verdict, 'deny');
  assert.match(result.reason, /无法判定 scope/);
  assert.ok(result.corrupt);
});

test('SCEN-LED-03 a corrupt ledger with an unreadable tasks.md denies (EISDIR)', (context) => {
  // 第三种「scope 未知」形状：tasks.md 存在但读不出来。existsSync 只看得到名字，
  // 目录、权限不足、I/O 错误都会在 readFileSync 抛异常——旧实现让异常直接冒到顶层，
  // CLI 变成崩溃（exit 1 + 栈），既不是 allow 也不是 deny，hook 侧则被 catch 吞成放行。
  // 必须与「缺席」「解析失败」同等处置：损坏时 deny，健康时 fail-open。
  const subject = fixture(context, { tasks: null, rawLedger: CORRUPT_LEDGER });
  mkdirSync(path.join(subject.repo, 'openspec', 'changes', change, 'tasks.md'));
  const raw = subject.run('src/T-01.mjs');
  assert.equal(raw.status, 2, `scope 判据读不出来 + 账本损坏必须拒绝：${raw.stdout}${raw.stderr}`);
  const result = verdictOf(raw);
  assert.equal(result.verdict, 'deny');
  assert.match(result.reason, /读取失败/, '理由必须点名是读取失败，不是「不在 scope 内」');
  assert.match(result.reason, /无法判定 scope/);
  assert.ok(result.corrupt);
});

test('SCEN-LED-03 an unreadable tasks.md still fails open while the ledger is healthy (EISDIR)', (context) => {
  // 同一形状在健康账本下必须保持旧语义：守卫是减速带不是沙箱，读不出 scope 就放行。
  // 否则一份坏掉的 tasks.md 会把整个有租约的仓库锁死。
  const subject = fixture(context, { tasks: null, lease: validLease() });
  mkdirSync(path.join(subject.repo, 'openspec', 'changes', change, 'tasks.md'));
  const raw = subject.run('src/T-01.mjs');
  assert.equal(raw.status, 0, `健康账本下读不出 scope 仍应放行：${raw.stdout}${raw.stderr}`);
  const result = verdictOf(raw);
  assert.equal(result.verdict, 'allow');
  assert.match(result.reason, /读取失败/);
  assert.match(result.reason, /无法判定 scope（fail-open）/);
  assert.equal(result.corrupt, null, '健康账本不得伪造损坏标记');
});

test('SCEN-LED-03 an allow from a healthy lease never hides a corrupt ledger elsewhere', (context) => {
  // R1 审计 SPEC_VIOLATION：assessAnyWrite 扫到第一个活跃租约就 return allow，另一个 change
  // 的账本坏了却没人报告——扫描形态下损坏信号被「先到先得」的放行吃掉。
  const subject = fixture(context, { tasks: TASKS, lease: validLease() });
  // 再放一个**别的 change** 的损坏账本（目录名即 change 名）。它自带 tasks.md，
  // 使 scope 可判定：目标在它之外 → 这一路本就放行，测的是放行时不得吞掉损坏。
  const corruptDir = path.join(subject.root, 'run-state', 'other-change');
  mkdirSync(corruptDir, { recursive: true });
  writeFileSync(path.join(corruptDir, 'run-state.json'), CORRUPT_LEDGER);
  const otherOps = path.join(subject.repo, 'openspec', 'changes', 'other-change');
  mkdirSync(otherOps, { recursive: true });
  writeFileSync(path.join(otherOps, 'tasks.md'), TASKS.replace(/T-01/g, 'X-01'));

  const result = spawnSync(process.execPath, [script, '--path', 'src/other.mjs', '--json'], {
    cwd: subject.repo, env: subject.env, encoding: 'utf8',
  });
  assert.equal(result.status, 0, `健康租约下的 scope 外写入仍应放行：${result.stdout}${result.stderr}`);
  const verdict = JSON.parse(result.stdout);
  assert.equal(verdict.verdict, 'allow');
  // 放行可以，但损坏必须出现在**同一份**输出里：否则调用方只看到「不在 scope 内」，
  // 而另一个 change 的租约与在途意图此刻全部不可读，这个事实被静默吞掉了。
  assert.ok(Array.isArray(verdict.corruptions), 'allow verdict must carry corruptions');
  assert.equal(verdict.corruptions.length, 1);
  assert.equal(verdict.corruptions[0].change, 'other-change');
  assert.match(verdict.corruptions[0].file, /run-state\.json$/);
  assert.match(verdict.reason, /账本已损坏/, '人类可读理由里同样要提到损坏');
});

test('SCEN-LED-03 a corrupt change alone still reports corruption on an allow, both channels', (context) => {
  // 同一条规则的退化情形：只有损坏账本、且目标在 scope 外。CLI 的 JSON 与人类可读通道
  // 都必须显式报告 corruption，hook 的放行路径同样不能一声不吭。
  const subject = fixture(context, { tasks: TASKS, rawLedger: CORRUPT_LEDGER });

  const json = spawnSync(process.execPath, [script, '--path', 'src/other.mjs', '--json'], {
    cwd: subject.repo, env: subject.env, encoding: 'utf8',
  });
  assert.equal(json.status, 0);
  const verdict = JSON.parse(json.stdout);
  assert.equal(verdict.verdict, 'allow');
  assert.equal(verdict.corruptions.length, 1);
  assert.match(verdict.reason, /账本已损坏/);

  const human = spawnSync(process.execPath, [script, '--path', 'src/other.mjs'], {
    cwd: subject.repo, env: subject.env, encoding: 'utf8',
  });
  assert.equal(human.status, 0);
  assert.match(human.stdout, /账本已损坏/, '人类可读通道在放行时也要说出损坏');

  // 库层信号（hook 的判据源）：放行时也必须带出损坏全集，hook 才有东西可报。
  // 适配层 hooks/scope-guard-hook.mjs 把这批 corruptions 转成非阻断的
  // additionalContext（见 SCEN-LED-03「the hook reports a corrupt ledger even when
  // it allows the write」）。判据留在这里，适配层只负责转述。
  //
  // 进程内调用只认 PIPELINE_RUN_STATE_DIR（或 cwd 的 git common dir），必须显式设置并还原，
  // 否则会去读真实仓库的账本目录——测试自己就犯了「读错目录当缺席」那类误判。
  const previous = process.env.PIPELINE_RUN_STATE_DIR;
  process.env.PIPELINE_RUN_STATE_DIR = subject.env.PIPELINE_RUN_STATE_DIR;
  try {
    assert.deepEqual(
      assessAnyWrite({ target: path.join(subject.repo, 'src', 'other.mjs'), cwd: subject.repo })
        .corruptions.map((c) => c.change),
      [change],
      '库层 allow 必须带出损坏全集，供 hook 适配层消费',
    );
  } finally {
    if (previous === undefined) delete process.env.PIPELINE_RUN_STATE_DIR;
    else process.env.PIPELINE_RUN_STATE_DIR = previous;
  }
});

test('SCEN-LED-03 a ledger named by the verdict is not repeated by the scan-level note', (context) => {
  // 两层都会往 reason 里写损坏：assessWrite 写「它依据的那份」，assessAnyWrite 再整批补
  // 「其余还没提到的」。没有去重时同一份账本在一句话里出现两遍（实测：
  // 「…运行账本已损坏（<file>）…；另有 1 个 change 的运行账本已损坏（c1）…」）。
  // 重复不是致命的，但它让「有几个 change 坏了」这句话自相矛盾，读的人会以为有两份。
  const subject = fixture(context, { tasks: TASKS, rawLedger: CORRUPT_LEDGER });
  const result = spawnSync(process.execPath, [script, '--path', 'src/other.mjs', '--json'], {
    cwd: subject.repo, env: subject.env, encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  const verdict = JSON.parse(result.stdout);
  assert.equal(verdict.verdict, 'allow');
  assert.equal(verdict.corruptions.length, 1, '结构化字段仍须给出全集');
  const mentions = verdict.reason.split('run-state.json').length - 1;
  assert.equal(mentions, 1, `同一份损坏账本在理由里只该出现一次：${verdict.reason}`);
  assert.doesNotMatch(verdict.reason, /另有\s*\d+\s*个 change/, '已点名的账本不得再被扫描层补一遍');
});

test('SCEN-LED-03 the scan still reports a corrupt ledger the first verdict did not name', (context) => {
  // 去重只去掉「已经在理由里点过名」的，不能顺手把「别的 change 也坏了」这条事实吃掉。
  const subject = fixture(context, { tasks: TASKS, lease: validLease() });
  const corruptDir = path.join(subject.root, 'run-state', 'other-change');
  mkdirSync(corruptDir, { recursive: true });
  writeFileSync(path.join(corruptDir, 'run-state.json'), CORRUPT_LEDGER);
  // 它自带 tasks.md，目标是它 scope 之外的路径：这一路本就放行，测的是「补上未点名的损坏」。
  const otherOps = path.join(subject.repo, 'openspec', 'changes', 'other-change');
  mkdirSync(otherOps, { recursive: true });
  writeFileSync(path.join(otherOps, 'tasks.md'), TASKS.replace(/T-01/g, 'X-01'));
  const result = spawnSync(process.execPath, [script, '--path', 'src/other.mjs', '--json'], {
    cwd: subject.repo, env: subject.env, encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  const verdict = JSON.parse(result.stdout);
  assert.deepEqual(verdict.corruptions.map((c) => c.change), ['other-change']);
  assert.match(verdict.reason, /other-change/, '未点名的那份必须在理由里补上');
});

test('SCEN-LED-03 PIPELINE_GUARD_SCOPE=off remains the explicit escape hatch for a corrupt ledger', (context) => {
  const subject = fixture(context, { tasks: TASKS, rawLedger: CORRUPT_LEDGER });
  const result = spawnSync(process.execPath, [script, change, '--path', 'src/T-01.mjs', '--json'], {
    cwd: subject.repo, env: { ...subject.env, PIPELINE_GUARD_SCOPE: 'off' }, encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  assert.match(JSON.parse(result.stdout).reason, /PIPELINE_GUARD_SCOPE=off/);
});

test('SCEN-LED-03 the lease scan treats a corrupt ledger as corrupt, not as an idle lease', (context) => {
  // hook 用的扫描形态：损坏 change 没有可读租约，若只遍历 active，它会整个消失，
  // 输出退化成「无有效编排租约」——正是 hook 拿到空输出即放行的那条路。
  const subject = fixture(context, { tasks: TASKS, rawLedger: CORRUPT_LEDGER });
  const result = spawnSync(process.execPath, [script, '--path', 'src/T-01.mjs', '--json'], {
    cwd: subject.repo, env: subject.env, encoding: 'utf8',
  });
  assert.equal(result.status, 2, `${result.stdout}${result.stderr}`);
  const verdict = JSON.parse(result.stdout);
  assert.equal(verdict.verdict, 'deny');
  assert.equal(verdict.change, change);
  assert.ok(verdict.corrupt);
  assert.match(verdict.reason, /账本已损坏/);
});

test('SCEN-LED-03 the hook denies a scoped write while the ledger is corrupt', (context) => {
  const subject = fixture(context, { tasks: TASKS, rawLedger: CORRUPT_LEDGER });
  const result = runHook(subject, {
    session_id: 'hook-test', tool_name: 'Write',
    tool_input: { file_path: path.join(subject.repo, 'src', 'T-01.mjs') },
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny',
    '账本损坏时 hook 必须拒绝，不能把损坏读成没有 run');
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /账本已损坏/);
});

test('SCEN-LED-03 the hook reports a corrupt ledger even when it allows the write', (context) => {
  // 放行路径此前一声不吭：库层已经把损坏放进 reason/corruptions，但 hook 只在 deny 时输出，
  // 于是「扫描到一个坏掉的他 change」在 model 看来完全不存在——R1 审计 SPEC_VIOLATION
  // 的另一半。放行仍然放行，但必须带一条非阻断提示：change 名 + 账本路径 + 解析错误。
  const subject = fixture(context, { tasks: TASKS, rawLedger: CORRUPT_LEDGER });
  const result = runHook(subject, {
    session_id: 'hook-test', tool_name: 'Write',
    tool_input: { file_path: path.join(subject.repo, 'src', 'other.mjs') },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(result.stdout.trim(), '', '损坏账本上的放行不得静默');
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(output.hookSpecificOutput.permissionDecision, undefined,
    '提示必须是非阻断的：不能把 scope 外的无关写入也 deny');
  const note = output.hookSpecificOutput.additionalContext;
  assert.equal(typeof note, 'string');
  assert.match(note, new RegExp(change), '提示要点名损坏的 change');
  assert.match(note, /run-state\.json/, '提示要给出账本路径');
  assert.match(note, /不是合法 JSON/, '提示要带上解析错误本身');
});

test('SCEN-LED-03 a healthy ledger emits no non-blocking hint at all', (context) => {
  // 反向约束：提示只在 corruptions 非空时出现。健康账本上的放行保持零输出，
  // 否则每次无关写入都会被一条噪音提示污染上下文。
  const subject = fixture(context, { tasks: TASKS, lease: validLease() });
  const result = runHook(subject, {
    session_id: 'hook-test', tool_name: 'Write',
    tool_input: { file_path: path.join(subject.repo, 'src', 'other.mjs') },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '');
});

test('SCEN-LED-03 a tier-gate deny merges the corruption hint instead of emitting twice', (context) => {
  // 两条信号同时成立：scope-guard 放行（scope 外）但账本损坏，tier-gate 因第 4 个文件拒绝。
  // 若各写一份 JSON，stdout 会变成两个对象拼接，Claude Code 解析失败 → deny 退化。
  // 必须合并成**一个** deny 对象：理由里既有 tier-gate 也有损坏说明。
  const subject = fixture(context, { tasks: TASKS, rawLedger: CORRUPT_LEDGER });
  execFileSync('git', ['checkout', '-q', '-b', 'main'], { cwd: subject.repo, env: subject.env, stdio: 'ignore' });
  const tierState = mkdtempSync(path.join(tmpdir(), 'pipeline-tier-'));
  context.after(() => rmSync(tierState, { recursive: true, force: true }));
  const env = { PIPELINE_TIER_GATE_STATE: tierState };
  const call = (name) => runHook(subject, {
    session_id: 'merge-session', tool_name: 'Write',
    tool_input: { file_path: path.join(subject.repo, 'src', name) },
  }, env);
  for (const name of ['a.mjs', 'b.mjs', 'c.mjs']) {
    assert.equal(call(name).status, 0);
  }
  const fourth = call('d.mjs');
  assert.equal(fourth.status, 0, fourth.stderr);
  const lines = fourth.stdout.trim().split('\n').filter((line) => line !== '');
  assert.equal(lines.length, 1, `stdout 只能是单个 JSON 对象：${fourth.stdout}`);
  const output = JSON.parse(lines[0]);
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /tier-gate/);
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /账本已损坏/,
    '合并后的 deny 理由不得吞掉损坏信号');
});

test('SCEN-LED-03 a hook that cannot load its judgement module stays silent (top-level catch)', (context) => {
  // 顶层 catch 是「宁可漏拦，不锁死工作」的最后一道：lib 缺失、import 抛错时
  // hook 仍须 exit 0 且零输出。把 hook 单独复制到一个没有 lib/ 的目录即可复现。
  const isolated = mkdtempSync(path.join(tmpdir(), 'pipeline-hook-iso-'));
  context.after(() => rmSync(isolated, { recursive: true, force: true }));
  mkdirSync(path.join(isolated, 'hooks'), { recursive: true });
  const copy = path.join(isolated, 'hooks', 'scope-guard-hook.mjs');
  writeFileSync(copy, readFileSync(hook, 'utf8'));
  const result = spawnSync(process.execPath, [copy], {
    cwd: isolated, env: { ...process.env, PIPELINE_TIER_GATE_STATE: isolated }, encoding: 'utf8', timeout: 30_000,
    input: JSON.stringify({ session_id: 'iso', tool_name: 'Write', tool_input: { file_path: path.join(isolated, 'x.mjs') } }),
  });
  assert.equal(result.status, 0, `加载失败也必须放行：${result.stderr}`);
  assert.equal(result.stdout.trim(), '');
});

// --- PreToolUse hook 适配层（hooks/scope-guard-hook.mjs） ---
//
// hook 是判据的**第二个调用点**，所以两条约束必须被测试证伪：
//   1. 事件里不是写入工具 / 没有路径 / JSON 不合法的输入一律不输出（不干预）；
//   2. 判定为 deny 时必须输出 Claude Code 认识的 permissionDecision 结构。
// 如果这两条只靠人工走查，hook 会在某次协议变更后静默失效——而它失效时没有任何信号。
const hook = fileURLToPath(new URL('../hooks/scope-guard-hook.mjs', import.meta.url));

function runHook(subject, payload, extraEnv = {}) {
  return spawnSync(process.execPath, [hook], {
    cwd: subject.repo, env: { ...subject.env, ...extraEnv }, encoding: 'utf8', timeout: 30_000,
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
}

test('SCEN-GRD-07 the hook stays silent for non-write tools, missing paths and junk input', (context) => {
  const subject = fixture(context, { tasks: TASKS, lease: validLease() });
  for (const payload of [
    { tool_name: 'Read', tool_input: { file_path: 'src/T-01.mjs' } },
    { tool_name: 'Bash', tool_input: { command: 'echo x > src/T-01.mjs' } },
    { tool_name: 'Write', tool_input: {} },
    'not json',
  ]) {
    const result = runHook(subject, payload);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), '', `hook 不应输出任何内容：${JSON.stringify(payload)}`);
  }
});

test('SCEN-GRD-07 the hook emits a real PreToolUse deny for an unexplained scope write', (context) => {
  const subject = fixture(context, { tasks: TASKS, lease: validLease() });
  const result = runHook(subject, {
    session_id: 'hook-test', tool_name: 'Write',
    tool_input: { file_path: path.join(subject.repo, 'src', 'T-01.mjs'), content: 'x' },
  });
  assert.equal(result.status, 0, 'hook 自身退出码恒为 0；裁决走 JSON');
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /T-01 的 Write scope/);
});

test('SCEN-GRD-07 the hook allows a scope write that has a writer intent, from the writer worktree', (context) => {
  const subject = fixture(context, { tasks: TASKS, lease: validLease(), intents: [writerIntent()] });
  const writer = linkedWorktree(subject);
  const result = spawnSync(process.execPath, [hook], {
    cwd: writer.dir, env: subject.env, encoding: 'utf8', timeout: 30_000,
    input: JSON.stringify({
      session_id: 'hook-test', tool_name: 'Edit',
      tool_input: { file_path: path.join(writer.dir, 'src', 'T-01.mjs') },
    }),
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), '');
});

test('SCEN-GRD-07 no lease means the hook never interferes', (context) => {
  const subject = fixture(context, { tasks: TASKS });
  const result = runHook(subject, {
    session_id: 'hook-test', tool_name: 'Write',
    tool_input: { file_path: path.join(subject.repo, 'src', 'T-01.mjs') },
  });
  assert.equal(result.stdout.trim(), '');
});

test('SCEN-GRD-07 --install-help prints a settings.json fragment naming this hook', (context) => {
  const subject = fixture(context, { tasks: TASKS });
  const result = spawnSync(process.execPath, [hook, '--install-help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /hooks\.PreToolUse/);
  assert.match(result.stdout, /scope-guard-hook\.mjs/);
  assert.match(result.stdout, /PreToolUse|matcher/);
});

// SCEN-GRD-08 跨仓库 cwd：Claude Code 在 session 的 cwd 下启动 hook，而 session 的 cwd
// 与写入目标所在的仓库可以不同（往另一个 checkout 写绝对路径很常见）。曾把账本目录锚在
// process.cwd()，于是从 paseo-skills 调用、对 /tmp 下带租约的仓库写入时扫不到租约，
// 守卫输出为空 —— deny 静默退化成 allow。判据必须由**目标路径**反推仓库。
function runHookFrom(subject, payload, cwd) {
  return spawnSync(process.execPath, [hook], {
    cwd, env: subject.env, encoding: 'utf8', timeout: 30_000, input: JSON.stringify(payload),
  });
}

test('SCEN-GRD-08 hook still denies a scoped write when invoked from a foreign cwd', (context) => {
  const subject = fixture(context, { tasks: TASKS, lease: validLease() });
  const foreign = mkdtempSync(path.join(tmpdir(), 'pipeline-guard-cwd-'));
  context.after(() => rmSync(foreign, { recursive: true, force: true }));
  const result = runHookFrom(subject, {
    session_id: 'hook-test', tool_name: 'Write',
    tool_input: { file_path: path.join(subject.repo, 'src', 'T-01.mjs') },
  }, foreign);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny',
    '从别的 cwd 调用时守卫不得静默放行');
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /T-01 的 Write scope/);
});

test('SCEN-GRD-08 foreign cwd keeps the allow paths intact', (context) => {
  const subject = fixture(context, { tasks: TASKS, lease: validLease(), intents: [writerIntent()] });
  const foreign = mkdtempSync(path.join(tmpdir(), 'pipeline-guard-cwd-'));
  context.after(() => rmSync(foreign, { recursive: true, force: true }));
  const writer = linkedWorktree(subject);
  const covered = runHookFrom(subject, {
    session_id: 'hook-test', tool_name: 'Edit',
    tool_input: { file_path: path.join(writer.dir, 'src', 'T-01.mjs') },
  }, foreign);
  assert.equal(covered.stdout.trim(), '', '写手 worktree 里有写手意图时仍应放行');
  const outside = runHookFrom(subject, {
    session_id: 'hook-test', tool_name: 'Write',
    tool_input: { file_path: path.join(subject.repo, 'src', 'other.mjs') },
  }, foreign);
  assert.equal(outside.stdout.trim(), '', 'scope 外的写入不受影响');
});

test('SCEN-GRD-08 the CLI keeps cwd-relative semantics when target lives under cwd', (context) => {
  const subject = fixture(context, { tasks: TASKS, lease: validLease() });
  const result = subject.run('src/T-01.mjs');
  const verdict = verdictOf(result);
  assert.equal(verdict.verdict, 'deny', '相对路径仍按 cwd 所在仓库判定');
  assert.equal(verdict.path, 'src/T-01.mjs');
});
