import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { rolesOf, check } from '../profiles-check.mjs';

const root = new URL('../../../', import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, root), 'utf8');
const profiles = JSON.parse(read('docs/agent-profiles.json')).daemon.agentProfiles;

test('deployment proposal preserves role IDs, chosen implementation models and honest permission notes', () => {
  const skill = read('skills/paseo-pipeline/SKILL.md');
  assert.deepEqual(check(rolesOf(skill), profiles, fileURLToPath(root)), []);
  assert.equal(new Set(profiles.map((p) => p.id)).size, profiles.length);
  const byId = (id) => profiles.find((p) => p.id === `agent_profile_${id}`);
  for (const [id, provider, model] of [
    ['gongbu', 'claude', 'flash'], ['gaogong', 'codex', 'glm'],
    ['hanlin', 'claude', 'cc'], ['ceshi', 'codex', 'codex'], ['anchasi', 'codex', 'gpt'],
  ]) {
    assert.equal(byId(id).provider, provider);
    assert.equal(byId(id).model, model);
  }
  const r0 = byId('mvvzv70y_bweu1x85oc9');
  assert.equal(r0.model, 'gemini-4-neon-high');
  assert.match(r0.notes, /diff-check/);
  assert.equal(byId('mw30xesr_dyanh9q3laq').name, '兼容入口（问题排查，非默认）');
  for (const p of profiles) {
    assert.doesNotMatch(p.notes, /纯只读权限|只读无写权限/);
    for (const key of ['family', 'harness', 'write', 'use', 'not', 'brief']) assert.match(p.notes, new RegExp(`^${key}:`, 'm'));
  }
});

test('every role token in SKILL Roles appears in docs/agent-team.md', () => {
  const team = read('docs/agent-team.md');
  for (const role of rolesOf(read('skills/paseo-pipeline/SKILL.md'))) {
    assert.match(team, new RegExp(`\\b${role}\\b`), `agent-team.md missing token ${role}`);
  }
});

test('operator documentation points to existing task briefs and discloses unapplied live configuration', () => {
  const team = read('docs/agent-team.md');
  for (const p of [
    'skills/paseo-pipeline/templates/author.md', 'skills/paseo-pipeline/templates/tester.md',
    'skills/paseo-pipeline/templates/worker.md', 'skills/paseo-pipeline/templates/reviewer.md',
    'docs/tier2-handoff-brief.md', 'docs/tier2-reviewer-brief.md', 'skills/tier2-handoff/SKILL.md',
  ]) {
    assert.ok(team.includes(p), p);
    assert.ok(fs.statSync(fileURLToPath(new URL(p, root))).isFile(), p);
  }
  assert.match(team, /未应用到 live profiles/);
  assert.match(team, /不能覆盖整个配置/);
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
