#!/usr/bin/env node
// SessionStart hook（matcher: startup|resume|compact|clear）：会话恢复或上下文压缩后重新注入精简分级红线。
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TIER_RULES, skipInjection, logHookError } from '../lib/tier-gate.mjs';
import { assessAuthorCompact } from '../lib/author-guard.mjs';

export const SESSION_CONTEXT = [
  '[分级规则·会话级] 按以下红线选择通道：',
  TIER_RULES,
].join('\n');

export const WORKTREE_COMPACT_REDLINE = '[worktree-compact] 压缩恢复红线：以 git status/log 与 handoff-progress.md 为准；隔离 worktree 内禁 cd/git -C 到主 checkout（用 ExitWorktree）；写文件用 Write/Edit、提交用 git commit -m/-F（禁 heredoc <<EOF）；满 2 次压缩优先落盘 handoff-progress.md 切干净切片；收口跑 tier2-verify；已获授权不重复问，未获授权不 push/deploy。';

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
  const compactNotice = payload?.source === 'compact'
    ? assessAuthorCompact({ cwd: payload?.cwd, sessionId: payload?.session_id })
    : null;
  const contexts = [];
  if (compactNotice) contexts.push(compactNotice);
  if (!skipInjection(payload?.cwd)) contexts.push(SESSION_CONTEXT);
  else if (payload?.source === 'compact') contexts.push(WORKTREE_COMPACT_REDLINE);
  if (!contexts.length) return;
  fs.writeSync(1, `${JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: contexts.join('\n\n') },
  })}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  try { await main(); } catch (err) { logHookError('tier-session-hook', err); }
}
