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
  for (const step of ['deploy', 'archive_workspace', 'delet', '/tmp', 'production']) {
    assert.ok(new RegExp(step, 'i').test(skill), step);
  }
  // The object list is concrete: ids, branches, host paths — not a summary sentence.
  assert.match(skill, /workspace IDs/i);
  assert.match(skill, /branch names/i);
  assert.match(skill, /host paths/i);
  // The approval is written verbatim to the run log; the file, not memory, survives compaction.
  assert.match(skill, /run-log\.md/);
  assert.match(skill, /verbatim/i);
  assert.match(skill, /compaction/i);
});

test('a FINAL failure compares the integration base with main before it is called a regression', () => {
  assert.match(skill, /merge-base/);
  assert.match(skill, /rev-list --count/);
  assert.match(skill, /rebase/i);
  assert.match(skill, /regression/i);
});

test('every dispatch registers a reconciliation point and never duplicates the dispatch', () => {
  assert.match(skill, /reconciliation point/i);
  assert.match(skill, /duplicate dispatch/i);
});

test('the enlarged skill stays under the hard size cap', () => {
  assert.ok(skill.length < 22000, `SKILL.md is ${skill.length} chars`);
});

test('material human choices precede R0 without replacing CP-1', () => {
  const entry = skill.slice(skill.indexOf('## Entry and CP-1'), skill.indexOf('## Start after CP-1'));
  const questions = entry.indexOf('open questions that require human choice');
  const dispatch = entry.indexOf('**Dispatch `hanlin`**');
  assert.ok(questions >= 0, 'human choice guidance missing');
  assert.ok(dispatch >= 0, 'R0 dispatch guidance missing');
  assert.ok(questions < dispatch);
  assert.match(entry, /commit the corrections with authorization and review the new SHA/);
  assert.match(entry, /materially change the contract/);
  assert.match(entry, /Ordinary assumptions need not block/);
  assert.match(entry, /does not replace CP-1/);
  assert.match(entry, /max two rounds/);
});

test('R0 declares commit and external input baseline without overstating enforcement', () => {
  const reviewer = fs.readFileSync(path.join(dir, 'templates/reviewer.md'), 'utf8');
  const author = fs.readFileSync(path.join(dir, 'templates/author.md'), 'utf8');
  assert.match(skill, /full reviewed commit SHA for both contract and code/);
  assert.match(skill, /fixed snapshot.*content hash/);
  assert.match(skill, /verify the hash before and after review/);
  assert.match(skill, /stop and escalate rather than use a dirty or untracked copy silently/);
  assert.match(skill, /reviewer protocol unless OS permissions enforce it/);
  assert.match(skill, /`freeze-check` do not bind or check external snapshots/);
  assert.match(reviewer, /unlisted worktree content/);
  assert.match(reviewer, /task-specific risks and cross-change compatibility/);
  assert.match(author, /material contract choices needing human decision/);
});

test('briefs carry verified decision context and handle checker friction without scope fabrication', () => {
  const skill = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
  const author = fs.readFileSync(path.join(dir, 'templates/author.md'), 'utf8');
  const reviewer = fs.readFileSync(path.join(dir, 'templates/reviewer.md'), 'utf8');
  assert.match(skill, /confirmed decisions.*references/i);
  assert.match(skill, /never invent ownership or dependencies/i);
  assert.match(author, /decision coverage and unresolved conflicts/i);
  // Minimal contract: the author records the real baseline SHA and reads only what its
  // rules collide with — no digest artifact exists to hold survey output.
  assert.match(author, /Preserve the actual baseline SHA/i);
  assert.match(author, /Read what your rules collide with, not the repository/i);
  assert.match(reviewer, /same confirmed decisions/i);
});
