#!/usr/bin/env node
import fs from 'node:fs';
import { logHookError } from '../lib/tier-gate.mjs';

const LIMIT = 2 * 1024 * 1024;
const canonical = (value) => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map((key) => [key, v[key]])) : v);
const output = (fields) => console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...fields } }));
const deny = (reason) => output({ permissionDecision: 'deny', permissionDecisionReason: reason });

function repeatedFailures(file, name, input) {
  if (typeof file !== 'string' || !file) return false;
  const fd = fs.openSync(file, 'r');
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
    const content = JSON.parse(line)?.message?.content;
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

async function main() {
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
  const payload = JSON.parse(Buffer.concat(chunks).toString());
  const name = payload?.tool_name;
  const input = payload?.tool_input;
  if (name === 'Bash' && typeof input?.command === 'string') {
    const command = input.command;
    if (/\bpaseo\s+(?:run|send)\b/.test(command) && !/(?:^|\s)--wait(?:\s|=|$)/.test(command) && !/\bpaseo\s+wait\b/.test(command)) {
      output({ additionalContext: 'CLI dispatch registers no completion callback; ending this turn will not wake the parent. Use MCP create_agent, or immediately start paseo wait <id> --timeout 540 in the background.' });
    }
  }
  if (typeof name !== 'string' || !name.startsWith('mcp__')) return;
  const server = input?.serverId;
  if (name.startsWith('mcp__paseo__') && typeof server === 'string' && ['', 'self', 'local', 'localhost'].includes(server.trim().toLowerCase())) {
    deny(`serverId ${JSON.stringify(server)} is not a valid id; omit serverId for this host, or use a srv_* id from list_hosts.`);
    return;
  }
  if (repeatedFailures(payload.transcript_path, name, input)) deny('The identical call failed 3 times; change args or report to the user.');
}
try { await main(); } catch (err) { logHookError('tool-guard-hook', err); }
