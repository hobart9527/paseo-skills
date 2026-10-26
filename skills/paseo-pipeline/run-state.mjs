#!/usr/bin/env node
// 轻量执行闭环入口（L4-02/L4-03/L4-04）。只读写运行账本，不碰业务代码、不碰 git 具名事实。
//
// 用法:
//   node run-state.mjs begin    <change> --owner <owner-id>
//   node run-state.mjs status   <change> [--json]
//   node run-state.mjs claim    <change> --task T-01 [--attempt 1] [--phase impl] [--role gongbu] [--action dispatch]
//   node run-state.mjs record   <change> --key <key> --agent <agent-id> [--workspace <id>] [--owner <id>]
//   node run-state.mjs fail     <change> --key <key> --reason <text> [--owner <id>]
//   node run-state.mjs heartbeat <change> --id <heartbeat-id> --action register|renew|pause|delete [--expires-at <iso>]
//
// 退出码：0 成功；2 动作被拒（重复意图、租约无效或非当前 owner、复活已作废意图）；1 用法/状态错误。
//
// 语义边界：
//   - 本账本只补「正在进行的动作」这一层事实，不是第二套任务真源。
//     任务契约在 tasks.md，已合流事实在 git first-parent 账本，Agent 事实在 Paseo。
//   - claim 只做幂等闸门，不产生任何外部副作用；副作用仍由原生 MCP 执行。
//   - 同一 run 只有一个有效 owner：租约生效期间，claim/record/fail 一律要求 `--owner` 匹配，
//     租约过期后旧 owner 的动作全部拒绝，必须显式 begin 才拿到新代际。
//   - fail 与 record 是互斥的两个终态：fail 允许同键重派（claim 复位该记录并记 retryOf），
//     record 必须带真实 agent 且不得复活已 fail 的意图。
import {
  readRunState, updateRunState, intentKey, findByKey, openIntents, leaseStatus,
  isFailed, heartbeatStatus, intentAgeMs, DEFAULT_LEASE_TTL_MS,
} from './lib/run-state.mjs';

function fail(code, message) {
  console.error(`[run-state] ${message}`);
  process.exit(code);
}

const argv = process.argv.slice(2);
const json = argv.includes('--json');
const command = argv[0];
const change = argv[1];
if (!command || !change) {
  console.error('Usage: node run-state.mjs <begin|status|claim|record|fail|heartbeat> <change> [flags]');
  process.exit(1);
}

/** 取 `--name value`，缺失返回 null。 */
function flag(name) {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : null;
}

const owner = flag('owner');
const now = new Date();
const nowIso = now.toISOString();

/**
 * 当前有效 owner 校验：无租约时放行（未启用租约的单机场景），有过期租约时拒绝。
 *
 * **有租约时 `--owner` 必填且必须匹配**：否则任何进程省略 `--owner` 就能绕过租约继续
 * claim/record/fail，单 owner 语义形同虚设（旧 Lead 复活后省略参数即可再次提交动作）。
 *
 * 返回拒绝理由（字符串）或 null。**必须在持锁的 draft 上调用**——在锁外先读一次再进锁写，
 * 比对的是一份可能已被并发持锁者推进过的旧快照，租约校验就失去意义。
 */
function ownerRefusal(draft, action) {
  const lease = leaseStatus(draft, now.getTime());
  if (!lease) return null;
  if (!lease.valid) {
    return `编排租约已过期（owner=${lease.owner} gen=${lease.generation}，到期 ${lease.expiresAt}）；`
      + `先执行 begin 领取新代际，再 ${action}`;
  }
  if (owner === null) {
    return `存在有效编排租约（owner=${lease.owner} gen=${lease.generation}）；`
      + `${action} 必须带 --owner <owner-id> 证明自己是当前编排者`;
  }
  if (owner !== lease.owner) {
    return `当前编排 owner 是 ${lease.owner}，${owner} 无权 ${action}（旧 Lead 不得继续提交动作）`;
  }
  return null;
}

/**
 * 持锁读改写，并把两种「动作被拒」统一成 exit 2：
 *   ELOCKED  另一个进程正持有账本锁（并发 claim），本次不改写任何内容；
 *   refusal  锁内发现的租约拒绝。
 */
function update(action, fn) {
  try {
    const { result } = updateRunState(change, fn);
    if (result?.refusal) fail(2, result.refusal);
    return result;
  } catch (error) {
    if (error?.code === 'ELOCKED') fail(2, `运行账本被占用，${action} 未生效：${error.message}`);
    throw error;
  }
}

switch (command) {
  case 'begin': {
    if (owner === null) fail(1, 'begin 需要 --owner <owner-id>');
    const result = update('begin', (draft) => {
      const previous = leaseStatus(draft, now.getTime());
      const expiresAt = new Date(now.getTime() + DEFAULT_LEASE_TTL_MS).toISOString();
      if (!previous || !previous.valid || previous.owner === owner) {
        draft.lease = {
          owner,
          generation: previous && previous.owner === owner ? previous.generation : (previous?.generation ?? 0) + 1,
          acquiredAt: previous && previous.valid && previous.owner === owner ? previous.acquiredAt : nowIso,
          renewedAt: nowIso,
          expiresAt,
          ttlMs: DEFAULT_LEASE_TTL_MS,
        };
        return draft.lease;
      }
      // 租约仍有效且属于别人：不抢，直接拒绝（需人工或前任显式交回）。
      return { refused: true, current: previous };
    });
    if (result.refused) {
      fail(2, `租约仍由 ${result.current.owner} 持有（到期 ${result.current.expiresAt}）；`
        + '不得抢占，等待其 renew 或超时');
    }
    console.log(json
      ? JSON.stringify({ change, lease: result, file: readRunState(change).file })
      : `[run-state] ${change} owner=${result.owner} generation=${result.generation} expiresAt=${result.expiresAt}`);
    break;
  }

  case 'status': {
    const { present, state, error, file } = readRunState(change);
    const lease = leaseStatus(state, now.getTime());
    const open = openIntents(state);
    if (json) {
      console.log(JSON.stringify({
        change, present, file, error, run: state.run, lease,
        openIntents: open, heartbeats: state.heartbeats, resolvedCount: state.intents.length - open.length,
      }, null, 2));
      break;
    }
    console.log(`[run-state] ${change} ${present ? '有记录' : '无记录'} ${file}`);
    if (error) console.log(`  WARN ${error}`);
    console.log(lease
      ? `LEASE owner=${lease.owner} gen=${lease.generation} ${lease.valid ? '有效' : '已过期'} 到期=${lease.expiresAt}`
      : 'LEASE (未启用)');
    console.log(`INTENTS 未回执 ${open.length} / 共 ${state.intents.length}`);
    for (const intent of open) {
      const age = intentAgeMs(intent, now.getTime());
      console.log(`  - ${intent.key}  ${intent.task ?? ''} ${intent.role ?? ''} 龄=${age === null ? '未采集' : `${Math.round(age / 1000)}s`}`);
    }
    for (const beat of state.heartbeats) {
      console.log(`HEARTBEAT ${beat.id} ${beat.status ?? 'unknown'} 到期=${beat.expiresAt ?? '未采集'}`);
    }
    break;
  }

  case 'claim': {
    const task = flag('task');
    if (task === null) fail(1, 'claim 需要 --task <id>');
    const attempt = flag('attempt');
    const phase = flag('phase');
    const role = flag('role');
    const action = flag('action') ?? 'dispatch';
    const result = update(`claim ${task}`, (draft) => {
      const refusal = ownerRefusal(draft, `claim ${task}`);
      if (refusal !== null) return { refusal, skipWrite: true };
      const key = intentKey({ run: draft.run ?? 'local', task, attempt, phase, role, action });
      const existing = findByKey(draft, key);
      // 已回执或仍在观察窗内的意图都拒绝重复派发：后者要等 record/fail 或超时由对账处置，
      // 否则「创建请求已发出、回执尚未返回」的窗口会被再派一次。
      if (existing && !isFailed(existing)) return { duplicate: true, existing };
      // 已显式 fail 的意图表示这次派发确认失败，按同一幂等键重派是**预期路径**，不是重复。
      // 就地复位同一条记录并留下 retryOf 链，而不是新增一条：键唯一是幂等的前提。
      if (existing) {
        const previousFailure = existing.failedAt;
        existing.createdAt = nowIso;
        existing.resolvedAt = null;
        existing.agentId = null;
        existing.workspaceId = null;
        existing.reason = null;
        delete existing.failedAt;
        existing.retryOf = previousFailure;
        return { intent: existing, retried: true };
      }
      const intent = {
        key, task, attempt: attempt === null ? null : Number(attempt), phase, role, action,
        createdAt: nowIso, resolvedAt: null, agentId: null, workspaceId: null,
      };
      draft.intents.push(intent);
      return { intent };
    });
    const key = result.intent?.key ?? result.existing?.key ?? '(unknown)';
    if (result.duplicate) {
      const existing = result.existing;
      fail(2, `动作已认领，拒绝重复派发: ${key}`
        + `${existing.agentId ? ` agent=${existing.agentId}` : '（尚未回执）'}`
        + ` 建于 ${existing.createdAt}`);
    }
    console.log(json ? JSON.stringify({ change, intent: result.intent, retried: result.retried === true })
      : `[run-state] claim ok ${key}${result.retried ? ' (retry of a failed intent)' : ''}`);
    break;
  }

  case 'record': {
    const key = flag('key');
    const agentId = flag('agent');
    if (key === null) fail(1, 'record 需要 --key <key>');
    // 回执必须携带真实 agent id：空回执关掉意图后，运行账本里就再也查不到这次派发指向谁，
    // 对账只能靠猜。宁可让调用方补参数，也不要留下无法追溯的「已回执」。
    if (agentId === null) fail(1, 'record 需要 --agent <agent-id>（回执必须登记真实 agent）');
    const workspaceId = flag('workspace');
    const result = update(`record ${key}`, (draft) => {
      const refusal = ownerRefusal(draft, `record ${key}`);
      if (refusal !== null) return { refusal, skipWrite: true };
      const intent = findByKey(draft, key);
      if (!intent) return { missing: true };
      // 已作废的意图不得靠 record 复活：作废与回执是互斥的两个终态，先 claim 再回执。
      if (isFailed(intent)) return { failed: true, failedAt: intent.failedAt };
      intent.resolvedAt = nowIso;
      intent.agentId = agentId;
      intent.workspaceId = workspaceId;
      return { intent };
    });
    if (result.missing) fail(1, `未知意图键：${key}（先 claim 再 record）`);
    if (result.failed) {
      fail(2, `意图已于 ${result.failedAt} 显式作废，不得用 record 复活：${key}（需重派请重新 claim）`);
    }
    console.log(json ? JSON.stringify({ change, intent: result.intent }) : `[run-state] record ok ${key} agent=${agentId}`);
    break;
  }

  case 'fail': {
    const key = flag('key');
    if (key === null) fail(1, 'fail 需要 --key <key>');
    const reason = flag('reason') ?? '(未提供)';
    const result = update(`fail ${key}`, (draft) => {
      const refusal = ownerRefusal(draft, `fail ${key}`);
      if (refusal !== null) return { refusal, skipWrite: true };
      const intent = findByKey(draft, key);
      if (!intent) return { missing: true };
      intent.failedAt = nowIso;
      intent.reason = reason;
      return { intent };
    });
    if (result.missing) fail(1, `未知意图键：${key}`);
    console.log(json ? JSON.stringify({ change, intent: result.intent }) : `[run-state] fail ok ${key} reason=${reason}`);
    break;
  }

  case 'heartbeat': {
    const id = flag('id');
    const action = flag('action') ?? 'register';
    if (id === null) fail(1, 'heartbeat 需要 --id <heartbeat-id>');
    const expiresAt = flag('expires-at');
    const result = update(`heartbeat ${action} ${id}`, (draft) => {
      let beat = heartbeatStatus(draft, id);
      if (!beat) {
        beat = { id, createdAt: nowIso, status: 'active', expiresAt: null };
        draft.heartbeats.push(beat);
      }
      beat.updatedAt = nowIso;
      if (action === 'register') {
        if (expiresAt === null) return { needsExpiry: true };
        beat.status = 'active';
        beat.expiresAt = expiresAt;
        beat.deletedAt = null;
      } else if (action === 'renew') {
        if (expiresAt === null) return { needsExpiry: true };
        beat.status = 'active';
        beat.expiresAt = expiresAt;
      } else if (action === 'pause') {
        beat.status = 'paused';
      } else if (action === 'delete') {
        beat.status = 'deleted';
        beat.deletedAt = nowIso;
        beat.expiresAt = null;
      } else {
        return { badAction: action };
      }
      return { beat };
    });
    if (result.needsExpiry) fail(1, `${action} 需要 --expires-at <iso>（到期不等于任务结束，但必须可判定）`);
    if (result.badAction) fail(1, `未知 heartbeat action: ${result.badAction}（register|renew|pause|delete）`);
    console.log(json ? JSON.stringify({ change, heartbeat: result.beat }) : `[run-state] heartbeat ${action} ok ${id} status=${result.beat.status}`);
    break;
  }

  default:
    fail(1, `未知命令: ${command}`);
}
