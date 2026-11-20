#!/usr/bin/env node
// Derive or update acceptance.md directly from specs/ (SCEN-*, **Verify:**, optional **Entry:**)
// and tasks.md (Scenarios claimants). Preserves existing non-placeholder Entry and Required columns.
import fs from 'node:fs';
import path from 'node:path';
import { parseTasks } from './lib/tasks.mjs';
import { loadSpecTree, scanScenVerify } from './lib/spec-scan.mjs';
import { parseAcceptanceTable } from './lib/acceptance.mjs';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const positional = args.filter((a) => !a.startsWith('--'));
if (positional.length !== 1) {
  console.error('Usage: acceptance-sync.mjs <change-dir> [--dry-run]');
  process.exit(2);
}

const changeDir = path.resolve(positional[0]);
const tasksPath = path.join(changeDir, 'tasks.md');
if (!fs.existsSync(tasksPath)) {
  console.error(`[acceptance-sync] missing ${tasksPath}`);
  process.exit(1);
}

const { tasks, errors } = parseTasks(fs.readFileSync(tasksPath, 'utf8'));
if (errors.length) {
  console.error(`[acceptance-sync] invalid tasks.md: ${errors.map((e) => e.message).join('; ')}`);
  process.exit(1);
}

const claimantsByScen = new Map();
for (const task of tasks) {
  for (const scen of task.scenarios) {
    const key = scen.toUpperCase();
    if (!claimantsByScen.has(key)) claimantsByScen.set(key, []);
    claimantsByScen.get(key).push(task.id);
  }
}

const specTree = loadSpecTree({ repoRoot: null, changeDir });
const specsScenarios = [];
for (const { text } of specTree.current) {
  for (const found of scanScenVerify(text)) {
    specsScenarios.push(found);
  }
}

const acceptancePath = path.join(changeDir, 'acceptance.md');
const existingByScen = new Map();
if (fs.existsSync(acceptancePath)) {
  const parsed = parseAcceptanceTable(fs.readFileSync(acceptancePath, 'utf8'));
  for (const row of parsed.rows) {
    if (!existingByScen.has(row.scen)) existingByScen.set(row.scen, row);
  }
}

const header = '| Scenario | Entry | Tasks | Verify | Required | Result | Evidence |\n| --- | --- | --- | --- | --- | --- | --- |';
const rows = specsScenarios.map((scen) => {
  const key = scen.id.toUpperCase();
  const prev = existingByScen.get(key);
  const entry = prev?.entry && !/^<.*>$/.test(prev.entry) ? prev.entry : '<真实入口：route / UI / CLI>';
  const claimants = (claimantsByScen.get(key) ?? []).join(',') || '<unclaimed>';
  const verify = scen.verify || prev?.verify || '<Verify command>';
  const required = prev?.required && /^(yes|no)$/i.test(prev.required) ? prev.required.toLowerCase() : 'yes';
  return `| ${scen.id} | ${entry} | ${claimants} | ${verify} | ${required} | PENDING | pending |`;
});

const content = `# Acceptance Matrix\n\n${header}\n${rows.join('\n')}\n`;
if (dryRun) {
  process.stdout.write(content);
} else {
  fs.writeFileSync(acceptancePath, content);
  console.log(`[acceptance-sync] wrote ${rows.length} row(s) to ${acceptancePath}`);
}
