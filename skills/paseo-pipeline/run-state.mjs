#!/usr/bin/env node
// 轻量执行闭环入口（L4-02/L4-03/L4-04）。只读写运行账本，不碰业务代码、不碰 git 具名事实。
//
// 用法:
//   node run-state.mjs begin    <change> --owner <owner-id>
//   node run-state.mjs status   <change> [--json]
//   node run-state.mjs report   <change> [--json]
//   node run-state.mjs claim    <change> --task T-01 [--attempt 1] [--phase impl] [--role gongbu] [--action dispatch]
//   node run-state.mjs record   <change> --key <key> --agent <agent-id> [--workspace <id>] [--owner <id>] [--envelope <file>]
//   node run-state.mjs fail     <change> --key <key> --reason <text> [--owner <id>]
//   node run-state.mjs review   <change> --task T-01 [--attempt 1] [--round 1] --verdict PASS|PASS_WITH_NITS|BLOCK --agent <id> [--sha <sha>] [--owner <id>]
//   node run-state.mjs merge    <change> --task T-01 --sha <merge-sha> [--attempt 1] [--review-tag <tag>]
//   node run-state.mjs confirm  <change> --checkpoint cp1|cp2 [--note <text>] [--owner <id>]
//
// 无 heartbeat 子命令：SKILL 已声明常规运行不建周期性 heartbeat，2026-10-26 的
// `hardening-governance-contracts` 账本里 heartbeats 为 0，注册入口没有使用者。
// 账本里的 `heartbeats` 字段保留为只读兼容（旧文件仍可读，`status` 仍打印），
// 但没有写入路径——要恢复注册语义必须先有可证伪的唤醒来源。
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
  isFailed, intentAgeMs, DEFAULT_LEASE_TTL_MS,
} from './lib/run-state.mjs';
import { normalizePhase } from './lib/roles.mjs';
import { findAgentRecord } from './lib/paseo-state.mjs';
import { changeIdProblem } from './lib/change-id.mjs';
import {
  validateEnvelope, ENVELOPE_MAX_LINES, ENVELOPE_MAX_LINES_AUDIT,
} from './lib/envelope.mjs';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * 当前 Skill 的 git 身份。读不到就返回 null——**不猜、不伪造**。
 *
 * 只用于「这批任务是用哪份编排逻辑跑出来的」留痕与不一致提示。版本不一致时不拦，
 * 因为拦会让一台机器上升级 Skill 后的每一次诊断都失败；但静默不记会让复盘无从判断
 * 某条规则在当时是否存在。
 *
 * 采集失败必须**当场说出来**（`begin` 那侧打印一行 note）：写进账本的 `skill: null`
 * 与「没采过」在文件里长得一模一样，事后无法区分。留痕字段的价值全在「知道它是缺的」，
 * 一个不声不响写进去的 null 只是让账本看起来字段齐备。
 */
function captureSkill() {
  const git = (args) => execFileSync('git', ['-C', SKILL_DIR, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000,
  }).trim();
  try {
    const head = git(['rev-parse', 'HEAD']);
    if (!/^[0-9a-f]{40}$/.test(head)) return null;
    const dirty = git(['status', '--porcelain', '--', SKILL_DIR]) !== '';
    return { head, dirty, dir: SKILL_DIR, at: new Date().toISOString() };
  } catch {
    return null;
  }
}

function fail(code, message) {
  console.error(`[run-state] ${message}`);
  process.exit(code);
}

const REQUIRED_LABELS = ['pipeline.change', 'pipeline.task', 'pipeline.attempt', 'pipeline.phase', 'pipeline.role'];

const argv = process.argv.slice(2);
const json = argv.includes('--json');
const command = argv[0];
const change = argv[1];
if (!command || !change) {
  console.error('Usage: node run-state.mjs <begin|status|report|claim|record|fail|review|merge|confirm> <change> [flags]');
  process.exit(1);
}
// change 名必须是位置参数形态：把 `--change` 这类旗标当成 change 会静默新建一份游离账本
// （实测 approval-hub 已因此产生 `--change/`、`--key/` 两份 run-state.json，前者还持有租约）。
const changeProblem = changeIdProblem(change);
if (changeProblem !== null) fail(1, `${changeProblem}\n正确写法：node run-state.mjs ${command} <change> [--flags]`);

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
    let skillUncaptured = false;
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
        // 领取新代际时记录本次编排使用的 Skill 版本（覆盖上一次：账本属于当前 run）。
        draft.skill = captureSkill();
        if (draft.skill === null) skillUncaptured = true;
        return draft.lease;
      }
      // 租约仍有效且属于别人：不抢，直接拒绝（需人工或前任显式交回）。
      return { refused: true, current: previous };
    });
    if (result.refused) {
      fail(2, `租约仍由 ${result.current.owner} 持有（到期 ${result.current.expiresAt}）；`
        + '不得抢占，等待其 renew 或超时');
    }
    if (skillUncaptured) {
      // 不拦（旧账本、无 git 的部署都该能 begin），但必须让采集失败可见：
      // 写进账本的 skill:null 与「从没采过」在文件里长得一样，事后无法区分。
      console.error('[run-state] WARN Skill 版本未采集（读不到 git HEAD）：本账本将无法回答「这批任务由哪份编排逻辑产生」');
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
        openIntents: open, heartbeats: state.heartbeats, confirmations: state.confirmations,
        resolvedCount: state.intents.length - open.length,
      }, null, 2));
      break;
    }
    console.log(`[run-state] ${change} ${present ? '有记录' : '无记录'} ${file}`);
    if (error) console.log(`  WARN ${error}`);
    console.log(lease
      ? `LEASE owner=${lease.owner} gen=${lease.generation} ${lease.valid ? '有效' : '已过期'} 到期=${lease.expiresAt}`
      : 'LEASE (未启用)');
    console.log(`INTENTS 未回执 ${open.length} / 共 ${state.intents.length}`);
    console.log(state.confirmations.length === 0
      ? 'CONFIRM 未登记（cp1 = spec 冻结，cp2 = 合入主干）'
      : `CONFIRM ${state.confirmations.map((entry) => `${entry.checkpoint}=${entry.at}`).join(' ')}`);
    // 版本漂移只警告，不拦：一台机器升级 Skill 之后，旧账本仍然应该可读。
    // 但「这批任务是用哪份编排逻辑跑出来的」不能默默丢掉，否则复盘无法判断规则是否存在。
    if (state.skill) {
      const current = captureSkill();
      const drift = current !== null && current.head !== state.skill.head;
      console.log(`SKILL head=${state.skill.head.slice(0, 7)}${state.skill.dirty ? ' (dirty)' : ''}`
        + `${drift ? `  ⚠ 与当前 ${current.head.slice(0, 7)} 不同：本账本的动作由旧版编排逻辑产生` : ''}`);
    } else {
      console.log('SKILL 未采集（账本无版本记录，可能是旧代际开始）');
    }
    for (const intent of open) {
      const age = intentAgeMs(intent, now.getTime());
      console.log(`  - ${intent.key}  ${intent.task ?? ''} ${intent.role ?? ''} 龄=${age === null ? '未采集' : `${Math.round(age / 1000)}s`}`);
    }
    for (const beat of state.heartbeats) {
      console.log(`HEARTBEAT ${beat.id} ${beat.status ?? 'unknown'} 到期=${beat.expiresAt ?? '未采集'}`);
    }
    break;
  }

  case 'report': {
    // 度量只从账本里**已经记下的时间戳**推导，采不到就写「未采集」。
    // 不估算、不用文件时间戳冒充事件时间：一份看起来精确的估算比「未采集」更有害，
    // 它会被当成实测值写进复盘。
    const { present, state, error, file } = readRunState(change);
    const dispatches = state.intents.filter((intent) => typeof intent.agentId === 'string' && intent.agentId !== '');
    const perTask = new Map();
    for (const intent of dispatches) {
      const task = intent.task ?? '(unknown)';
      if (!perTask.has(task)) perTask.set(task, []);
      perTask.get(task).push(intent);
    }
    const attempts = [...perTask.values()].map((list) =>
      Math.max(...list.map((intent) => (Number.isFinite(intent.attempt) ? intent.attempt : 0))));
    const auditRounds = state.intents.filter((intent) => {
      const p = normalizePhase(intent.phase);
      return p === 'audit' || p === 'arbitrate';
    });

    // --- 首次通过率：只数「审计结论」这一层，不数派发次数 ---
    //
    // 判据是 reviews[] 里每个任务**首轮**（round 最小）的 verdict。首轮 PASS 即一次通过；
    // 首轮 BLOCK 即需要返工。分母是「有审计结论的任务数」，不是派发数——
    // 用派发数做分母会让「同一任务多派几次」看起来像「多个任务失败了」。
    const firstRound = new Map();
    for (const review of state.reviews) {
      const round = Number.isFinite(review.round) ? review.round : 1;
      const current = firstRound.get(review.task);
      if (current === undefined || round < current.round) firstRound.set(review.task, { round, verdict: review.verdict });
    }
    // 没有审计结论的任务不计入分母（那是「未采集」，不是「通过」）。
    const auditedTasks = firstRound.size;
    const firstPassTasks = [...firstRound.values()].filter((entry) => entry.verdict === 'PASS').length;
    const firstPassRate = auditedTasks > 0 ? Math.round((firstPassTasks / auditedTasks) * 1000) / 1000 : null;

    // --- READY 等待：上一动作结束 → 本次派发 ---
    //
    // 这是账本能独立算出的「排队时长」，与「任务何时变成 READY」的严格定义差一步：
    // 依赖解除的时刻账本不一定知道（依赖可能是在别处被合流的）。因此如实标出口径，
    // 不冒充 end-to-end 的 READY 等待。
    const waits = state.readyObs.map((entry) => entry.waitMs).filter((v) => Number.isFinite(v) && v >= 0);
    waits.sort((a, b) => a - b);
    const readyWait = {
      samples: waits.length,
      medianMs: waits.length > 0 ? waits[Math.floor(waits.length / 2)] : null,
      maxMs: waits.length > 0 ? waits[waits.length - 1] : null,
      basis: '上一动作结束(resolvedAt/failedAt) → 本次 claim',
    };

    const report = {
      change,
      present,
      file,
      error,
      dispatches: dispatches.length,
      tasksDispatched: perTask.size,
      maxAttempt: attempts.length > 0 ? Math.max(...attempts) : null,
      voidedIntents: state.intents.filter((intent) => isFailed(intent)).length,
      auditDispatches: auditRounds.length,
      // 实测算出的三项：有数据才给值，没有就是 null（打印成「未采集」）。
      auditedTasks,
      firstPassTasks,
      firstPassRate,
      mergedTasks: state.merges.length,
      readyWait,
      // 确认点：只回显账本里记下的时间，不推算「本该多早」。两者都齐才给 CP-1→CP-2 跨度。
      confirmations: (() => {
        const cp1 = state.confirmations.find((entry) => entry.checkpoint === 'cp1') ?? null;
        const cp2 = state.confirmations.find((entry) => entry.checkpoint === 'cp2') ?? null;
        const span = cp1 && cp2 ? Date.parse(cp2.at) - Date.parse(cp1.at) : null;
        return {
          cp1At: cp1 ? cp1.at : null,
          cp2At: cp2 ? cp2.at : null,
          cp1ToCp2Ms: Number.isFinite(span) && span >= 0 ? span : null,
        };
      })(),
    };
    if (json) {
      console.log(JSON.stringify(report, null, 2));
      break;
    }
    console.log(`[run-state] ${change} 报告 ${present ? file : '（无账本）'}`);
    if (error) console.log(`  WARN ${error}`);
    console.log(`派发 ${report.dispatches} 次 / ${report.tasksDispatched} 个任务`);
    console.log(`同任务最大 attempt ${report.maxAttempt ?? '无派发'}`);
    console.log(`审查派发 ${report.auditDispatches} 次；作废意图 ${report.voidedIntents} 条`);
    console.log(auditedTasks > 0
      ? `首次通过率 ${firstPassTasks}/${auditedTasks}（${(firstPassRate * 100).toFixed(1)}%）；作废与仲裁不计入分母`
      : '首次通过率 未采集（账本没有任何 review 记录；用 run-state.mjs review 登记审计结论）');
    console.log(waits.length > 0
      ? `READY 等待 中位 ${Math.round(readyWait.medianMs / 1000)}s / 最大 ${Math.round(readyWait.maxMs / 1000)}s（${waits.length} 个样本，口径：${readyWait.basis}）`
      : `READY 等待 未采集（口径：${readyWait.basis}；需至少一次 claim 发生在上一动作结束之后）`);
    console.log(`已合流任务 ${state.merges.length} 个（由 merge-task.mjs 写入）`);
    const cp = report.confirmations;
    console.log(cp.cp1ToCp2Ms !== null
      ? `确认点 cp1=${cp.cp1At} → cp2=${cp.cp2At}（跨度 ${Math.round(cp.cp1ToCp2Ms / 1000)}s）`
      : `确认点 未采集（cp1=${cp.cp1At ?? '未登记'}，cp2=${cp.cp2At ?? '未登记'}；`
        + '确认发生的那一刻用 run-state.mjs confirm 登记，事后补记的时间是回忆不是采集值）');
    break;
  }

  case 'claim': {
    const task = flag('task');
    if (task === null) fail(1, 'claim 需要 --task <id>');
    const attempt = flag('attempt');
    const phase = flag('phase');
    const role = flag('role');
    const action = flag('action') ?? 'dispatch';
    // 意图键 = run:task:attempt:phase:role:action。缺任何一段都会落成 `-` 占位的脏键，
    // 而 reconcile 与 report 都按这些字段归因（真实账本里出现过 `local:T-06:-:-:-:dispatch`）。
    const missing = [['--attempt', attempt], ['--phase', phase], ['--role', role]]
      .filter(([, value]) => value === null || value === '').map(([name]) => name);
    if (missing.length > 0) {
      fail(1, `claim 缺少 ${missing.join(' ')}：意图键必须完整（--task --attempt --phase --role），否则对账无法归因`);
    }
    if (!/^[1-9][0-9]*$/.test(attempt)) fail(1, `claim --attempt 必须是正整数，收到 ${attempt}`);
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
      // --- READY 等待观测：上一动作结束 → 本次 claim ---
      //
      // 口径必须写死在数据里（basis 字段），否则报告读出来的「等待 4 分钟」会被当成
      // end-to-end 的 READY 时间：依赖解除的时刻账本并不总是知道（依赖可能在别处合流）。
      // 只取同一任务的上一条已了结意图，且只在它之后没有更晚的观测点时记录，
      // 避免同一对相邻动作被重复计时（重复计时会把中位数拉向最慢的那次）。
      const ended = draft.intents
        .filter((other) => other !== intent && other.task === task)
        .map((other) => ({ at: other.resolvedAt ?? other.failedAt, key: other.key }))
        .filter((entry) => typeof entry.at === 'string');
      if (ended.length > 0) {
        ended.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
        const lastEnded = ended[0];
        const lastMs = Date.parse(lastEnded.at);
        const nowMs = Date.parse(nowIso);
        if (Number.isFinite(lastMs) && Number.isFinite(nowMs) && nowMs >= lastMs) {
          const alreadyObserved = draft.readyObs.some((obs) => obs.task === task && obs.afterKey === lastEnded.key);
          if (!alreadyObserved) {
            draft.readyObs.push({
              task, afterKey: lastEnded.key, at: nowIso, waitMs: nowMs - lastMs, basis: 'prev-end→claim',
            });
          }
        }
      }
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
    // --envelope <file>：把子 Agent 的阶段信封交给机器校验。
    // 信封过去完全不被解析，于是漏字段、自相矛盾、超行的信封在账本上毫无痕迹。
    // 校验不过即拒绝回执（exit 2）：回执是账本里「这次派发产出了什么」的唯一入口，
    // 让它带着一份结构不合格的信封通过，等于把下游所有判断重新推回自由心证。
    const envelopeFile = flag('envelope');
    let envelope = null;
    if (envelopeFile !== null) {
      if (!fs.existsSync(envelopeFile)) fail(1, `--envelope 指向的文件不存在：${envelopeFile}`);
      const text = fs.readFileSync(envelopeFile, 'utf8');
      const roleForLimit = flag('role');
      const maxLines = roleForLimit === 'anchasi' || roleForLimit === 'hanlin'
        ? ENVELOPE_MAX_LINES_AUDIT : ENVELOPE_MAX_LINES;
      envelope = validateEnvelope(text, { maxLines });
      if (envelope.problems.length > 0) {
        fail(2, `信封结构不合格，拒绝回执：\n${envelope.problems.map((p) => `  - ${p}`).join('\n')}\n`
          + '（信封格式见 templates/writer.md 与 SKILL 的「信封规范」）');
      }
    }
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
      if (envelope !== null) {
        // 只留字段快照，不留原文：原文可能很长，账本是状态不是日志。
        intent.envelope = Object.fromEntries(envelope.fields);
      }
      return { intent };
    });
    if (result.missing) fail(1, `未知意图键：${key}（先 claim 再 record）`);
    if (result.failed) {
      fail(2, `意图已于 ${result.failedAt} 显式作废，不得用 record 复活：${key}（需重派请重新 claim）`);
    }
    // 派发标签自检：五个 pipeline.* 标签是 reconcile 归属、cap 计数的唯一依据，也是
    // ~/.claude/hooks/write-guard.py 识别「Paseo 派生 agent」的依据——漏打标签的写手既会被判
    // UNMAPPED，也会在无人可回复的 write-guard 首写拦截上永久卡死。
    // 只告警不拒绝：record 发生在 create_agent 之后，拒绝回执改变不了 agent 已经建成的事实，
    // 只会让它在账本上失联。读不到记录（Paseo 目录不存在）时不发声，不当成缺标签。
    const created = findAgentRecord(agentId);
    if (created !== null) {
      const absent = REQUIRED_LABELS.filter((name) => {
        const value = created.labels?.[name];
        return typeof value !== 'string' || value === '';
      });
      if (absent.length > 0) {
        console.error(`[run-state] WARN agent ${agentId} 缺派发标签：${absent.join(', ')}。`
          + '它会被 reconcile 判 UNMAPPED，且 write-guard 不会把它当派生 agent 豁免（首写即被拦、无人可回复）。'
          + '请 archive 该 agent，用齐全标签重新 claim/派发。');
      }
    }
    console.log(json ? JSON.stringify({ change, intent: result.intent, envelope: envelope?.fields.size ?? null })
      : `[run-state] record ok ${key} agent=${agentId}${envelope ? ` envelope=${envelope.lines}行/${envelope.fields.size}字段` : ''}`);
    break;
  }

  /**
   * review：登记审计结论。
   *
   * 为什么单独一个子命令而不是从信封里顺手取：信封的 `verdict` 是审计员的话，
   * 一次通过率要的是**可计数的结论 + 能对上的人**。把结论写进 reviews[] 之后，
   * `report` 才能算出分母与分子；否则「首次通过率」永远是「未采集」。
   *
   * 不做自动推导：本命令不读 Paseo 离线状态，只登记调用者声明的事实。
   * 事实是否成立由 merge-task 的 reviewer 交叉核对与 check-evidence 的 verdict 校验各自把关。
   */
  case 'review': {
    const task = flag('task');
    if (task === null) fail(1, 'review 需要 --task <id>');
    const verdict = flag('verdict');
    if (verdict === null) fail(1, 'review 需要 --verdict PASS|PASS_WITH_NITS|BLOCK');
    const normalizedVerdict = verdict.toUpperCase();
    if (!['PASS', 'PASS_WITH_NITS', 'BLOCK'].includes(normalizedVerdict)) {
      fail(1, `--verdict 取值未知：${verdict}（PASS/PASS_WITH_NITS/BLOCK）`);
    }
    const agentId = flag('agent');
    if (agentId === null) fail(1, 'review 需要 --agent <reviewer-agent-id>（结论必须能对上人）');
    const attemptRaw = flag('attempt');
    const roundRaw = flag('round');
    const attempt = attemptRaw === null ? null : Number(attemptRaw);
    const round = roundRaw === null ? null : Number(roundRaw);
    if (attempt !== null && (!Number.isInteger(attempt) || attempt <= 0)) fail(1, `--attempt 必须是正整数：${attemptRaw}`);
    if (round !== null && (!Number.isInteger(round) || round <= 0)) fail(1, `--round 必须是正整数：${roundRaw}`);
    const sha = flag('sha');
    const result = update(`review ${task}`, (draft) => {
      const refusal = ownerRefusal(draft, `review ${task}`);
      if (refusal !== null) return { refusal, skipWrite: true };
      // 幂等：同一 (task, attempt, round) 只保留一条，后写覆盖先写（复核会比首轮更晚到，
      // 但同一轮次的结论不该有两条——两条会让「首轮结论」变成随机取自其中一条）。
      const existing = draft.reviews.find((entry) => entry.task === task
        && (entry.attempt ?? null) === attempt && (entry.round ?? 1) === (round ?? 1));
      const record = {
        task, attempt, round: round ?? 1, verdict: normalizedVerdict, agentId,
        sha: sha ?? null, at: nowIso,
      };
      if (existing) {
        Object.assign(existing, record);
        return { review: existing, replaced: true };
      }
      draft.reviews.push(record);
      return { review: record };
    });
    console.log(json ? JSON.stringify({ change, review: result.review, replaced: result.replaced === true })
      : `[run-state] review ok ${task} attempt=${attempt ?? '-'} round=${result.review.round} verdict=${normalizedVerdict}`);
    break;
  }

  /**
   * merge：登记合流事实。
   *
   * 由 merge-task.mjs 在提交成功后调用，不是给人手敲的。写在这里而不是让报告去反推 git，
   * 是因为账本要回答的是「这个 change 的哪些任务被合流过、用哪次审查合的」，而这个映射
   * 只有合流那一刻知道（Done 行只有 source/review，没有任务与 attempt 的对应）。
   */
  case 'merge': {
    const taskIds = flag('task');
    if (taskIds === null) fail(1, 'merge 需要 --task <id[,id...]>');
    const sha = flag('sha');
    if (sha === null) fail(1, 'merge 需要 --sha <merge-sha>');
    const attemptRaw = flag('attempt');
    const attempt = attemptRaw === null ? null : Number(attemptRaw);
    const reviewTag = flag('review-tag');
    const tasks = taskIds.split(',').map((id) => id.trim()).filter(Boolean);
    if (tasks.length === 0) fail(1, '--task 不能为空');
    const result = update(`merge ${tasks.join(',')}`, (draft) => {
      const refusal = ownerRefusal(draft, `merge ${tasks.join(',')}`);
      if (refusal !== null) return { refusal, skipWrite: true };
      const recorded = [];
      for (const task of tasks) {
        const existing = draft.merges.find((entry) => entry.task === task && entry.sha === sha);
        if (existing) { recorded.push(existing); continue; }
        const entry = { task, sha, attempt, reviewTag: reviewTag ?? null, at: nowIso };
        draft.merges.push(entry);
        recorded.push(entry);
      }
      return { merges: recorded };
    });
    console.log(json ? JSON.stringify({ change, merges: result.merges })
      : `[run-state] merge ok ${tasks.join(',')} sha=${sha}`);
    break;
  }

  /**
   * confirm：登记人类确认点真正发生的时间（CP-1 冻结 / CP-2 合入主干）。
   *
   * 为什么需要它：`report` 里「确认点等待时长」过去只能写「未采集」，因为账本只知道
   * 派发与合流什么时候发生，不知道人是什么时候点头的。缺口不是算法问题，是**没有人写这一笔**。
   * 这一笔必须在确认发生的那一刻写，事后补记的时间是回忆，不是采集值。
   *
   * 同一 checkpoint 重复登记按幂等处理：保留首次时间并记 `repeated` 次数——真实流程里
   * 「再次确认」往往意味着冻结被推翻，覆盖时间会让等待时长永远看起来很短。
   */
  case 'confirm': {
    const checkpoint = flag('checkpoint');
    if (checkpoint === null) fail(1, 'confirm 需要 --checkpoint cp1|cp2');
    const normalized = checkpoint.toLowerCase();
    if (normalized !== 'cp1' && normalized !== 'cp2') {
      fail(1, `--checkpoint 取值未知：${checkpoint}（cp1 = spec 冻结，cp2 = 合入主干）`);
    }
    const note = flag('note');
    const result = update(`confirm ${normalized}`, (draft) => {
      const refusal = ownerRefusal(draft, `confirm ${normalized}`);
      if (refusal !== null) return { refusal, skipWrite: true };
      const existing = draft.confirmations.find((entry) => entry.checkpoint === normalized);
      if (existing) {
        existing.repeated = (Number.isInteger(existing.repeated) ? existing.repeated : 0) + 1;
        existing.lastAt = nowIso;
        return { entry: existing, repeated: true, firstAt: existing.at };
      }
      const entry = { checkpoint: normalized, at: nowIso, note: note ?? null };
      draft.confirmations.push(entry);
      return { entry, repeated: false };
    });
    console.log(json
      ? JSON.stringify({ change, confirmation: result.entry, repeated: result.repeated })
      : `[run-state] confirm ${normalized} at=${result.entry.at}`
        + (result.repeated ? `（已登记过，首次 ${result.firstAt}；本次只记重复次数，不改首次时间）` : ''));
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
      // 已有真实回执的意图不得作废。作废的语义是「这次派发确认没有发生」，而回执证明它
      // **发生过**并且指向一个具体 agent。旧实现在这里放行，于是 claim → record → fail
      // 可以用同一幂等键重派一个仍然活着的 agent：账本上写着「上次失败」，实际上出了两个
      // 写手。agent 中途死掉的处置是 reconcile 的 rework，不是抹掉派发痕迹。
      if (intent.resolvedAt !== null && typeof intent.agentId === 'string' && intent.agentId !== '') {
        return { recorded: true, agentId: intent.agentId, resolvedAt: intent.resolvedAt };
      }
      intent.failedAt = nowIso;
      intent.reason = reason;
      return { intent };
    });
    if (result.missing) fail(1, `未知意图键：${key}`);
    if (result.recorded) {
      fail(2, `意图已有真实回执（agent=${result.agentId}，${result.resolvedAt}），`
        + '不得作废：作废只用于「派发确认没有发生」。该 agent 已失联请走 reconcile 的 rework 处置，'
        + '用新的 attempt 键派发，不要抹掉这次派发的痕迹');
    }
    console.log(json ? JSON.stringify({ change, intent: result.intent }) : `[run-state] fail ok ${key} reason=${reason}`);
    break;
  }

  default:
    fail(1, `未知命令: ${command}`);
}
