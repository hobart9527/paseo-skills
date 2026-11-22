// Shared structured review verdict recorder & reader for Tier 1, Tier 2, R0, and FINAL gates (ADR-0004).
import fs from 'node:fs';
import path from 'node:path';
import { runGit } from './git.mjs';
import { recordEvent } from './telemetry.mjs';

export const REVIEW_MODES = ['r0', 'final', 'tier2', 'tier1'];
export const REVIEW_VERDICTS = ['PASS', 'BLOCKED', 'INCOMPLETE', 'HUMAN_ACCEPT'];

function gitDirOf(cwd) {
  const res = runGit(cwd, ['rev-parse', '--path-format=absolute', '--git-dir']);
  if (res.status === 0 && res.stdout.trim()) {
    try { return fs.realpathSync(res.stdout.trim()); } catch { return path.resolve(res.stdout.trim()); }
  }
  const rel = runGit(cwd, ['rev-parse', '--git-dir']);
  if (rel.status !== 0 || !rel.stdout.trim()) return null;
  const target = path.isAbsolute(rel.stdout.trim()) ? rel.stdout.trim() : path.resolve(cwd, rel.stdout.trim());
  try { return fs.realpathSync(target); } catch { return path.resolve(target); }
}

function appendUniqueLine(filePath, line) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let existing = '';
  try { existing = fs.readFileSync(filePath, 'utf8'); } catch { existing = ''; }
  const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(filePath, `${existing}${prefix}${line}\n`, 'utf8');
}

function formatSignoffLine(mode, verdict, reviewer, fullSha, reason) {
  const upper = mode.toUpperCase();
  const cleanReason = reason ? String(reason).trim().replace(/\r?\n+/g, ' ') : '';
  if (mode === 'r0' || mode === 'final') {
    if (verdict === 'PASS') return `${upper}: pass(${reviewer}@${fullSha})`;
    if (verdict === 'HUMAN_ACCEPT') return `${upper}: human-accept(@${fullSha})`;
    return `${upper}: ${verdict.toLowerCase()}(${reviewer}@${fullSha})${cleanReason ? ` — ${cleanReason}` : ''}`;
  }
  if (verdict === 'PASS') return `${upper}: pass(${reviewer}@${fullSha})`;
  if (verdict === 'HUMAN_ACCEPT') return `${upper}: human-accept(@${fullSha})`;
  return `${upper}: ${verdict.toLowerCase()}(${reviewer}@${fullSha})${cleanReason ? ` — ${cleanReason}` : ''}`;
}

export function recordReview({ cwd = process.cwd(), mode, verdict, reviewer = '', sha = 'HEAD', changeDir = null, reason = '' } = {}) {
  const normalizedMode = String(mode || '').trim().toLowerCase();
  const normalizedVerdict = String(verdict || '').trim().toUpperCase();
  if (!REVIEW_MODES.includes(normalizedMode)) {
    throw new Error(`--mode must be one of ${REVIEW_MODES.join(', ')}, got "${mode || ''}"`);
  }
  if (!REVIEW_VERDICTS.includes(normalizedVerdict)) {
    throw new Error(`--verdict must be one of ${REVIEW_VERDICTS.join(', ')}, got "${verdict || ''}"`);
  }
  const cleanReviewer = String(reviewer || '').trim();
  if (normalizedVerdict !== 'HUMAN_ACCEPT' && !cleanReviewer) {
    throw new Error(`--reviewer is required for verdict ${normalizedVerdict}`);
  }
  const root = path.resolve(cwd);
  const shaRes = runGit(root, ['rev-parse', '--verify', `${sha || 'HEAD'}^{commit}`]);
  if (shaRes.status !== 0) {
    throw new Error(`invalid commit reference "${sha || 'HEAD'}" in ${root}`);
  }
  const fullSha = shaRes.stdout.trim();
  const branchRes = runGit(root, ['symbolic-ref', '--short', '-q', 'HEAD']);
  const branch = branchRes.status === 0 ? branchRes.stdout.trim() : null;

  const resolvedChangeDir = changeDir ? path.resolve(root, changeDir) : null;
  if ((normalizedMode === 'r0' || normalizedMode === 'final') && !resolvedChangeDir) {
    throw new Error(`--change-dir is required for mode ${normalizedMode}`);
  }

  const targets = [];
  const line = formatSignoffLine(normalizedMode, normalizedVerdict, cleanReviewer || 'human', fullSha, reason);
  if (resolvedChangeDir) {
    if (!fs.existsSync(resolvedChangeDir)) throw new Error(`missing change directory: ${resolvedChangeDir}`);
    const reviewFile = path.join(resolvedChangeDir, 'review.md');
    appendUniqueLine(reviewFile, line);
    targets.push(reviewFile);
    if (normalizedVerdict === 'HUMAN_ACCEPT' && reason && String(reason).trim() && (normalizedMode === 'r0' || normalizedMode === 'final')) {
      const runLogFile = path.join(resolvedChangeDir, 'run-log.md');
      const approvalLine = `Approval: ${normalizedMode.toUpperCase()} residual risk accepted for ${fullSha} — ${String(reason).trim().replace(/\r?\n+/g, ' ')}`;
      appendUniqueLine(runLogFile, approvalLine);
      targets.push(runLogFile);
    }
  }

  if (normalizedMode === 'tier2' || normalizedMode === 'tier1') {
    const gitDir = gitDirOf(root);
    if (!gitDir) throw new Error(`not a git repository: ${root}`);
    const ledger = path.join(gitDir, 'paseo-reviews.jsonl');
    const entry = {
      ts: Date.now(),
      mode: normalizedMode,
      verdict: normalizedVerdict,
      reviewer: cleanReviewer || 'human',
      sha: fullSha,
      ...(branch ? { branch } : {}),
      ...(reason && String(reason).trim() ? { reason: String(reason).trim().slice(0, 240) } : {}),
    };
    appendUniqueLine(ledger, JSON.stringify(entry));
    targets.push(ledger);
  }

  recordEvent('review_verdict', {
    tier: normalizedMode === 'tier1' ? '1' : normalizedMode === 'tier2' ? '2' : '3',
    verdict: normalizedVerdict.toLowerCase(),
    role: normalizedMode,
  });

  return {
    ok: true,
    mode: normalizedMode,
    verdict: normalizedVerdict,
    reviewer: cleanReviewer || 'human',
    sha: fullSha,
    ...(branch ? { branch } : {}),
    line,
    targets,
  };
}

function shaMatches(recordedSha, targetSha) {
  const a = String(recordedSha || '').trim().toLowerCase();
  const b = String(targetSha || '').trim().toLowerCase();
  if (!a || !b) return false;
  if (a === b) return true;
  return (a.length >= 7 && b.startsWith(a)) || (b.length >= 7 && a.startsWith(b));
}

function resolveCommitSha(root, value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const res = runGit(root, ['rev-parse', '--verify', `${raw}^{commit}`]);
  return res.status === 0 && res.stdout.trim() ? res.stdout.trim() : null;
}

function isSignoffOnlyDescendant(root, recordedSha, targetFullSha, changeName = null) {
  if (!recordedSha || !targetFullSha) return false;
  if (!/^[a-f0-9]{40,64}$/i.test(recordedSha) || !/^[a-f0-9]{40,64}$/i.test(targetFullSha)) return false;
  if (recordedSha.toLowerCase() === targetFullSha.toLowerCase()) return false;
  const anc = runGit(root, ['merge-base', '--is-ancestor', recordedSha, targetFullSha]);
  if (anc.status !== 0) return false;
  const diff = runGit(root, ['diff', '--no-renames', '--name-only', '-z', recordedSha, targetFullSha]);
  if (diff.status !== 0) return false;
  const files = diff.stdout.split('\0').filter(Boolean);
  if (!files.length) return false;
  const escaped = changeName ? changeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '[^/]+';
  const signoffOnly = new RegExp(`^openspec/changes/(?:archive/\\d{4}-\\d{2}-\\d{2}-)?${escaped}/(?:review\\.md|rulings\\.md|run-log\\.md|evidence/.*)$`);
  return files.every((file) => signoffOnly.test(file.replace(/\\/g, '/')));
}

export function findReviewSignoff({ cwd = process.cwd(), changeDir = null, sha, ref = null, mode = 'tier2' } = {}) {
  const targetInput = sha || ref;
  if (!targetInput) return null;
  const root = path.resolve(cwd);
  const resolvedTargetSha = resolveCommitSha(root, targetInput);
  const targetSha = resolvedTargetSha || String(targetInput).trim();
  const targetMode = String(mode || 'tier2').trim().toLowerCase();
  const exactMatches = [];
  const ancestorMatches = [];
  const changeName = changeDir ? path.basename(path.resolve(root, changeDir)) : null;

  const gitDir = gitDirOf(root);
  if (gitDir) {
    const ledger = path.join(gitDir, 'paseo-reviews.jsonl');
    try {
      const raw = fs.readFileSync(ledger, 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (!entry || entry.mode !== targetMode) continue;
          const exact = shaMatches(entry.sha, targetSha);
          const ancestor = !exact && Boolean(resolvedTargetSha)
            && isSignoffOnlyDescendant(root, resolveCommitSha(root, entry.sha) || entry.sha, resolvedTargetSha, changeName);
          if (exact || ancestor) {
            const record = {
              source: 'git-ledger',
              mode: entry.mode,
              verdict: entry.verdict,
              reviewer: entry.reviewer,
              sha: entry.sha,
              ts: entry.ts ?? null,
              reason: entry.reason ?? null,
            };
            if (exact) exactMatches.push(record);
            else ancestorMatches.push(record);
          }
        } catch {
          // Ignore malformed ledger line
        }
      }
    } catch {
      // No worktree ledger yet
    }
  }

  if (changeDir) {
    const reviewFile = path.join(path.resolve(root, changeDir), 'review.md');
    let raw = null;
    if (ref) {
      const topRes = runGit(root, ['rev-parse', '--show-toplevel']);
      const repoRoot = topRes.status === 0 && topRes.stdout.trim() ? topRes.stdout.trim() : root;
      const relReview = path.relative(repoRoot, reviewFile).replace(/\\/g, '/');
      const show = runGit(repoRoot, ['show', `${ref}:${relReview}`]);
      if (show.status === 0) raw = show.stdout;
    }
    if (raw === null) {
      try {
        raw = fs.readFileSync(reviewFile, 'utf8');
      } catch {
        raw = null;
      }
    }
    if (raw === null && resolvedTargetSha) {
      const topRes = runGit(root, ['rev-parse', '--show-toplevel']);
      const repoRoot = topRes.status === 0 && topRes.stdout.trim() ? topRes.stdout.trim() : root;
      const relReview = path.relative(repoRoot, reviewFile).replace(/\\/g, '/');
      const show = runGit(repoRoot, ['show', `${resolvedTargetSha}:${relReview}`]);
      if (show.status === 0) raw = show.stdout;
    }
    if (raw !== null) {
      const upper = targetMode.toUpperCase();
      const re = new RegExp(`^${upper}:\\s*(pass|human-accept|blocked|incomplete)\\((?:([^@)]+)@)?([^)\\s]+)\\)`, 'gim');
      for (const m of raw.matchAll(re)) {
        const rawRef = m[3].trim();
        const isHex = /^[a-f0-9]{7,40}$/i.test(rawRef);
        const resolvedEntrySha = resolveCommitSha(root, rawRef);
        const exact = shaMatches(resolvedEntrySha || rawRef, targetSha);
        const ancestor = !exact && Boolean(resolvedTargetSha && resolvedEntrySha)
          && isSignoffOnlyDescendant(root, resolvedEntrySha, resolvedTargetSha, changeName);
        if (!exact && !ancestor) continue;
        const rawVerdict = m[1].toUpperCase();
        const record = {
          source: 'review.md',
          mode: targetMode,
          verdict: rawVerdict === 'HUMAN-ACCEPT' ? 'HUMAN_ACCEPT' : rawVerdict,
          reviewer: (m[2] || 'human').trim(),
          sha: isHex ? rawRef : (resolvedEntrySha || rawRef),
          ts: null,
          reason: null,
        };
        if (exact) exactMatches.push(record);
        else ancestorMatches.push(record);
      }
    }
  }

  if (exactMatches.length) return exactMatches.at(-1);
  return ancestorMatches.length ? ancestorMatches.at(-1) : null;
}
