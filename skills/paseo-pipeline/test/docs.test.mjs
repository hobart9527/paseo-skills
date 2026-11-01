import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const dir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (p) => fs.readFileSync(path.join(dir, p), 'utf8');
test('skill documents converged core and hard limits', () => {
  const text = read('SKILL.md');
  for (const needle of ['Vertical slices', 'Narrow Verify', 'Frontier scheduling', 'Wave 0', 'notifyOnFinish', 'merge-task.mjs', 'freeze-check.mjs']) assert.ok(text.includes(needle), needle);
  assert.ok(text.length < 12000);
});
test('no removed mechanism remains in operational docs', () => {
  const text = read('SKILL.md');
  for (const stale of ['run-state.mjs', 'reconcile.mjs', 'task-runner.mjs', 'intents', 'speculative']) assert.ok(!text.includes(stale), stale);
});
