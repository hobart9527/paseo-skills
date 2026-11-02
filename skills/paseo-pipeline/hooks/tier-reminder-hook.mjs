#!/usr/bin/env node

// UserPromptSubmit hook：用户消息带实施意图时，在本轮上下文末尾注入一段分级提醒。
//
// 为什么需要它：2026-10-31 两个会话都加载了全局分级表，但用户说「执行上面的优化」时，
// 模型在思考与输出里一次都没提到 Tier，直接跑测试、改代码。规则只在会话开头出现一次，
// 几十轮之后到了「该不该动手」的决策点，没有任何东西把它推回眼前。
//
// 与写入闸门分开：事件不同（UserPromptSubmit vs PreToolUse），失败语义也不同——
// 这里出错就什么都不输出，没有任何副作用。
//
// 安装：~/.claude/settings.json → hooks.UserPromptSubmit 追加
//   { "hooks": [{ "type": "command", "command": "node <本文件绝对路径>" }] }
// 也可用 `--install-help` 打印现成片段。
//
// 设计取舍：
//   - 系统通知（<paseo-system>）、linked worktree / 功能分支不提醒（cwd 判定，不看 PASEO_AGENT_ID）。
//   - 每条非斜杠消息都提醒（不再做关键词筛选，见 REMINDER 上方的说明）。
//   - 同时为 Stop 核对记录本轮基线（takeSnapshot）。
//   - 任何异常一律不输出（exit 0），但写入 errors.log。
//   - PIPELINE_TIER_REMINDER=off 整体关闭。
//
// 输出契约（Claude Code UserPromptSubmit）：
//   hookSpecificOutput.additionalContext 会作为额外上下文加进本轮。
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TIER_RULES, takeSnapshot, skipInjection, logHookError } from '../lib/tier-gate.mjs';

// 为什么不再做关键词筛选（2026-11-02）：长会话里用户多半只说「好的，按方案B来」「继续」「可以，做吧」，
// 关键词筛选全漏，而那恰恰是模型最容易直接动手的时刻。改为每条非斜杠消息都注入一行短提醒，
// 评估类消息多看一行，代价远小于漏掉一次。
export const REMINDER = [
  '[分级提醒] 动手改任何文件（含 Bash 里的 sed -i、重定向、patch）之前，第一句话先输出分级声明：计划改哪些文件、属于哪一级、依据。',
  TIER_RULES,
  '纯评估、纯讨论不需要声明。',
].join('\n');

// Paseo 把子 agent 的通知当作 user 角色消息投递（<paseo-system ...> / <task-notification ...>），
// UserPromptSubmit 会为每一条触发。它们不是用户的话：不提醒、不重置 churn 计数。
export function isSystemNotification(prompt) {
  return typeof prompt === 'string' && /^\s*<(?:paseo-system|task-notification)\b/i.test(prompt);
}

export function shouldRemind(prompt) {
  if (typeof prompt !== 'string') return false;
  const text = prompt.trim();
  return text !== '' && !text.startsWith('/') && !isSystemNotification(text);
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
  // 每条用户消息都给 Stop 核对留一份基线（斜杠命令也要，它们同样可能改文件）。
  try {
    takeSnapshot({
      cwd: payload?.cwd ?? process.cwd(),
      sessionId: payload?.session_id,
      isHumanTurn: !isSystemNotification(payload?.prompt),
    });
  } catch (err) {
    logHookError('tier-reminder-hook/snapshot', err);
  }
  if (!shouldRemind(payload?.prompt)) return 0;
  if (skipInjection(payload?.cwd)) return 0;
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
