import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const dir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (p) => fs.readFileSync(path.join(dir, p), 'utf8');
test('skill documents converged core and hard limits', () => {
  const text = read('SKILL.md');
  for (const needle of ['Vertical slices', 'Narrow Verify', 'One worker per task', 'Wave 0', 'finish notification', 'merge-task.mjs', 'freeze-check.mjs', 'worker', 'integrated', 'CP-2']) assert.ok(text.includes(needle), needle);
  assert.ok(text.length < 12000);
});
test('skill documents the real handoff sequence and profile-notes override', () => {
  const text = read('SKILL.md');
  for (const needle of ['Start after CP-1', 'integration/<change>', 'task/<change>/<T-id>', '确认冻结并交给主会话执行', 'Profile notes describe a role', 'Bootstrap dependencies']) {
    assert.ok(text.includes(needle), needle);
  }
  // A retired test-author role must not reappear as a dispatchable step.
  assert.doesNotMatch(text, /dispatch (a|the) ceshi|dispatch (a|the) shangshu/);
  assert.match(text, /`ceshi` and `shangshu` are retired/);
});

test('docs state the worktree dependency bootstrap contract', () => {
  const skill = read('SKILL.md');
  assert.match(skill, /exit 36|36 unchecked-out dependencies/);
  assert.match(skill, /checkout, not a clone/);
  // The only role that runs Verify is the worker; its brief must say a missing
  // package is an environment fault, not a Red result.
  assert.match(read('templates/worker.md'), /environment fault, not a test result/);
  assert.match(read('templates/worker.md'), /Cannot find package/);
});

test('no removed mechanism remains in operational docs', () => {
  const text = read('SKILL.md');
  for (const stale of ['run-state.mjs', 'reconcile.mjs', 'task-runner.mjs', 'intents', 'speculative']) assert.ok(!text.includes(stale), stale);
});

test('briefs preserve author/worker/reviewer role boundaries', () => {
  for (const file of ['author.md', 'worker.md', 'reviewer.md']) {
    assert.ok(fs.existsSync(path.join(dir, 'templates', file)), file);
  }
  for (const removed of ['tester.md', 'writer.md', 'lead.md', 'lead-resume.md', 'auditor.md']) {
    assert.ok(!fs.existsSync(path.join(dir, 'templates', removed)), removed);
  }
  assert.match(read('templates/worker.md'), /write the tests, write the implementation/);
  assert.match(read('templates/reviewer.md'), /reviewed-HEAD-sha|reviewed SHA/);
  // exit 31 is the most common merge failure; the worker brief must make the
  // writer prove the trailers survived, since a blank line after the block voids them.
  assert.match(read('templates/worker.md'), /trailers:key=Pipeline-Author,valueonly/);
  assert.match(read('templates/worker.md'), /Co-Authored-By/);
});

test('templates avoid removed scripts and the reviewer keeps all modes', () => {
  for (const f of ['author.md', 'worker.md', 'reviewer.md']) {
    const text = read(`templates/${f}`);
    for (const stale of ['run-state.mjs', 'reconcile.mjs', 'task-runner.mjs', 'replan.mjs']) assert.ok(!text.includes(stale), `${f}: ${stale}`);
  }
  for (const mode of ['R0', 'FINAL', 'ARBITER']) assert.ok(read('templates/reviewer.md').includes(mode), mode);
  assert.doesNotMatch(read('templates/reviewer.md'), /Mode.*\bTASK\b/);
});

test('briefs carry wait backstop, reviewer containment and impact inventory rules', () => {
  assert.match(read('templates/reviewer.md'), /separate workspace/);
  assert.match(read('templates/reviewer.md'), /Impact Inventory/);
  assert.match(read('templates/author.md'), /Impact Inventory/);
  assert.match(read('SKILL.md'), /paseo wait/);
  assert.match(read('openspec-schema/templates/design.md'), /Impact Inventory/);
});

test('dispatch guidance resolves live models and forbids copied examples', () => {
  for (const file of ['SKILL.md']) {
    const text = read(file);
    for (const needle of ['list_profiles', 'list_models', 'Never copy model IDs', 'not returned']) {
      assert.ok(text.includes(needle), `${file}: ${needle}`);
    }
  }
  const operationalDocs = [
    read('SKILL.md'),
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
  // design is written after the committed spec: by gaogong on the full path, or by the
  // single FULL author together with the spec on the fast path.
  const design = schema.slice(schema.indexOf('  - id: design'), schema.indexOf('  - id: tasks'));
  assert.match(design, /requires:\n\s+- proposal\n\s+- specs/);
  for (const id of ids) assert.ok(fs.existsSync(path.join(dir, 'openspec-schema', 'templates', `${id === 'specs' ? 'spec' : id}.md`)), `template for ${id}`);
  assert.doesNotMatch(schema, /SKILL\.md「Entry and CP-1」/);
});

test('route=handoff at the structural check skips R0', () => {
  assert.match(read('SKILL.md'), /`\[ROUTE\] handoff` here: skip R0/);
});

test('the main session reconciles by state, never by re-dispatch', () => {
  const skill = read('SKILL.md');
  assert.match(skill, /A lost notification triggers `plan` reconciliation/);
  assert.match(skill, /never a duplicate dispatch/);
  // With no Lead there is no Lead to resume; the main session is the router.
  assert.doesNotMatch(skill, /lead-resume|templates\/lead\.md/);
});

test('the author hook is installed per workspace; workers never type their identity', () => {
  const skill = read('SKILL.md');
  // `--worktree` keeps the hook inside the linked worktree: without it the shared .git/config
  // is mutated and the hook outlives CP-2 on the primary checkout.
  assert.match(skill, /config --worktree core\.hooksPath "\$PIPELINE_HOME\/hooks\/git"/);
  assert.match(skill, /extensions\.worktreeConfig true/);
  assert.match(read('templates/worker.md'), /\$PASEO_AGENT_ID.*never `uuidgen`/s);
  assert.ok(fs.statSync(path.join(dir, 'hooks', 'git', 'commit-msg')).mode & 0o111, 'hook must be executable');
});

test('the worker brief escalates instead of widening scope or guessing', () => {
  assert.match(read('templates/worker.md'), /blocked: <reason>/);
  assert.match(read('templates/worker.md'), /Do not silently widen scope/);
  assert.match(read('templates/worker.md'), /Never edit tests or the Verify command/);
});

test('FINAL review is the only code-quality gate; the merge gate proves mechanics', () => {
  const skill = read('SKILL.md');
  assert.match(skill, /test quality is the FINAL review's job/);
  const reviewer = read('templates/reviewer.md');
  assert.match(reviewer, /only code-quality gate/);
  assert.match(reviewer, /none had a per-task reviewer/);
});
