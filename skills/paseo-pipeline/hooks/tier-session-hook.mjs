#!/usr/bin/env node
// SessionStart hook（matcher: startup|resume|compact|clear）：会话开始、恢复、上下文压缩后重新注入分级规则。
// 为什么：压缩后规则可能只剩一句摘要，长会话的“丢规则”多发生在这里。
// linked worktree / 功能分支不注入（cwd 判定）；不按 PASEO_AGENT_ID 跳过，人会直连 Paseo 会话。
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TIER_RULES, skipInjection, logHookError } from '../lib/tier-gate.mjs';

export const SESSION_CONTEXT = [
  '[分级规则·会话级] 动手前声明 TIER-PLAN，并按以下规则选通道：',
  TIER_RULES,
].join('\n');

async function main() {
  if (process.env.PIPELINE_TIER_REMINDER === 'off') return;
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  let cwd;
  try { cwd = JSON.parse(Buffer.concat(chunks).toString('utf8'))?.cwd; } catch { cwd = undefined; }
  if (skipInjection(cwd)) return;
  fs.writeSync(1, `${JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: SESSION_CONTEXT },
  })}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  try { await main(); } catch (err) { logHookError('tier-session-hook', err); }
}
