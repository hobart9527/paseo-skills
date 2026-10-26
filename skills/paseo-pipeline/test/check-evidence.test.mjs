import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const checkEvidenceScript = path.resolve('skills/paseo-pipeline/test/check-evidence.mjs');

function runCheck(args) {
  return spawnSync('node', [checkEvidenceScript, ...args], { encoding: 'utf8' });
}

test('SCEN-VER-02: smoke evidence passes only with valid UUIDs, timestamps, and required fields', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-test-'));
  const validFile = path.join(tmpDir, 'valid-smoke.md');
  const validContent = [
    '# Native Smoke Evidence',
    'parent_agent_id: 62ce24cf-6ad9-4248-9def-7108195c73b5',
    'child_agent_id: dfa79d7b-99f5-46aa-bd01-3829029a8d9b',
    'notification_message_id: msg_01JAX789ABC',
    'dispatched_at: 2026-10-25T05:00:00.000Z',
    'notification_at: 2026-10-25T05:05:00.000Z',
    'result: FAIL',
    'relay_case: confirmed',
    'unverified:',
    '  - daemon restart recovery',
  ].join('\n');
  fs.writeFileSync(validFile, validContent, 'utf8');

  const res = runCheck([validFile]);
  assert.equal(res.status, 0, `Valid smoke evidence should exit 0, got: ${res.stderr}`);
  assert.match(res.stdout, /Smoke evidence valid/);

  // Missing child UUID
  const invalidFile = path.join(tmpDir, 'invalid-smoke.md');
  const invalidContent = validContent.replace(/child_agent_id: [^\n]+/, 'child_agent_id: not-a-uuid');
  fs.writeFileSync(invalidFile, invalidContent, 'utf8');
  const resBad = runCheck([invalidFile]);
  assert.equal(resBad.status, 1, 'Invalid UUID should exit 1');
  assert.match(resBad.stderr, /child_agent_id/);

  // Missing unverified
  const noUnverifiedFile = path.join(tmpDir, 'no-unverified.md');
  const noUnverifiedContent = validContent.replace(/unverified:[\s\S]*/, '');
  fs.writeFileSync(noUnverifiedFile, noUnverifiedContent, 'utf8');
  const resNoUnv = runCheck([noUnverifiedFile]);
  assert.equal(resNoUnv.status, 1, 'Missing unverified should exit 1');
});

test('SCEN-VER-03: audit evidence passes with verdict and reviewed_sha, fails otherwise', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-test-'));
  const validFile = path.join(tmpDir, 'valid-audit.md');
  const validContent = [
    '# Final Audit',
    'verdict: PASS',
    'reviewed_sha: 528c69176495ee698383bc565b0ea9dfc467d897',
    'notes: all tests passing',
  ].join('\n');
  fs.writeFileSync(validFile, validContent, 'utf8');

  const res = runCheck(['--kind', 'audit', validFile]);
  assert.equal(res.status, 0, `Valid audit evidence should exit 0, got: ${res.stderr}`);
  assert.match(res.stdout, /Audit evidence valid/);

  // Missing reviewed_sha
  const invalidFile = path.join(tmpDir, 'invalid-audit.md');
  const invalidContent = validContent.replace(/reviewed_sha: [^\n]+/, '');
  fs.writeFileSync(invalidFile, invalidContent, 'utf8');
  const resBad = runCheck(['--kind', 'audit', invalidFile]);
  assert.equal(resBad.status, 1, 'Missing reviewed_sha should exit 1');
  assert.match(resBad.stderr, /reviewed_sha/);
});

// --- 结构合法 ≠ 验收通过（L1-01） ---
// 真实反例：pipeline-native-closure 的 T-08/T-09 已勾选并挂 pass review，
// 但 smoke 是 FAIL、audit 是 PASS_SCRIPT_FAIL_NATIVE_RELAY。旧实现只查字段，
// 于是「收尾跑了一遍 check-evidence 且 exit 0」被当成了验收完成。

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-gate-'));
const write = (name, content) => {
  const file = path.join(TMP, name);
  fs.writeFileSync(file, content, 'utf8');
  return file;
};

const PASSING_SMOKE = [
  '# Native Smoke Evidence',
  'parent_agent_id: 62ce24cf-6ad9-4248-9def-7108195c73b5',
  'child_agent_id: dfa79d7b-99f5-46aa-bd01-3829029a8d9b',
  'notification_message_id: msg_01JAX789ABC',
  'dispatched_at: 2026-10-25T05:00:00.000Z',
  'notification_at: 2026-10-25T05:05:00.000Z',
  'reviewed_sha: 528c69176495ee698383bc565b0ea9dfc467d897',
  'result: PASS',
  'relay_case: confirmed',
  'unverified:',
  '',
].join('\n');

test('SCEN-EVD-01 structure gate keeps a FAIL investigation on file (exit 0)', () => {
  const file = write('fail-structure.md', PASSING_SMOKE.replace('result: PASS', 'result: FAIL'));
  const res = runCheck([file]);
  assert.equal(res.status, 0, 'structure gate must still accept a FAIL report as a record');
  assert.match(res.stdout, /Smoke evidence valid/);
  assert.match(res.stdout, /不构成验收通过/);
});

test('SCEN-EVD-01 acceptance gate rejects a FAIL smoke result', () => {
  const file = write('fail-acceptance.md', PASSING_SMOKE.replace('result: PASS', 'result: FAIL'));
  const res = runCheck(['--gate', 'acceptance', '--sha', '528c69176495ee698383bc565b0ea9dfc467d897', file]);
  assert.equal(res.status, 1, 'a FAIL smoke must not pass the acceptance gate');
  assert.match(res.stderr, /result=FAIL 不是 PASS/);
});

test('SCEN-EVD-01 acceptance gate rejects an audit whose verdict is not a pass', () => {
  const content = [
    '# Final Audit',
    'verdict: PASS_SCRIPT_FAIL_NATIVE_RELAY',
    'reviewed_sha: 528c69176495ee698383bc565b0ea9dfc467d897',
  ].join('\n');
  const file = write('audit-nonpass.md', content);
  const res = runCheck(['--kind', 'audit', '--gate', 'acceptance', '--sha', '528c69176495ee698383bc565b0ea9dfc467d897', file]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /不是已约定的通过结论/);
});

test('SCEN-EVD-01 acceptance gate rejects an audit for a stale revision', () => {
  const content = ['# Final Audit', 'verdict: PASS', 'reviewed_sha: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'].join('\n');
  const file = write('audit-stale.md', content);
  const res = runCheck(['--kind', 'audit', '--gate', 'acceptance', '--sha', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', file]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /与验收 revision .* 不符/);
});

test('SCEN-EVD-01 acceptance gate requires a revision binding for audits', () => {
  const content = ['# Final Audit', 'verdict: PASS', 'reviewed_sha: 528c69176495ee698383bc565b0ea9dfc467d897'].join('\n');
  const file = write('audit-nosha.md', content);
  const res = runCheck(['--kind', 'audit', '--gate', 'acceptance', file]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /必须给 --sha/);
});

test('SCEN-EVD-01 acceptance gate rejects unverified items even when the result is PASS', () => {
  const content = PASSING_SMOKE.replace('unverified:\n', 'unverified:\n  - daemon restart recovery\n  - parent relay timing\n');
  const file = write('unverified-acceptance.md', content);
  const res = runCheck(['--gate', 'acceptance', '--sha', '528c69176495ee698383bc565b0ea9dfc467d897', file]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /2 项未验证/);
});

test('SCEN-EVD-01 acceptance gate rejects a notification timestamp earlier than dispatch', () => {
  const content = PASSING_SMOKE
    .replace('dispatched_at: 2026-10-25T05:00:00.000Z', 'dispatched_at: 2026-10-25T06:00:00.000Z')
    .replace('notification_at: 2026-10-25T05:05:00.000Z', 'notification_at: 2026-10-25T05:54:33.409Z');
  const file = write('impossible-timeline.md', content);
  const res = runCheck(['--gate', 'acceptance', '--sha', '528c69176495ee698383bc565b0ea9dfc467d897', file]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /早于 dispatched_at/);
});

test('SCEN-EVD-01 a required scenario with no reference in the evidence is rejected', () => {
  const file = write('missing-scenario.md', PASSING_SMOKE);
  const res = runCheck([
    '--gate', 'acceptance', '--sha', '528c69176495ee698383bc565b0ea9dfc467d897',
    '--require-scenario', 'SCEN-REL-07', file,
  ]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /必需场景 SCEN-REL-07/);
});

test('SCEN-EVD-01 the all gate runs both checks and a clean passing record survives', () => {
  const file = write('clean.md', PASSING_SMOKE);
  const res = runCheck(['--gate', 'all', '--sha', '528c69176495ee698383bc565b0ea9dfc467d897', file]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /gate=all/);
});

test('SCEN-EVD-01 a 7-char prefix matching the full acceptance sha is accepted', () => {
  const file = write('prefix-sha.md', PASSING_SMOKE);
  const res = runCheck(['--gate', 'acceptance', '--sha', '528c691', file]);
  assert.equal(res.status, 0, res.stderr);
});

// --- 以下两条来自 2026-10-26 真实缺口复核（修复前均可绕过） ---

test('SCEN-EVD-01 the acceptance gate also enforces structure so a bare result is not a receipt', () => {
  // 修复前 acceptance 只跑语义检查：一份只有 result/dispatched_at/notification_at/unverified
  // 的 smoke（连 parent/child UUID、notification_message_id、relay_case 都没有）会 exit 0，
  // 于是「结构不完整」被当成「验收通过」。结构不合格是验收的前置条件，不是并列条件。
  const file = write('bare.md', [
    'result: PASS',
    'dispatched_at: 2026-10-25T05:00:00.000Z',
    'notification_at: 2026-10-25T05:10:00.000Z',
    'unverified:',
    '',
  ].join('\n'));
  const res = runCheck(['--gate', 'acceptance', '--sha', '528c69176495ee698383bc565b0ea9dfc467d897', file]);
  assert.equal(res.status, 1, 'a structurally incomplete record must not pass acceptance');
  assert.match(res.stderr, /结构不合格/);
  assert.match(res.stderr, /child_agent_id|parent_agent_id|relay_case/);
});

test('SCEN-EVD-01 a required scenario is matched on token boundaries, not as a raw substring', () => {
  // `SCEN-1` 曾是裸子串匹配，于是 `SCEN-10` 会满足它——拿一条无关场景的证据就能过必需项。
  const mentionsTen = write('scen-ten.md',
    `${PASSING_SMOKE}scenario_exercised: SCEN-10 passed\nscenario_results:\n  - SCEN-10: PASS\n`);
  const wrong = runCheck([
    '--gate', 'acceptance', '--sha', '528c69176495ee698383bc565b0ea9dfc467d897',
    '--require-scenario', 'SCEN-1', mentionsTen,
  ]);
  assert.equal(wrong.status, 1, 'SCEN-10 must not satisfy a requirement for SCEN-1');
  assert.match(wrong.stderr, /必需场景 SCEN-1/);

  // 同一份证据声明 SCEN-10 时，请求 SCEN-10 仍应通过（边界匹配不能误伤正确用例）。
  const right = runCheck([
    '--gate', 'acceptance', '--sha', '528c69176495ee698383bc565b0ea9dfc467d897',
    '--require-scenario', 'SCEN-10', mentionsTen,
  ]);
  assert.equal(right.status, 0, right.stderr);
});

test('SCEN-EVD-02 a required scenario that is merely mentioned does not satisfy acceptance', () => {
  // 「被提到」与「被验证通过」是两件事。旧实现只查 ID 是否出现在文件里，
  // 于是 TODO、注释、或一句「SCEN-X 尚未验证」都能满足必需项。
  const mentionedOnly = write('mentioned-only.md',
    `${PASSING_SMOKE}// TODO: SCEN-REL-07 尚未验证\n`);
  const res = runCheck([
    '--gate', 'acceptance', '--sha', '528c69176495ee698383bc565b0ea9dfc467d897',
    '--require-scenario', 'SCEN-REL-07', mentionedOnly,
  ]);
  assert.equal(res.status, 1, 'a bare mention must not satisfy a required scenario');
  assert.match(res.stderr, /没有 scenario_results 中的 PASS 结论/);

  const markedFail = write('scen-fail.md',
    `${PASSING_SMOKE}scenario_results:\n  - SCEN-REL-07: FAIL\n`);
  const failed = runCheck([
    '--gate', 'acceptance', '--sha', '528c69176495ee698383bc565b0ea9dfc467d897',
    '--require-scenario', 'SCEN-REL-07', markedFail,
  ]);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /结论是 FAIL, 不是 PASS|结论是 FAIL/);

  const passing = write('scen-pass.md',
    `${PASSING_SMOKE}scenario_results:\n  - SCEN-REL-07: PASS\n`);
  const ok = runCheck([
    '--gate', 'acceptance', '--sha', '528c69176495ee698383bc565b0ea9dfc467d897',
    '--require-scenario', 'SCEN-REL-07', passing,
  ]);
  assert.equal(ok.status, 0, ok.stderr);
});

test('SCEN-EVD-02 a scenario claimed PASS must not also be listed as unverified', () => {
  const content = `${PASSING_SMOKE.replace('unverified:\n', 'unverified:\n  - SCEN-REL-07 只在 mock 下跑过\n')}`
    + 'scenario_results:\n  - SCEN-REL-07: PASS\n';
  const file = write('scen-contradiction.md', content);
  const res = runCheck([
    '--gate', 'acceptance', '--sha', '528c69176495ee698383bc565b0ea9dfc467d897',
    '--require-scenario', 'SCEN-REL-07', file,
  ]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /自相矛盾/);
});

test('SCEN-EVD-02 placeholder values are rejected as not-collected, in both gates', () => {
  // 真实事故记录 native-smoke.md 用 `notification_message_id: msg_01JAX_LOST_NOTIFICATION`
  // 作为「通知丢失」的收据——它不是采集值，是编造值。结构与验收都不得当它合法。
  const placeholder = write('placeholder.md',
    PASSING_SMOKE.replace('notification_message_id: msg_01JAX789ABC',
      'notification_message_id: msg_01JAX_LOST_NOTIFICATION'));
  const structure = runCheck([placeholder]);
  assert.equal(structure.status, 1, 'structure gate must reject a placeholder value');
  assert.match(structure.stderr, /占位值/);

  const acceptance = runCheck(['--gate', 'acceptance', '--sha', '528c69176495ee698383bc565b0ea9dfc467d897', placeholder]);
  assert.equal(acceptance.status, 1);
  assert.match(acceptance.stderr, /占位值/);

  // 退化值（同一个字符重复）同样不是标识。
  const degenerate = write('degenerate.md',
    PASSING_SMOKE.replace('notification_message_id: msg_01JAX789ABC',
      'notification_message_id: aaaaaaaa'));
  const degen = runCheck([degenerate]);
  assert.equal(degen.status, 1);
  assert.match(degen.stderr, /退化值/);

  // 正常值不得被误伤：「未采集」的中文说明与真实 msg id 都要通过。
  const notCollected = write('not-collected.md',
    PASSING_SMOKE.replace('notification_message_id: msg_01JAX789ABC',
      'notification_message_id: msg_01KA2B3C4D5E6F7G8H9J0K'));
  const ok = runCheck([notCollected]);
  assert.equal(ok.status, 0, ok.stderr);
});
