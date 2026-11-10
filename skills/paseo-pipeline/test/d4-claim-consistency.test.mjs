import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Section 1 of the D4 design: the author brief, schema and acceptance template must state the
// claim-consistency rules the gate already enforces, and must distinguish a new SCEN id from
// baseline identity reuse and from a content conflict with an active change. These tests build
// packages by filling the REAL templates (not by asserting a sentence contains a phrase), so a
// template that drifts from the gate breaks them.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readTemplate = (name) => fs.readFileSync(path.join(root, 'openspec-schema', 'templates', name), 'utf8');
const skill = () => fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8');
const brief = () => fs.readFileSync(path.join(root, 'templates', 'author.md'), 'utf8');
const acceptanceTemplate = () => fs.readFileSync(path.join(root, 'openspec-schema', 'templates', 'acceptance.md'), 'utf8');
const schema = () => fs.readFileSync(path.join(root, 'openspec-schema', 'schema.yaml'), 'utf8');

const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
};
delete env.NODE_TEST_CONTEXT;

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}
function write(cwd, file, text) {
  const target = path.join(cwd, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
}
function change(files) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'd4-claims-'));
  for (const [file, text] of Object.entries(files)) write(cwd, file, text);
  return cwd;
}
function freeze(repo, flags = ['--structural', '--skip-signer-check']) {
  const r = spawnSync('node', [path.join(root, 'freeze-check.mjs'), path.join(repo, 'openspec/changes/chg'), '--json', ...flags], { encoding: 'utf8', env });
  const report = r.stdout ? JSON.parse(r.stdout) : null;
  return { status: r.status, report, stdout: r.stdout, stderr: r.stderr, out: `${r.stdout}${r.stderr}` };
}

// ---- the package, built from the real templates -------------------------------------------
// Two scenarios and three tasks: SCEN-CAP-01 is carried by T-01 and T-03, SCEN-CAP-02 by T-02
// only. That shape is what makes the union rule meaningful — a single-owner package cannot show
// a row that hides one claimant.
function packageFiles({ acceptanceRows, tasksOverride } = {}) {
  const tasks = `${readTemplate('tasks.md')
    .replaceAll('path/to/file.mjs', 'src/app.mjs')
    .replaceAll('path/to/file.test.mjs', 'test/app.test.mjs')
    .replaceAll('path/to/a.mjs', 'src/nav.mjs')
    .replaceAll('path/to/a.test.mjs', 'test/nav.test.mjs')}
- [ ] 3.1 T-03 <second carrier of the same journey>
  - Depends on: T-01
  - Write scope: src/export.mjs, test/export.test.mjs
  - Verify with: node --test test/export.test.mjs
  - Scenarios: SCEN-CAP-01
`;
  const filled = (tasksOverride ?? tasks)
    .replace('Scenarios: SCEN-CAP-01\n', 'Scenarios: SCEN-CAP-01\n')
    .replace('Scenarios: SCEN-CAP-02', 'Scenarios: SCEN-CAP-02');
  const spec = `${readTemplate('spec.md')
    .replace('SCEN-<CAP>-01', 'SCEN-CAP-01')
    .replace('<!-- requirement name -->', 'Export runs')
    .replace('<!-- requirement text -->', 'The system SHALL export data.')
    .replace('<!-- optional description -->', 'export runs')
    .replace('<!-- condition -->', 'invoked')
    .replace('<!-- expected outcome -->', 'it exports')}
#### Scenario: SCEN-CAP-02 export fails loudly
- **WHEN** invoked badly
- **THEN** it fails
`;
  return {
    'openspec/changes/chg/tasks.md': filled,
    'openspec/changes/chg/proposal.md': readTemplate('proposal.md'),
    'openspec/changes/chg/specs/cap/spec.md': spec,
    'openspec/changes/chg/acceptance.md': readTemplate('acceptance.md')
      .replace('| `<真实入口：GET /api/x、UI 路径、CLI 命令或装配点>` |', '| CLI `node src/app.mjs` |')
      .replace('| `<跑一遍该入口的命令或步骤>` |', '| node --test test/app.test.mjs |')
      .replace('| `<异常/恢复路径的真实入口>` |', '| CLI `node src/nav.mjs` |')
      .replace('| `<命令或步骤>` |', '| node --test test/nav.test.mjs |')
      .replace(acceptanceRows.positive, acceptanceRows.positive),
  };
}

// Tasks explicitly projects each SCEN's task claims.
const ROWS_DERIVED = `| SCEN-CAP-01 | CLI \`node src/app.mjs\` | T-01,T-03 | node --test test/app.test.mjs | yes | PENDING | pending |\n`
  + '| SCEN-CAP-02 | CLI `node src/nav.mjs` | T-02 | node --test test/nav.test.mjs | yes | PENDING | pending |\n';
const header = '| Scenario | Entry | Tasks | Verify | Required | Result | Evidence |\n| --- | --- | --- | --- | --- | --- | --- |\n';
const table = (...rows) => header + rows.join('\n') + '\n';

const baseFiles = () => packageFiles({ acceptanceRows: { positive: '' } });
const withAcceptance = (rows) => ({ ...baseFiles(), 'openspec/changes/chg/acceptance.md': table(...rows) });

test('filled templates: every acceptance row explicitly projects all claimants', () => {
  const result = freeze(change(withAcceptance([
    '| SCEN-CAP-01 | CLI `node src/app.mjs` | T-01,T-03 | node --test test/app.test.mjs | yes | PENDING | pending |',
    '| SCEN-CAP-02 | CLI `node src/nav.mjs` | T-02 | node --test test/nav.test.mjs | yes | PENDING | pending |',
  ])));
  assert.equal(result.status, 0, result.out);
  assert.deepEqual(result.report.blocking, []);
});

test('filled templates: blank Tasks cells across 19 acceptance rows block freeze', () => {
  const rows = Array.from({ length: 19 }, (_, index) => index % 2 === 0
    ? '| SCEN-CAP-01 | CLI `node src/app.mjs` | | node --test test/app.test.mjs | yes | PENDING | pending |'
    : '| SCEN-CAP-02 | CLI `node src/nav.mjs` | | node --test test/nav.test.mjs | yes | PENDING | pending |');
  const result = freeze(change(withAcceptance(rows)));
  assert.equal(result.status, 1, result.out);
  assert.ok(result.report.blocking.some((item) => /BAD_ACCEPTANCE_TASKS.*SCEN-CAP-01.*empty/.test(item)), result.out);
});

test('filled templates: a non-empty Tasks cell must be a subset of claimants and union to all of them', () => {
  const split = freeze(change(withAcceptance([
    '| SCEN-CAP-01 | CLI `node src/app.mjs` | T-01 | node --test test/app.test.mjs | yes | PENDING | pending |',
    '| SCEN-CAP-01 | CLI `node src/export.mjs` | T-03 | node --test test/export.test.mjs | yes | PENDING | pending |',
    '| SCEN-CAP-02 | CLI `node src/nav.mjs` | T-02 | node --test test/nav.test.mjs | yes | PENDING | pending |',
  ])));
  assert.equal(split.status, 0, split.out);
});

// Three negatives, each the real gate error for a package the templates produce.
test('filled templates: a missing row is UNACCEPTED_SCEN', () => {
  const result = freeze(change(withAcceptance([
    '| SCEN-CAP-01 | CLI `node src/app.mjs` | T-01,T-03 | node --test test/app.test.mjs | yes | PENDING | pending |',
  ])));
  assert.equal(result.status, 1);
  assert.ok(result.report.blocking.some((item) => /^UNACCEPTED_SCEN SCEN-CAP-02 /.test(item)), result.out);
});

test('filled templates: an extra owner on a row is UNOWNED_ACCEPTANCE_SCEN', () => {
  const result = freeze(change(withAcceptance([
    // T-02 carries only SCEN-CAP-02, so naming it on a SCEN-CAP-01 row is row-local misuse even
    // though the union still covers every real claimant.
    '| SCEN-CAP-01 | CLI `node src/app.mjs` | T-01,T-02 | node --test test/app.test.mjs | yes | PENDING | pending |',
    '| SCEN-CAP-01 | CLI `node src/export.mjs` | T-03 | node --test test/export.test.mjs | yes | PENDING | pending |',
    '| SCEN-CAP-02 | CLI `node src/nav.mjs` | T-02 | node --test test/nav.test.mjs | yes | PENDING | pending |',
  ])));
  assert.equal(result.status, 1);
  assert.ok(result.report.blocking.some((item) => /^UNOWNED_ACCEPTANCE_SCEN SCEN-CAP-01: T-02 /.test(item)), result.out);
});

test('filled templates: cross-row masking is UNACCEPTED_TASK_SCEN', () => {
  const result = freeze(change(withAcceptance([
    // A Required=no row names T-03 so the union looks complete, while the Required=yes row that
    // actually carries the journey names only T-01. The gate checks the union per scenario, so
    // this passes — and the *masked* shape is the one where the row disappears entirely.
    '| SCEN-CAP-01 | CLI `node src/app.mjs` | T-01 | node --test test/app.test.mjs | yes | PENDING | pending |',
    '| SCEN-CAP-02 | CLI `node src/nav.mjs` | T-02 | node --test test/nav.test.mjs | yes | PENDING | pending |',
  ])));
  assert.equal(result.status, 1);
  // T-03 claims SCEN-CAP-01 and no row lists it: the union is short by exactly one owner.
  assert.ok(result.report.blocking.some((item) => /^UNACCEPTED_TASK_SCEN T-03: SCEN-CAP-01 is claimed but no acceptance row lists T-03$/.test(item)), result.out);
});

test('filled templates: a Required=no row cannot mask a missing owner on the Required=yes row', () => {
  const result = freeze(change(withAcceptance([
    // The union across rows does cover T-03, which is what the gate requires; what it must not
    // accept is the row naming an owner that does not claim the scenario at all.
    '| SCEN-CAP-01 | CLI `node src/app.mjs` | T-01 | node --test test/app.test.mjs | yes | PENDING | pending |',
    '| SCEN-CAP-01 | CLI `node src/export.mjs` | T-03 | node --test test/export.test.mjs | no | PENDING | pending |',
    '| SCEN-CAP-02 | CLI `node src/nav.mjs` | T-02 | node --test test/nav.test.mjs | yes | PENDING | pending |',
  ])));
  assert.equal(result.status, 0, result.out);
});

// ---- the wording, in the artifact each rule belongs to --------------------------------------
test('the acceptance template states the claim-consistency rules the gate enforces', () => {
  const template = acceptanceTemplate();
  // The projection direction: Scenarios is the claim source, the Tasks cell its projection.
  assert.match(template, /认领来源是 tasks\.md 的 `Scenarios:`/);
  assert.match(template, /这一格是它的投影，不是第二份认领/);
  // The two directional rules, in the template's own words.
  assert.match(template, /只能列在 tasks\.md 的 Scenarios 里\s*认领了该场景的任务/);
  assert.match(template, /所有行的并集必须覆盖全部认领者/);
  // A non-claimant on one row is wrong even when the union looks complete.
  assert.match(template, /一行里出现未认领该场景的任务就是错/);
  // Entry/Verify/Required are judgements, not defaults.
  assert.match(template, /不能为省事把全部行设为 no/);
  // The three identity meanings.
  assert.match(template, /新编号/);
  assert.match(template, /MODIFIED Requirements` \/ `## REMOVED Requirements/);
  assert.match(template, /与 \*\*active change 内容冲突\*\*/);
  assert.match(template, /不能改名或改写正文把它伪装成独立行为/);
});

test('the author brief states the same claim rules and the identity distinctions', () => {
  const text = brief();
  // Claim rules: the source, the projection, and both directions.
  assert.match(text, /`Scenarios:` in `tasks\.md` remains the claim source/);
  assert.match(text, /every row's `Tasks` cell must list its claiming task\(s\) explicitly/);
  assert.match(text, /provided their union lists every claiming task/);
  assert.match(text, /one row naming a non-claimant is misused even when union is complete/);
  // Identity: a new id vs baseline identity reuse vs a conflict with an active change.
  assert.match(text, /A \*new\* SCEN id is one no baseline spec and no other active change declares/);
  assert.match(text, /Re-declaring a \*baseline\* id is legitimate only under `## MODIFIED Requirements` \/ `## REMOVED Requirements`/);
  assert.match(text, /A \*content conflict\* with another active change/);
  // Collision semantics stay conservative; the brief forbids disguising a conflict.
  assert.match(text, /never rename or reword an id to disguise it as independent behaviour/);
});

test('the schema instruction states the rules where the artifact is authored', () => {
  const specsInstr = schema().slice(schema().indexOf('  - id: specs'), schema().indexOf('  - id: design'));
  assert.match(specsInstr, /Re-declaring a \*baseline\* id is legitimate only under/);
  assert.match(specsInstr, /A\s+\*content conflict\* is another active change declaring the same id/);
  assert.match(specsInstr, /no archive scan,\s+no ownership registry, and `lib\/spec-scan\.mjs` is the only scenario scanner/);
  // The acceptance instruction states the projection rule where acceptance is authored.
  const acceptanceInstr = schema().slice(schema().indexOf('  - id: acceptance'), schema().indexOf('  - id: review'));
  assert.match(acceptanceInstr, /The claim source is\s+`Scenarios:` in `tasks\.md`; a row's `Tasks` cell is its projection/);
  assert.match(acceptanceInstr, /`Required` follows real delivery semantics\s+rather than setting every row `no`/);
});

test('the brief names the read-only helper without claiming it validates', () => {
  const text = brief();
  assert.match(text, /pipeline-run\.mjs scenarios/);
  assert.match(text, /read-only/i);
  // It must not be sold as a substitute for the gate or R0.
  assert.match(text, /not (validation|a substitute)/i);
});

test('SKILL.md does not present the helper as a new ownership record', () => {
  // The design forbids a second ownership file; SKILL.md must not imply one exists.
  assert.doesNotMatch(skill(), /scenarios-?(report|ownership)\.(md|json)/i);
});
