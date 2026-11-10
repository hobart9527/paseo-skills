#!/usr/bin/env node
// CLI half of the read-only `scenarios` helper: argument parsing, rendering, exit code.
// The derivation lives in lib/scenarios-report.mjs so tests can exercise it without a process.

import path from 'node:path';
import { buildScenariosReport } from './lib/scenarios-report.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const positional = args.filter((arg) => !arg.startsWith('--'));
const unknown = args.find((arg) => arg.startsWith('--') && arg !== '--json');
if (unknown || positional.length !== 1) {
  console.error('Usage: pipeline-run.mjs scenarios <change-dir> [--json]');
  process.exit(2);
}

const changeDir = path.resolve(positional[0]);
const report = buildScenariosReport(changeDir);

if (json) {
  console.log(JSON.stringify({ change: changeDir, ...report }, null, 2));
} else if (report.errors.length) {
  console.error(`[scenarios] ${changeDir}: input could not be read or parsed; no relations were derived`);
} else {
  const lines = [`[scenarios] ${changeDir}`, `declared=${report.scenarios.length} source=worktree-draft`, ''];
  for (const entry of report.scenarios) {
    const rows = entry.acceptanceRows.length;
    lines.push(`SCEN ${entry.id}${entry.title ? ` ${entry.title}` : ''}`);
    lines.push(`  claimants: ${entry.claimants.join(', ') || 'none'}`);
    lines.push(`  identity: ${entry.identity.kind}${entry.identity.files.length ? ` (${entry.identity.files.join(', ')})` : ''}`);
    lines.push(`  acceptance rows: ${rows}`);
    for (const row of entry.acceptanceRows) lines.push(`    acceptance.md:${row.line} tasks=${row.tasks.join(',') || 'derived'} required=${row.required}`);
    if (entry.gaps.length) for (const gap of entry.gaps) lines.push(`  GAP ${gap}`);
    lines.push(`  candidate: | ${entry.candidate.Scenario} | <Entry: author> | ${entry.candidate.Tasks || '<empty: fill before freeze>'} | <Verify: author> | <Required: author> | PENDING | pending |`);
  }
  if (report.undeclaredClaims.length) {
    lines.push('', `Claims with no declared scenario (${report.undeclaredClaims.length}):`);
    for (const item of report.undeclaredClaims) lines.push(`  ${item.task} claims ${item.scen}, which specs/ does not declare`);
  }
  if (report.undeclaredRows.length) {
    lines.push('', `Acceptance rows with no declared scenario (${report.undeclaredRows.length}):`);
    for (const item of report.undeclaredRows) lines.push(`  acceptance.md:${item.line} ${item.scen}`);
  }
  if (!report.acceptance.present) lines.push('', 'no acceptance.md yet: every declared scenario has no row');
  lines.push('', 'Candidates are a computed suggestion from this draft, never a freezable row: they carry no Entry,');
  lines.push('business expectation, Required or test-sufficiency claim, and structural freeze plus R0 still decide.');
  console.log(lines.join('\n'));
}

if (report.errors.length) {
  if (json) console.error(`[scenarios] ${report.errors.length} input error(s); no relations were derived`);
  for (const error of report.errors) console.error(`ERROR ${error.code}: ${error.message}${error.task ? ` (${error.task})` : ''}${error.line ? ` at line ${error.line}` : ''}`);
  process.exit(1);
}
