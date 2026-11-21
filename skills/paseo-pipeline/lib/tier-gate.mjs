// Tier 1 写入上限（零依赖）：主 checkout 的 main/master/功能分支上，单个任务段写过的不同业务文件
// 超过上限（默认 3）或跨作用域就触发 ask，指向 Tier 2（linked worktree）或 Tier 3（/paseo-pipeline）。
//
// 不再解析 transcript.jsonl 里的文本声明（TIER-PLAN）：模型开工前无法先知真实影响面，
// 强行要求先声明再写容易受 JSONL flush 竞态误拦。保留确定性的「主 checkout 文件数 + 作用域」
// PreToolUse 闸门，以及 Stop 的 Bash 写入 + 原地反复试错（churn）核对。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  DEFAULT_LIMIT,
  UNCOUNTED,
  EXEMPT,
  CHURN_EXEMPT,
  scopeKey,
  resolveScopedPath,
} from './paths.mjs';
import { scanRepo } from './risk-scan.mjs';
import { recordEvent } from './telemetry.mjs';

export { DEFAULT_LIMIT, UNCOUNTED, EXEMPT, scopeKey, resolveScopedPath };
export const DEFAULT_IDLE_MS = 30 * 60 * 1000;
export const DEFAULT_TURNS = 3;
const PROTECTED_BRANCHES = new Set(['main', 'master']);

// 规则正本是 ~/.claude/CLAUDE.md；这里只放必须看到的精简摘要，阈值与正本一致。
export const TIER_RULES = [
  `先只读探查（rg/调研）再定档：Tier 1 ≤${DEFAULT_LIMIT} 个源文件、单一作用域 → 主 checkout 做；Tier 2 >${DEFAULT_LIMIT} 个源文件或跨作用域 → 进 linked worktree（收口必跑 tier2-verify）；Tier 3 ≥4 实质任务且 maxWidth≥3（或 maxWidth≥2 且加速比≥1.8）→ /paseo-pipeline。`,
  '风险：风险操作（部署、生产写入、迁移、push）要用户原话授权与回滚方案；风险代码（鉴权、并发幂等、schema、资金、外部写入或改弱既有测试）须过 risk-scan + 1 个独立 reviewer（1+1 上限），不升档、不需授权。其余见 ~/.claude/CLAUDE.md。',
].join('\n');

const TIER_2_DEFINITION = `Tier 2：>${DEFAULT_LIMIT} 个源文件或跨作用域 → 先隔离到 linked worktree，主会话自己进去做；整体可独立完成或需要并行时才委派（brief.mjs tier2 / /tier2-handoff → /paseo-handoff），收口必跑 tier2-verify。`;
const TIER_3_DEFINITION = 'Tier 3：主会话粗画 DAG 有 ≥4 个实质任务且 maxWidth≥3（或 maxWidth≥2 且加权加速比≥1.8）→ /paseo-pipeline。';

function stateDir() {
  return process.env.PIPELINE_TIER_GATE_STATE || path.join(os.tmpdir(), 'paseo-tier-gate');
}

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

function deepestExistingDir(target) {
  let current = path.resolve(target);
  for (;;) {
    try {
      if (fs.statSync(current).isDirectory()) return current;
    } catch {}
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

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
      branch = '';
    }
    const isPrimary = gitDir === commonDir;
    return { root, isPrimary, isPrimaryOnProtected: isPrimary && PROTECTED_BRANCHES.has(branch), branch };
  } catch {
    return null;
  }
}

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

// Path and scope matchers live in ./paths.mjs (re-exported above).

function declaredScopes(files, root) {
  return [...new Set(files.map((file) => scopeKey(resolveScopedPath(file, root))))].sort();
}

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
    asked: fresh ? [] : strings(legacy ? [] : entry?.asked),
    stopFiles: fresh ? [] : strings(legacy ? [] : entry?.stopFiles),
    reported: fresh ? [] : strings(legacy ? [] : entry?.reported),
    turns: fresh ? 0 : (!legacy && Number.isInteger(entry?.turns) ? entry.turns : 0),
    churnReported: fresh ? false : (!legacy && entry?.churnReported === true),
    riskReported: fresh ? false : (!legacy && entry?.riskReported === true),
  };
}

function writeSegment(file, state, root, next) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...state, [root]: next }));
  } catch {}
}

function denyReason(count, limit, files, scopes = []) {
  const scopeLine = scopes.length >= 2
    ? `本任务段已跨 ${scopes.length} 个作用域（${scopes.join('、')}），超出 Tier 1 的单一作用域限制。`
    : `本任务段已在主 checkout（main）写了 ${count} 个不同源文件，达到 Tier 1 上限 ${limit}；再写会超出 Tier 1。`;
  return [
    scopeLine,
    `已写：${files.join('、')}`,
    '先停手，按范围改走对应通道（不要继续原地写）：',
    TIER_2_DEFINITION,
    TIER_3_DEFINITION,
    '已写的改动保留在工作区，不要回滚；若选择交接，把它们列进交接内容的「当前状态」。',
    '这是需要用户确认的越级写入：用户若在确认框放行才继续；不要改用 Bash 等方式绕过。',
  ].join('\n');
}

function churnReason(turns) {
  return [
    `[tier-gate] 本任务段已连续 ${turns} 轮只重复修改此前改过的业务文件，没有推进到新文件：这不是「一次小范围改动」，是原地反复试错。`,
    '先不要再改文件。向用户汇报：反复了几轮、每轮改了什么、卡在哪里。然后择一破局：',
    '- 疑难 Bug / 视野盲区：先用 /paseo-advisor（异构第二意见）、/paseo-committee（双模型会诊）或 /diagnosing-bugs 建最小复现，不要继续盲改。',
    '- 复杂度超预期：进 linked worktree 或用 /tier2-handoff（填 Slices 后调 /paseo-handoff）交给 worktree 里的 Agent，必写「## What was tried」。',
    '用户明确要求继续时，才在本任务段里继续改；不要改用 Bash 等方式绕过这次汇报。',
  ].join('\n');
}

function planDenyReason(declared, files, scopes, limit) {
  return [
    `[tier-gate] 计划已超出 Tier 1：${files.length} 个源文件、${scopes.length} 个作用域（Tier 1 上限 ${limit} 个源文件、单一作用域；测试和文档不计数）。`,
    `声明：tier=${declared.tier} files=${files.join('、')}`,
    '先选对通道，不要继续原地写：',
    TIER_2_DEFINITION,
    TIER_3_DEFINITION,
  ].join('\n');
}

/**
 * 判定一次写入。主 checkout 仅允许 Tier 1（≤3 源文件、单一作用域），超限触发 ask/deny。
 * @param {{target: string, sessionId?: string, declared?: {tier: 1|2, files: string[]}}} input
 */
export function assessTierGate({ target, sessionId, declared }) {
  if (process.env.PIPELINE_TIER_GATE === 'off') return { verdict: 'allow', note: 'gate off' };
  if (typeof sessionId !== 'string' || sessionId === '') return { verdict: 'allow', note: 'no session id' };
  if (typeof target !== 'string' || target === '') return { verdict: 'allow', note: 'no target' };

  const ctx = repoContext(target);
  if (ctx === null) return { verdict: 'allow', note: 'not a readable git repo' };
  if (!ctx.isPrimary) return { verdict: 'allow', note: 'not the primary checkout' };

  const rel = relativeInRepo(target, ctx.root);
  if (rel === null) return { verdict: 'allow', note: 'outside repo' };
  if (rel === 'openspec' || rel.startsWith('openspec/')) return { verdict: 'allow', note: 'openspec artifact' };
  if (rel === '.superpowers' || rel.startsWith('.superpowers/')) return { verdict: 'allow', note: 'gitignored scratch artifact' };
  if (UNCOUNTED(rel)) return { verdict: 'allow', note: 'test/doc file not counted' };

  if (declared && Array.isArray(declared.files) && declared.files.length > 0) {
    const planned = declared.files.filter((f) => !EXEMPT(f));
    const limit = limitFromEnv();
    const scopes = declaredScopes(planned, ctx.root);
    if (declared.tier === 2) {
      return {
        verdict: 'deny',
        reason: [
          '[tier-gate] 声明的是 Tier 2，但当前仍在主 checkout 原地写业务文件。',
          TIER_2_DEFINITION,
          '测试和文档不计数；源文件请在 linked worktree 里改（主会话自己进去即可，闸门在那里放行）。',
          `声明：tier=2 files=${planned.join('、')}`,
        ].join('\n'),
      };
    }
    if (planned.length > limit || scopes.length >= 2) {
      return { verdict: 'deny', reason: planDenyReason(declared, planned, scopes, limit) };
    }
  }

  const file = stateFile(sessionId);
  const state = readState(file);
  const now = Date.now();
  const seg = segment(state[ctx.root], now);
  const counted = seg.files.filter((filePath) => !EXEMPT(filePath));
  const asked = seg.asked.filter((filePath) => !EXEMPT(filePath));
  const keep = {
    turns: seg.turns,
    reported: seg.reported,
    churnReported: seg.churnReported,
    riskReported: seg.riskReported,
    stopFiles: seg.stopFiles,
  };
  if (counted.includes(rel)) return { verdict: 'allow', note: 'already counted' };

  const limit = limitFromEnv();
  const known = [...new Set([...counted, ...asked])];
  const scopes = [...new Set([...known.map(scopeKey), scopeKey(rel)])].sort();
  if (known.length > 0 && scopes.length >= 2) {
    writeSegment(file, state, ctx.root, { ...keep, files: counted, at: now, asked: asked.includes(rel) ? asked : [...asked, rel] });
    return { verdict: 'ask', reason: denyReason(known.length, limit, known, scopes) };
  }
  if (counted.length >= limit) {
    writeSegment(file, state, ctx.root, { ...keep, files: counted, at: now, asked: asked.includes(rel) ? asked : [...asked, rel] });
    return { verdict: 'ask', reason: denyReason(counted.length, limit, counted) };
  }

  writeSegment(file, state, ctx.root, { ...keep, files: [...counted, rel], at: now, asked });
  return { verdict: 'allow' };
}

function dirtySignatures(root) {
  const raw = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000,
  });
  const parts = raw.split('\0').filter(Boolean);
  const sig = {};
  for (let i = 0; i < parts.length; i += 1) {
    const status = parts[i].slice(0, 2);
    const rel = parts[i].slice(3);
    if (status[0] === 'R' || status[0] === 'C') i += 1;
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

export function skipInjection(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return false;
  const ctx = repoContext(cwd);
  return ctx !== null && !ctx.isPrimary;
}

export function takeSnapshot({ cwd, sessionId, isHumanTurn = true }) {
  if (process.env.PIPELINE_TIER_GATE === 'off') return;
  if (typeof sessionId !== 'string' || sessionId === '' || typeof cwd !== 'string' || cwd === '') return;
  const ctx = repoContext(cwd);
  if (ctx === null) return;
  const file = stateFile(sessionId);
  const state = readState(file);
  const prev = state[ctx.root];
  if (isHumanTurn && prev && !Array.isArray(prev)) {
    const inspected = prev.churnReported === true
      || (Number.isInteger(prev.turns) && prev.turns >= turnsFromEnv());
    const resetRisk = prev.riskReported === true;
    if (inspected || resetRisk) {
      writeSegment(file, state, ctx.root, {
        ...prev,
        ...(inspected ? { turns: 0, churnReported: false } : {}),
        ...(resetRisk ? { riskReported: false } : {}),
      });
    }
  }
  const snap = { root: ctx.root, head: git(ctx.root, ['rev-parse', 'HEAD']), sig: dirtySignatures(ctx.root) };
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(snapFile(sessionId), JSON.stringify(snap));
}

function localCommitFiles(root, from, to) {
  return git(root, ['log', '--first-parent', '--no-merges', '--pretty=format:', '--name-only', '--no-renames', `${from}..${to}`, '--not', '--remotes'])
    .split('\n').map((line) => line.trim()).filter(Boolean);
}

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
  } catch {}
  return claimed;
}

function riskStopReason({ hits = [], testMutations = [], caveatRemovals = [] }) {
  const details = [];
  if (hits.length) {
    const classes = [...new Set(hits.map((h) => h.class))].sort();
    const files = [...new Set(hits.map((h) => h.file))].sort();
    details.push(`命中的风险类别：${classes.join('、')}（${files.join('、')}）`);
  }
  if (testMutations.length) {
    details.push(`既有测试或快照/断言变更：${testMutations.map((m) => `${m.file} (${m.reason})`).join('；')}`);
  }
  if (caveatRemovals.length) {
    details.push(`文档/提示词安全约束削弱：${caveatRemovals.map((c) => `${c.file} (${c.reason})`).join('；')}`);
  }
  return [
    '[tier-gate] 本轮 Tier 1 改动触发风险/断言扫描哨兵：',
    ...details,
    '风险不自动升档也无需用户授权，但收口前必须完成：`pipeline-run.mjs risk-scan HEAD` + 1 次独立异构 reviewer（1+1 上限，可用 `anchasi` / `/paseo-advisor`），并在汇报中列出核验结论。',
  ].join('\n');
}

export function assessStop({ cwd, sessionId }) {
  if (process.env.PIPELINE_TIER_GATE === 'off') return { verdict: 'ok' };
  if (typeof sessionId !== 'string' || sessionId === '' || typeof cwd !== 'string' || cwd === '') return { verdict: 'ok' };
  const ctx = repoContext(cwd);
  if (ctx === null) return { verdict: 'ok' };
  const snap = readState(snapFile(sessionId));
  if (snap.root !== ctx.root || typeof snap.sig !== 'object' || snap.sig === null) return { verdict: 'ok' };

  const changed = new Set();
  const current = dirtySignatures(ctx.root);
  for (const [rel, sig] of Object.entries(current)) if (snap.sig[rel] !== sig) changed.add(rel);
  const head = git(ctx.root, ['rev-parse', 'HEAD']);
  const churnTouched = new Set(changed);
  if (head !== snap.head) {
    for (const rel of localCommitFiles(ctx.root, snap.head, head)) {
      changed.add(rel);
      if (!Object.hasOwn(snap.sig, rel)) churnTouched.add(rel);
    }
  }

  const file = stateFile(sessionId);
  const state = readState(file);
  const seg = segment(state[ctx.root]);
  const asked = new Set(seg.asked);
  const claimedByOthers = otherSessionsClaimedFiles(stateDir(), sessionId, ctx.root);
  const business = (rel) => !EXEMPT(rel) && !UNCOUNTED(rel) && !asked.has(rel) && !claimedByOthers.has(rel);
  const round = [...changed].filter(business).sort();
  const combined = [...new Set([...seg.files, ...seg.stopFiles, ...round])].filter(business).sort();
  const limit = limitFromEnv();
  const reportedBefore = new Set(seg.reported);
  const unreported = combined.filter((rel) => !reportedBefore.has(rel));
  const fileLimitBlock = ctx.isPrimary && combined.length > limit && unreported.length > 0;
  const scopes = [...new Set([...combined, ...seg.asked].map(scopeKey))].sort();
  const scopeBlock = ctx.isPrimary && !fileLimitBlock && combined.length > 0 && scopes.length >= 2 && unreported.length > 0;
  const turnLimit = turnsFromEnv();
  const churnRound = round.filter((rel) => churnTouched.has(rel) && !CHURN_EXEMPT(rel));
  const turnsAfter = churnRound.length > 0 ? seg.turns + 1 : seg.turns;
  const previouslyTouched = new Set([...seg.files, ...seg.stopFiles]);
  const fresh = churnRound.filter((rel) => !previouslyTouched.has(rel));
  const churnBlock = turnsAfter >= turnLimit && churnRound.length > 0 && fresh.length === 0 && !seg.churnReported;

  let riskFindings = null;
  let riskBlock = false;
  if (ctx.isPrimary && !fileLimitBlock && !scopeBlock && !churnBlock && !seg.riskReported && changed.size > 0) {
    try {
      const scan = scanRepo({ cwd: ctx.root, base: snap.head, workingTree: true });
      const hits = scan.hits.filter((item) => changed.has(item.file));
      const testMutations = scan.testMutations.filter((item) => changed.has(item.file));
      const caveatRemovals = (scan.caveatRemovals || []).filter((item) => changed.has(item.file));
      if (hits.length > 0 || testMutations.length > 0 || caveatRemovals.length > 0) {
        riskFindings = { hits, testMutations, caveatRemovals };
        riskBlock = true;
      }
    } catch {
      // Fail-open on synthetic or shallow repos
    }
  }

  const block = fileLimitBlock || scopeBlock || churnBlock || riskBlock;

  if (round.length > 0) {
    writeSegment(file, state, ctx.root, {
      files: seg.files,
      stopFiles: combined.filter((rel) => !seg.files.includes(rel)),
      asked: seg.asked,
      at: Date.now(),
      turns: turnsAfter,
      reported: fileLimitBlock || scopeBlock ? combined : seg.reported,
      churnReported: seg.churnReported || churnBlock,
      riskReported: seg.riskReported || riskBlock,
    });
  } else if (fileLimitBlock || scopeBlock || riskBlock) {
    writeSegment(file, state, ctx.root, {
      ...seg,
      reported: fileLimitBlock || scopeBlock ? combined : seg.reported,
      riskReported: seg.riskReported || riskBlock,
    });
  }

  if (!block) return { verdict: 'ok', files: round };
  const limitReason = [
    `[tier-gate] 本任务段在主 checkout（main）上已改动 ${combined.length} 个业务文件，超过 Tier 1 上限 ${limit}，且未经确认。`,
    `本轮改动：${round.join('、') || '（无新增，是上一轮累计）'}`,
    `累计：${combined.join('、')}`,
    '不要再改文件，也不要回滚。先向用户汇报：这次已越出 Tier 1，是否未先探查定界；然后请用户决定由主会话进 worktree（Tier 2）、委派（/tier2-handoff → /paseo-handoff）、走 Tier 3（/paseo-pipeline）或明确放行。',
    '（若其中有文件不是你改的，例如用户或其他会话同时在改，说明这一点即可。）',
  ].join('\n');
  const scopeReason = [
    `[tier-gate] 本任务段在主 checkout（main）上已跨 ${scopes.length} 个作用域（${scopes.join('、')}），超出 Tier 1 的「单目录小范围」，且未经确认。`,
    `本轮改动：${round.join('、') || '（无新增，是上一轮累计）'}`,
    `累计：${combined.join('、')}`,
    '不要再改文件，也不要回滚。先向用户汇报：这次已越出 Tier 1，是否未先探查定界；然后请用户决定由主会话进 worktree（Tier 2）、委派（/tier2-handoff → /paseo-handoff）、走 Tier 3（/paseo-pipeline）或明确放行。',
  ].join('\n');
  const reason = [
    fileLimitBlock ? limitReason : '',
    scopeBlock ? scopeReason : '',
    churnBlock ? churnReason(turnsAfter) : '',
    riskBlock ? riskStopReason(riskFindings) : '',
  ]
    .filter(Boolean).join('\n\n');
  const reportedFiles = (fileLimitBlock || scopeBlock || churnBlock) ? combined : [...changed].sort();
  const reasonCode = fileLimitBlock ? 'file_limit' : (scopeBlock ? 'scope_cross' : (churnBlock ? 'churn' : 'risk_sentinel'));
  recordEvent('tier_stop', { verdict: 'block', reasonCode, tier: ctx.isPrimary ? '1' : '2', count: reportedFiles.length });
  return { verdict: 'block', files: reportedFiles, reason };
}
