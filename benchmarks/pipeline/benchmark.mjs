#!/usr/bin/env node
// Scheduling benchmark: same frozen tasks, two policies (legacy vs converged).
// Makespan comes from lib/schedule.mjs, which is the single cost model shared with
// freeze-check; this script only compares policies and prints the delta.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const libDir = path.resolve(here, '../../skills/paseo-pipeline/lib');
const { parseTasks } = await import(path.join(libDir, 'tasks.mjs'));
const { simulate, weightedCriticalPath, DEFAULT_MODEL } = await import(path.join(libDir, 'schedule.mjs'));

const args = process.argv.slice(2);
const json = args.includes('--json');
const assertArg = args.find((a) => a.startsWith('--assert='));
const files = args.filter((a) => !a.startsWith('--'));
const baselineFile = files[0] ?? path.join(here, 'baseline-tasks.md');
const convergedFile = files[1] ?? path.join(here, 'converged-tasks.md');
const modelFile = files[2];
// Contract phase is measured, not simulated: 263 min (first spec commit -> R0 pass) vs the
// target 45 min (preflight + one author pass + lint + one R0). Post-execution is the sink
// full suite plus the FINAL integrated review, identical under both policies.
const CONTRACT = { legacy: 263, converged: 45 };
const POST = 100;

function load(file) {
  const parsed = parseTasks(fs.readFileSync(file, 'utf8'));
  const fatal = parsed.errors.filter((e) => !['MISSING_VERIFY'].includes(e.code));
  if (fatal.length) {
    console.error(`[benchmark] ${file}: ${fatal.map((e) => `${e.code} ${e.message}`).join('; ')}`);
    process.exit(2);
  }
  return parsed.tasks;
}
const model = modelFile ? { ...DEFAULT_MODEL, ...JSON.parse(fs.readFileSync(modelFile, 'utf8')) } : DEFAULT_MODEL;

const legacyTasks = load(baselineFile);
const convergedTasks = load(convergedFile);
const legacy = simulate(legacyTasks, { policy: 'legacy', model });
const converged = simulate(convergedTasks, { policy: 'converged', model });
const legacyChain = weightedCriticalPath(legacyTasks, model);
const convergedChain = weightedCriticalPath(convergedTasks, model);

const pct = (from, to) => Number((((from - to) / from) * 100).toFixed(1));
const out = {
  model,
  baseline: { tasks: legacyTasks.length, execMin: legacy.makespan, contractMin: CONTRACT.legacy, postMin: POST, totalMin: legacy.makespan + CONTRACT.legacy + POST, criticalChain: legacyChain },
  converged: { tasks: convergedTasks.length, execMin: converged.makespan, contractMin: CONTRACT.converged, postMin: POST, totalMin: converged.makespan + CONTRACT.converged + POST, criticalChain: convergedChain },
};
out.improvement = {
  execPct: pct(out.baseline.execMin, out.converged.execMin),
  totalPct: pct(out.baseline.totalMin, out.converged.totalMin),
};
out.phases = { baseline: legacy.phases, converged: converged.phases };

if (json) console.log(JSON.stringify(out, null, 2));
else {
  const row = (label, v) => console.log(`  ${label.padEnd(16)} ${String(v).padStart(8)}`);
  console.log('Policy comparison (minutes)\n');
  row('', 'legacy  converged');
  row('tasks', `${out.baseline.tasks}       ${out.converged.tasks}`);
  row('execution', `${out.baseline.execMin}       ${out.converged.execMin}`);
  row('contract', `${out.baseline.contractMin}       ${out.converged.contractMin}`);
  row('post', `${out.baseline.postMin}       ${out.converged.postMin}`);
  row('total', `${out.baseline.totalMin}       ${out.converged.totalMin}`);
  console.log(`\nimprovement: exec ${out.improvement.execPct}%  end-to-end ${out.improvement.totalPct}%`);
  console.log(`critical chain legacy:    ${legacyChain.chain.join(' -> ')} (${legacyChain.minutes} min)`);
  console.log(`critical chain converged: ${convergedChain.chain.join(' -> ')} (${convergedChain.minutes} min)`);
}
if (assertArg) {
  const want = Number(assertArg.split('=')[1]);
  if (!(out.improvement.totalPct >= want)) {
    console.error(`[benchmark] FAIL: end-to-end improvement ${out.improvement.totalPct}% < ${want}%`);
    process.exit(1);
  }
}
