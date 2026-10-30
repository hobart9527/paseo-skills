import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseMatrix, scenarioIds, isRequired, resultOf, requiredScenarios, requiredNotPassed,
  ACCEPTANCE_COLUMNS,
} from '../lib/acceptance-matrix.mjs';

const script = fileURLToPath(new URL('../acceptance-run.mjs', import.meta.url));

const MATRIX = (rows) => [
  '# Acceptance Matrix',
  '',
  `| ${ACCEPTANCE_COLUMNS.join(' | ')} |`,
  `| ${ACCEPTANCE_COLUMNS.map(() => '---').join(' | ')} |`,
  ...rows,
  '',
].join('\n');

const ROW = (scen, verify, required = 'yes', result = 'PENDING') =>
  `| ${scen} | entry | T-01 | ${verify} | ${required} | ${result} | pending |`;

function fixture(context, rows) {
  const root = mkdtempSync(path.join(tmpdir(), 'pipeline-acceptance-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  const dir = path.join(repo, 'openspec', 'changes', 'demo');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'acceptance.md');
  writeFileSync(file, MATRIX(rows));
  const env = { ...process.env, PIPELINE_RUN_STATE_DIR: path.join(root, 'state') };
  const run = (...args) => spawnSync(process.execPath, [script, 'demo', ...args], {
    cwd: repo, env, encoding: 'utf8', timeout: 60_000,
  });
  return { root, repo, file, env, run, read: () => readFileSync(file, 'utf8') };
}

// --- 解析层：三个消费方共用一份 ---

test('SCEN-ACC-01 the matrix parser reads the fixed columns and skips the separator row', () => {
  const matrix = parseMatrix(MATRIX([ROW('SCEN-A-01', '`true`')]));
  assert.deepEqual(matrix.header, ACCEPTANCE_COLUMNS);
  assert.equal(matrix.rows.length, 1);
  assert.equal(matrix.rows[0].Scenario, 'SCEN-A-01');
});

test('SCEN-ACC-01 a matrix without a Scenario header is unparseable, not silently empty', () => {
  assert.equal(parseMatrix('| a | b |\n| --- | --- |\n| 1 | 2 |'), null);
});

test('SCEN-ACC-01 one row may carry several scenario ids (Pod scenarios)', () => {
  const matrix = parseMatrix(MATRIX([ROW('SCEN-A-01, SCEN-A-02', '`true`')]));
  assert.deepEqual(scenarioIds(matrix.rows[0]), ['SCEN-A-01', 'SCEN-A-02']);
  assert.deepEqual(requiredScenarios(matrix), ['SCEN-A-01', 'SCEN-A-02']);
});

test('SCEN-ACC-01 Required is only "yes"; Result normalizes to upper case', () => {
  const matrix = parseMatrix(MATRIX([
    ROW('SCEN-A-01', '`true`', 'yes'),
    ROW('SCEN-A-02', '`true`', 'no'),
  ]));
  assert.equal(isRequired(matrix.rows[0]), true);
  assert.equal(isRequired(matrix.rows[1]), false);
  assert.deepEqual(requiredScenarios(matrix), ['SCEN-A-01']);
  assert.equal(resultOf({ Result: ' pending ' }), 'PENDING');
});

test('SCEN-ACC-01 PENDING, empty, FAIL and BLOCKED all count as not passed', () => {
  const matrix = parseMatrix(MATRIX([
    ROW('SCEN-A-01', '`true`', 'yes', 'PENDING'),
    ROW('SCEN-A-02', '`true`', 'yes', ''),
    ROW('SCEN-A-03', '`true`', 'yes', 'FAIL'),
    ROW('SCEN-A-04', '`true`', 'yes', 'BLOCKED'),
    ROW('SCEN-A-05', '`true`', 'yes', 'PASS'),
    ROW('SCEN-A-06', '`true`', 'no', 'PENDING'),
  ]));
  assert.deepEqual(requiredNotPassed(matrix).map((entry) => entry.scenario),
    ['SCEN-A-01', 'SCEN-A-02', 'SCEN-A-03', 'SCEN-A-04']);
});

// --- 执行层：Verify 命令真的被执行 ---

test('SCEN-ACC-02 acceptance-run executes every Required=yes Verify command and records exit codes', (context) => {
  const subject = fixture(context, [
    ROW('SCEN-A-01', '`node -e "process.exit(0)"`'),
    ROW('SCEN-A-02', '`node -e "process.exit(0)"`'),
    ROW('SCEN-A-03', '`node -e "process.exit(1)"`', 'no'),
  ]);
  const result = subject.run();
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /PASS SCEN-A-01/);
  assert.match(result.stdout, /PASS SCEN-A-02/);
  assert.doesNotMatch(result.stdout, /SCEN-A-03/, 'Required=no 的行不执行');
  const receipt = JSON.parse(readFileSync(path.join(subject.root, 'state', 'demo', 'acceptance-receipt.json'), 'utf8'));
  assert.equal(receipt.results.length, 2);
  assert.equal(receipt.results[0].exitCode, 0);
  // 坐标必须可回溯：不是 git 仓库时 head 是 null（如实记「未采集」），绝不伪造一个 SHA。
  assert.ok(receipt.head === null || /^[0-9a-f]{40}$/.test(receipt.head), String(receipt.head));
});

test('SCEN-ACC-02 a failing Verify command fails the run with the real exit code', (context) => {
  const subject = fixture(context, [
    ROW('SCEN-A-01', '`node -e "process.exit(0)"`'),
    ROW('SCEN-A-02', '`node -e "process.exit(7)"`'),
  ]);
  const result = subject.run();
  assert.equal(result.status, 1);
  assert.match(result.stdout, /FAIL SCEN-A-02 exit=7/);
});

test('SCEN-ACC-02 a natural-language Verify is rejected outright, never skipped as "unverified"', (context) => {
  // 自报验收的原始缺陷：矩阵里写一句「手工点一遍」，然后 Result 填 PASS。
  // 跳过自然语言行等于让那一行永远不需要证据，所以这里是硬失败。
  const subject = fixture(context, [ROW('SCEN-A-01', '手工点一遍界面')]);
  const result = subject.run();
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Verify 不是可执行命令/);
  assert.equal(existsSync(path.join(subject.root, 'state', 'demo', 'acceptance-receipt.json')), false);
});

test('SCEN-ACC-02 a timeout is a failure, not a pass', (context) => {
  const subject = fixture(context, [ROW('SCEN-A-01', '`node -e "setTimeout(()=>{},5000)"`')]);
  const result = subject.run('--timeout', '1');
  assert.equal(result.status, 1);
  assert.match(result.stdout, /TIMEOUT SCEN-A-01/);
});

test('SCEN-ACC-02 --only narrows execution but a partial run cannot pass as full acceptance', (context) => {
  const subject = fixture(context, [
    ROW('SCEN-A-01', '`node -e "process.exit(0)"`'),
    ROW('SCEN-A-02', '`node -e "process.exit(0)"`'),
  ]);
  const result = subject.run('--only', 'SCEN-A-01');
  assert.equal(result.status, 3, '有必需行未覆盖时必须是非零');
  assert.match(result.stderr, /未覆盖的必需行：SCEN-A-02/);
  const receipt = JSON.parse(readFileSync(path.join(subject.root, 'state', 'demo', 'acceptance-receipt.json'), 'utf8'));
  assert.deepEqual(receipt.uncovered, ['SCEN-A-02']);
});

test('SCEN-ACC-02 --only with a scenario that is not a required row is a usage error', (context) => {
  const subject = fixture(context, [
    ROW('SCEN-A-01', '`true`'),
    ROW('SCEN-A-09', '`true`', 'no'),
  ]);
  const result = subject.run('--only', 'SCEN-A-09');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /不是必需行/);
});

test('SCEN-ACC-02 --dry-run executes nothing and leaves the matrix untouched', (context) => {
  const subject = fixture(context, [ROW('SCEN-A-01', '`node -e "process.exit(0)"`')]);
  const before = subject.read();
  const result = subject.run('--dry-run', '--write');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[dry-run\] SCEN-A-01 → node -e/);
  assert.equal(subject.read(), before, 'dry-run 不得回填');
});

test('SCEN-ACC-02 --write backfills only the rows it executed', (context) => {
  const subject = fixture(context, [
    ROW('SCEN-A-01', '`node -e "process.exit(0)"`'),
    ROW('SCEN-A-02', '`node -e "process.exit(0)"`', 'yes', 'BLOCKED'),
  ]);
  const result = subject.run('--only', 'SCEN-A-01', '--write', '--json');
  assert.equal(result.status, 3, '仍有必需行未覆盖');
  const text = subject.read();
  assert.match(text, /\| SCEN-A-01 \| entry \| T-01 \| `node -e "process.exit\(0\)"` \| yes \| PASS \|/);
  assert.match(text, /\| yes \| BLOCKED \|/, '人工标的 BLOCKED 不得被抹掉');
  // 只有被执行的行改了 Evidence。
  assert.match(text, /acceptance-receipt\.json#SCEN-A-01/);
  assert.doesNotMatch(text, /acceptance-receipt\.json#SCEN-A-02/);
});

test('SCEN-ACC-02 a failing row is written as FAIL, never left as PENDING', (context) => {
  const subject = fixture(context, [ROW('SCEN-A-01', '`node -e "process.exit(3)"`')]);
  const result = subject.run('--write');
  assert.equal(result.status, 1);
  assert.match(subject.read(), /\| yes \| FAIL \|/);
});

test('SCEN-ACC-02 a matrix with no required row is refused', (context) => {
  const subject = fixture(context, [ROW('SCEN-A-01', '`true`', 'no')]);
  const result = subject.run();
  assert.equal(result.status, 2);
  assert.match(result.stderr, /没有任何 Required=yes 的行/);
});

test('SCEN-ACC-02 a missing matrix file is a usage error naming the path', (context) => {
  const root = mkdtempSync(path.join(tmpdir(), 'pipeline-acceptance-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [script, 'nope'], {
    cwd: root, env: { ...process.env, PIPELINE_RUN_STATE_DIR: path.join(root, 'state') },
    encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /找不到验收矩阵/);
});
