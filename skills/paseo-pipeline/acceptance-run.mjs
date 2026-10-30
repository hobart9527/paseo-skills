#!/usr/bin/env node
// 业务验收执行器：把冻结矩阵里 Required=yes 行的 Verify 命令**真跑一遍**。
//
// 为什么需要：收尾闸门 `check-evidence --gate acceptance --matrix acceptance.md` 只读
// Result 列。有闸门、没有执行者，于是「Required 行写 PASS」完全靠人手抄 —— 与 merge-task
// 修掉的「调用者传 true 就能合流」是同一个缺陷：**结论可自报，且没有任何代码检查它是否
// 真的跑过**。本脚本补上缺的那一环：读矩阵 → 逐行执行 Verify → 记录真实退出码、耗时、
// 输出尾部 → 生成可回填的 Result/Evidence。
//
// 判据边界（与证据闸门同一条线）：
//   - 命令退出码 0 才写 PASS；非 0 写 FAIL（不是「跳过」「未验证」）。
//   - Verify 单元格不是可执行命令（自然语言）→ 直接拒绝整轮（exit 2），不静默跳过。
//     自然语言描述既不能跑，也不该被当成「验证过了」。
//   - 只跑矩阵里 Required=yes 的行；--only 只允许**缩小本次执行范围**并会把未覆盖的必需行
//     报成 exit 3（部分验证不得冒充整体验收）——与 check-evidence 的「调用者只能收紧」同向。
//   - 不判定业务正确性：命令通过说明入口跑得通，语义是否达标由 Auditor 判。
//
// 用法:
//   node acceptance-run.mjs <change> [--matrix <acceptance.md>] [--only SCEN-1,SCEN-2]
//                            [--timeout <秒>] [--dry-run] [--write] [--json]
//   --matrix 缺省 openspec/changes/<change>/acceptance.md
//   --write  把结果回填进矩阵的 Result/Evidence 两列（只回填本次真跑过的行）
//   --dry-run 只打印将要执行的命令，不执行、不回填
// 退出码:
//   0  全部必需行执行且通过
//   1  有必需行执行失败
//   2  用法错误 / 矩阵不可解析 / Verify 不是可执行命令
//   3  部分验证：--only 导致存在未被本次执行的必需行
//   4  存在被阻塞的必需行（外部依赖不可达，矩阵里标 BLOCKED）
import { spawnSync } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  parseMatrix, requiredScenarios, scenarioIds, isRequired, resultOf, ACCEPTANCE_COLUMNS,
} from './lib/acceptance-matrix.mjs';
import { parseVerify } from './lib/tasks.mjs';
import { runStateRoot } from './lib/run-state.mjs';

const DEFAULT_TIMEOUT_SEC = 600;

function usage(message) {
  if (message) console.error(`[acceptance-run] ${message}`);
  console.error('Usage: node acceptance-run.mjs <change> [--matrix <acceptance.md>] [--only SCEN-1,SCEN-2]'
    + ' [--timeout <秒>] [--dry-run] [--write] [--json]');
  process.exit(2);
}

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const dryRun = args.includes('--dry-run');
const write = args.includes('--write');
const valueOf = (name) => {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) usage(`${name} 需要一个取值`);
  return value;
};
const only = valueOf('--only');
const timeoutSec = Number(valueOf('--timeout') ?? DEFAULT_TIMEOUT_SEC);
if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) usage('--timeout 必须是正数（秒）');

// 位置参数 = change；跳过所有旗标的取值，否则 `--matrix x.md` 里的 x.md 会被当成 change。
const VALUE_FLAGS = new Set(['--matrix', '--only', '--timeout']);
const positional = args.filter((arg, index) => !arg.startsWith('--')
  && !(index > 0 && VALUE_FLAGS.has(args[index - 1])));
const change = positional[0];
if (!change) usage('缺少 change 名');
if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(change)) usage(`change 名非法：${JSON.stringify(change)}`);

const matrixFile = valueOf('--matrix') ?? path.join('openspec', 'changes', change, 'acceptance.md');
if (!fs.existsSync(matrixFile)) usage(`找不到验收矩阵：${matrixFile}`);

const matrix = parseMatrix(fs.readFileSync(matrixFile, 'utf8'));
if (matrix === null) usage(`${matrixFile} 没有可解析的表格（表头须含 Scenario 列）`);
const missingColumns = ACCEPTANCE_COLUMNS.filter((name) => !matrix.header.includes(name));
if (missingColumns.length > 0) {
  usage(`${matrixFile} 表格缺列: ${missingColumns.join(', ')}（固定为 ${ACCEPTANCE_COLUMNS.join(' | ')}）`);
}

const required = requiredScenarios(matrix);
if (required.length === 0) usage(`${matrixFile} 没有任何 Required=yes 的行：那等于没有必须通过的验收项`);

const selected = only === null
  ? required
  : only.split(',').map((id) => id.trim().toUpperCase()).filter(Boolean);
const unknown = selected.filter((id) => !required.includes(id));
if (unknown.length > 0) {
  usage(`--only 里的场景不是必需行（或不存在）：${unknown.join(', ')}；必需行是 ${required.join(', ')}`);
}

// 每行一条执行计划。同一行可能挂多个场景编号（Pod 场景），按行执行一次、结果记给所有编号。
const plans = [];
for (const row of matrix.rows) {
  if (!isRequired(row)) continue;
  const ids = scenarioIds(row);
  if (!ids.some((id) => selected.includes(id))) continue;
  const verify = parseVerify(row.Verify ?? '');
  plans.push({ row, ids, verify });
}

const results = [];
if (!asJson) console.log(`[acceptance-run] ${change} 矩阵 ${matrixFile}`);
for (const plan of plans) {
  const { ids, verify } = plan;
  if (verify.command === null) {
    // 不可执行的 Verify 不是「跳过」：它是冻结质量缺陷，必须当场暴露。
    const message = `Verify 不是可执行命令（自然语言）：${JSON.stringify(verify.raw)}`
      + `（场景 ${ids.join(', ')}）；矩阵里的每一行都必须给出一条能跑的入口命令`;
    if (asJson) {
      console.log(JSON.stringify({ change, matrixFile, error: message, results: [] }, null, 2));
    } else {
      console.error(`[acceptance-run] ${message}`);
    }
    process.exit(2);
  }
  if (dryRun) {
    results.push({ ids, command: verify.command, dryRun: true });
    if (!asJson) console.log(`[dry-run] ${ids.join(',')} → ${verify.command}`);
    continue;
  }
  const startedAt = Date.now();
  const run = spawnSync('/bin/sh', ['-c', verify.command], {
    encoding: 'utf8', timeout: timeoutSec * 1000, cwd: process.cwd(),
    env: { ...process.env, PIPELINE_ACCEPTANCE_CHANGE: change },
  });
  const durationMs = Date.now() - startedAt;
  const timedOut = run.error?.code === 'ETIMEDOUT' || run.signal === 'SIGTERM';
  const status = run.status;
  const passed = !timedOut && status === 0;
  results.push({
    ids,
    command: verify.command,
    exitCode: status,
    signal: run.signal ?? null,
    timedOut,
    passed,
    durationMs,
    stdoutTail: tail(run.stdout ?? ''),
    stderrTail: tail(run.stderr ?? ''),
  });
}

function tail(text, lines = 20) {
  const all = String(text).split(/\r?\n/);
  const kept = all.slice(Math.max(0, all.length - lines));
  return kept.join('\n').trim();
}

const failed = results.filter((entry) => entry.dryRun !== true && entry.passed !== true);
const executedIds = new Set(results.flatMap((entry) => entry.ids));
const uncovered = required.filter((id) => !executedIds.has(id));
const blockedRows = matrix.rows
  .filter((row) => isRequired(row) && resultOf(row) === 'BLOCKED')
  .flatMap((row) => scenarioIds(row))
  .filter((id) => !executedIds.has(id));

// 收据落在 git common dir：与运行账本同一处，不弄脏工作树（合流要求工作树干净）。
const receiptFile = path.join(runStateRoot(), change, 'acceptance-receipt.json');

if (!asJson) {
  console.log(`  —— 共 ${results.filter((entry) => entry.dryRun !== true).length} 条已执行；收据 ${receiptFile}`);
  for (const entry of results) {
    if (entry.dryRun) continue;
    const mark = entry.passed ? 'PASS' : (entry.timedOut ? 'TIMEOUT' : 'FAIL');
    console.log(`  ${mark} ${entry.ids.join(',')} exit=${entry.exitCode ?? entry.signal} `
      + `${Math.round(entry.durationMs / 1000)}s  ${entry.command}`);
  }
  if (uncovered.length > 0) console.log(`  未执行（不在 --only 范围）：${uncovered.join(', ')}`);
}

const receipt = {
  change,
  matrix: matrixFile,
  head: headSha(),
  at: new Date().toISOString(),
  dryRun,
  required,
  executed: [...executedIds],
  uncovered,
  results,
};
fs.mkdirSync(path.dirname(receiptFile), { recursive: true });
fs.writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');

function headSha() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000,
    }).trim();
  } catch {
    return null;
  }
}

// 回填：只改本次真跑过的行的 Result / Evidence，其余行原样保留（人工填的 BLOCKED 不该被抹）。
if (write && !dryRun) {
  const updated = writeBack(fs.readFileSync(matrixFile, 'utf8'), results);
  fs.writeFileSync(matrixFile, updated, 'utf8');
  if (!asJson) console.log(`  已回填 ${matrixFile}（Result/Evidence，${results.length} 行）`);
}

/**
 * 按行回填 Result / Evidence。行识别靠**原始行内容**而不是重建整张表：重建会改掉
 * 列宽、对齐与人工注释，让这份冻结产物在 git diff 里无法审阅。
 */
function writeBack(markdown, entries) {
  const byScenario = new Map();
  for (const entry of entries) {
    for (const id of entry.ids) byScenario.set(id, entry);
  }
  const lines = markdown.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => /^\s*\|/.test(line) && /\bScenario\b/i.test(line));
  if (headerIndex === -1) return markdown;
  const header = lines[headerIndex].trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  const scenCol = header.indexOf('Scenario');
  const resCol = header.indexOf('Result');
  const evCol = header.indexOf('Evidence');
  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    if (!/^\s*\|/.test(lines[i])) continue;
    const cells = lines[i].trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    if (cells.every((cell) => /^:?-{2,}:?$/.test(cell))) continue;
    const ids = (cells[scenCol] ?? '').match(/SCEN-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*/gi) ?? [];
    const entry = ids.map((id) => byScenario.get(id.toUpperCase())).find(Boolean);
    if (!entry) continue;
    cells[resCol] = entry.passed ? 'PASS' : 'FAIL';
    cells[evCol] = `${receiptFile}#${entry.ids.join(',')}`;
    lines[i] = `| ${cells.join(' | ')} |`;
  }
  return lines.join('\n');
}

if (asJson) {
  console.log(JSON.stringify({ ...receipt, receiptFile, failed: failed.length }, null, 2));
}

if (dryRun) process.exit(0);
if (failed.length > 0) process.exit(1);
if (uncovered.length > 0) {
  if (!asJson) {
    console.error(`[acceptance-run] 未覆盖的必需行：${uncovered.join(', ')}；`
      + '部分验证不能当作验收完成（收尾闸门仍会拒绝）');
  }
  process.exit(3);
}
if (blockedRows.length > 0) {
  if (!asJson) console.error(`[acceptance-run] 被阻塞的必需行：${blockedRows.join(', ')}`);
  process.exit(4);
}
process.exit(0);
