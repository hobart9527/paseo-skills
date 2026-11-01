// Tier 1 写入上限（零依赖）：主 checkout 的 main/master 上，单个会话写过的不同业务文件
// 超过上限就拒绝，并指向 Tier 2 / Tier 3 通道。
//
// 为什么需要它：2026-10-31 两个会话在用户说「执行上面的优化」后，没有做任何分级判断就在
// 主 checkout 直接改了十几个文件。分级表在上下文里，但决策点上没人去查它。旧 scope 闸门只在
// 有编排租约时生效，租约之外一律放行，所以这类「根本没进流水线」的写入没有任何东西拦。
//
// 判据只数「本会话写过的文件」，不数 git 脏文件：仓库里原有的未提交改动不是本会话造成的，
// 数它们会让新任务一开工就被拦。
//
// 刻意保守，宁可少拦（旧 scope 闸门一致）：
//   - 不在主 checkout 的 main/master 上（linked worktree、功能分支、游离 HEAD）→ 放行。
//     Tier 2 的 handoff 写手与 Tier 3 的 Worktree 写手天然落在这里。
//   - 目标在仓库之外、或在 openspec/ 下 → 放行。Tier 3 的主会话要在主 checkout 写 spec 产物。
//   - 目标在 .superpowers/（gitignore 的原型/草稿产物）下 → 放行，同属文档类产物。
//   - 缺 session_id、读不到 git、状态文件损坏 → 放行（fail-open）。
//   - PIPELINE_TIER_GATE=off 整体关闭；PIPELINE_TIER_GATE_LIMIT 调上限（默认 3）。
//
// 覆盖缺口（如实记录）：只对结构化写入工具生效，Bash 里的 `sed -i`、重定向看不到。
//
// 2026-11-02：账本从「本会话累计」改为「当前任务段累计」。此前计数永不清零，同一会话里
// 先做完一件 3 文件的 Tier 1 小事之后，再做任何不相关的小改动都会被拒——闸门量的是
// 「本次改动规模」，却记成了「会话总写量」。现在遇到探针命中即结算：账本超过
// DEFAULT_IDLE_MS 没被写过，就视为新任务段，从空账本重新计数。阈值可调
// （PIPELINE_TIER_GATE_IDLE_MS），取舍见该常量的说明（宁可少拦，与旧行为一致）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const DEFAULT_LIMIT = 3;
// A gap this long between writes starts a new task segment. 30 minutes is chosen so a
// normal "read, think, edit" gap inside one task never resets the count, while a
// finished task followed by a fresh request does.
export const DEFAULT_IDLE_MS = 30 * 60 * 1000;
const PROTECTED_BRANCHES = new Set(['main', 'master']);

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000,
  }).trim();
}

/** 沿父目录向上找到最深的存在目录：目标文件可能尚不存在（新建）。 */
function deepestExistingDir(target) {
  let current = path.resolve(target);
  for (;;) {
    try {
      if (fs.statSync(current).isDirectory()) return current;
    } catch {
      // 不存在：继续向上。
    }
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

/**
 * 目标所在仓库的上下文；不在 git 仓库内、或读取失败时返回 null。
 * isPrimaryOnProtected = 主 checkout（git-dir 即 common-dir）且分支为 main/master。
 */
export function repoContext(target) {
  try {
    const dir = deepestExistingDir(target);
    const root = fs.realpathSync(git(dir, ['rev-parse', '--show-toplevel']));
    const gitDir = fs.realpathSync(path.resolve(dir, git(dir, ['rev-parse', '--git-dir'])));
    const commonDir = fs.realpathSync(path.resolve(dir, git(dir, ['rev-parse', '--git-common-dir'])));
    let branch = '';
    try {
      branch = git(dir, ['symbolic-ref', '--short', '-q', 'HEAD']);
    } catch {
      branch = ''; // 游离 HEAD
    }
    return { root, isPrimaryOnProtected: gitDir === commonDir && PROTECTED_BRANCHES.has(branch), branch };
  } catch {
    return null;
  }
}

/** 把目标换成仓内相对路径（两边都过 realpath，macOS 的 /tmp 符号链接不会让判定静默失效）。 */
function relativeInRepo(target, root) {
  let resolved = path.resolve(target);
  const rest = [];
  for (;;) {
    try {
      resolved = path.join(fs.realpathSync(resolved), ...rest);
      break;
    } catch {
      const parent = path.dirname(resolved);
      if (parent === resolved) return null;
      rest.unshift(path.basename(resolved));
      resolved = parent;
    }
  }
  const rel = path.relative(root, resolved);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

function stateFile(sessionId) {
  const dir = process.env.PIPELINE_TIER_GATE_STATE
    || path.join(os.tmpdir(), 'paseo-tier-gate');
  // session_id 只取字母数字与连字符，避免路径穿越。
  return path.join(dir, `${String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
}

function readState(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function limitFromEnv() {
  const raw = Number.parseInt(process.env.PIPELINE_TIER_GATE_LIMIT ?? '', 10);
  return Number.isInteger(raw) && raw >= 1 ? raw : DEFAULT_LIMIT;
}

function idleFromEnv() {
  const raw = Number.parseInt(process.env.PIPELINE_TIER_GATE_IDLE_MS ?? '', 10);
  return Number.isInteger(raw) && raw >= 0 ? raw : DEFAULT_IDLE_MS;
}

function denyReason(count, limit, files) {
  return [
    `本会话已在主 checkout（main）写了 ${count} 个不同文件，达到 Tier 1 上限 ${limit}；再写会超出 Tier 1。`,
    `已写：${files.join('、')}`,
    '先停手，按范围改走对应通道（不要继续原地写）：',
    '- Tier 2（单模块、不涉及持久化/并发/不可逆）：用 /paseo-handoff 交给 worktree 里的 Agent，交接内容写明验收命令与「越级即停」。',
    '- Tier 3（冻结后的 DAG 有 maxWidth≥2 且任务≥4；跨模块共享契约、持久化、并发、不可逆变更通常是这类迹象）：用 /paseo-pipeline。不要为了够格而拆分 DAG。',
    '已写的改动保留在工作区，不要回滚；把它们列进交接内容的「当前状态」。',
    '如果这是误判（例如纯文档批量修订），请向用户说明并请其放行，不要自行绕过。',
  ].join('\n');
}

/**
 * 判定一次写入。通过时把目标记入本会话账本，所以调用方每次写入只应调用一次。
 *
 * @param {{target: string, sessionId?: string}} input
 * @returns {{verdict: 'allow'|'deny', reason?: string, note?: string}}
 */
export function assessTierGate({ target, sessionId }) {
  if (process.env.PIPELINE_TIER_GATE === 'off') return { verdict: 'allow', note: 'gate off' };
  if (typeof sessionId !== 'string' || sessionId === '') return { verdict: 'allow', note: 'no session id' };
  if (typeof target !== 'string' || target === '') return { verdict: 'allow', note: 'no target' };

  const ctx = repoContext(target);
  if (ctx === null) return { verdict: 'allow', note: 'not a readable git repo' };
  if (!ctx.isPrimaryOnProtected) return { verdict: 'allow', note: 'not primary checkout on main' };

  const rel = relativeInRepo(target, ctx.root);
  if (rel === null) return { verdict: 'allow', note: 'outside repo' };
  if (rel === 'openspec' || rel.startsWith('openspec/')) return { verdict: 'allow', note: 'openspec artifact' };
  // 可视化原型/草稿目录：gitignore 里的一次性产物（brainstorm 原型页等），
  // 不进仓库、不参与构建，与 openspec/ 同属「写多少都不算越级」的文档类产物。
  if (rel === '.superpowers' || rel.startsWith('.superpowers/')) return { verdict: 'allow', note: 'gitignored scratch artifact' };

  const file = stateFile(sessionId);
  const state = readState(file);
  const now = Date.now();
  const entry = state[ctx.root];
  // Legacy shape (`["src/a", ...]`, no clock) still counts; it just has no timestamp.
  const legacy = Array.isArray(entry);
  const files = (legacy ? entry : Array.isArray(entry?.files) ? entry.files : []).filter((v) => typeof v === 'string');
  const lastWrite = !legacy && typeof entry?.at === 'number' ? entry.at : now;
  // A finished task followed by a fresh request is a new segment; see the header note.
  const fresh = !legacy && now - lastWrite >= idleFromEnv();
  const counted = fresh ? [] : files;
  if (counted.includes(rel)) return { verdict: 'allow', note: 'already counted' };

  const limit = limitFromEnv();
  if (counted.length >= limit) {
    return { verdict: 'deny', reason: denyReason(counted.length, limit, counted) };
  }

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...state, [ctx.root]: { files: [...counted, rel], at: now } }));
  } catch {
    // 记账失败不能锁死写入：放行，只是这一笔不计数。
  }
  return { verdict: 'allow' };
}
