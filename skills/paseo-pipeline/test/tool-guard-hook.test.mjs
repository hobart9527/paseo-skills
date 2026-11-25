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

test('create_agent: bare provider auto-resolves only on explicit model or unambiguous role in title/intro', (t) => {
  const PASEO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-guard-multi-codex-'));
  t.after(() => fs.rmSync(PASEO_HOME, { recursive: true, force: true }));
  fs.writeFileSync(path.join(PASEO_HOME, 'config.json'), JSON.stringify({ daemon: { agentProfiles: [
    { id: 'agent_profile_ceshi', name: '测试（独立 Red）', provider: 'codex', model: 'codex', modeId: 'auto-review', thinkingOptionId: 'high' },
    { id: 'agent_profile_gaogong', name: '攻坚（高工）', provider: 'codex', model: 'glm', modeId: 'auto-review', thinkingOptionId: 'high' },
    { id: 'agent_profile_anchasi', name: '审查（按察司）', provider: 'codex', model: 'gpt', modeId: 'auto-review', thinkingOptionId: 'high' },
  ] } }));

  const topModel = guard({ tool_name: 'mcp__paseo__create_agent', tool_input: { provider: 'codex', model: 'gpt', title: 'Review', initialPrompt: 'p' } }, { PASEO_HOME });
  assert.equal(topModel.permissionDecision, 'allow');
  assert.equal(topModel.updatedInput.provider, 'codex/gpt');
  assert.equal('model' in topModel.updatedInput, false);
  assert.equal(topModel.updatedInput.settings?.modeId, 'auto-review');

  const nestedModel = guard({ tool_name: 'mcp__paseo__create_agent', tool_input: { provider: 'codex', settings: { model: 'gpt', thinkingOptionId: 'high' }, title: 'Review', initialPrompt: 'p' } }, { PASEO_HOME });
  assert.equal(nestedModel.permissionDecision, 'allow');
  assert.equal(nestedModel.updatedInput.provider, 'codex/gpt');
  assert.equal('model' in nestedModel.updatedInput.settings, false);
  assert.equal(nestedModel.updatedInput.settings.modeId, 'auto-review');
  assert.equal(nestedModel.updatedInput.settings.thinkingOptionId, 'high');

  const byIntro = guard({
    tool_name: 'mcp__paseo__create_agent',
    tool_input: { provider: 'codex', title: '[Tier2] Review', initialPrompt: '你是独立异构审查（按察司 anchasi）。\n请审查改动' },
  }, { PASEO_HOME });
  assert.equal(byIntro.permissionDecision, 'allow');
  assert.equal(byIntro.updatedInput.provider, 'codex/gpt');
  assert.equal(byIntro.updatedInput.settings?.modeId, 'auto-review');

  const titleWins = guard({
    tool_name: 'mcp__paseo__create_agent',
    tool_input: {
      provider: 'codex',
      title: '[Pipeline] anchasi FINAL c1',
      labels: { 'pipeline.change': 'c1' },
      initialPrompt: 'ceshi wrote Red tests',
    },
  }, { PASEO_HOME });
  assert.equal(titleWins.permissionDecision, 'allow');
  assert.equal(titleWins.updatedInput.provider, 'codex/gpt');

  const twoRoles = guard({
    tool_name: 'mcp__paseo__create_agent',
    tool_input: { provider: 'codex', title: 'Ambiguous', initialPrompt: 'gaogong and anchasi both mentioned' },
  }, { PASEO_HOME });
  assert.equal(twoRoles.permissionDecision, 'deny');

  const mismatchModels = guard({
    tool_name: 'mcp__paseo__create_agent',
    tool_input: { provider: 'codex', model: 'gpt', settings: { model: 'glm' }, title: 'Mismatch', initialPrompt: 'p' },
  }, { PASEO_HOME });
  assert.equal(mismatchModels.permissionDecision, 'deny');

  const badModel = guard({
    tool_name: 'mcp__paseo__create_agent',
    tool_input: { provider: 'codex', model: 'nonexistent', title: 'Typo', initialPrompt: 'p' },
  }, { PASEO_HOME });
  assert.equal(badModel.permissionDecision, 'deny');
});

test('create_agent: role name, Chinese alias, or profile ID materializes live profile and settings', (t) => {
  const PASEO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-guard-role-'));
  t.after(() => fs.rmSync(PASEO_HOME, { recursive: true, force: true }));
  fs.writeFileSync(path.join(PASEO_HOME, 'config.json'), JSON.stringify({ daemon: { agentProfiles: [
    { id: 'agent_profile_chanpin', name: '调研（中书）', provider: 'antigravity', model: 'gemini-4-hydrogen-high', modeId: 'full-access', notes: '只读调研' },
    { id: 'agent_profile_gongbu', name: '开发（工部）', provider: 'claude', model: 'flash', modeId: 'auto', thinkingOptionId: 'medium', notes: '默认实现' },
    { id: 'agent_profile_anchasi', name: '审查（按察司）', provider: 'codex', model: 'gpt', modeId: 'auto-review', thinkingOptionId: 'high', featureValues: { fast_mode: true }, notes: '独立审查' },
  ] } }));

  const byToken = guard({
    tool_name: 'mcp__paseo__create_agent',
    tool_input: { provider: 'chanpin', title: 'Recon auth', initialPrompt: 'Check auth', settings: { thinkingOptionId: 'high' } },
  }, { PASEO_HOME });
  assert.equal(byToken.permissionDecision, 'allow');
  assert.equal(byToken.updatedInput.provider, 'antigravity/gemini-4-hydrogen-high');
  assert.deepEqual(byToken.updatedInput.settings, { modeId: 'full-access' });

  const byZh = guard({
    tool_name: 'mcp__paseo__create_agent',
    tool_input: { provider: '中书', title: 'Recon UI', initialPrompt: 'Check UI' },
  }, { PASEO_HOME });
  assert.equal(byZh.permissionDecision, 'allow');
  assert.equal(byZh.updatedInput.provider, 'antigravity/gemini-4-hydrogen-high');
  assert.deepEqual(byZh.updatedInput.settings, { modeId: 'full-access' });

  const byGongbu = guard({
    tool_name: 'mcp__paseo__create_agent',
    tool_input: { provider: 'gongbu', title: 'Fix bug', initialPrompt: 'Fix it' },
  }, { PASEO_HOME });
  assert.equal(byGongbu.permissionDecision, 'allow');
  assert.equal(byGongbu.updatedInput.provider, 'claude/flash');
  assert.deepEqual(byGongbu.updatedInput.settings, { modeId: 'auto', thinkingOptionId: 'medium' });

  const byProfileId = guard({
    tool_name: 'mcp__paseo__create_agent',
    tool_input: { provider: 'agent_profile_anchasi', title: 'Review PR', initialPrompt: 'Audit' },
  }, { PASEO_HOME });
  assert.equal(byProfileId.permissionDecision, 'allow');
  assert.equal(byProfileId.updatedInput.provider, 'codex/gpt');
  assert.deepEqual(byProfileId.updatedInput.settings, { modeId: 'auto-review', thinkingOptionId: 'high', features: { fast_mode: true } });

  const unknown = guard({
    tool_name: 'mcp__paseo__create_agent',
    tool_input: { provider: 'unknown-role', title: 'Test', initialPrompt: 'p' },
  }, { PASEO_HOME });
  assert.equal(unknown.permissionDecision, 'deny');
  assert.match(unknown.permissionDecisionReason, /role name or/);
});

test('create_agent: role late binding pins shared provider/model, resolves Chinese role aliases, and folds flat settings', (t) => {
  const PASEO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-guard-role-pin-'));
  t.after(() => fs.rmSync(PASEO_HOME, { recursive: true, force: true }));
  fs.writeFileSync(path.join(PASEO_HOME, 'config.json'), JSON.stringify({ daemon: { agentProfiles: [
    { id: 'agent_profile_gongbu', name: '开发（工部）', provider: 'claude', model: 'flash', modeId: 'auto', thinkingOptionId: 'medium' },
    { id: 'agent_profile_shangshu', name: '编排（尚书）', provider: 'claude', model: 'flash', modeId: 'auto', thinkingOptionId: 'high' },
    { id: 'agent_profile_ceshi', name: '测试', provider: 'codex', model: 'glm', modeId: 'auto', thinkingOptionId: 'medium' },
  ] } }));

  // Even when shangshu shares claude/flash with high thinking, provider: 'gongbu' pins gongbu (medium).
  for (const staleThinking of ['low', 'high']) {
    const res = guard({
      tool_name: 'mcp__paseo__create_agent',
      tool_input: { provider: 'gongbu', title: 'T-1', settings: { modeId: 'auto', thinkingOptionId: staleThinking }, initialPrompt: 'p' },
    }, { PASEO_HOME });
    assert.equal(res.permissionDecision, 'allow');
    assert.equal(res.updatedInput.provider, 'claude/flash');
    assert.deepEqual(res.updatedInput.settings, { modeId: 'auto', thinkingOptionId: 'medium' });
  }

  const zhCeshi = guard({
    tool_name: 'mcp__paseo__create_agent',
    tool_input: { provider: '测试', title: 'T-2', initialPrompt: 'p' },
  }, { PASEO_HOME });
  assert.equal(zhCeshi.permissionDecision, 'allow');
  assert.equal(zhCeshi.updatedInput.provider, 'codex/glm');
  assert.deepEqual(zhCeshi.updatedInput.settings, { modeId: 'auto', thinkingOptionId: 'medium' });

  // Flat top-level modeId/thinkingOptionId with role provider moves cleanly into nested settings.
  const flat = guard({
    tool_name: 'mcp__paseo__create_agent',
    tool_input: { provider: 'gongbu', title: 'T-3', modeId: 'auto-review', thinkingOptionId: 'high', initialPrompt: 'p' },
  }, { PASEO_HOME });
  assert.equal(flat.permissionDecision, 'allow');
  assert.equal(flat.updatedInput.provider, 'claude/flash');
  assert.deepEqual(flat.updatedInput.settings, { modeId: 'auto', thinkingOptionId: 'medium' });
  assert.equal('modeId' in flat.updatedInput, false);
  assert.equal('thinkingOptionId' in flat.updatedInput, false);
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

test('create_agent: stale or mismatched mode/thinking/features auto-align to the profile', (t) => {
  const PASEO_HOME = profileHome(t);
  const mode = createAgent({ provider: 'claude/flash', title: 't', settings: { modeId: 'auto-review', thinkingOptionId: 'high' } }, PASEO_HOME);
  assert.equal(mode.permissionDecision, 'allow');
  assert.deepEqual(mode.updatedInput.settings, { modeId: 'auto', thinkingOptionId: 'high' });

  const thinking = createAgent({ provider: 'claude/flash', title: 't', settings: { modeId: 'auto', thinkingOptionId: 'low' } }, PASEO_HOME);
  assert.equal(thinking.permissionDecision, 'allow');
  assert.deepEqual(thinking.updatedInput.settings, { modeId: 'auto', thinkingOptionId: 'high' });

  // A profile with no thinking option strips any extraneous thinkingOptionId instead of denying.
  const noOption = createAgent({ provider: 'antigravity/gemini', title: 't', settings: { modeId: 'full-access', thinkingOptionId: 'high' } }, PASEO_HOME);
  assert.equal(noOption.permissionDecision, 'allow');
  assert.deepEqual(noOption.updatedInput.settings, { modeId: 'full-access' });

  // Omitting it inherits, which is what the profile does.
  assert.deepEqual(createAgent({ provider: 'antigravity/gemini', title: 't', settings: { modeId: 'full-access' } }, PASEO_HOME), {});
});

// When multiple profiles share a provider/model pair with conflicting values:
// - agreed fields (like modeId) still auto-align;
// - if title/prompt names a role, its specific settings auto-align;
// - only truly ambiguous + invalid conflicting overrides are denied with candidates.
test('create_agent: shared provider/model aligns agreed fields and denies only conflicting ambiguous overrides', (t) => {
  const PASEO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'paseo-home-conflict-'));
  t.after(() => fs.rmSync(PASEO_HOME, { recursive: true, force: true }));
  fs.writeFileSync(path.join(PASEO_HOME, 'config.json'), JSON.stringify({ daemon: { agentProfiles: [
    { id: 'agent_profile_gongbu', name: '工部 (核心实现)', provider: 'claude', model: 'flash', modeId: 'auto', thinkingOptionId: 'medium' },
    { id: 'agent_profile_shangshu', name: '尚书 (总控编排)', provider: 'claude', model: 'flash', modeId: 'auto', thinkingOptionId: 'high' },
  ] } }));

  assert.deepEqual(createAgent({ provider: 'claude/flash', title: '尚书 T-01', settings: { modeId: 'auto', thinkingOptionId: 'high' } }, PASEO_HOME), {});

  // Both profiles agree on modeId='auto', so a stale modeId aligns automatically.
  const alignedMode = createAgent({ provider: 'claude/flash', title: 't', settings: { modeId: 'auto-review', thinkingOptionId: 'medium' } }, PASEO_HOME);
  assert.equal(alignedMode.permissionDecision, 'allow');
  assert.deepEqual(alignedMode.updatedInput.settings, { modeId: 'auto', thinkingOptionId: 'medium' });

  // Title identifies 工部 -> conflicting thinkingOptionId aligns to medium.
  const disambiguated = createAgent({ provider: 'claude/flash', title: '工部 T-01', settings: { modeId: 'auto', thinkingOptionId: 'low' } }, PASEO_HOME);
  assert.equal(disambiguated.permissionDecision, 'allow');
  assert.deepEqual(disambiguated.updatedInput.settings, { modeId: 'auto', thinkingOptionId: 'medium' });

  // No role token + invalid conflicting thinkingOptionId -> denied with candidates.
  const conflict = createAgent({ provider: 'claude/flash', title: 'Task T-01', settings: { modeId: 'auto', thinkingOptionId: 'low' } }, PASEO_HOME);
  assert.equal(conflict.permissionDecision, 'deny');
  assert.match(conflict.permissionDecisionReason, /thinkingOptionId/);
  assert.match(conflict.permissionDecisionReason, /尚书/);
  assert.match(conflict.permissionDecisionReason, /工部/);
});

// SCEN-GUARD-01: an explicit `null` is the same "inherit" an omitted field is, on a profile that
// sets no value for it. Dispatchers copy `list_profiles` verbatim, and that list spells a missing
// optional setting as `null`; comparing null against `undefined` denied every such launch.
test('create_agent: explicit null optional settings pass when unset and align when profile defines one', (t) => {
  const PASEO_HOME = profileHome(t);
  assert.deepEqual(createAgent({ provider: 'antigravity/gemini', title: 't', settings: { modeId: 'full-access', thinkingOptionId: null } }, PASEO_HOME), {});
  assert.deepEqual(createAgent({ provider: 'antigravity/gemini', title: 't', settings: { modeId: 'full-access', features: null } }, PASEO_HOME), {});
  // Empty `{}` feature map is semantically equivalent to unset when the profile sets none,
  // while an empty object on a scalar field like modeId aligns to the profile's modeId.
  assert.deepEqual(createAgent({ provider: 'codex/gpt', title: 't', settings: { modeId: 'auto-review', thinkingOptionId: 'high', features: {} } }, PASEO_HOME), {});
  const emptyScalar = createAgent({ provider: 'codex/gpt', title: 't', settings: { modeId: {} } }, PASEO_HOME);
  assert.equal(emptyScalar.permissionDecision, 'allow');
  assert.deepEqual(emptyScalar.updatedInput.settings, { modeId: 'auto-review' });

  // Profiles sharing claude/cc agree on features: { effort: 'max' }, so null/{}/stale features align automatically.
  const withFeatures = fs.mkdtempSync(path.join(os.tmpdir(), 'paseo-home-'));
  t.after(() => fs.rmSync(withFeatures, { recursive: true, force: true }));
  fs.writeFileSync(path.join(withFeatures, 'config.json'), JSON.stringify({ daemon: { agentProfiles: [
    { id: 'p5', name: '钦差 (验收)', provider: 'claude', model: 'cc', thinkingOptionId: 'high', features: { effort: 'max' } },
    { id: 'p6', name: '户部 (账目)', provider: 'claude', model: 'cc', modeId: 'auto', features: { effort: 'max' } },
  ] } }));
  const inherited = createAgent({ provider: 'claude/cc', title: 't', settings: { thinkingOptionId: null, features: { effort: 'max' } } }, withFeatures);
  assert.equal(inherited.permissionDecision, 'allow');
  assert.equal(inherited.updatedInput.settings.modeId, 'auto');

  const alignedNull = createAgent({ provider: 'claude/cc', title: 't', settings: { thinkingOptionId: 'high', features: null } }, withFeatures);
  assert.equal(alignedNull.permissionDecision, 'allow');
  assert.deepEqual(alignedNull.updatedInput.settings, { modeId: 'auto', thinkingOptionId: 'high', features: { effort: 'max' } });

  const alignedEmpty = createAgent({ provider: 'claude/cc', title: 't', settings: { thinkingOptionId: 'high', features: {} } }, withFeatures);
  assert.equal(alignedEmpty.permissionDecision, 'allow');
  assert.deepEqual(alignedEmpty.updatedInput.settings, { modeId: 'auto', thinkingOptionId: 'high', features: { effort: 'max' } });

  const alignedStale = createAgent({ provider: 'claude/cc', title: 't', settings: { thinkingOptionId: 'high', features: { effort: 'low' } } }, withFeatures);
  assert.equal(alignedStale.permissionDecision, 'allow');
  assert.deepEqual(alignedStale.updatedInput.settings, { modeId: 'auto', thinkingOptionId: 'high', features: { effort: 'max' } });
});

test('create_agent: conflicting featureValues print real values and cross-profile mixing is denied', (t) => {
  const PASEO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'paseo-fv-'));
  t.after(() => fs.rmSync(PASEO_HOME, { recursive: true, force: true }));
  fs.writeFileSync(path.join(PASEO_HOME, 'config.json'), JSON.stringify({ daemon: { agentProfiles: [
    { id: 'pA', name: '甲 (A)', provider: 'claude', model: 'cc', modeId: 'auto', thinkingOptionId: 'high', featureValues: { effort: 'low' } },
    { id: 'pB', name: '乙 (B)', provider: 'claude', model: 'cc', modeId: 'auto', thinkingOptionId: 'medium', featureValues: { effort: 'max' } },
  ] } }));

  const conflictFv = createAgent({ provider: 'claude/cc', title: 'Task', settings: { modeId: 'auto', features: { effort: 'invalid' } } }, PASEO_HOME);
  assert.equal(conflictFv.permissionDecision, 'deny');
  assert.match(conflictFv.permissionDecisionReason, /\{"effort":"low"\}/);
  assert.match(conflictFv.permissionDecisionReason, /\{"effort":"max"\}/);
  assert.doesNotMatch(conflictFv.permissionDecisionReason, /features=none/);

  // Mixing Profile A's thinkingOptionId with Profile B's featureValues has no single matching profile.
  const mixed = createAgent({ provider: 'claude/cc', title: 'Task', settings: { modeId: 'auto', thinkingOptionId: 'high', features: { effort: 'max' } } }, PASEO_HOME);
  assert.equal(mixed.permissionDecision, 'deny');
  assert.match(mixed.permissionDecisionReason, /甲/);
  assert.match(mixed.permissionDecisionReason, /乙/);
});

// The flat shape is only a compatibility fallback; the call shape every dispatch uses is nested.
test('create_agent: settings are read from the nested `settings` object and flat fallbacks align cleanly', (t) => {
  const PASEO_HOME = profileHome(t);
  const stale = createAgent({ provider: 'claude/flash', title: 't', settings: { modeId: 'auto-review' } }, PASEO_HOME);
  assert.equal(stale.permissionDecision, 'allow');
  assert.deepEqual(stale.updatedInput.settings, { modeId: 'auto' });
  // With `settings` present, a stale top-level value cannot mask or override the nested one.
  assert.deepEqual(createAgent({ provider: 'claude/flash', title: 't', modeId: 'auto-review', settings: { modeId: 'auto' } }, PASEO_HOME), {});
  // Flat shape without `settings` aligns into `settings` and removes the stale flat key.
  const flat = createAgent({ provider: 'claude/flash', title: 't', modeId: 'auto-review' }, PASEO_HOME);
  assert.equal(flat.permissionDecision, 'allow');
  assert.deepEqual(flat.updatedInput.settings, { modeId: 'auto' });
  assert.equal('modeId' in flat.updatedInput, false);
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

test('Bash and Read: ordinary read-only exploration never injects mid-turn cache-busting advisories', (t) => {
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
  const env = { PIPELINE_RECON_WARN_READS: '2', PIPELINE_WORKTREE_READ_WARN: '2', PIPELINE_TELEMETRY_FILE: tel, state };
  for (const cmd of ['rg a src/', 'sed -n 1,5p src/a.js', 'git status --short', 'cat src/a.js']) {
    assert.deepEqual(guard({ tool_name: 'Bash', cwd: repo, session_id: 'recon-1', tool_input: { command: cmd } }, env), {});
    assert.deepEqual(guard({ tool_name: 'Bash', cwd: wt, session_id: 'recon-wt', tool_input: { command: cmd } }, env), {});
  }
  for (let i = 0; i < 4; i += 1) {
    assert.deepEqual(guard({ tool_name: 'Read', cwd: repo, session_id: 'read-1', tool_input: { file_path: path.join(repo, 'src/a.js') } }, env), {});
    assert.deepEqual(guard({ tool_name: 'Read', cwd: wt, session_id: 'read-wt', tool_input: { file_path: path.join(wt, 'src/a.js') } }, env), {});
  }
});

test('tool guard checks repeated_failure before rewrite exit and expands ~ in targetsPrimary', (t) => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-loop-'));
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-home-'));
  t.after(() => {
    fs.rmSync(state, { recursive: true, force: true });
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });
  const tel = path.join(state, 'metrics.jsonl');
  const transcript = path.join(state, 'transcript.jsonl');
  const badWs = { isolation: 'worktree', branchName: 'feat/x', baseBranch: 'main', branch: 'main' };
  const records = [1, 2, 3].flatMap((n) => [
    { message: { content: [{ type: 'tool_use', id: `w${n}`, name: 'mcp__paseo__create_workspace', input: badWs }] } },
    { message: { content: [{ type: 'tool_result', tool_use_id: `w${n}`, is_error: true }] } },
  ]);
  fs.writeFileSync(transcript, records.map(JSON.stringify).join('\n'));
  const loopOut = guard({
    tool_name: 'mcp__paseo__create_workspace',
    tool_input: badWs,
    transcript_path: transcript,
  }, { PIPELINE_TELEMETRY_FILE: tel, state });
  assert.equal(loopOut.permissionDecision, 'deny');
  assert.match(loopOut.permissionDecisionReason, /failed 3 times/);

  // Expand ~/... inside targetsPrimary from a linked worktree
  const primary = path.join(fakeHome, 'Codex', 'demo-repo');
  fs.mkdirSync(path.join(primary, 'src'), { recursive: true });
  fs.writeFileSync(path.join(primary, 'src/a.js'), '1\n');
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: primary });
  spawnSync('git', ['config', 'user.email', 't@t'], { cwd: primary });
  spawnSync('git', ['config', 'user.name', 't'], { cwd: primary });
  spawnSync('git', ['add', '.'], { cwd: primary });
  spawnSync('git', ['commit', '-qm', 'seed'], { cwd: primary });
  const wt = path.join(fakeHome, 'wt-demo');
  spawnSync('git', ['worktree', 'add', '-q', '-b', 'feat/y', wt], { cwd: primary });

  const cdOut = guard({
    tool_name: 'Bash',
    cwd: wt,
    tool_input: { command: 'cd ~/Codex/demo-repo && git status' },
  }, { HOME: fakeHome, PIPELINE_TELEMETRY_FILE: tel, state });
  assert.match(cdOut.additionalContext, /avoid `cd` into the shared primary checkout/);

  const gitCOut = guard({
    tool_name: 'Bash',
    cwd: wt,
    tool_input: { command: 'git -C ~/Codex/demo-repo status' },
  }, { HOME: fakeHome, PIPELINE_TELEMETRY_FILE: tel, state });
  assert.match(gitCOut.additionalContext, /Avoid `git -C` mutating the primary checkout/);

  // create_agent inside a linked worktree must include a non-placeholder workspaceId
  const wtNoWs = guard({
    tool_name: 'mcp__paseo__create_agent',
    cwd: wt,
    tool_input: { provider: 'claude/flash', title: '[Handoff] T-01', initialPrompt: 'p' },
  }, { HOME: fakeHome, PASEO_HOME: fakeHome, PIPELINE_TELEMETRY_FILE: tel, state });
  assert.equal(wtNoWs.permissionDecision, 'deny');
  assert.match(wtNoWs.permissionDecisionReason, /create_workspace/);
  assert.match(wtNoWs.permissionDecisionReason, /wt-demo/);

  const wtPlaceholderWs = guard({
    tool_name: 'mcp__paseo__create_agent',
    cwd: wt,
    tool_input: { provider: 'claude/flash', title: '[Handoff] T-01', initialPrompt: 'p', workspaceId: 'local' },
  }, { HOME: fakeHome, PASEO_HOME: fakeHome, PIPELINE_TELEMETRY_FILE: tel, state });
  assert.equal(wtPlaceholderWs.permissionDecision, 'deny');
  assert.match(wtPlaceholderWs.permissionDecisionReason, /create_workspace/);

  const wtRealWs = guard({
    tool_name: 'mcp__paseo__create_agent',
    cwd: wt,
    tool_input: { provider: 'claude/flash', title: '[Handoff] T-01', initialPrompt: 'p', workspaceId: 'wks_2d1d4293681d68a3' },
  }, { HOME: fakeHome, PASEO_HOME: fakeHome, PIPELINE_TELEMETRY_FILE: tel, state });
  assert.equal(wtRealWs.permissionDecision, undefined);

  // Read-only observers (auto-review / plan) in a linked worktree do not require workspaceId
  const wtReviewNoWs = guard({
    tool_name: 'mcp__paseo__create_agent',
    cwd: wt,
    tool_input: { provider: 'codex/gpt', settings: { modeId: 'auto-review' }, title: '[Tier2 Review] check diff', initialPrompt: 'p' },
  }, { HOME: fakeHome, PASEO_HOME: fakeHome, PIPELINE_TELEMETRY_FILE: tel, state });
  assert.notEqual(wtReviewNoWs.permissionDecision, 'deny');

  const wtPlanNoWs = guard({
    tool_name: 'mcp__paseo__create_agent',
    cwd: wt,
    tool_input: { provider: 'claude/pro', settings: { modeId: 'plan' }, title: 'Design plan', initialPrompt: 'p' },
  }, { HOME: fakeHome, PASEO_HOME: fakeHome, PIPELINE_TELEMETRY_FILE: tel, state });
  assert.notEqual(wtPlanNoWs.permissionDecision, 'deny');

  // Explicit write mode must still be denied without workspaceId even if title mentions review
  const wtAutoWriteReviewTitle = guard({
    tool_name: 'mcp__paseo__create_agent',
    cwd: wt,
    tool_input: { provider: 'claude/flash', settings: { modeId: 'auto' }, title: 'Review and fix', initialPrompt: 'p' },
  }, { HOME: fakeHome, PASEO_HOME: fakeHome, PIPELINE_TELEMETRY_FILE: tel, state });
  assert.equal(wtAutoWriteReviewTitle.permissionDecision, 'deny');

  // ROLES overrides provider-specific modeId names (codex writers use auto-review; antigravity observers use full-access)
  const rolesHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-guard-roles-ws-'));
  t.after(() => fs.rmSync(rolesHome, { recursive: true, force: true }));
  fs.writeFileSync(path.join(rolesHome, 'config.json'), JSON.stringify({ daemon: { agentProfiles: [
    { id: 'agent_profile_gaogong', name: '高级研发（高工）', provider: 'codex', model: 'glm', modeId: 'auto-review' },
    { id: 'agent_profile_ceshi', name: '测试', provider: 'codex', model: 'codex', modeId: 'auto-review' },
    { id: 'agent_profile_anchasi', name: '审查（按察司）', provider: 'codex', model: 'gpt', modeId: 'auto-review' },
    { id: 'agent_profile_chanpin', name: '调研规划（中书）', provider: 'antigravity', model: 'gemini-4-hydrogen-high', modeId: 'full-access' },
  ] } }));

  for (const role of ['gaogong', 'ceshi']) {
    const out = guard({
      tool_name: 'mcp__paseo__create_agent',
      cwd: wt,
      tool_input: { provider: role, title: `Dispatch ${role}`, initialPrompt: 'p' },
    }, { HOME: fakeHome, PASEO_HOME: rolesHome, PIPELINE_TELEMETRY_FILE: tel, state });
    assert.equal(out.permissionDecision, 'deny', `${role} writer with auto-review must require workspaceId`);
  }
  for (const role of ['anchasi', 'chanpin']) {
    const out = guard({
      tool_name: 'mcp__paseo__create_agent',
      cwd: wt,
      tool_input: { provider: role, title: `Dispatch ${role}`, initialPrompt: 'p' },
    }, { HOME: fakeHome, PASEO_HOME: rolesHome, PIPELINE_TELEMETRY_FILE: tel, state });
    assert.notEqual(out.permissionDecision, 'deny', `${role} observer must not require workspaceId`);
  }

  const unmappedHandoffAutoReview = guard({
    tool_name: 'mcp__paseo__create_agent',
    cwd: wt,
    tool_input: { provider: 'codex/glm', settings: { modeId: 'auto-review' }, title: '[Handoff] T-01', initialPrompt: 'p' },
  }, { HOME: fakeHome, PASEO_HOME: fakeHome, PIPELINE_TELEMETRY_FILE: tel, state });
  assert.equal(unmappedHandoffAutoReview.permissionDecision, 'deny');
});
