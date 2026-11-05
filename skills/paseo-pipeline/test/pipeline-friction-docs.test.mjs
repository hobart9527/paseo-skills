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
  assert.ok(skill.length < 20000, `SKILL.md is ${skill.length} chars`);
});
