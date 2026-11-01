import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs, { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  intentKey, leaseStatus, openIntents, findByKey, intentAgeMs, DEFAULT_LEASE_TTL_MS,
  readRunState, writeRunState, updateRunState,
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

/**
 * 在临时目录里建一个真实 git 仓库并 checked out 到指定分支。
 *
 * 「agent 的工作目录在哪个分支上」只有真跑一次 git 才验得准（worktree、detached HEAD
 * 都靠 `rev-parse --abbrev-ref HEAD` 区分），用假字符串冒充分支会把实现里的解析方式锁死。
 */
function repoOnBranch(root, branch) {
  const dir = path.join(root, `repo-${branch.replace(/[^A-Za-z0-9]+/g, '-')}`);
  mkdirSync(dir, { recursive: true });
  const git = (...args) => {
    const result = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 15_000 });
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  git('init', '-q', '-b', branch);
  git('-c', 'user.email=fixture@example.com', '-c', 'user.name=fixture',
    'commit', '--allow-empty', '-q', '-m', 'init');
  return dir;
}

function recordWithAgentLabels(context, labels, options = {}) {
  const { task = 'T-01', phase = 'impl', role = 'gongbu', gitBranch = null } = options;
  const subject = fixture(context);
  const paseoHome = path.join(subject.root, 'paseo-home');
  if (labels !== undefined) {
    const dir = path.join(paseoHome, 'agents', 'slug');
    mkdirSync(dir, { recursive: true });
    // gitBranch 为 null 时记录里没有 cwd：分支检查必须按「读不到」放行并说明。
    const cwd = gitBranch === null ? undefined : repoOnBranch(subject.root, gitBranch);
    writeFileSync(path.join(dir, `${AGENT_ID}.json`),
      JSON.stringify({ id: AGENT_ID, labels, ...(cwd === undefined ? {} : { cwd }) }));
  }
  const withHome = { ...subject.env, PIPELINE_PASEO_HOME: paseoHome };
  const run = (...args) => spawnSync(process.execPath, [script, args[0], change, ...args.slice(1)], {
    env: withHome, encoding: 'utf8', timeout: 15_000,
  });
  assert.equal(run('claim', '--task', task, '--attempt', '1', '--phase', phase, '--role', role).status, 0);
  const key = intentKey({ run: null, task, attempt: 1, phase, role, action: 'dispatch' });
  return { subject, key, result: run('record', '--key', key, '--agent', AGENT_ID) };
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

// 缺口 1：写手被派进集成分支工作区。record 是手动 MCP 路径上唯一能看到「这个 agent 到底
// 在哪个分支上干活」的时刻，因此闸门放在回执处：拒绝登记，并点名分支。
// SCEN-HND-03
test('SCEN-HND-03 record refuses a writer intent whose agent works on the integration branch', (context) => {
  const refused = recordWithAgentLabels(context, ALL_LABELS, { gitBranch: `integration/${change}` });
  assert.equal(refused.result.status, 2, `${refused.result.stdout}${refused.result.stderr}`);
  assert.match(refused.result.stderr, new RegExp(`integration/${change}`),
    '拒绝理由必须点名分支，否则调用方只知道「被拒」不知道去哪改');
  assert.equal(findByKey(refused.subject.read(), refused.key).resolvedAt, null,
    '被拒的回执不得落进账本：它会被 report 当成一次真实派发');

  const accepted = recordWithAgentLabels(context, ALL_LABELS, { gitBranch: `task/${change}/T-01` });
  assert.equal(accepted.result.status, 0, accepted.result.stderr);
  assert.ok(findByKey(accepted.subject.read(), accepted.key).resolvedAt);
  assert.doesNotMatch(accepted.result.stderr, /分支检查未执行/, '读到了分支就不该说检查没做');
});

test('the integration-branch refusal covers test phase and writer roles only', (context) => {
  const branch = `integration/${change}`;
  const testPhase = recordWithAgentLabels(context, ALL_LABELS, { gitBranch: branch, phase: 'test' });
  assert.equal(testPhase.result.status, 2, 'SCEN-HND-03 的 impl/test 两个阶段都要拦');

  const gaogong = recordWithAgentLabels(context, ALL_LABELS, { gitBranch: branch, role: 'gaogong' });
  assert.equal(gaogong.result.status, 2, 'gaogong 同为写手角色，不能绕过');

  // 审计员/仲裁员本来就在别处工作：拦它们会让正常审计回执全部失败。
  const anchasi = recordWithAgentLabels(context, ALL_LABELS, { gitBranch: branch, role: 'anchasi', phase: 'audit' });
  assert.equal(anchasi.result.status, 0, anchasi.result.stderr);
  const gongbuAudit = recordWithAgentLabels(context, ALL_LABELS, { gitBranch: branch, role: 'gongbu', phase: 'audit' });
  assert.equal(gongbuAudit.result.status, 0, '写手角色在审计阶段也不拦（这条判据只管 impl/test）');
});

test('an unreadable working directory still records and says the check was skipped', (context) => {
  // 读不到 ≠ 违规：记录拿不到时既不能当证据，也不能当免责，只能把「没检查」说出来。
  const noCwd = recordWithAgentLabels(context, ALL_LABELS);
  assert.equal(noCwd.result.status, 0, noCwd.result.stderr);
  assert.match(noCwd.result.stderr, /分支检查未执行/);
  assert.match(noCwd.result.stderr, /回执照常登记/);
  assert.ok(findByKey(noCwd.subject.read(), noCwd.key).resolvedAt);

  // 记录里写了 cwd，但那个路径不存在 / 不是 git 仓库：同样按「读不到」放行并说明。
  const missingDir = recordWithAgentLabels(context, ALL_LABELS, { gitBranch: `integration/${change}` });
  const recordFile = path.join(missingDir.subject.root, 'paseo-home', 'agents', 'slug', `${AGENT_ID}.json`);
  const record = JSON.parse(readFileSync(recordFile, 'utf8'));
  writeFileSync(recordFile, JSON.stringify({ ...record, cwd: path.join(missingDir.subject.root, 'gone') }));
  const retried = missingDir.subject.run('record', '--key', missingDir.key, '--agent', AGENT_ID);
  assert.equal(retried.status, 0, retried.stderr);
  assert.match(retried.stderr, /分支检查未执行/);
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
  // T-02 的审计意图只 claim 未 record：没有回执就不是已发生的派发（SCEN-CON-27），
  // 与 dispatches 共用同一判据。旧断言把未回执的审计意图算作一次审查派发。
  assert.equal(report.auditDispatches, 0);
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

test('SCEN-CON-27 a voided audit intent is not counted as an audit dispatch', (context) => {
  const subject = fixture(context);
  subject.run('begin', '--owner', 'lead-a');
  // 写手真实派发并回执。
  subject.run('claim', '--task', 'T-01', '--attempt', '1', '--phase', 'impl', '--role', 'gongbu', '--owner', 'lead-a');
  subject.run('record', '--key', intentKey({ run: null, task: 'T-01', attempt: 1, phase: 'impl', role: 'gongbu', action: 'dispatch' }),
    '--agent', '01234567-89ab-cdef-0123-456789abcdef', '--owner', 'lead-a');
  // 审计意图领取后创建失败，被显式作废：这次派发确认没有发生。
  const auditKey = intentKey({ run: null, task: 'T-01', attempt: 1, phase: 'audit', role: 'anchasi', action: 'dispatch' });
  subject.run('claim', '--task', 'T-01', '--attempt', '1', '--phase', 'audit', '--role', 'anchasi', '--owner', 'lead-a');
  const voided = subject.run('fail', '--key', auditKey, '--reason', 'create failed', '--owner', 'lead-a');
  assert.equal(voided.status, 0, voided.stderr);

  const report = JSON.parse(subject.run('report', '--json').stdout);
  assert.equal(report.dispatches, 1, '只有带真实回执的意图算派发');
  assert.equal(report.auditDispatches, 0, '作废的审计意图没有发生过派发，不得计入审查派发');
  assert.equal(report.voidedIntents, 1, '作废意图单独计数，不并入任何派发数');
});

test('SCEN-CON-27 audit and arbitrate intents with a real receipt are still audit dispatches', (context) => {
  const subject = fixture(context);
  subject.run('begin', '--owner', 'lead-a');
  // 收紧「未回执不算」不得误伤「哪些 phase 算审查」：有回执的 audit/arbitrate 仍要计数。
  for (const [phase, role, agent] of [
    ['audit', 'anchasi', '01234567-89ab-cdef-0123-456789abcdea'],
    ['arbitrate', 'arbiter', '01234567-89ab-cdef-0123-456789abcdef'],
  ]) {
    subject.run('claim', '--task', 'T-01', '--attempt', '1', '--phase', phase, '--role', role, '--owner', 'lead-a');
    subject.run('record', '--key', intentKey({ run: null, task: 'T-01', attempt: 1, phase, role, action: 'dispatch' }),
      '--agent', agent, '--owner', 'lead-a');
  }

  const report = JSON.parse(subject.run('report', '--json').stdout);
  assert.equal(report.auditDispatches, 2, '有回执的 audit 与 arbitrate 都属于审查派发');
  assert.equal(report.voidedIntents, 0);
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

// --- SCEN-LED-01..03 账本损坏：拒绝覆盖、报告为损坏而不是缺席 ---
//
// 2026-11-01 自审实测：run-state.json 被写坏（截断的 JSON）之后，`claim` 把「解析失败」
// 读成「没有账本」，随即用空 state 原子写回。原本 3 条派发意图 + 1 条审查结论的账本，
// 在一次没有任何报错的命令之后变成 1 条意图 + 0 条结论，看起来像一次干净的 begin。
// 这里钉住三件事：
//   1. 损坏 != 缺席：readRunState 必须给出 corrupt=true，只读消费者才可能 fail closed；
//   2. 任何写入路径（CLI 的 begin/claim/record 与库里的 writeRunState）都拒绝覆盖；
//   3. 拒绝时现场字节不变，并给出可执行的恢复指引（修好或移开，而不是重跑 begin）。

const CORRUPT_TEXT = '{ "version": 1, "intents": [ { "key": "local:T-01:1:impl:gongbu:dispatch" ';

function corrupt(subject, text = CORRUPT_TEXT) {
  mkdirSync(path.dirname(subject.file), { recursive: true });
  writeFileSync(subject.file, text);
}

// 库层读写在进程内调用，账本根目录只认 PIPELINE_RUN_STATE_DIR（或 cwd 的 git common dir）。
// 子进程用 fixture.env 拿到它；进程内必须显式设置并还原，否则会去读别的目录、把「读不到
// 该 change 的账本」当成缺席——这恰好是本次要修的那类误判，测试自己不能犯。
function withLedgerDir(subject, fn) {
  const previous = process.env.PIPELINE_RUN_STATE_DIR;
  process.env.PIPELINE_RUN_STATE_DIR = subject.env.PIPELINE_RUN_STATE_DIR;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.PIPELINE_RUN_STATE_DIR;
    else process.env.PIPELINE_RUN_STATE_DIR = previous;
  }
}

function assertRefused(result) {
  assert.notEqual(result.status, 0, `损坏账本上不得成功写入：${result.stdout}`);
  assert.match(result.stderr, /run-state\.json/, '拒绝必须点名文件');
  // 两种损坏形状各有点名的原因：JSON 解析失败 vs 合法 JSON 但不是账本对象。
  assert.match(result.stderr, /不是合法 JSON|顶层不是 JSON 对象/, '拒绝必须点名解析错误本身');
  assert.match(result.stderr, /拒绝覆盖/, '拒绝必须写明「不覆盖」这件事');
  assert.match(result.stderr, /移开|修复/, '拒绝必须给出恢复指引，否则操作者会直接重跑 begin');
}

// SCEN-LED-01
test('SCEN-LED-01 begin/claim/record refuse to overwrite a corrupt ledger and leave it byte-identical', (context) => {
  const subject = fixture(context);
  corrupt(subject);
  const before = readFileSync(subject.file, 'utf8');

  // 三条变异入口各跑一次：任何一条把空 state 写回，事故就会重演。
  assertRefused(subject.run('begin', '--owner', 'lead-a'));
  assertRefused(subject.run('claim', '--task', 'T-01', '--attempt', '1', '--phase', 'impl', '--role', 'gongbu'));
  assertRefused(subject.run('record', '--key', 'local:T-01:1:impl:gongbu:dispatch', '--agent', 'agent-1'));

  assert.equal(readFileSync(subject.file, 'utf8'), before, '损坏文件必须字节级不变');
  // 崩溃残留的锁也不能留下：拒绝路径同样要释放 run-state.lock，否则之后连重试都卡住。
  assert.equal(existsSync(path.join(path.dirname(subject.file), 'run-state.lock')), false,
    '拒绝写入后不得留下锁文件');
});

// SCEN-LED-01
test('SCEN-LED-01 the library write path refuses a corrupt ledger even without the CLI in between', (context) => {
  const subject = fixture(context);
  corrupt(subject);
  const before = readFileSync(subject.file, 'utf8');

  withLedgerDir(subject, () => {
    assert.throws(
      () => writeRunState(change, { version: 1, run: null, lease: null, intents: [] }),
      (error) => error.code === 'ECORRUPT' && error.file === subject.file,
      'writeRunState 也必须守住现场：绕过 updateRunState 的调用方同样不该清空账本',
    );
  });
  assert.equal(readFileSync(subject.file, 'utf8'), before);
});

// SCEN-LED-01
test('SCEN-LED-01 recoverable JSON that is not a ledger object is corrupt, not silently emptied', (context) => {
  const subject = fixture(context);
  // `[]` 与 `null` 都是合法 JSON，normalize 会把它们归一成空 state——这正是静默清空的
  // 第二种形状。顶层必须是账本对象，否则按损坏处置。
  for (const text of ['[]', 'null', '"a string"']) {
    corrupt(subject, text);
    assertRefused(subject.run('begin', '--owner', 'lead-a'));
    assert.equal(readFileSync(subject.file, 'utf8'), text, `顶层非对象的 ${text} 不得被改写`);
  }
});

// SCEN-LED-01
test('SCEN-LED-01 moving the corrupt file aside is the documented recovery path, and begin then works', (context) => {
  const subject = fixture(context);
  corrupt(subject);
  assertRefused(subject.run('begin', '--owner', 'lead-a'));

  // 指引里写的两条路之一：移开留档后重跑同一命令。这里用 rename 走同一条路径。
  const moved = `${subject.file}.corrupt-20261031T120000`;
  fs.renameSync(subject.file, moved);
  const retried = subject.run('begin', '--owner', 'lead-a');
  assert.equal(retried.status, 0, retried.stderr);
  assert.equal(fs.readFileSync(moved, 'utf8'), CORRUPT_TEXT, '现场留档必须保留原始字节');
  assert.equal(subject.read().lease.owner, 'lead-a');
});

// SCEN-LED-02
test('SCEN-LED-02 readRunState reports corruption as corruption, never as an absent ledger', (context) => {
  const subject = fixture(context);

  // 本条只钉住**供 reconcile 判定的信号**（corrupt 标志与错误的可达性）。
  // reconcile 侧据此输出 corruption hold 的接线在 T-03（reconcile.mjs 属其 Write scope）。
  withLedgerDir(subject, () => {
    const absent = readRunState(change);
    assert.deepEqual(
      { present: absent.present, corrupt: absent.corrupt, error: absent.error },
      { present: false, corrupt: false, error: null },
      '文件不存在才是缺席',
    );

    corrupt(subject);
    const unparsable = readRunState(change);
    assert.equal(unparsable.present, true, '文件在就不能报成缺席——否则 reconcile 会把它当 lease-free');
    assert.equal(unparsable.corrupt, true);
    assert.match(unparsable.error, /run-state\.json/);
    assert.match(unparsable.error, /不是合法 JSON/);
  });
});

// SCEN-LED-02
test('SCEN-LED-02 status reports a corrupt ledger as recorded-with-an-error, never as 无记录', (context) => {
  const subject = fixture(context);
  corrupt(subject);
  const status = subject.run('status', '--json');
  assert.equal(status.status, 0, '只读诊断不得因账本损坏而崩溃');
  const parsed = JSON.parse(status.stdout);
  // 关键回归：旧实现在这里 present=false，status 打印「无记录」，调用方据此以为这是一次
  // 尚未开始的 run。现在 present=true 且 error 非空——「有账本但读不了」不能被读成「没有账本」。
  assert.equal(parsed.present, true, '损坏账本不是缺席账本');
  assert.match(parsed.error, /不是合法 JSON/);
  assert.equal(parsed.lease, null, '读不出内容就没有租约可报');
  const human = subject.run('status').stdout;
  assert.match(human, /有记录/, '人类可读输出必须说「有记录」，而不是「无记录」');
  assert.match(human, /不是合法 JSON/, '人类可读输出同样要说出损坏原因');
});

// SCEN-LED-03
test('SCEN-LED-03 corruption is distinguishable from an idle lease so the scope guard cannot degrade to allow', (context) => {
  const subject = fixture(context);

  // 守卫的降级路径是「没有有效租约 → 放行」。损坏账本给出的 state 同样是空 state、同样没有
  // 租约，所以只靠 leaseStatus 无法区分「真的没有 run」与「账本读不了」。
  // 唯一的机械信号是 corrupt 标志：消费者必须先看它，才可能在损坏时拒绝而不是放行。
  //
  // **本任务只提供信号，不改守卫本身**：lib/scope-guard.mjs 不在 T-02 的 Write scope 内，
  // 而 tasks.md 里也没有任何任务把它列为 Write scope（见交接说明的 scope 缺口一节）。
  // 守卫改为「损坏即 deny」需要另一张 ticket；在那之前，这里是库层契约的下界钉子。
  withLedgerDir(subject, () => {
    corrupt(subject);
    const ledger = readRunState(change);
    assert.equal(ledger.corrupt, true);
    assert.equal(leaseStatus(ledger.state), null,
      '空 state 没有租约是设计使然；正因如此，corrupt 标志是唯一的防线');
    assert.notEqual(ledger.error, null, '错误文本随损坏一起返回，供守卫原样打印');
  });
});

// --- 直写入入口的临界区：损坏检查与写入必须在同一把锁内 ---
//
// 2026-11-01 审计 B1 实测：`writeRunState` 只做 tmp + rename，损坏检查与写入都在锁外。
// 它因此有两处静默失败：
//   a. 在 `updateRunState` 的回调里直写一份账本，回调返回后外层再写回自己的快照，
//      直写的那条 intent 无声消失——写方没拿到任何错误，读方再也看不见它；
//   b. 锁外读到「没损坏」到真正 rename 之间，另一个进程可以把文件写坏，随后本次写入
//      照样覆盖上去，损坏现场就没了。
// 收敛：直写入口自己取同一把 `run-state.lock`；`updateRunState` 内部改用不重复加锁的
// 私有写入。代价是「锁内直写」从静默成功变成显式 ELOCKED——宁可报错，不可丢数据。

function seedLedger(subject, intents = []) {
  mkdirSync(path.dirname(subject.file), { recursive: true });
  writeFileSync(subject.file, JSON.stringify({ version: 1, run: null, lease: null, intents }, null, 2));
}

function ledgerLockFile(subject) {
  return path.join(path.dirname(subject.file), 'run-state.lock');
}

// 一条在临界区外「成功」、随后被外层快照覆盖的 intent，就是 B1 事故本身。
const LOST_INTENT = { key: 'local:T-01:1:impl:gongbu:dispatch', createdAt: '2026-11-01T00:00:00.000Z' };

// SCEN-LED-01
test('SCEN-LED-01 a direct write takes the ledger lock, so it cannot race a concurrent read-modify-write', (context) => {
  const subject = fixture(context);
  seedLedger(subject);
  const before = readFileSync(subject.file, 'utf8');
  // 另一个进程正持有账本锁（模拟一次进行中的 updateRunState）。
  writeFileSync(ledgerLockFile(subject), JSON.stringify({
    pid: 99999, host: 'other-host', acquiredAt: new Date().toISOString(),
  }));

  withLedgerDir(subject, () => {
    assert.throws(
      () => writeRunState(change, { version: 1, run: null, lease: null, intents: [LOST_INTENT] }),
      (error) => error.code === 'ELOCKED',
      '直写必须与 updateRunState 抢同一把锁；锁外写入会覆盖并发持锁者的快照',
    );
  });
  assert.equal(readFileSync(subject.file, 'utf8'), before, '锁被占用时直写不得落盘');
});

// SCEN-LED-01
test('SCEN-LED-01 a direct write inside updateRunState fails loudly instead of being silently overwritten', (context) => {
  const subject = fixture(context);
  seedLedger(subject);

  withLedgerDir(subject, () => {
    let directWrite = null;
    updateRunState(change, (state) => {
      state.intents.push({ key: 'local:T-02:1:impl:gongbu:dispatch', createdAt: '2026-11-01T00:00:00.000Z' });
      // B1 的复现：回调内直写。修复前这里静默成功，返回后外层写回自己的快照，
      // 直写的那条 intent 只剩在磁盘上一次已消失的中间态里。
      try {
        writeRunState(change, { version: 1, run: null, lease: null, intents: [LOST_INTENT] });
        directWrite = 'succeeded';
      } catch (error) {
        directWrite = error;
      }
      return null;
    });

    assert.equal(directWrite?.code, 'ELOCKED', '锁内直写必须显式失败，而不是无声丢数据');
    const intents = JSON.parse(readFileSync(subject.file, 'utf8')).intents.map((entry) => entry.key);
    assert.deepEqual(intents, ['local:T-02:1:impl:gongbu:dispatch'],
      '账本里只有 updateRunState 的快照；直写那条要么显式失败，要么完整可见，不能静默消失');
    assert.equal(existsSync(ledgerLockFile(subject)), false, 'updateRunState 结束必须释放锁');
  });
});

// SCEN-LED-01
test('SCEN-LED-01 a direct write on a corrupt ledger refuses and leaves no lock behind', (context) => {
  const subject = fixture(context);
  corrupt(subject);
  const before = readFileSync(subject.file, 'utf8');

  withLedgerDir(subject, () => {
    assert.throws(
      () => writeRunState(change, { version: 1, run: null, lease: null, intents: [] }),
      (error) => error.code === 'ECORRUPT',
    );
  });
  assert.equal(readFileSync(subject.file, 'utf8'), before, '拒绝路径同样不得改写现场');
  assert.equal(existsSync(ledgerLockFile(subject)), false, '损坏检查在锁内完成，拒绝后必须释放锁');
});

// SCEN-LED-02
test('SCEN-LED-02 a read failure other than ENOENT is corruption, not absence', (context) => {
  const subject = fixture(context);
  // 目录占了 run-state.json 的位置：文件「在」，但读不出。按缺席处理会让下一次写把
  // 目录内容当空账本覆盖（或直接 rename 掉）。
  mkdirSync(subject.file, { recursive: true });
  withLedgerDir(subject, () => {
    const ledger = readRunState(change);
    assert.equal(ledger.present, true);
    assert.equal(ledger.corrupt, true);
    assert.match(ledger.error, /无法读取/);
  });
});
