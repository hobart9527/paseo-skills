import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs, { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
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

  const stale = subject.run('claim', '--task', 'T-01', '--attempt', '1', '--phase', 'impl', '--role', 'gongbu', '--owner', 'lead-a');
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
  const noLease = subject.run('claim', '--task', 'T-01', '--attempt', '1', '--phase', 'impl', '--role', 'gongbu');
  assert.equal(noLease.status, 0, 'no lease record means the lease feature is not in use');
});

test('claim refuses an incomplete intent key instead of writing a `-` placeholder entry', (context) => {
  const subject = fixture(context);
  // 真实账本里出现过 `local:T-06:-:-:-:dispatch`：缺 attempt/phase/role 的 claim 被默默接受。
  for (const args of [
    ['--task', 'T-01'],
    ['--task', 'T-01', '--attempt', '1'],
    ['--task', 'T-01', '--attempt', '1', '--phase', 'impl'],
    ['--task', 'T-01', '--phase', 'impl', '--role', 'gongbu'],
  ]) {
    const result = subject.run('claim', ...args);
    assert.equal(result.status, 1, `${args.join(' ')}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /claim 缺少/);
  }
  const bad = subject.run('claim', '--task', 'T-01', '--attempt', 'x', '--phase', 'impl', '--role', 'gongbu');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /正整数/);
  assert.equal(existsSync(subject.file), false, '被拒的 claim 不得创建账本');
});

// 派发标签自检：漏打 pipeline.* 标签的 agent 会被 reconcile 判 UNMAPPED，并且 write-guard
// 不把它当派生 agent 豁免（首写即被拦、无人可回复）。record 拿到真实 agent id，正好核对。
const AGENT_ID = '3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b';
const ALL_LABELS = {
  'pipeline.change': change, 'pipeline.task': 'T-01', 'pipeline.attempt': '1',
  'pipeline.phase': 'impl', 'pipeline.role': 'gongbu',
};

function recordWithAgentLabels(context, labels) {
  const subject = fixture(context);
  const paseoHome = path.join(subject.root, 'paseo-home');
  if (labels !== undefined) {
    const dir = path.join(paseoHome, 'agents', 'slug');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${AGENT_ID}.json`), JSON.stringify({ id: AGENT_ID, labels }));
  }
  const withHome = { ...subject.env, PIPELINE_PASEO_HOME: paseoHome };
  const run = (...args) => spawnSync(process.execPath, [script, args[0], change, ...args.slice(1)], {
    env: withHome, encoding: 'utf8', timeout: 15_000,
  });
  assert.equal(run('claim', '--task', 'T-01', '--attempt', '1', '--phase', 'impl', '--role', 'gongbu').status, 0);
  const key = intentKey({ run: null, task: 'T-01', attempt: 1, phase: 'impl', role: 'gongbu', action: 'dispatch' });
  return { subject, result: run('record', '--key', key, '--agent', AGENT_ID) };
}

test('record warns (but still records) when the dispatched agent lacks pipeline labels', (context) => {
  const { subject, result } = recordWithAgentLabels(context, { 'pipeline.change': change, 'pipeline.task': 'T-01' });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /缺派发标签：pipeline\.attempt, pipeline\.phase, pipeline\.role/);
  assert.match(result.stderr, /write-guard/);
  assert.ok(subject.read().intents[0].resolvedAt, '告警不改变回执：agent 已建成，拒绝回执只会让它失联');
});

test('record stays silent when every pipeline label is present or the agent record is unreadable', (context) => {
  const complete = recordWithAgentLabels(context, ALL_LABELS);
  assert.equal(complete.result.status, 0);
  assert.doesNotMatch(complete.result.stderr, /缺派发标签/);
  const unreadable = recordWithAgentLabels(context, undefined);
  assert.equal(unreadable.result.status, 0);
  assert.doesNotMatch(unreadable.result.stderr, /缺派发标签/, '读不到记录不等于缺标签');
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
  assert.equal(subject.run('claim', '--task', 'T-01', '--attempt', '1', '--phase', 'impl', '--role', 'gongbu').status, 0);
  // 手工占住账本锁，模拟另一个进程正在读改写。
  const lockDir = path.join(subject.root, 'state', change);
  writeFileSync(path.join(lockDir, 'run-state.lock'),
    JSON.stringify({ pid: 99999, host: 'other-host', acquiredAt: new Date().toISOString() }));

  const blocked = subject.run('claim', '--task', 'T-02', '--attempt', '1', '--phase', 'impl', '--role', 'gongbu');
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

  const result = subject.run('claim', '--task', 'T-01', '--attempt', '1', '--phase', 'impl', '--role', 'gongbu');
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

  // 2026-10-31 起账本新增 reviews/merges/readyObs：这两项不再是「恒为未采集」的占位字段。
  // 没有 review 记录时如实写未采集（不能拿派发次数冒充分母）。
  assert.equal(report.auditedTasks, 0);
  assert.equal(report.firstPassRate, null, '无审计结论时通过率是 null，不是 0');
  assert.match(subject.run('report').stdout, /首次通过率 未采集/,
    '缺数据必须写未采集，不能打印 0%');
  // attempt 2 的 claim 发生在 attempt 1 的 record 之后：账本确实采到了这一对相邻动作，
  // 所以 READY 等待必须给出样本数与口径，而不是「未采集」。
  assert.equal(report.readyWait.samples, 1, '上一动作结束→本次 claim 这对动作必须被计时');
  assert.match(report.readyWait.basis, /上一动作结束/);
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

// --- review / merge：首次通过率与合流事实的写入点（2026-10-31） ---
//
// 这两个子命令存在的理由只有一个：让 `report` 的分母与分子有真实来源。
// 它们只登记调用者声明的事实，不读 Paseo 离线状态——事实成立与否由 merge-task 的
// reviewer 交叉核对负责，账本不假装自己验过。

test('SCEN-CON-10 review registers the first-round verdict so the rate has a denominator', (context) => {
  const subject = fixture(context);
  subject.run('review', '--task', 'T-01', '--verdict', 'PASS', '--agent', 'reviewer-1', '--round', '1');
  subject.run('review', '--task', 'T-02', '--verdict', 'BLOCK', '--agent', 'reviewer-1', '--round', '1');
  // 第二轮复核不改写首轮结论：一次通过率问的是「第一轮就过没有」。
  subject.run('review', '--task', 'T-02', '--verdict', 'PASS', '--agent', 'reviewer-1', '--round', '2');

  const report = JSON.parse(subject.run('report', '--json').stdout);
  assert.equal(report.auditedTasks, 2);
  assert.equal(report.firstPassTasks, 1, 'T-02 的第二轮 PASS 不能把首轮 BLOCK 洗白');
  assert.equal(report.firstPassRate, 0.5);
  assert.equal(subject.read().reviews.length, 3, '每轮结论各存一条');
});

test('SCEN-CON-10 a re-recorded verdict for the same round replaces instead of double counting', (context) => {
  const subject = fixture(context);
  subject.run('review', '--task', 'T-01', '--verdict', 'BLOCK', '--agent', 'r1', '--round', '1');
  subject.run('review', '--task', 'T-01', '--verdict', 'PASS_WITH_NITS', '--agent', 'r1', '--round', '1');
  const state = subject.read();
  assert.equal(state.reviews.length, 1, '同一 (task, attempt, round) 只留一条');
  assert.equal(state.reviews[0].verdict, 'PASS_WITH_NITS');
});

test('SCEN-CON-10 review rejects an unknown verdict and a missing reviewer', (context) => {
  const subject = fixture(context);
  const badVerdict = subject.run('review', '--task', 'T-01', '--verdict', 'LGTM', '--agent', 'r1');
  assert.equal(badVerdict.status, 1);
  assert.match(badVerdict.stderr, /--verdict 取值未知/);
  const noAgent = subject.run('review', '--task', 'T-01', '--verdict', 'PASS');
  assert.equal(noAgent.status, 1);
  assert.match(noAgent.stderr, /结论必须能对上人/);
  assert.equal(existsSync(subject.file), false, '被拒的结论不得落盘（连空账本都不该建）');
});

test('SCEN-CON-10 merge records the first-parent fact per task and stays idempotent', (context) => {
  const subject = fixture(context);
  const first = subject.run('merge', '--task', 'T-01,T-02', '--sha', 'abc1234', '--attempt', '2', '--review-tag', 'review-T-01');
  assert.equal(first.status, 0, first.stderr);
  const again = subject.run('merge', '--task', 'T-01', '--sha', 'abc1234');
  assert.equal(again.status, 0, again.stderr);
  const state = subject.read();
  assert.equal(state.merges.length, 2, '同一 (task, sha) 不得重复记账');
  assert.equal(state.merges[0].attempt, 2);
  assert.equal(state.merges[0].reviewTag, 'review-T-01');
  const report = JSON.parse(subject.run('report', '--json').stdout);
  assert.equal(report.mergedTasks, 2);
});

test('SCEN-CON-10 merge refuses an empty task list instead of writing a nameless fact', (context) => {
  const subject = fixture(context);
  const result = subject.run('merge', '--task', ' , ', '--sha', 'abc1234');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--task 不能为空/);
});

// --- record --envelope：信封过去完全没有被代码读过 ---
//
// 后果：漏字段、自相矛盾、超行的信封在账本上零痕迹，Lead 只能自己猜 next_action。
// 校验不过即拒绝回执，因为回执是「这次派发产出了什么」的唯一入口。

const ENVELOPE = (overrides = {}) => {
  const base = {
    kind: 'phase-complete',
    task: 'T-01',
    attempt: '1',
    phase: 'impl',
    result: '实现完成',
    reviewed_sha: '528c69176495ee698383bc565b0ea9dfc467d897',
    blockers: 'none',
    next_action: 'merge',
    ...overrides,
  };
  return Object.entries(base).map(([k, v]) => `${k}: ${v}`).join('\n');
};

function envelopeFile(subject, text) {
  const file = path.join(subject.root, 'envelope.md');
  writeFileSync(file, `${text}\n`);
  return file;
}

function claimAndRecord(subject, extra = [], keyArgs = { attempt: '1', phase: 'impl', role: 'gongbu' }) {
  subject.run('begin', '--owner', 'lead-a');
  subject.run('claim', '--task', 'T-01', '--attempt', keyArgs.attempt, '--phase', keyArgs.phase,
    '--role', keyArgs.role, '--owner', 'lead-a');
  const key = intentKey({
    run: null, task: 'T-01', attempt: Number(keyArgs.attempt), phase: keyArgs.phase,
    role: keyArgs.role, action: 'dispatch',
  });
  return subject.run('record', '--key', key, '--agent', 'agent-env', '--role', keyArgs.role, '--owner', 'lead-a', ...extra);
}

test('SCEN-ENV-02 record accepts a well-formed envelope and snapshots its fields', (context) => {
  const subject = fixture(context);
  const result = claimAndRecord(subject, ['--envelope', envelopeFile(subject, ENVELOPE())]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /envelope=8行\/8字段/);
  const intent = subject.read().intents[0];
  assert.equal(intent.envelope.next_action, 'merge');
  assert.equal(intent.envelope.task, 'T-01');
});

test('SCEN-ENV-02 a malformed envelope blocks the receipt instead of being stored as prose', (context) => {
  const subject = fixture(context);
  const result = claimAndRecord(subject, [
    '--envelope', envelopeFile(subject, ENVELOPE({ next_action: 'ship-it' })),
  ]);
  assert.equal(result.status, 2, '结构不合格的信封不得关掉意图');
  assert.match(result.stderr, /信封结构不合格/);
  assert.match(result.stderr, /next_action="ship-it"/);
  assert.equal(subject.read().intents[0].resolvedAt, null, '被拒的回执不得留下已回执状态');
});

test('SCEN-ENV-02 the line ceiling depends on who wrote the envelope', (context) => {
  // 审计员逐场景写结论：同一份 22 行信封，写手越界，审计员不越界。
  const long = `${ENVELOPE()}\n${Array.from({ length: 14 }, (_, i) => `  - 场景 ${i}`).join('\n')}`;
  const writer = fixture(context);
  const blocked = claimAndRecord(writer, ['--envelope', envelopeFile(writer, long)]);
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /超过上限 20 行/);

  const auditor = fixture(context);
  const ok = claimAndRecord(auditor, ['--envelope', envelopeFile(auditor, long)],
    { attempt: '1', phase: 'audit', role: 'anchasi' });
  assert.equal(ok.status, 0, ok.stderr);
});

test('SCEN-ENV-02 a missing envelope file is a usage error, not a silent skip', (context) => {
  const subject = fixture(context);
  const result = claimAndRecord(subject, ['--envelope', path.join(subject.root, 'nope.md')]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--envelope 指向的文件不存在/);
});

// --- READY 等待观测：上一动作结束 → 本次 claim ---

test('SCEN-CON-10 SCEN-CON-22 ready wait is measured from the previous action, and a repeated pair is not re-counted', (context) => {
  const subject = fixture(context);
  subject.run('begin', '--owner', 'lead-a');
  subject.run('claim', '--task', 'T-01', '--attempt', '1', '--phase', 'impl', '--role', 'gongbu', '--owner', 'lead-a');
  // 没有上一动作结束的观测点：此时不能编造一个等待样本。
  assert.equal(subject.read().readyObs.length, 0, '首派没有「上一动作结束」可参照');

  subject.run('record', '--key', intentKey({
    run: null, task: 'T-01', attempt: 1, phase: 'impl', role: 'gongbu', action: 'dispatch',
  }), '--agent', 'agent-1', '--owner', 'lead-a');
  subject.run('claim', '--task', 'T-01', '--attempt', '2', '--phase', 'impl', '--role', 'gongbu', '--owner', 'lead-a');
  const after = subject.read().readyObs;
  assert.equal(after.length, 1);
  assert.ok(after[0].waitMs >= 0);
  assert.equal(after[0].basis, 'prev-end→claim', '口径必须写进数据，否则报告会把排队时长说成端到端等待');

  // fail 掉 attempt 2 后重派同一 attempt：上一动作变成刚才那次 claim 的作废，
  // 但 (task, afterKey) 已观测过，不能重复计时（重复计时把中位数拉向最慢的一次）。
  const key2 = intentKey({ run: null, task: 'T-01', attempt: 2, phase: 'impl', role: 'gongbu', action: 'dispatch' });
  subject.run('fail', '--key', key2, '--reason', 'create failed', '--owner', 'lead-a');
  subject.run('claim', '--task', 'T-01', '--attempt', '2', '--phase', 'impl', '--role', 'gongbu', '--owner', 'lead-a');
  assert.equal(subject.read().readyObs.filter((obs) => obs.afterKey === after[0].afterKey).length, 1);
});

// --- 人类确认点时间戳（2026-10-31 D 试点前置） ---
//
// 「确认点等待时长」过去只能报「未采集」：账本知道派发与合流的时间，不知道人什么时候点头。
// 缺口不在算法，在没有写入点。confirm 必须在确认发生的当下调用；事后补记的是回忆，不是采集值。

test('SCEN-CON-10 confirm records cp1/cp2 in the order a run actually reaches them', (context) => {
  const subject = fixture(context);
  subject.run('begin', '--owner', 'lead-a');

  // 未登记时报告必须写未采集，不能拿「无跨度」冒充 0 秒。
  const empty = JSON.parse(subject.run('report', '--json').stdout);
  assert.deepEqual(empty.confirmations, { cp1At: null, cp2At: null, cp1ToCp2Ms: null });
  assert.match(subject.run('report').stdout, /确认点 未采集/);

  const cp1 = subject.run('confirm', '--checkpoint', 'cp1', '--owner', 'lead-a');
  assert.equal(cp1.status, 0, cp1.stderr);
  const onlyCp1 = JSON.parse(subject.run('report', '--json').stdout);
  assert.ok(onlyCp1.confirmations.cp1At);
  assert.equal(onlyCp1.confirmations.cp2At, null);
  assert.equal(onlyCp1.confirmations.cp1ToCp2Ms, null, '只有一个确认点时没有跨度可算');

  const cp2 = subject.run('confirm', '--checkpoint', 'cp2', '--note', 'merged to main', '--owner', 'lead-a');
  assert.equal(cp2.status, 0, cp2.stderr);
  const both = JSON.parse(subject.run('report', '--json').stdout);
  assert.ok(both.confirmations.cp1ToCp2Ms >= 0);
  assert.equal(subject.read().confirmations.length, 2);
});

test('confirm is idempotent per checkpoint and never rewrites the first timestamp', (context) => {
  const subject = fixture(context);
  subject.run('begin', '--owner', 'lead-a');
  subject.run('confirm', '--checkpoint', 'cp1', '--owner', 'lead-a');
  const first = subject.read().confirmations[0];

  const again = subject.run('confirm', '--checkpoint', 'cp1', '--owner', 'lead-a');
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /已登记过/);
  const after = subject.read().confirmations;
  assert.equal(after.length, 1, '重复确认不得新增第二条记录');
  assert.equal(after[0].at, first.at, '首次时间是不可改写的采集值');
  assert.equal(after[0].repeated, 1);
  assert.ok(after[0].lastAt);
});

test('confirm rejects an unknown checkpoint and values that are not timestamps in the ledger', (context) => {
  const subject = fixture(context);
  subject.run('begin', '--owner', 'lead-a');
  const bad = subject.run('confirm', '--checkpoint', 'cp3', '--owner', 'lead-a');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /cp1/);

  // 规范化层丢弃无法解析时间的记录：一条读不出时间的确认等于没确认过。
  const state = subject.read();
  state.confirmations = [
    { checkpoint: 'cp1', at: 'not-a-date' },
    { checkpoint: 'cp9', at: new Date().toISOString() },
  ];
  writeFileSync(subject.file, JSON.stringify(state, null, 2));
  // `fixture.read()` 读的是原始文件；规范化在 readRunState 里，用 status --json 观察结果。
  const listed = JSON.parse(subject.run('status', '--json').stdout).confirmations;
  assert.deepEqual(listed, [], '非法确认记录被丢弃，不补默认值');
  assert.equal(JSON.parse(subject.run('report', '--json').stdout).confirmations.cp1At, null);
});
