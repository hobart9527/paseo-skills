import test from 'node:test';
import assert from 'node:assert/strict';
import { checklistForSurfaces } from '../lib/adversarial.mjs';

// One call per case: every risk surface, an unknown surface, explicit `none`,
// and a task with no Risk-surface field at all.
test('each risk surface maps to its concrete checklist', () => {
  const merged = checklistForSurfaces('[persistence, public-api]');
  // Merged surfaces keep a stable order and duplicate nothing.
  assert.equal(merged.length, 8);
  assert.ok(merged.includes('state survives reload / process restart'));
  assert.ok(merged.includes('unknown endpoint/method returns the documented status code'));
  assert.equal(new Set(merged).size, merged.length);

  const concurrency = checklistForSurfaces('concurrency');
  assert.ok(concurrency.includes('two in-flight requests: the documented policy (last-write-wins vs conflict) holds'));
  assert.ok(concurrency.includes('duplicate/retried request does not apply the effect twice'));
});

test('none and a missing Risk-surface produce an empty checklist', () => {
  assert.deepEqual(checklistForSurfaces('[none]'), []);
  assert.deepEqual(checklistForSurfaces(''), []);
  assert.deepEqual(checklistForSurfaces(undefined), []);
});

test('an unknown surface asks for a scenario-derived case instead of guessing', () => {
  const checklist = checklistForSurfaces('[telepathy]');
  assert.equal(checklist.length, 1);
  assert.match(checklist[0], /unmapped risk surface "telepathy"/);
  assert.match(checklist[0], /Scenarios/);
});

test('the mapping is deterministic and accepts the aliases used by older contracts', () => {
  assert.deepEqual(checklistForSurfaces('[data-integrity, public api]'), checklistForSurfaces('[persistence, public-api]'));
  assert.deepEqual(checklistForSurfaces('none, security'), checklistForSurfaces('security'));
});
