#!/usr/bin/env node
// SessionStart hook（matcher: startup|resume|compact|clear）：会话恢复或上下文压缩后重新注入精简分级红线。
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TIER_RULES, skipInjection, logHookError } from '../lib/tier-gate.mjs';

export const SESSION_CONTEXT = [
  '[分级规则·会话级] 按以下红线选择通道：',
  TIER_RULES,
].join('\n');

export function shouldSkipSource(source) {
  return source === 'startup' || source === 'clear';
}

async function main() {
  if (process.env.PIPELINE_TIER_REMINDER === 'off') return;
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  let payload;
  try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { payload = undefined; }
  if (shouldSkipSource(payload?.source)) return;
  if (skipInjection(payload?.cwd)) return;
  fs.writeSync(1, `${JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: SESSION_CONTEXT },
  })}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  try { await main(); } catch (err) { logHookError('tier-session-hook', err); }
}
