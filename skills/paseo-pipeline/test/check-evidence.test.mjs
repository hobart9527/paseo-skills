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
