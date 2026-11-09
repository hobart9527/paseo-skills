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
  // Id collision precheck before freezing.
  assert.match(specsInstr, /Before\s+assigning\s+ids,\s+list\s+the\s+ids\s+already\s+declared\s+in\s+baseline\s+`openspec\/specs\/\*\*`\s+and\s+in\s+every\s+other\s+`openspec\/changes\/\*\/specs\/\*\*`\s+with\s+one\s+`rg`\s+over\s+scenario\s+headings\s+only,\s+choose\s+new\s+ids\s+outside\s+that\s+set,\s+and\s+only\s+then\s+commit\s+the\s+specs\s+as\s+the\s+frozen\s+set/);
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
  // A staged specs check exists; the full structural check still runs on the complete package.
  assert.match(table, /After committing `specs\/`, run the supplied structural check with `--stage specs` appended \(`--structural --stage specs`\) and fix what it blocks before design\/tasks/);
  assert.match(table, /The full structural check still runs once the package is complete, and failures are fixed and rerun until it succeeds or a required command is denied/);
  assert.match(table, /run `node "\$PIPELINE_HOME"\/namespace\.mjs openspec\/changes\/<change>` once: it lists every `SCEN-<PFX>` prefix in baseline `openspec\/specs\/\*\*` and the other unarchived changes' `openspec\/changes\/\*\/specs\/\*\*` with the next free number/);
  assert.match(table, /This one call is the baseline\/active-change sweep; the four bounded collision checks below are unchanged/);
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

test('authoring order commits a proposal skeleton before any code read', () => {
  const author = read('templates/author.md');
  const order = author.indexOf('## Authoring order');
  const table = author.slice(order, author.indexOf('## Write-first budget'));
  // Step 0 exists with the skeleton scope, the 2-minute commit and the no-code constraint.
  assert.match(table, /\| 0 \| `proposal\.md` skeleton:/);
  // Every required skeleton element is pinned inside the Step 0 row itself.
  const row0 = table.split('\n').find((line) => line.startsWith('| 0 |'));
  assert.ok(row0, 'Step 0 row exists');
  assert.match(row0, /skeleton: Why, the rule list under What Changes \(one line per rule; details may be TBD\), `## OPEN-DECISION` for choices the brief already supplies, and an empty `## Baseline`/);
  assert.match(row0, /Run `openspec new change` first/);
  assert.match(row0, /commit within 2 minutes; read no code/);
  // A one-line rule list is the plan; the baseline read is owed before the spec delta.
  assert.match(author, /The Step 0 one-line rule list is a plan and needs no baseline read; before writing a rule into its spec delta or `## MODIFIED Requirements` block, read the baseline it lands on/);
  // The rule list is written from approved inputs, not from research.
  assert.match(author, /Writing the Step 0 proposal skeleton does not depend on research being complete/);
  // Code reads serve a listed rule and persist findings as found.
  assert.match(author, /Once the Step 0 rule list is committed, code reads are allowed[^\n]*each read must serve one rule on that list/);
  assert.match(author, /Append each `path:line` fact to `## Baseline` as found and commit it small/);
  // namespace.mjs runs after the rule list is committed and before ids are assigned.
  assert.match(author, /After the rule list is committed and before step 2 assigns ids, run `node "\$PIPELINE_HOME"\/namespace\.mjs/);
  // Collision checks are bounded to after the rule list too.
  assert.match(author, /These happen only after the Step 0 rule list is committed\. Exactly four: the Requirement text you modify/);
  // The measured anchors are unchanged.
  assert.match(author, /first files committed by minute 10/);
  assert.match(author, /complete package plus the structural check by minute 20/);
  assert.match(author, /stop at minute 25/);
});

test('task design self-checks scenario ownership, falsifiable Verify and named symbols', () => {
  const author = read('templates/author.md');
  const schema = read('openspec-schema/schema.yaml');
  const taskDesign = author.slice(author.indexOf('## Task design'), author.indexOf('## Decision Context'));
  const tasksInstr = schema.slice(schema.indexOf('  - id: tasks'), schema.indexOf('  - id: acceptance'));
  const clauses = [
    // Entry owned: the observed entry sits in the owning task's Write scope (or a Depends on edge), not beside it.
    ['entry owned', /Entry owned: the entry point named for the SCEN in acceptance\.md[^\n]*Write scope, or the owner `Depends on` the task that owns it[^\n]*does not stand in for it\./,
      /entry point named for the SCEN in acceptance\.md[\s\S]*?inside the owner's Write scope,\s+or the owner `Depends on` the task that owns it[\s\S]*?does not stand in for it/],
    // Verify can fail: the test exercises the entry and would be red before the change.
    ['Verify can fail', /Verify can fail: the owner's Verify runs a test that exercises that entry or function and would fail before the change[^\n]*Write scope \(or created by it\)[^\n]*cannot carry the SCEN\./,
      /owner's Verify runs a test that exercises\s+that entry or function and would fail before the change[\s\S]*?Write scope or created by it[\s\S]*?never calls the code under change cannot carry the SCEN/],
    // Names exist: every named symbol checked with rg; design names decisions, tasks name decisions.
    ['names exist', /Names exist: confirm each field, symbol or route a task or design names once with `rg` in the tree \(or in a file the task creates\); design\.md names decisions \(`D-01`\) and affected modules only, never task ids; when design\.md exists, tasks declare `Implements:` decision ids and every id must exist in design\.md; with no design\.md there are no decision ids, so omit `Implements:` \(it is optional in the tasks template\)\./,
      /confirmed once with `rg` in the tree[\s\S]*?design\.md names decisions \(`D-01`\) and affected modules only,\s+never task ids; when design\.md exists, tasks declare `Implements:` decision ids and\s+every id must exist in design\.md; when it does not exist, omit `Implements:`\s+because there are no decision ids to reference/],
  ];
  for (const [name, authorRe, schemaRe] of clauses) {
    assert.match(taskDesign, authorRe, `author.md: ${name}`);
    assert.match(tasksInstr, schemaRe, `schema tasks instruction: ${name}`);
  }
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

test('FINAL is a bounded conformance verdict; the merge gate proves mechanics', () => {
  const skill = read('SKILL.md');
  assert.match(skill, /test quality is the FINAL review's job/);
  const reviewer = read('templates/reviewer.md');
  assert.doesNotMatch(reviewer, /only code-quality gate/);
  assert.match(reviewer, /none had a per-task reviewer/);
  assert.match(reviewer, /contract-conformance verdict, not an open search/);
  assert.match(reviewer, /conformance matrix/);
  assert.match(reviewer, /`MET \| NOT_MET \| UNVERIFIABLE`/);
  assert.match(reviewer, /A BLOCKER must attach to a matrix row/);
  assert.match(reviewer, /Cannot attach to a row ⇒ not a blocker/);
  assert.match(reviewer, /Round 2 is delta only/);
  assert.match(reviewer, /At most two rounds per change/);
  assert.match(reviewer, /CONTRACT_GAP/);
  assert.match(reviewer, /ENHANCEMENT/);
  assert.match(reviewer, /only label NOT_MET rows/);
  assert.match(skill, /Bounded FINAL.*max two rounds/);
});

test('FINAL findings are ledgered and routed by class; ledger survives SHAs and reviewers', () => {
  const reviewer = read('templates/reviewer.md');
  assert.match(reviewer, /Finding ledger/);
  assert.match(reviewer, /`review\.md`/);
  assert.match(reviewer, /F-<n> <matrix row> <DEVIATION\|CONTRACT_GAP\|ENHANCEMENT> <open\|fixed@<sha>\|closed\|accepted\|rejected>/);
  assert.match(reviewer, /ledger carries across SHAs and reviewers/);
  assert.match(reviewer, /confirmed fixed is closed; reopening it needs new evidence/);
  assert.match(reviewer, /replacement reviewer reads the ledger first and inherits the budget/);
  const recovery = read('templates/final-recovery.md');
  assert.match(recovery, /Only DEVIATION .* enters a repair task/);
  assert.match(recovery, /CONTRACT_GAP goes to the human/);
  assert.match(recovery, /ENHANCEMENT goes to the backlog/);
  const skill = read('SKILL.md');
  assert.match(skill, /DEVIATION → one batched repair wave/);
  assert.match(skill, /CONTRACT_GAP → human/);
});

test('FINAL is capped at two rounds with a mandatory three-way human exit mirroring R0', () => {
  const recovery = read('templates/final-recovery.md');
  assert.doesNotMatch(recovery, /repeat steps 3-5/);
  assert.match(recovery, /at most 2 FINAL rounds per change/);
  assert.match(recovery, /round 1 full, round 2 delta/);
  assert.match(recovery, /`FINAL: human-accept\(@<sha>\)` in `review\.md`/);
  assert.match(recovery, /`Approval: FINAL residual risk accepted for <sha> — <reason>` in `run-log\.md`/);
  assert.match(recovery, /\(b\) reopen at contract level — delta R0 \+ CP-1/);
  assert.match(recovery, /\(c\) terminate the change/);
  assert.match(recovery, /no fourth default/);
  const skill = read('SKILL.md');
  assert.match(skill, /`FINAL: human-accept\(@<sha>\)`/);
  assert.match(skill, /`Approval: FINAL residual risk accepted for <sha> — <reason>`/);
  assert.match(skill, /reopen once at contract level \(delta R0 \+ CP-1, one wave, one reopen delta round\), or terminate/);
});

test('FINAL repairs are batched, parallel by domain, SHA-bound, with one pre-authorizable wave', () => {
  const recovery = read('templates/final-recovery.md');
  assert.match(recovery, /One round's DEVIATIONs become one amendment and one repair wave/);
  assert.match(recovery, /split by domain into parallel tasks/);
  assert.match(recovery, /Repairs depend on each other only when their own scopes overlap/);
  assert.match(recovery, /SCOPE_CONFLICT/);
  assert.match(recovery, /up to 1 FINAL repair wave of ≤N tasks, DEVIATION only/);
  assert.match(recovery, /Every approval binds to a SHA in `run-log\.md`/);
  assert.match(recovery, /"approach only" approval is not one/);
  assert.match(recovery, /one `anchasi` session for all FINAL rounds/);
  assert.match(recovery, /reads the ledger first/);
  assert.match(recovery, /reason for replacement is recorded/);
});

test('FINAL cannot loop or pass on missing evidence: UNVERIFIABLE escalates, reopen is once', () => {
  const reviewer = read('templates/reviewer.md');
  assert.match(reviewer, /`UNVERIFIABLE` is never conformance: any such row makes the verdict `INCOMPLETE`, not a pass/);
  assert.match(reviewer, /handled like NOT_MET after round 2/);
  const recovery = read('templates/final-recovery.md');
  assert.match(recovery, /After round 2 with any NOT_MET or UNVERIFIABLE row, the human must choose one/);
  assert.match(recovery, /missing evidence for an UNVERIFIABLE row .* that is not a repair task/);
  assert.match(recovery, /exactly one repair wave and one reopen delta round/);
  assert.match(recovery, /\(b\) can be chosen at most once per change/);
  assert.match(recovery, /only \(a\) or \(c\) remain/);
  assert.doesNotMatch(recovery, /new repair wave whose re-review is again delta only/);
  assert.match(recovery, /no NOT_MET or UNVERIFIABLE row is unaccepted/);
  const skill = read('SKILL.md');
  assert.match(skill, /NOT_MET\/UNVERIFIABLE the human chooses/);
  assert.match(skill, /reopen once at contract level/);
});

test('FINAL evidence binds to the reviewed SHA; record commits touch only three files', () => {
  const recovery = read('templates/final-recovery.md');
  assert.match(recovery, /Evidence binds to the reviewed code SHA/);
  assert.match(recovery, /record commits, touching nothing but `openspec\/changes\/<change>\/\{review\.md,rulings\.md,run-log\.md\}`/);
  assert.match(recovery, /git diff --name-only <reviewed-sha>\.\.HEAD/);
  assert.match(recovery, /lists only those files/);
  assert.match(recovery, /Only then make record commits/);
  assert.doesNotMatch(recovery, /verify integration HEAD still equals the recorded SHA,/);
  assert.match(read('templates/reviewer.md'), /record commits only/);
  assert.match(read('SKILL.md'), /Later commits touch only `review\.md`, `rulings\.md`, `run-log\.md`/);
});

test('pre-authorization is a recorded human approval applied to a named amendment SHA', () => {
  const recovery = read('templates/final-recovery.md');
  assert.match(recovery, /unless covered by a pre-authorization \(below\)/);
  assert.match(recovery, /verbatim CP-1 approval of "up to 1 FINAL repair wave of ≤N tasks, DEVIATION only"/);
  assert.match(recovery, /adds no new interface or security boundary/);
  assert.match(recovery, /`Approval: pre-authorized repair wave \(<cp1-approval-timestamp>\) applied to <amendment-sha>`/);
  assert.match(recovery, /without that line naming the amendment SHA, dispatch is not authorized/);
  assert.match(recovery, /needs fresh human CP-1 for its SHA/);
  assert.doesNotMatch(recovery, /repair tasks need no per-task re-freeze approval/);
});

test('acceptance check runs at the reviewed SHA before record commits, not at the record HEAD', () => {
  const recovery = read('templates/final-recovery.md');
  assert.match(recovery, /while integration HEAD equals the reviewed SHA and before any record commit, run `acceptance check`/);
  assert.match(recovery, /log its command, exit status and the reviewed SHA in `run-log\.md`/);
  assert.match(recovery, /logged check is bound to the reviewed SHA/);
  assert.match(recovery, /do not re-run `acceptance check` at the record HEAD/);
  assert.match(recovery, /Any other path invalidates the evidence: redo it at the new SHA/);
  assert.match(read('SKILL.md'), /run at the reviewed SHA, before record commits/);
  // The checker really binds to HEAD, which is why the sequence matters.
  assert.match(read('acceptance-run.mjs'), /record\.sourceSha !== sha/);
});

test('pre-authorization exception is named wherever amendments need approval', () => {
  const skill = read('SKILL.md');
  assert.match(skill, /a human confirms, or a recorded pre-authorization covers it \(`final-recovery\.md`\), before `plan`/);
  assert.match(skill, /amend under CP-1 or recorded pre-authorization/);
  assert.doesNotMatch(skill, /amend under human CP-1/);
  assert.doesNotMatch(skill, /a human confirms before re-running `plan`/);
  assert.match(read('templates/final-recovery.md'), /unless covered by a pre-authorization \(below\)/);
});

test('the reopen delta round is named consistently outside the two-round count', () => {
  const recovery = read('templates/final-recovery.md');
  assert.match(recovery, /plus one reopen delta round only if \(b\) is chosen/);
  assert.match(recovery, /one reopen delta round \(the only round beyond the two\)/);
  assert.match(recovery, /remains after the reopen delta round/);
  assert.match(read('templates/reviewer.md'), /plus one reopen delta round if the human reopens at contract level/);
  assert.match(read('SKILL.md'), /one wave, one reopen delta round\)/);
  assert.doesNotMatch(recovery, /one more delta round/);
});

test('R0 checks the Verify oracle and amendment R0 is delta-only', () => {
  const reviewer = read('templates/reviewer.md');
  assert.match(reviewer, /\*\*Oracle check\.\*\*/);
  assert.match(reviewer, /real entry its Verify exercises/);
  assert.match(reviewer, /not a fixture or an isolated module/);
  assert.match(reviewer, /how a wrong implementation would make that Verify fail/);
  assert.match(reviewer, /Verify a wrong or unwired implementation would still pass, is a BLOCKER/);
  assert.match(reviewer, /delta-only against its parent SHA, one round/);
  // Existing R0 rules keep working.
  assert.match(reviewer, /At most two whole-package R0 rounds per change/);
  assert.match(reviewer, /R0: pass\(<your-full-agent-uuid>@<reviewed-HEAD-sha-7-chars>\)/);
});

test('Tier 2 brief is requirement-anchored with per-delivery caps and escalation', () => {
  const brief = fs.readFileSync(path.join(dir, '..', '..', 'docs', 'tier2-reviewer-brief.md'), 'utf8');
  assert.match(brief, /verdict is against the Requirement field above, not against all problems in the diff/);
  assert.match(brief, /DEVIATION/);
  assert.match(brief, /REQUIREMENT_GAP/);
  assert.match(brief, /ENHANCEMENT/);
  assert.match(brief, /Only `DEVIATION` is a `BLOCKER`/);
  assert.match(brief, /At most 2 reviewer agents and 4 verdicts in total for one delivery/);
  assert.match(brief, /inherits all prior findings and the budget does not reset/);
  assert.match(brief, /same defect class is blocked in two consecutive rounds/);
  assert.match(brief, /independent PASS conflicts with an assigned reviewer's BLOCKED/);
  assert.match(brief, /both verdicts side by side/);
});

test('LESSONS records the review-convergence redesign with health metrics', () => {
  const lessons = read('LESSONS.md');
  assert.match(lessons, /2026-11-09/);
  assert.match(lessons, /FINAL 12 轮/);
  assert.match(lessons, /评审健康度指标/);
  assert.match(lessons, /FINAL 轮数 ≤2/);
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
  assert.match(recovery, /same profile/);
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
  // A test-only sink is an advisory to check, not proof that no task owns the wiring.
  assert.match(schema, /advisory, not as proof/);
  assert.match(read('templates/author.md'), /advisory for R0 rather than proof of a missing owner/);
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

test('acceptance guidance matches the gate: every declared SCEN is covered, journeys are not', () => {
  const author = read('templates/author.md');
  const schema = read('openspec-schema/schema.yaml');
  const template = read('openspec-schema/templates/acceptance.md');
  // The old brief said acceptance is "not ... every spec scenario", which the gate contradicts:
  // freeze-check.mjs:633 rejects UNACCEPTED_SCEN. The brief must state the row requirement in its
  // own words, while still forbidding a second unit-test list.
  assert.doesNotMatch(author, /not a second list of unit tests or every spec scenario/);
  assert.match(author, /not a second list of unit tests, but every declared `SCEN-\*` still needs at least one row/);
  assert.match(author, /Rows may share an Entry and Verify, and reuse an existing test: a scenario does not need a new test of its own/);
  // Ownership: an empty cell derives owners from tasks.md; a filled one is a per-row subset
  // whose union covers every claimant.
  assert.match(author, /Leave the `Tasks` cell empty and it is derived from the `Scenarios` claims in `tasks\.md`/);
  assert.match(author, /A non-empty cell may list only tasks that claim that SCEN in `tasks\.md` `Scenarios`/);
  assert.match(author, /their union lists every claiming task/);
  // Required is a semantic decision, not a blanket `no`.
  assert.match(author, /`Required` follows real delivery semantics — do not set every row `no`/);
  assert.match(template, /每个声明过的场景至少一行/);
  assert.match(template, /留空则从 tasks\.md 的 Scenarios 认领自动推导/);
  assert.match(template, /所有行的并集必须覆盖全部认领者/);
  assert.match(template, /不要为省事把全部行设为 no/);
  // Schema acceptance instruction carries the same rule, scoped to its own block.
  const acceptanceInstr = schema.slice(schema.indexOf('  - id: acceptance'), schema.indexOf('  - id: review'));
  assert.match(acceptanceInstr, /Every `SCEN-\*` declared in the change's spec delta needs at least one row/);
  assert.match(acceptanceInstr, /Leave a row's `Tasks` cell empty\s+and the owners are derived/);
  assert.match(acceptanceInstr, /union\s+of all rows for a scenario must name every task that claims it/);
  assert.match(acceptanceInstr, /rather than setting every row `no`/);
});

test('structural-check guidance names the real exit code, not a pipeline tail status', () => {
  const author = read('templates/author.md');
  const template = read('openspec-schema/templates/acceptance.md');
  // A `| tail` at the end of the pipe replaces the checker's status with tail's; the brief must say so.
  assert.match(author, /Judge the result by the check's own process exit code, not by the status of the last command in a pipe/);
  assert.match(author, /`node freeze-check\.mjs \.\.\. \| tail -n 20` reports `tail`'s status, not the check's/);
  assert.match(author, /With `--structural --json`, only `blocking` rejects; `advisories` are for R0 and keep exit 0/);
  assert.match(template, /经过 `\| tail` 等管道时 `\$\?` 是管道末端的状态，不能当作检查结果/);
});
