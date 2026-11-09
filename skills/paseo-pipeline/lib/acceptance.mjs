// Acceptance-table recognition, shared by the freeze gate and the read-only scenarios helper.
//
// This is deliberately only *recognition*: which line is the header, how a cell is split and
// unescaped, and which rows are scenario rows. It validates nothing and reports no blocking code.
// freeze-check keeps every rule and message it had (so the gate cannot drift); the helper reads
// the same rows to show the author which acceptance relations already exist.
export const ACCEPTANCE_COLUMNS = ['scenario', 'entry', 'tasks', 'verify', 'required', 'result', 'evidence'];

// A literal `|` inside a cell silently changes the column count; `\|` is the escape the template
// documents. Cells keep inner whitespace trimmed and drop one surrounding backtick pair.
export function cellsOf(line) {
  return String(line || '').split(/(?<!\\)\|/).slice(1, -1)
    .map((cell) => cell.trim().replace(/\\\|/g, '|').replace(/^`|`$/g, ''));
}

// A scenario row starts with a SCEN id. Prose and the header do not.
export const isAcceptanceRow = (line) => /^\s*\|\s*SCEN-[A-Za-z0-9-]+\s*\|/.test(String(line || ''));

/**
 * Read the acceptance table as rows. `headerOk` says the header has exactly the seven documented
 * columns in order; `expectedColumns` is the header's own width when one exists, else seven (the
 * gate's historical fallback). Rows with the wrong cell count are `malformed`, not `rows`, so a
 * caller can report the same row it always reported.
 *
 * `entries` keeps the table's own line order, with malformed rows and valid rows interleaved, so
 * a caller that reports diagnostics can emit them in the order the author sees them. Base
 * freeze-check walked the lines once and reported in that order; grouping malformed rows first
 * changed the output of an invalid package for no reason.
 */
export function parseAcceptanceTable(markdown) {
  const lines = String(markdown || '').split(/\r?\n/);
  const headerLine = lines.find((line) => /^\s*\|.*\|\s*$/.test(line) && /\bScenario\b/i.test(line)) ?? null;
  const headerCells = headerLine === null ? null : cellsOf(headerLine);
  const headerOk = headerLine !== null && headerCells.join('|').toLowerCase() === ACCEPTANCE_COLUMNS.join('|');
  const expectedColumns = headerCells ? headerCells.length : ACCEPTANCE_COLUMNS.length;
  const rows = [];
  const malformed = [];
  const entries = [];
  lines.forEach((line, index) => {
    if (!isAcceptanceRow(line)) return;
    const cells = cellsOf(line);
    const lineNumber = index + 1;
    if (cells.length !== expectedColumns) {
      const problem = { line: lineNumber, cells: cells.length, expectedColumns };
      malformed.push(problem);
      entries.push({ line: lineNumber, malformed: problem });
      return;
    }
    const row = {
      line: lineNumber,
      // `scenRaw` is the id as written: diagnostic messages echo it, the keyed comparisons use
      // the uppercased `scen` the gate has always keyed on.
      scenRaw: cells[0],
      scen: cells[0].toUpperCase(),
      entry: cells[1],
      tasksRaw: cells[2].trim(),
      verify: cells[3],
      required: cells[4],
      result: cells[5],
      evidence: cells[6],
    };
    rows.push(row);
    entries.push({ line: lineNumber, row });
  });
  return { headerLine, headerOk, expectedColumns, rows, malformed, entries };
}
