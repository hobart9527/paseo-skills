import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHANGE_ID_RE, isChangeId, changeIdProblem } from '../lib/change-id.mjs';

const runState = fileURLToPath(new URL('../run-state.mjs', import.meta.url));
const reconcile = fileURLToPath(new URL('../reconcile.mjs', import.meta.url));

function tmp(context) {
  const root = mkdtempSync(path.join(tmpdir(), 'pipeline-change-id-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

// --- 纯函数层 ---

test('CHANGE_ID_RE accepts directory-shaped names and rejects flag shapes', () => {
  for (const ok of ['approval-hub', 'eas-reverse-coverage-100', 'v2.1', 'a_b']) {
    assert.equal(isChangeId(ok), true, ok);
  }
  for (const bad of ['--change', '-x', '', 'has space', 'a/b', '.hidden', null, undefined]) {
    assert.equal(isChangeId(bad), false, String(bad));
  }
  assert.ok(CHANGE_ID_RE instanceof RegExp);
});

test('a flag-shaped positional is diagnosed as an argument-order mistake, not as a bad name', () => {
  // 事故依据：`run-state.mjs status --change foo` 的 rc=0，还把状态写进了
  // `paseo-pipeline/--change/run-state.json`——一份没有任何读取方会读的文件。
  const problem = changeIdProblem('--change');
  assert.match(problem, /旗标形态/);
  assert.match(problem, /位置参数顺序写错了/);
  assert.match(problem, /<change> 在前、旗标在后/);
  // 「非法字符」不是这里的正确诊断：名字本身合法，是位置错了。
  assert.doesNotMatch(problem, /含非法字符/);
});

test('an illegal-character change name names the regex it must match', () => {
  const problem = changeIdProblem('a/b');
  assert.match(problem, /含非法字符/);
  assert.match(problem, /A-Za-z0-9/);
});

test('an empty change name is reported rather than defaulted', () => {
  assert.match(changeIdProblem(''), /为空/);
  assert.equal(changeIdProblem('ok-change'), null);
});

// --- CLI 层：真实入口必须挡住 ---

test('SCEN-RS-ARG run-state refuses a flag-shaped positional and writes no stray ledger', (context) => {
  const root = tmp(context);
  const stateDir = path.join(root, 'state');
  const res = spawnSync(process.execPath, [runState, 'status', '--change', 'foo'], {
    env: { ...process.env, PIPELINE_RUN_STATE_DIR: stateDir }, encoding: 'utf8', timeout: 15_000,
  });
  assert.equal(res.status, 1, `${res.stdout}${res.stderr}`);
  assert.match(res.stderr, /旗标形态/);
  assert.match(res.stderr, /正确写法/);
  assert.equal(existsSync(path.join(stateDir, '--change')), false,
    '被拒的调用不得创建以旗标命名的状态目录');
});

test('SCEN-RS-ARG run-state accepts a normal change name', (context) => {
  const root = tmp(context);
  const stateDir = path.join(root, 'state');
  const res = spawnSync(process.execPath, [runState, 'begin', 'good-change', '--owner', 'lead'], {
    env: { ...process.env, PIPELINE_RUN_STATE_DIR: stateDir }, encoding: 'utf8', timeout: 15_000,
  });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(existsSync(path.join(stateDir, 'good-change', 'run-state.json')), true);
});

test('SCEN-RS-ARG reconcile never mistakes a flag value for the change name', (context) => {
  // reconcile 的位置参数就是 change；`--cap` 的取值不能被当成 change 拿去对账。
  const root = tmp(context);
  const res = spawnSync(process.execPath, [reconcile, '--cap', '3'], {
    cwd: root, env: { ...process.env, PIPELINE_RUN_STATE_DIR: path.join(root, 'state') },
    encoding: 'utf8', timeout: 15_000,
  });
  assert.equal(res.status, 1, `${res.stdout}${res.stderr}`);
  assert.match(res.stderr, /Usage: node reconcile\.mjs/);
});
