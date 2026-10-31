// 运行账本单一属主（零依赖）。
//
// 为什么需要它：Git 保存「已合流事实」，冻结的 tasks.md 保存「任务契约」，Paseo 保存
// 「Agent/workspace 事实」。三者都不记录**正在进行的动作**，于是原生派发存在一个真空窗：
// 派发请求已发出、agent 尚未落盘（创建失败、回合去重、进程崩溃）时，对账看不见任何痕迹，
// 同一任务会被再派一次；反过来，创建已成功但回执丢失时，重复派发会双写同一文件。
//
// 本模块只补这一层最小事实，不建第二套任务真源：
//   lease        —— 同一 run 唯一编排 owner（代际租约，旧 Lead 复活后不能继续提交动作）
//   intents      —— 动作意图（先记意图 → 执行 → 记真实 agent/workspace 回执）
//   reviews      —— 审计结论（task/attempt/round/verdict/agent/时间戳），首次通过率的唯一来源
//   merges       —— first-parent 合流事实（task/sha/attempt/reviewTag），由 merge-task.mjs 写入
//   readyObs     —— 写手意图的派发间隔观测（上一动作结束 → 本次 claim 的时间差）
//   heartbeats   —— 只读兼容字段：旧账本可能带该数组，新代码不再写入（heartbeat 子命令已删）
//
// 为什么新增 reviews/merges/readyObs：旧版 `report` 只能打印两项恒为「未采集」的度量，
// 因为账本不记审查结论，也不记合流事实。一次通过率、返工分布这些判断交付质量的关键数
// 就永远只能靠人回忆——而回忆出来的数字会被当成实测值写进复盘。三者的写入点在
// 「事实发生的那一步」（审计回执、合流提交、派发 claim），不在报告生成时补算。
//
// 存放位置：git common dir 下的 `paseo-pipeline/<change>/run-state.json`。
// 为什么不放工作树：合流要求工作树干净，把运行时状态写进 openspec/ 会让每次派发都弄脏
// 工作树、进而阻塞 merge-task；而 git 的具名事实本来就不该由运行时状态污染。
// common dir 在同一仓库的所有 worktree 间共享，因此 Lead 在集成 worktree 写入的记录
// 对其它 worktree 立即可见。可用 PIPELINE_RUN_STATE_DIR 覆盖（测试与特殊部署）。
//
// 写入是原子的（tmp + rename）；读取永不抛：文件缺失或损坏按「无记录」返回，
// 由调用方决定是否 fail closed。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { acquireLock } from './lock.mjs';

export const STATE_VERSION = 1;

/** 租约有效期：超过即视为前任编排者已死，须显式重新 begin（代际 +1）才能继续提交动作。 */
export const DEFAULT_LEASE_TTL_MS = 30 * 60 * 1000;

/** 派发意图的观察宽限：宽限内无对应 agent 属正常（创建尚未落盘），超过即判为孤儿。 */
export const DEFAULT_INTENT_GRACE_MS = 10 * 60 * 1000;

/** 运行账本根目录：PIPELINE_RUN_STATE_DIR > git common dir > 当前目录兜底。 */
export function runStateRoot(cwd = process.cwd()) {
  if (process.env.PIPELINE_RUN_STATE_DIR) return process.env.PIPELINE_RUN_STATE_DIR;
  try {
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000,
    }).trim();
    if (common !== '') return path.resolve(cwd, common, 'paseo-pipeline');
  } catch {
    // 不是 git 仓库：落到当前目录，仍保证单机可用。
  }
  return path.resolve(cwd, '.paseo-pipeline');
}

export function runStatePath(change, cwd = process.cwd()) {
  return path.join(runStateRoot(cwd), change, 'run-state.json');
}

function emptyState() {
  return {
    version: STATE_VERSION,
    run: null,
    lease: null,
    intents: [],
    heartbeats: [],
    reviews: [],
    merges: [],
    readyObs: [],
    confirmations: [],
    skill: null,
  };
}

function normalize(raw) {
  const state = emptyState();
  if (raw === null || typeof raw !== 'object') return state;
  if (typeof raw.run === 'string' && raw.run !== '') state.run = raw.run;
  const lease = raw.lease;
  if (lease && typeof lease === 'object' && typeof lease.owner === 'string' && lease.owner !== '') {
    state.lease = {
      owner: lease.owner,
      generation: Number.isInteger(lease.generation) ? lease.generation : 1,
      acquiredAt: typeof lease.acquiredAt === 'string' ? lease.acquiredAt : null,
      renewedAt: typeof lease.renewedAt === 'string' ? lease.renewedAt : null,
      expiresAt: typeof lease.expiresAt === 'string' ? lease.expiresAt : null,
      ttlMs: Number.isFinite(lease.ttlMs) ? lease.ttlMs : DEFAULT_LEASE_TTL_MS,
    };
  }
  if (Array.isArray(raw.intents)) state.intents = raw.intents.filter((entry) => entry && typeof entry.key === 'string');
  if (Array.isArray(raw.heartbeats)) state.heartbeats = raw.heartbeats.filter((entry) => entry && typeof entry.id === 'string');
  // 审计结论与合流事实：两者的判据在规范化层收紧到「能被报告直接使用的形状」。
  // 缺字段的记录整条丢弃而不是补默认值——补出来的 verdict=unknown 会污染一次通过率的分母。
  if (Array.isArray(raw.reviews)) {
    state.reviews = raw.reviews.filter((entry) => entry && typeof entry.task === 'string'
      && typeof entry.verdict === 'string' && typeof entry.at === 'string');
  }
  if (Array.isArray(raw.merges)) {
    state.merges = raw.merges.filter((entry) => entry && typeof entry.task === 'string'
      && typeof entry.sha === 'string' && typeof entry.at === 'string');
  }
  if (Array.isArray(raw.readyObs)) {
    state.readyObs = raw.readyObs.filter((entry) => entry && typeof entry.task === 'string'
      && Number.isFinite(entry.waitMs));
  }
  // 人类确认点的时间戳。只认 cp1/cp2 两个点位且必须有可解析的时间：
  // 确认点是「人做过这个决定」的唯一占位，记一条无法解析时间的记录等于没有记。
  if (Array.isArray(raw.confirmations)) {
    state.confirmations = raw.confirmations.filter((entry) => entry
      && (entry.checkpoint === 'cp1' || entry.checkpoint === 'cp2')
      && typeof entry.at === 'string' && Number.isFinite(Date.parse(entry.at)));
  }
  // 派发时使用的 Skill 版本。只做「不一致提示」，不做强制：账本可以在同一台机器的不同
  // Skill 版本之间被读取（只读诊断不该因此失败），但「这批任务是用哪份编排逻辑跑出来的」
  // 必须留痕——否则复盘时无法判断某条规则当时是否存在。
  const skill = raw.skill;
  if (skill && typeof skill === 'object' && typeof skill.head === 'string' && skill.head !== '') {
    state.skill = {
      head: skill.head,
      dirty: skill.dirty === true,
      dir: typeof skill.dir === 'string' ? skill.dir : null,
      at: typeof skill.at === 'string' ? skill.at : null,
    };
  }
  return state;
}

/**
 * 读取运行账本。
 * @returns {{present: boolean, state: ReturnType<typeof emptyState>, error: string|null, file: string}}
 */
export function readRunState(change, cwd = process.cwd()) {
  const file = runStatePath(change, cwd);
  if (!fs.existsSync(file)) return { present: false, state: emptyState(), error: null, file };
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return { present: false, state: emptyState(), error: `${file} 不是合法 JSON：${error.message}`, file };
  }
  return { present: true, state: normalize(raw), error: null, file };
}

export function writeRunState(change, state, cwd = process.cwd()) {
  const file = runStatePath(change, cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * 读—改—写一次。`fn(state)` 直接改动 state，可返回结果。
 *
 * 必须持锁：只靠 tmp + rename 保证的是「写入原子」，不是「读改写互斥」。两个进程同时
 * claim 同一 run 时会各自读到旧快照、各自写回，幂等键双双成功，于是同一动作被派发两次。
 * `fn` 抛错时不写回——否则一次失败的校验会把半改的 state 落盘。
 * `fn` 返回 `{ skipWrite: true, ... }` 时也不写回：留给你在锁内做完校验后再决定拒绝，
 * 例如租约校验——在锁外校验等于比对一个可能已被并发持锁者推进过的旧快照。
 */
export function updateRunState(change, fn, cwd = process.cwd()) {
  const file = runStatePath(change, cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = acquireLock(path.dirname(file), 'run-state', { purpose: change });
  if (!lock.ok) {
    const error = new Error(`运行账本正被另一个进程改写（${lock.holder}）；串行重试，不要并发 claim`);
    error.code = 'ELOCKED';
    error.lock = lock;
    throw error;
  }
  try {
    const { state } = readRunState(change, cwd);
    const result = fn(state);
    if (!(result && result.skipWrite === true)) writeRunState(change, state, cwd);
    return { result, state };
  } finally {
    lock.release();
  }
}

/** 动作意图的稳定幂等键：同一 run 内 (task, attempt, phase, role, action) 只允许一条。 */
export function intentKey({ run, task, attempt, phase, role, action }) {
  return [run ?? 'local', task, attempt ?? '-', phase ?? '-', role ?? '-', action ?? 'dispatch'].join(':');
}

export function openIntents(state) {
  return state.intents.filter((intent) => !intent.resolvedAt && intent.failedAt === undefined);
}

/**
 * 意图是否已被显式作废。
 * 作废与回执是两回事：作废（fail）表示这次派发没成功、允许按同键重派；
 * 回执（record）表示派发已落地。两者都从 `openIntents` 里消失，但后续动作相反。
 */
export function isFailed(intent) {
  return intent !== null && typeof intent === 'object' && intent.failedAt !== undefined;
}

export function findByKey(state, key) {
  return state.intents.find((intent) => intent.key === key) ?? null;
}

/**
 * 租约状态。无租约记录 → null（未启用编排租约，不构成放行或阻断依据）。
 * valid 只在租约未过期时为真；过期租约仍保留 owner/generation 供诊断。
 */
export function leaseStatus(state, now = Date.now()) {
  const lease = state.lease;
  if (!lease) return null;
  const expiresAtMs = lease.expiresAt ? Date.parse(lease.expiresAt) : NaN;
  const valid = Number.isFinite(expiresAtMs) && expiresAtMs > now;
  return { ...lease, expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : null, valid };
}

/** 意图年龄（毫秒）；时间戳解析失败返回 null（调用方不得据此判定为新鲜）。 */
export function intentAgeMs(intent, now = Date.now()) {
  const at = intent.createdAt ? Date.parse(intent.createdAt) : NaN;
  return Number.isFinite(at) ? now - at : null;
}
