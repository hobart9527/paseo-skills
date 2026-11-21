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
      if (!fs.existsSync(path.join(changeDir, 'proposal.md'))) continue;
      if (fs.existsSync(path.join(changeDir, 'tasks.md'))) continue;
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
  return segments.every((seg) => READ_ONLY_CMD_RE.test(seg));
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

export function recordAuthorRead({ cwd, sessionId, command, now = Date.now() } = {}) {
  try {
    if (process.env.PIPELINE_TIER_GATE === 'off' || process.env.PIPELINE_AUTHOR_GUARD === 'off') {
      return { action: 'none' };
    }
    if (typeof sessionId !== 'string' || !sessionId) return { action: 'none' };
    if (!isReadOnlyBash(command)) return { action: 'none' };
    const active = detectActiveAuthorChange(cwd);
    if (!active) return { action: 'none' };

    const file = guardStateFile(sessionId);
    const existing = readState(file);
    const sameChange = existing && existing.root === active.root && existing.change === active.change;
    const state = sameChange
      ? { ...existing }
      : { root: active.root, change: active.change, startedAt: now, readCount: 0, warnSent: false, stopSent: false };

    state.readCount += 1;
    const elapsedMs = Math.max(0, now - (typeof state.startedAt === 'number' ? state.startedAt : now));
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
        message: `[author-guard] ${state.readCount} read-only commands (${Math.floor(elapsedMin)}m) on "${active.change}" without persisting a contract file. Consult openspec/changes/${active.change}/baseline-facts.md and write openspec/changes/${active.change}/specs/<cap>/spec.md now (or verify with freeze-check --stage specs).`,
      };
    }

    writeState(file, state);
    return { action: 'none', readCount: state.readCount, elapsedMin };
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
    const file = guardStateFile(sessionId);
    writeState(file, {
      root,
      change,
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
    return `[author-guard] Context compacted while authoring "${active.change}" with no spec.md written under openspec/changes/${active.change}/specs/. Do NOT re-read source files from scratch; read baseline-facts.md and proposal.md only to persist specs/<cap>/spec.md immediately, or return INCOMPLETE.`;
  } catch (err) {
    logHookError('author-guard:compact', err);
    return null;
  }
}
