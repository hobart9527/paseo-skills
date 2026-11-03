import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../merge-task.mjs', import.meta.url));
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
// `node --test` refuses to run nested files when this leaks in from the outer run.
delete env.NODE_TEST_CONTEXT;

// Recorded shape of real `paseo ls --all --json`: full UUID `id`, 7-char `shortId`,
// and `provider` packing "provider/model" into one string.
const TESTER = '9b2f4c1e-1111-4a2b-8c3d-000000000001';
const WRITER = '9b2f4c1e-2222-4a2b-8c3d-000000000002';
const REVIEWER = '9b2f4c1e-3333-4a2b-8c3d-000000000003';
const REVIEWER_SHORT = '9b2f4c3';
const AGENTS = JSON.stringify([
  { id: TESTER, shortId: '9b2f4c1', provider: 'codex/gpt' },
  { id: WRITER, shortId: '9b2f4c2', provider: 'claude/flash' },
  { id: REVIEWER, shortId: REVIEWER_SHORT, provider: 'claude/cc' },
]);
function installPaseo(cwd, agents = AGENTS, inspect = null) {
  const bin = path.join(os.tmpdir(), `merge-bin-${path.basename(cwd)}`);
  fs.mkdirSync(bin, { recursive: true });
  const payload = Buffer.from(typeof agents === 'string' ? agents : JSON.stringify(agents)).toString('base64');
  // `ls` replays the recorded sample; `inspect <id>` covers agents that `ls` omits
  // (it caps at 100 entries and hides some archived ones). `inspect` may be pinned to
  // a fixed payload to exercise archived-agent identity checks.
  const inspectCmd = inspect
    ? `printf '%s' '${JSON.stringify(inspect)}'`
    : `printf '{"Id":"%s","Provider":"codex","Model":"gpt"}' "$2"`;
  const exe = path.join(bin, 'paseo');
  fs.writeFileSync(exe, `#!/bin/sh\nif [ "$1" = inspect ]; then ${inspectCmd}; else printf '%s' '${payload}' | base64 -d; fi\nprintf '\\n'\n`);
  fs.chmodSync(exe, 0o755);
  return { ...env, PATH: `${bin}:${process.env.PATH}` };
}
function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}
function write(cwd, file, text) {
  const p = path.join(cwd, file);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

// A behavioural Red: the test file loads, runs, and fails on its assertion.
const RED_TEST = `import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
test('behavior', () => { assert.equal(fs.existsSync('src/a.txt'), true); });
`;
const GREEN = 'node --test test/a.test.mjs';
let seq = 0;

function fixture({ outside = false, verify = GREEN, baseFiles = {} } = {}) {
  const change = `c${++seq}`;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-'));
  git(cwd, 'init', '-q', '-b', 'main');
  write(cwd, `openspec/changes/${change}/tasks.md`, `- [ ] 1.1 T-01 task\n  - Write scope: src,test\n  - Verify with: ${verify}\n`);
  write(cwd, `openspec/changes/${change}/proposal.md`, 'p\n');
  write(cwd, `openspec/changes/${change}/acceptance.md`, 'a\n');
  for (const [file, text] of Object.entries(baseFiles)) write(cwd, file, text);
  git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'base'); git(cwd, 'switch', '-qc', `integration/${change}`);
  const base = git(cwd, 'rev-parse', 'HEAD'); git(cwd, 'switch', '-qc', `task/${change}/T-01`);
  write(cwd, 'test/a.test.mjs', RED_TEST); git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', `red tests\n\nPipeline-Role: ceshi\nPipeline-Author: ${TESTER}`);
  write(cwd, outside ? 'outside.txt' : 'src/a.txt', 'a'); git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', `work\n\nPipeline-Role: gongbu\nPipeline-Author: ${WRITER}`);
  const tip = git(cwd, 'rev-parse', 'HEAD'); git(cwd, 'switch', '-q', `integration/${change}`);
  installPaseo(cwd);
  return { cwd, change, base, tip };
}
function invoke(cwd, args, agents, inspect = null) {
  const r = spawnSync('node', [script, ...args], { cwd, env: installPaseo(cwd, agents, inspect), encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}
const passTag = (tip, base, reviewer = REVIEWER) => `pass(${reviewer}@${tip.slice(0, 7)}/${base.slice(0, 7)})`;
const tag = (f) => passTag(f.tip, f.base);
function taggedFixture(tasks) {
  const change = `c${++seq}`;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-'));
  git(cwd, 'init', '-q', '-b', 'main');
  write(cwd, `openspec/changes/${change}/tasks.md`, tasks);
  write(cwd, `openspec/changes/${change}/proposal.md`, 'p');
  write(cwd, `openspec/changes/${change}/acceptance.md`, 'a');
  git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'base'); git(cwd, 'switch', '-qc', `integration/${change}`);
  const base = git(cwd, 'rev-parse', 'HEAD'); git(cwd, 'switch', '-qc', `task/${change}/T-01`);
  if (!tasks.includes('Review: mechanical')) {
    write(cwd, 'test/a.test.mjs', RED_TEST); git(cwd, 'add', 'test');
    git(cwd, 'commit', '-qm', `red tests\n\nPipeline-Role: ceshi\nPipeline-Author: ${TESTER}`);
  }
  installPaseo(cwd);
  return { cwd, change, base };
}

test('merges valid task and records Done', () => {
  const f = fixture(); const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', tag(f)]);
  assert.equal(r.status, 0, r.out);
  assert.match(fs.readFileSync(path.join(f.cwd, `openspec/changes/${f.change}/tasks.md`), 'utf8'), /\[x\][^\n]*T-01[^\n]*\n\s*- Done:/);
});
test('accepts a reviewer named by 7-char shortId (paseo shortId shape)', () => {
  const f = fixture(); const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', passTag(f.tip, f.base, REVIEWER_SHORT)]);
  assert.equal(r.status, 0, r.out);
});
test('resolves an author missing from `paseo ls` via `paseo inspect`', () => {
  const f = fixture();
  const partial = JSON.stringify([{ id: REVIEWER, shortId: REVIEWER_SHORT, provider: 'claude/cc' }]);
  const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', tag(f)], partial);
  // inspect reports codex/gpt for both authors, so the model split is genuinely gone.
  assert.equal(r.status, 32, r.out);
  assert.match(r.out, /different models/);
});
test('rejects scope violation', () => {
  const f = fixture({ outside: true }); const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', tag(f)]);
  assert.equal(r.status, 30, r.out);
});
test('rejects reviewer equals author', () => {
  const f = fixture(); const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', passTag(f.tip, f.base, WRITER)]);
  assert.equal(r.status, 32, r.out);
});
test('rejects reviewer shortId that resolves to an author', () => {
  const f = fixture(); const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', passTag(f.tip, f.base, '9b2f4c2')]);
  assert.equal(r.status, 32, r.out);
  assert.match(r.out, /reviewer matches a task author/);
});

test('rejects test author and implementer using same Paseo model', () => {
  const f = fixture();
  const sameModel = JSON.stringify([
    { id: TESTER, shortId: '9b2f4c1', provider: 'codex/gpt' },
    { id: WRITER, shortId: '9b2f4c2', provider: 'codex/gpt' },
    { id: REVIEWER, shortId: REVIEWER_SHORT, provider: 'claude/cc' },
  ]);
  const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', tag(f)], sameModel);
  assert.equal(r.status, 32, r.out);
  assert.match(r.out, /different models/);
});

test('rejects unresolved author identity/model', () => {
  const f = fixture();
  // Neither `ls` nor `inspect` can resolve the ids.
  const bin = path.join(os.tmpdir(), `merge-bin-${path.basename(f.cwd)}`);
  fs.writeFileSync(path.join(bin, 'paseo'), '#!/bin/sh\nexit 1\n');
  fs.chmodSync(path.join(bin, 'paseo'), 0o755);
  const r = spawnSync('node', [script, `task/${f.change}/T-01`, 'T-01', tag(f)], { cwd: f.cwd, env: { ...env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });
  assert.equal(r.status, 32, `${r.stdout}${r.stderr}`);
  assert.match(`${r.stdout}${r.stderr}`, /cannot resolve/);
});
test('rejects failed frozen verify', () => {
  const f = fixture({ verify: 'node --test test/does-not-exist.test.mjs' });
  const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', tag(f)]);
  assert.equal(r.status, 33, r.out);
});

test('reports a worktree with no dependencies as exit 36, not a failing test', () => {
  // Recorded real output: a linked worktree has no node_modules, so `node --import tsx`
  // dies before the test runs. That must not be blamed on the task (exit 33/20).
  const f = fixture({ verify: 'node --import tsx --test test/a.test.mjs' });
  const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', tag(f)]);
  assert.equal(r.status, 36, r.out);
  assert.match(r.out, /cannot resolve "tsx"/);
  assert.match(r.out, /not a test failure/);
  assert.match(r.out, /Do not edit tests/);
  assert.equal(git(f.cwd, 'status', '--porcelain'), '');
});
test('reports a missing runner command as exit 36 as well', () => {
  const f = fixture({ verify: 'tsx --test test/a.test.mjs' });
  const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', tag(f)]);
  assert.equal(r.status, 36, r.out);
  assert.match(r.out, /cannot resolve "tsx"/);
});
test('reports a missing dependency-local binary as exit 36 as well', () => {
  // Real shape when the runner is installed in the repo and the directory is absent.
  const f = fixture({ verify: 'node_modules/.bin/vitest run test/a.test.mjs' });
  const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', tag(f)]);
  assert.equal(r.status, 36, r.out);
  assert.match(r.out, /cannot resolve "node_modules"/);
});
test('green Verify that dies with exit 1 on a missing package is exit 36, not 20', () => {
  // Red stops at the failing assertion; on Green the tests pass and the next leg hits an uninstalled package.
  const f = fixture({ verify: `node --test test/a.test.mjs && node --input-type=module -e "import 'nopkg-xyz'"` });
  const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', tag(f)]);
  assert.equal(r.status, 36, r.out);
  assert.match(r.out, /cannot resolve "nopkg-xyz"/);
  assert.equal(git(f.cwd, 'status', '--porcelain'), '');
});
test('failed verify leaves integration clean and allows retry', () => {
  const tasks = `- [ ] T-01 work\n  - Write scope: src,test\n  - Verify with: node --test test/a.test.mjs\n`;
  const f = taggedFixture(tasks);
  write(f.cwd, 'src/a.txt', 'a');
  git(f.cwd, 'add', 'src/a.txt'); git(f.cwd, 'commit', '-qm', `work\n\nPipeline-Role: gongbu\nPipeline-Author: ${WRITER}`);
  const tip = git(f.cwd, 'rev-parse', 'HEAD'); git(f.cwd, 'switch', '-q', `integration/${f.change}`);
  const first = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', passTag(tip, f.base)]);
  assert.equal(first.status, 0, first.out);
  // Re-running an already-Done task is refused rather than re-merged.
  const again = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', passTag(tip, f.base)]);
  assert.equal(again.status, 1, again.out);
  assert.match(again.out, /already Done/);
  assert.equal(git(f.cwd, 'status', '--porcelain'), '');
});
test('marks exact task ID, not substring ID', () => {
  const tasks = `- [ ] T-010 other\n  - Write scope: other\n  - Review: mechanical\n  - Verify with: true\n- [ ] T-01 target\n  - Write scope: src,test\n  - Verify with: ${GREEN}\n`;
  const f = taggedFixture(tasks);
  write(f.cwd, 'test/a.test.mjs', RED_TEST); git(f.cwd, 'add', 'test');
  git(f.cwd, 'commit', '-qm', `red\n\nPipeline-Role: ceshi\nPipeline-Author: ${TESTER}`);
  write(f.cwd, 'src/a.txt', 'target');
  git(f.cwd, 'add', 'src/a.txt'); git(f.cwd, 'commit', '-qm', `target\n\nPipeline-Role: gongbu\nPipeline-Author: ${WRITER}`);
  const tip = git(f.cwd, 'rev-parse', 'HEAD'); git(f.cwd, 'switch', '-q', `integration/${f.change}`);
  const result = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', passTag(tip, f.base)]);
  assert.equal(result.status, 0, result.out);
  const text = fs.readFileSync(path.join(f.cwd, `openspec/changes/${f.change}/tasks.md`), 'utf8');
  assert.match(text, /^- \[ \] T-010 other[\s\S]*?- \[x\] T-01 target/m);
  assert.doesNotMatch(text, /- \[x\] T-010/);
});
test('accepts unquoted review tag as a shell argument', () => {
  const f = fixture();
  const direct = spawnSync('node', [script, `task/${f.change}/T-01`, 'T-01', tag(f)], { cwd: f.cwd, env: installPaseo(f.cwd), encoding: 'utf8' });
  assert.equal(direct.status, 0, direct.stdout + direct.stderr);
});

function build(commits, { review } = {}) {
  const tasks = `- [ ] T-01 task\n  - Write scope: src,test\n${review ? `  - Review: ${review}\n` : ''}  - Verify with: ${review ? 'true' : GREEN}\n`;
  const f = taggedFixture(tasks);
  if (!review) git(f.cwd, 'reset', '-q', '--hard', f.base); // drop default tester commit; commits define history
  for (const [file, text, role, author] of commits) {
    write(f.cwd, file, text); git(f.cwd, 'add', '.');
    git(f.cwd, 'commit', '-qm', `c\n\nPipeline-Role: ${role}\nPipeline-Author: ${author}`);
  }
  const tip = git(f.cwd, 'rev-parse', 'HEAD'); git(f.cwd, 'switch', '-q', `integration/${f.change}`);
  return { ...f, tip };
}
const run3 = (f, reviewer = REVIEWER) => invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', passTag(f.tip, f.base, reviewer)]);

test('rejects when test author and implementer are the same agent', () => {
  const agents = JSON.stringify([
    { id: WRITER, shortId: '9b2f4c2', provider: 'codex/gpt' },
    { id: REVIEWER, shortId: REVIEWER_SHORT, provider: 'claude/cc' },
  ]);
  const f = build([['test/a.test.mjs', RED_TEST, 'ceshi', WRITER], ['src/a.txt', 'a', 'gongbu', WRITER]]);
  const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', passTag(f.tip, f.base)], agents);
  assert.equal(r.status, 32, r.out); assert.match(r.out, /different agents/);
});
test('rejects implementer modifying test-author files', () => {
  const f = build([['test/a.test.mjs', RED_TEST, 'ceshi', TESTER], ['test/a.test.mjs', 'edited', 'gongbu', WRITER]]);
  const r = run3(f); assert.equal(r.status, 30, r.out); assert.match(r.out, /modifies test-author files/);
});
test('rejects test author changing non-test paths', () => {
  const f = build([['src/a.txt', 'a', 'ceshi', TESTER], ['src/b.txt', 'b', 'gongbu', WRITER]]);
  const r = run3(f); assert.equal(r.status, 30, r.out); assert.match(r.out, /non-test files/);
});
test('rejects reviewer sharing implementer model', () => {
  const agents = JSON.stringify([
    { id: TESTER, shortId: '9b2f4c1', provider: 'codex/gpt' },
    { id: WRITER, shortId: '9b2f4c2', provider: 'claude/flash' },
    { id: REVIEWER, shortId: REVIEWER_SHORT, provider: 'claude/flash' },
  ]);
  const f = build([['test/a.test.mjs', RED_TEST, 'ceshi', TESTER], ['src/a.txt', 'a', 'gongbu', WRITER]]);
  const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', passTag(f.tip, f.base)], agents);
  assert.equal(r.status, 32, r.out); assert.match(r.out, /reviewer and implementer must use different models/);
});
test('rejects behavior task lacking ceshi commit', () => {
  const f = build([['src/a.txt', 'a', 'gongbu', WRITER]]);
  const r = run3(f); assert.equal(r.status, 31, r.out);
});
test('mechanical task is exempt from tester and model checks', () => {
  const f = build([['src/a.txt', 'a', 'gongbu', WRITER]], { review: 'mechanical' });
  const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', `pass(mechanical@${f.tip.slice(0, 7)}/${f.base.slice(0, 7)})`], []);
  assert.equal(r.status, 0, r.out);
});

// ---- deferred review ----
function deferredFixture() {
  const change = `c${++seq}`;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-'));
  git(cwd, 'init', '-q', '-b', 'main');
  write(cwd, `openspec/changes/${change}/tasks.md`, `- [ ] 1.1 T-01 task\n  - Write scope: src,test\n  - Review: deferred\n  - Verify with: ${GREEN}\n`);
  write(cwd, `openspec/changes/${change}/proposal.md`, 'p\n');
  write(cwd, `openspec/changes/${change}/acceptance.md`, 'a\n');
  git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'base'); git(cwd, 'switch', '-qc', `integration/${change}`);
  const base = git(cwd, 'rev-parse', 'HEAD'); git(cwd, 'switch', '-qc', `task/${change}/T-01`);
  write(cwd, 'test/a.test.mjs', RED_TEST); git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', `red tests\n\nPipeline-Role: ceshi\nPipeline-Author: ${TESTER}`);
  write(cwd, 'src/a.txt', 'a'); git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', `work\n\nPipeline-Role: gongbu\nPipeline-Author: ${WRITER}`);
  const tip = git(cwd, 'rev-parse', 'HEAD'); git(cwd, 'switch', '-q', `integration/${change}`);
  installPaseo(cwd);
  return { cwd, change, base, tip };
}

test('deferred task merges on pass(deferred@tip/base) without a per-task reviewer', () => {
  const f = deferredFixture();
  const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', passTag(f.tip, f.base, 'deferred')]);
  assert.equal(r.status, 0, r.out);
  assert.match(fs.readFileSync(path.join(f.cwd, `openspec/changes/${f.change}/tasks.md`), 'utf8'), /- Done: source=[0-9a-f]{7,40} review=pass\(deferred@/);
});

test('deferred tag is refused on a standard task and a real reviewer is refused on a deferred task', () => {
  const standard = fixture();
  const wrong = invoke(standard.cwd, [`task/${standard.change}/T-01`, 'T-01', passTag(standard.tip, standard.base, 'deferred')]);
  assert.equal(wrong.status, 32, wrong.out);
  assert.match(wrong.out, /deferred review tag requires Review: deferred/);

  const deferred = deferredFixture();
  const real = invoke(deferred.cwd, [`task/${deferred.change}/T-01`, 'T-01', passTag(deferred.tip, deferred.base)]);
  assert.equal(real.status, 32, real.out);
  assert.match(real.out, /Review: deferred and must merge on pass\(deferred@/);
});

// ---- Uses is a merge edge ----
test('Uses target must be Done before the consumer merges (exit 35)', () => {
  const tasks = `- [ ] T-00 producer
  - Write scope: src/producer
  - Kind: skeleton
  - Interface: src/producer/api.ts#run
  - Review: mechanical
  - Verify with: true
- [ ] T-01 consumer
  - Uses: T-00
  - Write scope: src,test
  - Verify with: ${GREEN}
`;
  const f = taggedFixture(tasks);
  const tip = git(f.cwd, 'rev-parse', 'HEAD');
  git(f.cwd, 'switch', '-q', `integration/${f.change}`);
  const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', passTag(tip, f.base)]);
  assert.equal(r.status, 35, r.out);
  assert.match(r.out, /T-01 Uses T-00 is not Done/);
});

// ---- cherry-pick provenance ----
const FAKE = '9b2f4c1e-9999-4a2b-8c3d-000000000009';
const provenanceTasks = `- [ ] T-01 work
  - Write scope: src,test
  - Verify with: ${GREEN}
`;
function provenanceFixture() {
  const f = taggedFixture(provenanceTasks);
  git(f.cwd, 'switch', '-qc', 'original', f.base);
  write(f.cwd, 'src/a.txt', 'a');
  git(f.cwd, 'add', 'src/a.txt');
  git(f.cwd, 'commit', '-qm', `work\n\nPipeline-Role: gongbu\nPipeline-Author: ${WRITER}`);
  const original = git(f.cwd, 'rev-parse', 'HEAD');
  git(f.cwd, 'switch', '-q', `task/${f.change}/T-01`);
  return { ...f, original };
}
const provenanceTip = (cwd, change) => {
  const tip = git(cwd, 'rev-parse', 'HEAD');
  git(cwd, 'switch', '-q', `integration/${change}`);
  return tip;
};

test('clean cherry-pick -x is accepted: marker, patch-id and author trailers agree', () => {
  const f = provenanceFixture();
  git(f.cwd, 'cherry-pick', '-x', f.original);
  const tip = provenanceTip(f.cwd, f.change);
  const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', passTag(tip, f.base)]);
  assert.equal(r.status, 0, r.out);
});

test('hand-recreated commit with the same patch but a different author is exit 31', () => {
  const f = provenanceFixture();
  write(f.cwd, 'src/a.txt', 'a');
  git(f.cwd, 'add', 'src/a.txt');
  git(f.cwd, 'commit', '-qm', `work\n\nPipeline-Role: gongbu\nPipeline-Author: ${FAKE}`);
  const tip = provenanceTip(f.cwd, f.change);
  const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', passTag(tip, f.base)]);
  assert.equal(r.status, 31, r.out);
  assert.match(r.out, /restates .*Pipeline-Author differs.*cherry-pick -x/);
});

test('cherry-pick marker whose author trailers disagree with the source is exit 31', () => {
  const f = provenanceFixture();
  git(f.cwd, 'cherry-pick', '-x', f.original);
  git(f.cwd, 'commit', '--amend', '-qm', `work\n\nPipeline-Role: gongbu\nPipeline-Author: ${FAKE}\n(cherry picked from commit ${f.original})`);
  const tip = provenanceTip(f.cwd, f.change);
  const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', passTag(tip, f.base)]);
  assert.equal(r.status, 31, r.out);
  assert.match(r.out, /cherry-pick Pipeline-Author .* differs from/);
});

test('warns when reviewer shares model with test author but still merges', () => {
  const agents = JSON.stringify([
    { id: TESTER, shortId: '9b2f4c1', provider: 'codex/gpt' },
    { id: WRITER, shortId: '9b2f4c2', provider: 'claude/flash' },
    { id: REVIEWER, shortId: REVIEWER_SHORT, provider: 'codex/gpt' },
  ]);
  const f = build([['test/a.test.mjs', RED_TEST, 'ceshi', TESTER], ['src/a.txt', 'a', 'gongbu', WRITER]]);
  const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', passTag(f.tip, f.base)], agents);
  assert.equal(r.status, 0, r.out); assert.match(r.out, /WARN reviewer shares model/);
});

test('rejects merge that regresses an already-Done task (exit 21) and leaves tree clean', () => {
  // The prior task asserts its own invariant: a generated file must never exist.
  // Once the target task adds that file, replaying the prior leg must go red.
  const tasks = '- [x] T-00 prior\n  - Write scope: test/prior.test.mjs\n  - Review: mechanical\n  - Verify with: node --test test/prior.test.mjs\n  - Done: source=abcdef1 review=pass(mechanical@abcdef1/abcdef1)\n- [ ] T-01 target\n  - Write scope: src,test\n  - Verify with: node --test test/a.test.mjs\n';
  const f = taggedFixture(tasks);
  write(f.cwd, 'test/prior.test.mjs', `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport fs from 'node:fs';\ntest('legacy', () => { assert.equal(fs.existsSync('src/poison.txt'), false); });\n`);
  write(f.cwd, 'test/a.test.mjs', RED_TEST); git(f.cwd, 'add', 'test');
  git(f.cwd, 'commit', '-qm', `red\n\nPipeline-Role: ceshi\nPipeline-Author: ${TESTER}`);
  write(f.cwd, 'src/a.txt', 'a'); write(f.cwd, 'src/poison.txt', 'x'); git(f.cwd, 'add', 'src');
  git(f.cwd, 'commit', '-qm', `w\n\nPipeline-Role: gongbu\nPipeline-Author: ${WRITER}`);
  const tip = git(f.cwd, 'rev-parse', 'HEAD'); git(f.cwd, 'switch', '-q', `integration/${f.change}`);
  const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', passTag(tip, f.base)]);
  assert.equal(r.status, 21, r.out); assert.match(r.out, /regress already-Done T-00/);
  assert.equal(git(f.cwd, 'status', '--porcelain'), '');
});

test('rejects when Verify already passes on the test-author commit (no Red)', () => {
  const f = build([['test/a.test.mjs', RED_TEST, 'ceshi', TESTER], ['src/a.txt', 'a', 'gongbu', WRITER]]);
  git(f.cwd, 'switch', '-q', 'main');
  const tasksPath = `openspec/changes/${f.change}/tasks.md`;
  git(f.cwd, 'switch', '-q', `integration/${f.change}`);
  fs.writeFileSync(path.join(f.cwd, tasksPath), fs.readFileSync(path.join(f.cwd, tasksPath), 'utf8').replace(/Verify with: .*/, 'Verify with: true'));
  git(f.cwd, 'add', '.'); git(f.cwd, 'commit', '-qm', 'always-green verify');
  git(f.cwd, 'switch', '-q', `task/${f.change}/T-01`); git(f.cwd, 'rebase', '-q', `integration/${f.change}`);
  const tip = git(f.cwd, 'rev-parse', 'HEAD'); git(f.cwd, 'switch', '-q', `integration/${f.change}`);
  const base = git(f.cwd, 'rev-parse', 'HEAD');
  const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', passTag(tip, base)]);
  assert.equal(r.status, 33, r.out); assert.match(r.out, /Red check/);
  assert.equal(git(f.cwd, 'status', '--porcelain'), '');
});
test('rejects Red proof that fails only by loading the test file (exit 33)', () => {
  // A broken test file "goes red" without exercising any behavior. merge-task must
  // not accept that as TDD proof; the tester brief already forbids it.
  const change = `c${++seq}`;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-'));
  git(cwd, 'init', '-q', '-b', 'main');
  write(cwd, `openspec/changes/${change}/tasks.md`, `- [ ] 1.1 T-01 task\n  - Write scope: src,test\n  - Verify with: ${GREEN}\n`);
  write(cwd, `openspec/changes/${change}/proposal.md`, 'p\n');
  write(cwd, `openspec/changes/${change}/acceptance.md`, 'a\n');
  git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'base'); git(cwd, 'switch', '-qc', `integration/${change}`);
  const base = git(cwd, 'rev-parse', 'HEAD'); git(cwd, 'switch', '-qc', `task/${change}/T-01`);
  write(cwd, 'test/a.test.mjs', 'import test from "node:test";\ntest("broken", () => { ;\n');
  git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', `red\n\nPipeline-Role: ceshi\nPipeline-Author: ${TESTER}`);
  write(cwd, 'src/a.txt', 'a'); git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', `work\n\nPipeline-Role: gongbu\nPipeline-Author: ${WRITER}`);
  const tip = git(cwd, 'rev-parse', 'HEAD'); git(cwd, 'switch', '-q', `integration/${change}`);
  installPaseo(cwd);
  const r = invoke(cwd, [`task/${change}/T-01`, 'T-01', passTag(tip, base)]);
  assert.equal(r.status, 33, r.out);
  assert.match(r.out, /without a test assertion/);
  assert.equal(git(cwd, 'status', '--porcelain'), '');
});
test('rejects Red proof that only fails to load the test file', () => {
  const f = build([['test/a.test.mjs', RED_TEST, 'ceshi', TESTER], ['src/a.txt', 'a', 'gongbu', WRITER]]);
  git(f.cwd, 'switch', '-q', `task/${f.change}/T-01`);
  // Implementation removes the test file; Red now "fails" by not finding it.
  fs.rmSync(path.join(f.cwd, 'test/a.test.mjs'));
  git(f.cwd, 'add', '-A'); git(f.cwd, 'commit', '-qm', `drop\n\nPipeline-Role: gongbu\nPipeline-Author: ${WRITER}`);
  const tip = git(f.cwd, 'rev-parse', 'HEAD'); git(f.cwd, 'switch', '-q', `integration/${f.change}`);
  const base = git(f.cwd, 'rev-parse', 'HEAD');
  const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', passTag(tip, base)]);
  // Removing a test-author file is itself a scope/provenance violation.
  assert.equal(r.status, 30, r.out);
});
test('accepts greenfield Red: static import of a not-yet-created module inside Write scope', () => {
  // The canonical greenfield TDD pattern: ceshi writes `import { foo } from '../src/foo.mjs'`
  // when src/foo.mjs does not exist on base. Node dies with ERR_MODULE_NOT_FOUND. This IS
  // behavioral Red — the test asserts the module's existence. merge-task must not reject it
  // as a non-behavioral failure (exit 33).
  const GREENFIELD_RED = `import test from 'node:test';
import assert from 'node:assert/strict';
import { isNumber } from '../src/a.mjs';
test('isNumber', () => { assert.equal(isNumber(42), true); });
`;
  const change = `c${++seq}`;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-'));
  git(cwd, 'init', '-q', '-b', 'main');
  write(cwd, `openspec/changes/${change}/tasks.md`, `- [ ] 1.1 T-01 task\n  - Write scope: src,test\n  - Verify with: node --test test/a.test.mjs\n`);
  write(cwd, `openspec/changes/${change}/proposal.md`, 'p\n');
  write(cwd, `openspec/changes/${change}/acceptance.md`, 'a\n');
  git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'base');
  git(cwd, 'switch', '-qc', `integration/${change}`);
  const base = git(cwd, 'rev-parse', 'HEAD');
  git(cwd, 'switch', '-qc', `task/${change}/T-01`);

  // ceshi: static import of module that does not exist yet
  write(cwd, 'test/a.test.mjs', GREENFIELD_RED);
  git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', `red\n\nPipeline-Role: ceshi\nPipeline-Author: ${TESTER}`);

  // gongbu: create the module
  write(cwd, 'src/a.mjs', 'export function isNumber(n) { return typeof n === "number"; }\n');
  git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', `impl\n\nPipeline-Role: gongbu\nPipeline-Author: ${WRITER}`);

  const tip = git(cwd, 'rev-parse', 'HEAD');
  git(cwd, 'switch', '-q', `integration/${change}`);

  const r = invoke(cwd, [`task/${change}/T-01`, 'T-01', passTag(tip, base)]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /merged T-01/);
});

test('accepts greenfield Red when Write scope names the exact .ts file the test imports as .js', () => {
  // NodeNext TypeScript: the test imports `../src/a.js` while the source is `src/a.ts`,
  // and the frozen Write scope names the exact `.ts` file. Both spellings are the same
  // declared module, so this must still count as behavioral Red.
  const FILE_SCOPE_RED = `import test from 'node:test';
import assert from 'node:assert/strict';
import { isNumber } from '../src/a.js';
test('isNumber', () => { assert.equal(isNumber(42), true); });
`;
  // Stands in for tsx: resolves the NodeNext `.js` specifier to the `.ts` source.
  const TS_HOOK = `import { registerHooks } from 'node:module';
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.endsWith('.js')) {
      try { return next(spec.replace(/\\.js$/, '.ts'), ctx); } catch {}
    }
    return next(spec, ctx);
  }
});
`;
  const change = `c${++seq}`;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-'));
  git(cwd, 'init', '-q', '-b', 'main');
  write(cwd, `openspec/changes/${change}/tasks.md`, `- [ ] 1.1 T-01 task\n  - Write scope: src/a.ts,test\n  - Verify with: node --import ./test/hook.mjs --test test/a.test.mjs\n`);
  write(cwd, `openspec/changes/${change}/proposal.md`, 'p\n');
  write(cwd, `openspec/changes/${change}/acceptance.md`, 'a\n');
  git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'base');
  git(cwd, 'switch', '-qc', `integration/${change}`);
  const base = git(cwd, 'rev-parse', 'HEAD');
  git(cwd, 'switch', '-qc', `task/${change}/T-01`);

  write(cwd, 'test/a.test.mjs', FILE_SCOPE_RED);
  write(cwd, 'test/hook.mjs', TS_HOOK);
  git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', `red\n\nPipeline-Role: ceshi\nPipeline-Author: ${TESTER}`);
  write(cwd, 'src/a.ts', 'export function isNumber(n: unknown): boolean { return typeof n === "number"; }\n');
  git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', `impl\n\nPipeline-Role: gongbu\nPipeline-Author: ${WRITER}`);

  const tip = git(cwd, 'rev-parse', 'HEAD'); git(cwd, 'switch', '-q', `integration/${change}`);
  const r = invoke(cwd, [`task/${change}/T-01`, 'T-01', passTag(tip, base)]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /merged T-01/);
});

test('still rejects greenfield Red when the file-scoped task imports an undeclared module', () => {
  // Same file-scope shape, but the missing module is not any declared file: extension
  // tolerance must not turn every ERR_MODULE_NOT_FOUND into an accepted Red.
  const UNDECLARED_RED = `import test from 'node:test';
import assert from 'node:assert/strict';
import { helper } from '../src/helper.js';
test('helper', () => { assert.equal(helper(), 1); });
`;
  const change = `c${++seq}`;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-'));
  git(cwd, 'init', '-q', '-b', 'main');
  write(cwd, `openspec/changes/${change}/tasks.md`, `- [ ] 1.1 T-01 task\n  - Write scope: src/a.ts,test\n  - Verify with: node --test test/a.test.mjs\n`);
  write(cwd, `openspec/changes/${change}/proposal.md`, 'p\n');
  write(cwd, `openspec/changes/${change}/acceptance.md`, 'a\n');
  git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'base');
  git(cwd, 'switch', '-qc', `integration/${change}`);
  const base = git(cwd, 'rev-parse', 'HEAD');
  git(cwd, 'switch', '-qc', `task/${change}/T-01`);

  write(cwd, 'test/a.test.mjs', UNDECLARED_RED);
  git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', `red\n\nPipeline-Role: ceshi\nPipeline-Author: ${TESTER}`);
  write(cwd, 'src/a.ts', 'export const x = 1;\n');
  git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', `impl\n\nPipeline-Role: gongbu\nPipeline-Author: ${WRITER}`);

  const tip = git(cwd, 'rev-parse', 'HEAD'); git(cwd, 'switch', '-q', `integration/${change}`);
  const r = invoke(cwd, [`task/${change}/T-01`, 'T-01', passTag(tip, base)]);
  assert.equal(r.status, 33, r.out);
  assert.match(r.out, /without a test assertion/);
});

test('rejects greenfield Red when missing module is outside Write scope', () => {
  const OUTSIDE_RED = `import test from 'node:test';
import assert from 'node:assert/strict';
import { foo } from '../lib/outside.mjs';
test('foo', () => { assert.equal(foo(), 1); });
`;
  const change = `c${++seq}`;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-'));
  git(cwd, 'init', '-q', '-b', 'main');
  // Write scope is only src,test — NOT lib
  write(cwd, `openspec/changes/${change}/tasks.md`, `- [ ] 1.1 T-01 task\n  - Write scope: src,test\n  - Verify with: node --test test/a.test.mjs\n`);
  write(cwd, `openspec/changes/${change}/proposal.md`, 'p\n');
  write(cwd, `openspec/changes/${change}/acceptance.md`, 'a\n');
  git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'base');
  git(cwd, 'switch', '-qc', `integration/${change}`);
  const base = git(cwd, 'rev-parse', 'HEAD');
  git(cwd, 'switch', '-qc', `task/${change}/T-01`);

  write(cwd, 'test/a.test.mjs', OUTSIDE_RED);
  git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', `red\n\nPipeline-Role: ceshi\nPipeline-Author: ${TESTER}`);

  write(cwd, 'src/a.mjs', 'export const x = 1;\n');
  git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', `impl\n\nPipeline-Role: gongbu\nPipeline-Author: ${WRITER}`);

  const tip = git(cwd, 'rev-parse', 'HEAD');
  git(cwd, 'switch', '-q', `integration/${change}`);

  const r = invoke(cwd, [`task/${change}/T-01`, 'T-01', passTag(tip, base)]);
  // lib/ is outside scope → still exit 33
  assert.equal(r.status, 33, r.out);
});

test('skips regression replay for fully independent prior task (P2b: O(N²) fix)', () => {
  // T-00 and T-01 have disjoint scopes and no shared dependencies.
  // T-00's verify would fail (test asserts 'src/poison.txt' absent, but nobody adds it),
  // yet merge-task must not run it when merging T-01, because they are independent.
  const tasks = [
    '- [x] T-00 independent',
    '  - Write scope: lib',
    '  - Review: mechanical',
    '  - Verify with: node --test test/prior.test.mjs',
    '  - Done: source=abcdef1 review=pass(mechanical@abcdef1/abcdef1)',
    '- [ ] T-01 target',
    '  - Write scope: src,test',
    `  - Verify with: ${GREEN}`,
    '',
  ].join('\n');
  const f = taggedFixture(tasks);
  // Prior's verify deliberately fails — it checks a file that does not exist.
  write(f.cwd, 'test/prior.test.mjs', `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport fs from 'node:fs';\ntest('independent', () => { assert.equal(fs.existsSync('lib/data.txt'), true); });\n`);
  write(f.cwd, 'test/a.test.mjs', RED_TEST); git(f.cwd, 'add', 'test');
  git(f.cwd, 'commit', '-qm', `red\n\nPipeline-Role: ceshi\nPipeline-Author: ${TESTER}`);
  write(f.cwd, 'src/a.txt', 'a'); git(f.cwd, 'add', 'src');
  git(f.cwd, 'commit', '-qm', `w\n\nPipeline-Role: gongbu\nPipeline-Author: ${WRITER}`);
  const tip = git(f.cwd, 'rev-parse', 'HEAD'); git(f.cwd, 'switch', '-q', `integration/${f.change}`);
  const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', passTag(tip, f.base)]);
  // If regression replay were O(N²), it would run T-00's verify and get exit 21.
  // With P2b fix, T-00 is skipped → merge succeeds.
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /merged T-01/);
});

test('still replays regression for tasks with overlapping scope', () => {
  // T-00 and T-01 both touch scope containing 'src' → must replay.
  const tasks = [
    '- [x] T-00 overlapper',
    '  - Write scope: src/core',
    '  - Review: mechanical',
    '  - Verify with: node --test test/prior.test.mjs',
    '  - Done: source=abcdef1 review=pass(mechanical@abcdef1/abcdef1)',
    '- [ ] T-01 target',
    '  - Write scope: src,test',
    `  - Verify with: ${GREEN}`,
    '',
  ].join('\n');
  const f = taggedFixture(tasks);
  // Prior's verify will fail: asserts poison file absent, but T-01 adds it.
  write(f.cwd, 'test/prior.test.mjs', `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport fs from 'node:fs';\ntest('overlap', () => { assert.equal(fs.existsSync('src/poison.txt'), false); });\n`);
  write(f.cwd, 'test/a.test.mjs', RED_TEST); git(f.cwd, 'add', 'test');
  git(f.cwd, 'commit', '-qm', `red\n\nPipeline-Role: ceshi\nPipeline-Author: ${TESTER}`);
  write(f.cwd, 'src/a.txt', 'a'); write(f.cwd, 'src/poison.txt', 'x'); git(f.cwd, 'add', 'src');
  git(f.cwd, 'commit', '-qm', `w\n\nPipeline-Role: gongbu\nPipeline-Author: ${WRITER}`);
  const tip = git(f.cwd, 'rev-parse', 'HEAD'); git(f.cwd, 'switch', '-q', `integration/${f.change}`);
  const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', passTag(tip, f.base)]);
  // src/core overlaps src → prior IS replayed → regression detected
  assert.equal(r.status, 21, r.out);
  assert.match(r.out, /regress already-Done T-00/);
});

test('rejects when implementation commit precedes test-author commit', () => {
  const f = build([['src/a.txt', 'a', 'gongbu', WRITER], ['test/a.test.mjs', RED_TEST, 'ceshi', TESTER]]);

  const r = run3(f); assert.equal(r.status, 31, r.out); assert.match(r.out, /must precede/);
});

// Python greenfield Red: pytest reports the not-yet-created module as ModuleNotFoundError.
const PY_VERIFY = `sh -c 'test -f src/a.txt || { echo "FAILED tests - ModuleNotFoundError: No module named src.a"; exit 1; }'`;
test('accepts Python greenfield Red: missing dotted module inside Write scope', () => {
  const f = fixture({ verify: PY_VERIFY, baseFiles: { 'src/keep.py': '' } }); // package exists on base, module is new
  const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', tag(f)]);
  assert.equal(r.status, 0, r.out);
});
test('rejects Python Red when the missing first-party module is outside Write scope (exit 33)', () => {
  // `openspec` exists on base but is not in Write scope (src,test).
  const f = fixture({ verify: PY_VERIFY.replace('src.a', 'openspec.x') });
  const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', tag(f)]);
  assert.equal(r.status, 33, r.out);
});
test('an uninstalled Python package stays exit 36, never a greenfield Red', () => {
  const f = fixture({ verify: PY_VERIFY.replace('src.a', 'pytest') });
  const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', tag(f)]);
  assert.equal(r.status, 36, r.out);
});

// A task may create a brand-new top-level Python package. Nothing named `billing`
// exists on base, so the first-party root lookup cannot fire; only the task's own
// diff proves the module is its work rather than an uninstalled dependency.
function pyPackageFixture({ verify, implFile, writeScope = 'billing,test' }) {
  const change = `c${++seq}`;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-'));
  git(cwd, 'init', '-q', '-b', 'main');
  write(cwd, `openspec/changes/${change}/tasks.md`, `- [ ] 1.1 T-01 task\n  - Write scope: ${writeScope}\n  - Verify with: ${verify}\n`);
  write(cwd, `openspec/changes/${change}/proposal.md`, 'p\n');
  write(cwd, `openspec/changes/${change}/acceptance.md`, 'a\n');
  git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'base');
  git(cwd, 'switch', '-qc', `integration/${change}`);
  const base = git(cwd, 'rev-parse', 'HEAD');
  git(cwd, 'switch', '-qc', `task/${change}/T-01`);
  write(cwd, 'test/a.txt', 'x'); git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', `red\n\nPipeline-Role: ceshi\nPipeline-Author: ${TESTER}`);
  write(cwd, implFile, ''); git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', `impl\n\nPipeline-Role: gongbu\nPipeline-Author: ${WRITER}`);
  const tip = git(cwd, 'rev-parse', 'HEAD'); git(cwd, 'switch', '-q', `integration/${change}`);
  return { cwd, change, tip, base };
}
const pyVerify = (mod) => `sh -c 'test -f ${mod.replaceAll('.', '/')}.py || { echo "FAILED tests - ModuleNotFoundError: No module named ${mod}"; exit 1; }'`;

test('accepts Python greenfield Red for a brand-new top-level package the task creates', () => {
  const f = pyPackageFixture({ verify: pyVerify('billing.core'), implFile: 'billing/core.py' });
  const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', passTag(f.tip, f.base)]);
  assert.equal(r.status, 0, r.out);
});
test('accepts a new top-level package under a src/ layout (import billing.core from src/billing/core.py)', () => {
  const verify = `sh -c 'test -f src/billing/core.py || { echo "FAILED tests - ModuleNotFoundError: No module named billing.core"; exit 1; }'`;
  const f = pyPackageFixture({ verify, implFile: 'src/billing/core.py', writeScope: 'src/billing,test' });
  const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', passTag(f.tip, f.base)]);
  assert.equal(r.status, 0, r.out);
});
test('a src/ layout new package outside Write scope still fails', () => {
  const verify = `sh -c 'test -f src/acme/core.py || { echo "FAILED tests - ModuleNotFoundError: No module named acme.core"; exit 1; }'`;
  const f = pyPackageFixture({ verify, implFile: 'src/billing/core.py', writeScope: 'src/billing,test' });
  const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', passTag(f.tip, f.base)]);
  assert.notEqual(r.status, 0, r.out);
});
test('a brand-new top-level Python module outside Write scope stays exit 36', () => {
  const f = pyPackageFixture({ verify: pyVerify('acme.core'), implFile: 'billing/core.py' });
  const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', passTag(f.tip, f.base)]);
  assert.equal(r.status, 36, r.out);
});
test('an uninstalled Python package is never excused by a task that writes Python files', () => {
  const f = pyPackageFixture({ verify: pyVerify('pytest'), implFile: 'billing/core.py' });
  const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', passTag(f.tip, f.base)]);
  assert.equal(r.status, 36, r.out);
});

test('rejects a Lead author that `paseo ls` omits but `paseo inspect` resolves', () => {
  const f = fixture();
  const partial = JSON.stringify([
    { id: TESTER, shortId: '9b2f4c1', provider: 'codex/gpt' },
    { id: REVIEWER, shortId: REVIEWER_SHORT, provider: 'claude/cc' },
  ]);
  const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', tag(f)], partial,
    { Id: WRITER, Name: '[Pipeline] shangshu z lead', Provider: 'claude', Model: 'flash' });
  assert.equal(r.status, 31, r.out);
  assert.match(r.out, /Lead/);
});
test('an archived non-Lead author resolved by `paseo inspect` still merges', () => {
  const f = fixture();
  const partial = JSON.stringify([
    { id: TESTER, shortId: '9b2f4c1', provider: 'codex/gpt' },
    { id: REVIEWER, shortId: REVIEWER_SHORT, provider: 'claude/cc' },
  ]);
  const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', tag(f)], partial,
    { Id: WRITER, Name: 'gongbu z', Provider: 'claude', Model: 'flash' });
  assert.equal(r.status, 0, r.out);
});

test('rejects commits authored by the Lead (shangshu)', () => {
  const f = fixture();
  const agents = [
    { id: TESTER, shortId: '9b2f4c1', provider: 'codex/gpt' },
    { id: WRITER, shortId: '9b2f4c2', provider: 'claude/flash', name: '[Pipeline] shangshu c lead' },
    { id: REVIEWER, shortId: REVIEWER_SHORT, provider: 'claude/cc' },
  ];
  const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', tag(f)], agents);
  assert.equal(r.status, 31, r.out);
  assert.match(r.out, /Lead/);
});

test('attempt breaker: -a4 is exit 37 unless a human approved it', () => {
  const f = fixture();
  git(f.cwd, 'branch', '-m', `task/${f.change}/T-01`, `task/${f.change}/T-01-a4`);
  const blocked = invoke(f.cwd, [`task/${f.change}/T-01-a4`, 'T-01', tag(f)]);
  assert.equal(blocked.status, 37, blocked.out);
  const allowed = invoke(f.cwd, [`task/${f.change}/T-01-a4`, 'T-01', tag(f), '--allow-attempt-over']);
  assert.equal(allowed.status, 0, allowed.out);
});
test('attempt breaker: -a3 still merges', () => {
  const f = fixture();
  git(f.cwd, 'branch', '-m', `task/${f.change}/T-01`, `task/${f.change}/T-01-a3`);
  assert.equal(invoke(f.cwd, [`task/${f.change}/T-01-a3`, 'T-01', tag(f)]).status, 0);
});

// Main drift: the integration branch is cut from main; if main later changed this task's files,
// the review and Verify ran on a stale picture.
function advanceMain(f, file, text) {
  git(f.cwd, 'switch', '-q', 'main');
  write(f.cwd, file, text); git(f.cwd, 'add', '.'); git(f.cwd, 'commit', '-qm', `main: ${file}`);
  git(f.cwd, 'switch', '-q', `integration/${f.change}`);
}
test('main advanced on a task scope file → exit 34, rebase and re-review', () => {
  const f = fixture();
  advanceMain(f, 'src/hot.txt', 'changed on main');
  const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', tag(f)]);
  assert.equal(r.status, 34, r.out);
  assert.match(r.out, /main advanced on task scope \(src\/hot\.txt\)/);
  assert.match(r.out, new RegExp(`rebase integration/${f.change} onto main`));
});
test('main advanced only outside the task scope still merges', () => {
  const f = fixture();
  advanceMain(f, 'docs/unrelated.md', 'x');
  assert.equal(invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', tag(f)]).status, 0);
});
test('main drift falls back to master and fails open when neither exists', () => {
  const f = fixture();
  advanceMain(f, 'src/hot.txt', 'x');
  git(f.cwd, 'branch', '-m', 'main', 'master');
  assert.equal(invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', tag(f)]).status, 34);
  git(f.cwd, 'branch', '-m', 'master', 'trunk');
  assert.equal(invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', tag(f)]).status, 0);
});

// Same-branch rework cap: 2 implementation commits per branch (lead.md).
const implCommits = (n) => [
  ['test/a.test.mjs', RED_TEST, 'ceshi', TESTER],
  ...Array.from({ length: n }, (_, i) => [`src/${i === 0 ? 'a' : `r${i}`}.txt`, `v${i}`, 'gongbu', WRITER]),
];
test('rework cap: 2 implementation commits on one branch merge', () => {
  assert.equal(run3(build(implCommits(2))).status, 0);
});
test('rework cap: a 3rd implementation commit is exit 37 pointing at -a2', () => {
  const r = run3(build(implCommits(3)));
  assert.equal(r.status, 37, r.out);
  assert.match(r.out, /3 implementation commits/);
  assert.match(r.out, /T-01-a2/);
});
test('rework cap: --allow-attempt-over bypasses it', () => {
  const f = build(implCommits(3));
  const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', passTag(f.tip, f.base), '--allow-attempt-over']);
  assert.equal(r.status, 0, r.out);
});
