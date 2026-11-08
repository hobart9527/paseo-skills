import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const dir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (p) => fs.readFileSync(path.join(dir, p), 'utf8');
test('skill documents converged core and hard limits', () => {
  const text = read('SKILL.md');
  for (const needle of ['Vertical slices', 'Narrow Verify', 'One worker per task', 'Wave 0', 'finish notification', 'merge-task.mjs', 'freeze-check.mjs', 'worker', 'integrated', 'CP-2']) assert.ok(text.includes(needle), needle);
  // The prompt is allowed room to explain the model; it is not padded to a budget.
  assert.ok(text.length < 20000);
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

test('author brief closes assigned-workspace handoff, permission and structural-check gaps', () => {
  const skill = read('SKILL.md');
  for (const requirement of ['exact preflight and structural commands', 'success does not authorize later commands', 'Any required-command denial means `BLOCKED`', 'as soon as package exists', 'structural command/outcome/exit', 'Reconcile Git/evidence before R0']) {
    assert.ok(skill.includes(requirement), requirement);
  }
  assert.match(skill, /`COMPLETE` requires structural success on committed content/);
  assert.match(skill, /route\/check success is not R0\/CP-1/);
  const author = read('templates/author.md');
  for (const requirement of [
    'assigned author workspace',
    'Do not create another workspace',
    'Before writing, resolve and read every actual template',
    'Preflight success does not authorize `freeze-check`',
    'exact structural-check command',
    'After the complete initial package first exists',
    'route separately from structural-check outcome',
    '`COMPLETE`, `BLOCKED`, or `INCOMPLETE`',
    'package commit SHA',
    'Denied command report',
    'next responsible action',
  ]) assert.ok(author.includes(requirement), requirement);
  assert.match(author, /COMPLETE` only when the structural check succeeded on committed package content/);
  assert.match(author, /command: `<exact command>`; cwd: `<absolute path>`; denial: `<verbatim denial>`/);
});

test('briefs carry wait backstop, reviewer containment and minimal-contract rules', () => {
  assert.match(read('templates/reviewer.md'), /separate workspace/);
  assert.match(read('SKILL.md'), /paseo wait/);
  // Keep native artifacts and gates; author only changed behavior and material risks.
  const author = read('templates/author.md');
  assert.match(author, /Never write a digest or a survey document/);
  assert.match(author, /Depth follows behavior and risk/);
  assert.match(author, /Acceptance records essential real-entry journeys/);
  const schema = read('openspec-schema/schema.yaml');
  assert.match(schema, /Specs describe observable behavior and testable outcomes, not internal DTO fields/);
  assert.match(schema, /Do not invent behavior scenarios for internal-only changes/);
  const reviewer = read('templates/reviewer.md');
  const worker = read('templates/worker.md');
  assert.match(author, /Keep scenarios for observable behavior and semantics/);
  assert.match(author, /freeze its shape and required semantics once in a worker-reachable authoritative contract/);
  assert.match(author, /use a Wave 0 skeleton with `Interface:`\/`Uses:`/i);
  assert.match(author, /Do not create a skeleton solely for an internal signature/);
  assert.match(author, /Before tasks, write any cross-task Decisions in design, one line each naming owner and consumers/);
  assert.match(author, /would each settle the same unfrozen decision, merge them, serialize with `Depends on`, or extract a `Kind: skeleton` with `Interface:` and consumer `Uses:`/);
  assert.match(author, /Tasks that only consume a decision already frozen in design may run concurrently/);
  assert.match(author, /Never leave parallel tasks implementing the same decision independently/);
  assert.match(author, /producer and consumer Write scopes must be disjoint; if still overlapping, serialize with `Depends on`/);
  assert.match(author, /do any two concurrent tasks share an unfrozen decision\?/);
  assert.match(author, /Write only files under `openspec\/changes\/<change>\/`/);
  assert.match(author, /return `BLOCKED` with the reason; never edit any other tracked file/);
  assert.match(author, /Keep concurrent tasks' Write scopes disjoint; do not serialize independent work or invent edges/);
  const tasks = read('openspec-schema/templates/tasks.md');
  assert.match(tasks, /派发等待目标及其依赖链中的 skeleton，不等目标实现合流/);
  assert.match(tasks, /merge 仍要求目标 Done/);
  assert.match(schema, /Concurrent tasks have fully disjoint Write scopes/);
  assert.match(reviewer, /verify one authoritative contract is frozen and reachable before consumer dispatch/);
  assert.match(reviewer, /do not require internal DTO fields or signatures to be repeated as behavioral scenarios/);
  assert.match(reviewer, /ambiguous behavior or interface that can produce incompatible work is a BLOCKER/);
  assert.match(worker, /If required interface shape, behavior, or a decision is missing or ambiguous, return `blocked:`/);
  for (const brief of ['templates/author.md', 'templates/reviewer.md', 'templates/worker.md']) {
    assert.doesNotMatch(read(brief), /Impact Inventory|Baseline Alignment/, brief);
  }
});

test('author brief carries a write-first budget without lowering any gate', () => {
  const author = read('templates/author.md');
  assert.match(author, /## Write-first budget/);
  assert.match(author, /Run `date` first and record the start/);
  assert.match(author, /first files committed by minute 10/);
  assert.match(author, /stop at minute 25/);
  assert.match(author, /Commit each artifact as it lands/);
  assert.match(author, /a summary is not state/);
  assert.match(author, /Exactly four: the Requirement text you modify/);
  assert.match(author, /never read a multi-thousand-line file whole/);
  assert.match(author, /`OPEN-DECISION`: options, consequences, a recommended default/);
  assert.match(author, /Never decide for the human/);
  assert.match(author, /`MISSING_DEPENDENCIES`/);
  assert.match(author, /Budget exhaustion is never a `COMPLETE`/);
  assert.match(author, /Do not read `freeze-check`, parser or scheduler source/);
  assert.match(author, /30-minute mark and compares Paseo status with `git log`/);
  assert.match(author, /Having made a first commit does not clear the point/);
  assert.match(author, /complete package plus the structural check by minute 20/);
  assert.match(author, /roughly 30 \/ 60 \/ 75 calls approximate the same anchors/);
  assert.match(author, /Return `BLOCKED` only if the choice changes the task graph or ownership/);
  assert.match(author, /record that each affected Verify cannot run until the main session resolves it; a zero exit status is not readiness/);
  // The budget must not displace the gates or the single-author topology.
  assert.match(author, /`COMPLETE` still requires the structural check to succeed on committed content/);
  assert.match(author, /One `gongbu` author writes the entire package/);
  assert.doesNotMatch(author, /skip (R0|the structural check)/i);
});

test('contract authoring order freezes findings, SCEN ids and briefed constants', () => {
  const author = read('templates/author.md');
  const schema = read('openspec-schema/schema.yaml');
  const proposal = read('openspec-schema/templates/proposal.md');
  // Baseline: findings persisted as found, no survey stance.
  assert.match(proposal, /^## Baseline$/m);
  assert.match(proposal, /AS FOUND/);
  assert.match(proposal, /A finding that exists only in thinking does not count/);
  assert.match(proposal, /No survey, no alignment tables/);
  assert.match(proposal, /^## OPEN-DECISION$/m);
  assert.match(proposal, /options <A \| B>; consequences .*; recommended default/);
  assert.match(schema, /\*\*Baseline \(paseo-pipeline\):\*\* add a short `## Baseline` section/);
  assert.match(schema, /a finding that exists only\s+in thinking does not count/);
  assert.match(schema, /no\s+survey, no alignment tables, no digest/);
  assert.match(schema, /`## OPEN-DECISION`: options, consequences, a recommended\s+default/);
  // Core Baseline requirement, pinned in both the template and the proposal instruction.
  const proposalInstr = schema.slice(schema.indexOf('  - id: proposal'), schema.indexOf('  - id: specs'));
  for (const [name, text] of [['template', proposal], ['schema instruction', proposalInstr]]) {
    assert.match(text, /`path:line`\s+plus\s+one\s+line\s+of\s+consequence/, `${name}: path:line + consequence`);
    assert.match(text, /AS\s+FOUND/, `${name}: as found`);
    assert.match(text, /and\s+commit/, `${name}: commit requirement`);
  }
  // SCEN freeze lives in the specs instruction.
  const specsInstr = schema.slice(schema.indexOf('  - id: specs'), schema.indexOf('  - id: design'));
  assert.match(specsInstr, /\*\*SCEN freeze:\*\* once the last spec file is committed, the declared SCEN id set is\s+frozen/);
  assert.match(specsInstr, /Never renumber, rename, move or delete a declared\s+id after tasks\.md or acceptance\.md reference it; additions are allowed/);
  assert.match(specsInstr, /same commit and be followed by the structural check/);
  // design before tasks.
  const tasksInstr = schema.slice(schema.indexOf('  - id: tasks'), schema.indexOf('  - id: acceptance'));
  assert.match(tasksInstr, /When design\.md exists, write and commit it before tasks\.md; tasks reference only\s+committed SCEN ids/);
  // Authoring order table precedes the write-first budget.
  const order = author.indexOf('## Authoring order');
  assert.ok(order > 0 && order < author.indexOf('## Write-first budget'));
  const table = author.slice(order, author.indexOf('## Write-first budget'));
  assert.match(table, /`proposal\.md` \(\+ `## Baseline`\)/);
  assert.match(table, /`specs\/` — freezes the SCEN id set/);
  assert.match(table, /`design\.md`, only if its criteria apply/);
  assert.match(table, /`tasks\.md`, then `acceptance\.md`/);
  assert.match(table, /structural check on the complete package/);
  assert.match(table, /commit with done\/remaining in the message/);
  assert.match(table, /`openspec validate`\/`openspec status`/);
  assert.match(table, /No staged freeze-check exists; the first structural check runs when the package is complete, and failures are fixed and rerun until it succeeds or a required command is denied/);
  // Main-session brief fields.
  assert.match(author, /\*\*Project constants\*\*: how Verify runs in a fresh worktree/);
  assert.match(author, /the author must not write `openspec\/config\.yaml`, which belongs to the target project/);
  assert.match(author, /\*\*Pending decisions \(clarify\)\*\*: at most 5 items, each with a default/);
  assert.match(author, /Items with a default do not block; items without a default are asked of the human first/);
  assert.match(author, /answered by the brief's Project constants when supplied/);
  assert.match(read('SKILL.md'), /supplies project constants and at most 5 pending decisions with defaults/);
  // Gates untouched.
  assert.match(author, /30-minute mark/);
  assert.match(author, /`COMPLETE` still requires the structural check to succeed on committed content/);
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

test('schema declares the minimal artifact chain the pipeline reads, in flow order', () => {
  const schema = read('openspec-schema/schema.yaml');
  assert.match(schema, /^name: paseo-pipeline$/m);
  assert.match(schema, /^version: 2$/m);
  const ids = [...schema.matchAll(/^  - id: (\w+)$/gm)].map((m) => m[1]);
  // OpenSpec native set minus digest: proposal, specs, design (on demand), plus the
  // pipeline additions tasks/acceptance/review.
  assert.deepEqual([...ids].sort(), ['acceptance', 'design', 'proposal', 'review', 'specs', 'tasks']);
  // design, when written, comes after the spec; it is optional, so `requires` orders
  // it without demanding it (tasks requires specs only, not design).
  const design = schema.slice(schema.indexOf('  - id: design'), schema.indexOf('  - id: tasks'));
  assert.match(design, /requires:\n\s+- proposal\n\s+- specs/);
  assert.match(design, /create only if any apply/);
  const tasksBlock = schema.slice(schema.indexOf('  - id: tasks'), schema.indexOf('  - id: acceptance'));
  assert.doesNotMatch(tasksBlock, /- design/);
  for (const id of ids) assert.ok(fs.existsSync(path.join(dir, 'openspec-schema', 'templates', `${id === 'specs' ? 'spec' : id}.md`)), `template for ${id}`);
  assert.ok(!fs.existsSync(path.join(dir, 'openspec-schema', 'templates', 'digest.md')), 'digest template removed');
  assert.doesNotMatch(schema, /SKILL\.md「Entry and CP-1」/);
});

test('handoff route requires complete author result and successful matching structural check', () => {
  const skill = read('SKILL.md');
  assert.match(skill, /Handoff route is valid only with author `COMPLETE`/);
  assert.match(skill, /structural exit 0\/no blocks/);
  assert.match(skill, /matching checked\/reported commit SHA/);
  assert.match(skill, /Route alone clears no BLOCK, later failure, or Git\/evidence mismatch/);
  assert.match(skill, /Then skip R0 and use Tier 2 `\/paseo-handoff`/);
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
  assert.match(template, /可选元数据/);
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

test('R0 has a legal exit: reviewer pass, recorded human exception, or blocking', () => {
  const skill = read('SKILL.md');
  // The two approval kinds are distinct and neither may be written as the other.
  assert.match(skill, /R0: pass\(<agent-uuid>@<reviewed-sha>\)/);
  assert.match(skill, /R0: human-accept\(@<sha>\)/);
  assert.match(skill, /never written as a reviewer pass/);
  // A human exception needs its own record, not just the sign-off line.
  assert.match(skill, /approval in `run-log\.md`/);
  assert.match(skill, /open item and reason in `rulings\.md`/);
  // Whole-package rounds are capped; a directed repair is verified as a delta.
  assert.match(skill, /at most two whole-package rounds/);
  assert.match(skill, /verifies the fix diff only/);
  assert.match(skill, /never regenerate the package by default/);
  // NITs are recorded, not fixed, unless they change what a Verify can prove.
  assert.match(skill, /Recorded NITs are not fixed before CP-1/);
});

test('planner output is not execution authorization', () => {
  const skill = read('SKILL.md');
  assert.match(skill, /not execution authorization/);
  assert.match(skill, /human CP-1 for that exact contract commit is in `run-log\.md`/);
  assert.match(skill, /PLANNING PREVIEW/);
  assert.match(skill, /`frozen: false`/);
});

test('author and reviewer briefs implement bounded revision and falsifiable blocking', () => {
  const author = read('templates/author.md');
  assert.match(author, /Mode: `FULL \| REVISE`/);
  assert.match(author, /Do not regenerate the package/);
  assert.match(author, /Do not fix recorded NITs/);
  assert.match(author, /one block per finding/);
  assert.match(author, /Compile the approved design; do not re-solve it/);
  const reviewer = read('templates/reviewer.md');
  assert.match(reviewer, /falsifiable counterexample/);
  assert.match(reviewer, /If your findings are all NITs, return the pass line/);
  assert.match(reviewer, /delta check against your own findings/);
  // A worker gets task-relevant inputs, not unrelated contract history.
  assert.match(read('templates/worker.md'), /Read only from your packet/);
});

test('contract guidance distinguishes structural coverage from worker readiness', () => {
  const author = read('templates/author.md');
  const reviewer = read('templates/reviewer.md');
  const worker = read('templates/worker.md');
  const schema = read('openspec-schema/schema.yaml');
  const tasks = read('openspec-schema/templates/tasks.md');
  assert.match(author, /data migration\/persistence schema, credentials\/security\/audit, cross-task identity\/idempotency, external protocol\/vendor, and destructive\/rollback/);
  assert.match(author, /first Verify may be red/);
  assert.match(author, /merge replay cannot rescue/);
  assert.match(reviewer, /future sibling's file or behavior/);
  assert.match(reviewer, /optional regression read/);
  assert.match(worker, /Before delivery it must run and pass in your branch/);
  assert.match(schema, /owning skeleton must be a dispatch dependency/);
  assert.match(schema, /Structural checks cannot prove existence/);
  assert.match(tasks, /静态检查不证明文件存在/);
});
