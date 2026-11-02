#!/usr/bin/env node
// PreToolUse tier cap: on main checkout, the 4th distinct file written by one session needs user confirmation.
import { logHookError } from '../lib/tier-gate.mjs';

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
async function main() {
  const chunks = []; for await (const c of process.stdin) chunks.push(c);
  let payload; try { payload = JSON.parse(Buffer.concat(chunks).toString()); } catch { return; }
  if (!WRITE_TOOLS.has(payload?.tool_name)) return;
  const target = payload?.tool_input?.file_path ?? payload?.tool_input?.notebook_path;
  if (typeof target !== 'string' || !target) return;
  const { assessTierGate } = await import('../lib/tier-gate.mjs');
  const verdict = assessTierGate({ target, sessionId: payload.session_id });
  // ask, not deny: deny has no release path, so the model reroutes through Bash. ask puts the user in the loop.
  if (verdict.verdict === 'ask') {
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: `[tier-gate] ${verdict.reason}` } }));
  }
}
try { await main(); } catch (err) { logHookError('tier-write-hook', err); }
