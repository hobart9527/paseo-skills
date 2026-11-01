import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const dir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (p) => fs.readFileSync(path.join(dir, p), 'utf8');
test('skill documents converged core and hard limits', () => {
  const text = read('SKILL.md');
  for (const needle of ['Vertical slices', 'Narrow Verify', 'Frontier scheduling', 'Wave 0', 'finish notifications', 'merge-task.mjs', 'freeze-check.mjs', 'tester', 'integrated', 'CP-2']) assert.ok(text.includes(needle), needle);
  assert.ok(text.length < 12000);
});
test('no removed mechanism remains in operational docs', () => {
  const text = read('SKILL.md');
  for (const stale of ['run-state.mjs', 'reconcile.mjs', 'task-runner.mjs', 'intents', 'speculative']) assert.ok(!text.includes(stale), stale);
});

test('briefs preserve author/tester/writer/reviewer role boundaries', () => {
  for (const file of ['author.md', 'tester.md', 'writer.md', 'reviewer.md', 'lead.md']) {
    assert.ok(fs.existsSync(path.join(dir, 'templates', file)), file);
  }
  assert.match(read('templates/writer.md'), /Treat test-author commits as immutable/);
  assert.match(read('templates/tester.md'), /behavior tests only/);
  assert.match(read('templates/reviewer.md'), /reviewed SHA|reviewed_sha|tip/);
});

test('lead brief keeps required sections and templates avoid removed scripts', () => {
  const lead = read('templates/lead.md');
  for (const h of ['Startup and truth', 'Frontier dispatch', 'Notifications, audit, merge', 'Finish', 'Recovery commands']) assert.ok(lead.includes(h), h);
  for (const f of ['lead.md', 'author.md', 'tester.md', 'writer.md', 'reviewer.md', 'auditor.md']) {
    const text = read(`templates/${f}`);
    for (const stale of ['run-state.mjs', 'reconcile.mjs', 'task-runner.mjs', 'replan.mjs']) assert.ok(!text.includes(stale), `${f}: ${stale}`);
  }
  for (const mode of ['R0', 'TASK', 'FINAL', 'ARBITER']) assert.ok(read('templates/reviewer.md').includes(mode), mode);
});

test('briefs carry wait backstop, reviewer containment and impact inventory rules', () => {
  const lead = read('templates/lead.md');
  assert.match(lead, /paseo wait <agent-id> --timeout/);
  assert.match(lead, /regression|already-Done/);
  assert.match(lead, /separate workspace|own fresh workspace/);
  assert.match(read('templates/reviewer.md'), /Impact Inventory/);
  assert.match(read('templates/author.md'), /Impact Inventory/);
  assert.match(read('SKILL.md'), /paseo wait/);
  assert.match(read('openspec-schema/templates/design.md'), /Impact Inventory/);
});
