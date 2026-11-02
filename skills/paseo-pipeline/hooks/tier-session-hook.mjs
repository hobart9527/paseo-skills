#!/usr/bin/env node
// SessionStart hook（matcher: startup|resume|compact|clear）：会话开始、恢复、上下文压缩后重新注入分级规则。
// 为什么：压缩后规则可能只剩一句摘要，长会话的“丢规则”多发生在这里。
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TIER_RULES, logHookError } from '../lib/tier-gate.mjs';

export const SESSION_CONTEXT = [
  '[分级规则·会话级] 本会话改文件前必须先分级并声明，不经用户允许不得越级。',
  TIER_RULES,
  '主 checkout 上同一会话写到第 4 个业务文件会弹出确认；Stop 时还会核对实际改动。',
].join('\n');

async function main() {
  if (process.env.PIPELINE_TIER_REMINDER === 'off') return;
  for await (const _ of process.stdin); // 排空 stdin
  fs.writeSync(1, `${JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: SESSION_CONTEXT },
  })}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  try { await main(); } catch (err) { logHookError('tier-session-hook', err); }
}
