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
//
// 2026-11-02（二）：补两类真实缺口。
//   1) Stop 核对曾把 `git pull`、CP-2 的 --no-ff 合流、以及被 `git restore`/`stash` 还原的
//      旧脏文件都算成本轮违规。现在只在 HEAD 移动时读「本机新增、未进远端」的提交
//      （--first-parent --no-merges --not --remotes），合流与拉取不再误拦。
//   2) 每轮 Stop 把本轮实际改动的业务文件并回段账本并计一轮。此前每轮只看增量，
//      每轮 Bash 改 2 个文件可以永远不触发上限；现在累计到第 4 个文件即 ask。
//   另外，同一任务段连续 DEFAULT_TURNS 轮都在改业务文件时，Stop 汇报一次「原地反复试错」。
//   这条汇报放在 Stop 而不是 PreToolUse：它要的是「先停下来汇报试过什么」，不是逐次写入的
//   许可弹窗。用户看到后，下一条消息到达时轮次清零、重新观察，每 DEFAULT_TURNS 轮最多打断一次。
//   按轮次而非 Edit 次数计数（LESSONS §9.4）。
//
// 2026-11-03：修复 Git 工作树改动回写账本污染本会话计数问题。
//   此前 assessStop 把工作树 Git 脏文件（round）并回 seg.files，由于 Git 工作树全进程共享，
//   并发 agent 或其他活跃会话改动的文件被持久化进当前会话账本，导致当前会话后续正常的
//   PreToolUse（Write/Edit）被误判超限阻断。
//   现改为：
//   1) seg.files 严格由 PreToolUse（assessTierGate）单会话精准记录，assessStop 绝不将 round 回写进 seg.files；
//   2) Stop 自己的跨轮累计（Bash 每轮小步写，见上 2026-11-02（二）2)）改记在私有字段 seg.stopFiles，
//      assessTierGate 不读它，只透传保存；PreToolUse 额度因此不受 Git 脏文件影响，Bash 小步累计仍会在 Stop 触顶；
//   3) assessStop 排除 stateDir 中其他活跃会话 files/asked 已认领的业务文件，并发产物不计入当前会话。
//   局限：两个会话碰同一文件时，该文件被排除，Stop 可能漏报（宁可少拦）；认领窗口同 DEFAULT_IDLE_MS。
//   这是减速带，不是沙箱（LESSONS §14.4）；并发写入的正解仍是 worktree 隔离。
//
// 2026-11-02（三）：补上「单目录」这一维。此前闸门只数文件数，跨包的第一个文件（如已在
// packages/server 写了 1 个，再写 packages/web 的第 2 个）完全不拦——规则里的「超出单目录
// 即 Tier 2」在实现里没有对应项。现按工作区根判 scopeKey（packages/web、apps/api、skills/x
// 取前两段，其余取顶层目录），已触碰其他 scope 时该文件也要 ask。ask 仍不进 files、只进 asked，
// 「拒绝后重试仍 ask」与 Stop 对 asked 的豁免都保持不变。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const DEFAULT_LIMIT = 3;
// A gap this long between writes starts a new task segment. 30 minutes is chosen so a
// normal "read, think, edit" gap inside one task never resets the count, while a
// finished task followed by a fresh request does.
export const DEFAULT_IDLE_MS = 30 * 60 * 1000;
// 同一任务段里连续这么多轮用户消息都在主 checkout 改业务文件，就不再只是「多写了几笔」：
// 模型在原地反复试错。达到阈值时由 Stop 汇报一次（不是逐次写入的许可弹窗），用户看到后
// 由 takeSnapshot 清零轮次、重新观察。按「轮次」而不是「Edit 次数」计数，因为一次正常的
// 小改动分 4-5 次 Edit 很常见，按次数拦会制造弹窗疲劳（LESSONS §9.4）。
export const DEFAULT_TURNS = 3;
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

function turnsFromEnv() {
  const raw = Number.parseInt(process.env.PIPELINE_TIER_GATE_TURNS ?? '', 10);
  return Number.isInteger(raw) && raw >= 1 ? raw : DEFAULT_TURNS;
}

const EXEMPT = (rel) => rel === 'openspec' || rel.startsWith('openspec/')
  || rel === '.superpowers' || rel.startsWith('.superpowers/');

// 工作区根：monorepo 的 packages/x、apps/x、services/x、crates/x、skills/x 算一个作用域，
// 其余取顶层目录。Tier 1 的「单目录」按这里判，而不是按文件的完整路径。
const WORKSPACE_ROOTS = new Set(['packages', 'apps', 'services', 'crates', 'skills']);
export function scopeKey(rel) {
  const parts = String(rel).split('/');
  if (parts.length > 2 && WORKSPACE_ROOTS.has(parts[0])) return `${parts[0]}/${parts[1]}`;
  return parts.length > 1 ? parts[0] : '.';
}

/**
 * 段账本归一化：legacy 数组形态、损坏字段、跨段旧值都在这里收敛成同一种形状。
 * `fresh` 为真表示上一笔写入已超过空闲阈值，本笔开启新任务段。
 */
function segment(entry, now = Date.now()) {
  const legacy = Array.isArray(entry);
  const strings = (value) => (Array.isArray(value) ? value : []).filter((v) => typeof v === 'string');
  const at = !legacy && typeof entry?.at === 'number' ? entry.at : 0;
  const fresh = !legacy && at > 0 && now - at >= idleFromEnv();
  return {
    legacy,
    at,
    fresh,
    files: fresh ? [] : strings(legacy ? entry : entry?.files),
    // 用户确认过的文件只在同一任务段内豁免；新任务段的改动要重新计数。
    asked: fresh ? [] : strings(legacy ? [] : entry?.asked),
    // Stop 私有的跨轮累计（来自 Git 差异，含 Bash 写入）。只有 assessStop 读写；
    // assessTierGate 不据此计数，只在 keep 里原样带过，防止被 PreToolUse 的写回抹掉。
    stopFiles: fresh ? [] : strings(legacy ? [] : entry?.stopFiles),
    // 已经因为超过上限向用户汇报过的文件。同一批文件不重复 block，否则用户回复后
    // 没有任何新改动也会被反复打断；只有累计集合里出现新文件才再次汇报。
    reported: fresh ? [] : strings(legacy ? [] : entry?.reported),
    turns: fresh ? 0 : (!legacy && Number.isInteger(entry?.turns) ? entry.turns : 0),
    // Stop 已汇报过「连续多轮原地改」。用户看到后的下一条消息才重置，避免每轮重复打断。
    churnReported: fresh ? false : (!legacy && entry?.churnReported === true),
  };
}

function writeSegment(file, state, root, next) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...state, [root]: next }));
  } catch {
    // 记账失败不能锁死写入：放行，只是这一笔不计数。
  }
}

function denyReason(count, limit, files, scopes = []) {
  const scopeLine = scopes.length >= 2
    ? `本任务段已跨 ${scopes.length} 个作用域（${scopes.join('、')}），超出 Tier 1 的「单目录小范围」。`
    : `本任务段已在主 checkout（main）写了 ${count} 个不同业务文件，达到 Tier 1 上限 ${limit}；再写会超出 Tier 1。`;
  return [
    scopeLine,
    `已写：${files.join('、')}`,
    '先停手，按范围改走对应通道（不要继续原地写）：',
    '- Tier 2（单模块、不涉及持久化/并发/不可逆）：用 /paseo-handoff 交给 worktree 里的 Agent，交接内容写明验收命令与「越级即停」。',
    '- Tier 3（冻结后的 DAG 有 maxWidth≥2 且任务≥4；跨模块共享契约、持久化、并发、不可逆变更通常是这类迹象）：用 /paseo-pipeline。不要为了够格而拆分 DAG。',
    '已写的改动保留在工作区，不要回滚；把它们列进交接内容的「当前状态」。',
    '这是需要用户确认的越级写入：用户若在确认框放行才继续；不要改用 Bash 等方式绕过。',
  ].join('\n');
}

function churnReason(turns, threshold) {
  return [
    `[tier-gate] 本任务段已连续 ${turns} 轮在主 checkout（main）上改业务文件，达到阈值 ${threshold} 轮：这不是「一次小范围改动」，是原地反复试错。`,
    '先不要再改文件。向用户汇报：反复了几轮、每轮改了什么、卡在哪里。然后二选一：',
    '- 疑难 Bug：用 /diagnosing-bugs 建最小复现，不要继续盲改。',
    '- 复杂度超预期：用 /paseo-handoff 交给 worktree 里的 Agent，交接内容必写「## What was tried」，避免下游重走同一条死路。',
    '用户明确要求继续时，才在本任务段里继续改；不要改用 Bash 等方式绕过这次汇报。',
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
  const seg = segment(state[ctx.root], now);
  const counted = seg.files;
  const asked = seg.asked;
  // 越线写入要用户确认的文件。churn 不在这里判：那是「停下来汇报试过什么」，
  // 归 Stop 事后核对（assessStop），逐次写入只做文件数上限这一件事。
  const keep = { turns: seg.turns, reported: seg.reported, churnReported: seg.churnReported, stopFiles: seg.stopFiles };
  if (counted.includes(rel)) return { verdict: 'allow', note: 'already counted' };

  const limit = limitFromEnv();
  // 已触碰的作用域（含用户确认过的越线文件——它们同样在本任务段的范围内）。
  const known = [...new Set([...counted, ...asked])];
  const scopes = [...new Set([...known.map(scopeKey), scopeKey(rel)])].sort();
  if (known.length > 0 && scopes.length >= 2) {
    // 跨作用域一律 ask：哪怕这是第 2 个文件，也已经是 Tier 2。
    // 同样不进 files、只进 asked，保住「拒绝后重试仍 ask」这条不变式。
    writeSegment(file, state, ctx.root, { ...keep, files: counted, at: now, asked: asked.includes(rel) ? asked : [...asked, rel] });
    return { verdict: 'ask', reason: denyReason(known.length, limit, known, scopes) };
  }
  if (counted.length >= limit) {
    // 不计入 files：每次越线写入都要重新确认，被拒绝后不能靠重试溜过去。
    writeSegment(file, state, ctx.root, { ...keep, files: counted, at: now, asked: asked.includes(rel) ? asked : [...asked, rel] });
    return { verdict: 'ask', reason: denyReason(counted.length, limit, counted) };
  }

  writeSegment(file, state, ctx.root, { ...keep, files: [...counted, rel], at: now, asked });
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

/**
 * 分级提醒/会话规则只对「人在主 checkout 上直接对话」的会话有意义。
 * linked worktree / 功能分支里注入只是噪声：那里的 tier 已经由派发方决定。
 * cwd 不在 git 仓库内（ctx 为 null）时照常注入——不能用 `!ctx?.isPrimaryOnProtected`，
 * 否则非仓库目录的会话会丢掉规则。
 * 不看 `PASEO_AGENT_ID`：人在 Paseo 里直连的会话同样带它，按环境变量跳过会静默吞掉提醒。
 */
export function skipInjection(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return false;
  const ctx = repoContext(cwd);
  return ctx !== null && !ctx.isPrimaryOnProtected;
}

/**
 * 记录本轮基线。`isHumanTurn=false`（Paseo 子 agent 通知等系统消息，经 UserPromptSubmit 到达）
 * 仍要刷新快照——否则上一轮遗留的脏文件会在 assessStop 里被当成「本轮改动」——
 * 但不重置 turns / churnReported：系统通知不是用户看过汇报后的答复。
 */
export function takeSnapshot({ cwd, sessionId, isHumanTurn = true }) {
  if (process.env.PIPELINE_TIER_GATE === 'off') return;
  if (typeof sessionId !== 'string' || sessionId === '' || typeof cwd !== 'string' || cwd === '') return;
  const ctx = repoContext(cwd);
  if (ctx === null || !ctx.isPrimaryOnProtected) return;
  // 新一条用户消息到达 = 用户已经看到上一次汇报（文件名或「原地反复改」）并选择继续。
  // 只在这里重置观察窗：越线后同一轮里不会每写一次都弹窗，用户答复后也不会被同一批文件
  // 反复打断。files / asked 不动——否则越线的写入就真的被忘掉了。
  const file = stateFile(sessionId);
  const state = readState(file);
  const prev = state[ctx.root];
  if (isHumanTurn && prev && !Array.isArray(prev)) {
    const inspected = prev.churnReported === true
      || (Number.isInteger(prev.turns) && prev.turns >= turnsFromEnv());
    if (inspected) writeSegment(file, state, ctx.root, { ...prev, turns: 0, churnReported: false });
  }
  const snap = { root: ctx.root, head: git(ctx.root, ['rev-parse', 'HEAD']), sig: dirtySignatures(ctx.root) };
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(snapFile(sessionId), JSON.stringify(snap));
}

/**
 * 本轮由本机新增、尚未推送的提交改到的文件。这是 `git pull` 与 CP-2 合流不误拦的关键：
 *   --first-parent  合流只算主干这一条线，`integration/<change>` 子分支上的 4 个文件不算「主 checkout 原地写」；
 *   --no-merges     跳过合流提交本身；
 *   --not --remotes 远端已有的提交是拉取来的，不属于本会话。
 * 本机直连 `main` 的普通提交仍会出现在这里——那正是「Bash 写完直接提交」要补的洞。
 */
function localCommitFiles(root, from, to) {
  return git(root, ['log', '--first-parent', '--no-merges', '--pretty=format:', '--name-only', `${from}..${to}`, '--not', '--remotes'])
    .split('\n').map((line) => line.trim()).filter(Boolean);
}

/**
 * 仓内其他活跃会话已经认领（files 或 asked）的文件集合。
 * 用于 Stop 核对时排除并发 agent / 其他会话在同一 checkout 下产生的业务文件，避免误算进本会话。
 */
export function otherSessionsClaimedFiles(dir, currentSessionId, root, now = Date.now()) {
  const claimed = new Set();
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json') || name.endsWith('.snap.json')) continue;
      const sid = name.slice(0, -5);
      if (sid === currentSessionId) continue;
      const state = readState(path.join(dir, name));
      const entry = state[root];
      if (!entry || Array.isArray(entry)) continue;
      const at = typeof entry.at === 'number' ? entry.at : 0;
      if (at > 0 && now - at < idleFromEnv()) {
        const files = Array.isArray(entry.files) ? entry.files : [];
        const asked = Array.isArray(entry.asked) ? entry.asked : [];
        for (const f of files) claimed.add(f);
        for (const f of asked) claimed.add(f);
      }
    }
  } catch {
    // 读其他会话失败不影响本会话主流程
  }
  return claimed;
}

/**
 * Stop 时核对：自本轮快照以来主 checkout 上变化的业务文件（含 Bash 造成的、含已提交的）是否超过 Tier 1 上限。
 * 经 ask 流程由用户确认过的文件不计入。
 * 排除 stateDir 中其他活跃会话已认领的文件，避免并发产物误拦当前会话。
 * Git 改动（round）只累计进私有 seg.stopFiles、不写进 seg.files，PreToolUse 判据不受 Git 脏文件污染。
 *
 * 同一段里连续 DEFAULT_TURNS 轮都在改业务文件，也在这里
 * 汇报一次「原地反复试错」——事后迫使模型停下来讲清楚，而不是逐次写入弹许可框。
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
  // 快照里有、现在没了，且 HEAD 没动：只可能是 stash/restore/checkout 把旧脏文件还原了，
  // 不是本轮写的新内容。HEAD 动了的交给下面按提交补（合流与拉取已被排除）。
  const head = git(ctx.root, ['rev-parse', 'HEAD']);
  if (head !== snap.head) {
    for (const rel of localCommitFiles(ctx.root, snap.head, head)) changed.add(rel);
  }

  const file = stateFile(sessionId);
  const state = readState(file);
  const seg = segment(state[ctx.root]);
  const asked = new Set(seg.asked);
  const claimedByOthers = otherSessionsClaimedFiles(stateDir(), sessionId, ctx.root);
  const business = (rel) => !EXEMPT(rel) && !asked.has(rel) && !claimedByOthers.has(rel);
  const round = [...changed].filter(business).sort();
  // PreToolUse 已写文件 + Stop 私有累计 + 本轮 Git 变化（均排除并发产物）参与当轮判定
  const combined = [...new Set([...seg.files, ...seg.stopFiles, ...round])].filter(business).sort();
  const limit = limitFromEnv();
  const reportedBefore = new Set(seg.reported);
  // 同一批累计文件只汇报一次：用户看到 block 后回一句「知道了」，不应在没有任何新改动时
  // 再被同样的 block 打断；只有出现新的越界文件才重新汇报。
  const unreported = combined.filter((rel) => !reportedBefore.has(rel));
  const fileLimitBlock = combined.length > limit && unreported.length > 0;
  // 跨作用域与 assessTierGate 同口径：已有累计文件、再触到第 2 个作用域即越出 Tier 1。
  // Bash 写入绕过了 PreToolUse 的 ask，这里事后补上；复用 reported，同一批只汇报一次。
  const scopes = [...new Set([...combined, ...seg.asked].map(scopeKey))].sort();
  const scopeBlock = !fileLimitBlock && combined.length > 0 && scopes.length >= 2 && unreported.length > 0;
  // 「连续多轮原地改」在这里判：Stop 的产出是迫使模型停下来汇报，不是逐次写入的许可。
  // 汇报过一次就设 churnReported，用户回话时由 takeSnapshot 重置；否则同一段任务每轮都打断。
  const turnLimit = turnsFromEnv();
  const turnsAfter = round.length > 0 ? seg.turns + 1 : seg.turns;
  const churnBlock = turnsAfter >= turnLimit && round.length > 0 && !seg.churnReported;
  const block = fileLimitBlock || scopeBlock || churnBlock;
  // 只有真的在本轮改动了业务文件才算一轮；纯阅读/纯讨论不推进计数器，也不刷新段时钟，
  // 否则一段任务会被频繁的 Stop 永久保活，空闲重置永远不生效。
  if (round.length > 0) {
    writeSegment(file, state, ctx.root, {
      // 关键：round 不进 files（PreToolUse 的账本），只进 Stop 私有的 stopFiles，避免 Git 脏文件污染后续 PreToolUse
      files: seg.files,
      stopFiles: combined.filter((rel) => !seg.files.includes(rel)),
      asked: seg.asked,
      at: Date.now(),
      turns: turnsAfter,
      reported: fileLimitBlock || scopeBlock ? combined : seg.reported,
      // 保留已汇报标记：只有下一条用户消息（takeSnapshot）才重置，别在同一条消息里又允许重复打断。
      churnReported: seg.churnReported || churnBlock,
    });
  }

  if (!block) return { verdict: 'ok', files: round };
  const limitReason = [
    `[tier-gate] 本任务段在主 checkout（main）上已改动 ${combined.length} 个业务文件，超过 Tier 1 上限 ${limit}，且未经确认。`,
    `本轮改动：${round.join('、') || '（无新增，是上一轮累计）'}`,
    `累计：${combined.join('、')}`,
    '不要再改文件，也不要回滚。先向用户汇报：这次已越出 Tier 1，是否未先分级；然后请用户决定走 Tier 2（/paseo-handoff）、Tier 3（/paseo-pipeline）或明确放行。',
    '（若其中有文件不是你改的，例如用户或其他会话同时在改，说明这一点即可。）',
  ].join('\n');
  const scopeReason = [
    `[tier-gate] 本任务段在主 checkout（main）上已跨 ${scopes.length} 个作用域（${scopes.join('、')}），超出 Tier 1 的「单目录小范围」，且未经确认。`,
    `本轮改动：${round.join('、') || '（无新增，是上一轮累计）'}`,
    `累计：${combined.join('、')}`,
    '不要再改文件，也不要回滚。先向用户汇报：这次已越出 Tier 1，是否未先分级；然后请用户决定走 Tier 2（/paseo-handoff）、Tier 3（/paseo-pipeline）或明确放行。',
  ].join('\n');
  const reason = [fileLimitBlock ? limitReason : '', scopeBlock ? scopeReason : '', churnBlock ? churnReason(turnsAfter, turnLimit) : '']
    .filter(Boolean).join('\n\n');
  return { verdict: 'block', files: combined, reason };
}
