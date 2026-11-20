import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { rolesOf } from '../profiles-check.mjs';

const root = new URL('../../../', import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, root), 'utf8');

test('SKILL Roles table names every role token with a display name and no copy of the team map remains', () => {
  const skill = read('skills/paseo-pipeline/SKILL.md');
  const roles = rolesOf(skill);
  assert.deepEqual(roles, ['chanpin', 'hanlin', 'ceshi', 'gongbu', 'gaogong', 'jiangzuo', 'anchasi', 'shangshu']);
  for (const gone of ['docs/agent-team.md', 'docs/agent-profiles.json']) {
    assert.ok(!fs.existsSync(fileURLToPath(new URL(gone, root))), `${gone} must stay deleted: live profiles are the single source`);
    assert.ok(!skill.includes(gone), `SKILL.md must not point at ${gone}`);
  }
});

test('every brief named by the SKILL and the Tier 2 wrapper exists', () => {
  const skill = read('skills/paseo-pipeline/SKILL.md');
  assert.match(skill, /templates\/\{author,tester,worker,reviewer\}\.md/);
  for (const name of ['author', 'tester', 'worker', 'reviewer']) {
    assert.ok(fs.statSync(fileURLToPath(new URL(`skills/paseo-pipeline/templates/${name}.md`, root))).isFile(), name);
  }
  for (const p of ['docs/tier2-handoff-brief.md', 'docs/tier2-reviewer-brief.md', 'skills/tier2-handoff/SKILL.md']) {
    assert.ok(fs.statSync(fileURLToPath(new URL(p, root))).isFile(), p);
  }
});

test('Tier 2 wrapper carries Delegate and Testing fields instead of editing bundled handoff', () => {
  const brief = read('docs/tier2-handoff-brief.md');
  const wrapper = read('skills/tier2-handoff/SKILL.md');
  for (const field of ['Delegate:', 'Testing:', 'Authorization:', 'Risk:', 'Contract:']) {
    assert.ok(brief.includes(field), field);
    assert.ok(wrapper.includes(field), field);
  }
  assert.match(wrapper, /synced by the app, so it is not edited/);
  assert.match(read('skills/paseo-pipeline/templates/tester.md'), /assertion failure/);
  assert.match(read('skills/paseo-pipeline/templates/worker.md'), /Red commit SHA/);
});
