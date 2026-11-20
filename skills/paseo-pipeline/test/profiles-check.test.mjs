import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROLE_PROFILE_IDS } from '../profiles-check.mjs';

const script = fileURLToPath(new URL('../profiles-check.mjs', import.meta.url));
const ROLES = ['chanpin', 'hanlin', 'ceshi', 'gongbu', 'gaogong', 'jiangzuo', 'anchasi', 'shangshu', 'neon'];
// The R0 reviewer's live profile id is not `agent_profile_<role>`; the lint resolves it by mapping.
const PROFILE_IDS = { neon: 'agent_profile_mvvzv70y_bweu1x85oc9' };

const skillText = `## Roles\n\n| Profile | Scope |\n|---|---|\n${ROLES.map((r) => `| 角色 \`${r}\` | x |`).join('\n')}\n\n## Tools\n`;
const FAMILY = { chanpin: 'gemini', hanlin: 'claude', ceshi: 'gemini', gongbu: 'glm', gaogong: 'kimi', jiangzuo: 'qwen', anchasi: 'gpt', shangshu: 'claude', neon: 'google' };

function profile(role, over = {}) {
  const family = over.family ?? FAMILY[role];
  const write = over.write ?? 'read-only';
  const lines = [`family: ${family}`, `harness: claude`, `write: ${write}`, 'use: u', 'not: n', 'brief: none'];
  return {
    id: PROFILE_IDS[role] ?? `agent_profile_${role}`, name: role, provider: over.provider ?? 'claude', model: 'm',
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

// SCEN-PROF-01: the R0 reviewer is a dispatched role, not a nesting detail of `hanlin`.
// The real SKILL.md must name it — a role the table omits is never linted at all — and when its
// mapped profile is absent the lint fails instead of silently skipping the role that gates CP-1.
test('SCEN-PROF-01 the R0 reviewer role without its mapped profile is MISSING_PROFILE', () => {
  const skillFile = fileURLToPath(new URL('../SKILL.md', import.meta.url));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profiles-real-'));
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ daemon: { agentProfiles: all().filter((p) => p.id !== PROFILE_IDS.neon) } }));
  const real = spawnSync('node', [script, '--skill', skillFile, '--config', configFile], { encoding: 'utf8' });
  assert.equal(real.status, 1, real.stdout);
  // The finding names the id it resolved, so a table row with no mapping is distinguishable from
  // a wrong id: `agent_profile_neon` was never going to exist.
  assert.match(real.stdout, new RegExp(`MISSING_PROFILE neon \\(${PROFILE_IDS.neon}\\)`));
  const r = run(all().filter((p) => p.id !== PROFILE_IDS.neon));
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /MISSING_PROFILE neon/);
  // Only the reviewer's absence is reported: the other eight roles still resolve.
  assert.doesNotMatch(r.out, /MISSING_PROFILE (?!neon)/);
});

// SCEN-PROF-02: the live Neon profile carries `agent_profile_mvvzv70y_bweu1x85oc9`, so the
// `agent_profile_<role>` default alone would report a role that does exist as MISSING_PROFILE.
test('SCEN-PROF-02 a mapped non-default profile id resolves and the run exits 0', () => {
  const r = run(all());
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /profiles ok \(9 roles\)/);
  const reviewer = all().find((p) => p.id === PROFILE_IDS.neon);
  assert.equal(reviewer.id, 'agent_profile_mvvzv70y_bweu1x85oc9');
});

test('the resolved role-to-profile-id mapping is explicit, not a name guess', () => {
  assert.equal(ROLE_PROFILE_IDS.neon, 'agent_profile_mvvzv70y_bweu1x85oc9');
  // A profile reachable only by a different id is not found by matching `name`: the mapping is the
  // only route, so a renamed id is still MISSING_PROFILE rather than an accidental match.
  const renamed = all().map((p) => (p.id === PROFILE_IDS.neon ? { ...p, id: 'agent_profile_neon' } : p));
  const r = run(renamed);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /MISSING_PROFILE neon/);
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

// R6: a brief pointer must match the profile's `use:` boundary. The contract-author brief belongs
// to the role that writes the contract; handing it to a research role is a boundary drift the
// live 调研（中书）profile shows today. It is reported, not blocked: the live config is outside the
// repository, so a block would make the required live run exit 1 until someone edits it there.
test('a non-authoring role carrying the contract-author brief is reported as an advisory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profiles-brief-'));
  fs.mkdirSync(path.join(dir, 'skills/paseo-pipeline/templates'), { recursive: true });
  for (const name of ['author', 'tester', 'worker', 'reviewer']) {
    fs.writeFileSync(path.join(dir, `skills/paseo-pipeline/templates/${name}.md`), 'x');
  }
  const skillFile = path.join(dir, 'SKILL.md');
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(skillFile, skillText);
  const withBrief = (role, brief) => ({
    [role]: { notes: `family: ${FAMILY[role]}\nharness: claude\nwrite: w\nuse: u\nnot: n\nbrief: ${brief}` },
  });
  const runWith = (over) => {
    fs.writeFileSync(configFile, JSON.stringify({ daemon: { agentProfiles: all(over) } }));
    return spawnSync('node', [script, '--skill', skillFile, '--config', configFile, '--root', dir], { encoding: 'utf8' });
  };
  const author = 'skills/paseo-pipeline/templates/author.md';
  const drifted = runWith({ chanpin: withBrief('chanpin', author).chanpin });
  assert.equal(drifted.status, 0, drifted.stdout);
  assert.match(drifted.stdout, /ADVISORY_BRIEF_OUT_OF_SCOPE chanpin/);
  assert.match(drifted.stdout, /profiles ok \(9 roles\)/);
  // The contract author is the role that owns it, so its own pointer is not reported.
  const owned = runWith({ hanlin: withBrief('hanlin', author).hanlin });
  assert.doesNotMatch(owned.stdout, /ADVISORY_BRIEF_OUT_OF_SCOPE hanlin/);
});
