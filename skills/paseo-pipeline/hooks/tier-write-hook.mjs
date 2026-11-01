#!/usr/bin/env node
// PreToolUse tier cap: on main checkout, block the 4th distinct file written by one session.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
async function main() {
  const chunks = []; for await (const c of process.stdin) chunks.push(c);
  let payload; try { payload = JSON.parse(Buffer.concat(chunks).toString()); } catch { return; }
  if (!WRITE_TOOLS.has(payload?.tool_name)) return;
  const target = payload?.tool_input?.file_path ?? payload?.tool_input?.notebook_path;
  if (typeof target !== 'string' || !target) return;
  const { assessTierGate } = await import('../lib/tier-gate.mjs');
  const verdict = assessTierGate({ target, sessionId: payload.session_id });
  if (verdict.verdict === 'deny') {
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `[tier-gate] ${verdict.reason}` } }));
  }
}
try { await main(); } catch {}
