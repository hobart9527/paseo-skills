#!/usr/bin/env node
// PreToolUse tier gate: counts distinct source files and scopes touched on the primary checkout
// so Tier 2+ work moves into linked worktrees without fragile transcript-JSONL parsing.
import { logHookError } from '../lib/tier-gate.mjs';

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
async function main() {
  const chunks = []; for await (const c of process.stdin) chunks.push(c);
  let payload; try { payload = JSON.parse(Buffer.concat(chunks).toString()); } catch { return; }
  if (!WRITE_TOOLS.has(payload?.tool_name)) return;
  const target = payload?.tool_input?.file_path ?? payload?.tool_input?.notebook_path;
  if (typeof target !== 'string' || !target) return;
  try {
    const { recordAuthorWrite } = await import('../lib/author-guard.mjs');
    recordAuthorWrite({ target, sessionId: payload.session_id });
  } catch (err) {
    logHookError('tier-write-hook:author-guard', err);
  }
  const { assessTierGate } = await import('../lib/tier-gate.mjs');
  const verdict = assessTierGate({
    target,
    sessionId: payload.session_id,
  });
  if (verdict.verdict === 'deny') {
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: verdict.reason } }));
  } else if (verdict.verdict === 'ask') {
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: `[tier-gate] ${verdict.reason}` } }));
  }
}
try { await main(); } catch (err) { logHookError('tier-write-hook', err); }
