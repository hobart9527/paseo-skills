#!/usr/bin/env node
// PreToolUse tier gate: counts distinct source files and scopes touched on the primary checkout,
// and guards heavily compacted (>=2 compactions) linked worktree sessions against uncontracted feature drift.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const PIPELINE_HOME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function inlineStateFile(sessionId) {
  const dir = process.env.PIPELINE_TIER_GATE_STATE || path.join(os.tmpdir(), 'paseo-tier-gate');
  return path.join(dir, `${String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
}

function inlineCompactLimit() {
  const raw = String(process.env.PIPELINE_WORKTREE_COMPACT_LIMIT ?? '').trim().toLowerCase();
  if (raw === '0' || raw === 'off' || raw === 'false') return 0;
  if (!raw) return 2;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= 1 ? n : 2;
}

function fileSig(target) {
  try {
    const st = fs.statSync(target);
    return st.isFile() ? `${st.size}:${st.mtimeMs}` : 'nonfile';
  } catch {
    return 'missing';
  }
}

function fastLinkedWorktreeTarget(target) {
  let current = path.resolve(target);
  const tail = [];
  while (true) {
    try {
      if (fs.statSync(current).isDirectory()) break;
    } catch {}
    const parent = path.dirname(current);
    if (parent === current) return null;
    tail.unshift(path.basename(current));
    current = parent;
  }
  let resolvedReal = current;
  try {
    resolvedReal = path.join(fs.realpathSync(current), ...tail);
  } catch {
    resolvedReal = path.join(current, ...tail);
  }
  for (;;) {
    const dotGit = path.join(current, '.git');
    try {
      const st = fs.lstatSync(dotGit);
      if (st.isDirectory()) return null;
      if (st.isFile()) {
        const line = fs.readFileSync(dotGit, 'utf8').trim();
        const gitDirRaw = line.slice(7).trim();
        if (!line.startsWith('gitdir:') || !/(?:^|[\\/])worktrees[\\/]/.test(gitDirRaw)) {
          return null;
        }
        let wtRoot = current;
        try { wtRoot = fs.realpathSync(current); } catch {}
        const gitDir = path.resolve(current, gitDirRaw);
        const rel = path.relative(wtRoot, resolvedReal).split(path.sep).join('/');
        return { wtRoot, rel, resolved: resolvedReal, gitDir };
      }
    } catch {}
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function hasHandoffProgress(wtInfo) {
  if (fs.existsSync(path.join(wtInfo.wtRoot, 'handoff-progress.md'))) return true;
  return Boolean(wtInfo.gitDir && fs.existsSync(path.join(wtInfo.gitDir, 'handoff-progress.md')));
}

function isHeavyWorktreeExempt(rel) {
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return true;
  if (rel === 'openspec' || rel.startsWith('openspec/')) return true;
  if (rel === '.superpowers' || rel.startsWith('.superpowers/')) return true;
  return rel.toLowerCase().endsWith('.md');
}

async function assessHeavyWorktreeWrite(wtInfo, sessionId) {
  if (isHeavyWorktreeExempt(wtInfo.rel)) return;
  if (hasHandoffProgress(wtInfo)) return;
  const limit = inlineCompactLimit();
  if (limit <= 0) return;
  const sFile = inlineStateFile(sessionId);
  let state;
  try {
    const parsed = JSON.parse(fs.readFileSync(sFile, 'utf8'));
    state = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return;
  }
  const meta = state?.__meta && typeof state.__meta === 'object' && !Array.isArray(state.__meta) ? state.__meta : null;
  const count = Number.isInteger(meta?.compactCount) ? meta.compactCount : 0;
  if (count < limit) return;

  const approvedCount = Number(meta.compactApproved?.[wtInfo.wtRoot] ?? 0);
  if (approvedCount > 0) return;

  const prevAsked = meta.compactAsked?.[wtInfo.wtRoot];
  if (prevAsked && prevAsked.count <= count && typeof prevAsked.file === 'string' && fileSig(prevAsked.file) !== prevAsked.sig) {
    const nextAsked = { ...(meta.compactAsked || {}) };
    delete nextAsked[wtInfo.wtRoot];
    const nextMeta = { ...meta, compactApproved: { ...(meta.compactApproved || {}), [wtInfo.wtRoot]: count }, compactAsked: nextAsked };
    try { fs.writeFileSync(sFile, JSON.stringify({ ...state, __meta: nextMeta })); } catch {}
    return;
  }

  const nextMeta = {
    ...meta,
    compactAsked: { ...(meta.compactAsked || {}), [wtInfo.wtRoot]: { count, file: wtInfo.resolved, sig: fileSig(wtInfo.resolved) } },
  };
  try {
    fs.mkdirSync(path.dirname(sFile), { recursive: true });
    fs.writeFileSync(sFile, JSON.stringify({ ...state, __meta: nextMeta }));
  } catch {}
  const { recordEvent } = await import('../lib/telemetry.mjs');
  recordEvent('tier_write', { tier: '2', action: 'ask', reasonCode: 'worktree_compact_heavy', count });
  const reason = [
    `[tier-gate] 当前 worktree 会话已累计压缩 ${count} 次（≥${limit} 次重上下文红线），正试图继续修改源码 \`${wtInfo.rel}\`。`,
    '重/已压缩会话禁止无契约硬扩或连写业务代码；请先暂停业务编码：',
    '- 若有未收口需求/增量：先把进展写入 `handoff-progress.md`，冻结或更新 OpenSpec Tier 2 契约（`openspec/changes/<change>/specs/...` + `tasks.md`）并过 `openspec validate <change> --strict`。',
    `- 使用 \`node "${PIPELINE_HOME}/pipeline-run.mjs" brief tier2 ...\`，配合 \`mcp__paseo__create_workspace(path: "${wtInfo.wtRoot}", isolation: "local")\` 与 \`mcp__paseo__create_agent(provider: "gongbu", workspaceId: "<id>")\` 把切片交由干净上下文的 \`gongbu\` 执行。`,
    '- 只有用户在确认框明确放行时，才继续在本重上下文中写入源码（`openspec/` 与 `*.md` 交接/契约文件随时放行）。',
  ].join('\n');
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason } }));
}

async function main() {
  const chunks = []; for await (const c of process.stdin) chunks.push(c);
  let payload; try { payload = JSON.parse(Buffer.concat(chunks).toString()); } catch { return; }
  if (!WRITE_TOOLS.has(payload?.tool_name)) return;
  const target = payload?.tool_input?.file_path ?? payload?.tool_input?.notebook_path;
  if (typeof target !== 'string' || !target) return;
  if (process.env.PIPELINE_TIER_GATE === 'off' || typeof payload.session_id !== 'string' || !payload.session_id) return;
  const wtInfo = fastLinkedWorktreeTarget(target);
  if (wtInfo) {
    await assessHeavyWorktreeWrite(wtInfo, payload.session_id);
    return;
  }
  const { assessTierGate } = await import('../lib/tier-gate.mjs');
  const verdict = assessTierGate({
    target,
    sessionId: payload.session_id,
  });
  if (verdict.verdict === 'deny') {
    const { recordEvent } = await import('../lib/telemetry.mjs');
    recordEvent('tier_write', { tier: '1', action: 'deny', reasonCode: verdict.reasonCode || 'tier1_limit' });
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: verdict.reason } }));
  } else if (verdict.verdict === 'ask') {
    const { recordEvent } = await import('../lib/telemetry.mjs');
    recordEvent('tier_write', { tier: '1', action: 'ask', reasonCode: verdict.reasonCode || 'tier1_limit' });
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: `[tier-gate] ${verdict.reason}` } }));
  }
}
try { await main(); } catch (err) {
  const { logHookError } = await import('../lib/tier-gate.mjs');
  logHookError('tier-write-hook', err);
}
