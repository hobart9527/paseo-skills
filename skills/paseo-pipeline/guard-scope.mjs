#!/usr/bin/env node
// 写范围守卫 CLI（诊断与 hook 共用 lib/scope-guard.mjs 的同一份判据）。
//
// 为什么需要它：2026-10-27 `eas-filing-and-local-ocr` 的越权代写（LESSONS §13）里，
// 总控在主 checkout 直接写了 T-02 的 Write scope 文件。全部门禁都在别处生效：
// `merge-task.mjs` exit 30/31 只在**合流**时检查，原地写完不提交就根本走不到合流。
// 本条是**写之前**的那道减速带；事后可见性由 `reconcile.mjs` 的 DIRTY 输出提供。
//
// 刻意保守，宁可少拦：无租约放行、scope 外放行、读不到 tasks.md 放行（fail-open）。
// 守卫是减速带，不是沙箱——锁死工作区的代价远大于漏拦一次。
//
// 已知覆盖缺口：Bash 的 `sed -i`、`>` 重定向、`git apply` 都能写文件，本脚本看不到。
//
// 用法:
//   node guard-scope.mjs <change> --path <file> [--json]     # 单 change 判定
//   node guard-scope.mjs --path <file> [--json]              # 扫描全部活跃租约（hook 用）
//   PIPELINE_GUARD_SCOPE=off 整体关闭（排障用）
//
// 退出码：0 放行；2 拒绝（有租约 + 命中 scope + 无在途写手意图）；1 用法错误。

import fs from 'node:fs';
import { changeIdProblem } from './lib/change-id.mjs';
import { assessWrite, assessAnyWrite } from './lib/scope-guard.mjs';

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const pathIndex = argv.indexOf('--path');
const target = pathIndex >= 0 ? argv[pathIndex + 1] : null;
if (target === null || target.startsWith('--')) {
  console.error('Usage: node guard-scope.mjs [<change>] --path <file> [--json]');
  process.exit(1);
}

function emit(result, change) {
  // 同步写 fd 1 再 exit：管道上的 console.log 是异步 flush，直接 process.exit()
  // 会把刚算出的裁决截断，hook 拿到空输出 → deny 退化成静默放行。
  const text = asJson
    ? JSON.stringify({ change, path: target, ...result })
    : `[guard-scope] ${result.verdict} ${target}：${result.reason}`;
  fs.writeSync(1, `${text}\n`);
  process.exit(result.verdict === 'deny' ? 2 : 0);
}

const change = argv.find((arg, index) => !arg.startsWith('--') && argv[index - 1] !== '--path');
// change 只能是位置参数。把 `--change foo` 照抄进来会让 `foo` 被当成 change 名，
// 于是守卫对着一个游离名字判 scope 并可能放行——与 run-state 里那份游离账本同源。
const KNOWN_FLAGS = new Set(['--path', '--json']);
const leading = argv[0] ?? '';
if (leading.startsWith('--') && !KNOWN_FLAGS.has(leading)) {
  console.error(`[guard-scope] 未知旗标 ${leading}；change 必须作为位置参数给出\n`
    + '正确写法：node guard-scope.mjs <change> --path <file>\n'
    + '（不透传 change 时扫描全部活跃租约：node guard-scope.mjs --path <file>）');
  process.exit(1);
}
if (process.env.PIPELINE_GUARD_SCOPE === 'off') {
  emit({ verdict: 'allow', reason: 'PIPELINE_GUARD_SCOPE=off 显式关闭', path: null }, change ?? null);
}
if (change === undefined) {
  // 不给 change：扫描全部活跃租约。这正是 PreToolUse hook 需要的形态——
  // hook 只知道文件路径，不知道用户此刻在跑哪个 change。
  emit(assessAnyWrite({ target }), null);
} else {
  const problem = changeIdProblem(change);
  if (problem !== null) {
    console.error(`[guard-scope] ${problem}`);
    process.exit(1);
  }
  emit(assessWrite({ change, target }), change);
}
