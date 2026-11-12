import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const skill = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');

test('destructive and production steps need an object list and a recorded approval', () => {
  // Every destructive/production step class the operator can hit must be named, so the
  // rule is not silently read as "only applies to deploys".
  for (const step of ['archive', 'cleanup', 'branch', 'worktree', 'push']) {
    assert.ok(new RegExp(step, 'i').test(skill), step);
  }
  // Detailed object-list, verbatim-approval format lives in shared template.
  const approval = fs.readFileSync(path.join(dir, 'templates/approvals.md'), 'utf8');
  for (const token of ['workspace', 'branch', 'path', 'run-log', 'verbatim']) assert.ok(approval.includes(token), token);
});

test('a FINAL failure compares the integration base with main before it is called a regression', () => {
  assert.match(skill, /regression/i);
  assert.match(skill, /main\.\.\.<full-SHA>/);
});

test('every dispatch registers a reconciliation point and never duplicates the dispatch', () => {
  assert.match(skill, /reconcile Paseo state, Git tip and Done lines/);
  assert.match(skill, /never duplicate dispatch/);
});

test('skill retains routing and human gate landmarks', () => {
  for (const token of ['maxWidth', 'freeze-check', 'CP-1', 'CP-2', 'run-log.md', 'FINAL']) assert.ok(skill.includes(token), token);
});

test('CP-1 remains after R0 and human choices', () => {
  const entry = skill.slice(skill.indexOf('## Entry and CP-1'), skill.indexOf('## Start and execute after CP-1'));
  for (const token of ['Resolve material human choices', 'dispatch `hanlin`', 'Human confirms CP-1', 'Maximum two package rounds']) assert.ok(entry.includes(token), token);
  assert.ok(entry.indexOf('Resolve material human choices') < entry.indexOf('dispatch `hanlin`'));
  assert.ok(entry.indexOf('Human confirms CP-1') > entry.indexOf('dispatch `hanlin`'));
});

test('R0 declares commit and external input baseline without overstating enforcement', () => {
  const reviewer = fs.readFileSync(path.join(dir, 'templates/reviewer.md'), 'utf8');
  const author = fs.readFileSync(path.join(dir, 'templates/author.md'), 'utf8');
  assert.match(skill, /exact contract commit/);
  assert.match(reviewer, /pinned commit and approved external snapshots/);
  assert.match(author, /material product choices requiring human decision/);
});

test('briefs carry verified decision context and handle checker friction without scope fabrication', () => {
  const skill = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
  const author = fs.readFileSync(path.join(dir, 'templates/author.md'), 'utf8');
  const reviewer = fs.readFileSync(path.join(dir, 'templates/reviewer.md'), 'utf8');
  assert.match(skill, /confirmed decisions/);
  assert.match(skill, /Reproduce suspected bugs; never invent ownership or dependencies/);
  assert.match(author, /unresolved conflicts/);
  assert.match(author, /baseline SHA/);
  assert.match(author, /Read baseline only to resolve a rule/);
  assert.match(reviewer, /confirmed decisions supplied to the author/);
});
