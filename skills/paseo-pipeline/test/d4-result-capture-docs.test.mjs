import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Section 4 of the D4 design: the author brief must ask for the structural check's own
// stdout/stderr/exit code and the Git state it ran against, must not let a draft run count as
// COMPLETE, and must describe the 25-minute stop event and the 30-minute reconciliation
// accurately: one scheduled stop, recovery only, no polling, notification is not completion.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const brief = () => read('templates/author.md');

// The structural-check paragraph and the stop-point paragraph are different sections; scope each
// assertion to its own text so a claim cannot satisfy the wrong rule.
const structuralParagraph = () => {
  const text = brief();
  const start = text.indexOf('Run the exact structural-check command supplied');
  assert.ok(start > -1, 'the structural-check paragraph exists');
  return text.slice(start, text.indexOf('\n- ', start + 1));
};
const stopParagraph = () => {
  const text = brief();
  const start = text.indexOf('- **At the stop point**');
  assert.ok(start > -1, 'the stop-point paragraph exists');
  return text.slice(start, text.indexOf('\n## ', start));
};
const reconciliationField = () => {
  const text = brief();
  const start = text.indexOf('- Product decisions already settled');
  assert.ok(start > -1, 'the main-session brief fields block carries the timing point');
  return text.slice(start, text.indexOf('\n\n', start));
};

test('the brief keeps the checker stdout, stderr and real exit code instead of a summary', () => {
  const paragraph = structuralParagraph();
  assert.match(paragraph, /Keep the captured stdout, the captured stderr and the real process exit code/);
  assert.match(paragraph, /Git state that was checked \(`git rev-parse HEAD` and `git status --porcelain` for the package\)/);
  // The reason it matters: a pipeline status is not the checker's status.
  assert.match(paragraph, /reports `tail`'s status, not the check's/);
  // Blockers and advisories stay separate, since only blocking rejects.
  assert.match(paragraph, /record blockers and advisories separately/);
});

test('a structural run on the uncommitted draft is reported as a draft, never COMPLETE', () => {
  const text = brief();
  assert.match(text, /A structural run against the uncommitted draft is evidence about a draft: report it as draft, not as `COMPLETE`/);
  assert.match(text, /the reported SHA must be the content that was actually checked/);
  // COMPLETE keeps its existing definition rather than gaining a weaker one.
  assert.match(text, /COMPLETE` requires structural success against the committed package content/);
  assert.match(text, /`COMPLETE` still requires the structural check to succeed on committed content/);
});

test('the stop point is one scheduled instruction, not an enforced kill', () => {
  const paragraph = stopParagraph();
  assert.match(paragraph, /one stop event at the start\+25-minute mark/);
  assert.match(paragraph, /an \*instruction\* the author is expected to honour, not an enforced kill/);
  // The 30-minute point is recovery for a missed event or notification, not a second stop.
  assert.match(paragraph, /30-minute point exists only as recovery/);
  assert.match(paragraph, /It is not polling and not a second stop/);
  // Four separately recorded timestamps.
  assert.match(paragraph, /planned deadline, stop-instruction delivery, the author's actual stop, and the snapshot commit/);
  assert.match(paragraph, /never treat a late notification as author completion/);
});

test('the 30-minute reconciliation is recovery only and reads state once', () => {
  const field = reconciliationField();
  assert.match(field, /At 30 minutes, only recover unreported state by reconciling Paseo status with `git log`/);
  assert.match(field, /do not poll, steer based on inactivity, or treat this as another stop/);
  assert.match(field, /The 30-minute recovery does not imply completion or authorization to continue/);
  assert.match(field, /Record the planned deadline, stop-event delivery/);
  // The two points are distinguished by job, so the 25-minute stop is not restated as the 30.
  assert.match(field, /At 25 minutes, stop and deliver an `INCOMPLETE` snapshot/);
  assert.match(field, /The 30-minute recovery does not imply completion or authorization to continue/);
});

test('the brief does not claim a scheduler change or a forced termination', () => {
  const text = brief();
  // No new scheduler/terminator is promised anywhere in the brief.
  assert.doesNotMatch(text, /kill (the )?author at|hard[- ]stop|scheduler (now )?enforces/i);
  assert.doesNotMatch(text, /event delivery (is|equals) (a )?(forced|enforced) (stop|termination)/i);
});
