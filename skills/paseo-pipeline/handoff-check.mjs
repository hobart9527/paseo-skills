#!/usr/bin/env node
// 交接门禁 CLI：确认点 1 之后、建集成 workspace 之前跑一次；task-runner（T-03）派发前复用同一份判据。
//
// 用法:
//   node handoff-check.mjs <change> [--base <ref>] [--json]
// 退出码:
//   0  交接就绪
//   1  有阻断项，不得开工
//   2  用法错误
//
// 本文件**只做参数解析、输出与退出码**。判据全在 lib/handoff.mjs：
// 在这里再写一遍「怎么算已提交」就是第二份判法，两处漂移时门禁先绿后红。

import { checkHandoff, HANDOFF_CODES } from './lib/handoff.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');

// 按「旗标 + 取值」成对消费，剩下的才是位置参数。
// 不这么做的直接后果：`--base <sha>` 里的 sha 会被当成 change 名（freeze-check 的
// `--baseline` 就踩过同一个坑），于是门禁去核对一个不存在的 change。
const positional = [];
let base = 'HEAD';
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--json') continue;
  if (arg === '--base' || arg === '--change') {
    const value = args[index + 1];
    if (value === undefined) {
      console.error(`Usage: node handoff-check.mjs <change> [--base <ref>] [--json]（${arg} 缺少取值）`);
      process.exit(2);
    }
    if (arg === '--base') base = value;
    else positional.push(value);
    index += 1;
    continue;
  }
  if (arg.startsWith('--base=')) { base = arg.slice('--base='.length); continue; }
  if (arg.startsWith('--change=')) { positional.push(arg.slice('--change='.length)); continue; }
  positional.push(arg);
}

const change = positional[0];

if (!change) {
  console.error('Usage: node handoff-check.mjs <change> [--base <ref>] [--json]');
  process.exit(2);
}

const result = checkHandoff({ change, base });

if (json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`[handoff-check] openspec/changes/${change}/ base=${base} branch=${result.branch ?? '(unknown)'}`);
  for (const problem of result.problems) {
    const label = problem.path ? `${problem.code} ${problem.path}` : problem.code;
    console.error(`  BLOCK [${label}] ${problem.message}`);
  }
  console.log(result.ok
    ? '  RESULT 交接就绪：change 产物已全部提交，tasks.md 在基点上可读'
    : `  RESULT 不得开工：${result.problems.length} 个阻断项`);
}

// 用法类问题（change 名非法、非仓库、读不到基点/分支）与内容类阻断项都是 exit 1：
// 对调用方而言都意味着「现在不能交接」，区分只体现在消息里，不体现在退出码上。
const usageCodes = new Set([HANDOFF_CODES.BAD_CHANGE, HANDOFF_CODES.NOT_A_REPO]);
const onlyUsage = result.problems.length > 0 && result.problems.every((problem) => usageCodes.has(problem.code));
process.exit(result.ok ? 0 : onlyUsage ? 2 : 1);
