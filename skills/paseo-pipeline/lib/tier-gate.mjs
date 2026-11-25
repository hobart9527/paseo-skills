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
  isTestPath,
  scopeKey,
  resolveScopedPath,
} from './paths.mjs';
import { scanRepo } from './risk-scan.mjs';
import { findReviewSignoff } from './review-record.mjs';
import { recordEvent } from './telemetry.mjs';

export { DEFAULT_LIMIT, UNCOUNTED, EXEMPT, scopeKey, resolveScopedPath };
export const DEFAULT_IDLE_MS = 30 * 60 * 1000;
export const DEFAULT_TURNS = 3;
export const DEFAULT_LARGE_FILE_LINES = 800;
export const DEFAULT_TEST_FILE_LIMIT = 5;
export const DEFAULT_WORKTREE_COMPACT_LIMIT = 2;
const MAX_LINE_SCAN_BYTES = 2 * 1024 * 1024;
const PROTECTED_BRANCHES = new Set(['main', 'master']);

// 规则正本是 ~/.claude/CLAUDE.md；这里只放必须看到的精简摘要，阈值与正本一致。
export const TIER_RULES = [
  `仅代码改动任务先只读探查定档（问答/排障/诊断直接按目标执行）：Tier 1 ≤${DEFAULT_LIMIT} 个源文件、单一作用域 → 主 checkout 做；Tier 2 >${DEFAULT_LIMIT} 个源文件、跨作用域、${DEFAULT_LARGE_FILE_LINES}+ 行或>${DEFAULT_TEST_FILE_LIMIT} 测试 → 进 linked worktree（收口必跑 tier2-verify）；Tier 3 ≥4 实质任务且 maxWidth≥3（或 maxWidth≥2 且加速比≥1.8）→ /paseo-pipeline。`,
  '边界：仅风险操作（部署、生产写入、迁移、push）要用户原话授权与回滚方案，只读诊断默认放开；风险代码（鉴权、并发幂等、schema、资金、外部写入或改弱既有测试）须过 risk-scan + 1 个独立 reviewer（1+1 上限），不升档、不需授权。其余见 ~/.claude/CLAUDE.md。',
].join('\n');

const TIER_2_DEFINITION = `Tier 2：>${DEFAULT_LIMIT} 个源文件、跨作用域、≥${DEFAULT_LARGE_FILE_LINES} 行或>${DEFAULT_TEST_FILE_LIMIT} 测试 → 先隔离到 linked worktree；轻会话可自改，重/已压缩/慢规划会话冻结契约后交 gongbu（brief.mjs tier2 / /tier2-handoff → /paseo-handoff，无未冻结共享接口的 ≤2 路不相交垂直切片可并行再合并），收口必跑 tier2-verify。`;
const TIER_3_DEFINITION = 'Tier 3：主会话粗画 DAG 有 ≥4 个实质任务且 maxWidth≥3（或 maxWidth≥2 且加权加速比≥1.8）→ /paseo-pipeline。';

export function tierGateStateDir() {
  return process.env.PIPELINE_TIER_GATE_STATE || path.join(os.tmpdir(), 'paseo-tier-gate');
}
const stateDir = tierGateStateDir;

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

function readHeadSha(root) {
  try {
    const dotGit = path.join(root, '.git');
    const st = fs.lstatSync(dotGit);
    let gitDir = null;
    let commonDir = null;
    if (st.isDirectory()) {
      gitDir = dotGit;
      commonDir = dotGit;
    } else if (st.isFile()) {
      const content = fs.readFileSync(dotGit, 'utf8').trim();
      if (content.startsWith('gitdir:')) {
        gitDir = path.resolve(root, content.slice(7).trim());
        try {
          const commonRel = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim();
          commonDir = commonRel ? path.resolve(gitDir, commonRel) : gitDir;
        } catch {
          commonDir = gitDir;
        }
      }
    }
    if (gitDir) {
      const headText = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
      if (/^[0-9a-f]{40,64}$/i.test(headText)) return headText;
      if (headText.startsWith('ref: ')) {
        const refPath = headText.slice(5).trim();
        for (const base of new Set([gitDir, commonDir])) {
          try {
            const refSha = fs.readFileSync(path.join(base, refPath), 'utf8').trim();
            if (/^[0-9a-f]{40,64}$/i.test(refSha)) return refSha;
          } catch {}
        }
      }
    }
  } catch {}
  return git(root, ['rev-parse', 'HEAD']);
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

function branchFromGitDir(startDir, gitDir) {
  let branch = '';
  try {
    const headText = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (headText.startsWith('ref: refs/heads/')) {
      branch = headText.slice('ref: refs/heads/'.length);
    } else if (/^[0-9a-f]{40,64}$/i.test(headText) || headText.startsWith('ref: ')) {
      branch = '';
    } else {
      try {
        branch = git(startDir, ['symbolic-ref', '--short', '-q', 'HEAD']);
      } catch {
        branch = '';
      }
    }
  } catch {
    try {
      branch = git(startDir, ['symbolic-ref', '--short', '-q', 'HEAD']);
    } catch {
      branch = '';
    }
  }
  return branch;
}

export function repoContext(target) {
  try {
    const dir = deepestExistingDir(target);
    if (!process.env.GIT_DIR && !process.env.GIT_WORK_TREE) {
      let cur = dir;
      for (;;) {
        const dotGit = path.join(cur, '.git');
        let st = null;
        try { st = fs.lstatSync(dotGit); } catch {}
        if (st?.isDirectory()) {
          const root = fs.realpathSync(cur);
          const gitDir = fs.realpathSync(dotGit);
          const branch = branchFromGitDir(dir, gitDir);
          return { root, isPrimary: true, isPrimaryOnProtected: PROTECTED_BRANCHES.has(branch), branch };
        }
        if (st?.isFile()) {
          const content = fs.readFileSync(dotGit, 'utf8').trim();
          if (content.startsWith('gitdir:')) {
            const root = fs.realpathSync(cur);
            const gitDir = fs.realpathSync(path.resolve(cur, content.slice(7).trim()));
            let commonDir = gitDir;
            try {
              const commonRel = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim();
              if (commonRel) commonDir = fs.realpathSync(path.resolve(gitDir, commonRel));
            } catch {}
            const branch = branchFromGitDir(dir, gitDir);
            const isPrimary = gitDir === commonDir;
            return { root, isPrimary, isPrimaryOnProtected: isPrimary && PROTECTED_BRANCHES.has(branch), branch };
          }
        }
        const parent = path.dirname(cur);
        if (parent === cur) return null;
        cur = parent;
      }
    }
    const lines = git(dir, ['rev-parse', '--show-toplevel', '--git-dir', '--git-common-dir']).split(/\r?\n/).filter(Boolean);
    if (lines.length < 3) return null;
    const root = fs.realpathSync(lines[0]);
    const gitDir = fs.realpathSync(path.resolve(dir, lines[1]));
    const commonDir = fs.realpathSync(path.resolve(dir, lines[2]));
    const branch = branchFromGitDir(dir, gitDir);
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

export function sessionStateFile(sessionId) {
  return path.join(stateDir(), `${String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
}
const stateFile = sessionStateFile;

export function readSessionMeta(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return {};
  const raw = readState(sessionStateFile(sessionId)).__meta;
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {};
}

export function writeSessionMeta(sessionId, patch) {
  if (typeof sessionId !== 'string' || !sessionId) return {};
  const file = sessionStateFile(sessionId);
  const state = readState(file);
  const prevMeta = state.__meta && typeof state.__meta === 'object' && !Array.isArray(state.__meta) ? state.__meta : {};
  const nextMeta = { ...prevMeta, ...patch };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...state, __meta: nextMeta }));
  } catch {}
  return nextMeta;
}

export function worktreeCompactLimitFromEnv() {
  const raw = String(process.env.PIPELINE_WORKTREE_COMPACT_LIMIT ?? '').trim().toLowerCase();
  if (raw === '0' || raw === 'off' || raw === 'false') return 0;
  if (!raw) return DEFAULT_WORKTREE_COMPACT_LIMIT;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_WORKTREE_COMPACT_LIMIT;
}

export function incrementCompactCount(sessionId, now = Date.now()) {
  if (typeof sessionId !== 'string' || !sessionId) return { count: 1, at: now };
  const prev = readSessionMeta(sessionId);
  const prevCount = Number.isInteger(prev.compactCount) && prev.compactCount >= 0 ? prev.compactCount : 0;
  const next = writeSessionMeta(sessionId, { compactCount: prevCount + 1, compactAt: now });
  return { count: next.compactCount, at: now };
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

export function tierGateIdleMs() {
  const raw = Number.parseInt(process.env.PIPELINE_TIER_GATE_IDLE_MS ?? '', 10);
  return Number.isInteger(raw) && raw >= 0 ? raw : DEFAULT_IDLE_MS;
}
const idleFromEnv = tierGateIdleMs;

function turnsFromEnv() {
  const raw = Number.parseInt(process.env.PIPELINE_TIER_GATE_TURNS ?? '', 10);
  return Number.isInteger(raw) && raw >= 1 ? raw : DEFAULT_TURNS;
}

function largeFileLinesFromEnv() {
  const raw = Number.parseInt(process.env.PIPELINE_TIER_GATE_LARGE_FILE_LINES ?? '', 10);
  return Number.isInteger(raw) && raw >= 1 ? raw : DEFAULT_LARGE_FILE_LINES;
}

function testFileLimitFromEnv() {
  const raw = Number.parseInt(process.env.PIPELINE_TIER_GATE_TEST_FILE_LIMIT ?? '', 10);
  return Number.isInteger(raw) && raw >= 1 ? raw : DEFAULT_TEST_FILE_LIMIT;
}

function existingFileLineCount(target) {
  try {
    const st = fs.statSync(target);
    if (!st.isFile() || st.size === 0 || st.size > MAX_LINE_SCAN_BYTES) return 0;
    const content = fs.readFileSync(target, 'utf8');
    return content.split(/\r?\n/).length;
  } catch {
    return 0;
  }
}

// Path and scope matchers live in ./paths.mjs (re-exported above).

function targetSig(target) {
  try {
    const st = fs.statSync(target);
    return st.isFile() ? `${st.size}:${st.mtimeMs}` : 'nonfile';
  } catch {
    return 'missing';
  }
}

function isControlArtifact(rel) {
  return rel === 'openspec' || rel.startsWith('openspec/')
    || rel === '.superpowers' || rel.startsWith('.superpowers/');
}

function sigMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
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
    askedSigs: fresh || legacy ? {} : sigMap(entry?.askedSigs),
    askedRules: fresh || legacy ? {} : sigMap(entry?.askedRules),
    approved: fresh ? [] : strings(legacy ? [] : entry?.approved),
    approvedRules: fresh ? [] : strings(legacy ? [] : entry?.approvedRules),
    stopFiles: fresh ? [] : strings(legacy ? [] : entry?.stopFiles),
    reported: fresh ? [] : strings(legacy ? [] : entry?.reported),
    testFiles: fresh ? [] : strings(legacy ? [] : entry?.testFiles),
    turns: fresh ? 0 : (!legacy && Number.isInteger(entry?.turns) ? entry.turns : 0),
    churnReported: fresh ? false : (!legacy && entry?.churnReported === true),
    riskReported: fresh ? false : (!legacy && entry?.riskReported === true),
    riskReportedFiles: fresh ? [] : strings(legacy ? [] : entry?.riskReportedFiles),
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
    '主 checkout 已写有改动时，若用 `EnterWorktree` 建好 clean worktree 可在其内跑 `pipeline-run.mjs escalate-tier2 --into .`，或直接在主 checkout 跑 `pipeline-run.mjs escalate-tier2 <slug>` 一键无损迁入并还原主分支。',
    '这是需要用户确认的越级写入：用户若在确认框放行才继续；不要改用 Bash 等方式绕过。',
  ].join('\n');
}

function churnReason(turns, isPrimary = true) {
  const escalateBullet = isPrimary
    ? '- 复杂度超预期：进 linked worktree 或用 /tier2-handoff（填 Slices 后调 /paseo-handoff）交给 worktree 里的 Agent，必写「## What was tried」。'
    : '- 复杂度超预期：把已确认事实写入 handoff-progress.md 后用 brief.mjs tier2 / /paseo-handoff 切干净切片上下文接力，必写「## What was tried」。';
  return [
    `[tier-gate] 本任务段已连续 ${turns} 轮只重复修改此前改过的业务文件，没有推进到新文件：这不是「一次小范围改动」，是原地反复试错。`,
    '先不要再改文件。向用户汇报：反复了几轮、每轮改了什么、卡在哪里。然后择一破局：',
    '- 疑难 Bug / 视野盲区：先用 /paseo-advisor（异构第二意见）、/paseo-committee（双模型会诊）或 /diagnosing-bugs 建最小复现，不要继续盲改。',
    escalateBullet,
    '用户明确要求继续时，才在本任务段里继续改；不要改用 Bash 等方式绕过这次汇报。',
  ].join('\n');
}

function largeFileReason(rel, lineCount, threshold) {
  return [
    `目标源文件 ${rel} 已有 ${lineCount} 行（≥${threshold} 行大文件红线），主 checkout 原地改易造成爆炸半径失控与上下文膨胀。`,
    '先停手，改走 Tier 2 linked worktree（若复杂度高，先跑 Stage 0/1 `prepare-author --schema paseo-tier2` + `chanpin` 生成 `baseline-facts.md`，再按切片接力或交接）：',
    TIER_2_DEFINITION,
    '若确实只需微调且经用户放行，请在确认框放行后继续。',
  ].join('\n');
}

function testBlastReason(rel, limit, testFiles) {
  return [
    `本任务段已在主 checkout 修改了 ${testFiles.length} 个测试文件，新增 ${rel} 将超过 ${limit} 个测试文件上限：测试爆炸半径已进入 Tier 2 量级。`,
    `已改测试：${testFiles.join('、')}`,
    TIER_2_DEFINITION,
    '用户若在确认框放行才继续；建议直接进 linked worktree 并走 `paseo-tier2` / 切片接力。',
  ].join('\n');
}

/**
 * 判定一次写入。主 checkout 仅允许 Tier 1（≤3 源文件、单一作用域，且避开 ≥800 行大文件与 >5 个测试文件爆炸），超限触发 ask/deny。
 * @param {{target: string, sessionId?: string}} input
 */
export function assessTierGate({ target, sessionId }) {
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

  const file = stateFile(sessionId);
  const state = readState(file);
  const now = Date.now();
  const seg = segment(state[ctx.root], now);
  let counted = seg.files.filter((filePath) => !EXEMPT(filePath));
  const trackableAsked = (filePath) => !isControlArtifact(filePath) && (!UNCOUNTED(filePath) || isTestPath(filePath));
  let asked = seg.asked.filter(trackableAsked);
  const askedSigs = { ...seg.askedSigs };
  const askedRules = { ...seg.askedRules };
  let approved = seg.approved.filter(trackableAsked);
  let approvedRules = [...seg.approvedRules];
  let testFiles = [...seg.testFiles];
  let promotedThisCall = false;
  let promotedAny = false;

  for (const prevRel of [...asked]) {
    const prevTarget = prevRel === rel ? target : path.join(ctx.root, prevRel);
    if (typeof askedSigs[prevRel] === 'string' && targetSig(prevTarget) !== askedSigs[prevRel]) {
      asked = asked.filter((filePath) => filePath !== prevRel);
      delete askedSigs[prevRel];
      const rule = askedRules[prevRel];
      delete askedRules[prevRel];
      if (!approved.includes(prevRel)) approved = [...approved, prevRel];
      if ((rule === 'file_limit' || rule === 'scope_cross') && !approvedRules.includes(rule)) {
        approvedRules = [...approvedRules, rule];
      }
      if (UNCOUNTED(prevRel)) {
        if (isTestPath(prevRel) && !testFiles.includes(prevRel)) testFiles = [...testFiles, prevRel];
      } else if (!counted.includes(prevRel)) {
        counted = [...counted, prevRel];
      }
      promotedAny = true;
      if (prevRel === rel) promotedThisCall = true;
    }
  }

  const keep = {
    turns: seg.turns,
    reported: seg.reported,
    churnReported: seg.churnReported,
    riskReported: seg.riskReported,
    riskReportedFiles: seg.riskReportedFiles,
    stopFiles: seg.stopFiles,
    testFiles,
    askedSigs,
    askedRules,
    approved,
    approvedRules,
  };

  if (UNCOUNTED(rel)) {
    if (isTestPath(rel) && !testFiles.includes(rel)) {
      const testLimit = testFileLimitFromEnv();
      if (testFiles.length >= testLimit) {
        askedSigs[rel] = targetSig(target);
        askedRules[rel] = 'test_blast';
        writeSegment(file, state, ctx.root, { ...keep, files: counted, at: now, asked: asked.includes(rel) ? asked : [...asked, rel], askedSigs, askedRules });
        return { verdict: 'ask', reasonCode: 'test_blast', reason: testBlastReason(rel, testLimit, testFiles) };
      }
      testFiles = [...testFiles, rel];
      writeSegment(file, state, ctx.root, { ...keep, files: counted, at: now, asked, testFiles });
    } else if (promotedAny) {
      writeSegment(file, state, ctx.root, { ...keep, files: counted, at: now, asked });
    }
    return { verdict: 'allow', note: promotedThisCall ? 'already approved' : 'test/doc file not counted' };
  }

  if (counted.includes(rel)) {
    if (promotedAny) writeSegment(file, state, ctx.root, { ...keep, files: counted, at: now, asked });
    return { verdict: 'allow', note: promotedThisCall ? 'already approved' : 'already counted' };
  }

  const limit = limitFromEnv();
  const known = [...new Set([...counted, ...asked.filter((filePath) => !EXEMPT(filePath))])];
  const scopes = [...new Set([...known.map(scopeKey), scopeKey(rel)])].sort();
  if (known.length > 0 && scopes.length >= 2 && !approvedRules.includes('scope_cross')) {
    askedSigs[rel] = targetSig(target);
    askedRules[rel] = 'scope_cross';
    writeSegment(file, state, ctx.root, { ...keep, files: counted, at: now, asked: asked.includes(rel) ? asked : [...asked, rel], askedSigs, askedRules });
    return { verdict: 'ask', reasonCode: 'scope_cross', reason: denyReason(known.length, limit, known, scopes) };
  }
  if (counted.length >= limit && !approvedRules.includes('file_limit')) {
    askedSigs[rel] = targetSig(target);
    askedRules[rel] = 'file_limit';
    writeSegment(file, state, ctx.root, { ...keep, files: counted, at: now, asked: asked.includes(rel) ? asked : [...asked, rel], askedSigs, askedRules });
    return { verdict: 'ask', reasonCode: 'file_limit', reason: denyReason(counted.length, limit, counted) };
  }

  const largeFileLines = largeFileLinesFromEnv();
  const lineCount = existingFileLineCount(target);
  if (lineCount >= largeFileLines) {
    askedSigs[rel] = targetSig(target);
    askedRules[rel] = 'large_file';
    writeSegment(file, state, ctx.root, { ...keep, files: counted, at: now, asked: asked.includes(rel) ? asked : [...asked, rel], askedSigs, askedRules });
    return { verdict: 'ask', reasonCode: 'large_file', reason: largeFileReason(rel, lineCount, largeFileLines) };
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

export function skipInjection(cwd, precomputedCtx = undefined) {
  if (typeof cwd !== 'string' || cwd === '') return false;
  const ctx = precomputedCtx === undefined ? repoContext(cwd) : precomputedCtx;
  return ctx !== null && !ctx.isPrimary;
}

export function takeSnapshot({ cwd, sessionId, isHumanTurn = true, ctx: precomputedCtx } = {}) {
  if (process.env.PIPELINE_TIER_GATE === 'off') return;
  if (typeof sessionId !== 'string' || sessionId === '' || typeof cwd !== 'string' || cwd === '') return;
  const ctx = precomputedCtx === undefined ? repoContext(cwd) : precomputedCtx;
  if (ctx === null) return;
  const file = stateFile(sessionId);
  const state = readState(file);
  const prev = state[ctx.root];
  let effectivePrev = prev;
  if (isHumanTurn && prev && !Array.isArray(prev)) {
    const inspected = prev.churnReported === true
      || (Number.isInteger(prev.turns) && prev.turns >= turnsFromEnv());
    const resetRisk = prev.riskReported === true;
    if (inspected || resetRisk) {
      effectivePrev = {
        ...prev,
        ...(inspected ? { turns: 0, churnReported: false } : {}),
        ...(resetRisk ? { riskReported: false } : {}),
      };
      writeSegment(file, state, ctx.root, effectivePrev);
    }
  }
  const prevSeg = segment(effectivePrev);
  const knownFiles = [...new Set([...prevSeg.files, ...prevSeg.stopFiles, ...prevSeg.asked])];
  const snap = { root: ctx.root, head: readHeadSha(ctx.root), sig: dirtySignatures(ctx.root), knownFiles, at: Date.now() };
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(snapFile(sessionId), JSON.stringify(snap));
}

function localCommitFiles(root, from, to) {
  return git(root, ['log', '--first-parent', '--no-merges', '--pretty=format:', '--name-only', '--no-renames', `${from}..${to}`, '--not', '--remotes'])
    .split('\n').map((line) => line.trim()).filter(Boolean);
}

const CLAIM_RACE_GRACE_MS = 2000;

export function otherSessionsClaimedFiles(dir, currentSessionId, root, now = Date.now(), sinceAt = 0) {
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
      if (at > 0 && now - at < idleFromEnv() && (sinceAt <= 0 || at >= sinceAt - CLAIM_RACE_GRACE_MS)) {
        const files = Array.isArray(entry.files) ? entry.files : [];
        const asked = Array.isArray(entry.asked) ? entry.asked : [];
        for (const f of files) claimed.add(f);
        for (const f of asked) claimed.add(f);
      }
    }
  } catch {}
  return claimed;
}

function riskStopReason({ hits = [], testMutations = [], caveatRemovals = [] }, baseSha = 'HEAD') {
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
    `风险不自动升档也无需用户授权，但收口前必须完成：\`pipeline-run.mjs risk-scan ${baseSha || 'HEAD'}\` + 1 次独立异构 reviewer（1+1 上限，可用 \`anchasi\` / \`/paseo-advisor\`，并用 \`pipeline-run.mjs record-review --mode tier1\` 登记），并在汇报中列出核验结论。`,
  ].join('\n');
}

export function assessStop({ cwd, sessionId }) {
  if (process.env.PIPELINE_TIER_GATE === 'off') return { verdict: 'ok' };
  if (typeof sessionId !== 'string' || sessionId === '' || typeof cwd !== 'string' || cwd === '') return { verdict: 'ok' };
  const snap = readState(snapFile(sessionId));
  if (!snap.root || typeof snap.sig !== 'object' || snap.sig === null) return { verdict: 'ok' };
  const ctx = repoContext(cwd);
  if (ctx === null || snap.root !== ctx.root) return { verdict: 'ok' };

  const changed = new Set();
  const current = dirtySignatures(ctx.root);
  for (const [rel, sig] of Object.entries(current)) if (snap.sig[rel] !== sig) changed.add(rel);
  const head = readHeadSha(ctx.root);
  const churnTouched = new Set(changed);
  if (head !== snap.head) {
    for (const rel of localCommitFiles(ctx.root, snap.head, head)) {
      changed.add(rel);
      if (!Object.hasOwn(snap.sig, rel)) churnTouched.add(rel);
    }
  }

  if (changed.size === 0) {
    return { verdict: 'ok', files: [] };
  }

  const file = stateFile(sessionId);
  const state = readState(file);
  const seg = segment(state[ctx.root]);
  const asked = new Set(seg.asked);
  const approved = new Set(seg.approved);
  const sinceAt = typeof snap.at === 'number' && snap.at > 0 ? snap.at : 0;
  const claimedByOthers = otherSessionsClaimedFiles(stateDir(), sessionId, ctx.root, Date.now(), sinceAt);
  const selfOwned = new Set([...seg.files, ...seg.stopFiles]);
  const isOtherClaim = (rel) => claimedByOthers.has(rel) && !selfOwned.has(rel);
  const business = (rel) => !EXEMPT(rel) && !UNCOUNTED(rel) && !asked.has(rel) && !approved.has(rel) && !isOtherClaim(rel);
  const round = [...changed].filter(business).sort();
  const combined = [...new Set([...seg.files, ...seg.stopFiles, ...round])].filter(business).sort();
  const limit = limitFromEnv();
  const reportedBefore = new Set(seg.reported);
  const unreported = combined.filter((rel) => !reportedBefore.has(rel));
  const fileLimitBlock = ctx.isPrimary && !seg.approvedRules.includes('file_limit') && combined.length > limit && unreported.length > 0;
  const scopes = [...new Set([...combined, ...seg.asked.filter((rel) => !EXEMPT(rel))].map(scopeKey))].sort();
  const scopeBlock = ctx.isPrimary && !seg.approvedRules.includes('scope_cross') && !fileLimitBlock && combined.length > 0 && scopes.length >= 2 && unreported.length > 0;

  const largeFileLines = largeFileLinesFromEnv();
  const knownBefore = new Set([...seg.files, ...seg.stopFiles, ...seg.asked, ...seg.approved, ...seg.reported]);
  const stopLargeHits = ctx.isPrimary
    ? round
      .filter((rel) => !knownBefore.has(rel))
      .map((rel) => ({ rel, lines: existingFileLineCount(path.join(ctx.root, rel)) }))
      .filter((item) => item.lines >= largeFileLines)
    : [];
  const largeFileBlock = ctx.isPrimary && !fileLimitBlock && !scopeBlock && stopLargeHits.length > 0;

  const testLimit = testFileLimitFromEnv();
  const changedTestFiles = ctx.isPrimary
    ? [...changed].filter((rel) => !isControlArtifact(rel) && isTestPath(rel) && !asked.has(rel) && !approved.has(rel) && !isOtherClaim(rel)).sort()
    : [];
  const unapprovedNewTests = changedTestFiles.filter((rel) => !seg.testFiles.includes(rel) && !reportedBefore.has(rel));
  const allTestFiles = [...new Set([...seg.testFiles, ...changedTestFiles])].filter((rel) => !asked.has(rel) && !approved.has(rel)).sort();
  const testBlastBlock = ctx.isPrimary && allTestFiles.length > testLimit && unapprovedNewTests.length > 0;

  const turnLimit = turnsFromEnv();
  const churnBusiness = (rel) => !EXEMPT(rel) && !UNCOUNTED(rel) && !isOtherClaim(rel);
  const churnRound = [...changed].filter((rel) => churnBusiness(rel) && churnTouched.has(rel) && !CHURN_EXEMPT(rel));
  const previouslyTouched = Array.isArray(snap.knownFiles)
    ? new Set(snap.knownFiles)
    : new Set([...seg.files, ...seg.stopFiles, ...seg.asked]);
  const fresh = churnRound.filter((rel) => !previouslyTouched.has(rel));
  const turnsAfter = churnRound.length === 0 ? seg.turns : (fresh.length > 0 ? 1 : seg.turns + 1);
  const churnBlock = turnsAfter >= turnLimit && churnRound.length > 0 && fresh.length === 0 && !seg.churnReported;

  let riskFindings = null;
  let riskBlock = false;
  const dirtyTree = Object.keys(current).length > 0;
  const tier1Signoff = !dirtyTree && head !== snap.head
    ? findReviewSignoff({ cwd: ctx.root, sha: head, mode: 'tier1' })
    : null;
  const tier1Satisfied = ['PASS', 'HUMAN_ACCEPT'].includes(tier1Signoff?.verdict);
  const reportedRiskFiles = new Set(seg.riskReportedFiles);
  const shouldFlagRisk = (filePath) => changed.has(filePath) && !(reportedRiskFiles.has(filePath) && !churnTouched.has(filePath));
  if (ctx.isPrimary && !fileLimitBlock && !scopeBlock && !largeFileBlock && !testBlastBlock && !churnBlock && !seg.riskReported && changed.size > 0 && !tier1Satisfied) {
    try {
      const scan = scanRepo({ cwd: ctx.root, base: snap.head, workingTree: true });
      const hits = scan.hits.filter((item) => shouldFlagRisk(item.file));
      const testMutations = scan.testMutations.filter((item) => shouldFlagRisk(item.file));
      const caveatRemovals = (scan.caveatRemovals || []).filter((item) => shouldFlagRisk(item.file));
      if (hits.length > 0 || testMutations.length > 0 || caveatRemovals.length > 0) {
        riskFindings = { hits, testMutations, caveatRemovals };
        riskBlock = true;
      }
    } catch {
      // Fail-open on synthetic or shallow repos
    }
  }

  const block = fileLimitBlock || scopeBlock || largeFileBlock || testBlastBlock || churnBlock || riskBlock;
  const nextReported = [...new Set([
    ...seg.reported,
    ...(fileLimitBlock || scopeBlock ? combined : []),
    ...(largeFileBlock ? stopLargeHits.map((item) => item.rel) : []),
    ...(testBlastBlock ? unapprovedNewTests : []),
  ])];
  const nextTestFiles = [...new Set([...seg.testFiles, ...(testBlastBlock ? unapprovedNewTests : [])])];
  const newlyReportedRisk = riskBlock
    ? [
        ...riskFindings.hits.map((h) => h.file),
        ...riskFindings.testMutations.map((m) => m.file),
        ...riskFindings.caveatRemovals.map((c) => c.file),
      ]
    : [];
  const nextRiskReportedFiles = [...new Set([...seg.riskReportedFiles, ...newlyReportedRisk])];

  if (round.length > 0 || churnRound.length > 0 || testBlastBlock) {
    writeSegment(file, state, ctx.root, {
      files: seg.files,
      stopFiles: combined.filter((rel) => !seg.files.includes(rel)),
      asked: seg.asked,
      askedSigs: seg.askedSigs,
      askedRules: seg.askedRules,
      approved: seg.approved,
      approvedRules: seg.approvedRules,
      testFiles: nextTestFiles,
      at: Date.now(),
      turns: turnsAfter,
      reported: nextReported,
      churnReported: seg.churnReported || churnBlock,
      riskReported: seg.riskReported || riskBlock,
      riskReportedFiles: nextRiskReportedFiles,
    });
  } else if (fileLimitBlock || scopeBlock || largeFileBlock || riskBlock) {
    writeSegment(file, state, ctx.root, {
      ...seg,
      askedSigs: seg.askedSigs,
      approved: seg.approved,
      at: Date.now(),
      turns: turnsAfter,
      reported: nextReported,
      churnReported: seg.churnReported || churnBlock,
      riskReported: seg.riskReported || riskBlock,
      riskReportedFiles: nextRiskReportedFiles,
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
  const stopLargeReason = largeFileBlock
    ? `[tier-gate] 本轮通过 Bash 改动了大文件：\n${stopLargeHits.map((item) => largeFileReason(item.rel, item.lines, largeFileLines)).join('\n')}`
    : '';
  const stopTestBlastReason = testBlastBlock
    ? `[tier-gate] 本轮通过 Bash 新增/改动测试使本任务段测试文件达到 ${allTestFiles.length} 个：\n${testBlastReason(unapprovedNewTests[0], testLimit, allTestFiles)}`
    : '';
  const reason = [
    fileLimitBlock ? limitReason : '',
    scopeBlock ? scopeReason : '',
    stopLargeReason,
    stopTestBlastReason,
    churnBlock ? churnReason(turnsAfter, ctx.isPrimary) : '',
    riskBlock ? riskStopReason(riskFindings, snap.head) : '',
  ]
    .filter(Boolean).join('\n\n');
  const reportedFiles = (fileLimitBlock || scopeBlock || churnBlock) ? combined : [...changed].sort();
  const reasonCode = fileLimitBlock
    ? 'file_limit'
    : (scopeBlock ? 'scope_cross'
      : (largeFileBlock ? 'large_file'
        : (testBlastBlock ? 'test_blast'
          : (churnBlock ? 'churn' : 'risk_sentinel'))));
  recordEvent('tier_stop', { verdict: 'block', reasonCode, tier: ctx.isPrimary ? '1' : '2', count: reportedFiles.length });
  return { verdict: 'block', reasonCode, files: reportedFiles, reason };
}
