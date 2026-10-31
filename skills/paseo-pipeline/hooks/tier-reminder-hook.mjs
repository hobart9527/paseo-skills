#!/usr/bin/env node

// UserPromptSubmit hook：用户消息带实施意图时，在本轮上下文末尾注入一段分级提醒。
//
// 为什么需要它：2026-10-31 两个会话都加载了全局分级表，但用户说「执行上面的优化」时，
// 模型在思考与输出里一次都没提到 Tier，直接跑测试、改代码。规则只在会话开头出现一次，
// 几十轮之后到了「该不该动手」的决策点，没有任何东西把它推回眼前。
//
// 与 scope-guard-hook 分开：事件不同（UserPromptSubmit vs PreToolUse），失败语义也不同——
// 这里出错就什么都不输出，没有任何副作用。
//
// 安装：~/.claude/settings.json → hooks.UserPromptSubmit 追加
//   { "hooks": [{ "type": "command", "command": "node <本文件绝对路径>" }] }
// 也可用 `--install-help` 打印现成片段。
//
// 设计取舍：
//   - 关键词只是触发提醒的粗筛，不是判据。误触发的代价是模型多说一句分级声明。
//   - 任何异常一律不输出（exit 0）。
//   - PIPELINE_TIER_REMINDER=off 整体关闭。
//
// 输出契约（Claude Code UserPromptSubmit）：
//   hookSpecificOutput.additionalContext 会作为额外上下文加进本轮。
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// 实施意图词。宁可宽：命中只带来一段提醒，不阻断任何事。
const INTENT = /(执行|实施|实现|落地|开始做|动手|按(照)?.{0,8}(方案|计划|上面)|修复|修一下|修改|优化|重构|改一下|\b(implement|execute|apply|fix|refactor|go ahead|do it)\b)/i;

// 纯提问（评估/分析/为什么）且没有明确动作词时不提醒，避免每条评估问题都被打断。
const QUESTION_ONLY = /^(为什么|怎么|如何|是否|能不能|可不可以|评估|分析|看一下|解释)/;

export const REMINDER = [
  '[分级提醒] 本轮可能进入实施。动手改任何文件之前，第一句话先输出分级声明：计划改哪些文件、属于哪一级、依据。',
  '- Tier 1：≤3 个文件、单一目录、不涉及 schema/认证/迁移 → 在当前会话直接改，验证后原子提交。',
  '- Tier 2：超出 Tier 1，但只在单个模块内、不涉及持久化/并发/不可逆 → 用 /paseo-handoff 交给 worktree 里的 Agent。',
  '- Tier 3：跨模块共享契约，或涉及持久化/并发/不可逆变更 → 用 /paseo-pipeline。',
  '判定不了时按高一级处理。开工后发现范围变大，立刻停手升级，不在原通道硬撑。纯评估、纯讨论不需要声明。',
].join('\n');

export function shouldRemind(prompt) {
  if (typeof prompt !== 'string') return false;
  const text = prompt.trim();
  if (text === '' || text.startsWith('/')) return false;
  if (!INTENT.test(text)) return false;
  // 「为什么 xxx 执行逃逸」这类句子里的动作词是被讨论的对象，不是指令。
  if (QUESTION_ONLY.test(text) && text.length > 40) return false;
  return true;
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
  if (!shouldRemind(payload?.prompt)) return 0;
  fs.writeSync(1, `${JSON.stringify({
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: REMINDER },
  })}\n`);
  return 0;
}

// 被测试 import 时不执行 main。
if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  try {
    process.exitCode = await main();
  } catch {
    process.exitCode = 0;
  }
}
