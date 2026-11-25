#!/usr/bin/env node

// UserPromptSubmit hook：仅在需要动手改代码的新会话段首次提醒分级红线；
// 纯问答/调研/排障提问与已提醒过的活跃会话段跳过上下文注入，仍保留 Stop 基线快照。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TIER_RULES,
  tierGateIdleMs,
  readSessionMeta,
  writeSessionMeta,
  repoContext,
  takeSnapshot,
  skipInjection,
  logHookError,
} from '../lib/tier-gate.mjs';

export const REMINDER = [
  '[分级提醒·仅代码改动适用]',
  TIER_RULES,
].join('\n');

const WRITE_OR_ACTION_RE = /(?:修改|改动|改写|改一下|改掉|重构|实现|修复|修一下|写代码|写测试|补测试|加上|删掉|删了|删除|移除|执行|动手|按方案|按上面|开始做|去改|去修|建一个|写一个|\b(?:fix|edit|write|implement|refactor|patch|create|update|add|remove|delete|go ahead|ok go|proceed)\b)/i;
const BARE_MUTATION_RE = /(?:提交|推送|部署|合并|\b(?:commit|push|deploy|merge)\b)/i;
const QUESTION_OR_DIAG_RE = /(?:为什么|为何|怎么回事|什么原因|是不是|怎么看|你觉得|调研|分析|评估|诊断|排查|核对|检查一下|看看|解释|总结|对比|梳理|\b(?:why|how\s+(?:does|do|is|are|did|to)|what\s+(?:is|are|caused)|explain|analy[sz]e|research|investigate|diagnose|compare|summari[sz]e|inspect|audit)\b)/i;

// Paseo 把子 agent 的通知当作 user 角色消息投递（<paseo-system ...> / <task-notification ...>），
// UserPromptSubmit 会为每一条触发。它们不是用户的话：不提醒、不记入用户轮次。
export function isSystemNotification(prompt) {
  return typeof prompt === 'string' && /^\s*<(?:paseo-system|task-notification)\b/i.test(prompt);
}

export function isReadOnlyPrompt(prompt) {
  if (typeof prompt !== 'string') return false;
  const text = prompt.trim();
  if (!text || WRITE_OR_ACTION_RE.test(text)) return false;
  if (QUESTION_OR_DIAG_RE.test(text)) return true;
  if (BARE_MUTATION_RE.test(text)) return false;
  return /[？?]\s*$/.test(text);
}

export function shouldRemind(prompt) {
  if (typeof prompt !== 'string') return false;
  const text = prompt.trim();
  return text !== '' && !text.startsWith('/') && !isSystemNotification(text) && !isReadOnlyPrompt(text);
}

function normalizedCwd(cwd, precomputedCtx = undefined) {
  const target = typeof cwd === 'string' && cwd.trim() ? cwd : process.cwd();
  const ctx = precomputedCtx === undefined ? repoContext(target) : precomputedCtx;
  if (ctx?.root) return ctx.root;
  try { return fs.realpathSync(target); } catch { return path.resolve(target); }
}

function markReminded(sessionId, cwdKey, now = Date.now()) {
  if (typeof sessionId !== 'string' || !sessionId) return;
  writeSessionMeta(sessionId, { remindedCwd: cwdKey, remindedAt: now });
}

function refreshIfActive(sessionId, cwdKey, now = Date.now()) {
  if (typeof sessionId !== 'string' || !sessionId) return false;
  const meta = readSessionMeta(sessionId);
  const active = meta.remindedCwd === cwdKey
    && typeof meta.remindedAt === 'number'
    && (now - meta.remindedAt) < tierGateIdleMs();
  if (active) {
    markReminded(sessionId, cwdKey, now);
    return true;
  }
  return false;
}

async function main() {
  if (process.argv.includes('--install-help')) {
    const self = fileURLToPath(import.meta.url);
    fs.writeSync(1, [
      '// ~/.claude/settings.json → hooks.UserPromptSubmit 追加一项：',
      JSON.stringify({ hooks: [{ type: 'command', command: `node ${JSON.stringify(self)}` }] }, null, 2),
      '',
    ].join('\n'));
    return 0;
  }
  if (process.env.PIPELINE_TIER_REMINDER === 'off') return 0;
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  let payload;
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return 0;
  }
  const cwd = payload?.cwd ?? process.cwd();
  const sessionId = payload?.session_id;
  const ctx = typeof cwd === 'string' && cwd.trim() ? repoContext(cwd) : null;
  // 每条用户消息都给 Stop 核对留一份基线（斜杠命令与问答同样可能意外写文件）。
  try {
    takeSnapshot({
      cwd,
      sessionId,
      isHumanTurn: !isSystemNotification(payload?.prompt),
      ctx,
    });
  } catch (err) {
    logHookError('tier-reminder-hook/snapshot', err);
  }
  if (!shouldRemind(payload?.prompt)) return 0;
  if (skipInjection(payload?.cwd, ctx)) return 0;
  const cwdKey = normalizedCwd(cwd, ctx);
  const now = Date.now();
  if (refreshIfActive(sessionId, cwdKey, now)) return 0;
  markReminded(sessionId, cwdKey, now);
  fs.writeSync(1, `${JSON.stringify({
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: REMINDER },
  })}\n`);
  return 0;
}

// 被测试 import 时不执行 main。
if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  try {
    process.exitCode = await main();
  } catch (err) {
    logHookError('tier-reminder-hook', err);
    process.exitCode = 0;
  }
}
