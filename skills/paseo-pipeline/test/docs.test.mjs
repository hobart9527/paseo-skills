import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const dir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (p) => fs.readFileSync(path.join(dir, p), 'utf8');
test('skill documents converged core and hard limits', () => {
  const text = read('SKILL.md');
  for (const needle of ['Vertical slices', 'Narrow Verify', 'Frontier scheduling', 'Wave 0', 'finish notifications', 'merge-task.mjs', 'freeze-check.mjs', 'tester', 'integrated', 'CP-2']) assert.ok(text.includes(needle), needle);
  assert.ok(text.length < 12000);
});
test('skill documents the real handoff sequence and profile-notes override', () => {
  const text = read('SKILL.md');
  for (const needle of ['Handoff after CP-1', 'integration/<change>', 'task/<change>/<T-id>', '确认冻结并交给 shangshu 执行', 'Profile notes describe a role', 'Bootstrap dependencies']) {
    assert.ok(text.includes(needle), needle);
  }
  // The old rule ("only Review: strict gets Red tests") would let merge-task exit 31
  // on a standard task; the SKILL must state the real condition.
  assert.match(text, /every non-mechanical task needs a Red test commit/);
});

test('docs state the worktree dependency bootstrap contract', () => {
  const skill = read('SKILL.md');
  assert.match(skill, /exit 36|36 unchecked-out dependencies/);
  assert.match(skill, /does not inherit `node_modules`/);
  // Both roles that run Verify must be told the missing-package signal is not Red.
  assert.match(read('templates/tester.md'), /not Red/);
  assert.match(read('templates/writer.md'), /environment fault, not a test result/);
  assert.match(read('templates/lead.md'), /checkout, not a clone/);
});

test('no removed mechanism remains in operational docs', () => {
  const text = read('SKILL.md');
  for (const stale of ['run-state.mjs', 'reconcile.mjs', 'task-runner.mjs', 'intents', 'speculative']) assert.ok(!text.includes(stale), stale);
});

test('briefs preserve author/tester/writer/reviewer role boundaries', () => {
  for (const file of ['author.md', 'tester.md', 'writer.md', 'reviewer.md', 'lead.md']) {
    assert.ok(fs.existsSync(path.join(dir, 'templates', file)), file);
  }
  assert.match(read('templates/writer.md'), /Treat test-author commits as immutable/);
  assert.match(read('templates/tester.md'), /behavior tests only/);
  assert.match(read('templates/reviewer.md'), /reviewed SHA|reviewed_sha|tip/);
  // exit 31 is the most common merge failure; both authoring briefs must make the
  // writer prove the trailers survived, since a blank line after the block voids them.
  for (const file of ['writer.md', 'tester.md']) {
    assert.match(read(`templates/${file}`), /trailers:key=Pipeline-Author,valueonly/, file);
    assert.match(read(`templates/${file}`), /Co-Authored-By/, file);
  }
});

test('lead brief keeps required sections and templates avoid removed scripts', () => {
  const lead = read('templates/lead.md');
  for (const h of ['Startup and truth', 'Frontier dispatch', 'Notifications, audit, merge', 'Finish', 'Recovery commands']) assert.ok(lead.includes(h), h);
  for (const f of ['lead.md', 'author.md', 'tester.md', 'writer.md', 'reviewer.md', 'auditor.md']) {
    const text = read(`templates/${f}`);
    for (const stale of ['run-state.mjs', 'reconcile.mjs', 'task-runner.mjs', 'replan.mjs']) assert.ok(!text.includes(stale), `${f}: ${stale}`);
  }
  for (const mode of ['R0', 'TASK', 'FINAL', 'ARBITER']) assert.ok(read('templates/reviewer.md').includes(mode), mode);
});

test('briefs carry wait backstop, reviewer containment and impact inventory rules', () => {
  const lead = read('templates/lead.md');
  assert.match(lead, /paseo wait <agent-id> --timeout/);
  assert.match(lead, /regression|already-Done/);
  assert.match(lead, /separate workspace|own fresh workspace/);
  assert.match(read('templates/reviewer.md'), /Impact Inventory/);
  assert.match(read('templates/author.md'), /Impact Inventory/);
  assert.match(read('SKILL.md'), /paseo wait/);
  assert.match(read('openspec-schema/templates/design.md'), /Impact Inventory/);
});

test('dispatch guidance resolves live models and forbids copied examples', () => {
  for (const file of ['SKILL.md', 'templates/lead.md']) {
    const text = read(file);
    for (const needle of ['list_profiles', 'list_models', 'Never copy model IDs', 'not returned']) {
      assert.ok(text.includes(needle), `${file}: ${needle}`);
    }
  }
  const operationalDocs = [
    read('SKILL.md'),
    read('templates/lead.md'),
    fs.readFileSync(path.resolve(dir, '../../docs/sdd-multi-agent-architecture.md'), 'utf8'),
    fs.readFileSync(path.resolve(dir, '../../docs/paseo-pipeline-architecture.md'), 'utf8'),
  ];
  for (const text of operationalDocs) {
    assert.doesNotMatch(text, /gpt[- ]?5\.4|claude\/opus|claude[- ]3[.-]7[- ]sonnet|gpt[- ]?4o/i);
  }
});

test('schema declares every artifact the pipeline reads, in flow order', () => {
  const schema = read('openspec-schema/schema.yaml');
  assert.match(schema, /^name: paseo-pipeline$/m);
  const ids = [...schema.matchAll(/^  - id: (\w+)$/gm)].map((m) => m[1]);
  assert.deepEqual([...ids].sort(), ['acceptance', 'design', 'digest', 'proposal', 'review', 'specs', 'tasks']);
  // design is written by gaogong after the committed spec (SKILL.md Entry step 3).
  const design = schema.slice(schema.indexOf('  - id: design'), schema.indexOf('  - id: tasks'));
  assert.match(design, /requires:\n\s+- proposal\n\s+- specs/);
  for (const id of ids) assert.ok(fs.existsSync(path.join(dir, 'openspec-schema', 'templates', `${id === 'specs' ? 'spec' : id}.md`)), `template for ${id}`);
  assert.doesNotMatch(schema, /SKILL\.md「Entry and CP-1」/);
});

test('route=handoff at the structural check skips R0', () => {
  assert.match(read('SKILL.md'), /`\[ROUTE\] handoff` here: skip R0/);
});

test('lead interruption: resume same Lead, re-arm waits, never archive pipeline agents', () => {
  const lead = read('templates/lead.md');
  const resume = read('templates/lead-resume.md');
  assert.match(lead, /never create another Lead/);
  assert.match(lead, /re-arm the backstop/);
  assert.match(lead, /Never archive any agent labeled `pipeline\.change=<change>`/);
  assert.match(resume, /SAME Lead ID/);
  assert.match(resume, /Re-arm the backstop `paseo wait`/);
  assert.match(read('SKILL.md'), /resume that ID with `templates\/lead-resume\.md`/);
  for (const stale of ['run-state.mjs', 'reconcile.mjs', 'task-runner.mjs', 'replan.mjs']) assert.ok(!resume.includes(stale), stale);
});

test('lead installs the author hook per workspace; writers never type their identity', () => {
  const lead = read('templates/lead.md');
  // `--worktree` keeps the hook inside the linked worktree: without it the shared .git/config
  // is mutated and the hook outlives CP-2 on the primary checkout.
  assert.match(lead, /config --worktree core\.hooksPath "\$PIPELINE_HOME\/hooks\/git"/);
  assert.match(lead, /extensions\.worktreeConfig true/);
  for (const f of ['tester.md', 'writer.md']) assert.match(read(`templates/${f}`), /\$PASEO_AGENT_ID.*never `uuidgen`/s, f);
  assert.ok(fs.statSync(path.join(dir, 'hooks', 'git', 'commit-msg')).mode & 0o111, 'hook must be executable');
});

test('lead escalates capability on repeated rework, not the same profile', () => {
  const lead = read('templates/lead.md');
  assert.match(lead, /gaogong.*never the light profile/);
  assert.match(lead, /ARBITER/);
  assert.match(lead, /--allow-attempt-over/);
});
