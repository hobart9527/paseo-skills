import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const GUARD = path.join(here, '..', 'hooks', 'tool-guard-hook.mjs');

function guard(payload, env = {}) {
  const result = spawnSync('node', [GUARD], { input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, PIPELINE_TIER_GATE_STATE: env.state ?? process.env.PIPELINE_TIER_GATE_STATE ?? '', ...env } });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout ? JSON.parse(result.stdout).hookSpecificOutput : {};
}

const createWorkspace = (tool_input) => guard({ tool_name: 'mcp__paseo__create_workspace', tool_input });

test('create_workspace: branch-off with branch/prNumber/forge is stripped, not rejected', () => {
  const out = createWorkspace({
    isolation: 'worktree', mode: 'branch-off', branchName: 'integration/x', baseBranch: 'refs/heads/main', path: '/repo',
    branch: 'main', prNumber: 1, forge: 'github.com',
  });
  assert.equal(out.permissionDecision, 'allow');
  assert.deepEqual(out.updatedInput, { isolation: 'worktree', mode: 'branch-off', branchName: 'integration/x', baseBranch: 'refs/heads/main', path: '/repo' });
  // No deny path: the historical 48-in-a-row failure loop came from rejecting the call.
  assert.equal(out.permissionDecisionReason, undefined);
});

test('create_workspace: an omitted mode is branch-off, so the same extras are stripped', () => {
  const out = createWorkspace({ isolation: 'worktree', branchName: 'task/x', baseBranch: 'main', branch: 'main' });
  assert.equal(out.permissionDecision, 'allow');
  assert.deepEqual(out.updatedInput, { isolation: 'worktree', branchName: 'task/x', baseBranch: 'main' });
});

test('create_workspace: checkout modes keep their own exclusive fields', () => {
  assert.deepEqual(createWorkspace({ isolation: 'worktree', mode: 'checkout-branch', branch: 'feat/x' }), {});
  assert.deepEqual(createWorkspace({ isolation: 'worktree', mode: 'checkout-pr', prNumber: 12, forge: 'github.com' }), {});
  // An unknown mode is the server's call, not the hook's.
  assert.deepEqual(createWorkspace({ isolation: 'worktree', mode: 'bogus', branch: 'main' }), {});
});

test('create_workspace: a clean branch-off call is untouched', () => {
  assert.deepEqual(createWorkspace({ isolation: 'worktree', mode: 'branch-off', branchName: 'b', baseBranch: 'main' }), {});
  assert.deepEqual(createWorkspace({ isolation: 'local', path: '/repo' }), {});
});

test('placeholder server IDs are stripped for paseo tools instead of denying', () => {
  for (const serverId of ['', 'self', ' LOCALHOST ', 'srv-invalid', 'srv_invalid', '/', 'host-1', 'srv']) {
    const created = guard({ tool_name: 'mcp__paseo__create_workspace', tool_input: { isolation: 'worktree', serverId } });
    assert.equal(created.permissionDecision, 'allow', serverId);
    assert.deepEqual(created.updatedInput, { isolation: 'worktree' }, serverId);
    const listed = guard({ tool_name: 'mcp__paseo__list_agents', tool_input: { serverId, limit: 5 } });
    assert.equal(listed.permissionDecision, 'allow', serverId);
    assert.deepEqual(listed.updatedInput, { limit: 5 }, serverId);
  }
});

test('real srv_* ids, absent serverId and non-paseo tools are passed through', () => {
  assert.deepEqual(guard({ tool_name: 'mcp__paseo__list_agents', tool_input: { serverId: 'srv_AdzDXaf59gwG' } }), {});
  assert.deepEqual(guard({ tool_name: 'mcp__paseo__list_agents', tool_input: {} }), {});
  // Another MCP server's `serverId` is not the Paseo host selector.
  assert.deepEqual(guard({ tool_name: 'mcp__example__call', tool_input: { serverId: 'local' } }), {});
});

test('serverId stripping and branch-off stripping combine into one updatedInput', () => {
  const out = createWorkspace({ isolation: 'worktree', serverId: 'srv_invalid', branchName: 'b', baseBranch: 'main', branch: 'main' });
  assert.equal(out.permissionDecision, 'allow');
  assert.deepEqual(out.updatedInput, { isolation: 'worktree', branchName: 'b', baseBranch: 'main' });
});

test('identical-call deny tells create_workspace exactly which fields to drop', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-guard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const transcript_path = path.join(dir, 'transcript.jsonl');
  const input = { isolation: 'worktree', mode: 'checkout-branch', branch: 'feat/x' };
  const records = [1, 2, 3].flatMap((id) => [
    { message: { content: [{ type: 'tool_use', id: String(id), name: 'mcp__paseo__create_workspace', input }] } },
    { message: { content: [{ type: 'tool_result', tool_use_id: String(id), is_error: true }] } },
  ]);
  fs.writeFileSync(transcript_path, records.map(JSON.stringify).join('\n'));
  const out = guard({ tool_name: 'mcp__paseo__create_workspace', tool_input: input, transcript_path });
  assert.equal(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /branch、prNumber、forge/);
  assert.match(out.permissionDecisionReason, /branchName\+baseBranch|branchName.*baseBranch/);
});

test('identical-call deny for other tools says to read the error and change a field', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-guard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const transcript_path = path.join(dir, 'transcript.jsonl');
  const input = { a: 1 };
  const records = [1, 2, 3].flatMap((id) => [
    { message: { content: [{ type: 'tool_use', id: String(id), name: 'mcp__paseo__list_agents', input }] } },
    { message: { content: [{ type: 'tool_result', tool_use_id: String(id), is_error: true }] } },
  ]);
  fs.writeFileSync(transcript_path, records.map(JSON.stringify).join('\n'));
  const out = guard({ tool_name: 'mcp__paseo__list_agents', tool_input: input, transcript_path });
  assert.equal(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /报错|error/i);
  assert.match(out.permissionDecisionReason, /字段|field/i);
  assert.doesNotMatch(out.permissionDecisionReason, /The identical call failed 3 times; change args/);
});
