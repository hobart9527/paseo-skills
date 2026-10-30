// 业务验收矩阵（acceptance.md）的单一解析点（零依赖）。
//
// 为什么需要单独一个模块：这张表有**三个**消费方——冻结预检（freeze-check 核对场景/任务
// 引用与「冻结时不得写 PASS」）、收尾闸门（check-evidence --matrix 取必需场景）、以及
// 验收执行器（acceptance-run 按 Verify 列真跑命令）。此前前两个各自内联了一份表格解析，
// 第三个干脆不存在，于是矩阵里的 Verify 命令从来没有任何代码执行过：
// 「Required=yes 的行写 PASS」完全是自报，与 merge-task 修的「调用者传 true 就能合流」
// 是同一个缺陷在收尾端的翻版。
//
// 解析只做结构：列名、行、单元格。谁是必需行、结果算不算通过、命令能不能执行，
// 由各消费方按自己的判据判——这里不预设立场，也不改判据强度。

/** 冻结矩阵的固定列（顺序即模板顺序）。 */
export const ACCEPTANCE_COLUMNS = ['Scenario', 'Entry', 'Tasks', 'Verify', 'Required', 'Result', 'Evidence'];

/** 场景编号：`SCEN-<段>[-<段>...]`。与 freeze-check / check-evidence 同一形状。 */
export const SCENARIO_RE = /SCEN-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*/g;

function splitRow(line) {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|');
}

/**
 * 解析 Markdown 表格。
 *
 * @returns {{header: string[], rows: Array<Record<string,string>>}|null} 找不到表头返回 null
 */
export function parseMatrix(markdown) {
  const lines = String(markdown ?? '').split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => /^\s*\|/.test(line) && /\bScenario\b/i.test(line));
  if (headerIndex === -1) return null;
  const header = splitRow(lines[headerIndex]).map((cell) => cell.trim());
  const rows = [];
  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!/^\s*\|/.test(line)) continue;
    const cells = splitRow(line);
    // 分隔行（|---|---|）不是数据行。
    if (cells.every((cell) => /^:?-{2,}:?$/.test(cell.trim()))) continue;
    const row = {};
    header.forEach((name, index) => { row[name] = (cells[index] ?? '').trim(); });
    rows.push(row);
  }
  return { header, rows };
}

/** 行里的场景编号（可能一格写多个，取全部）。 */
export function scenarioIds(row) {
  return ((row?.Scenario ?? '').match(SCENARIO_RE) ?? []).map((id) => id.toUpperCase());
}

/** Required 列是否表示「必须通过」。 */
export function isRequired(row) {
  return (row?.Required ?? '').toLowerCase() === 'yes';
}

/** Result 列归一化：大写，空值返回空串（调用方据此区分「空」与「未通过」）。 */
export function resultOf(row) {
  return (row?.Result ?? '').trim().toUpperCase();
}

/** 必需行清单（去重、保序）。 */
export function requiredScenarios(matrix) {
  const out = [];
  for (const row of matrix?.rows ?? []) {
    if (!isRequired(row)) continue;
    for (const id of scenarioIds(row)) {
      if (!out.includes(id)) out.push(id);
    }
  }
  return out;
}

/**
 * 必需行里尚未通过的行。
 * @returns {Array<{scenario: string, result: string}>}
 */
export function requiredNotPassed(matrix) {
  const out = [];
  for (const row of matrix?.rows ?? []) {
    if (!isRequired(row)) continue;
    const result = resultOf(row);
    if (result === 'PASS') continue;
    for (const id of scenarioIds(row)) out.push({ scenario: id, result });
  }
  return out;
}
