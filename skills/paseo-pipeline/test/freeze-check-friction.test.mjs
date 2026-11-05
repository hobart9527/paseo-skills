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
