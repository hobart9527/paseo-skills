// Validate a benchmark contract with the pipeline's own freeze gate.
//
// The benchmark files are tasks.md fragments; freeze-check needs a complete change
// package. Materialise the minimum one in a throwaway repository (specs, design Impact
// Inventory, one Required acceptance row, plus stub files for every `Reads` anchor) and
// run the real `freeze-check --structural`. A fixture the pipeline would refuse to freeze
// must never produce a benchmark number.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pipeline = path.resolve(here, '../../skills/paseo-pipeline');
const libDir = path.join(pipeline, 'lib');
const { parseTasks } = await import(path.join(libDir, 'tasks.mjs'));

/** Run freeze-check --structural over a tasks.md. Returns { ok, output, dir }. */
export function checkContract(tasksMarkdown, changeName = 'benchmark') {
  const parsed = parseTasks(tasksMarkdown);
  if (parsed.errors.length) {
    return { ok: false, output: parsed.errors.map((error) => `${error.code} ${error.message}`).join('\n') };
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-check-'));
  const changeDir = path.join(root, 'openspec', 'changes', changeName);
  const write = (file, text) => {
    const full = path.join(root, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  };
  write(`openspec/changes/${changeName}/tasks.md`, tasksMarkdown);
  write(`openspec/changes/${changeName}/proposal.md`, '# Proposal\n');
  write(`openspec/changes/${changeName}/design.md`,
    `# Design\n\n## Impact Inventory\n${parsed.tasks.map((task) => `- ${task.id}: ${task.scope.join(', ')}`).join('\n')}\n`);

  const scenarios = [...new Set(parsed.tasks.flatMap((task) => task.scenarios))];
  write(`openspec/changes/${changeName}/specs/spec.md`,
    scenarios.map((scenario) => `#### Scenario: ${scenario} behaviour\n`).join(''));

  const row = parsed.tasks.find((task) => task.scenarios.length) ?? parsed.tasks[0];
  write(`openspec/changes/${changeName}/acceptance.md`, [
    '| Scenario | Entry | Tasks | Verify | Required | Result | Evidence |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    `| ${row.scenarios[0] ?? 'SCEN-BENCH-01'} | CLI | ${row.id} | ${row.verify} | yes | PENDING | pending |`,
    '',
  ].join('\n'));

  // Reads is a read-only anchor: the path must exist in the repository.
  for (const task of parsed.tasks) {
    for (const read of task.reads) write(read, '');
  }

  const git = (...argv) => spawnSync('git', argv, { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  git('add', '.');
  git('-c', 'user.email=bench@test.local', '-c', 'user.name=bench', 'commit', '-qm', 'contract');

  const result = spawnSync('node', [path.join(pipeline, 'freeze-check.mjs'), `openspec/changes/${changeName}`, '--structural'], {
    cwd: root,
    encoding: 'utf8',
  });
  return { ok: result.status === 0, output: `${result.stdout || ''}${result.stderr || ''}`, dir: root };
}

/** Blocking lines only, so a caller can report the rule that rejected the contract. */
export function blockingLines(output) {
  return output.split(/\r?\n/).filter((line) => /^\s*(?:BLOCK|\[BLOCK\])/.test(line) || /^[A-Z_]+ (?:\S+:)?/.test(line) && line.includes(':'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: contract-check.mjs <tasks.md>');
    process.exit(2);
  }
  const result = checkContract(fs.readFileSync(file, 'utf8'));
  process.stdout.write(result.output);
  process.exit(result.ok ? 0 : 1);
}
