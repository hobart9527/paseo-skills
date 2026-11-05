import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
function run(dir, flags = ['--skip-signer-check'], env = process.env) {
  const result = spawnSync('node', [path.join(root, 'freeze-check.mjs'), dir, '--json', ...flags], { encoding: 'utf8', env });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, report: safeJson(result.stdout) };
}
const safeJson = (text) => { try { return JSON.parse(text); } catch { return null; } };

function change(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freeze-friction-'));
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
  return dir;
}

const table = (rows) => `| Scenario | Entry | Tasks | Verify | Required | Result | Evidence |\n| --- | --- | --- | --- | --- | --- | --- |\n${rows}`;
const acceptance = table('| SCEN-1 | CLI | T-02 | node -e "0" | yes | PENDING | pending |');
const contract = `- [ ] 1.1 T-01 shared
  - Write scope: src/shared,test/shared.test.mjs
  - Verify with: node --test test/shared.test.mjs
  - Scen: SCEN-1
- [ ] 1.2 T-02 alpha
  - Depends on: T-01
  - Write scope: src/alpha,test/alpha.test.mjs
  - Verify with: node --test test/alpha.test.mjs
  - Scen: SCEN-1
- [ ] 1.3 T-03 beta
  - Depends on: T-01
  - Write scope: src/beta,test/beta.test.mjs
  - Verify with: node --test test/beta.test.mjs
  - Scen: SCEN-1
- [ ] 1.4 T-04 sink
  - Depends on: T-02,T-03
  - Write scope: test/sink.test.mjs
  - Verify with: npm test
  - Scen: SCEN-1`;
const design = '## Impact Inventory\nnone\n';
const REVIEW = 'R0: pass(9b2f4c1e-aaaa-4a2b-8c3d-000000000099@abcdef1)\n';
const files = (tasks = contract) => ({
  'tasks.md': tasks,
  'proposal.md': 'x',
  'design.md': design,
  'acceptance.md': acceptance,
  'specs/a/spec.md': '### Scenario: SCEN-1\n',
  'review.md': REVIEW,
});

// ---- frozen SHA behind main ----

function repoWithHistory(filesMap, { advance = 0 } = {}) {
  const dir = change(filesMap);
  const sh = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  sh('init', '-q', '-b', 'main');
  sh('config', 'user.email', 't@t');
  sh('config', 'user.name', 't');
  sh('add', '.');
  sh('commit', '-qm', 'frozen contract');
  const frozen = sh('rev-parse', 'HEAD');
  // main moves on after the contract was frozen. Plumbing keeps the working tree at the reviewed
  // commit, so the only drift the sign-off check sees is the sign-off file itself.
  const tree = sh('rev-parse', `${frozen}^{tree}`);
  let tip = frozen;
  for (let i = 0; i < advance; i += 1) tip = sh('commit-tree', tree, '-p', tip, '-m', `main moves ${i}`);
  if (advance > 0) sh('update-ref', 'refs/heads/main', tip);
  fs.writeFileSync(path.join(dir, 'review.md'), `R0: pass(hanlin-uuid@${frozen.slice(0, 7)})\n`);
  return { dir, sh, frozen };
}

test('a frozen base behind main is an advisory naming the miss count', () => {
  const { dir } = repoWithHistory(files(), { advance: 3 });
  const result = run(dir);
  const hits = result.report.advisories.filter((item) => item.startsWith('ADVISORY_FROZEN_BEHIND'));
  assert.equal(hits.length, 1, result.report.advisories.join('\n'));
  assert.match(hits[0], /3 commits?|3 commit\(s\)/);
  assert.equal(result.status, 0, 'advisory must not block by default');
});

test('--strict promotes the frozen-behind advisory to a block', () => {
  const { dir } = repoWithHistory(files(), { advance: 2 });
  const result = run(dir, ['--skip-signer-check', '--strict']);
  assert.equal(result.status, 1);
  assert.ok(result.report.blocking.some((item) => item.startsWith('FROZEN_BEHIND_MAIN')));
});

test('an up-to-date frozen base is silent, and a non-repo fixture is skipped', () => {
  const { dir } = repoWithHistory(files(), { advance: 0 });
  const result = run(dir);
  assert.deepEqual(result.report.advisories.filter((item) => item.startsWith('ADVISORY_FROZEN_BEHIND')), []);
  const plain = change(files());
  const nonRepo = run(plain);
  assert.deepEqual(nonRepo.report.advisories.filter((item) => item.startsWith('ADVISORY_FROZEN_BEHIND')), []);
});

// ---- files a test asserts on must have an owning task ----

function repoWithTests(testBody, scopeOverrides = {}) {
  const tasks = contract
    .replace('Write scope: src/shared,test/shared.test.mjs', `Write scope: src/shared,test/shared.test.mjs${scopeOverrides.extra ?? ''}`);
  const dir = change({
    ...files(tasks),
    'scripts/deploy.sh': 'echo deploy\n',
    'test/shared.test.mjs': testBody,
  });
  const sh = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  sh('init', '-q', '-b', 'main');
  sh('config', 'user.email', 't@t'); sh('config', 'user.name', 't');
  sh('add', '.'); sh('commit', '-qm', 'draft');
  const sha = sh('rev-parse', '--short', 'HEAD');
  fs.writeFileSync(path.join(dir, 'review.md'), `R0: pass(hanlin-uuid@${sha})\n`);
  return dir;
}

test('a test asserting on a file outside every Write scope blocks and names both', () => {
  const dir = repoWithTests("import fs from 'node:fs';\nfs.readFileSync('scripts/deploy.sh');\n");
  const result = run(dir);
  assert.equal(result.status, 1);
  const hit = result.report.blocking.find((item) => item.startsWith('TEST_FILE_UNOWNED'));
  assert.ok(hit, result.report.blocking.join('\n'));
  assert.match(hit, /scripts\/deploy\.sh/);
  assert.match(hit, /test\/shared\.test\.mjs/);
});

test('the referenced file is accepted when a task owns it, and relative imports resolve', () => {
  const owned = repoWithTests("import fs from 'node:fs';\nfs.readFileSync('scripts/deploy.sh');\n", { extra: ',scripts/deploy.sh' });
  assert.equal(run(owned).status, 0, run(owned).report?.blocking?.join('\n'));
  const sibling = repoWithTests("import { x } from './helper.mjs';\nx();\n");
  // `helper.mjs` resolves beside the test only if it exists; a missing file is not a claim.
  assert.equal(run(sibling).status, 0);
});

test('a test asserting on its own sibling test file needs no extra scope', () => {
  const dir = repoWithTests("import fs from 'node:fs';\nfs.readFileSync('test/alpha.test.mjs');\n", { extra: ',test/alpha.test.mjs' });
  assert.equal(run(dir).status, 0);
});

// ---- R0 anchor-drift guidance ----

test('the reviewer brief treats path:line-only anchor drift as non-blocking NITs', () => {
  const reviewer = fs.readFileSync(path.join(root, 'templates', 'reviewer.md'), 'utf8');
  assert.match(reviewer, /anchor drift is not a blocker|pure anchor[- ]drift/i);
  assert.match(reviewer, /NIT/);
  assert.match(reviewer, /proofread/i);
});

test('ordinary setup imports do not imply ownership but explicit file reads do', () => {
  const dir = repoWithTests("import '../test/setup.mjs';\n");
  fs.writeFileSync(path.join(dir, 'test/setup.mjs'), 'export const setup = true;\n');
  assert.ok(!run(dir).report.blocking.some((s) => s.startsWith('TEST_FILE_UNOWNED')));
  fs.writeFileSync(path.join(dir, 'test/shared.test.mjs'), "import fs from 'node:fs';\nfs.readFileSync('test/setup.mjs');\n");
  assert.ok(run(dir).report.blocking.some((s) => s.startsWith('TEST_FILE_UNOWNED')));
});

test('impact inventory does not treat encoding or scenario IDs as task IDs', () => {
  const dir = change({ ...files(), 'design.md': `${design}\nUTF-8 and SCEN-CAP-01\n` });
  assert.ok(!run(dir).report.blocking.some((s) => s.startsWith('IMPACT_UNKNOWN_TASK')));
});

test('scenario headings inside fenced examples do not declare scenarios', () => {
  const dir = change({ ...files(), 'specs/a/spec.md': '### Scenario: SCEN-1\n```md\n### Scenario: SCEN-FAKE\n```\n' });
  assert.ok(!run(dir).report.blocking.some((s) => s.includes('SCEN-FAKE')));
});

test('an inspector source path does not count as test verification', () => {
  const tasks = contract.replace('Write scope: src/shared,test/shared.test.mjs', 'Write scope: src/shared,test/shared.test.mjs,src/inspector.mjs').replace('node --test test/shared.test.mjs', 'node src/inspector.mjs');
  const result = run(change(files(tasks)));
  assert.ok(result.report.blocking.some((s) => s.startsWith('VERIFY_NOT_NARROW T-01')));
});

test('duplicate scenario declarations are reported', () => {
  const dir = change({ ...files(), 'specs/b/spec.md': '### Scenario: SCEN-1\n' });
  assert.ok(run(dir).report.blocking.some((s) => s.includes('DUPLICATE_SCEN')));
});

test('impact unknown task retains arbitrary task prefixes', () => {
  const dir = change({ ...files(), 'design.md': `${design}\nfoo() -> TASK-7\n` });
  assert.ok(run(dir).report.blocking.some((s) => s.startsWith('IMPACT_UNKNOWN_TASK TASK-7')));
});

test('scenario scan ignores HTML comments, preserves real duplicates and unclosed fences', () => {
  const dir = change({ ...files(), 'specs/a/spec.md': '<!--\n### Scenario: SCEN-COMMENT\n-->\n### Scenario: SCEN-1\n~~~md\n### Scenario: SCEN-FENCED\n' });
  const result = run(dir);
  assert.ok(!result.report.blocking.some((s) => /SCEN-(COMMENT|FENCED)/.test(s)));
  fs.writeFileSync(path.join(dir, 'specs/a/spec.md'), '<!-- ### Scenario: SCEN-FAKE -->\n### Scenario: SCEN-1\n<!-- comment -->\n### Scenario: SCEN-1\n');
  const duplicate = run(dir, ['--skip-signer-check', '--explain']);
  assert.ok(duplicate.report.blocking.some((s) => s.startsWith('DUPLICATE_SCEN')));
  assert.match(duplicate.report.explanations.find((e) => e.code === 'DUPLICATE_SCEN').fix, /unique|duplicate/i);
});

test('verify rejects fixture data but accepts a scoped test runner script', () => {
  const base = contract.replace('Write scope: src/shared,test/shared.test.mjs', 'Write scope: src/shared,test/shared.test.mjs,test/fixtures/input.json,scripts/test.sh');
  const data = run(change(files(base.replace('node --test test/shared.test.mjs', 'cat test/fixtures/input.json'))));
  assert.ok(data.report.blocking.some((s) => s.startsWith('VERIFY_NOT_NARROW T-01')));
  const runner = run(change(files(base.replace('node --test test/shared.test.mjs', 'bash scripts/test.sh'))));
  assert.ok(!runner.report.blocking.some((s) => s.startsWith('VERIFY_NOT_NARROW T-01')));
});

test('scenario scan closes only matching bare fences and handles inline comments', () => {
  const spec = '<!-- fake -->\n### Scenario: SCEN-1\n````md\n```\n### Scenario: SCEN-HIDDEN\n```` trailing\n### Scenario: SCEN-STILL-HIDDEN\n````\n<!--\n```\n-->\n';
  const result = run(change({ ...files(), 'specs/a/spec.md': spec }));
  assert.ok(!result.report.blocking.some((s) => /SCEN-(HIDDEN|STILL-HIDDEN)/.test(s)));
});

test('fixture filenames and script arguments cannot masquerade as verification', () => {
  const base = contract.replace('Write scope: src/shared,test/shared.test.mjs', 'Write scope: src/shared,test/shared.test.mjs,test/fixtures/input.json,scripts/test.sh');
  for (const cmd of ['cat scripts/test.sh', 'cat test/fixtures/input.json']) {
    const result = run(change(files(base.replace('node --test test/shared.test.mjs', cmd))));
    assert.ok(result.report.blocking.some((s) => s.startsWith('VERIFY_NOT_NARROW T-01')), cmd);
  }
});

test('side-effect import syntax alone cannot prove whether unowned code is a fixture or the subject', () => {
  const body = "import '../test/setup.mjs';\n";
  for (const content of ['globalThis.testEnvironment = true;\n', 'globalThis.observedBehavior = true;\n']) {
    const dir = repoWithTests(body);
    fs.writeFileSync(path.join(dir, 'test/setup.mjs'), content);
    assert.ok(!run(dir).report.blocking.some((s) => s.startsWith('TEST_FILE_UNOWNED')));
  }
});

// ---- review blockers on 8e9c65f ----

test('an import earlier on the line does not hide an explicit read of an unowned file', () => {
  const dir = repoWithTests("import fs from 'node:fs'; fs.readFileSync('test/setup.mjs');\n");
  fs.writeFileSync(path.join(dir, 'test/setup.mjs'), 'export const setup = true;\n');
  assert.ok(run(dir).report.blocking.some((s) => s.startsWith('TEST_FILE_UNOWNED') && /test\/setup\.mjs/.test(s)));
});

test('a multiline import specifier on the next line is still an import, not a claim', () => {
  const dir = repoWithTests("import fs from\n  './setup.mjs';\nexport {\n  y } from\n  './setup.mjs';\nvoid fs;\n");
  fs.writeFileSync(path.join(dir, 'test/setup.mjs'), 'export const y = true;\n');
  assert.ok(!run(dir).report.blocking.some((s) => s.startsWith('TEST_FILE_UNOWNED')), run(dir).report.blocking.join('\n'));
});

test('a test-named file under fixtures/ or a fixtures script cannot satisfy Verify', () => {
  const extra = 'Write scope: src/shared,test/shared.test.mjs,test/fixtures,test/unit,test/run-all.sh';
  const base = contract.replace('Write scope: src/shared,test/shared.test.mjs', extra);
  const verdict = (cmd) => run(change(files(base.replace('node --test test/shared.test.mjs', cmd)))).report.blocking.some((s) => s.startsWith('VERIFY_NOT_NARROW T-01'));
  assert.ok(verdict('node --test test/fixtures/foo.test.mjs'));
  assert.ok(verdict('bash test/fixtures/test.sh'));
  assert.ok(!verdict('node --test test/unit/a.test.mjs'));
  assert.ok(!verdict('bash test/run-all.sh'));
});

test('a comment opener on a fence-opening line cannot swallow a later duplicate scenario', () => {
  const spec = '### Scenario: SCEN-1\n```html <!--\nx\n```\n### Scenario: SCEN-1\n';
  const result = run(change({ ...files(), 'specs/a/spec.md': spec }));
  assert.ok(result.report.blocking.some((s) => s.startsWith('DUPLICATE_SCEN SCEN-1')), result.report.blocking.join('\n'));
  const plain = run(change({ ...files(), 'specs/a/spec.md': '### Scenario: SCEN-1\n<!--\nnote\n-->\n### Scenario: SCEN-1\n' }));
  assert.ok(plain.report.blocking.some((s) => s.startsWith('DUPLICATE_SCEN SCEN-1')));
});

test('impact inventory ignores UTF-16 style tokens but still flags real unknown task ids', () => {
  const clean = change({ ...files(), 'design.md': `${design}\nUTF-16, UTF-32, SHA-256 and ISO-8601 are plain prose\n` });
  assert.ok(!run(clean).report.blocking.some((s) => s.startsWith('IMPACT_UNKNOWN_TASK')));
  const bad = change({ ...files(), 'design.md': `${design}\nUTF-16 and T-99\n` });
  const hits = run(bad).report.blocking.filter((s) => s.startsWith('IMPACT_UNKNOWN_TASK'));
  assert.deepEqual(hits.map((s) => s.split(':')[0]), ['IMPACT_UNKNOWN_TASK T-99']);
});
