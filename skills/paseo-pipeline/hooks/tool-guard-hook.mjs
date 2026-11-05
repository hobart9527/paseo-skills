#!/usr/bin/env node
import fs from 'node:fs';
import { logHookError } from '../lib/tier-gate.mjs';

const LIMIT = 2 * 1024 * 1024;
// The server rejects `branch`/`prNumber`/`forge` together with `mode: "branch-off"` (and with the
// omitted default, which is branch-off). Denying only produced the same call again — one window
// logged 48 identical failures — so rewrite it into the call the server accepts.
const BRANCH_OFF_EXTRAS = ['branch', 'prNumber', 'forge'];
// An id that is not a `srv_*` handle is never resolvable. Denying it mid-batch loses the call;
// stripping sends the request to the calling daemon, which is what an omitted serverId means.
// "srv_invalid" also matches the handle shape, so the placeholder words are named explicitly
// instead of requiring mixed case; a real id must not be stripped by accident.
const PLACEHOLDER_SERVER_ID = /^srv[_-]?(?:invalid|unknown|placeholder|none|null|test|dummy|example|fake|todo|x+)?$/i;
const isPlaceholderServerId = (value) => {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  return text === '' || !/^srv_[A-Za-z0-9]+$/.test(text) || PLACEHOLDER_SERVER_ID.test(text);
};
const canonical = (value) => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map((key) => [key, v[key]])) : v);
const output = (fields) => console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...fields } }));
const deny = (reason) => output({ permissionDecision: 'deny', permissionDecisionReason: reason });

function repeatedFailures(file, name, input) {
  if (typeof file !== 'string' || !file) return false;
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return false; }
  let text;
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - LIMIT);
    const buffer = Buffer.alloc(size - start);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, start);
    text = buffer.subarray(0, bytes).toString('utf8');
    if (start) text = text.slice(text.indexOf('\n') + 1);
  } finally { fs.closeSync(fd); }
  const calls = [];
  const byId = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      if (item.type === 'tool_use') {
        const call = { name: item.name, input: canonical(item.input), result: undefined };
        calls.push(call); byId.set(item.id, call);
      } else if (item.type === 'tool_result' && byId.has(item.tool_use_id)) {
        byId.get(item.tool_use_id).result = item.is_error === true;
      }
    }
  }
  const expected = canonical(input);
  return calls.length >= 3 && calls.slice(-3).every((call) => call.name === name && call.input === expected && call.result === true);
}

// Say what to change, not just that something failed. The old message ("change args") was read as
// "retry the same call", which is how a denial loop forms.
function repeatedFailureReason(name) {
  if (name === 'mcp__paseo__create_workspace') {
    return 'This exact create_workspace call failed 3 times. Read the error, then change the fields: for mode "branch-off" (the default) remove branch、prNumber、forge and keep only branchName+baseBranch (plus optional worktreeSlug/path).';
  }
  return 'This exact call failed 3 times. Read the error text and change the specific field it names before retrying; if the error does not name a field, report to the user instead of repeating the call.';
}

/** Strip fields the server rejects for the mode being used; returns null when nothing changes. */
function sanitizedPaseoInput(name, input) {
  if (name !== 'mcp__paseo__create_workspace') return null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const mode = typeof input.mode === 'string' ? input.mode.trim().toLowerCase() : 'branch-off';
  if (mode !== 'branch-off') return null;
  if (!BRANCH_OFF_EXTRAS.some((field) => field in input)) return null;
  const next = { ...input };
  for (const field of BRANCH_OFF_EXTRAS) delete next[field];
  return next;
}

async function main() {
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
  let payload;
  try { payload = JSON.parse(Buffer.concat(chunks).toString()); } catch { return; }
  const name = payload?.tool_name;
  const input = payload?.tool_input;
  if (name === 'Bash' && typeof input?.command === 'string') {
    const command = input.command;
    if (/\bpaseo\s+(?:run|send)\b/.test(command) && !/(?:^|\s)--wait(?:\s|=|$)/.test(command) && !/\bpaseo\s+wait\b/.test(command)) {
      output({ additionalContext: 'CLI dispatch registers no completion callback; ending this turn will not wake the parent. Use MCP create_agent, or immediately start paseo wait <id> --timeout 540 in the background.' });
    }
  }
  if (typeof name !== 'string' || !name.startsWith('mcp__')) return;
  let updated = input;
  let changed = false;
  if (name.startsWith('mcp__paseo__')) {
    if (updated && typeof updated === 'object' && !Array.isArray(updated) && isPlaceholderServerId(updated.serverId)) {
      updated = { ...updated };
      delete updated.serverId;
      changed = true;
    }
    const sanitized = sanitizedPaseoInput(name, updated);
    if (sanitized) {
      updated = sanitized;
      changed = true;
    }
  }
  // A rewritten call cannot be the same failing call, so it never reaches the deny below.
  if (changed) {
    output({ permissionDecision: 'allow', updatedInput: updated });
    return;
  }
  if (repeatedFailures(payload.transcript_path, name, input)) deny(repeatedFailureReason(name));
}

try { await main(); } catch (err) { logHookError('tool-guard-hook', err); }
