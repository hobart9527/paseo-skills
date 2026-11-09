// Sandbox end-to-end: contract lint -> freeze-check -> serial merges with the
// converged DAG model (skeleton, Uses, deferred) and cherry-pick provenance.
// Proves the pipeline does not block itself on a valid contract, and that the
// real blocking codes still fire on the cases they are meant to catch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mergeTask = fileURLToPath(new URL('../merge-task.mjs', import.meta.url));
const freezeCheck = fileURLToPath(new URL('../freeze-check.mjs', import.meta.url));

const WORKER = '9b2f4c10-2222-4a2b-8c3d-000000000002';
const HANLIN = '9b2f4c10-3333-4a2b-8c3d-000000000003';
const OTHER_WORKER = '9b2f4c10-5555-4a2b-8c3d-000000000005';

const baseEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'sandbox',
  GIT_AUTHOR_EMAIL: 'sandbox@test.local',
  GIT_COMMITTER_NAME: 'sandbox',
  GIT_COMMITTER_EMAIL: 'sandbox@test.local',
};
delete baseEnv.NODE_TEST_CONTEXT;

function fakePaseo(cwd) {
  const bin = path.join(cwd, '.fake-bin');
  fs.mkdirSync(bin, { recursive: true });
  const agents = Buffer.from(JSON.stringify([
    { id: WORKER, shortId: WORKER.slice(0, 7), provider: 'claude/flash' },
    { id: HANLIN, shortId: HANLIN.slice(0, 7), name: '[Pipeline] hanlin R0', provider: 'claude/cc' },
  ])).toString('base64');
  const exe = path.join(bin, 'paseo');
  fs.writeFileSync(exe, [
    '#!/bin/sh',
    `if [ "$1" = inspect ]; then printf '{"Id":"%s","Provider":"claude","Model":"flash"}' "$2";`,
    `else printf '%s' '${agents}' | base64 -d; fi`,
    "printf '\\n'",
  ].join('\n'));
  fs.chmodSync(exe, 0o755);
  return { ...baseEnv, PATH: `${bin}:${process.env.PATH}` };
}

const TASKS = `- [ ] 1.1 T-00 interface skeleton
  - Write scope: src/iface.mjs,test/iface.test.mjs
  - Est: S
  - Kind: skeleton
  - Interface: src/iface.mjs#useDraft
  - Review: mechanical
  - Verify with: node --test test/iface.test.mjs
- [ ] 1.2 T-01 producer
  - Write scope: src/prod.mjs,test/prod.test.mjs
  - Est: S
  - Review: deferred
  - Verify with: node --test test/prod.test.mjs
  - Scen: SCEN-CORE
- [ ] 1.3 T-02 consumer of the frozen interface
  - Uses: T-00
  - Write scope: src/consumer.mjs,test/consumer.test.mjs
  - Est: S
  - Review: deferred
  - Verify with: node --test test/consumer.test.mjs
  - Scen: SCEN-CORE
- [ ] 1.4 T-04 extra behavior
  - Write scope: src/extra.mjs,test/extra.test.mjs
  - Est: S
  - Review: deferred
  - Verify with: node --test test/extra.test.mjs
  - Scen: SCEN-CORE
- [ ] 1.5 T-03 sole sink
  - Depends on: T-00,T-01,T-02,T-04
  - Write scope: src/all.mjs,test/all.test.mjs
  - Est: S
  - Review: mechanical
  - Verify with: node --test test/all.test.mjs
`;

const acceptance = `| Scenario | Entry | Tasks | Verify | Required | Result | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| SCEN-CORE | CLI | T-01,T-02,T-04 | node -e "0" | yes | PENDING | pending |
`;

function redTest(file, marker) {
  return `import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
test('behavior', () => { assert.equal(fs.existsSync('${marker}'), true); });
`;
}
const impl = (name) => `export const ${name} = '${name}';\n`;

function sandbox() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-e2e-'));
  const env = fakePaseo(cwd);
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    return result.stdout.trim();
  };
  const write = (file, text) => {
    const full = path.join(cwd, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  };
  const change = 'sandbox';
  write('openspec/changes/sandbox/tasks.md', TASKS);
  write('openspec/changes/sandbox/proposal.md', '# Proposal\nsandbox\n');
  write('openspec/changes/sandbox/design.md', '# Design\n## Impact Inventory\nnone\n');
  write('openspec/changes/sandbox/acceptance.md', acceptance);
  write('openspec/changes/sandbox/specs/core/spec.md', '#### Scenario: SCEN-CORE behavior\n');
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-qm', 'contract');
  const contractSha = git('rev-parse', 'HEAD');
  write('openspec/changes/sandbox/review.md', `R0: pass(${HANLIN}@${contractSha})\n`);
  // review.md is exempt from R0 drift, so it can land after the reviewed commit.
  git('add', 'openspec/changes/sandbox/review.md');
  git('commit', '-qm', 'R0 sign-off');
  return { cwd, env, git, write, change, contractSha };
}

function run(script, cwd, env, args) {
  const result = spawnSync('node', [script, ...args], { cwd, env, encoding: 'utf8' });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

function branch(env, cwd, name, base) {
  spawnSync('git', ['switch', '-q', '-c', name, base], { cwd, env });
}
function commit(env, cwd, message, files) {
  for (const [file, text] of Object.entries(files)) {
    const full = path.join(cwd, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
  spawnSync('git', ['add', '-A'], { cwd, env });
  const result = spawnSync('git', ['commit', '-qm', message], { cwd, env, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
}

test('sandbox: a converged contract freezes, then merges in dependency order without self-blocking', () => {
  const s = sandbox();

  // 1. Contract lint and freeze gate accept the converged model.
  const structural = run(freezeCheck, s.cwd, s.env, ['openspec/changes/sandbox', '--structural']);
  assert.equal(structural.status, 0, structural.out);
  const frozen = run(freezeCheck, s.cwd, s.env, ['openspec/changes/sandbox']);
  assert.equal(frozen.status, 0, frozen.out);

  // 2. Integration branch off the frozen contract.
  s.git('switch', '-qc', 'integration/sandbox');
  const base = s.git('rev-parse', 'HEAD');

  // 3. Consumer branch exists before its Uses producer is Done. Merging it must
  //    exit 35 (dependency), not merge early.
  branch(s.env, s.cwd, 'task/sandbox/T-02', base);
  commit(s.env, s.cwd, `work(T-02): consumer\n\nPipeline-Role: gongbu\nPipeline-Author: ${WORKER}`, {
    'test/consumer.test.mjs': redTest('consumer', 'src/consumer.mjs'),
    'src/consumer.mjs': impl('consumer'),
  });
  const consumerTip = s.git('rev-parse', 'HEAD');
  s.git('switch', '-q', 'integration/sandbox');
  const early = run(mergeTask, s.cwd, s.env, ['task/sandbox/T-02', 'T-02']);
  assert.equal(early.status, 35, early.out);
  assert.match(early.out, /Uses T-00 is not Done/);

  // 4. Skeleton merges mechanically; then the consumer is allowed.
  branch(s.env, s.cwd, 'task/sandbox/T-00', base);
  commit(s.env, s.cwd, `skeleton\n\nPipeline-Role: gongbu\nPipeline-Author: ${WORKER}`, {
    'src/iface.mjs': impl('useDraft'),
    'test/iface.test.mjs': redTest('iface', 'src/iface.mjs'),
  });
  const skeletonTip = s.git('rev-parse', 'HEAD');
  s.git('switch', '-q', 'integration/sandbox');
  // There is no reviewer tag any more: a `Review:` value never gates the merge.
  const skeleton = run(mergeTask, s.cwd, s.env, ['task/sandbox/T-00', 'T-00']);
  assert.equal(skeleton.status, 0, skeleton.out);
  const consumer = run(mergeTask, s.cwd, s.env, ['task/sandbox/T-02', 'T-02']);
  assert.equal(consumer.status, 0, consumer.out);

  // 5. Deferred producer merges on the deferred tag with a Red commit first.
  branch(s.env, s.cwd, 'task/sandbox/T-01', base);
  commit(s.env, s.cwd, `work(T-01): producer\n\nPipeline-Role: gongbu\nPipeline-Author: ${WORKER}`, {
    'test/prod.test.mjs': redTest('prod', 'src/prod.mjs'),
    'src/prod.mjs': impl('prod'),
  });
  const prodTip = s.git('rev-parse', 'HEAD');
  s.git('switch', '-q', 'integration/sandbox');
  const prod = run(mergeTask, s.cwd, s.env, ['task/sandbox/T-01', 'T-01']);
  assert.equal(prod.status, 0, prod.out);

  // 6. Provenance: a hand-recreated commit (same patch, different author, no cherry-pick
  //    marker) is exit 31; replaying the same commits with `cherry-pick -x` merges.
  s.git('switch', '-qc', 'seed/sandbox', base);
  commit(s.env, s.cwd, `work(T-04): tests + impl\n\nPipeline-Role: gongbu\nPipeline-Author: ${WORKER}`, {
    'test/extra.test.mjs': redTest('extra', 'src/extra.mjs'),
    'src/extra.mjs': impl('extra'),
  });
  const seed = s.git('rev-parse', 'HEAD');
  s.git('switch', '-q', 'integration/sandbox');

  branch(s.env, s.cwd, 'task/sandbox/T-04', base);
  s.git('cherry-pick', '-n', seed);
  commit(s.env, s.cwd, `work(T-04): tests + impl\n\nPipeline-Role: gongbu\nPipeline-Author: ${OTHER_WORKER}`, {});
  const forgedTip = s.git('rev-parse', 'HEAD');
  s.git('switch', '-q', 'integration/sandbox');
  const forged = run(mergeTask, s.cwd, s.env, ['task/sandbox/T-04', 'T-04']);
  assert.equal(forged.status, 31, forged.out);
  assert.match(forged.out, /cherry-pick -x/);

  branch(s.env, s.cwd, 'task/sandbox/T-04-a2', base);
  s.git('cherry-pick', '-x', seed);
  const replayTip = s.git('rev-parse', 'HEAD');
  s.git('switch', '-q', 'integration/sandbox');
  const replay = run(mergeTask, s.cwd, s.env, ['task/sandbox/T-04-a2', 'T-04']);
  assert.equal(replay.status, 0, replay.out);

  // 7. The mechanical sink closes the DAG and records every Done line.
  const afterReplay = s.git('rev-parse', 'HEAD');
  branch(s.env, s.cwd, 'task/sandbox/T-03', afterReplay);
  commit(s.env, s.cwd, `sink\n\nPipeline-Role: gongbu\nPipeline-Author: ${WORKER}`, {
    'src/all.mjs': impl('all'),
    'test/all.test.mjs': `import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
test('all', () => {
  for (const file of ['src/iface.mjs', 'src/prod.mjs', 'src/consumer.mjs', 'src/extra.mjs', 'src/all.mjs']) assert.equal(fs.existsSync(file), true);
});
`,
  });
  const sinkTip = s.git('rev-parse', 'HEAD');
  s.git('switch', '-q', 'integration/sandbox');
  const sink = run(mergeTask, s.cwd, s.env, ['task/sandbox/T-03', 'T-03']);
  assert.equal(sink.status, 0, sink.out);

  const tasks = fs.readFileSync(path.join(s.cwd, 'openspec/changes/sandbox/tasks.md'), 'utf8');
  for (const id of ['T-00', 'T-01', 'T-02', 'T-03', 'T-04']) {
    assert.match(tasks, new RegExp(`\\[x\\][^\\n]*${id}[^\\n]*\\n\\s*- Done: source=[0-9a-f]{7,40}`), id);
  }
});
