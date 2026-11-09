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

const WORKER = '9b2f4c1e-2222-4a2b-8c3d-000000000002';
const OTHER_WORKER = '9b2f4c1e-4444-4a2b-8c3d-000000000004';
const FAKE = '9b2f4c1e-9999-4a2b-8c3d-000000000009';

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

// A passing behavioral test: the file loads, runs, and its assertions hold.
const PASSING_TEST = `import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
test('behavior', () => { assert.equal(fs.existsSync('src/a.txt'), true); });
`;
const GREEN = 'node --test test/a.test.mjs';
let seq = 0;

function fixture({ outside = false, verify = GREEN, baseFiles = {}, seedRed = false } = {}) {
  const change = `c${++seq}`;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-'));
  git(cwd, 'init', '-q', '-b', 'main');
  write(cwd, `openspec/changes/${change}/tasks.md`, `- [ ] 1.1 T-01 task\n  - Write scope: src,test\n  - Verify with: ${verify}\n`);
  write(cwd, `openspec/changes/${change}/proposal.md`, 'p\n');
  write(cwd, `openspec/changes/${change}/acceptance.md`, 'a\n');
  for (const [file, text] of Object.entries(baseFiles)) write(cwd, file, text);
  git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'base'); git(cwd, 'switch', '-qc', `integration/${change}`);
  const base = git(cwd, 'rev-parse', 'HEAD'); git(cwd, 'switch', '-qc', `task/${change}/T-01`);
  if (seedRed) {
    write(cwd, 'test/legacy.test.mjs', PASSING_TEST); git(cwd, 'add', '.');
    git(cwd, 'commit', '-qm', `tests\n\nPipeline-Role: ceshi\nPipeline-Author: ${WORKER}`);
  }
  write(cwd, 'test/a.test.mjs', PASSING_TEST); git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', `work\n\nPipeline-Role: gongbu\nPipeline-Author: ${WORKER}`);
  if (!outside) write(cwd, 'src/a.txt', 'a');
  else write(cwd, 'outside.txt', 'a');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', `impl\n\nPipeline-Role: gongbu\nPipeline-Author: ${WORKER}`);
  const tip = git(cwd, 'rev-parse', 'HEAD'); git(cwd, 'switch', '-q', `integration/${change}`);
  return { cwd, change, base, tip };
}
function invoke(cwd, args) {
  const r = spawnSync('node', [script, ...args], { cwd, env, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}
const passTag = (tip, base, reviewer = 'abcd123') => `pass(${reviewer}@${tip.slice(0, 7)}/${base.slice(0, 7)})`;

function taggedFixture(tasks) {
  const change = `c${++seq}`;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-'));
  git(cwd, 'init', '-q', '-b', 'main');
  write(cwd, `openspec/changes/${change}/tasks.md`, tasks);
  write(cwd, `openspec/changes/${change}/proposal.md`, 'p');
  write(cwd, `openspec/changes/${change}/acceptance.md`, 'a');
  git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'base'); git(cwd, 'switch', '-qc', `integration/${change}`);
  const base = git(cwd, 'rev-parse', 'HEAD'); git(cwd, 'switch', '-qc', `task/${change}/T-01`);
  return { cwd, change, base };
}

test('merges a valid worker branch without any review tag and records Done', () => {
  const f = fixture();
  const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01']);
  assert.equal(r.status, 0, r.out);
  const text = fs.readFileSync(path.join(f.cwd, `openspec/changes/${f.change}/tasks.md`), 'utf8');
  assert.match(text, /\[x\][^\n]*T-01[^\n]*\n\s*- Done: source=[0-9a-f]{7,40} review=worker/);
  assert.equal(git(f.cwd, 'status', '--porcelain'), '');
});

test('a legacy review tag is accepted only as a base hint', () => {
  const f = fixture();
  const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', passTag(f.tip, f.base)]);
  assert.equal(r.status, 0, r.out);
});

test('one worker may write tests and implementation; no separate test author is required', () => {
  const f = fixture();
  // fixture commits both tests and implementation under `gongbu`
  const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01']);
  assert.equal(r.status, 0, r.out);
});

test('a legacy ceshi commit on the branch still merges', () => {
  // Branches authored before the single-worker change carry a `ceshi` test commit.
  // Accept it for merge compatibility rather than rejecting valid in-flight work.
  const f = taggedFixture(`- [ ] T-01 task\n  - Write scope: src,test\n  - Verify with: ${GREEN}\n`);
  write(f.cwd, 'test/legacy.test.mjs', PASSING_TEST); git(f.cwd, 'add', '.');
  git(f.cwd, 'commit', '-qm', `tests\n\nPipeline-Role: ceshi\nPipeline-Author: ${WORKER}`);
  write(f.cwd, 'test/a.test.mjs', PASSING_TEST);
  write(f.cwd, 'src/a.txt', 'a'); git(f.cwd, 'add', '.');
  git(f.cwd, 'commit', '-qm', `work\n\nPipeline-Role: gongbu\nPipeline-Author: ${WORKER}`);
  const tip = git(f.cwd, 'rev-parse', 'HEAD'); git(f.cwd, 'switch', '-q', `integration/${f.change}`);
  const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01']);
  assert.equal(r.status, 0, r.out);
});

test('rejects scope violation', () => {
  const f = fixture({ outside: true });
  const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01']);
  assert.equal(r.status, 30, r.out);
});

test('rejects a failed frozen Verify with exit 20', () => {
  const f = fixture({ verify: 'node --test test/does-not-exist.test.mjs' });
  const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01']);
  assert.equal(r.status, 20, r.out);
  assert.equal(git(f.cwd, 'status', '--porcelain'), '');
});

test('a worktree with no dependencies is exit 36, not a failing test', () => {
  const f = fixture({ verify: 'node --import tsx --test test/a.test.mjs' });
  const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01']);
  assert.equal(r.status, 36, r.out);
  assert.match(r.out, /cannot resolve "tsx"/);
  assert.match(r.out, /not a test failure/);
  assert.match(r.out, /Do not edit tests/);
  assert.equal(git(f.cwd, 'status', '--porcelain'), '');
});
test('a missing runner command is exit 36 as well', () => {
  const f = fixture({ verify: 'tsx --test test/a.test.mjs' });
  assert.equal(invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01']).status, 36);
});
test('a missing dependency-local binary is exit 36 as well', () => {
  const f = fixture({ verify: 'node_modules/.bin/vitest run test/a.test.mjs' });
  const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01']);
  assert.equal(r.status, 36, r.out);
  assert.match(r.out, /cannot resolve "node_modules"/);
});
test('a green Verify that dies on a missing package is exit 36, not 20', () => {
  const f = fixture({ verify: `node --test test/a.test.mjs && node --input-type=module -e "import 'nopkg-xyz'"` });
  const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01']);
  assert.equal(r.status, 36, r.out);
  assert.match(r.out, /cannot resolve "nopkg-xyz"/);
});

test('an already-Done task is refused, not re-merged', () => {
  const f = fixture();
  assert.equal(invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01']).status, 0);
  const again = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01']);
  assert.equal(again.status, 1, again.out);
  assert.match(again.out, /already Done/);
});

test('marks the exact task ID, not a substring ID', () => {
  const tasks = `- [ ] T-010 other\n  - Write scope: other\n  - Review: mechanical\n  - Verify with: true\n- [ ] T-01 target\n  - Write scope: src,test\n  - Verify with: ${GREEN}\n`;
  const f = taggedFixture(tasks);
  write(f.cwd, 'test/a.test.mjs', PASSING_TEST);
  write(f.cwd, 'src/a.txt', 'target');
  git(f.cwd, 'add', '.');
  git(f.cwd, 'commit', '-qm', `target\n\nPipeline-Role: gongbu\nPipeline-Author: ${WORKER}`);
  const tip = git(f.cwd, 'rev-parse', 'HEAD'); git(f.cwd, 'switch', '-q', `integration/${f.change}`);
  const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', passTag(tip, f.base)]);
  assert.equal(r.status, 0, r.out);
  const text = fs.readFileSync(path.join(f.cwd, `openspec/changes/${f.change}/tasks.md`), 'utf8');
  assert.match(text, /^- \[ \] T-010 other[\s\S]*?- \[x\] T-01 target/m);
  assert.doesNotMatch(text, /- \[x\] T-010/);
});

test('missing writer trailers are exit 31', () => {
  const f = fixture();
  git(f.cwd, 'switch', '-q', `task/${f.change}/T-01`);
  write(f.cwd, 'src/b.txt', 'b');
  git(f.cwd, 'add', '-A');
  git(f.cwd, 'commit', '-qm', 'no trailers');
  git(f.cwd, 'switch', '-q', `integration/${f.change}`);
  const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01']);
  assert.equal(r.status, 31, r.out);
});

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
  write(f.cwd, 'test/a.test.mjs', PASSING_TEST);
  write(f.cwd, 'src/a.txt', 'a');
  git(f.cwd, 'add', '.');
  git(f.cwd, 'commit', '-qm', `work\n\nPipeline-Role: gongbu\nPipeline-Author: ${WORKER}`);
  const tip = git(f.cwd, 'rev-parse', 'HEAD'); git(f.cwd, 'switch', '-q', `integration/${f.change}`);
  const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', passTag(tip, f.base)]);
  assert.equal(r.status, 35, r.out);
  assert.match(r.out, /T-01 Uses T-00 is not Done/);
});

// ---- cherry-pick provenance ----
const provenanceTasks = `- [ ] T-01 work
  - Write scope: src,test
  - Verify with: ${GREEN}
`;
function provenanceFixture() {
  const f = taggedFixture(provenanceTasks);
  write(f.cwd, 'test/a.test.mjs', PASSING_TEST);
  git(f.cwd, 'add', '.');
  git(f.cwd, 'commit', '-qm', `tests\n\nPipeline-Role: gongbu\nPipeline-Author: ${WORKER}`);
  const start = git(f.cwd, 'rev-parse', 'HEAD');
  git(f.cwd, 'switch', '-qc', 'original', start);
  write(f.cwd, 'src/a.txt', 'a');
  git(f.cwd, 'add', 'src/a.txt');
  git(f.cwd, 'commit', '-qm', `work\n\nPipeline-Role: gongbu\nPipeline-Author: ${WORKER}`);
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

test('a cherry-pick marker whose author trailers disagree with the source is exit 31', () => {
  const f = provenanceFixture();
  git(f.cwd, 'cherry-pick', '-x', f.original);
  git(f.cwd, 'commit', '--amend', '-qm', `work\n\nPipeline-Role: gongbu\nPipeline-Author: ${FAKE}\n(cherry picked from commit ${f.original})`);
  const tip = provenanceTip(f.cwd, f.change);
  const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', passTag(tip, f.base)]);
  assert.equal(r.status, 31, r.out);
  assert.match(r.out, /cherry-pick Pipeline-Author .* differs from/);
});

test('a merge that regresses an already-Done task is exit 21 and leaves the tree clean', () => {
  // The prior task asserts its own invariant: a generated file must never exist.
  // Once the target task adds that file, replaying the prior leg must go red.
  const tasks = '- [x] T-00 prior\n  - Write scope: test/prior.test.mjs\n  - Reads: src/poison.txt\n  - Review: mechanical\n  - Verify with: node --test test/prior.test.mjs\n  - Done: source=abcdef1 review=worker\n- [ ] T-01 target\n  - Write scope: src,test\n  - Verify with: node --test test/a.test.mjs\n';
  const f = taggedFixture(tasks);
  write(f.cwd, 'test/prior.test.mjs', `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport fs from 'node:fs';\ntest('legacy', () => { assert.equal(fs.existsSync('src/poison.txt'), false); });\n`);
  write(f.cwd, 'test/a.test.mjs', PASSING_TEST);
  write(f.cwd, 'src/a.txt', 'a'); write(f.cwd, 'src/poison.txt', 'x');
  git(f.cwd, 'add', '.');
  git(f.cwd, 'commit', '-qm', `w\n\nPipeline-Role: gongbu\nPipeline-Author: ${WORKER}`);
  const tip = git(f.cwd, 'rev-parse', 'HEAD'); git(f.cwd, 'switch', '-q', `integration/${f.change}`);
  const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', passTag(tip, f.base)]);
  assert.equal(r.status, 21, r.out);
  assert.match(r.out, /regress already-Done T-00/);
  // The gate cannot tell a real regression from an absent environment; the message must say so.
  assert.match(r.out, /environment it needs is absent/);
  assert.match(r.out, /Do not edit the Verify command or the tests/);
  assert.equal(git(f.cwd, 'status', '--porcelain'), '');
});

test('a prefix suite on an already-Done task is skipped and only its narrow leg replays', () => {
  // Prior T-00 mixes a package full suite with a narrow test. `npm` itself does not exist in
  // this fixture, so replaying that leg would fail; the narrow leg passes. This pins the
  // working-directory parse feeding merge's broad-leg skip.
  const tasks = '- [x] T-00 prior\n  - Write scope: test/prior.test.mjs\n  - Reads: src/poison.txt\n  - Review: mechanical\n  - Verify with: npm --prefix packages/a test && node --test test/prior.test.mjs\n  - Done: source=abcdef1 review=worker\n- [ ] T-01 target\n  - Write scope: src,test\n  - Verify with: node --test test/a.test.mjs\n';
  const f = taggedFixture(tasks);
  write(f.cwd, 'test/prior.test.mjs', `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport fs from 'node:fs';\ntest('legacy', () => { assert.equal(fs.existsSync('src/poison.txt'), false); });\n`);
  write(f.cwd, 'test/a.test.mjs', PASSING_TEST);
  write(f.cwd, 'src/a.txt', 'a');
  git(f.cwd, 'add', '.');
  git(f.cwd, 'commit', '-qm', `w\n\nPipeline-Role: gongbu\nPipeline-Author: ${WORKER}`);
  const tip = git(f.cwd, 'rev-parse', 'HEAD'); git(f.cwd, 'switch', '-q', `integration/${f.change}`);
  const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', passTag(tip, f.base)]);
  assert.equal(r.status, 0, r.out);
  assert.match(fs.readFileSync(path.join(f.cwd, `openspec/changes/${f.change}/run-log.md`), 'utf8'), /"replayed":1/);
});

test('a repeated working-directory option is a broad leg, so replay still runs the narrow one', () => {
  // Prior T-00 lists a package suite behind two `--prefix` options beside a narrow test. npm runs
  // the last package's whole suite, so that leg must be skipped as broad — and the narrow leg
  // must still replay. Reading the first prefix only would make the "suite" look like a path:
  // the skip would then not apply, and the replay would fail trying to run the real npm suite in
  // a fixture that has no packages.
  const tasks = '- [x] T-00 prior\n  - Write scope: test/prior.test.mjs\n  - Reads: src/poison.txt\n  - Review: mechanical\n  - Verify with: npm --prefix packages/a --prefix packages/b test && node --test test/prior.test.mjs\n  - Done: source=abcdef1 review=worker\n- [ ] T-01 target\n  - Write scope: src,test\n  - Verify with: node --test test/a.test.mjs\n';
  const f = taggedFixture(tasks);
  write(f.cwd, 'test/prior.test.mjs', `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport fs from 'node:fs';\ntest('legacy', () => { assert.equal(fs.existsSync('src/poison.txt'), false); });\n`);
  write(f.cwd, 'test/a.test.mjs', PASSING_TEST);
  write(f.cwd, 'src/a.txt', 'a');
  git(f.cwd, 'add', '.');
  git(f.cwd, 'commit', '-qm', `w\n\nPipeline-Role: gongbu\nPipeline-Author: ${WORKER}`);
  const tip = git(f.cwd, 'rev-parse', 'HEAD'); git(f.cwd, 'switch', '-q', `integration/${f.change}`);
  const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', passTag(tip, f.base)]);
  assert.equal(r.status, 0, r.out);
  const log = fs.readFileSync(path.join(f.cwd, `openspec/changes/${f.change}/run-log.md`), 'utf8');
  assert.match(log, /"replayed":1/);
});

test('attempt breaker: -a4 is exit 37 unless a human approved it', () => {
  const f = fixture();
  git(f.cwd, 'branch', '-m', `task/${f.change}/T-01`, `task/${f.change}/T-01-a4`);
  assert.equal(invoke(f.cwd, [`task/${f.change}/T-01-a4`, 'T-01']).status, 37);
  assert.equal(invoke(f.cwd, [`task/${f.change}/T-01-a4`, 'T-01', '--allow-attempt-over']).status, 0);
});
test('attempt breaker: -a3 still merges', () => {
  const f = fixture();
  git(f.cwd, 'branch', '-m', `task/${f.change}/T-01`, `task/${f.change}/T-01-a3`);
  assert.equal(invoke(f.cwd, [`task/${f.change}/T-01-a3`, 'T-01']).status, 0);
});

// Main drift: the integration branch is cut from main; if main later changed this task's files,
// the Verify ran on a stale picture.
function advanceMain(f, file, text) {
  git(f.cwd, 'switch', '-q', 'main');
  write(f.cwd, file, text); git(f.cwd, 'add', '.'); git(f.cwd, 'commit', '-qm', `main: ${file}`);
  git(f.cwd, 'switch', '-q', `integration/${f.change}`);
}
test('main advanced on a task scope file → exit 34', () => {
  const f = fixture();
  advanceMain(f, 'src/hot.txt', 'changed on main');
  const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01']);
  assert.equal(r.status, 34, r.out);
  assert.match(r.out, /main advanced on task scope \(src\/hot\.txt\)/);
});
test('main advanced only outside the task scope still merges', () => {
  const f = fixture();
  advanceMain(f, 'docs/unrelated.md', 'x');
  assert.equal(invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01']).status, 0);
});
test('main drift falls back to master and fails open when neither exists', () => {
  const f = fixture();
  advanceMain(f, 'src/hot.txt', 'x');
  git(f.cwd, 'branch', '-m', 'main', 'master');
  assert.equal(invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01']).status, 34);
  git(f.cwd, 'branch', '-m', 'master', 'trunk');
  assert.equal(invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01']).status, 0);
});

// Multiple implementation commits can be one successful attempt; commit count is not retry count.
const implCommits = (n) => Array.from({ length: n }, (_, i) => [`src/${i === 0 ? 'a' : `r${i}`}.txt`, `v${i}`]);
test('four worker commits on one attempt merge without human override', () => {
  const f = taggedFixture(`- [ ] T-01 task\n  - Write scope: src,test\n  - Verify with: ${GREEN}\n`);
  write(f.cwd, 'test/a.test.mjs', PASSING_TEST);
  for (const [file, text] of implCommits(4)) {
    write(f.cwd, file, text); git(f.cwd, 'add', '.');
    git(f.cwd, 'commit', '-qm', `w\n\nPipeline-Role: gongbu\nPipeline-Author: ${WORKER}`);
  }
  const tip = git(f.cwd, 'rev-parse', 'HEAD'); git(f.cwd, 'switch', '-q', `integration/${f.change}`);
  const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', passTag(tip, f.base)]);
  assert.equal(r.status, 0, r.out);
});

test('timeout accepts separate and equals forms and rejects invalid values', () => {
  for (const flag of [['--timeout', '5000'], ['--timeout=5000']]) {
    const f = fixture();
    const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', ...flag]);
    assert.equal(r.status, 0, r.out);
  }
  const f = fixture();
  for (const flag of [['--timeout'], ['--timeout=bogus'], ['--timeout=0'], ['--timeout-malformed']]) {
    const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', ...flag]);
    assert.equal(r.status, 2, `${flag}: ${r.out}`);
  }
});

test('test infrastructure requires explicit human override', () => {
  for (const file of ['packages/web/test/setup/jsdom.ts', 'vitest.config.ts', 'nested/jest.config.js']) {
    const f = taggedFixture(`- [ ] T-01 task\n  - Write scope: packages,vitest.config.ts,nested,src,test\n  - Verify with: ${GREEN}\n`);
    write(f.cwd, file, 'changed');
    write(f.cwd, 'test/a.test.mjs', PASSING_TEST);
    write(f.cwd, 'src/a.txt', 'a');
    git(f.cwd, 'add', '.');
    git(f.cwd, 'commit', '-qm', `work\n\nPipeline-Role: gongbu\nPipeline-Author: ${WORKER}`);
    git(f.cwd, 'switch', '-q', `integration/${f.change}`);
    const args = [`task/${f.change}/T-01`, 'T-01'];
    const denied = invoke(f.cwd, args);
    assert.equal(denied.status, 38, denied.out);
    assert.match(denied.out, /test infrastructure changes require human approval/);
    const allowed = invoke(f.cwd, [...args, '--allow-test-infra']);
    assert.equal(allowed.status, 0, allowed.out);
  }
});

test('ordinary test files do not trigger test infrastructure gate', () => {
  const f = taggedFixture(`- [ ] T-01 task\n  - Write scope: src,test\n  - Verify with: ${GREEN}\n`);
  write(f.cwd, 'src/a.test.ts', 'test');
  write(f.cwd, 'test/a.test.mjs', PASSING_TEST);
  write(f.cwd, 'src/a.txt', 'a');
  git(f.cwd, 'add', '.');
  git(f.cwd, 'commit', '-qm', `work\n\nPipeline-Role: gongbu\nPipeline-Author: ${WORKER}`);
  git(f.cwd, 'switch', '-q', `integration/${f.change}`);
  const result = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01']);
  assert.equal(result.status, 0, result.out);
});

test('rejects a task missing Verify with without crashing child_process', () => {
  const f = taggedFixture(`- [ ] T-01 task\n  - Write scope: src,test\n`);
  write(f.cwd, 'src/a.txt', 'a');
  git(f.cwd, 'add', '.');
  git(f.cwd, 'commit', '-qm', `work\n\nPipeline-Role: gongbu\nPipeline-Author: ${WORKER}`);
  git(f.cwd, 'switch', '-q', `integration/${f.change}`);
  const result = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01']);
  assert.equal(result.status, 1, result.out);
  assert.match(result.out, /invalid task T-01/);
  assert.match(result.out, /MISSING_VERIFY/);
});

test('replay executes an npm-prefix narrow target instead of skipping it as a package suite', () => {
  // The prior Verify is a single narrow leg behind two `--prefix` options: npm runs it in the last
  // package. Replay must execute it, so a failing target blocks the merge with the regression
  // message. If that leg were classified broad it would be filtered out, the prior would have no
  // legs left, and the merge would sail through with `replayed:0`.
  const npm = spawnSync('npm', ['--version'], { encoding: 'utf8' });
  assert.equal(npm.status, 0, `npm is needed for this replay test: ${npm.error?.message ?? npm.stderr}`);
  const tasks = '- [x] T-00 prior\n  - Write scope: test/prior.test.mjs\n  - Reads: src/poison.txt\n  - Review: mechanical\n  - Verify with: npm --prefix packages/a --prefix packages/b test -- test/x.test.ts\n  - Done: source=abcdef1 review=worker\n- [ ] T-01 target\n  - Write scope: src,test\n  - Verify with: node --test test/a.test.mjs\n';
  const f = taggedFixture(tasks);
  // The packages belong to the integration base, not to the task branch: a file the worker adds
  // would fall outside its Write scope, and the replay only needs the runner to exist.
  git(f.cwd, 'switch', '-q', `integration/${f.change}`);
  const pkg = (name) => JSON.stringify({ name, version: '1.0.0', scripts: { test: 'node --test test/x.test.ts' } }, null, 2);
  write(f.cwd, 'packages/a/package.json', pkg('a'));
  write(f.cwd, 'packages/b/package.json', pkg('b'));
  // Only package b has the target, and it emits a unique marker before failing. The merge report
  // must contain that child's captured stdout as well as the regression command; this proves the
  // package-b test really executed, rather than merely proving merge-task attempted npm.
  write(f.cwd, 'packages/b/test/x.test.ts', `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport path from 'node:path';\ntest('runs in package b', () => {\n  assert.equal(path.basename(process.cwd()), 'b');\n  console.log('D4_NPM_PREFIX_TARGET_EXECUTED_B');\n  assert.fail('deliberate replay failure');\n});\n`);
  git(f.cwd, 'add', '.'); git(f.cwd, 'commit', '-qm', 'packages');
  git(f.cwd, 'switch', '-q', `task/${f.change}/T-01`);
  write(f.cwd, 'test/prior.test.mjs', `import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('legacy', () => { assert.ok(true); });\n`);
  write(f.cwd, 'test/a.test.mjs', PASSING_TEST);
  write(f.cwd, 'src/a.txt', 'a');
  git(f.cwd, 'add', '.');
  git(f.cwd, 'commit', '-qm', `w\n\nPipeline-Role: gongbu\nPipeline-Author: ${WORKER}`);
  const tip = git(f.cwd, 'rev-parse', 'HEAD'); git(f.cwd, 'switch', '-q', `integration/${f.change}`);
  const r = invoke(f.cwd, [`task/${f.change}/T-01`, 'T-01', passTag(tip, f.base)]);
  assert.equal(r.status, 21, r.out);
  assert.match(r.out, /merge would regress already-Done T-00: npm --prefix packages\/a --prefix packages\/b test -- test\/x\.test\.ts/);
  assert.match(r.out, /D4_NPM_PREFIX_TARGET_EXECUTED_B/, 'the last-prefix package test must have run');
  // The merge aborted, so the integration branch is unchanged.
  assert.equal(git(f.cwd, 'status', '--porcelain'), '');
});
