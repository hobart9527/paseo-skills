#!/usr/bin/env node
// Deterministic diff risk & test-oracle scanner for Tier 1/2/3 delivery gates.
import { parseOptions } from './lib/cli.mjs';
import { scanRepo } from './lib/risk-scan.mjs';

const usage = 'Usage: risk-scan.mjs <base> [<head>] [--cwd <dir>] [--working-tree] [--files <p1,p2>] [--tracked-only] [--json] [--require-clean]';

let parsed;
try {
  parsed = parseOptions(process.argv.slice(2), {
    cwd: 'value',
    'working-tree': 'boolean',
    files: 'repeat',
    'tracked-only': 'boolean',
    json: 'boolean',
    'require-clean': 'boolean',
  });
} catch (error) {
  console.error(`[risk-scan] ${error.message}\n${usage}`);
  process.exit(2);
}

const [base, head] = parsed.positional;
if (!base || parsed.positional.length > 2) {
  console.error(usage);
  process.exit(2);
}
if (head && parsed.options['working-tree']) {
  console.error(`[risk-scan] cannot combine <head> with --working-tree\n${usage}`);
  process.exit(2);
}

let report;
try {
  report = scanRepo({
    cwd: parsed.options.cwd || process.cwd(),
    base,
    head: head || null,
    workingTree: !!parsed.options['working-tree'],
    files: parsed.options.files || null,
    trackedOnly: !!parsed.options['tracked-only'],
  });
} catch (error) {
  console.error(`[risk-scan] ${error.message}`);
  process.exit(2);
}

if (parsed.options.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`[risk-scan] ${report.base.slice(0, 7)}..${report.head ? report.head.slice(0, 7) : 'working-tree'}`);
  console.log(`tierRequired=${report.tierRequired} reviewRequired=${report.reviewRequired} sources=${report.sourceFiles.length} scopes=${report.scopes.length}`);
  if (report.classes.length) console.log(`classes: ${report.classes.join(', ')}`);
  for (const hit of report.hits) {
    const tag = hit.untracked ? '(untracked) ' : '';
    console.log(`RISK [${hit.class}] ${tag}${hit.file}: ${hit.reason}`);
  }
  for (const mut of report.testMutations) console.log(`ORACLE ${mut.file}: ${mut.reason}`);
  for (const cav of report.caveatRemovals || []) console.log(`CAVEAT ${cav.file}: ${cav.reason}`);
  if (report.untrackedOnlyRisk) {
    console.log(`NOTE hits came only from untracked files (${report.untrackedFiles.length} untracked); if pre-existing repo residue, re-run with --files <changed-paths> or clean untracked files.`);
  }
  if (!report.reviewRequired) console.log('RESULT risk-scan clean');
  else console.log('RESULT review-required');
}

if (parsed.options['require-clean'] && report.reviewRequired) process.exit(1);
