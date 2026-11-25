#!/usr/bin/env node
// SessionStart hook（matcher: startup|resume|compact|clear）：会话恢复或上下文压缩后重新注入精简分级红线，并持久化累计压缩次数。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TIER_RULES, skipInjection, logHookError, incrementCompactCount, worktreeCompactLimitFromEnv } from '../lib/tier-gate.mjs';

export const PIPELINE_HOME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const SESSION_CONTEXT = [
  '[分级规则·会话级] 按以下红线选择通道：',
  TIER_RULES,
].join('\n');

export const WORKTREE_COMPACT_REDLINE = `[worktree-compact] 压缩恢复红线：以 git status/log 与 handoff-progress.md 为准；隔离 worktree 内禁 cd/git -C 到主 checkout（用 ExitWorktree）；写文件用 Write/Edit、提交用 git commit -m/-F（禁 heredoc <<EOF）；满 2 次压缩优先落盘 handoff-progress.md 切干净切片；收口跑 tier2-verify；已获授权不重复问，未获授权不 push/deploy；脚本目录 PIPELINE_HOME=${PIPELINE_HOME}。`;

function compactHeavyNotice(compactCount, limit, cwd, isPrimary) {
  if (!limit || compactCount < limit) {
    return !isPrimary ? `脚本路径：\`PIPELINE_HOME=${PIPELINE_HOME}\`（不要用 find 搜索，直接 \`node "${PIPELINE_HOME}/pipeline-run.mjs" ...\`）。` : '';
  }
  if (isPrimary) {
    return `[compact-count] 本会话已累计压缩 ${compactCount} 次，重任务请先冻结契约并按切片移交 \`gongbu\`（\`PIPELINE_HOME=${PIPELINE_HOME}\`），不要在主会话硬写大范围功能。`;
  }
  const wtHint = typeof cwd === 'string' && cwd.trim() ? cwd.trim() : '<当前 worktree>';
  return [
    `[worktree-compact-heavy] 本会话已累计压缩 ${compactCount} 次（≥${limit} 次硬红线），禁止继续在当前重上下文里无契约扩张新功能或连写业务代码。`,
    `请立即收口当前增量并切换干净切片：1) 把已完成/失败与验证命令写入 handoff-progress.md；2) 跑 \`node "${PIPELINE_HOME}/pipeline-run.mjs" prepare-author openspec/changes/<change> --schema paseo-tier2 --hydrate\` + \`openspec validate <change> --strict\` 冻结契约；3) 用 \`create_workspace(path: "${wtHint}", isolation: "local")\` + \`create_agent(provider: "gongbu", workspaceId: "<id>")\` 逐片移交 \`gongbu\`。`,
  ].join('\n');
}

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
  const isCompact = payload?.source === 'compact';
  const compactState = isCompact ? incrementCompactCount(payload?.session_id) : null;
  const contexts = [];
  const inWorktree = skipInjection(payload?.cwd);
  if (!inWorktree) {
    contexts.push(SESSION_CONTEXT);
    if (isCompact) {
      contexts.push(`脚本路径：\`PIPELINE_HOME=${PIPELINE_HOME}\``);
      const heavy = compactHeavyNotice(compactState.count, worktreeCompactLimitFromEnv(), payload?.cwd, true);
      if (heavy) contexts.push(heavy);
    }
  } else if (isCompact) {
    contexts.push(WORKTREE_COMPACT_REDLINE);
    const heavy = compactHeavyNotice(compactState.count, worktreeCompactLimitFromEnv(), payload?.cwd, false);
    if (heavy) contexts.push(heavy);
  }
  if (!contexts.length) return;
  fs.writeSync(1, `${JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: contexts.join('\n\n') },
  })}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  try { await main(); } catch (err) { logHookError('tier-session-hook', err); }
}
