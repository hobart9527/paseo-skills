import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Structural and stop evidence stays covered by focused checks over concise stage guidance.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const brief = () => read('templates/author.md');

// The structural-check paragraph and the stop-point paragraph are different sections; scope each
// assertion to its own text so a claim cannot satisfy the wrong rule.
const structuralParagraph = () => {
  const text = brief();
  const start = text.indexOf('## Structural-check evidence');
  assert.ok(start > -1, 'structural evidence heading exists');
  return text.slice(start, text.indexOf('\n## ', start + 1));
};

test('author brief keeps structural check and evidence requirements', () => {
  const paragraph = structuralParagraph();
  for (const token of ['stdout', 'stderr', 'exit code', 'git rev-parse HEAD', 'git status --porcelain', 'blockers and advisories', 'draft', 'COMPLETE']) assert.ok(paragraph.includes(token), token);
});

test('a structural draft cannot count as COMPLETE', () => {
  const text = brief();
  assert.match(text, /draft run is evidence only about the draft, never `COMPLETE`/);
  assert.match(text, /checked SHA must match committed package/);
  assert.match(text, /`COMPLETE` requires structural success on committed content/);
});

test('time budget keeps stop bounded; minute-30 recovery belongs to the main session', () => {
  const text = brief();
  for (const token of ['minute 25', 'INCOMPLETE', 'snapshot commit']) assert.ok(text.includes(token), token);
  const skill = read('SKILL.md');
  assert.match(skill, /minute 30, reconcile Paseo status with the author branch `git log` once instead of polling/);
});

test('the brief does not claim a scheduler change or a forced termination', () => {
  const text = brief();
  // No new scheduler/terminator is promised anywhere in the brief.
  assert.doesNotMatch(text, /kill (the )?author at|hard[- ]stop|scheduler (now )?enforces/i);
  assert.doesNotMatch(text, /event delivery (is|equals) (a )?(forced|enforced) (stop|termination)/i);
});
