// O(1) per-session anti-thrashing and empty-specs compaction guard for contract authoring (ADR-0007).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { repoContext, logHookError } from './tier-gate.mjs';
import { recordEvent } from './telemetry.mjs';

export const DEFAULT_WARN_READS = 15;
export const DEFAULT_STOP_READS = 25;
export const DEFAULT_WARN_MIN = 10;
export const DEFAULT_STOP_MIN = 18;
export const DEFAULT_RECON_WARN_READS = 15;
const NEGATIVE_CACHE_TTL_MS = 60_000;
const RECON_IDLE_MS = 45 * 60_000;

function dirMtimeMs(dir) {
  try { return fs.statSync(dir).mtimeMs; } catch { return null; }
}

function realOrResolved(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

function stateDir() {
  return process.env.PIPELINE_TIER_GATE_STATE || path.join(os.tmpdir(), 'paseo-tier-gate');
}

function guardStateFile(sessionId) {
  const hash = crypto.createHash('sha1').update(String(sessionId)).digest('hex').slice(0, 12);
  return path.join(stateDir(), `ag-${hash}.json`);
}

function intEnv(name, fallback) {
  const raw = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isInteger(raw) && raw >= 1 ? raw : fallback;
}

export function guardThresholds() {
  return {
    warnReads: intEnv('PIPELINE_AUTHOR_WARN_READS', DEFAULT_WARN_READS),
    stopReads: intEnv('PIPELINE_AUTHOR_STOP_READS', DEFAULT_STOP_READS),
    warnMin: intEnv('PIPELINE_AUTHOR_WARN_MIN', DEFAULT_WARN_MIN),
    stopMin: intEnv('PIPELINE_AUTHOR_STOP_MIN', DEFAULT_STOP_MIN),
  };
}

function hasAnySpecFile(specsDir) {
  if (!fs.existsSync(specsDir)) return false;
  const stack = [specsDir];
  while (stack.length > 0) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      if (ent.isFile() && ent.name === 'spec.md') return true;
      if (ent.isDirectory()) stack.push(path.join(cur, ent.name));
    }
  }
  return false;
}

function gitStatusLines(root, args) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function hasFilledTasks(changeDir) {
  const tasksFile = path.join(changeDir, 'tasks.md');
  if (!fs.existsSync(tasksFile)) return false;
  try {
    const content = fs.readFileSync(tasksFile, 'utf8');
    // Unfilled scaffold templates from openspec-schema-tier2 still contain template placeholders.
    if (content.includes('path/to/file.mjs') || content.includes('<一句话目标>')) return false;
    return true;
  } catch {
    return true;
  }
}

function isAuthorChangeRoot(changeDir) {
  if (fs.existsSync(path.join(changeDir, 'proposal.md'))) return true;
  if (fs.existsSync(path.join(changeDir, 'baseline-facts.md'))) return true;
  const metaPath = path.join(changeDir, '.openspec.yaml');
  if (!fs.existsSync(metaPath)) return false;
  try {
    return /^schema:\s*(?:paseo-pipeline|paseo-tier2)\s*$/m.test(fs.readFileSync(metaPath, 'utf8'));
  } catch {
    return false;
  }
}

export function detectActiveAuthorChange(cwd) {
  try {
    if (typeof cwd !== 'string' || cwd.trim() === '') return null;
    const ctx = repoContext(cwd);
    if (!ctx) return null;
    const changesRoot = path.join(ctx.root, 'openspec', 'changes');
    if (!fs.existsSync(changesRoot)) return null;

    let entries;
    try { entries = fs.readdirSync(changesRoot, { withFileTypes: true }); } catch { return null; }

    const statusFiles = gitStatusLines(ctx.root, ['status', '--porcelain=v1', '--untracked-files=all', '--', 'openspec/changes']);
    const headFiles = gitStatusLines(ctx.root, ['show', '--pretty=format:', '--name-only', 'HEAD', '--', 'openspec/changes']);
    const touchedText = [...statusFiles, ...headFiles].join('\n');

    const candidates = [];
    for (const ent of entries) {
      if (!ent.isDirectory() || ent.name === 'archive') continue;
      const change = ent.name;
      const changeDir = path.join(changesRoot, change);
      if (hasFilledTasks(changeDir)) continue;
      if (!isAuthorChangeRoot(changeDir)) continue;
      const hasSpecs = hasAnySpecFile(path.join(changeDir, 'specs'));
      const prefix = `openspec/changes/${change}/`;
      const touched = touchedText.includes(prefix);
      if (!hasSpecs || touched) {
        candidates.push({ root: ctx.root, change, changeDir, hasSpecs, touched });
      }
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => {
      if (a.hasSpecs !== b.hasSpecs) return a.hasSpecs ? 1 : -1;
      if (a.touched !== b.touched) return a.touched ? -1 : 1;
      return a.change.localeCompare(b.change);
    });
    return candidates[0];
  } catch (err) {
    logHookError('author-guard:detect', err);
    return null;
  }
}

const READ_ONLY_CMD_RE = /^(?:rg|grep|egrep|fgrep|ag|ack|cat|head|tail|less|more|bat|sed\s+-n|ls|exa|eza|find|fd|tree|wc|stat|file|pwd|which|type|git\s+(?:(?:(?:-C|--git-dir|--work-tree)\s+\S+\s+)*(?:status|log|show|diff|grep|ls-files|rev-parse|branch(?:\s|$))))\b/;
const MUTATION_OR_SCRIPT_RE = /\b(?:rm|mv|cp|mkdir|rmdir|touch|chmod|chown|ln|tee|sed\s+-i|perl\s+-pi|npm|pnpm|yarn|bun|pip|openspec\s+validate|pipeline-run\.mjs|freeze-check\.mjs|acceptance-sync\.mjs|tier2-verify\.mjs)\b|\bgit\s+(?:add|commit|checkout|switch|merge|rebase|reset|worktree|push|pull|fetch)\b/;
const LEADING_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"\n]*"|'[^'\n]*'|[^\s;&|()]+)(?:\s+|$)/;
const SIMPLE_CD_RE = /^cd\s+(?:-P\s+|-L\s+)?(?:"[^"\n]+"|'[^'\n]+'|[^\s;&|()]+)$/;
const HAS_CMD_SUBST_RE = /\$\(|`/;

function stripLeadingAssignments(segment) {
  let rest = segment.trimStart();
  for (;;) {
    const match = rest.match(LEADING_ASSIGN_RE);
    if (!match) break;
    if (HAS_CMD_SUBST_RE.test(match[0])) return null;
    rest = rest.slice(match[0].length).trimStart();
  }
  return rest;
}

export function isReadOnlyBash(command) {
  if (typeof command !== 'string') return false;
  const trimmed = command.trim();
  if (!trimmed) return false;
  // Strip harmless fd/devnull redirections before checking for file output redirects.
  const strippedRedirects = trimmed.replace(/\b[12]?>\/dev\/null\b/g, '').replace(/\b2>&1\b/g, '').replace(/\b>&2\b/g, '');
  if (/>/.test(strippedRedirects)) return false;
  if (MUTATION_OR_SCRIPT_RE.test(trimmed)) return false;
  const segments = trimmed.split(/\s*(?:\|\||&&|\||;)\s*/).map((s) => s.trim()).filter(Boolean);
  if (!segments.length) return false;
  let hasReadCmd = false;
  for (const seg of segments) {
    const rest = stripLeadingAssignments(seg);
    if (rest === null) return false;
    if (!rest) continue;
    if (/^(?:echo|printf)\b/.test(rest) && !HAS_CMD_SUBST_RE.test(rest)) continue;
    if (SIMPLE_CD_RE.test(rest) && !HAS_CMD_SUBST_RE.test(rest)) continue;
    if (!READ_ONLY_CMD_RE.test(rest)) return false;
    hasReadCmd = true;
  }
  return hasReadCmd;
}

function repoRelativeSourcePath(cwd, target, { skipChangesOnly = false } = {}) {
  if (typeof target !== 'string' || !target.trim()) return null;
  const ctx = repoContext(cwd);
  if (!ctx) return null;
  const targetAbs = realOrResolved(path.isAbsolute(target) ? target : path.resolve(cwd, target));
  const rel = path.relative(ctx.root, targetAbs).split(path.sep).join('/');
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  if (skipChangesOnly ? (rel === 'openspec/changes' || rel.startsWith('openspec/changes/')) : (rel === 'openspec' || rel.startsWith('openspec/'))) {
    return null;
  }
  return { ctx, rel };
}

function readState(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state));
}

function resolveCachedActiveChange({ cwd, existing, now }) {
  const cwdKey = realOrResolved(cwd);
  const sameCwd = existing
    && (existing.cwd === cwdKey || (existing.root && existing.cwd === existing.root && cwdKey === existing.root));

  if (sameCwd) {
    if (existing.change && existing.root && existing.changeDir) {
      const hasTasks = hasFilledTasks(existing.changeDir);
      const hasRoot = !hasTasks && isAuthorChangeRoot(existing.changeDir);
      const changesMtimeMs = dirMtimeMs(path.join(existing.root, 'openspec', 'changes'));
      if (hasRoot && !hasTasks && changesMtimeMs === existing.changesMtimeMs) {
        return {
          active: { root: existing.root, change: existing.change, changeDir: existing.changeDir },
          cacheHit: true,
          cwdKey,
          root: existing.root,
          changesMtimeMs,
        };
      }
    } else if (existing.change === null) {
      const changesMtimeMs = existing.root ? dirMtimeMs(path.join(existing.root, 'openspec', 'changes')) : null;
      const fresh = now - (existing.detectedAt ?? 0) < NEGATIVE_CACHE_TTL_MS;
      if (changesMtimeMs === existing.changesMtimeMs && fresh) {
        return {
          active: null,
          cacheHit: true,
          cwdKey,
          root: existing.root ?? null,
          changesMtimeMs,
        };
      }
    }
  }

  const active = detectActiveAuthorChange(cwd);
  const root = active?.root ?? repoContext(cwd)?.root ?? null;
  const changesMtimeMs = root ? dirMtimeMs(path.join(root, 'openspec', 'changes')) : null;
  return { active, cacheHit: false, cwdKey, root, changesMtimeMs };
}

export function recordAuthorRead({ cwd, sessionId, command, toolName, target, now = Date.now() } = {}) {
  try {
    if (process.env.PIPELINE_TIER_GATE === 'off' || process.env.PIPELINE_AUTHOR_GUARD === 'off') {
      return { action: 'none' };
    }
    if (typeof sessionId !== 'string' || !sessionId) return { action: 'none' };
    if (typeof cwd !== 'string' || !cwd.trim()) return { action: 'none' };
    let readRel = null;
    if (toolName === 'Read') {
      const info = repoRelativeSourcePath(cwd, target, { skipChangesOnly: true });
      if (!info) return { action: 'none' };
      readRel = info.rel;
    } else if (!isReadOnlyBash(command)) {
      return { action: 'none' };
    }

    const file = guardStateFile(sessionId);
    const existing = readState(file);
    const { active, cacheHit, cwdKey, root, changesMtimeMs } = resolveCachedActiveChange({ cwd, existing, now });
    if (!active) {
      if (!cacheHit) {
        writeState(file, {
          cwd: cwdKey,
          root,
          change: null,
          changeDir: null,
          changesMtimeMs,
          detectedAt: now,
          startedAt: now,
          readCount: 0,
          warnSent: false,
          stopSent: false,
          fileReads: {},
          repeatWarnedFiles: {},
        });
      }
      return { action: 'none', cacheHit };
    }

    const sameChange = existing && existing.root === active.root && existing.change === active.change;
    const plainObj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? { ...v } : {});
    const state = {
      cwd: cwdKey,
      root: active.root,
      change: active.change,
      changeDir: active.changeDir,
      changesMtimeMs,
      detectedAt: cacheHit ? (existing?.detectedAt ?? now) : now,
      startedAt: sameChange && typeof existing.startedAt === 'number' ? existing.startedAt : now,
      readCount: sameChange && Number.isInteger(existing.readCount) ? existing.readCount : 0,
      warnSent: sameChange ? Boolean(existing.warnSent) : false,
      stopSent: sameChange ? Boolean(existing.stopSent) : false,
      fileReads: sameChange ? plainObj(existing.fileReads) : {},
      repeatWarnedFiles: sameChange ? plainObj(existing.repeatWarnedFiles) : {},
    };

    state.readCount += 1;
    if (readRel) {
      state.fileReads[readRel] = (Number.isInteger(state.fileReads[readRel]) ? state.fileReads[readRel] : 0) + 1;
    }
    const elapsedMs = Math.max(0, now - state.startedAt);
    const elapsedMin = elapsedMs / 60_000;
    const { warnReads, stopReads, warnMin, stopMin } = guardThresholds();

    if (!state.stopSent && (state.readCount >= stopReads || elapsedMin >= stopMin)) {
      state.stopSent = true;
      state.warnSent = true;
      writeState(file, state);
      recordEvent('author_guard', {
        action: 'advise',
        reasonCode: 'author_thrash_stop',
        count: state.readCount,
        durationMs: Math.round(elapsedMs),
      });
      return {
        action: 'stop',
        reasonCode: 'author_thrash_stop',
        readCount: state.readCount,
        elapsedMin,
        cacheHit,
        message: `[author-guard] Thrashing limit reached (${state.readCount} read-only commands, ${Math.floor(elapsedMin)}m) on "${active.change}" without completing tasks.md. Stop reading source files and return INCOMPLETE with verified findings, missing facts, and remaining contract artifacts.`,
      };
    }

    if (!state.warnSent && (state.readCount >= warnReads || elapsedMin >= warnMin)) {
      state.warnSent = true;
      writeState(file, state);
      recordEvent('author_guard', {
        action: 'advise',
        reasonCode: 'author_thrash_warn',
        count: state.readCount,
        durationMs: Math.round(elapsedMs),
      });
      return {
        action: 'warn',
        reasonCode: 'author_thrash_warn',
        readCount: state.readCount,
        elapsedMin,
        cacheHit,
        message: `[author-guard] ${state.readCount} read-only commands (${Math.floor(elapsedMin)}m) on "${active.change}" without persisting a contract file. Consult openspec/changes/${active.change}/baseline-facts.md and write openspec/changes/${active.change}/specs/<cap>/spec.md now (or verify with freeze-check --stage specs).`,
      };
    }

    if (readRel && state.fileReads[readRel] >= 4 && !state.repeatWarnedFiles[readRel]) {
      state.repeatWarnedFiles[readRel] = true;
      writeState(file, state);
      recordEvent('author_guard', {
        action: 'advise',
        reasonCode: 'author_repeat_read',
        count: state.fileReads[readRel],
      });
      return {
        action: 'warn',
        reasonCode: 'author_repeat_read',
        readCount: state.readCount,
        repeatCount: state.fileReads[readRel],
        file: readRel,
        cacheHit,
        message: `[author-guard] ${readRel} has already been read ${state.fileReads[readRel]} times on "${active.change}" without persisting contract files. Stop re-reading the same file; consult openspec/changes/${active.change}/baseline-facts.md and write specs/<cap>/spec.md + tasks.md now.`,
      };
    }

    writeState(file, state);
    return { action: 'none', readCount: state.readCount, elapsedMin, cacheHit };
  } catch (err) {
    logHookError('author-guard:read', err);
    return { action: 'none' };
  }
}

export function recordAuthorWrite({ target, sessionId, now = Date.now() } = {}) {
  try {
    if (process.env.PIPELINE_TIER_GATE === 'off' || process.env.PIPELINE_AUTHOR_GUARD === 'off') return false;
    if (typeof target !== 'string' || !target || typeof sessionId !== 'string' || !sessionId) return false;
    const normalized = path.resolve(target).split(path.sep).join('/');
    const match = normalized.match(/\/openspec\/changes\/([^/]+)\//);
    if (!match || match[1] === 'archive') return false;

    const ctx = repoContext(target);
    const root = ctx?.root || normalized.slice(0, normalized.indexOf('/openspec/changes/'));
    const change = match[1];
    const changeDir = path.join(root, 'openspec', 'changes', change);
    const changesMtimeMs = dirMtimeMs(path.join(root, 'openspec', 'changes'));
    const file = guardStateFile(sessionId);
    const existing = readState(file);
    const cwd = existing?.root === root && typeof existing.cwd === 'string' ? existing.cwd : root;
    writeState(file, {
      cwd,
      root,
      change,
      changeDir,
      changesMtimeMs,
      detectedAt: now,
      startedAt: now,
      readCount: 0,
      warnSent: false,
      stopSent: false,
    });
    return true;
  } catch (err) {
    logHookError('author-guard:write', err);
    return false;
  }
}

export function assessAuthorCompact({ cwd, sessionId } = {}) {
  try {
    if (process.env.PIPELINE_TIER_GATE === 'off' || process.env.PIPELINE_AUTHOR_GUARD === 'off') return null;
    const active = detectActiveAuthorChange(cwd);
    if (!active || active.hasSpecs) return null;
    const file = sessionId ? guardStateFile(sessionId) : null;
    const existing = file ? readState(file) : null;
    recordEvent('author_guard', {
      action: 'advise',
      reasonCode: 'author_compact_empty_specs',
      count: existing?.readCount ?? 0,
    });
    return `[author-guard] Context compacted while authoring "${active.change}" with no spec.md written under openspec/changes/${active.change}/specs/. Do NOT re-read source files from scratch; read baseline-facts.md (and proposal.md if present) only to persist specs/<cap>/spec.md immediately, or return INCOMPLETE.`;
  } catch (err) {
    logHookError('author-guard:compact', err);
    return null;
  }
}

function reconStateFile(sessionId) {
  const hash = crypto.createHash('sha1').update(String(sessionId)).digest('hex').slice(0, 12);
  return path.join(stateDir(), `rg-${hash}.json`);
}

function worktreeReadStateFile(sessionId) {
  const hash = crypto.createHash('sha1').update(String(sessionId)).digest('hex').slice(0, 12);
  return path.join(stateDir(), `ws-${hash}.json`);
}

export function resetPrimaryRecon(sessionId) {
  try {
    if (typeof sessionId !== 'string' || !sessionId) return false;
    fs.rmSync(reconStateFile(sessionId), { force: true });
    fs.rmSync(worktreeReadStateFile(sessionId), { force: true });
    return true;
  } catch (err) {
    logHookError('recon-guard:reset', err);
    return false;
  }
}

export function recordPrimaryReconRead({ cwd, sessionId, command, toolName, target, now = Date.now() } = {}) {
  try {
    if (process.env.PIPELINE_TIER_GATE === 'off' || process.env.PIPELINE_RECON_GUARD === 'off') {
      return { action: 'none' };
    }
    if (typeof sessionId !== 'string' || !sessionId) return { action: 'none' };
    if (typeof cwd !== 'string' || !cwd.trim()) return { action: 'none' };

    let ctx;
    if (toolName === 'Read') {
      const info = repoRelativeSourcePath(cwd, target, { skipChangesOnly: false });
      if (!info) return { action: 'none' };
      ctx = info.ctx;
    } else {
      if (!isReadOnlyBash(command)) return { action: 'none' };
      ctx = repoContext(cwd);
    }
    if (!ctx || !ctx.isPrimary) return { action: 'none' };

    const file = reconStateFile(sessionId);
    const existing = readState(file);
    const fresh = existing && existing.root === ctx.root && typeof existing.updatedAt === 'number' && (now - existing.updatedAt) < RECON_IDLE_MS;
    const state = {
      root: ctx.root,
      count: fresh && Number.isInteger(existing.count) ? existing.count : 0,
      warned: fresh ? Boolean(existing.warned) : false,
      updatedAt: now,
    };

    state.count += 1;
    const warnReads = intEnv('PIPELINE_RECON_WARN_READS', DEFAULT_RECON_WARN_READS);
    if (!state.warned && state.count >= warnReads) {
      state.warned = true;
      writeState(file, state);
      recordEvent('tool_guard', {
        action: 'advise',
        reasonCode: 'recon_stall',
        count: state.count,
      });
      return {
        action: 'warn',
        reasonCode: 'recon_stall',
        count: state.count,
        message: `[recon-budget] 已在主 checkout 连续执行 ${state.count} 次只读探测尚无改动：多文件跨端调研请拆给并行只读子代理（chanpin/Agent）汇总，主会话勿逐个全量 Read；若缺生产/外部证据请停下向用户确认；Bash 请直接以白名单命令（rg/git/sed -n）开头以避开 auto_mode 延迟。`,
      };
    }

    writeState(file, state);
    return { action: 'none', count: state.count };
  } catch (err) {
    logHookError('recon-guard:read', err);
    return { action: 'none' };
  }
}

/** Warn once in a linked worktree when autonomous tool loops keep reading without writing. */
export function recordWorktreeReadStall({ cwd, sessionId, command, toolName, target, now = Date.now() } = {}) {
  try {
    if (process.env.PIPELINE_TIER_GATE === 'off' || process.env.PIPELINE_RECON_GUARD === 'off') {
      return { action: 'none' };
    }
    if (typeof sessionId !== 'string' || !sessionId) return { action: 'none' };
    if (typeof cwd !== 'string' || !cwd.trim()) return { action: 'none' };

    let ctx;
    if (toolName === 'Read') {
      const info = repoRelativeSourcePath(cwd, target, { skipChangesOnly: false });
      if (!info) return { action: 'none' };
      ctx = info.ctx;
    } else {
      if (!isReadOnlyBash(command)) return { action: 'none' };
      ctx = repoContext(cwd);
    }
    if (!ctx || ctx.isPrimary) return { action: 'none' };

    const file = worktreeReadStateFile(sessionId);
    const existing = readState(file);
    const fresh = existing && existing.root === ctx.root && typeof existing.updatedAt === 'number' && (now - existing.updatedAt) < RECON_IDLE_MS;
    const state = {
      root: ctx.root,
      count: fresh && Number.isInteger(existing.count) ? existing.count : 0,
      warned: fresh ? Boolean(existing.warned) : false,
      updatedAt: now,
    };

    state.count += 1;
    const warnReads = intEnv('PIPELINE_WORKTREE_READ_WARN', DEFAULT_RECON_WARN_READS);
    if (!state.warned && state.count >= warnReads) {
      state.warned = true;
      writeState(file, state);
      recordEvent('tool_guard', {
        action: 'advise',
        reasonCode: 'worktree_read_stall',
        count: state.count,
      });
      return {
        action: 'warn',
        reasonCode: 'worktree_read_stall',
        count: state.count,
        message: `[worktree-read-budget] 已在 linked worktree 连续 ${state.count} 次只读探测尚无写入：停止继续发散读源码，立即开始当前任务切片的编码修改，或将进展写入 handoff-progress.md 后切换干净切片会话（若当前为纯只读排查/复盘可忽略）。`,
      };
    }

    writeState(file, state);
    return { action: 'none', count: state.count };
  } catch (err) {
    logHookError('worktree-guard:read', err);
    return { action: 'none' };
  }
}
