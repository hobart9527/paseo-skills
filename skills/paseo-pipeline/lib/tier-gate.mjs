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
// 覆盖缺口（如实记录）：PreToolUse 只对结构化写入工具生效，Bash 里的 `sed -i`、重定向看不到。
// 由 Stop 核对补位（assessStop）：UserPromptSubmit 时快照脏文件，Stop 时比对，主 checkout 上本轮
// 新增/变化的文件超限就 block，让模型停手汇报。事后补救，不是事前拦截。
//
// 2026-11-02：超限由 deny 改为 ask。deny 没有放行通道，模型转去 Bash 绕过；ask 把决定权交给用户。
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

export const TIER_RULES = [
  '- Tier 1：小范围、单目录改动 → 当前会话修改并验证。',
  '- Tier 2：超出 Tier 1 且没有真实 DAG 并发收益 → /paseo-handoff 或明确授权的 worktree Agent。',
  '- Tier 3：仅当冻结 DAG 有 maxWidth>=2 且任务>=4 → /paseo-pipeline。',
  '判定不了时按高一级处理。开工后发现范围变大，立刻停手升级，不在原通道硬撑。',
  '用 Bash（sed -i、重定向、heredoc、patch）改文件同样算改文件，同样要先分级；Stop 时会核对主 checkout 的实际改动。',
].join('\n');

function stateDir() {
  return process.env.PIPELINE_TIER_GATE_STATE || path.join(os.tmpdir(), 'paseo-tier-gate');
}

/** 闸门默认 fail-open，但不能静默：异常追加到 errors.log，install.sh 自检与人工排查都看它。 */
export function logHookError(hook, err) {
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.appendFileSync(path.join(stateDir(), 'errors.log'),
      `${new Date().toISOString()} ${hook} ${err?.stack ?? err}\n`);
  } catch {
    // 日志本身失败就放弃，绝不影响主流程。
  }
}

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
  // session_id 只取字母数字与连字符，避免路径穿越。
  return path.join(stateDir(), `${String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
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
    '这是需要用户确认的越级写入：用户若在确认框放行才继续；不要改用 Bash 等方式绕过。',
  ].join('\n');
}

/**
 * 判定一次写入。通过时把目标记入本会话账本，所以调用方每次写入只应调用一次。
 *
 * @param {{target: string, sessionId?: string}} input
 * @returns {{verdict: 'allow'|'ask', reason?: string, note?: string}}
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
  // asked = 越线后交给用户确认的文件；Stop 核对时不再算作逃逸。被拒绝的文件不会真的变化，所以无需区分。
  const asked = (!legacy && Array.isArray(entry?.asked) ? entry.asked : []).filter((v) => typeof v === 'string');
  const lastWrite = !legacy && typeof entry?.at === 'number' ? entry.at : now;
  // A finished task followed by a fresh request is a new segment; see the header note.
  const fresh = !legacy && now - lastWrite >= idleFromEnv();
  const counted = fresh ? [] : files;
  if (counted.includes(rel)) return { verdict: 'allow', note: 'already counted' };

  const limit = limitFromEnv();
  const save = (next) => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ ...state, [ctx.root]: next }));
    } catch {
      // 记账失败不能锁死写入：放行，只是这一笔不计数。
    }
  };
  if (counted.length >= limit) {
    // 不计入 files：每次越线写入都要重新确认，被拒绝后不能靠重试溜过去。
    save({ files: counted, at: now, asked: asked.includes(rel) ? asked : [...asked, rel] });
    return { verdict: 'ask', reason: denyReason(counted.length, limit, counted) };
  }

  save({ files: [...counted, rel], at: now, asked });
  return { verdict: 'allow' };
}

/** 本轮开始时的基线：HEAD 与脏文件签名。只在主 checkout 的 main/master 上记录。 */
function dirtySignatures(root) {
  const raw = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000,
  });
  const parts = raw.split('\0').filter(Boolean);
  const sig = {};
  for (let i = 0; i < parts.length; i += 1) {
    const status = parts[i].slice(0, 2);
    const rel = parts[i].slice(3);
    if (status[0] === 'R' || status[0] === 'C') i += 1; // -z 下重命名后面跟着原路径
    try {
      const st = fs.statSync(path.join(root, rel));
      sig[rel] = `${st.size}:${st.mtimeMs}`;
    } catch {
      sig[rel] = 'gone';
    }
  }
  return sig;
}

function snapFile(sessionId) {
  return stateFile(sessionId).replace(/\.json$/, '.snap.json');
}

export function takeSnapshot({ cwd, sessionId }) {
  if (process.env.PIPELINE_TIER_GATE === 'off') return;
  if (typeof sessionId !== 'string' || sessionId === '' || typeof cwd !== 'string' || cwd === '') return;
  const ctx = repoContext(cwd);
  if (ctx === null || !ctx.isPrimaryOnProtected) return;
  const snap = { root: ctx.root, head: git(ctx.root, ['rev-parse', 'HEAD']), sig: dirtySignatures(ctx.root) };
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(snapFile(sessionId), JSON.stringify(snap));
}

const EXEMPT = (rel) => rel === 'openspec' || rel.startsWith('openspec/')
  || rel === '.superpowers' || rel.startsWith('.superpowers/');

/**
 * Stop 时核对：自本轮快照以来主 checkout 上变化的业务文件（含 Bash 造成的、含已提交的）是否超过 Tier 1 上限。
 * 经 ask 流程由用户确认过的文件不计入。
 *
 * @returns {{verdict: 'ok'|'block', reason?: string, files?: string[]}}
 */
export function assessStop({ cwd, sessionId }) {
  if (process.env.PIPELINE_TIER_GATE === 'off') return { verdict: 'ok' };
  if (typeof sessionId !== 'string' || sessionId === '' || typeof cwd !== 'string' || cwd === '') return { verdict: 'ok' };
  const ctx = repoContext(cwd);
  if (ctx === null || !ctx.isPrimaryOnProtected) return { verdict: 'ok' };
  const snap = readState(snapFile(sessionId));
  if (snap.root !== ctx.root || typeof snap.sig !== 'object' || snap.sig === null) return { verdict: 'ok' };

  const changed = new Set();
  const current = dirtySignatures(ctx.root);
  for (const [rel, sig] of Object.entries(current)) if (snap.sig[rel] !== sig) changed.add(rel);
  for (const rel of Object.keys(snap.sig)) if (!(rel in current)) changed.add(rel); // 本轮被还原/提交
  const head = git(ctx.root, ['rev-parse', 'HEAD']);
  if (head !== snap.head) {
    for (const rel of git(ctx.root, ['diff', '--name-only', snap.head, head]).split('\n').filter(Boolean)) changed.add(rel);
  }

  const askedList = readState(stateFile(sessionId))[ctx.root]?.asked;
  const asked = new Set(Array.isArray(askedList) ? askedList : []);
  const files = [...changed].filter((rel) => !EXEMPT(rel) && !asked.has(rel)).sort();
  const limit = limitFromEnv();
  if (files.length <= limit) return { verdict: 'ok', files };
  return {
    verdict: 'block',
    files,
    reason: [
      `[tier-gate] 本轮在主 checkout（main）上实际改动了 ${files.length} 个文件，超过 Tier 1 上限 ${limit}，且未经确认。`,
      `改动：${files.join('、')}`,
      '不要再改文件，也不要回滚。先向用户汇报：这次已越出 Tier 1，是否未先分级；然后请用户决定走 Tier 2（/paseo-handoff）、Tier 3（/paseo-pipeline）或明确放行。',
      '（若其中有文件不是你改的，例如用户或其他会话同时在改，说明这一点即可。）',
    ].join('\n'),
  };
}
