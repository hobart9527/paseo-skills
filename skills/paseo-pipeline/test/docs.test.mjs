import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (p) => fs.readFileSync(path.join(dir, p), 'utf8');
const exists = (p) => assert.ok(fs.existsSync(path.join(dir, p)), p);

test('pipeline prompt files and required headings exist', () => {
  for (const p of ['SKILL.md', 'templates/author.md', 'templates/worker.md', 'templates/reviewer.md', 'templates/approvals.md', 'openspec-schema/schema.yaml']) exists(p);
  for (const [file, headings] of Object.entries({
    'SKILL.md': ['# Paseo Pipeline', '## Roles', '## Entry and CP-1', '## Start and execute after CP-1', '## FINAL and CP-2', '## Appendix'],
    'templates/author.md': ['# Change Author Brief', '## Route first', '## DAG draft and route checks', '## Return envelope'],
    'templates/worker.md': ['# Worker Brief', '## Rules', '## Return envelope'],
    'templates/reviewer.md': ['# Independent Reviewer Brief', '## Requirement conformance first', '## R0', '## FINAL'],
    'templates/approvals.md': ['# Recovery and Approval', '## FINAL after round 2', '## Destructive or production action'],
  })) for (const heading of headings) assert.ok(read(file).includes(heading), `${file}: ${heading}`);
});

test('skill preserves route, human gates and all dispatch profiles', () => {
  const skill = read('SKILL.md');
  for (const token of ['maxWidth >= 2', 'tasks >= 4', 'never split', 'freeze-check', 'handoff', 'CP-1', 'CP-2', 'merge-task.mjs', 'pipeline-run.mjs']) assert.ok(skill.includes(token), token);
  for (const role of ['chanpin', 'hanlin', 'ceshi', 'gongbu', 'gaogong', 'jiangzuo', 'anchasi', 'shangshu']) assert.ok(skill.includes(role), role);
  for (const token of ['WRITER_ROLES', 'list_profiles', 'Red tests', 'test/', 'read-only']) assert.ok(skill.includes(token), token);
  assert.ok(skill.length < 22200);
});

test('author prompt puts route DAG before full artifact requirements', () => {
  const author = read('templates/author.md');
  for (const token of ['task IDs', 'dependencies', 'maxWidth', 'one-line goal', 'freeze-check', 'handoff', 'proposal', 'SCEN-numbered', 'tasks', 'acceptance', 'review', 'design.md', 'path:line', 'COMPLETE', 'BLOCKED', 'INCOMPLETE']) assert.ok(author.includes(token), token);
  assert.ok(author.indexOf('## Route first') < author.indexOf('## DAG draft and route checks'));
  assert.ok(author.length < 9000, `author.md is ${author.length} chars`);
});

test('reviewer leads with conformance and preserves bounded advisory framing', () => {
  const reviewer = read('templates/reviewer.md');
  for (const token of ['Requirement conformance first', 'bidirectional traceability', 'shared boundaries', 'real entry', 'matrix row', 'MET | NOT_MET | UNVERIFIABLE', 'DEVIATION', 'CONTRACT_GAP', 'ENHANCEMENT', 'NOT_MET', 'UNVERIFIABLE', 'CP-2', 'templates/approvals.md']) assert.ok(reviewer.includes(token), token);
  assert.ok(reviewer.length < 7000, `reviewer.md is ${reviewer.length} chars`);
});

test('worker prompt keeps task-local scope and runtime verification', () => {
  const worker = read('templates/worker.md');
  for (const token of ['Write scope', 'frozen Verify', 'write tests and implementation', 'environment fault, not a test result', 'Cannot find package', 'Do not silently widen scope', 'Pipeline-Author', 'Co-Authored-By']) assert.ok(worker.includes(token), token);
  assert.ok(worker.length < 4500, `worker.md is ${worker.length} chars`);
});

test('recovery and destructive approval template has bounded choices and exact record format', () => {
  const approval = read('templates/approvals.md');
  for (const token of ['Accept', 'New change', 'Terminate', 'two FINAL rounds', 'NOT_MET', 'UNVERIFIABLE', 'reviewed SHA', 'CP-2', 'Object:', 'Command:', 'Executor:', 'verbatim', 'Push and history rewrite']) assert.ok(approval.includes(token), token);
  assert.ok(approval.length < 2200, `approvals.md is ${approval.length} chars`);
});

test('schema retains artifact ids, requirements and template paths', () => {
  const schema = read('openspec-schema/schema.yaml');
  const blocks = [...schema.matchAll(/^  - id: (\w+)\n([\s\S]*?)(?=^  - id: |^apply:)/gm)];
  assert.deepEqual(blocks.map((m) => m[1]), ['proposal', 'specs', 'design', 'tasks', 'acceptance', 'review']);
  for (const [, id, body] of blocks) {
    assert.match(body, /^    generates: /m, `${id}: generates`);
    assert.match(body, /^    template: /m, `${id}: template`);
    assert.match(body, /^    instruction: \|/m, `${id}: instruction`);
    assert.match(body, /^    requires:/m, `${id}: requires`);
    const template = body.match(/^    template: ([^\n]+)/m)?.[1];
    const filename = id === 'specs' ? 'spec.md' : template;
    exists(`openspec-schema/templates/${filename}`);
  }
  for (const token of ['SCEN-', '#### Scenario:', 'MODIFIED Requirements', 'Write scope', 'Verify', 'acceptance.md', 'R0: pass', 'R0: human-accept', 'validation dependency, not authorization']) assert.ok(schema.toLowerCase().includes(token.toLowerCase()), token);
  assert.ok(schema.length < 12000, `schema.yaml is ${schema.length} chars`);
});

test('history documents are relocated and active references use new paths', () => {
  for (const p of ['../../docs/history/LESSONS.md', '../../docs/history/BENCH-2026-11-03.md']) exists(p);
  assert.match(fs.readFileSync(path.join(dir, '..', '..', 'docs', 'history', 'LESSONS.md'), 'utf8'), /^# /);
});

test('no active prompt or test references deleted recovery file', () => {
  const files = ['SKILL.md', 'templates/author.md', 'templates/reviewer.md', 'templates/worker.md', 'templates/approvals.md'];
  for (const file of files) assert.doesNotMatch(read(file), /final-recovery\.md/);
  assert.doesNotMatch(read('templates/approvals.md'), /approvals\.md/);
});

test('Tier 2 handoff and review remain documented', () => {
  const handoffPath = path.join(dir, '..', '..', 'docs', 'tier2-handoff-brief.md');
  const reviewPath = path.join(dir, '..', '..', 'docs', 'tier2-reviewer-brief.md');
  exists('../../docs/tier2-handoff-brief.md'); exists('../../docs/tier2-reviewer-brief.md');
  const handoff = fs.readFileSync(handoffPath, 'utf8');
  for (const token of ['Requirement', 'Authorization', 'BLOCKED (scope expansion)', 'handoff-progress.md']) assert.ok(handoff.includes(token), token);
  assert.match(fs.readFileSync(reviewPath, 'utf8'), /Requirement matrix/);
});
