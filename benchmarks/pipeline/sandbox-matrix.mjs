// Run the ten scenario DAGs through the real pipeline scripts. Two runs share one
// fixture builder:
//
//   legacy    — the old model: every edge is Depends-on, every task reviews inline,
//               there is no skeleton/Uses/Reads/deferred.
//   converged — the same tasks and files under the converged model.
//
// The sandbox measures *orchestration* overhead only: agents are simulated with tiny
// commits, so per-task LLM minutes cannot appear here. The efficiency comparison is
// therefore the shared cost model (lib/schedule.mjs), and the sandbox's job is to
// prove the same ten DAGs complete with no blocking exit code under the real scripts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SCENARIOS, renderTasks, legacyTasks, scenarioFiles } from './scenarios.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pipeline = path.resolve(here, '../../skills/paseo-pipeline');
const bin = (name) => path.join(pipeline, name);
const libDir = path.join(pipeline, 'lib');
const { simulate, DEFAULT_MODEL } = await import(path.join(libDir, 'schedule.mjs'));
const { parseTasks } = await import(path.join(libDir, 'tasks.mjs'));

const args = process.argv.slice(2);
const json = args.includes('--json');
const assertArg = args.find((arg) => arg.startsWith('--assert='));
const only = args.filter((arg) => !arg.startsWith('--'));

const baseEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'sandbox',
  GIT_AUTHOR_EMAIL: 'sandbox@test.local',
  GIT_COMMITTER_NAME: 'sandbox',
  GIT_COMMITTER_EMAIL: 'sandbox@test.local',
};
delete baseEnv.NODE_TEST_CONTEXT;

// Distinct agent identities and models: the gate requires the test author, implementer
// and reviewer to be different agents on different models.
const AGENTS = {
  ceshi: { id: '9b2f4c10-0000-4a2b-8c3d-000000000001', provider: 'codex/gpt' },
  gongbu: { id: '9b2f4c10-0000-4a2b-8c3d-000000000002', provider: 'claude/flash' },
  anchasi: { id: '9b2f4c10-0000-4a2b-8c3d-000000000003', provider: 'claude/cc' },
  hanlin: { id: '9b2f4c10-0000-4a2b-8c3d-000000000004', provider: 'claude/review' },
};

function fakePaseo(cwd) {
  const dir = path.join(cwd, '.fake-bin');
  fs.mkdirSync(dir, { recursive: true });
  const listing = Object.entries(AGENTS).map(([role, agent]) => ({
    id: agent.id, shortId: agent.id.slice(0, 7), name: `[Pipeline] ${role}`, provider: agent.provider, status: 'closed',
  }));
  fs.writeFileSync(path.join(cwd, '.agents.json'), JSON.stringify(listing));
  const exe = path.join(dir, 'paseo');
  const inspectCases = Object.values(AGENTS).map((agent) => {
    const [provider, model] = agent.provider.split('/');
    return `${agent.id}*) printf '{"Id":"%s","Provider":"${provider}","Model":"${model}"}' "$2";;`;
  }).join(' ');
  fs.writeFileSync(exe, [
    '#!/bin/sh',
    'if [ "$1" = "inspect" ]; then',
    `  case "$2" in ${inspectCases} *) printf '{"Id":"%s"}' "$2";; esac;`,
    'else',
    '  cat "$(dirname "$0")/../.agents.json"',
    'fi',
    "printf '\\n'",
  ].join('\n'));
  fs.chmodSync(exe, 0o755);
  return { ...baseEnv, PATH: `${dir}:${process.env.PATH}` };
}

function timed(command, argv, cwd, env, timeout = 300_000) {
  const started = process.hrtime.bigint();
  const result = spawnSync(command, argv, { cwd, env, encoding: 'utf8', timeout });
  const ms = Number((process.hrtime.bigint() - started) / 1n) / 1e6;
  return { status: result.status, out: `${result.stdout || ''}${result.stderr || ''}`, ms };
}

function fixture(scenario, policy) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `sandbox-${scenario.id}-${policy}-`));
  const env = fakePaseo(cwd);
  const change = scenario.id;
  const changeDir = path.join(cwd, 'openspec', 'changes', change);
  const git = (...argv) => {
    const result = spawnSync('git', argv, { cwd, env, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${argv.join(' ')} failed: ${result.stderr}`);
    return result.stdout.trim();
  };
  const write = (file, text) => {
    const full = path.join(cwd, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  };
  write(`openspec/changes/${change}/tasks.md`, renderTasks(scenario, policy));
  for (const [file, text] of Object.entries(scenarioFiles(scenario))) {
    write(`openspec/changes/${change}/${file}`, text);
  }
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-qm', 'contract');
  const contractSha = git('rev-parse', 'HEAD');
  write(`openspec/changes/${change}/review.md`, `R0: pass(${AGENTS.hanlin.id}@${contractSha})\n`);
  git('add', `openspec/changes/${change}/review.md`);
  git('commit', '-qm', 'R0 sign-off');
  return { cwd, env, git, write, change, changeDir };
}

async function runScenario(scenario, policy) {
  const s = fixture(scenario, policy);
  const phases = { freezeMs: 0, frontierMs: 0, workMs: 0, queueMs: 0, mergeMs: 0, syncMs: 0, acceptMs: 0, briefMs: 0 };
  const notes = [];
  const taskList = parseTasks(fs.readFileSync(path.join(s.changeDir, 'tasks.md'), 'utf8')).tasks;
  const byId = new Map(taskList.map((task) => [task.id, task]));
  const bases = new Map();
  const branchOf = new Map();
  let syncChecked = 0;

  const structural = timed('node', [bin('freeze-check.mjs'), `openspec/changes/${s.change}`, '--structural'], s.cwd, s.env);
  if (structural.status !== 0) throw new Error(`freeze-check --structural failed: ${structural.out}`);
  const frozen = timed('node', [bin('freeze-check.mjs'), `openspec/changes/${s.change}`], s.cwd, s.env);
  if (frozen.status !== 0) throw new Error(`freeze-check failed: ${frozen.out}`);
  phases.freezeMs += structural.ms + frozen.ms;

  s.git('switch', '-qc', `integration/${s.change}`);
  const lead = timed('node', [bin('brief.mjs'), 'lead', '--change', s.change, '--repo', s.cwd, '--json'], s.cwd, s.env);
  if (lead.status !== 0) throw new Error(`lead brief failed: ${lead.out}`);
  phases.briefMs += lead.ms;

  const done = new Set();
  let round = 0;
  const maxRounds = taskList.length * 8 + 20;
  while (done.size < taskList.length) {
    round += 1;
    if (round > maxRounds) throw new Error('frontier loop did not converge');
    const listed = timed('node', [bin('next-actions.mjs'), `openspec/changes/${s.change}`, '--json'], s.cwd, s.env);
    if (listed.status !== 0) throw new Error(`next-actions failed: ${listed.out}`);
    phases.frontierMs += listed.ms;
    const report = JSON.parse(listed.out.slice(listed.out.indexOf('{')));
    if (process.env.SANDBOX_TRACE) process.stderr.write(`round ${round}: ${report.dispatch.map((item) => `${item.task}:${item.action}`).join(' ')}\n`);
    if (!report.dispatch.length) {
      throw new Error(`frontier stalled after ${round} rounds: ${JSON.stringify({ waiting: report.waiting, blocked: report.blocked, attention: report.attention }).slice(0, 400)}`);
    }

    for (const item of report.dispatch) {
      const task = byId.get(item.task);
      const branch = `task/${s.change}/${task.id}`;
      const testFile = task.scope.find((file) => /(\.|_)(test|spec)\./.test(file));
      const implFiles = task.scope.filter((file) => file !== testFile);

      if (item.action === 'merge' || item.action === 'dispatch-reviewer') {
        // A fresh branch name per attempt: an integration branch already named
        // `task/<change>/<T>` would otherwise carry commits from an earlier task.
        const branch = branchOf.get(task.id);
        const tag = item.action === 'dispatch-reviewer'
          ? AGENTS.anchasi.id
          : task.review === 'mechanical' ? 'mechanical' : 'deferred';
        if (task.uses.length) {
          // Rehearse the consumer against the integration tip before queueing the merge.
          s.git('switch', '-q', branch);
          const synced = timed('node', [bin('sync-check.mjs'), s.cwd, `integration/${s.change}`, '--verify', task.verify], s.cwd, s.env);
          phases.syncMs += synced.ms;
          if (synced.status !== 0) notes.push(`${task.id}: sync-check exit ${synced.status}`);
          syncChecked += 1;
          s.git('switch', '-q', `integration/${s.change}`);
        }
        const queued = timed('node', [bin('merge-queue.mjs'), `openspec/changes/${s.change}`, task.id, '--json'], s.cwd, s.env);
        phases.queueMs += queued.ms;
        const merged = timed('node', [bin('merge-task.mjs'), branch, task.id, `pass(${tag}@${s.git('rev-parse', branch).slice(0, 7)}/${bases.get(task.id).slice(0, 7)})`], s.cwd, s.env);
        phases.mergeMs += merged.ms;
        if (merged.status !== 0) throw new Error(`merge ${task.id} (${tag}) failed exit ${merged.status}: ${merged.out}`);
        done.add(task.id);
        continue;
      }

      const started = process.hrtime.bigint();
      if (item.action === 'create-branch+dispatch-ceshi') {
        const base = s.git('rev-parse', 'HEAD');
        bases.set(task.id, base);
        const name = `task/${s.change}/${task.id}`;
        branchOf.set(task.id, name);
        s.git('switch', '-q', '-c', name, base);
        s.write(testFile, `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport fs from 'node:fs';\ntest('red', () => { assert.equal(fs.existsSync('${implFiles[0]}'), true); });\n`);
        s.git('add', testFile);
        s.git('commit', '-qm', `test(${task.id}): red\n\nPipeline-Role: ceshi\nPipeline-Author: ${AGENTS.ceshi.id}`);
      } else if (item.action === 'create-branch+dispatch-implementer') {
        // Mechanical: one commit, no Red (freeze-check forces Review: mechanical on skeletons).
        const base = s.git('rev-parse', 'HEAD');
        bases.set(task.id, base);
        const name = `task/${s.change}/${task.id}`;
        branchOf.set(task.id, name);
        s.git('switch', '-q', '-c', name, base);
        s.write(testFile, `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport fs from 'node:fs';\ntest('mechanical', () => { for (const file of ${JSON.stringify(implFiles)}) assert.equal(fs.existsSync(file), true); });\n`);
        for (const file of implFiles) s.write(file, `export const value = '${task.id}';\n`);
        s.git('add', '-A');
        s.git('commit', '-qm', `work(${task.id})\n\nPipeline-Role: gongbu\nPipeline-Author: ${AGENTS.gongbu.id}`);
      } else if (item.action === 'dispatch-implementer') {
        s.git('switch', '-q', branchOf.get(task.id));
        for (const file of implFiles) s.write(file, `export const value = '${task.id}';\n`);
        s.git('add', '-A');
        s.git('commit', '-qm', `work(${task.id})\n\nPipeline-Role: gongbu\nPipeline-Author: ${AGENTS.gongbu.id}`);
      } else {
        notes.push(`${task.id}: unexpected action ${item.action}`);
      }
      s.git('switch', '-q', `integration/${s.change}`);
      phases.workMs += Number((process.hrtime.bigint() - started) / 1n) / 1e6;
    }
  }

  const sink = taskList.at(-1);
  const acceptance = timed('sh', ['-c', sink.verify], s.cwd, s.env);
  phases.acceptMs += acceptance.ms;
  if (acceptance.status !== 0) throw new Error(`sink Verify failed: ${acceptance.out}`);

  const finalBrief = timed('node', [bin('brief.mjs'), 'reviewer', '--change', s.change, '--repo', s.cwd, '--json'], s.cwd, s.env);
  if (finalBrief.status !== 0) throw new Error(`final brief failed: ${finalBrief.out}`);
  phases.briefMs += finalBrief.ms;
  if (policy === 'converged' && scenario.tasks.some((task) => task.review === 'deferred')) {
    const prompt = JSON.parse(finalBrief.out).prompt;
    if (!/## Deferred tasks/.test(prompt)) notes.push('FINAL brief lacks the deferred section');
  }

  const marked = parseTasks(fs.readFileSync(path.join(s.changeDir, 'tasks.md'), 'utf8')).tasks.filter((task) => task.checked);
  if (marked.length !== taskList.length) throw new Error(`${marked.length}/${taskList.length} tasks Done`);

  return {
    scenario: scenario.id,
    policy,
    tasks: taskList.length,
    rounds: round,
    syncChecked,
    phases,
    wallMs: Object.values(phases).reduce((sum, value) => sum + value, 0),
    notes,
  };
}

const selected = only.length ? SCENARIOS.filter((scenario) => only.includes(scenario.id)) : SCENARIOS;
const results = [];
for (const scenario of selected) {
  for (const policy of ['legacy', 'converged']) {
    results.push(await runScenario(scenario, policy));
  }
}

const modeled = selected.map((scenario) => {
  const legacy = simulate(legacyTasks(scenario), { policy: 'legacy', model: DEFAULT_MODEL });
  const converged = simulate(parseTasks(renderTasks(scenario, 'converged')).tasks, { policy: 'converged', model: DEFAULT_MODEL });
  return { scenario: scenario.id, legacy: legacy.makespan, converged: converged.makespan };
});
// The contract phase is the one measured number here, and it is measured on the real
// submit-hub change (263 min first spec commit -> R0 pass, vs the converged 45 min).
// It is not re-derived per synthetic scenario; both numbers come from baseline-metrics
// and are applied unchanged, exactly as benchmark.mjs does. POST (sink suite + FINAL
// review) is identical under both policies and cancels out of the delta.
const CONTRACT = { legacy: 263, converged: 45 };
const POST = 100;
const pct = (from, to) => Number((((from - to) / from) * 100).toFixed(1));

const legacyRows = results.filter((row) => row.policy === 'legacy');
const convergedRows = results.filter((row) => row.policy === 'converged');
const endToEnd = selected.map((scenario, index) => {
  const row = modeled[index];
  const legacyTotal = row.legacy + CONTRACT.legacy + POST;
  const convergedTotal = row.converged + CONTRACT.converged + POST;
  return { scenario: scenario.id, legacyTotal, convergedTotal };
});
const report = {
  results,
  modeled,
  endToEnd,
  summary: {
    scenarios: selected.length,
    tasksTotal: selected.reduce((sum, scenario) => sum + scenario.tasks.length, 0),
    wallMs: {
      legacy: legacyRows.reduce((sum, row) => sum + row.wallMs, 0),
      converged: convergedRows.reduce((sum, row) => sum + row.wallMs, 0),
    },
    modelMinutes: {
      legacy: modeled.reduce((sum, row) => sum + row.legacy, 0),
      converged: modeled.reduce((sum, row) => sum + row.converged, 0),
    },
    endToEndMinutes: {
      legacy: endToEnd.reduce((sum, row) => sum + row.legacyTotal, 0),
      converged: endToEnd.reduce((sum, row) => sum + row.convergedTotal, 0),
    },
    exitWithBlocking: results.filter((row) => row.notes.some((note) => /exit [1-9]/.test(note))).map((row) => row.scenario),
  },
};
report.summary.wallPct = pct(report.summary.wallMs.legacy, report.summary.wallMs.converged);
report.summary.modelPct = pct(report.summary.modelMinutes.legacy, report.summary.modelMinutes.converged);
report.summary.endToEndPct = pct(report.summary.endToEndMinutes.legacy, report.summary.endToEndMinutes.converged);

if (json) console.log(JSON.stringify(report, null, 2));
else {
  for (const row of results) {
    const phases = Object.entries(row.phases).filter(([, ms]) => ms > 0.5).map(([name, ms]) => `${name}=${Math.round(ms)}ms`).join(' ');
    console.log(`${row.scenario.padEnd(20)} ${row.policy.padEnd(10)} tasks=${row.tasks} rounds=${row.rounds} ${phases}`);
    for (const note of row.notes) console.log(`  NOTE ${note}`);
  }
  console.log('');
  for (const row of modeled) {
    console.log(`${row.scenario.padEnd(20)} model legacy=${row.legacy} min converged=${row.converged} min (${pct(row.legacy, row.converged)}% faster)`);
  }
  console.log('');
  for (const row of endToEnd) {
    console.log(`${row.scenario.padEnd(20)} e2e   legacy=${row.legacyTotal} min converged=${row.convergedTotal} min (${pct(row.legacyTotal, row.convergedTotal)}% faster)`);
  }
  console.log('');
  console.log(`orchestration wall: legacy ${Math.round(report.summary.wallMs.legacy)}ms -> converged ${Math.round(report.summary.wallMs.converged)}ms (${report.summary.wallPct}%)`);
  console.log(`model makespan:     legacy ${report.summary.modelMinutes.legacy} min -> converged ${report.summary.modelMinutes.converged} min (${report.summary.modelPct}%)`);
  console.log(`end-to-end total:   legacy ${report.summary.endToEndMinutes.legacy} min -> converged ${report.summary.endToEndMinutes.converged} min (${report.summary.endToEndPct}%)`);
  console.log(`  (end-to-end adds the measured contract phase ${CONTRACT.legacy}/${CONTRACT.converged} min and a shared ${POST} min post phase)`);
}
if (assertArg) {
  const want = Number(assertArg.split('=')[1]);
  if (!(report.summary.endToEndPct >= want)) {
    console.error(`[sandbox-matrix] FAIL: end-to-end improvement ${report.summary.endToEndPct}% < ${want}%`);
    process.exit(1);
  }
}
