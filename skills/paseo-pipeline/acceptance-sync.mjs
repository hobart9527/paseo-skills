#!/usr/bin/env node
// Derive or update acceptance.md directly from specs/ (SCEN-*) and tasks.md
// (Scenarios claimants, Verify with:, Entry:, Required:).
// Preserves existing non-placeholder Entry/Required when tasks.md omits them, and falls back
// to legacy spec-level **Verify:** when tasks.md has none.
import fs from 'node:fs';
import path from 'node:path';
import { parseTasks, entryForScenario, requiredForScenario } from './lib/tasks.mjs';
import { loadSpecTree, scanScenVerify } from './lib/spec-scan.mjs';
import { parseAcceptanceTable } from './lib/acceptance.mjs';
import { unprovableVerifyReason } from './lib/verify-policy.mjs';

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

const tasksByScen = new Map();
for (const task of tasks) {
  for (const scen of task.scenarios) {
    const key = scen.toUpperCase();
    if (!tasksByScen.has(key)) tasksByScen.set(key, []);
    tasksByScen.get(key).push(task);
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

function escapeTableCell(text) {
  return String(text || '').replace(/(?<!\\)\|/g, '\\|');
}

function resolveVerify(scenId, claimantTasks, scenVerify, prevVerify) {
  const taskVerifies = [...new Set(claimantTasks.map((t) => t.verify.trim()).filter(Boolean))];
  if (taskVerifies.length === 1) return taskVerifies[0];
  if (taskVerifies.length > 1) {
    const composed = taskVerifies.join(' && ');
    const reason = unprovableVerifyReason(composed);
    if (reason) {
      console.error(`[acceptance-sync] cannot compose Verify for ${scenId}: ${reason}`);
      process.exit(1);
    }
    return composed;
  }
  return scenVerify || prevVerify || '<Verify command>';
}

const header = '| Scenario | Entry | Tasks | Verify | Required | Result | Evidence |\n| --- | --- | --- | --- | --- | --- | --- |';
const rows = specsScenarios.map((scen) => {
  const key = scen.id.toUpperCase();
  const prev = existingByScen.get(key);
  const claimantTasks = tasksByScen.get(key) ?? [];
  const taskEntry = claimantTasks.map((t) => entryForScenario(t, key)).find(Boolean);
  const entry = taskEntry || (prev?.entry && !/^<.*>$/.test(prev.entry) ? prev.entry : '<真实入口：route / UI / CLI>');
  const claimants = claimantTasks.map((t) => t.id).join(',') || '<unclaimed>';
  const verify = resolveVerify(scen.id, claimantTasks, scen.verify, prev?.verify);
  const explicitReqs = claimantTasks.map((t) => requiredForScenario(t)).filter(Boolean);
  const required = explicitReqs.length
    ? (explicitReqs.includes('yes') ? 'yes' : 'no')
    : (prev?.required && /^(yes|no)$/i.test(prev.required) ? prev.required.toLowerCase() : 'yes');
  return `| ${scen.id} | ${escapeTableCell(entry)} | ${claimants} | ${escapeTableCell(verify)} | ${required} | PENDING | pending |`;
});

const content = `# Acceptance Matrix\n\n${header}\n${rows.join('\n')}\n`;
if (dryRun) {
  process.stdout.write(content);
} else {
  fs.writeFileSync(acceptancePath, content);
  console.log(`[acceptance-sync] wrote ${rows.length} row(s) to ${acceptancePath}`);
}
