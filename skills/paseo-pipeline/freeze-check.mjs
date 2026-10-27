#!/usr/bin/env node
// 冻结前机械预检：一条命令把「任务能不能被执行、场景能不能被对账、矩阵能不能被验收」全查一遍。
//
// 为什么需要它：SKILL §2.1 过去只写了一句「跑一次任务解析」，没给命令。实际后果是
// 冻结后的返工全部发生在下游——`hardening-governance-contracts` 冻结后补了两次任务格式
// 提交，`pipeline-gate-slimming` 直到归档后才发现 19 条 BAD_DONE_LINE。
// 检查太晚的代价是整轮返工，不是一次报错。
//
// 它只做三种事，不新造判据：
//   1. 复用 lib/tasks.mjs 的 parseTasks（与 reconcile / merge-task 同一解析器，禁止另写正则）。
//   2. 核对 spec 的场景编号 与 tasks.md 的 Scenarios 双向闭环（contract-check 的对账前提）。
//   3. 核对 acceptance.md 的业务验收矩阵：场景/任务引用存在、冻结时不得提前写 PASS。
//
// 它**不**做的事（刻意不做）：
//   - 不判断「这个场景的测试写得对不对」「scope 是否闭环」——语义判据由冻结审查的 Auditor 核。
//   - 不因为别的 change 改同一批文件就拦截，只提示（跨 change 顺序是人类在确认点 1 的决定）。
//
// 用法:
//   node freeze-check.mjs openspec/changes/<name> [--json]
// 退出码:
//   0  可以冻结
//   1  有阻断项，不得冻结
//   2  用法错误
import fs from 'node:fs';
import path from 'node:path';
import { parseTasks, normalizeScope } from './lib/tasks.mjs';
import { batchDependencyClosure } from './lib/ledger.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
// `--baseline <dir>` 的取值不是位置参数：跳过它自己的值，否则它会被当成 change 目录。
const baselineIndex = args.indexOf('--baseline');
const baselineArg = args.find((a) => a.startsWith('--baseline='))?.slice('--baseline='.length)
  ?? (baselineIndex >= 0 && baselineIndex + 1 < args.length ? args[baselineIndex + 1] : null);
const positional = args.filter((a, i) => !a.startsWith('--')
  && !(baselineIndex >= 0 && i === baselineIndex + 1));
const changeDir = positional[0];

if (!changeDir) {
  console.error('Usage: node freeze-check.mjs openspec/changes/<name> [--baseline <spec 目录>] [--json]');
  process.exit(2);
}
if (!fs.existsSync(changeDir) || !fs.statSync(changeDir).isDirectory()) {
  console.error(`[freeze-check] change 目录不存在: ${changeDir}`);
  process.exit(2);
}

const SCEN_RE = /SCEN-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*/g;
const SCEN_HEADING = /^#{3,6}\s*Scenario\s*:\s*(.+?)\s*$/i;

const blocking = [];
const advisory = [];

function block(message) { blocking.push(message); }
function advise(message) { advisory.push(message); }

function readIfExists(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

// --- 1. tasks.md：同一解析器 ---
const tasksFile = path.join(changeDir, 'tasks.md');
const tasksMarkdown = readIfExists(tasksFile);
let tasks = [];
if (tasksMarkdown === null) {
  block(`缺少 ${tasksFile}`);
} else {
  const parsed = parseTasks(tasksMarkdown);
  tasks = parsed.tasks;
  for (const error of parsed.errors) {
    block(`tasks.md ${error.code}: ${error.message}`);
  }
  if (tasks.length === 0) {
    block('tasks.md 解析出 0 个任务：编排器看不到任何可派发任务'
      + '（任务行必须是 `- [ ] <序号> <ID> <标题>`，ID 形如 T-01）');
  }
  // scope 合法性：解析器只要求非空，规范性在这里核（与 reconcile 的 badScope 同判据）。
  for (const task of tasks) {
    const bad = task.scope.filter((entry) => normalizeScope(entry) === null);
    if (bad.length > 0) {
      block(`${task.id} 的 Write scope 含非法路径: ${bad.join(', ')}`
        + '（须为仓库根内相对路径，不得绝对路径或逃出根）');
    }
  }
}

// --- 2. spec 场景编号 与 任务 Scenarios 双向闭环 ---
// `--baseline <spec 目录>`：并入基线已声明的场景编号，用于**双向核对的豁免侧**。
//
// 为什么需要：openspec 的 MODIFIED 替换整个 Requirement 块，所以 delta 必须把基线原有
// 场景原样抄回来（抄漏会被 `validate` 拒绝）。抄回来之后，这些编号在 delta 里出现
// 并不代表本 change 新增了它们——它们仍由基线负责。没有这个开关时，双向核对会把
// 「每个声明场景必须被任务认领」施加到抄回来的历史场景上，于是任何含 MODIFIED 的
// change 都冻结不了（本 change 实测：5 条基线场景被判「没有任何任务认领」）。
const baselineScens = new Set();
if (baselineArg !== null) {
  if (!fs.existsSync(baselineArg)) {
    console.error(`[freeze-check] baseline 路径不存在: ${baselineArg}`);
    process.exit(2);
  }
  const baselineFiles = [];
  (function walkBaseline(dir) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walkBaseline(full);
      else if (entry.isFile() && entry.name.endsWith('.md')) baselineFiles.push(full);
    }
  })(baselineArg);
  for (const file of baselineFiles) {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const heading = line.match(SCEN_HEADING);
      const idMatch = heading?.[1].match(/^(SCEN-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)/);
      if (idMatch) baselineScens.add(idMatch[1]);
    }
  }
}

const specFiles = [];
function walkSpecs(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkSpecs(full);
    else if (entry.isFile() && entry.name.endsWith('.md')) specFiles.push(full);
  }
}
walkSpecs(path.join(changeDir, 'specs'));

const declaredScens = new Map(); // id -> 文件
const scenariosWithoutId = [];
for (const file of specFiles) {
  const markdown = fs.readFileSync(file, 'utf8');
  for (const line of markdown.split(/\r?\n/)) {
    const heading = line.match(SCEN_HEADING);
    if (!heading) continue;
    const idMatch = heading[1].match(/^(SCEN-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)/);
    if (!idMatch) {
      scenariosWithoutId.push(`${path.relative(changeDir, file)}: ${line.trim()}`);
      continue;
    }
    const id = idMatch[1];
    if (declaredScens.has(id)) {
      block(`场景编号 ${id} 重复声明（${declaredScens.get(id)} 与 ${path.relative(changeDir, file)}）`);
    } else {
      declaredScens.set(id, path.relative(changeDir, file));
    }
  }
}
for (const entry of scenariosWithoutId) {
  // 不带编号的场景不会被 contract-check 对账：change 看起来验过了，实际什么都没检。
  block(`场景缺少 SCEN- 编号，静态对账会静默跳过: ${entry}`);
}
if (specFiles.length === 0) {
  advise('本 change 没有 spec delta（纯工具/文档变更可用 skip_specs，确认是有意的）');
}

const claimed = new Map(); // scen -> [taskId]
for (const task of tasks) {
  for (const scen of task.scenarios) {
    // 任务认得一个**基线**场景不算错：delta 里的 MODIFIED 必须原样抄回基线场景
    // （openspec 按整块替换，抄漏会被 validate 拒绝），抄回来之后任务若确实仍承载它，
    // 标注出来是诚实的。真正要拦的是引用了**哪儿都没声明**的编号。
    if (!declaredScens.has(scen) && !baselineScens.has(scen)) {
      block(`${task.id} 的 Scenarios 引用了未声明的场景 ${scen}`);
    }
    claimed.set(scen, [...(claimed.get(scen) ?? []), task.id]);
  }
}
for (const [scen, file] of declaredScens) {
  // 基线场景不要求本 change 的任务认领：它们由基线负责，本 change 只是抄回来保住它们。
  if (!claimed.has(scen) && !baselineScens.has(scen)) {
    block(`场景 ${scen}（${file}）没有任何任务认领：验收时必然变成 untested 噪声或幻影声明`);
  }
}

// --- 3. acceptance.md：业务验收矩阵 ---
const acceptanceFile = path.join(changeDir, 'acceptance.md');
const acceptanceMarkdown = readIfExists(acceptanceFile);
const ACCEPT_COLUMNS = ['Scenario', 'Entry', 'Tasks', 'Verify', 'Required', 'Result', 'Evidence'];
let acceptanceRows = 0;

function parseMatrix(markdown) {
  const lines = markdown.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => /^\s*\|/.test(line) && /\bScenario\b/i.test(line));
  if (headerIndex === -1) return null;
  const header = splitRow(lines[headerIndex]).map((cell) => cell.trim());
  const rows = [];
  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!/^\s*\|/.test(line)) continue;
    const cells = splitRow(line);
    if (cells.every((cell) => /^:?-{2,}:?$/.test(cell.trim()))) continue; // 分隔行
    const row = {};
    header.forEach((name, index) => { row[name] = (cells[index] ?? '').trim(); });
    rows.push(row);
  }
  return { header, rows };
}

function splitRow(line) {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|');
}

if (acceptanceMarkdown === null) {
  block(`缺少 ${acceptanceFile}：业务验收矩阵是「算不算交付」的唯一定义，缺了收尾只能临场发挥`);
} else {
  const matrix = parseMatrix(acceptanceMarkdown);
  if (matrix === null) {
    block(`${acceptanceFile} 没有可解析的表格（表头须含 Scenario 列）`);
  } else {
    const missingColumns = ACCEPT_COLUMNS.filter((name) => !matrix.header.includes(name));
    if (missingColumns.length > 0) {
      block(`${acceptanceFile} 表格缺列: ${missingColumns.join(', ')}`
        + `（固定为 ${ACCEPT_COLUMNS.join(' | ')}）`);
    }
    acceptanceRows = matrix.rows.length;
    if (acceptanceRows === 0) {
      block(`${acceptanceFile} 没有任何验收行：至少覆盖一条真实业务旅程或异常路径`);
    }
    const taskIds = new Set(tasks.map((task) => task.id));
    const requiredScens = new Set();
    for (const [index, row] of matrix.rows.entries()) {
      const label = `验收矩阵第 ${index + 1} 行（${row.Scenario || '无场景'}）`;
      const scenIds = (row.Scenario ?? '').match(SCEN_RE) ?? [];
      if (scenIds.length === 0) {
        block(`${label} 的 Scenario 列没有 SCEN- 编号`);
      }
      for (const scen of scenIds) {
        if (!declaredScens.has(scen)) block(`${label} 引用了未声明的场景 ${scen}`);
        if (row.Required?.toLowerCase() === 'yes') requiredScens.add(scen);
      }
      for (const raw of (row.Tasks ?? '').split(/[,\s]+/).filter(Boolean)) {
        if (!taskIds.has(raw)) block(`${label} 引用了不存在的任务 ${raw}`);
      }
      if (!row.Entry || row.Entry === '') block(`${label} 缺少 Entry（真实入口/装配点）`);
      if (!row.Verify || row.Verify === '') block(`${label} 缺少 Verify（怎么验）`);
      const required = (row.Required ?? '').toLowerCase();
      if (!['yes', 'no'].includes(required)) {
        block(`${label} 的 Required 必须是 yes/no，实际是「${row.Required ?? ''}」`);
      }
      const result = (row.Result ?? '').toUpperCase();
      // 冻结时只能写 PENDING：提前写 PASS 等于在什么都没跑之前就宣布验收通过。
      if (!['PENDING', 'BLOCKED', 'UNVERIFIED'].includes(result)) {
        block(`${label} 的 Result 是 ${row.Result || '(空)'}：冻结时只能是 PENDING`
          + '（外部依赖接不通标 BLOCKED/UNVERIFIED），PASS 必须在收尾实测后回填');
      }
    }
    if (requiredScens.size === 0) {
      block(`${acceptanceFile} 没有任何 Required=yes 的行：那等于没有必须通过的验收项`);
    }
  }
}

// --- 4. Pod 成员（可选） ---
// 成员字段是 `tasks`：reconcile.mjs 与 merge-task.mjs 都读它（两者是真正消费冻结成员集的
// 位置）。冻结检查过去读 `taskIds`，于是同一份文件在冻结时被判「没有成员」，在执行时
// 又被正确读取——冻结报告说没问题，实际两个入口对同一字段名的理解不同。
const membersFile = path.join(changeDir, 'pod-members.json');
if (fs.existsSync(membersFile)) {
  try {
    const frozen = JSON.parse(fs.readFileSync(membersFile, 'utf8'));
    const ids = Array.isArray(frozen?.tasks) ? frozen.tasks.filter((id) => typeof id === 'string') : [];
    const taskIds = new Set(tasks.map((task) => task.id));
    for (const id of ids) {
      if (!taskIds.has(id)) block(`pod-members.json 引用了不存在的任务 ${id}`);
    }
    if (ids.length === 0) advise('pod-members.json 存在但没有 tasks 成员；已有的 Pod 合流会因空成员集被拒');
    // 旧字段名会让三处消费者中的两处读不到成员：冻结时在这里说清楚，而不是等合流才报空集。
    if (!Array.isArray(frozen?.tasks) && Array.isArray(frozen?.taskIds)) {
      block('pod-members.json 用了旧字段名 taskIds：reconcile.mjs 与 merge-task.mjs 只读 tasks，'
        + 'Pod 合流会因空成员集被拒');
    }
    if (ids.length > 0) {
      const byId = new Map(tasks.map((task) => [task.id, task]));
      // Pod 是单次整体合流：成员之间的依赖由这一次合流一并满足，不要求合流前已被证明。
      // 但依赖落在成员集之外的任务仍须靠 first-parent 已 Done，否则合流会被 exit 35 拒。
      // 环在解析阶段已是 graph 级错误，这里不必重复判。
      const outsideDeps = [];
      for (const id of ids) {
        const task = byId.get(id);
        if (task === undefined) continue;
        const closure = batchDependencyClosure(task, ids, byId);
        for (const dep of closure.outside) {
          if (!outsideDeps.some((entry) => entry.dep === dep)) outsideDeps.push({ task: id, dep });
        }
      }
      for (const entry of outsideDeps) {
        advise(`${entry.task} 依赖 Pod 成员集之外的 ${entry.dep}：合流前它必须已被 first-parent 证明 Done，`
          + '否则 Pod 合流会因依赖未验收被拒');
      }
      if (outsideDeps.length === 0) {
        advise(`Pod 成员 ${ids.length} 个的依赖闭包完全落在成员集内，单次合流可满足`);
      }
    }
  } catch (error) {
    block(`pod-members.json 无法解析: ${error.message}`);
  }
}

// --- 5. 跨 change 写范围重叠（只提示，不拦截） ---
// 同仓两个 change 改同一文件是真实发生过的（approval-hub 的 approval-service.ts / api.ts）。
// 顺序是人类在确认点 1 的决定，不是脚本能替人做的决定，所以这里只出提示。
const changesRoot = path.dirname(path.resolve(changeDir));
const selfName = path.basename(path.resolve(changeDir));
const overlaps = new Map();
if (tasks.length > 0 && fs.existsSync(changesRoot)) {
  for (const entry of fs.readdirSync(changesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === selfName || entry.name === 'archive') continue;
    const otherTasksFile = path.join(changesRoot, entry.name, 'tasks.md');
    const otherMarkdown = readIfExists(otherTasksFile);
    if (otherMarkdown === null) continue;
    const other = parseTasks(otherMarkdown);
    for (const mine of tasks) {
      for (const theirs of other.tasks) {
        const shared = mine.scope.filter((myScope) => theirs.scope.some((theirScope) => scopesOverlap(myScope, theirScope)));
        if (shared.length > 0) {
          const key = entry.name;
          overlaps.set(key, [...(overlaps.get(key) ?? []), `${mine.id}↔${theirs.id}: ${shared.join(', ')}`]);
        }
      }
    }
  }
}
for (const [other, pairs] of overlaps) {
  advise(`与活跃 change ${other} 的写范围重叠（${pairs.length} 对）：${pairs.slice(0, 3).join('; ')}`
    + '；顺序须在冻结确认时裁决');
}

function scopesOverlap(a, b) {
  const left = normalizeScope(a);
  const right = normalizeScope(b);
  if (!left || !right) return false;
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length <= right.length ? right : left;
  for (let i = 0; i < shorter.length; i += 1) {
    if (shorter[i] !== longer[i]) return false;
  }
  return true;
}

// --- 编排路由（只提示，不参与退出码） ---
//
// 「该谁编排」是冻结时就能数出来的事实，不该留给模型自己估：2026-10-27 `eas-filing-and-local-ocr`
// 的 8 个任务够交 Shangshu，但冻结输出里只有 `tasks=8`，主会话确认点 1 后直接在本机写了实现代码。
// 判据与 SKILL 的「预计派发 ≥6 次」同源，按任务档位机械累加：
//   - 每个任务至少一次写手派发；
//   - 非 mechanical 档另加一次独立审计；
//   - strict 档再加一次 Tester 先行（先写 Red）。
// 审查档位未定（既没声明 Review 也没风险面）按 standard 计，因为合流时它 fail closed，不会省掉审计。
function estimatedDispatches(list) {
  return list.reduce((sum, task) => {
    const review = task.requiredReview ?? 'standard';
    return sum + 1 + (review === 'mechanical' ? 0 : 1) + (review === 'strict' ? 1 : 0);
  }, 0);
}

const dispatches = estimatedDispatches(tasks);
const route = dispatches >= 6 ? 'lead' : 'pod';
const routeNote = route === 'lead'
  ? `[ROUTE] lead：预计派发 ${dispatches} 次（≥6），确认点 1 后必须交 agent_profile_shangshu 无人值守编排，`
    + '主会话立即停笔、不准读写业务代码，只守确认点 1 与 2'
  : `[ROUTE] pod：预计派发 ${dispatches} 次（<6），主会话可自行编排，`
    + '但每个任务仍须委派 agent_profile_gongbu 在独立 workspace 完成，主会话不写实现代码';

// --- 输出 ---
//
// **归档 change 一律只出提示。** `openspec/changes/archive/` 是历史记录，不是待执行的计划：
// 实测四个归档 change 在当前规则下全部判「不得冻结」（contract-alignment 14、wakeup-budget 30、
// gate-slimming 31、native-closure 1），而其中绝大多数是「写的时候这条规则还不存在」——
// 例如 2026-10-26 之前的 Done 行用 `review=main-session`，那是当时的合法形态。
// 用今天的语法追溯执法，只会让只读诊断永远红着，红到最后没人再看它。
// 冻结预检回答的是「这份计划现在能不能开工」，归档的东西已经没有这个问题的答案。
const archived = path.resolve(changeDir).split(path.sep).includes('archive');
const effectiveBlocking = archived ? [] : blocking;
const effectiveAdvisory = archived
  ? [...blocking.map((item) => `[已归档，仅记录] ${item}`), ...advisory]
  : advisory;

const summary = {
  change: changeDir,
  archived,
  tasks: tasks.length,
  scenarios: declaredScens.size,
  acceptanceRows,
  dispatches,
  route,
  blocking: effectiveBlocking,
  advisory: effectiveAdvisory,
};

if (json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`[freeze-check] ${changeDir}${archived ? '（已归档）' : ''}`);
  console.log(`  tasks=${summary.tasks} scenarios=${summary.scenarios} acceptanceRows=${summary.acceptanceRows}`);
  console.log(`  ${routeNote}`);
  for (const item of effectiveAdvisory) console.log(`  HINT  ${item}`);
  for (const item of effectiveBlocking) console.error(`  BLOCK ${item}`);
  if (archived) {
    console.log('  RESULT 已归档：历史记录只读诊断，不做可冻结判定');
  } else {
    console.log(effectiveBlocking.length === 0
      ? '  RESULT 可冻结（0 阻断项）；语义判据（scope 闭环、delta 对基线）仍由冻结审查逐条核'
      : `  RESULT 不得冻结：${effectiveBlocking.length} 个阻断项`);
  }
}
process.exit(effectiveBlocking.length === 0 ? 0 : 1);
