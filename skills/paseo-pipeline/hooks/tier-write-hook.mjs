#!/usr/bin/env node
// PreToolUse tier gate: before the first business write, judge the plan the model declared
// (`TIER-PLAN: tier=1 files=...`); later writes still count distinct files on the main checkout.
import { logHookError } from '../lib/tier-gate.mjs';

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
async function main() {
  const chunks = []; for await (const c of process.stdin) chunks.push(c);
  let payload; try { payload = JSON.parse(Buffer.concat(chunks).toString()); } catch { return; }
  if (!WRITE_TOOLS.has(payload?.tool_name)) return;
  const target = payload?.tool_input?.file_path ?? payload?.tool_input?.notebook_path;
  if (typeof target !== 'string' || !target) return;
  const { assessTierGate, readDeclaredPlanStatusWithRetry } = await import('../lib/tier-gate.mjs');
  const verdict = assessTierGate({
    target,
    sessionId: payload.session_id,
    transcriptPath: payload.transcript_path,
    // The retry covers a transcript flush that lands just after the hook's first read; the
    // batch cache covers a parallel Edit whose hook read a shorter prefix of the same batch.
    loadDeclaration: () => readDeclaredPlanStatusWithRetry(payload.transcript_path),
  });
  // ask, not deny, for the running count: deny has no release path, so the model reroutes
  // through Bash. A declared plan that already exceeds Tier 1 is a routing error, so it denies.
  if (verdict.verdict === 'deny') {
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: verdict.reason } }));
  } else if (verdict.verdict === 'ask') {
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: `[tier-gate] ${verdict.reason}` } }));
  }
}
try { await main(); } catch (err) { logHookError('tier-write-hook', err); }
