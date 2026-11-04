import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const dir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (p) => fs.readFileSync(path.join(dir, p), 'utf8');
test('skill documents converged core and hard limits', () => {
  const text = read('SKILL.md');
  for (const needle of ['Vertical slices', 'Narrow Verify', 'One worker per task', 'Wave 0', 'finish notification', 'merge-task.mjs', 'freeze-check.mjs', 'worker', 'integrated', 'CP-2']) assert.ok(text.includes(needle), needle);
  // The prompt is allowed room to explain the model; it is not padded to a budget.
  assert.ok(text.length < 16000);
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

test('templates avoid removed scripts and reviewer keeps current modes', () => {
  for (const f of ['author.md', 'worker.md', 'reviewer.md']) {
    const text = read(`templates/${f}`);
    for (const stale of ['run-state.mjs', 'reconcile.mjs', 'task-runner.mjs', 'replan.mjs']) assert.ok(!text.includes(stale), `${f}: ${stale}`);
  }
  for (const mode of ['R0', 'FINAL']) assert.ok(read('templates/reviewer.md').includes(mode), mode);
  assert.doesNotMatch(read('templates/reviewer.md'), /Mode.*\bTASK\b|ARBITER/);
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
  // One command per workspace: the raw `--worktree` git invocation lives in pipeline-run, so the
  // operator cannot half-install it (worktreeConfig on, hooksPath missing).
  assert.match(skill, /pipeline-run\.mjs install-hook/);
  assert.match(skill, /plan.*warns about any `task\/<change>\/` or `integration\/<change>` worktree/, 'plan must surface a missing hook');
  assert.match(read('templates/worker.md'), /\$PASEO_AGENT_ID.*never `uuidgen`/s);
  assert.ok(fs.statSync(path.join(dir, 'hooks', 'git', 'commit-msg')).mode & 0o111, 'hook must be executable');
});

test('exit 21 names the environment cause, not only the regression', () => {
  const skill = read('SKILL.md');
  assert.match(skill, /Exit 21: a replayed already-Done Verify failed/);
  assert.match(skill, /fix the environment and re-run merge/);
  assert.match(skill, /never edit the Verify command or the tests/);
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

test('FINAL repair instructions retain gate and bind all evidence to final SHA', () => {
  const recovery = read('templates/final-recovery.md');
  for (const requirement of ['human CP-1 approval', 'pipeline-run.mjs merge', 'frozen Verify', 'regression', 'every `Required=yes`', 'same SHA', 'before CP-2']) {
    assert.ok(recovery.includes(requirement), requirement);
  }
  // A repair task overlaps the Done task it fixes; freeze-check needs the edge.
  assert.match(recovery, /Depends on/);
  assert.match(recovery, /SCOPE_CONFLICT/);
  // The original reviewer may be gone; an identically profiled replacement is allowed.
  assert.match(recovery, /new `anchasi` with the same profile/);
  assert.match(read('templates/reviewer.md'), /full SHA and verdict/);
});

test('recovery documents verified other change, permission hold, empty branch and final SHA', () => {
  const skill = read('SKILL.md');
  for (const text of ['--other-change <id>', 'label is verified', 'no pending permission', 'only when no worker', 'main...<full-SHA>', 'author commits the amendment', 'exit 3']) assert.ok(skill.includes(text), text);
});

test('review guidance reflects merge metadata and independent review', () => {
  const schema = read('openspec-schema/schema.yaml');
  const author = read('templates/author.md');
  const reviewer = read('templates/reviewer.md');
  assert.match(schema, /review=worker/);
  assert.match(schema, /Historical Done/);
  assert.match(schema, /rejects\s+`deferred` on sinks/);
  assert.doesNotMatch(schema, /instead of per task/);
  assert.match(author, /missing risk label does not establish safety/);
  assert.match(reviewer, /realistic ways each Verify could pass/);
  assert.match(reviewer, /Script checks establish only their stated properties/);
  assert.match(reviewer, /Lint and typecheck do not replace standards review/);
  assert.match(reviewer, /keyboard and focus, accessibility/);
});

test('task template and schema distinguish structural exemptions from review', () => {
  const template = read('openspec-schema/templates/tasks.md');
  const schema = read('openspec-schema/schema.yaml');
  assert.match(template, /review=worker/);
  assert.match(template, /历史 `pass\(/);
  assert.doesNotMatch(template, /review=<tag>/);
  assert.match(template, /禁止汇点[\s\S]*使用 deferred/);
  assert.match(template, /非汇点的 mechanical 任务也要求窄 Verify/);
  assert.match(template, /mechanical 任务可不认领/);
  assert.match(schema, /does not require `strict`/);
  assert.match(schema, /`mechanical` sink may use a non-test check/);
  assert.match(schema, /structural exemptions do not establish safety/);
});

test('docs reference the optional R0/FINAL summary tool consistently', () => {
  for (const file of ['SKILL.md', 'templates/author.md', 'templates/reviewer.md']) assert.match(read(file), /r0-hotspots\.mjs/, file);
  assert.match(read('templates/reviewer.md'), /--final <reviewed-full-SHA>/);
  assert.match(read('templates/reviewer.md'), /not a substitute for/);
});

test('FINAL depth follows the diff content and R0 rulings have a record format', () => {
  const reviewer = read('templates/reviewer.md');
  assert.match(reviewer, /Match depth to what the diff actually changes/);
  assert.match(reviewer, /Rendered UI/);
  assert.match(reviewer, /Do not skip a part because its task was labelled `mechanical`/);
  assert.match(read('SKILL.md'), /R0-<round>-<n> <BLOCKER\|NIT> <accepted\|rejected\|fixed>/);
});
