import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Guards for prompt rules that real runs needed. Each checks a short landmark token or an
// ordering, not a sentence, so prompts can be reworded and deduplicated without breaking it.
const dir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (file) => fs.readFileSync(path.join(dir, file), 'utf8');
const skill = read('SKILL.md');
const author = read('templates/author.md');
const reviewer = read('templates/reviewer.md');
const approval = read('templates/approvals.md');
const has = (text, tokens, name) => { for (const token of tokens) assert.ok(text.includes(token), `${name}: ${token}`); };

test('destructive and production steps need an object list and a recorded approval', () => {
  for (const step of ['archive', 'cleanup', 'branch', 'worktree', 'push']) assert.ok(new RegExp(step, 'i').test(skill), step);
  has(approval, ['workspace', 'branch', 'path', 'run-log', 'verbatim'], 'approvals.md');
});

test('a FINAL failure compares the integration base with main before it is called a regression', () => {
  has(skill, ['regression', 'main...<full-SHA>', 'git merge-base integration/<change> main'], 'SKILL.md');
});

test('every dispatch registers a reconciliation point and never duplicates the dispatch', () => {
  has(skill, ['reconciliation point', 'never duplicate dispatch'], 'SKILL.md');
});

test('CP-1 follows R0, which follows the human choices', () => {
  const entry = skill.slice(skill.indexOf('## Entry and CP-1'), skill.indexOf('## Start and execute after CP-1'));
  const at = (token) => { const index = entry.indexOf(token); assert.ok(index > -1, token); return index; };
  assert.ok(at('material human choices') < at('read-only R0'));
  assert.ok(at('read-only R0') < at('confirms CP-1'));
  has(entry, ['exact contract commit', 'two package rounds'], 'Entry');
});

test('briefs carry pinned evidence, decision context and no fabricated scope', () => {
  has(skill, ['pinned', 'confirmed decisions'], 'SKILL.md');
  has(author, ['material product choices', 'OPEN-DECISION', 'invented behavior, ownership or dependencies', 'unresolved conflicts', 'baseline SHA', 'Read baseline only'], 'author.md');
  has(reviewer, ['pinned commit and approved external snapshots', 'confirmed decisions supplied to the author'], 'reviewer.md');
});

// D8: the author researched for 11 minutes before the first file and the R0 reviewer ran 34
// minutes without a verdict. The rule list comes first, the three risk checks are named, and
// the reviewer stops on a clock.
test('the author writes the rule list before the baseline research, and the reviewer stops on a clock', () => {
  has(author, ['within 2 minutes', '**Reach**', '**Shape**', '**Removal**', 'exit code', '$PASEO_AGENT_ID'], 'author.md');
  const at = (token) => { const index = author.indexOf(token); assert.ok(index > -1, token); return index; };
  assert.ok(at('Write the rule list now') < at('the baseline is fair game'));
  has(reviewer, ['minute 20', 'minute 25', 'baseline pass'], 'reviewer.md');
});

// D9: R0 found a live 越权 read path (F7) that design.md D-03 had already named as affected, with
// no task owning the route. The design template promises freeze-check cross-checks decisions both
// ways; only the tasks->design direction existed, so the promise now has a checker behind it.
test('design.md declares affected modules and freeze-check holds a writer for each', () => {
  const schema = read('openspec-schema/templates/design.md');
  has(schema, ['影响模块/路径'], 'design template');
  has(read('freeze-check.mjs'), ['影响模块/路径', 'ADVISORY_DECISION_UNOWNED'], 'freeze-check.mjs');
});
