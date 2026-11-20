import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../profiles-check.mjs', import.meta.url));
const ROLES = ['chanpin', 'hanlin', 'ceshi', 'gongbu', 'gaogong', 'jiangzuo', 'anchasi', 'shangshu'];

const skillText = `## Roles\n\n| Profile | Scope |\n|---|---|\n${ROLES.map((r) => `| 角色 \`${r}\` | x |`).join('\n')}\n\n## Tools\n`;
const FAMILY = { chanpin: 'gemini', hanlin: 'claude', ceshi: 'gemini', gongbu: 'glm', gaogong: 'kimi', jiangzuo: 'qwen', anchasi: 'gpt', shangshu: 'claude' };

function profile(role, over = {}) {
  const family = over.family ?? FAMILY[role];
  const write = over.write ?? 'read-only';
  const lines = [`family: ${family}`, `harness: claude`, `write: ${write}`, 'use: u', 'not: n', 'brief: none'];
  return {
    id: `agent_profile_${role}`, name: role, provider: over.provider ?? 'claude', model: 'm',
    notes: (over.notes ?? lines.join('\n')),
  };
}

function run(profiles, { skill = skillText } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profiles-check-'));
  const skillFile = path.join(dir, 'SKILL.md');
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(skillFile, skill);
  fs.writeFileSync(configFile, JSON.stringify({ daemon: { agentProfiles: profiles } }));
  const r = spawnSync('node', [script, '--skill', skillFile, '--config', configFile], { encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}
const all = (over = {}) => ROLES.map((r) => profile(r, over[r] ?? {}));

test('complete heterogeneous profiles exit 0', () => {
  const r = run(all());
  assert.equal(r.status, 0, r.out);
});

test('role without a profile is MISSING_PROFILE', () => {
  const r = run(all().filter((p) => p.id !== 'agent_profile_gongbu'));
  assert.equal(r.status, 1);
  assert.match(r.out, /MISSING_PROFILE gongbu/);
});

test('notes without family/harness/write are MISSING_FIELD', () => {
  const r = run(all({ gongbu: { notes: '只写职责' } }));
  assert.equal(r.status, 1);
  for (const f of ['family', 'harness', 'write', 'use', 'not', 'brief']) assert.match(r.out, new RegExp(`MISSING_FIELD gongbu ${f}`));
});

test('auditor sharing a family with a writer is FAMILY_CLASH', () => {
  const r = run(all({ gongbu: { family: 'gpt' } }));
  assert.equal(r.status, 1);
  assert.match(r.out, /FAMILY_CLASH anchasi gongbu/);
});

test('tester sharing a family with the implementer is FAMILY_CLASH', () => {
  const r = run(all({ ceshi: { family: 'glm' } }));
  assert.equal(r.status, 1);
  assert.match(r.out, /FAMILY_CLASH ceshi gongbu/);
});

test('tester and auditor may share OpenAI family; lint does not prove target independence', () => {
  const r = run(all({ ceshi: { family: 'openai' }, anchasi: { family: 'openai' } }));
  assert.equal(r.status, 0, r.out);
});

test('bad or incomplete arguments exit 2', () => {
  for (const args of [['--config'], ['--unknown', 'x'], ['--skill', '--config'], ['--config', 'x', '--config', 'y']]) {
    const r = spawnSync('node', [script, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 2, `${args}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /Usage:/);
  }
});

test('antigravity profile without diff-check is UNENFORCED_WRITE', () => {
  const r = run(all({ chanpin: { provider: 'antigravity', write: 'read-only' } }));
  assert.equal(r.status, 1);
  assert.match(r.out, /UNENFORCED_WRITE chanpin/);
});

test('antigravity profile declaring diff-check passes', () => {
  const r = run(all({ chanpin: { provider: 'antigravity', write: 'read-only; diff-check' } }));
  assert.equal(r.status, 0, r.out);
});

test('unreadable config exits 2', () => {
  const r = spawnSync('node', [script, '--skill', '/nonexistent', '--config', '/nonexistent'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
});

test('brief path must exist under --root and notes must not claim read-only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profiles-root-'));
  const skillFile = path.join(dir, 'SKILL.md');
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(skillFile, skillText);
  const ps = all({ gongbu: { notes: 'family: glm\nharness: claude\nwrite: w\nuse: u\nnot: n\nbrief: nope/missing.md' }, anchasi: { notes: 'family: gpt\nharness: claude\nwrite: 只读无写权限\nuse: u\nnot: n\nbrief: none' } });
  fs.writeFileSync(configFile, JSON.stringify({ daemon: { agentProfiles: ps } }));
  const r = spawnSync('node', [script, '--skill', skillFile, '--config', configFile, '--root', dir], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /MISSING_BRIEF gongbu nope\/missing.md/);
  assert.match(r.stdout, /FALSE_READONLY anchasi/);
});

test('brief accepts several ;-separated paths with a Tier label and checks each', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profiles-multi-'));
  fs.writeFileSync(path.join(dir, 'a.md'), 'x');
  const skillFile = path.join(dir, 'SKILL.md');
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(skillFile, skillText);
  const mk = (brief) => ({ gongbu: { notes: `family: glm\nharness: claude\nwrite: w\nuse: u\nnot: n\nbrief: ${brief}` } });
  const runWith = (brief) => {
    fs.writeFileSync(configFile, JSON.stringify({ daemon: { agentProfiles: all(mk(brief)) } }));
    return spawnSync('node', [script, '--skill', skillFile, '--config', configFile, '--root', dir], { encoding: 'utf8' });
  };
  assert.equal(runWith('Tier 3 a.md; Tier 2 a.md').status, 0);
  const bad = runWith('Tier 3 a.md; Tier 2 gone.md');
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /MISSING_BRIEF gongbu gone\.md/);
});
