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

function paseoHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paseo-home-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'server-id'), 'srv_AdzDXaf59gwG\n');
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ daemon: { agentProfiles: [
    { id: 'p1', name: '工部 (核心实现)', provider: 'claude', model: 'flash' },
    { id: 'p2', name: '按察司 (审计)', provider: 'codex', model: 'gpt' },
  ] } }));
  return dir;
}

test('serverId one or two edits from this host is a typo and is stripped; distant ids pass', (t) => {
  const PASEO_HOME = paseoHome(t);
  for (const serverId of ['srv_AdzDXaf59gw', 'srv_AdzDXaf59gwC', 'srv_AdzDXaf59gwGG']) {
    const out = guard({ tool_name: 'mcp__paseo__create_workspace', tool_input: { isolation: 'worktree', serverId } }, { PASEO_HOME });
    assert.equal(out.permissionDecision, 'allow', serverId);
    assert.deepEqual(out.updatedInput, { isolation: 'worktree' }, serverId);
  }
  assert.deepEqual(guard({ tool_name: 'mcp__paseo__list_agents', tool_input: { serverId: 'srv_AdzDXaf59gwG' } }, { PASEO_HOME }), {});
  assert.deepEqual(guard({ tool_name: 'mcp__paseo__list_agents', tool_input: { serverId: 'srv_Remote123456' } }, { PASEO_HOME }), {});
});

test('create_agent: bare provider is denied with the valid provider/model pairs', (t) => {
  const PASEO_HOME = paseoHome(t);
  const out = guard({ tool_name: 'mcp__paseo__create_agent', tool_input: { provider: 'claude', title: 't', initialPrompt: 'p' } }, { PASEO_HOME });
  assert.equal(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /claude\/flash/);
  assert.match(out.permissionDecisionReason, /codex\/gpt/);
});

test('create_agent: placeholder workspaceId dropped, missing title derived, long title clipped', (t) => {
  const PASEO_HOME = paseoHome(t);
  for (const workspaceId of ['', '\t', 'default', 'local', 'current']) {
    const out = guard({ tool_name: 'mcp__paseo__create_agent', tool_input: { provider: 'codex/gpt', title: 'Audit', initialPrompt: 'p', workspaceId } }, { PASEO_HOME });
    assert.deepEqual(out.updatedInput, { provider: 'codex/gpt', title: 'Audit', initialPrompt: 'p' }, JSON.stringify(workspaceId));
  }
  const derived = guard({ tool_name: 'mcp__paseo__create_agent', tool_input: { provider: 'codex/glm', initialPrompt: '## Task\nReview the diff' } }, { PASEO_HOME });
  assert.equal(derived.updatedInput.title, 'Task');
  const long = guard({ tool_name: 'mcp__paseo__create_agent', tool_input: { provider: 'claude/cc', title: '发'.repeat(62), initialPrompt: 'p' } }, { PASEO_HOME });
  assert.equal(long.updatedInput.title.length, 60);
  assert.deepEqual(guard({ tool_name: 'mcp__paseo__create_agent', tool_input: { provider: 'claude/cc', title: 'ok', initialPrompt: 'p', workspaceId: 'wks_4c2768faccbb4adb' } }, { PASEO_HOME }), {});
});

test('create_agent: a [Pipeline] agent without pipeline.change is denied; labelled or non-pipeline passes', (t) => {
  const PASEO_HOME = paseoHome(t);
  const call = (extra) => guard({ tool_name: 'mcp__paseo__create_agent', tool_input: { provider: 'claude/cc', initialPrompt: 'p', ...extra } }, { PASEO_HOME });
  for (const labels of [undefined, {}, { 'pipeline.change': ' ' }, { 'pipeline.task': 'T-01' }]) {
    const out = call({ title: '[Pipeline] gongbu T-01 c1', ...(labels ? { labels } : {}) });
    assert.equal(out.permissionDecision, 'deny', JSON.stringify(labels));
    assert.match(out.permissionDecisionReason, /pipeline\.change/);
    assert.match(out.permissionDecisionReason, /DISPATCH/);
  }
  assert.deepEqual(call({ title: '[Pipeline] gongbu T-01 c1', labels: { 'pipeline.change': 'c1' } }), {});
  assert.deepEqual(call({ title: '[Handoff] fix login' }), {});
});

test('create_agent: a [Pipeline] agent missing pipeline.change is auto-labelled when one live change is unambiguous', (t) => {
  const PASEO_HOME = paseoHome(t);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-repo-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  spawnSync('git', ['init', '-q'], { cwd: repo });
  for (const name of ['c1', 'c2', 'archive']) fs.mkdirSync(path.join(repo, 'openspec', 'changes', name), { recursive: true });
  const call = (extra) => guard({ tool_name: 'mcp__paseo__create_agent', cwd: repo, tool_input: { provider: 'claude/cc', initialPrompt: 'p', ...extra } }, { PASEO_HOME });
  const byTitle = call({ title: '[Pipeline] gongbu T-01 c1' });
  assert.equal(byTitle.permissionDecision, 'allow');
  assert.deepEqual(byTitle.updatedInput.labels, { 'pipeline.change': 'c1' });
  const merged = call({ title: '[Pipeline] gongbu T-01 c2', labels: { 'pipeline.task': 'T-01' } });
  assert.deepEqual(merged.updatedInput.labels, { 'pipeline.task': 'T-01', 'pipeline.change': 'c2' });
  const byPrompt = call({ title: '[Pipeline] gongbu T-01', initialPrompt: 'see openspec/changes/c2/tasks.md' });
  assert.deepEqual(byPrompt.updatedInput.labels, { 'pipeline.change': 'c2' });
  // Ambiguous or unknown: still denied.
  assert.equal(call({ title: '[Pipeline] gongbu T-01' }).permissionDecision, 'deny');
  assert.equal(call({ title: '[Pipeline] gongbu T-01 c1 c2' }).permissionDecision, 'deny');
  assert.equal(call({ title: '[Pipeline] gongbu T-01 archive' }).permissionDecision, 'deny');
});

// ---- create_agent runtime settings must match the profile ----
// A stale modeId/thinkingOptionId/features used to pass silently: the hook checked only the
// provider string shape. The real call nests them under `settings`, and the live config shares
// `claude/flash` between 尚书 and 工部, so the pair selects a set of profiles, not one.
// `features` is null in every current profile: null means "no feature requirement".
function profileHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paseo-home-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ daemon: { agentProfiles: [
    { id: 'p1', name: '工部 (核心实现)', provider: 'claude', model: 'flash', modeId: 'auto', thinkingOptionId: 'high', features: undefined, featureValues: null },
    { id: 'p2', name: '按察司 (审计)', provider: 'codex', model: 'gpt', modeId: 'auto-review', thinkingOptionId: 'high', features: undefined, featureValues: null },
    { id: 'p3', name: '中书 (产品调研)', provider: 'antigravity', model: 'gemini', modeId: 'full-access', features: undefined, featureValues: null },
    { id: 'p4', name: '尚书 (总控编排)', provider: 'claude', model: 'flash', modeId: 'auto', thinkingOptionId: 'high', features: undefined, featureValues: null },
  ] } }));
  return dir;
}
const createAgent = (tool_input, PASEO_HOME) => guard({ tool_name: 'mcp__paseo__create_agent', tool_input: { initialPrompt: 'p', ...tool_input } }, { PASEO_HOME });

test('create_agent: settings matching the profile exactly are allowed unchanged', (t) => {
  const PASEO_HOME = profileHome(t);
  assert.deepEqual(createAgent({ provider: 'claude/flash', title: 't', settings: { modeId: 'auto', thinkingOptionId: 'high' } }, PASEO_HOME), {});
  // No profile matches this pair: profiles are launch configuration, not a whitelist.
  assert.deepEqual(createAgent({ provider: 'claude/unknown', title: 't', settings: { modeId: 'bogus' } }, PASEO_HOME), {});
  // An unreadable config cannot be compared or filled, so the call is left alone.
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'paseo-home-'));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  assert.deepEqual(createAgent({ provider: 'claude/flash', title: 't', settings: { modeId: 'bogus' } }, empty), {});
});

// Paseo inherits an omitted mode from the *calling* agent and only within the same provider:
// a claude session dispatching antigravity or codex fails with "cannot inherit mode 'auto' from
// caller (provider 'claude')", even though codex also has an `auto` mode. Omitting the mode is
// therefore a call the server rejects, not a way to inherit the profile.
test('create_agent: an omitted mode is filled from the matching profile', (t) => {
  const PASEO_HOME = profileHome(t);
  const filled = createAgent({ provider: 'codex/gpt', title: 't' }, PASEO_HOME);
  assert.equal(filled.permissionDecision, 'allow');
  assert.deepEqual(filled.updatedInput.settings, { modeId: 'auto-review' });
  // Existing settings are kept; the fill lands next to them.
  const merged = createAgent({ provider: 'claude/flash', title: 't', settings: { thinkingOptionId: 'high' } }, PASEO_HOME);
  assert.deepEqual(merged.updatedInput.settings, { thinkingOptionId: 'high', modeId: 'auto' });
  // An explicit null is the same "not stated" as an omission.
  const nulled = createAgent({ provider: 'antigravity/gemini', title: 't', settings: { modeId: null } }, PASEO_HOME);
  assert.deepEqual(nulled.updatedInput.settings, { modeId: 'full-access' });
  // Conflicting modes across profiles sharing the pair are not guessed; the server names them.
  const conflict = fs.mkdtempSync(path.join(os.tmpdir(), 'paseo-home-'));
  t.after(() => fs.rmSync(conflict, { recursive: true, force: true }));
  fs.writeFileSync(path.join(conflict, 'config.json'), JSON.stringify({ daemon: { agentProfiles: [
    { id: 'a', name: 'A', provider: 'codex', model: 'gpt', modeId: 'auto' },
    { id: 'b', name: 'B', provider: 'codex', model: 'gpt', modeId: 'auto-review' },
  ] } }));
  assert.deepEqual(createAgent({ provider: 'codex/gpt', title: 't' }, conflict), {});
});

test('create_agent: a stale mode or thinking option is denied with both values named', (t) => {
  const PASEO_HOME = profileHome(t);
  const mode = createAgent({ provider: 'claude/flash', title: 't', settings: { modeId: 'auto-review', thinkingOptionId: 'high' } }, PASEO_HOME);
  assert.equal(mode.permissionDecision, 'deny');
  assert.match(mode.permissionDecisionReason, /modeId/);
  assert.match(mode.permissionDecisionReason, /auto-review/);
  assert.match(mode.permissionDecisionReason, /auto\b/);
  assert.match(mode.permissionDecisionReason, /工部/);
  const thinking = createAgent({ provider: 'claude/flash', title: 't', settings: { modeId: 'auto', thinkingOptionId: 'low' } }, PASEO_HOME);
  assert.equal(thinking.permissionDecision, 'deny');
  assert.match(thinking.permissionDecisionReason, /thinkingOptionId/);
  assert.match(thinking.permissionDecisionReason, /low/);
  assert.match(thinking.permissionDecisionReason, /high/);
  // A profile with no thinking option cannot supply one, so any stated value is a mismatch.
  const noOption = createAgent({ provider: 'antigravity/gemini', title: 't', settings: { modeId: 'full-access', thinkingOptionId: 'high' } }, PASEO_HOME);
  assert.equal(noOption.permissionDecision, 'deny');
  assert.match(noOption.permissionDecisionReason, /thinkingOptionId/);
  // Omitting it inherits, which is what the profile does.
  assert.deepEqual(createAgent({ provider: 'antigravity/gemini', title: 't', settings: { modeId: 'full-access' } }, PASEO_HOME), {});
});

// The live config shares `claude/flash` between 尚书 and 工部 with identical settings. The pair,
// not the title, selects the profiles: a value matching one of them passes, a value matching none
// is denied and names the candidates. Guessing a role from the title would let a stale mode through.
test('create_agent: a shared provider/model pair is checked against every matching profile', (t) => {
  const PASEO_HOME = profileHome(t);
  assert.deepEqual(createAgent({ provider: 'claude/flash', title: '尚书 T-01', settings: { modeId: 'auto', thinkingOptionId: 'high' } }, PASEO_HOME), {});
  const stale = createAgent({ provider: 'claude/flash', title: '工部 T-01', settings: { modeId: 'auto-review' } }, PASEO_HOME);
  assert.equal(stale.permissionDecision, 'deny');
  assert.match(stale.permissionDecisionReason, /modeId/);
  assert.match(stale.permissionDecisionReason, /auto-review/);
  assert.match(stale.permissionDecisionReason, /尚书/);
  assert.match(stale.permissionDecisionReason, /工部/);
});

// SCEN-GUARD-01: an explicit `null` is the same "inherit" an omitted field is, on a profile that
// sets no value for it. Dispatchers copy `list_profiles` verbatim, and that list spells a missing
// optional setting as `null`; comparing null against `undefined` denied every such launch.
test('create_agent: an explicit null optional setting is allowed where the profile sets none', (t) => {
  const PASEO_HOME = profileHome(t);
  assert.deepEqual(createAgent({ provider: 'antigravity/gemini', title: 't', settings: { modeId: 'full-access', thinkingOptionId: null } }, PASEO_HOME), {});
  assert.deepEqual(createAgent({ provider: 'antigravity/gemini', title: 't', settings: { modeId: 'full-access', features: null } }, PASEO_HOME), {});
  // Empty `{}` feature map is semantically equivalent to unset when the profile sets none,
  // while an empty object on a scalar field like modeId must still be denied.
  assert.deepEqual(createAgent({ provider: 'codex/gpt', title: 't', settings: { modeId: 'auto-review', thinkingOptionId: 'high', features: {} } }, PASEO_HOME), {});
  const emptyScalar = createAgent({ provider: 'codex/gpt', title: 't', settings: { modeId: {} } }, PASEO_HOME);
  assert.equal(emptyScalar.permissionDecision, 'deny');
  // A real profile that does set features is matched against: null is inherit only where the
  // profile has no value, so a profile that sets one still denies a null that contradicts it.
  const withFeatures = fs.mkdtempSync(path.join(os.tmpdir(), 'paseo-home-'));
  t.after(() => fs.rmSync(withFeatures, { recursive: true, force: true }));
  fs.writeFileSync(path.join(withFeatures, 'config.json'), JSON.stringify({ daemon: { agentProfiles: [
    { id: 'p5', name: '钦差 (验收)', provider: 'claude', model: 'cc', thinkingOptionId: 'high', features: { effort: 'max' } },
    { id: 'p6', name: '户部 (账目)', provider: 'claude', model: 'cc', modeId: 'auto', features: { effort: 'max' } },
  ] } }));
  // The pair states one mode, so an omitted/`null` one is filled from the profile (cross-provider
  // omission is rejected by the server). The null `thinkingOptionId` is still allowed.
  const inherited = createAgent({ provider: 'claude/cc', title: 't', settings: { thinkingOptionId: null, features: { effort: 'max' } } }, withFeatures);
  assert.equal(inherited.permissionDecision, 'allow');
  assert.equal(inherited.updatedInput.settings.modeId, 'auto');
  // Null or `{}` inherits only where the profile sets nothing: a profile that does set the value
  // still catches a null or `{}` that contradicts it.
  const contradicted = createAgent({ provider: 'claude/cc', title: 't', settings: { thinkingOptionId: 'high', features: null } }, withFeatures);
  assert.equal(contradicted.permissionDecision, 'deny');
  assert.match(contradicted.permissionDecisionReason, /features/);
  const emptyFeatures = createAgent({ provider: 'claude/cc', title: 't', settings: { thinkingOptionId: 'high', features: {} } }, withFeatures);
  assert.equal(emptyFeatures.permissionDecision, 'deny');
  assert.match(emptyFeatures.permissionDecisionReason, /features/);
  const stale = createAgent({ provider: 'claude/cc', title: 't', settings: { thinkingOptionId: 'high', features: { effort: 'low' } } }, withFeatures);
  assert.equal(stale.permissionDecision, 'deny');
  assert.match(stale.permissionDecisionReason, /features/);
});

// The flat shape is only a compatibility fallback; the call shape every dispatch uses is nested.
test('create_agent: settings are read from the nested `settings` object, not only top level', (t) => {
  const PASEO_HOME = profileHome(t);
  const stale = createAgent({ provider: 'claude/flash', title: 't', settings: { modeId: 'auto-review' } }, PASEO_HOME);
  assert.equal(stale.permissionDecision, 'deny');
  assert.match(stale.permissionDecisionReason, /modeId/);
  // With `settings` present, a stale top-level value cannot mask or rescue the nested one.
  assert.deepEqual(createAgent({ provider: 'claude/flash', title: 't', modeId: 'auto-review', settings: { modeId: 'auto' } }, PASEO_HOME), {});
  // Same values flat still deny (compatibility fallback when no `settings` object is sent).
  assert.equal(createAgent({ provider: 'claude/flash', title: 't', modeId: 'auto-review' }, PASEO_HOME).permissionDecision, 'deny');
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

test('Agent: denies built-in independent code review while allowing normal Explore/research subagents', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-agent-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const tel = path.join(tmp, 'metrics.jsonl');

  const deniedByType = guard({
    tool_name: 'Agent',
    tool_input: { description: 'Check picker diff', subagent_type: 'code-review', prompt: 'Inspect commit abc' },
  }, { PIPELINE_TELEMETRY_FILE: tel, state: tmp });
  assert.equal(deniedByType.permissionDecision, 'deny');
  assert.match(deniedByType.permissionDecisionReason, /anchasi/);

  const deniedByDesc = guard({
    tool_name: 'Agent',
    tool_input: { description: 'Tier 2 independent review', prompt: 'You are an independent reviewer. Output PASS or BLOCKED.' },
  }, { PIPELINE_TELEMETRY_FILE: tel, state: tmp });
  assert.equal(deniedByDesc.permissionDecision, 'deny');

  const deniedByZh = guard({
    tool_name: 'Agent',
    tool_input: { description: '复核提交', prompt: '独立评审一个已提交的前端修复，只评审、不改代码，输出 PASS 或 BLOCKED。' },
  }, { PIPELINE_TELEMETRY_FILE: tel, state: tmp });
  assert.equal(deniedByZh.permissionDecision, 'deny');

  const deniedContract = guard({
    tool_name: 'Agent',
    tool_input: { description: 'Review contract', prompt: 'You are an independent contract reviewer. Read-only; output PASS or BLOCKED.' },
  }, { PIPELINE_TELEMETRY_FILE: tel, state: tmp });
  assert.equal(deniedContract.permissionDecision, 'deny');

  const deniedCodeReviewer = guard({
    tool_name: 'Agent',
    tool_input: { description: 'Review changes', subagent_type: 'code-reviewer', prompt: 'You are an independent code reviewer. Read-only; output PASS or BLOCKED.' },
  }, { PIPELINE_TELEMETRY_FILE: tel, state: tmp });
  assert.equal(deniedCodeReviewer.permissionDecision, 'deny');

  const allowedExplore = guard({
    tool_name: 'Agent',
    tool_input: { description: 'Search auth routes', subagent_type: 'Explore', prompt: 'Find where session tokens are validated in packages/server.' },
  }, { PIPELINE_TELEMETRY_FILE: tel, state: tmp });
  assert.deepEqual(allowedExplore, {});
});

test('Bash: primary-checkout read-only recon stall advises once at threshold and resets after write', (t) => {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'recon-repo-')));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-state-'));
  t.after(() => {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(state, { recursive: true, force: true });
  });
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  spawnSync('git', ['config', 'user.email', 't@t'], { cwd: repo });
  spawnSync('git', ['config', 'user.name', 't'], { cwd: repo });
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src/a.js'), 'export const a = 1;\n');
  spawnSync('git', ['add', '.'], { cwd: repo });
  spawnSync('git', ['commit', '-qm', 'seed'], { cwd: repo });

  const wt = `${repo}-wt`;
  spawnSync('git', ['worktree', 'add', '-q', '-b', 'feat/x', wt], { cwd: repo });
  t.after(() => fs.rmSync(wt, { recursive: true, force: true }));

  const tel = path.join(state, 'metrics.jsonl');
  const env = { PIPELINE_RECON_WARN_READS: '3', PIPELINE_TELEMETRY_FILE: tel, state };
  const readCmd = (cwd, cmd, session_id = 'recon-1') => guard({
    tool_name: 'Bash',
    cwd,
    session_id,
    tool_input: { command: cmd },
  }, env);

  assert.deepEqual(readCmd(repo, 'rg a src/'), {});
  assert.deepEqual(readCmd(repo, 'sed -n 1,5p src/a.js'), {});
  const third = readCmd(repo, 'git status --short');
  assert.match(third.additionalContext, /\[recon-budget\]/);
  // Advisory fires once per segment.
  assert.deepEqual(readCmd(repo, 'cat src/a.js'), {});

  // Linked worktree never emits primary-checkout recon_stall.
  for (const cmd of ['rg a src/', 'cat src/a.js', 'git status --short']) {
    assert.deepEqual(readCmd(wt, cmd, 'recon-wt'), {});
  }

  // Write via tier-write-hook resets primary recon counter.
  const writeHook = path.join(here, '..', 'hooks', 'tier-write-hook.mjs');
  const writeRes = spawnSync('node', [writeHook], {
    input: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: path.join(repo, 'src/a.js') }, session_id: 'recon-1' }),
    encoding: 'utf8',
    env: { ...process.env, PIPELINE_TIER_GATE_STATE: state, PIPELINE_TELEMETRY_FILE: tel },
  });
  assert.equal(writeRes.status, 0);

  assert.deepEqual(readCmd(repo, 'rg a src/'), {});
  assert.deepEqual(readCmd(repo, 'sed -n 1,5p src/a.js'), {});
  assert.match(readCmd(repo, 'cat src/a.js').additionalContext, /\[recon-budget\]/);
});
