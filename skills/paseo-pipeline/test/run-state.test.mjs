import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs, { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  intentKey, leaseStatus, openIntents, findByKey, intentAgeMs, DEFAULT_LEASE_TTL_MS,
} from '../lib/run-state.mjs';

const script = fileURLToPath(new URL('../run-state.mjs', import.meta.url));
const change = 'run-state-contract';

function fixture(context) {
  const root = mkdtempSync(path.join(tmpdir(), 'pipeline-run-state-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, PIPELINE_RUN_STATE_DIR: path.join(root, 'state') };
  const file = path.join(root, 'state', change, 'run-state.json');
  const run = (...args) => spawnSync(process.execPath, [script, args[0], change, ...args.slice(1)], {
    env, encoding: 'utf8', timeout: 15_000,
  });
  const read = () => JSON.parse(readFileSync(file, 'utf8'));
  return { root, env, file, run, read };
}

test('begin acquires a lease and a second owner cannot steal a live lease', (context) => {
  const subject = fixture(context);
  const first = subject.run('begin', '--owner', 'lead-a');
  assert.equal(first.status, 0, first.stderr);
  const second = subject.run('begin', '--owner', 'lead-b');
  assert.equal(second.status, 2, 'a live lease must not be stolen by another owner');
  assert.match(second.stderr, /租约仍由 lead-a 持有/);

  const state = subject.read();
  assert.equal(state.lease.owner, 'lead-a');
  assert.equal(state.lease.generation, 1);
});

test('an expired lease is reclaimable and bumps the generation so the old lead cannot act', (context) => {
  const subject = fixture(context);
  subject.run('begin', '--owner', 'lead-a');
  // 直接把租约改到过去：模拟前任编排者已死。过期不是「抢」，是重新领取代际。
  const state = subject.read();
  state.lease.expiresAt = new Date(Date.now() - 1000).toISOString();
  writeFileSync(subject.file, JSON.stringify(state, null, 2));

  const taken = subject.run('begin', '--owner', 'lead-b');
  assert.equal(taken.status, 0, taken.stderr);
  assert.equal(subject.read().lease.generation, 2, 'a new generation must be issued');

  const stale = subject.run('claim', '--task', 'T-01', '--owner', 'lead-a');
  assert.equal(stale.status, 2, 'the previous generation must not be able to submit actions');
  assert.match(stale.stderr, /无权|旧 Lead/);
});

test('claim then record resolves the intent exactly once and rejects a duplicate claim', (context) => {
  const subject = fixture(context);
  subject.run('begin', '--owner', 'lead-a');
  const key = intentKey({
    run: null, task: 'T-01', attempt: 1, phase: 'impl', role: 'gongbu', action: 'dispatch',
  });

  const claim = subject.run('claim', '--task', 'T-01', '--attempt', '1', '--phase', 'impl', '--role', 'gongbu', '--owner', 'lead-a');
  assert.equal(claim.status, 0, claim.stderr);

  const duplicate = subject.run('claim', '--task', 'T-01', '--attempt', '1', '--phase', 'impl', '--role', 'gongbu', '--owner', 'lead-a');
  assert.equal(duplicate.status, 2, 'an open intent must block a repeat dispatch');
  assert.match(duplicate.stderr, /拒绝重复派发/);

  const record = subject.run('record', '--key', key, '--agent', 'agent-abc', '--workspace', 'wks-1', '--owner', 'lead-a');
  assert.equal(record.status, 0, record.stderr);
  const intent = findByKey(subject.read(), key);
  assert.equal(intent.agentId, 'agent-abc');
  assert.equal(intent.workspaceId, 'wks-1');
  assert.ok(intent.resolvedAt, 'record must stamp resolvedAt');

  // 回执之后同一 key 仍不得重复派发：任务已有归属，重派会导致双写。
  const again = subject.run('claim', '--task', 'T-01', '--attempt', '1', '--phase', 'impl', '--role', 'gongbu', '--owner', 'lead-a');
  assert.equal(again.status, 2);
});

test('a different attempt is a distinct intent key, not a duplicate', (context) => {
  const subject = fixture(context);
  subject.run('begin', '--owner', 'lead-a');
  subject.run('claim', '--task', 'T-01', '--attempt', '1', '--phase', 'impl', '--role', 'gongbu', '--owner', 'lead-a');
  const second = subject.run('claim', '--task', 'T-01', '--attempt', '2', '--phase', 'impl', '--role', 'gongbu', '--owner', 'lead-a');
  assert.equal(second.status, 0, 'a retry is a new attempt and must be claimable');
});

test('fail releases the intent so the task can be dispatched again', (context) => {
  const subject = fixture(context);
  subject.run('begin', '--owner', 'lead-a');
  const key = intentKey({
    run: null, task: 'T-02', attempt: 1, phase: 'impl', role: 'gongbu', action: 'dispatch',
  });
  subject.run('claim', '--task', 'T-02', '--attempt', '1', '--phase', 'impl', '--role', 'gongbu', '--owner', 'lead-a');
  const failed = subject.run('fail', '--key', key, '--reason', 'create_agent failed', '--owner', 'lead-a');
  assert.equal(failed.status, 0, failed.stderr);
  assert.equal(subject.read().intents[0].reason, 'create_agent failed');
  // fail 后该意图不再是「未回执」，但也不算成功回执。
  const state = subject.read();
  assert.equal(state.intents[0].resolvedAt, null);
  assert.ok(state.intents[0].failedAt);
});

test('claim without a lease is allowed (bare single-run usage) but a stale lease still blocks', (context) => {
  const subject = fixture(context);
  const noLease = subject.run('claim', '--task', 'T-01', '--attempt', '1');
  assert.equal(noLease.status, 0, 'no lease record means the lease feature is not in use');
});

test('unknown key on record is a usage error, not a silent success', (context) => {
  const subject = fixture(context);
  subject.run('begin', '--owner', 'lead-a');
  const result = subject.run('record', '--key', 'nope', '--agent', 'a', '--owner', 'lead-a');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /未知意图键/);
});

test('heartbeat is no longer a run-state subcommand', (context) => {
  // 注册入口已删：SKILL 声明常规运行不建周期性 heartbeat，2026-10-26 账本 heartbeats=0。
  // 旧账本里的 heartbeats 数组仍是只读兼容字段，status 照常打印，但不得再有写入路径。
  const subject = fixture(context);
  const result = subject.run('heartbeat', '--id', 'hb-1', '--action', 'register');
  assert.equal(result.status, 1, 'removed subcommand must be a usage error');
  assert.match(result.stderr, /未知命令/);
});

test('a corrupt run-state file is reported as absent, never thrown', (context) => {
  const subject = fixture(context);
  mkdirSync(path.dirname(subject.file), { recursive: true });
  writeFileSync(subject.file, '{ not json');
  const status = subject.run('status');
  assert.equal(status.status, 0, 'status must still work on a corrupt ledger');
  assert.match(status.stdout, /无记录|WARN/);
});

test('leaseStatus treats an unparseable expiry as invalid rather than fresh', () => {
  const status = leaseStatus({ lease: { owner: 'x', generation: 1, expiresAt: 'not-a-date' } });
  assert.equal(status.valid, false);
});

test('openIntents excludes resolved and failed intents', () => {
  const state = {
    intents: [
      { key: 'a', resolvedAt: '2026-01-01T00:00:00Z' },
      { key: 'b', resolvedAt: null, failedAt: '2026-01-01T00:00:00Z' },
      { key: 'c', resolvedAt: null },
    ],
  };
  assert.deepEqual(openIntents(state).map((i) => i.key), ['c']);
});

test('intentAgeMs returns null for an unparseable timestamp instead of a fake age', () => {
  assert.equal(intentAgeMs({ createdAt: 'nonsense' }), null);
  assert.equal(intentAgeMs({ createdAt: new Date().toISOString() }) >= 0, true);
});

test('DEFAULT_LEASE_TTL_MS is a sane positive window', () => {
  assert.ok(DEFAULT_LEASE_TTL_MS > 0);
});

// --- 以下四条来自 2026-10-26 真实缺口复核（/tmp 实测复现，修复前全部可绕过） ---

test('an active lease makes --owner mandatory: omitting it must not bypass the single-owner rule', (context) => {
  const subject = fixture(context);
  subject.run('begin', '--owner', 'lead-a');
  // 修复前：owner===null 直接跳过比对，任何进程省略参数即可继续提交动作。
  const claim = subject.run('claim', '--task', 'T-01', '--attempt', '1', '--phase', 'impl', '--role', 'gongbu');
  assert.equal(claim.status, 2, 'an active lease must not be bypassed by omitting --owner');
  assert.match(claim.stderr, /必须带 --owner/);
  assert.equal(subject.read().intents.length, 0, '被拒的动作不得落盘');
});

test('record requires a real --agent so the receipt stays traceable', (context) => {
  const subject = fixture(context);
  subject.run('begin', '--owner', 'lead-a');
  const key = intentKey({ run: null, task: 'T-03', attempt: 1, phase: 'impl', role: 'gongbu', action: 'dispatch' });
  subject.run('claim', '--task', 'T-03', '--attempt', '1', '--phase', 'impl', '--role', 'gongbu', '--owner', 'lead-a');
  const bare = subject.run('record', '--key', key, '--owner', 'lead-a');
  assert.equal(bare.status, 1, 'a receipt without an agent id is untraceable');
  assert.match(bare.stderr, /需要 --agent/);
  assert.equal(findByKey(subject.read(), key).resolvedAt, null, '被拒的回执不得关掉意图');
});

test('fail authorises a same-key retry while record stays rejected', (context) => {
  const subject = fixture(context);
  subject.run('begin', '--owner', 'lead-a');
  const args = ['--task', 'T-04', '--attempt', '1', '--phase', 'impl', '--role', 'gongbu', '--owner', 'lead-a'];
  const key = intentKey({ run: null, task: 'T-04', attempt: 1, phase: 'impl', role: 'gongbu', action: 'dispatch' });
  subject.run('claim', ...args);
  subject.run('fail', '--key', key, '--reason', 'create_agent rejected', '--owner', 'lead-a');

  // fail 明说这次派发没成功，按同一幂等键重派是预期路径（修复前会误判为重复派发）。
  const retry = subject.run('claim', ...args);
  assert.equal(retry.status, 0, retry.stderr);
  assert.match(retry.stdout, /retry of a failed intent/);
  const intent = findByKey(subject.read(), key);
  assert.ok(intent.retryOf, '重派必须留下 retryOf 链，否则丢失失败历史');
  assert.equal(intent.resolvedAt, null, '重派后意图重新变为未回执');
  assert.equal(subject.read().intents.length, 1, '重派复位同一条记录，键唯一是幂等的前提');
});

test('a failed intent cannot be revived by record', (context) => {
  const subject = fixture(context);
  subject.run('begin', '--owner', 'lead-a');
  const key = intentKey({ run: null, task: 'T-05', attempt: 1, phase: 'impl', role: 'gongbu', action: 'dispatch' });
  subject.run('claim', '--task', 'T-05', '--attempt', '1', '--phase', 'impl', '--role', 'gongbu', '--owner', 'lead-a');
  subject.run('fail', '--key', key, '--reason', 'create failed', '--owner', 'lead-a');

  // 修复前 record 会 delete failedAt，把一条已作废的意图悄悄复活成「已回执」。
  const revived = subject.run('record', '--key', key, '--agent', 'ghost', '--owner', 'lead-a');
  assert.equal(revived.status, 2, 'a failed intent must not be closed by record');
  assert.match(revived.stderr, /不得用 record 复活/);
  const intent = findByKey(subject.read(), key);
  assert.ok(intent.failedAt, 'failedAt 必须保留');
  assert.equal(intent.agentId, null);
});

test('SCEN-CON-09 an intent with a real receipt cannot be voided, so its key cannot be reused', (context) => {
  // 实际复现的缺陷：claim → record → fail 三步都 rc=0，随后同一幂等键可以再次 claim，
  // 于是同一 attempt 派出了第二个写手，账本上却只写着「上次失败」。
  // 作废的语义是「这次派发确认没有发生」；回执证明它发生过并指向一个真实 agent。
  const subject = fixture(context);
  subject.run('begin', '--owner', 'lead-a');
  const args = ['--task', 'T-06', '--attempt', '1', '--phase', 'impl', '--role', 'gongbu', '--owner', 'lead-a'];
  const key = intentKey({ run: null, task: 'T-06', attempt: 1, phase: 'impl', role: 'gongbu', action: 'dispatch' });
  subject.run('claim', ...args);
  subject.run('record', '--key', key, '--agent', '01234567-89ab-cdef-0123-456789abcdef', '--owner', 'lead-a');

  const voided = subject.run('fail', '--key', key, '--reason', 'agent went silent', '--owner', 'lead-a');
  assert.equal(voided.status, 2, 'a recorded intent must not be voided');
  assert.match(voided.stderr, /已有真实回执/);
  const intent = findByKey(subject.read(), key);
  assert.equal(intent.failedAt, undefined, '账本不得留下 failedAt');
  assert.equal(intent.agentId, '01234567-89ab-cdef-0123-456789abcdef', '回执必须原样保留');

  // 真正的处置路径：新的 attempt 键。旧键仍被锁住，重复派发依旧被拒。
  const reClaim = subject.run('claim', ...args);
  assert.equal(reClaim.status, 2, 'the same attempt key must stay occupied');
  const nextAttempt = subject.run('claim', '--task', 'T-06', '--attempt', '2',
    '--phase', 'impl', '--role', 'gongbu', '--owner', 'lead-a');
  assert.equal(nextAttempt.status, 0, nextAttempt.stderr);
});

// --- 读改写互斥（L4-03 幂等的前提） ---
// tmp + rename 只保证「写入原子」，不保证「读改写互斥」：两个进程同时 claim 同一 run
// 会各自读到旧快照、各自写回，幂等键双双成功，同一动作被派发两次。

test('SCEN-RS-LOCK concurrent claims of the same intent can never both succeed', (context) => {
  const subject = fixture(context);
  assert.equal(subject.run('claim', '--task', 'T-01').status, 0);
  // 手工占住账本锁，模拟另一个进程正在读改写。
  const lockDir = path.join(subject.root, 'state', change);
  writeFileSync(path.join(lockDir, 'run-state.lock'),
    JSON.stringify({ pid: 99999, host: 'other-host', acquiredAt: new Date().toISOString() }));

  const blocked = subject.run('claim', '--task', 'T-02');
  assert.equal(blocked.status, 2, `${blocked.stdout}${blocked.stderr}`);
  assert.match(blocked.stderr, /运行账本被占用/);
  // 被锁挡住的动作不得留下半条记录。
  assert.equal(subject.read().intents.length, 1, 'a blocked claim must not write anything');
});

test('SCEN-RS-LOCK a stale lock from a crashed run is reclaimed instead of wedging the run', (context) => {
  const subject = fixture(context);
  const lockFile = path.join(subject.root, 'state', change, 'run-state.lock');
  mkdirSync(path.dirname(lockFile), { recursive: true });
  writeFileSync(lockFile, JSON.stringify({ pid: 99999, host: 'other-host', acquiredAt: '2020-01-01T00:00:00.000Z' }));
  // 把 mtime 推到远超陈旧阈值的位置。
  const old = new Date('2020-01-01T00:00:00.000Z');
  fs.utimesSync(lockFile, old, old);

  const result = subject.run('claim', '--task', 'T-01');
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(subject.read().intents.length, 1);
});

// --- report：度量只写采集值（2026-10-27 包 5） ---
//
// 复盘的常见污染是「看起来精确的估算」：它比「未采集」更有害，因为会被当成实测值引用。
// 所以 report 只从账本已有的时间戳与字段推导，做不到的项直接写「未采集」。

test('SCEN-CON-10 SCEN-CON-22 report derives only what the ledger actually recorded', (context) => {
  const subject = fixture(context);
  subject.run('begin', '--owner', 'lead-a');
  subject.run('claim', '--task', 'T-01', '--attempt', '1', '--phase', 'impl', '--role', 'gongbu', '--owner', 'lead-a');
  subject.run('record', '--key', intentKey({ run: null, task: 'T-01', attempt: 1, phase: 'impl', role: 'gongbu', action: 'dispatch' }),
    '--agent', '01234567-89ab-cdef-0123-456789abcdef', '--owner', 'lead-a');
  subject.run('claim', '--task', 'T-01', '--attempt', '2', '--phase', 'impl', '--role', 'gongbu', '--owner', 'lead-a');
  subject.run('claim', '--task', 'T-02', '--attempt', '1', '--phase', 'impl', '--role', 'gongbu', '--owner', 'lead-a');
  subject.run('claim', '--task', 'T-02', '--attempt', '1', '--phase', 'audit', '--role', 'anchasi', '--owner', 'lead-a');

  const report = JSON.parse(subject.run('report', '--json').stdout);
  assert.equal(report.dispatches, 1, '只有带真实 agent 回执的意图算派发');
  assert.equal(report.tasksDispatched, 1);
  assert.equal(report.auditDispatches, 1);
  assert.equal(report.maxAttempt, 1, 'attempt 2 尚未回执，不能算作已发生的派发');

  // 账本不记审查结论与状态迁移时刻：这些项**不出现在报告里**，也不估算。
  // 旧版并排打印两项恒为「未采集」的字段；一条永远是同一个占位值的字段不传递信息，
  // 只会让报告看起来像覆盖了它。口径改成报告末尾一句「本报告不覆盖什么」。
  assert.equal(report.firstPassUnknown, undefined, '不采集的项不占字段位');
  assert.equal(report.readyWaitUnknown, undefined, '不采集的项不占字段位');
  assert.match(subject.run('report').stdout, /未采集：账本不记审查结论与状态迁移时刻/,
    '不覆盖的口径必须写出来，不能静默省略');
});

test('SCEN-CON-10 report on a missing ledger reports absence instead of zeros that look measured', (context) => {
  const subject = fixture(context);
  const report = JSON.parse(subject.run('report', '--json').stdout);
  assert.equal(report.present, false);
  assert.equal(report.dispatches, 0);
  assert.equal(report.maxAttempt, null, '无派发时最大 attempt 是 null，不是 0');
});

// --- Skill 版本留痕（2026-10-27 包 5 轻量版） ---
//
// 不允许强制：读旧账本、在另一台机器上诊断，都不该因为 Skill HEAD 不同而失败。
// 但「这批任务由哪一份编排逻辑产生」必须留痕——复盘时要判断某条规则当时是否存在，
// 只能靠这个字段。

test('SCEN-CON-11 begin records the Skill version so a later review can tell which rules applied', (context) => {
  const subject = fixture(context);
  subject.run('begin', '--owner', 'lead-a');
  const skill = subject.read().skill;
  assert.ok(skill, 'begin 必须记录 Skill 版本');
  assert.match(skill.head, /^[0-9a-f]{40}$/, '记录完整 HEAD，不是分支名');
  assert.equal(typeof skill.dirty, 'boolean');
  assert.ok(skill.dir.endsWith('paseo-pipeline'), '目录要能指回是哪份 Skill');
});

test('SCEN-CON-11 a Skill version mismatch warns instead of blocking, and an old ledger stays readable', (context) => {
  const subject = fixture(context);
  subject.run('begin', '--owner', 'lead-a');
  // 模拟「账本由旧版 Skill 产生」：改写成另一个 HEAD。
  const state = subject.read();
  state.skill = { ...state.skill, head: 'f'.repeat(40) };
  writeFileSync(subject.file, JSON.stringify(state, null, 2));

  const status = subject.run('status');
  assert.equal(status.status, 0, '版本不同不得让诊断失败');
  assert.match(status.stdout, /与当前 .* 不同|不同：本账本/);

  // 旧账本没有 skill 字段：如实说未采集，不猜。
  const legacy = subject.read();
  delete legacy.skill;
  writeFileSync(subject.file, JSON.stringify(legacy, null, 2));
  const legacyStatus = subject.run('status');
  assert.equal(legacyStatus.status, 0);
  assert.match(legacyStatus.stdout, /SKILL 未采集/);
});

test('SCEN-CON-23 an uncapturable Skill version is reported instead of silently recorded as null', (context) => {
  // 写进账本的 skill:null 与「从没采过」在文件里长得一样：留痕字段的价值全在
  // 「知道它是缺的」。所以采集失败必须在 begin 时当场说一行，且仍然不拦——
  // 无 git 的部署、旧账本诊断都要能继续。
  const root = mkdtempSync(path.join(tmpdir(), 'pipeline-run-state-nogit-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const env = {
    ...process.env,
    PIPELINE_RUN_STATE_DIR: path.join(root, 'state'),
    // 让 `git -C <skillDir> rev-parse HEAD` 找不到仓库：GIT_DIR 指向不存在的位置。
    // （skillDir 是真实仓库里的目录，没有这条它必然采得到。）
    GIT_DIR: path.join(root, 'not-a-repo.git'),
    GIT_WORK_TREE: path.join(root, 'not-a-worktree'),
  };
  const begin = spawnSync(process.execPath, [script, 'begin', change, '--owner', 'lead-a'], {
    env, encoding: 'utf8', timeout: 15_000,
  });
  assert.equal(begin.status, 0, '采集失败不得阻断 begin');
  assert.match(begin.stderr, /Skill 版本未采集/, '采集失败必须可见，不能静默写 null');
});
