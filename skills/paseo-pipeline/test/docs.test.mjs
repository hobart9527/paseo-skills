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
test('skill documents the real handoff sequence and profile-notes override', () => {
  const text = read('SKILL.md');
  for (const needle of ['Handoff after CP-1', 'integration/<change>', 'task/<change>/<T-id>', '确认冻结并交给 shangshu 执行', 'Profile notes describe a role', 'Bootstrap dependencies']) {
    assert.ok(text.includes(needle), needle);
  }
  // The old rule ("only Review: strict gets Red tests") would let merge-task exit 31
  // on a standard task; the SKILL must state the real condition.
  assert.match(text, /every non-mechanical task needs a Red test commit/);
});

test('docs state the worktree dependency bootstrap contract', () => {
  const skill = read('SKILL.md');
  assert.match(skill, /exit 36|36 unchecked-out dependencies/);
  assert.match(skill, /does not inherit `node_modules`/);
  // Both roles that run Verify must be told the missing-package signal is not Red.
  assert.match(read('templates/tester.md'), /not Red/);
  assert.match(read('templates/writer.md'), /environment fault, not a test result/);
  assert.match(read('templates/lead.md'), /checkout, not a clone/);
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
  // exit 31 is the most common merge failure; both authoring briefs must make the
  // writer prove the trailers survived, since a blank line after the block voids them.
  for (const file of ['writer.md', 'tester.md']) {
    assert.match(read(`templates/${file}`), /trailers:key=Pipeline-Author,valueonly/, file);
    assert.match(read(`templates/${file}`), /Co-Authored-By/, file);
  }
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
