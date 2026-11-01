#!/usr/bin/env node
// PreToolUse hook：有编排租约期间，拒绝命中任务 Write scope 且无在途写手意图的写入。
//
// 这是 LESSONS §13 里「暂缓的措施」（PreToolUse hook 拦截命中 Write scope 的 Edit/Write）
// 的落地版本：同类越权再次发生时上 hook。判据全部在 lib/scope-guard.mjs，本文件只做
// 事件适配——它与 guard-scope.mjs 共用同一份实现，不存在第二套 scope 解析。
//
// 安装（手动，一行）：把下面这段加进 ~/.claude/settings.json 的 hooks.PreToolUse：
//   {
//     "matcher": "Write|Edit|MultiEdit|NotebookEdit",
//     "hooks": [{ "type": "command",
//                 "command": "node /Users/<you>/Codex/paseo-skills/skills/paseo-pipeline/hooks/scope-guard-hook.mjs" }]
//   }
// 也可用 `node .../hooks/scope-guard-hook.mjs --install-help` 打印现成片段。
//
// 设计取舍（与 write-guard.py 一致，勿扩大）：
//   - 任何异常一律放行（exit 0）：宁可漏拦，不能锁死工作。
//   - 只读工具不拦；Bash 不拦（覆盖不了 `sed -i`/重定向，见 lib/scope-guard.mjs 注释）。
//   - 无有效租约放行：门禁只在一次 run 内成立。
//   - PIPELINE_GUARD_SCOPE=off 整体关闭（排障用）。
//
// 输出契约（Claude Code PreToolUse）：
//   permissionDecision=deny + permissionDecisionReason → 模型看到理由并停下；
//   账本损坏而裁决仍是 allow 时，输出 additionalContext（非阻断，只把事实推给模型）；
//   其余情况不输出任何 JSON（= 不干预）。
//   每次调用**只输出一个** JSON 对象：两个对象拼接在 stdout 上会让解析失败，
//   而解析失败在 Claude Code 侧等于不干预——deny 会静默退化成放行。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'NotebookEditTool']);

function emit(payload) {
  fs.writeSync(1, `${JSON.stringify(payload)}\n`);
}

function emitDeny(reason) {
  emit({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  });
}

/**
 * 损坏账本的非阻断提示。裁决仍按 scope 判定（损坏不该冻结整个仓库），
 * 但「某 change 的租约与在途意图此刻不可读」必须让模型看见——放行通道此前零输出，
 * 这条事实在最需要它的场景下恰好消失。
 *
 * @returns {string} 没有损坏时返回空串（调用方据此保持零输出）
 */
export function corruptionHint(corruptions) {
  if (!Array.isArray(corruptions) || corruptions.length === 0) return '';
  const lines = corruptions.map((c) => `- ${c.change}：${c.file}（${c.error}）`);
  return [
    `[paseo-pipeline scope-guard] ${corruptions.length} 个 change 的运行账本已损坏，`
      + '其租约、在途写手意图与待批状态均不可读（本次写入按 scope 判定照常放行）：',
    ...lines,
    '先修复或移开这些账本留档，再派发新任务；不要把它们读成「没有 run」。',
  ].join('\n');
}

async function main() {
  if (process.argv.includes('--install-help')) {
    const self = fileURLToPath(import.meta.url);
    fs.writeSync(1, [
      '// ~/.claude/settings.json → hooks.PreToolUse 追加一项：',
      JSON.stringify({
        matcher: 'Write|Edit|MultiEdit|NotebookEdit',
        hooks: [{ type: 'command', command: `node ${JSON.stringify(self)}` }],
      }, null, 2),
      '',
    ].join('\n'));
    return 0;
  }
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  let payload;
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return 0;
  }
  if (!WRITE_TOOLS.has(payload?.tool_name ?? '')) return 0;
  const target = payload?.tool_input?.file_path ?? payload?.tool_input?.notebook_path ?? '';
  if (typeof target !== 'string' || target === '') return 0;

  // 动态 import：hook 的加载异常同样不能锁死工作，因此放在 try 里。
  const { assessAnyWrite } = await import(path.join(
    path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'lib', 'scope-guard.mjs'));
  const verdict = assessAnyWrite({ target });
  if (verdict.verdict === 'deny') {
    emitDeny(`[paseo-pipeline scope-guard] ${verdict.reason}`);
    return 0;
  }
  // 放行也带出损坏信号：只放在结构化字段里等于人类与模型都读不到。
  const hint = corruptionHint(verdict.corruptions);

  // 租约之外的兜底：主 checkout 的 main 上，单会话写入超过 Tier 1 上限。
  // 放在 scope-guard 之后，所以有租约时仍由 scope-guard 先裁决。
  const { assessTierGate } = await import(path.join(
    path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'lib', 'tier-gate.mjs'));
  const gate = assessTierGate({ target, sessionId: payload?.session_id });
  if (gate.verdict === 'deny') {
    // 两份信号合并进**一个** deny 对象：分开输出会让 stdout 变成两个 JSON 拼接，
    // 解析失败时 Claude Code 视为不干预，tier-gate 的 deny 静默失效。
    emitDeny(`[paseo-pipeline tier-gate] ${gate.reason}${hint === '' ? '' : `\n\n${hint}`}`);
    return 0;
  }
  if (hint !== '') {
    emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: hint } });
  }
  return 0;
}

try {
  process.exitCode = await main();
} catch {
  // 宁可漏拦，不锁死工作。
  process.exitCode = 0;
}
